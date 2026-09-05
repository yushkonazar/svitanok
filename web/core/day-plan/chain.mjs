// DayPlanChain (07 §6, ADR-035, S-P-9…15): Workflow, що живе від вечірнього
// «Що завтра?» до вечірнього огляду наступного дня. Машина станів -
// runDayPlanChain(env, params, step, io): усі кроки через `step.do`, очікування
// через `step.waitForEvent`, а вихід у світ - через `io` (повідомлення, старт
// працівника, календар, енергія). Клас DayPlanChain - тонка обгортка з
// бойовим io; тести ганяють машину з фейковими step/io (03-plan: «unit -
// машина станів кожного Workflow (мок waitForEvent)»).
//
// Денний працівник (day-planner.md) - прогін профілю `day-planner` у мозку:
// вхід JSON {chain_id, mode, date, task}, вихід - подія `worker` у цей
// ланцюг через /internal/runs outcome.chain (без deliver). Працівник
// недоступний або впав - резерв: наївний розбір наміру і formatDraft, ланцюг
// не вмирає (00-README п.6: помилка видима, але без тиші).

import { WorkflowEntrypoint } from 'cloudflare:workers';
import { kyivDateKey, kyivMinuteOfDay } from '../../kyiv-time.mjs';
import { addDaysToDateKey } from '../../reminders-core.mjs';
import { readCalendarRange } from '../../google.mjs';
import { loadStats } from '../../kv-store.mjs';
import { enqueueOutbox, drainOutbox } from '../tg/outbox.mjs';
import { registryBegin, registryFinish } from '../run-registry/client.mjs';
import { callBrainRun } from '../brain/run-client.mjs';
import { loadInstruction } from '../instructions.mjs';
import { applyPolicy } from '../policy/proposals.mjs';
import { calendarProposalText } from '../tools/plan.mjs';
import { computeSlots, formatDraft, energyBySlot, hhmmToMin, minToHhmm } from './slots.mjs';
import {
  readDayPlanConfig,
  upsertDayPlan,
  replaceItems,
  normalizeItem,
  acceptPlan,
  updateItems,
  reviewPlan,
  carryItems,
  carriedInto,
  markReviewed,
  listItems,
  kyivMs,
  nextPlannedDay,
  ITEMS_MAX,
} from './store.mjs';

export const CHAIN_KIND = 'day-plan';
/** Таймаути очікувань (07 §6). */
export const WAIT_INTENT_MS = 3 * 3_600_000;
export const WAIT_ANSWER_MS = 3_600_000;
export const WAIT_WORKER_MS = 10 * 60_000;
export const WAIT_CARRY_MS = 2 * 3_600_000;
/** Стеля змін від працівника в replan (day-planner.md §5: «не більше 3»). */
export const REPLAN_MAX_CHANGES = 3;
export const DAY_PLANNER_MODEL = 'claude-sonnet-5';

/**
 * @typedef {{
 *   now: () => number,
 *   send: (text: string, buttons?: { text: string, callback_data: string }[][]) => Promise<void>,
 *   startWorker: (mode: 'intent' | 'explain' | 'replan', task: Record<string, unknown>) => Promise<boolean>,
 *   readCalendar: (date: string) => Promise<{ title: string, startMin: number | null, endMin: number | null }[]>,
 *   readEnergy: () => Promise<{ morning: number, afternoon: number, evening: number } | null>,
 * }} ChainIo
 * @typedef {{
 *   do: <T>(name: string, fn: () => Promise<T>) => Promise<T>,
 *   sleepUntil: (name: string, ms: number) => Promise<void>,
 *   waitForEvent: (name: string, opts: { type: string, timeout: string }) => Promise<{ payload: any }>,
 * }} ChainStep
 */

/** Кнопки ланцюга (07 §9 `c:<id>:<choice>`). @param {string} chainId @param {[string, string][]} pairs */
function buttons(chainId, pairs) {
  return [pairs.map(([text, choice]) => ({ text, callback_data: `c:${chainId}:${choice}` }))];
}

/**
 * Машина станів ланцюга. Повертає підсумок для журналу.
 * @param {Env} env
 * @param {{ chainId: string, date: string }} params
 * @param {ChainStep} step
 * @param {ChainIo} io
 */
export async function runDayPlanChain(env, params, step, io) {
  const { chainId, date } = params;
  const config = await step.do('config', () => readDayPlanConfig(env));
  const eve = addDaysToDateKey(date, -1);

  // 1. Вечірнє питання (S-P-9) - о intent_at напередодні.
  await step.sleepUntil('intent-at', kyivMs(eve, config.settings.intent_at) ?? io.now());
  await step.do('ask-intent', async () => {
    await setChainState(env, chainId, { status: 'waiting', awaiting: 'intent' });
    await io.send(
      `Що завтра (${ddmm(date)})? 1-6 речей текстом або голосом; «нічого особливого» - теж відповідь.`,
      buttons(chainId, [
        ['Нічого особливого', 'none'],
        ['Не питай сьогодні', 'skip'],
      ]),
    );
  });
  const intent = await waitOrNull(step, 'wait-intent', 'intent', WAIT_INTENT_MS);
  if (intent?.choice === 'skip') {
    await step.do('skip', async () => {
      await upsertDayPlan(env, date, { status: 'skipped' }, io.now());
      await setChainState(env, chainId, { status: 'done', awaiting: null });
    });
    return { outcome: 'skipped' };
  }
  const intentText = typeof intent?.text === 'string' ? intent.text.trim() : '';

  // 2. Намір → пункти (Денний, mode=intent) з уточненнями (S-P-10).
  /** @type {ReturnType<typeof normalizeItem>[]} */
  let items = [];
  if (intentText) {
    await step.do('save-intent', () =>
      upsertDayPlan(
        env,
        date,
        { status: 'intent', intent_text: intentText, workflow_id: chainId },
        io.now(),
      ),
    );
    const started = await step.do('worker-intent', () =>
      io.startWorker('intent', { text: intentText, date }),
    );
    const parsed = started
      ? await waitOrNull(step, 'wait-intent-parsed', 'worker', WAIT_WORKER_MS)
      : null;
    items = await step.do('items', async () => normalizeIntent(parsed?.output, intentText));
    const questions = Array.isArray(parsed?.output?.questions)
      ? parsed.output.questions.slice(0, 2)
      : [];
    if (questions.length) {
      await step.do('ask-questions', async () => {
        await setChainState(env, chainId, { status: 'waiting', awaiting: 'answer' });
        for (const [qi, q] of questions.entries()) {
          /** @type {unknown[]} */
          const options = Array.isArray(q.options) ? q.options.slice(0, 4) : ['не знаю'];
          await io.send(
            String(q.q ?? 'Уточни, будь ласка'),
            buttons(
              chainId,
              options.map((o, oi) => /** @type {[string, string]} */ ([String(o), `a${qi}_${oi}`])),
            ),
          );
        }
      });
      for (let qi = 0; qi < questions.length; qi += 1) {
        const answer = await waitOrNull(step, `wait-answer-${qi}`, 'answer', WAIT_ANSWER_MS);
        items = applyAnswer(items, questions, answer, qi);
      }
    }
  }
  // Перенесені з учора - у план завжди (S-P-15).
  const carried = await step.do('carried', () => carriedInto(env, date));
  for (const c of carried) {
    if (!items.some((i) => i.title === c.title)) {
      items.push(
        normalizeItem(
          {
            id: c.id,
            title: c.title,
            kind: c.kind,
            est_min: c.est_min,
            deadline: c.deadline,
            place: c.place,
            carried_from: c.carried_from,
            priority: c.priority,
          },
          items.length,
        ),
      );
    }
  }

  // 3. Розкладка ядром (S-P-11) і чернетка (S-P-12).
  const draft = await step.do('slots', async () => {
    const events = await io.readCalendar(date);
    const energy = await io.readEnergy();
    const slots = computeSlots({
      date,
      items: items.slice(0, ITEMS_MAX),
      events,
      settings: config.settings,
      habits: config.habits,
      energy,
    });
    await replaceItems(env, date, slots, items);
    await upsertDayPlan(
      env,
      date,
      { status: 'draft', fill_ratio: config.settings.fill_ratio },
      io.now(),
    );
    return { slots, events };
  });
  const explained = await explain(step, io, date, draft, 'explain');
  await step.do('send-draft', async () => {
    await setChainState(env, chainId, { status: 'waiting', awaiting: 'accept' });
    await io.send(
      explained,
      buttons(chainId, [
        ['✅ Так', 'accept'],
        ['✏️ Змінити', 'edit'],
        ['🗓 У календар', 'calendar'],
      ]),
    );
  });
  const decision = await waitOrNull(
    step,
    'wait-accept',
    'accept',
    Math.max(60_000, (kyivMs(date, config.settings.morning_at) ?? io.now()) - io.now()),
  );
  const accepted = await step.do('accept', async () => {
    if (decision?.choice === 'edit') {
      await setChainState(env, chainId, { status: 'waiting', awaiting: 'answer' });
      await io.send('Напиши, що змінити (наприклад: «презентацію на 16:00», «забери банк»).');
      return { edit: true };
    }
    // Мовчання до ранку = план прийнято за замовчуванням: інакше ранок без
    // нагадувань, хоч власник сам назвав пункти (S-P-9: без відповіді - план
    // лише з календаря; тут відповідь була).
    const res = await acceptPlan(env, date, io.now(), address(env));
    if (decision?.choice === 'calendar') await proposeCalendar(env, date, res.items, io.now(), io);
    return { edit: false, reminders: res.reminders };
  });
  if (accepted.edit) {
    const change = await waitOrNull(step, 'wait-edit', 'answer', WAIT_ANSWER_MS);
    const started =
      typeof change?.text === 'string'
        ? await step.do('worker-replan', () =>
            io.startWorker('replan', { text: change.text, date, items }),
          )
        : false;
    // Працівник повертає JSON {done[], moves[{id,to}], drop[]} - застосовуємо
    // через updateItems ДО прийняття, інакше нагадування стануть на старий час.
    const replan = started ? await waitOrNull(step, 'wait-replan', 'worker', WAIT_WORKER_MS) : null;
    await step.do('replan', async () => {
      const out = replan?.output && typeof replan.output === 'object' ? replan.output : null;
      if (out) {
        try {
          await updateItems(env, date, replanChanges(out), io.now());
        } catch (/** @type {any} */ e) {
          console.error(`day-plan ${chainId}: зміни працівника не застосовано`, e?.message);
          await io.send(`Зміни не застосував (${String(e?.message ?? '')}) - напиши їх у чат.`);
        }
      } else if (typeof change?.text === 'string') {
        await io.send('Зміни збережу через чат: напиши, коли буде зручно.');
      }
      await acceptPlan(env, date, io.now(), address(env));
    });
  }

  // 4. Ранковий план (S-P-13).
  await step.sleepUntil('morning-at', kyivMs(date, config.settings.morning_at) ?? io.now());
  await step.do('morning', async () => {
    await setChainState(env, chainId, { status: 'running', awaiting: null });
    const [events, rows] = await Promise.all([io.readCalendar(date), listItems(env, date)]);
    await io.send(morningText(date, rows, events));
  });

  // 5. Вечірній огляд (S-P-15).
  await step.sleepUntil('review-at', kyivMs(date, config.settings.review_at) ?? io.now());
  const review = await step.do('review', async () => {
    const r = await reviewPlan(env, date);
    await setChainState(env, chainId, { status: 'waiting', awaiting: 'carry' });
    if (r.open.length === 0) {
      await io.send(`З плану ${r.done}/${r.planned} ✅ - усе закрито.`);
      return { ...r, asked: false };
    }
    await io.send(
      `З плану ${r.done}/${r.planned} ✅ · перенести «${r.open.map((o) => o.title).join('», «')}» на завтра?`,
      buttons(chainId, [
        ['Так', 'carry_all'],
        ['Ні', 'carry_none'],
      ]),
    );
    return { ...r, asked: true };
  });
  const carry = review.asked ? await waitOrNull(step, 'wait-carry', 'carry', WAIT_CARRY_MS) : null;
  await step.do('carry', async () => {
    const to = nextPlannedDay(date, config.weekdays);
    if (carry?.choice === 'carry_all' || (carry?.choice == null && review.asked)) {
      // Без відповіді за 2 год - переносимо (S-P-15: перенесений живе 3 дні).
      const res = await carryItems(env, date, to, [], io.now());
      if (res.stale.length) {
        await io.send(
          `«${res.stale.map((s) => s.title).join('», «')}» переїжджає вже ${res.stale[0]?.days} день - забути чи в ідеї?`,
        );
      }
    } else {
      await markReviewed(env, date, io.now());
    }
    await setChainState(env, chainId, { status: 'done', awaiting: null });
  });
  return { outcome: 'done', items: items.length };
}

// ── Кроки-помічники ────────────────────────────────────────────────────────

/**
 * Очікування події з таймаутом: у Workflows таймаут кидає - тут це чесний
 * null (тиша власника - штатний шлях сценарію, не збій).
 * @param {ChainStep} step @param {string} name @param {string} type @param {number} ms
 */
async function waitOrNull(step, name, type, ms) {
  try {
    const ev = await step.waitForEvent(name, {
      type,
      timeout: `${Math.max(1, Math.ceil(ms / 1000))} seconds`,
    });
    return ev?.payload ?? null;
  } catch {
    return null;
  }
}

/**
 * Пояснений текст чернетки (Денний, mode=explain) або резерв formatDraft.
 * @param {ChainStep} step @param {ChainIo} io @param {string} date
 * @param {{ slots: ReturnType<typeof computeSlots>, events: any[] }} draft
 * @param {'explain'} mode
 */
async function explain(step, io, date, draft, mode) {
  const started = await step.do('worker-explain', () =>
    io.startWorker(mode, {
      date,
      schedule: draft.slots.placed,
      flexible: draft.slots.flexible,
      events: draft.events,
      free_min: draft.slots.freeMin - draft.slots.usedMin,
    }),
  );
  const out = started ? await waitOrNull(step, 'wait-explain', 'worker', WAIT_WORKER_MS) : null;
  const text = typeof out?.output === 'string' ? out.output.trim() : '';
  return text || formatDraft(date, draft.slots, draft.events);
}

/**
 * Пункти з JSON працівника; без нього - наївний розбір (кома/крапка з комою/
 * рядки), усі routine без оцінок, щоб ланцюг не вмер без мозку.
 * @param {any} output @param {string} intentText
 */
export function normalizeIntent(output, intentText) {
  /** @type {Record<string, unknown>[]} */
  const raw = Array.isArray(output?.items)
    ? output.items
    : intentText
        .split(/[\n;,]|\s+і\s+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((title) => ({ title, kind: 'routine' }));
  // id від працівника не приймаємо: replaceItems робить INSERT OR REPLACE за
  // id, і чужий id «перетягнув» би рядок іншої дати разом із reminder_id.
  return raw.slice(0, ITEMS_MAX).map((r, i) => normalizeItem({ ...r, id: undefined }, i));
}

/**
 * Зміни від працівника (mode=replan, day-planner.md §5): {done[], moves[{id,to}],
 * drop[]} → аргументи updateItems; чужі поля відкидаються, ≤ 3 зміни.
 * @param {Record<string, unknown>} out
 */
export function replanChanges(out) {
  const strings = (/** @type {unknown} */ v) =>
    Array.isArray(v) ? v.filter((x) => typeof x === 'string').map(String) : [];
  const moves = Array.isArray(out.moves)
    ? out.moves
        .filter(
          (m) => m && typeof m === 'object' && typeof m.id === 'string' && typeof m.to === 'string',
        )
        .map((m) => ({ id: String(m.id), to: String(m.to) }))
    : [];
  const all = [
    ...strings(out.done).map((id) => ({ kind: 'done', id })),
    ...moves.map((m) => ({ kind: 'move', ...m })),
    ...strings(out.drop).map((id) => ({ kind: 'drop', id })),
  ].slice(0, REPLAN_MAX_CHANGES);
  return {
    done: all.filter((c) => c.kind === 'done').map((c) => c.id),
    moves: all
      .filter((c) => c.kind === 'move')
      .map((c) => ({ id: c.id, to: String(/** @type {any} */ (c).to) })),
    drop: all.filter((c) => c.kind === 'drop').map((c) => c.id),
  };
}

/**
 * Відповідь на уточнення: варіант «1 год»/«30 хв»/«2 год» → est_min пункту.
 * Кнопка несе {item, option}; текст із prerouter - лише {text}, тоді пункт -
 * той, чиє питання зараз чекає відповіді (qiDefault).
 * @param {ReturnType<typeof normalizeItem>[]} items
 * @param {any[]} questions
 * @param {{ item?: number, option?: number, text?: string } | null} answer
 * @param {number} [qiDefault]
 */
export function applyAnswer(items, questions, answer, qiDefault = 0) {
  if (!answer) return items;
  const qi = Number.isInteger(answer.item) ? Number(answer.item) : qiDefault;
  const q = questions[qi];
  const target = items[Number(q?.item ?? qi)];
  if (!target) return items;
  const option =
    typeof answer.option === 'number'
      ? String(q?.options?.[answer.option] ?? '')
      : String(answer.text ?? '');
  const min = parseDurationMin(option);
  if (min != null) target.est_min = min;
  else target.flexible = true;
  return items;
}

/** «1 год», «2 год», «30 хв», «1.5 год» → хвилини; «не знаю» → null. @param {string} s */
export function parseDurationMin(s) {
  const t = s.toLowerCase().replace(',', '.');
  const h = /(\d+(?:\.\d+)?)\s*год/.exec(t);
  const m = /(\d+)\s*хв/.exec(t);
  if (!h && !m) return null;
  return Math.round((h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0)) || null;
}

/** Ранкове повідомлення з прийнятих блоків + подій. @param {string} date @param {any[]} rows @param {any[]} events */
export function morningText(date, rows, events) {
  const lines = [`Ранок ${ddmm(date)}`];
  const timed = rows.filter((r) => r.window_start && r.status === 'planned');
  for (const r of timed) lines.push(`• ${r.window_start}-${r.window_end} ${r.title}`);
  for (const e of events) {
    if (e.startMin != null) lines.push(`• ${minToHhmm(e.startMin)} ${e.title} (календар)`);
  }
  const flex = rows.filter((r) => !r.window_start && r.status === 'planned');
  if (flex.length) lines.push(`Гнучке: ${flex.map((f) => f.title).join(', ')}`);
  return lines.join('\n');
}

/**
 * «У календар» (S-P-12): пропозиція T1 на кожен блок із часом. rows - те, що
 * acceptPlan щойно прочитав (без другого SELECT).
 * @param {Env} env @param {string} date @param {{ title: string, window_start: string | null, window_end: string | null }[]} rows @param {number} nowMs
 * @param {ChainIo} io
 */
async function proposeCalendar(env, date, rows, nowMs, io) {
  for (const r of rows.filter((x) => x.window_start && x.window_end)) {
    const startMs = kyivMs(date, String(r.window_start));
    const endMs = kyivMs(date, String(r.window_end));
    if (startMs == null || endMs == null) continue;
    const out = await applyPolicy(
      env,
      {
        kind: 'calendar.event',
        payload: {
          title: r.title,
          startIso: new Date(startMs).toISOString(),
          endIso: new Date(endMs).toISOString(),
        },
        threadId: env.TOPIC_ASSISTANT ?? 'dm',
        tainted: false,
      },
      nowMs,
    );
    // Кнопки ✅/❌ шле ланцюг сам - пропозицію створило ядро, а не модель
    // (приймання 05.09, B2: без цього вона лежала open без сліду в чаті).
    if (out.mode === 'proposed') {
      await io.send(
        calendarProposalText({
          title: r.title,
          date,
          start: String(r.window_start),
          end: String(r.window_end),
        }),
        /** @type {{ text: string, callback_data: string }[][]} */ (out.proposal.buttons),
      );
    }
  }
}

/** @param {Env} env */
function address(env) {
  return {
    chatId: env.TELEGRAM_CHAT_ID ?? null,
    threadId: env.TOPIC_ASSISTANT ?? null,
  };
}

/** @param {string} date */
function ddmm(date) {
  const [, m, d] = date.split('-');
  return `${d}.${m}`;
}

// ── Стан ланцюга в D1 (`chains`) ───────────────────────────────────────────

/**
 * @param {Env} env @param {string} chainId
 * @param {{ status: 'running' | 'waiting' | 'done' | 'failed' | 'cancelled', awaiting: string | null }} state
 */
export async function setChainState(env, chainId, state) {
  if (!env.DB) throw new Error('привʼязки DB немає');
  await env.DB.prepare(
    `UPDATE chains SET status = ?, state_json = json_set(COALESCE(state_json, '{}'), '$.awaiting', ?), updated_at = ? WHERE id = ?`,
  )
    .bind(state.status, state.awaiting, new Date().toISOString(), chainId)
    .run();
}

/**
 * Ланцюг плану, що чекає слова власника (intent/answer): prerouter віддає
 * туди текст замість мозку.
 * @param {Env} env
 * @returns {Promise<{ id: string, awaiting: string } | null>}
 */
export async function findAwaitingDayPlan(env) {
  if (!env.DB) return null;
  const row = /** @type {any} */ (
    await env.DB.prepare(
      `SELECT id, json_extract(state_json, '$.awaiting') AS awaiting FROM chains
       WHERE kind = ? AND status = 'waiting' AND json_extract(state_json, '$.awaiting') IN ('intent', 'answer')
       ORDER BY updated_at DESC LIMIT 1`,
    )
      .bind(CHAIN_KIND)
      .first()
  );
  return row ? { id: String(row.id), awaiting: String(row.awaiting) } : null;
}

/**
 * Створити ланцюг на дату: рядок у chains + інстанс Workflow (id = chainId,
 * щоб кнопки й події адресували його без другого ключа).
 * @param {Env} env @param {string} date @param {number} nowMs
 */
export async function startDayPlanChain(env, date, nowMs) {
  if (!env.DB) throw new Error('привʼязки DB немає');
  if (!env.DAY_PLAN) throw new Error('привʼязки DAY_PLAN (Workflow) немає');
  const chainId = crypto.randomUUID();
  const iso = new Date(nowMs).toISOString();
  await env.DB.prepare(
    `INSERT INTO chains (id, kind, workflow_id, state_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'running', ?, ?)`,
  )
    .bind(chainId, CHAIN_KIND, chainId, JSON.stringify({ date, awaiting: null }), iso, iso)
    .run();
  await env.DAY_PLAN.create({ id: chainId, params: { chainId, date } });
  await upsertDayPlan(env, date, { status: 'intent', workflow_id: chainId }, nowMs);
  return chainId;
}

/**
 * Подія в ланцюг (07 §3 /internal/chain/event, кнопки c:, текст власника).
 * @param {Env} env @param {string} chainId @param {string} type @param {Record<string, unknown>} payload
 */
export async function sendDayPlanEvent(env, chainId, type, payload) {
  if (!env.DAY_PLAN) throw new Error('привʼязки DAY_PLAN (Workflow) немає');
  const instance = await env.DAY_PLAN.get(chainId);
  await instance.sendEvent({ type, payload });
  return true;
}

/**
 * Старт Денного працівника (профіль `day-planner` у мозку): вхід - JSON
 * задачі; вихід повернеться подією `worker` у ланцюг через /internal/runs.
 * @param {Env} env
 * @param {{ chainId: string, date: string, mode: string, task: Record<string, unknown> }} req
 * @param {number} nowMs
 */
export async function startDayPlannerRun(env, req, nowMs) {
  let instruction;
  try {
    const loaded = await loadInstruction(env, 'day-planner');
    instruction = { name: loaded.name, version_hash: loaded.hash, body_md: loaded.body };
  } catch (/** @type {any} */ e) {
    console.error('day-plan: інструкція day-planner недоступна', e?.message);
    return false;
  }
  const runId = crypto.randomUUID();
  const threadId = env.TOPIC_ASSISTANT ? String(env.TOPIC_ASSISTANT) : 'dm';
  await registryBegin(env, {
    id: runId,
    trigger: 'workflow',
    profile: 'day-planner',
    threadId,
    chatId: env.TELEGRAM_CHAT_ID ? Number(env.TELEGRAM_CHAT_ID) : null,
    model: DAY_PLANNER_MODEL,
    startedMs: nowMs,
  });
  const res = await callBrainRun(
    env,
    {
      instruction,
      runId,
      profile: 'day-planner',
      threadId,
      inputText: JSON.stringify({
        chain_id: req.chainId,
        mode: req.mode,
        date: req.date,
        task: req.task,
        format: req.mode === 'explain' ? 'chat' : 'json',
      }),
    },
    nowMs,
  );
  if (res.ok) return true;
  console.error(`day-plan: працівник не стартував (${res.status} ${res.detail})`);
  await registryFinish(env, runId, { finishedMs: nowMs, error: `brain-start: ${res.status}` });
  return false;
}

/**
 * Бойове io ланцюга. chainId/date замикаються тут: кожна задача працівника
 * несе chain_id, щоб його відповідь (outcome.chain) знайшла саме цей ланцюг.
 * Доставка - enqueue + best-effort drain (як у підказках/експорті): збій
 * драйну лишає повідомлення в outbox сторожу `outbox-drain`, але в лог іде.
 * @param {Env} env @param {string} chainId @param {string} date
 */
export function productionIo(env, chainId, date) {
  return /** @type {ChainIo} */ ({
    now: () => Date.now(),
    send: async (text, btns) => {
      if (!env.TELEGRAM_CHAT_ID) throw new Error('TELEGRAM_CHAT_ID не задано');
      await enqueueOutbox(
        env,
        {
          chatId: env.TELEGRAM_CHAT_ID,
          threadId: env.TOPIC_ASSISTANT ?? null,
          kind: 'send',
          payload: { text, ...(btns ? { reply_markup: { inline_keyboard: btns } } : {}) },
        },
        Date.now(),
      );
      await drainOutbox(env, { nowMs: Date.now() }).catch((/** @type {any} */ e) => {
        console.error(`day-plan ${chainId}: драйн outbox впав, доставить sweeper`, e?.message);
      });
    },
    startWorker: async (mode, task) =>
      startDayPlannerRun(
        env,
        { chainId, date, mode, task: { ...task, chain_id: chainId, date } },
        Date.now(),
      ),
    readCalendar: async (day) => {
      const events = await readCalendarRange(env, day, day);
      // Чат-шлях (plan.intent) без календаря відмовляє; ланцюг мусить дожити
      // до ранку - планує без подій, але не мовчки.
      if (events == null) {
        console.error(`day-plan ${chainId}: календар недоступний, розкладка без подій`);
      }
      return (events ?? []).map((e) => ({
        title: String(e.title ?? ''),
        startMin: typeof e.startMs === 'number' ? kyivMinuteOfDay(new Date(e.startMs)) : null,
        endMin: typeof e.endMs === 'number' ? kyivMinuteOfDay(new Date(e.endMs)) : null,
      }));
    },
    readEnergy: async () => energyBySlot((await loadStats(env)).checkins ?? {}),
  });
}

/** Workflow-клас (wrangler.jsonc `workflows`, worker.js export). */
export class DayPlanChain extends WorkflowEntrypoint {
  /**
   * @override
   * @param {any} event - WorkflowEvent<{ chainId: string, date: string }>
   * @param {any} step - WorkflowStep
   */
  async run(event, step) {
    const env = /** @type {Env} */ (this.env);
    const params = /** @type {{ chainId: string, date: string }} */ (event.payload);
    const io = productionIo(env, params.chainId, params.date);
    try {
      return await runDayPlanChain(env, params, step, io);
    } catch (/** @type {any} */ e) {
      console.error(`day-plan chain ${params.chainId} впав`, e?.message);
      await setChainState(env, params.chainId, { status: 'failed', awaiting: null }).catch(
        () => {},
      );
      throw e;
    }
  }
}

// Експорт для тестів: дата сьогодні за Києвом (kick рахує «завтра» від неї).
export { kyivDateKey, hhmmToMin };
