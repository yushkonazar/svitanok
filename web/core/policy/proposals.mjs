// Пропозиції (07-schema §1 `proposals`) і виконання рішень власника - єдине
// місце, що викликає виконавців запису (01 §2.1 policy). Життєвий цикл:
// open → approved | rejected | expired; рішення ідемпотентне (другий тап по
// тій самій кнопці нічого не переграє). T0-виконання лишає undo-рядок
// (kind `undo:<kind>`, TTL 10 хв) - «↩» відкочує через executor.undo.
//
// Виконавці - реєстр EXECUTORS: зараз лише facts.set (єдиний write-інструмент
// етапу 1); календар/контакти/drive підключать адаптери етапу 2. Прийняте ✅
// без виконавця - ЯВНА відмова no-executor, не тихе «прийнято і забуто».

import {
  decideLevel,
  pickT2Word,
  proposalButtons,
  undoButton,
  PROPOSAL_TTL_MS,
  UNDO_WINDOW_MS,
} from './core.mjs';
import { runFactsSet, runFactsGet } from '../tools/facts.mjs';
import { runRecord } from '../tools/record.mjs';
import {
  runRemindersCreate,
  runRemindersUpdate,
  runRemindersCancel,
  readActiveReminders,
} from '../tools/reminders.mjs';

/** @typedef {{ id: string, level: string, kind: string, payload_json: string, thread_id: string | null, msg_id: number | null, word: string | null, expires_at: string, status: string, created_at: string, decided_at: string | null }} ProposalRow */

/**
 * Виконавці записів. execute повертає {prev} - знімок для undo (undefined =
 * відкочувати нічого, undo-кнопки не буде). undo приймає той знімок.
 * @type {Record<string, {
 *   execute: (env: Env, payload: any, nowMs: number) => Promise<{ prev?: unknown, result?: unknown }>,
 *   undo?: (env: Env, prev: any, nowMs: number) => Promise<void>,
 * }>}
 */
export const EXECUTORS = {
  // Нагадування (PR-6). undo вертає ТОЙ САМИЙ id: власник бачить у списку той
  // самий рядок, що й до «↩», а не новий - інакше друге «↩» після ручної
  // правки скасувало б чуже нагадування.
  'reminders.create': {
    async execute(env, payload, nowMs) {
      const { result } = await runRemindersCreate(env, payload, nowMs);
      return { prev: { id: result.id }, result };
    },
    async undo(env, snapshot) {
      await runRemindersCancel(env, { id: snapshot.id }).catch(() => {});
    },
  },
  'reminders.update': {
    async execute(env, payload, nowMs) {
      const before = (await readActiveReminders(env)).find((r) => r.id === payload.id);
      const { result } = await runRemindersUpdate(env, payload, nowMs);
      // Знімок ДО правки: undo кладе назад і текст, і час.
      return {
        prev: before ? { id: before.id, text: before.text, whenMs: before.whenMs } : null,
        result,
      };
    },
    async undo(env, snapshot, nowMs) {
      if (!snapshot) return;
      await runRemindersUpdate(
        env,
        { id: snapshot.id, text: snapshot.text, whenMs: snapshot.whenMs },
        nowMs,
      );
    },
  },
  'reminders.cancel': {
    // nowMs не потрібен: скасування не рахує часу, лише прибирає рядок.
    async execute(env, payload) {
      const before = (await readActiveReminders(env)).find((r) => r.id === payload.id);
      const { result } = await runRemindersCancel(env, payload);
      return { prev: before ?? null, result };
    },
    async undo(env, snapshot, nowMs) {
      if (!snapshot) return;
      // Скасоване нагадування зникло зі списку - «↩» створює його наново з
      // тим самим id, текстом і часом.
      await runRemindersCreate(
        env,
        { text: snapshot.text, whenMs: snapshot.whenMs, restoreId: snapshot.id },
        nowMs,
      );
    },
  },
  // record: БЕЗ undo. Чинні модулі (applyEvent, recordEvent, toggleProgress)
  // зворотної операції не мають - стрік, ваги преференцій і воронка
  // перераховуються з подій, і «відкат» тут означав би писати компенсаційну
  // подію, тобто брехати історії. Кнопки «↩» не буде: прогін віддає prev
  // undefined (policy тоді її не показує).
  record: {
    async execute(env, payload, nowMs) {
      const { result } = await runRecord(env, payload, nowMs);
      return { result };
    },
  },
  'facts.set': {
    async execute(env, payload, nowMs) {
      const before = await runFactsGet(env, { kind: payload.kind, key: payload.key });
      const prev = before.result[0] ?? null; // null = факту не існувало
      const { result } = await runFactsSet(env, payload, nowMs);
      return { prev: { key: payload.key, kind: payload.kind, prev }, result };
    },
    async undo(env, snapshot, nowMs) {
      if (snapshot.prev == null) {
        // Факту не було - відкат = видалення.
        if (!env.DB) throw new Error('привʼязки DB немає');
        await env.DB.prepare('DELETE FROM facts WHERE kind = ? AND key = ?')
          .bind(snapshot.kind, snapshot.key)
          .run();
        return;
      }
      await runFactsSet(
        env,
        {
          kind: snapshot.kind,
          key: snapshot.key,
          value: snapshot.prev.value,
          source: snapshot.prev.source,
        },
        nowMs,
      );
    },
  },
};

/** @param {Env} env */
function db(env) {
  if (!env.DB) throw new Error('привʼязки DB немає - policy неможлива');
  return env.DB;
}

/**
 * Виконати ДІЮ за політикою: T0 (у чистій сесії) - одразу + undo-рядок;
 * T1/T2 (і будь-що в tainted) - пропозиція з кнопками. Це єдиний вхід для
 * write-шляхів router'а.
 * @param {Env} env
 * @param {{ kind: string, payload: Record<string, unknown>,
 *   threadId?: string | number | null, tainted: boolean }} action
 * @param {number} nowMs
 * @returns {Promise<
 *   | { mode: 'executed', result: unknown, undo?: { id: string, buttons: unknown } }
 *   | { mode: 'proposed', proposal: { id: string, level: string, word: string | null,
 *       expires_at: string, buttons: unknown } }
 *   | { mode: 'error', error: string }>}
 */
export async function applyPolicy(env, action, nowMs) {
  const decision = decideLevel(action.kind, action.tainted);
  if ('error' in decision) return { mode: 'error', error: decision.error };
  let level = decision.level;

  // source='owner' - привласнення слів власника, і воно потребує ЙОГО ✅:
  // 07 §4 дозволяє виводу моделі лише inferred, тож T0-шлях із owner
  // ескалюється до пропозиції (після ✅ attribution легітимний).
  if (level === 'T0' && action.kind === 'facts.set' && action.payload.source === 'owner') {
    level = 'T1';
  }

  if (level === 'T0') {
    const executor = EXECUTORS[action.kind];
    if (!executor) return { mode: 'error', error: `no-executor: ${action.kind}` };
    const { prev, result } = await executor.execute(env, action.payload, nowMs);
    if (prev === undefined || !executor.undo) return { mode: 'executed', result };
    try {
      const undoId = crypto.randomUUID();
      await insertRow(env, {
        id: undoId,
        level: 'T0',
        kind: `undo:${action.kind}`,
        payloadJson: JSON.stringify(prev),
        threadId: action.threadId,
        word: null,
        expiresAt: new Date(nowMs + UNDO_WINDOW_MS).toISOString(),
        nowMs,
      });
      return { mode: 'executed', result, undo: { id: undoId, buttons: undoButton(undoId) } };
    } catch (/** @type {any} */ e) {
      // Дію ВЖЕ виконано - збій undo-рядка не сміє звітувати «не виконано»
      // (мозок повторив би запис). Просто без кнопки «↩», зі слідом у логах.
      console.error('policy: undo-рядок не записано (дія виконана)', e?.message);
      return { mode: 'executed', result };
    }
  }

  const id = crypto.randomUUID();
  const proposalLevel = /** @type {'T1' | 'T2'} */ (level); // T0 повернувся вище
  const word = proposalLevel === 'T2' ? pickT2Word() : null;
  const expiresAt = new Date(nowMs + PROPOSAL_TTL_MS[proposalLevel]).toISOString();
  await insertRow(env, {
    id,
    level,
    kind: action.kind,
    payloadJson: JSON.stringify(action.payload),
    threadId: action.threadId,
    word,
    expiresAt,
    nowMs,
  });
  return {
    mode: 'proposed',
    proposal: {
      id,
      level,
      word,
      expires_at: expiresAt,
      buttons: proposalButtons(id),
    },
  };
}

/**
 * Рішення власника по пропозиції (callback `p:`). Ідемпотентно: рішення по
 * вже вирішеній - {already}; прострочена - позначається expired.
 * @param {Env} env
 * @param {{ id: string, choice: 'ok' | 'no', word?: string | null }} input
 * @param {number} nowMs
 * @returns {Promise<
 *   | { ok: true, status: 'approved', executed: boolean, result?: unknown, error?: string }
 *   | { ok: true, status: 'rejected' | 'expired' }
 *   | { ok: true, already: string }
 *   | { ok: false, error: string }>}
 */
export async function resolveProposal(env, input, nowMs) {
  const row = await loadRow(env, input.id);
  if (!row || row.kind.startsWith('undo:')) return { ok: false, error: 'unknown-proposal' };
  if (row.status !== 'open') return { ok: true, already: row.status };
  if (Date.parse(row.expires_at) <= nowMs) {
    await setStatus(env, row.id, 'expired', nowMs);
    return { ok: true, status: 'expired' };
  }
  if (input.choice === 'no') {
    await setStatus(env, row.id, 'rejected', nowMs);
    return { ok: true, status: 'rejected' };
  }
  if (row.level === 'T2') {
    // Слово - другий фактор T2: без нього ✅ не достатньо (01 §4.3).
    if ((input.word ?? '').trim().toUpperCase() !== row.word) {
      return { ok: false, error: 'word-required' };
    }
  }
  const executor = EXECUTORS[row.kind];
  if (!executor) {
    // Прийнято, а виконати нічим (виконавець прийде пізнішим етапом) -
    // кажемо вголос, пропозицію лишаємо open: власник не винен, що рано.
    return { ok: false, error: `no-executor: ${row.kind}` };
  }
  /** @type {Record<string, unknown>} */
  let payload;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    return { ok: false, error: 'bad-payload' };
  }
  // CLAIM ПЕРЕД виконанням (TOCTOU): подвійний тап ✅ = два вебхуки = два
  // конкурентні resolve, і обидва бачили status='open' вище. CAS пускає до
  // виконавця рівно одного; на етапі 2 це різниця між однією і двома подіями
  // в календарі.
  if (!(await setStatus(env, row.id, 'approved', nowMs))) {
    return { ok: true, already: 'approved' };
  }
  try {
    const { result } = await executor.execute(env, payload, nowMs);
    return { ok: true, status: 'approved', executed: true, result };
  } catch (/** @type {any} */ e) {
    // Клейм уже стоїть (повтор не переграє) - збій виконання кажемо вголос.
    console.error(`policy: виконання ${row.kind} після ✅ впало`, e?.message);
    return { ok: false, error: `execute-failed: ${String(e?.message ?? '')}` };
  }
}

/**
 * «↩» по T0 (callback `u:`): відкат у вікні 10 хв, ідемпотентно.
 * @param {Env} env
 * @param {string} id
 * @param {number} nowMs
 * @returns {Promise<{ ok: true, status: 'undone' | 'expired' } | { ok: true, already: string } | { ok: false, error: string }>}
 */
export async function resolveUndo(env, id, nowMs) {
  const row = await loadRow(env, id);
  if (!row || !row.kind.startsWith('undo:')) return { ok: false, error: 'unknown-undo' };
  if (row.status !== 'open') return { ok: true, already: row.status };
  if (Date.parse(row.expires_at) <= nowMs) {
    await setStatus(env, id, 'expired', nowMs);
    return { ok: true, status: 'expired' };
  }
  const baseKind = row.kind.slice('undo:'.length);
  const executor = EXECUTORS[baseKind];
  if (!executor?.undo) return { ok: false, error: `no-executor: ${baseKind}` };
  /** @type {any} */
  let snapshot;
  try {
    snapshot = JSON.parse(row.payload_json);
  } catch {
    return { ok: false, error: 'bad-payload' };
  }
  // Той самий claim-first, що в resolveProposal: подвійний «↩» - один відкат.
  if (!(await setStatus(env, id, 'approved', nowMs))) {
    return { ok: true, already: 'approved' };
  }
  await executor.undo(env, snapshot, nowMs); // approved = «↩ застосовано»
  return { ok: true, status: 'undone' };
}

/**
 * @param {Env} env
 * @param {{ id: string, level: string, kind: string, payloadJson: string,
 *   threadId?: string | number | null, word: string | null, expiresAt: string,
 *   nowMs: number }} row
 */
async function insertRow(env, row) {
  await db(env)
    .prepare(
      `INSERT INTO proposals (id, level, kind, payload_json, thread_id, word, expires_at, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
    )
    .bind(
      row.id,
      row.level,
      row.kind,
      row.payloadJson,
      row.threadId == null ? null : String(row.threadId),
      row.word,
      row.expiresAt,
      new Date(row.nowMs).toISOString(),
    )
    .run();
}

/** @param {Env} env @param {string} id @returns {Promise<ProposalRow | null>} */
async function loadRow(env, id) {
  const { results } = await db(env).prepare('SELECT * FROM proposals WHERE id = ?').bind(id).all();
  return /** @type {ProposalRow | undefined} */ (results?.[0]) ?? null;
}

/** CAS open→status; true = саме ЦЕЙ виклик забрав рішення (changes === 1).
 *  @param {Env} env @param {string} id @param {string} status @param {number} nowMs */
async function setStatus(env, id, status, nowMs) {
  const res = await db(env)
    .prepare(`UPDATE proposals SET status = ?, decided_at = ? WHERE id = ? AND status = 'open'`)
    .bind(status, new Date(nowMs).toISOString(), id)
    .run();
  return (res.meta?.changes ?? 0) === 1;
}
