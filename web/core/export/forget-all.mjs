// «Забудь усе» (S-0-5 «чат X / колекція Y / усе», 07 §4 `forget`, T2 зі
// словом; етап 7 PR-4).
//
// ⚠️ ЩО САМЕ СТИРАЄТЬСЯ - СПИСОК ДАНИМИ, не гілки коду: інакше нова таблиця
// тихо переживе «забудь усе», і власник вважатиме стертим те, що лишилось.
// Контракт-тест звіряє список зі знімком бекапу (BACKUP_TABLES).
//
// ЩО НЕ СТИРАЄТЬСЯ І ЧОМУ.
//   `instructions` / `instruction_history` - це НЕ дані власника, а конфіг
//   застосунку з репозиторію (ADR-016): стерши їх, ми зупинили б асистента до
//   наступної синхронізації, і «забудь усе» перетворилось би на «вимкни».
//   `migrations_meta` - службовий журнал схеми; без нього наступна міграція
//   пішла б заново.
//   StateStore `state` цілком не чіпаємо - у ньому живе робоче листування з
//   Telegram (lastUpdateId, адреси вебхука, мітки задач), і його обнулення
//   зламало б бота, а не забуло б власника. Стираються ПОЛЯ даних усередині
//   нього, а окремий canonical `settings` slot очищується цілком.

import { BACKUP_TABLES } from '../backup/core.mjs';
import {
  clearAssistantHistory,
  clearSentMessages,
  clearSettings,
  updateState,
  updateStats,
} from '../../kv-store.mjs';
import { pendingClear } from '../pending-proposals/client.mjs';
import { assistantResumeClear } from '../assistant-resume/client.mjs';
import { weatherQuotaClear } from '../weather-quota/client.mjs';
import {
  ActiveBrainRunsError,
  eraseAllManagedBackups,
  eraseAllMemoryVectors,
  eraseAllQueuedRuns,
  eraseAllSdkTranscripts,
} from '../retention/external.mjs';

/**
 * Таблиці, які «забудь усе» НЕ чіпає, і чому.
 *   instructions / instruction_history - конфіг застосунку з репозиторію
 *     (ADR-016): без персони прогін не стартує, і «забудь усе» стало б
 *     «вимкни асистента».
 *   counters - службовий лічильник номерів ідей (міграція 0011). ⚠️ DELETE
 *     звідти прибирає САМ РЯДОК, і `ideas.create` після цього назавжди падає
 *     з «лічильник ideas відсутній - міграція 0011 не застосована»: власник
 *     дістав би брехливу помилку про міграцію й непрацездатні ідеї. Рядок
 *     лишається, а значення обнуляється (нижче) - нумерація починається з
 *     нуля, як і має бути після забуття.
 */
export const FORGET_ALL_KEEP = ['instructions', 'instruction_history', 'counters'];

/** Таблиці, які «забудь усе» очищає. */
export const FORGET_ALL_TABLES = BACKUP_TABLES.filter((t) => !FORGET_ALL_KEEP.includes(t));

/** FTS-індекси (ADR-036 standalone): чистяться окремо, інакше пошук ще довго
 *  знаходив би стерте. */
export const FORGET_ALL_FTS = ['ideas_fts', 'records_fts', 'inbox_fts'];

/**
 * Власні KV-ключі даних - зникають цілком. Список звіряється тестом із
 * переліком ключів, які проєкт узагалі пише: інакше «стерто все» лишало б
 * позаду те, чого ніхто не помітив, - як от координати власника
 * (`ownerGeo`), що переживали стирання й далі відповідали на «де я».
 */
export const FORGET_ALL_KV_KEYS = [
  'stats',
  'statsArchive',
  'statsArchiveWeekly',
  'saved',
  'levers',
  'latest',
  'assistantHistory',
  'ownerGeo',
  'ownerGeoManual',
  'weatherLive',
  'weatherLiveCounter',
  'assistantPending',
  // Legacy/Mini App keys, знайдені в inventory 2026-09-16. Це не «технічні
  // деталі»: settings містить тихі години й вимкнені модулі, agentRuns —
  // контекст незавершеного прогону, publicStatus — часовий слід активності.
  'settings',
  'agentRuns',
  'inboxDayCount',
  'publicStatus',
  'weeklyReviewState',
  'security_hint_at',
  'steamSaleShare',
];

/**
 * Остання квитанція T2. Вона містить тільки дату, лічильники та статуси, без
 * id/текстів, тому переживає «забудь усе» як доказ scope. Помилка зберігає
 * локальні адресати, доки зовнішній cleanup не підтверджено.
 */
export const DELETION_RECEIPT_KEY = 'dataDeletionReceipt';

/**
 * Історія квитанцій не є одним JSON-масивом у KV. Кілька T2 можуть завершуватись
 * близько в часі (наприклад, retry після тимчасового збою), а read-modify-write
 * масиву в KV загубив би один із записів. Кожна квитанція має власний ключ;
 * поточний ключ вище лишається канонічним джерелом для scheduler-resume.
 */
export const DELETION_RECEIPT_HISTORY_PREFIX = 'dataDeletionReceipt:';
export const DELETION_RECEIPT_RETENTION_DAYS = 90;
export const DELETION_RECEIPT_HISTORY_LIMIT = 20;
const DELETION_RECEIPT_RETENTION_MS = DELETION_RECEIPT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const RECEIPT_STATUSES = new Set(['running', 'completed', 'failed', 'waiting_for_active_runs']);
const STAGE_STATUSES = new Set(['pending', 'running', 'completed']);
const DELETION_STAGE_KEYS = ['queues', 'sdkSessions', 'vectors', 'backups', 'local'];

/** @typedef {{ status: string, count: number, rows?: number, kvKeys?: number }} DeletionStageReport */
/** @typedef {{ fingerprint: string, requestedAt: string, updatedAt: string, retainedUntil: string, status: string, scope: 'all', stages: Record<string, DeletionStageReport>, error: string|null }} DeletionReceiptReport */

/**
 * ⚠️ ЩО СЮДИ НЕ ПОТРАПИЛО І ЧОМУ (ревʼю виправлень).
 *   `sentMessages` - ring-buffer id повідомлень бота для `/clear`. Стерши
 *     його, «забудь усе» прибрало б ЄДИНИЙ інструмент прибирання: старі
 *     повідомлення лишились би в чаті назавжди.
 *   `backupState` - мітка «бекап цієї неділі зроблено». Без неї найближчий
 *     тік після 04:00 вирішив би, що бекап не відбувся, і послав алерт про
 *     неіснуючий збій (а до 04:00 - зробив би другий бекап).
 *   `monoReconcile` - крок звірки з банком; його скидання запустило б
 *     повторне первинне завантаження за 31 добу.
 * Усі три - службовий стан, а не дані власника.
 */

/** Поля даних усередині canonical `state` (службовий ключ лишається живим). */
export const FORGET_ALL_STATE_FIELDS = [
  'reminders',
  'shownMail',
  'shownNews',
  'shownJobs',
  'mailTriage',
  'calendarToday',
  'roadmapProgress',
];

/**
 * Стерти все. Спочатку прибирає похідні/віддалені копії, і лише потім D1 та
 * KV. Квитанція переходить у `completed`, `failed` або тимчасово
 * `waiting_for_active_runs`; у failed цей виклик кидає, тож policy не скаже
 * власнику хибне «все стерто».
 * @param {Env} env
 * @returns {Promise<{ pending: true, receiptId: string } | { tables: number, rows: number, kvKeys: number, receiptId: string, external: { queues: number, sdkSessions: number, vectors: number, backups: number } }>}
 */
export async function forgetAll(env) {
  if (!env.DB) throw new Error('привʼязки DB немає - стирання неможливе');
  const nowMs = Date.now();
  /** @type {Record<string, any>} */
  const receipt = {
    id: `del-${crypto.randomUUID()}`,
    requestedAt: new Date(nowMs).toISOString(),
    status: 'running',
    scope: 'all',
    stages: {
      sdkSessions: { status: 'pending', count: 0 },
      vectors: { status: 'pending', count: 0 },
      backups: { status: 'pending', count: 0 },
      queues: { status: 'pending', count: 0 },
      local: { status: 'pending', rows: 0, kvKeys: 0 },
    },
  };
  // Якщо не можемо зберегти факт старту, не починаємо незворотні кроки.
  await writeDeletionReceipt(env, receipt);
  return continueForgetAll(env, receipt);
}

/**
 * Планувальник завершує лише T2, відкладене через активний SDK run. Повторне
 * слово не потрібне: воно вже зафіксоване у receipt, а дані ще не видалені.
 * @param {Env} env
 */
export async function resumePendingForgetAll(env) {
  let receipt;
  try {
    receipt = JSON.parse((await env.BRIEFING.get(DELETION_RECEIPT_KEY)) ?? 'null');
  } catch {
    return { skipped: 'invalid-receipt' };
  }
  if (!receipt || receipt.scope !== 'all' || receipt.status !== 'waiting_for_active_runs') {
    return { skipped: 'none' };
  }
  if (!env.DB) throw new Error('привʼязки DB немає - продовжити стирання неможливо');
  receipt.status = 'running';
  receipt.resumedAt = new Date(Date.now()).toISOString();
  await writeDeletionReceipt(env, receipt);
  return continueForgetAll(env, receipt);
}

/**
 * Безпечний owner-facing зріз історії T2. Він не повертає ні внутрішній id
 * квитанції, ні зовнішні адресати/stack/error detail: власнику потрібен чесний
 * стан cleanup, а не нова копія потенційно приватних даних у Mini App.
 *
 * Старий одиничний ключ додається як fallback, тому rollout не втрачає
 * квитанцію, записану до появи історії.
 * @param {Env} env
 * @param {number} [nowMs]
 */
export async function readDeletionReceiptHistory(env, nowMs = Date.now()) {
  /** @type {Record<string, any>[]} */
  const rawReceipts = [];
  try {
    for (const key of await listDeletionReceiptKeys(env)) {
      try {
        const parsed = JSON.parse((await env.BRIEFING.get(key.name)) ?? 'null');
        if (parsed && typeof parsed === 'object') rawReceipts.push(parsed);
      } catch {
        // Один битий запис не має ховати решту історії.
      }
    }
  } catch {
    // KV list може бути тимчасово недоступний; нижче ще спробуємо current receipt.
  }

  try {
    const current = JSON.parse((await env.BRIEFING.get(DELETION_RECEIPT_KEY)) ?? 'null');
    if (current && typeof current === 'object') rawReceipts.push(current);
  } catch {
    // Порожній/битий current receipt означає лише відсутню історію, не 500.
  }

  const seen = new Set();
  const reports = rawReceipts
    .map((receipt) => shapeDeletionReceiptReport(receipt, nowMs))
    .filter(isDeletionReceiptReport)
    .filter((receipt) => !seen.has(receipt.fingerprint) && seen.add(receipt.fingerprint));
  return reports
    .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
    .slice(0, DELETION_RECEIPT_HISTORY_LIMIT)
    .map((receipt) => ({
      requestedAt: receipt.requestedAt,
      updatedAt: receipt.updatedAt,
      retainedUntil: receipt.retainedUntil,
      status: receipt.status,
      scope: receipt.scope,
      stages: receipt.stages,
      error: receipt.error,
    }));
}

/** @param {DeletionReceiptReport|null} receipt @returns {receipt is DeletionReceiptReport} */
function isDeletionReceiptReport(receipt) {
  return receipt !== null;
}

/** @param {Env} env @param {Record<string, any>} receipt */
async function continueForgetAll(env, receipt) {
  const nowMs = Date.now();
  try {
    receipt.stages.queues.status = 'running';
    await writeDeletionReceipt(env, receipt);
    receipt.stages.queues.count = await eraseAllQueuedRuns(env, nowMs);
    receipt.stages.queues.status = 'completed';

    receipt.stages.sdkSessions.status = 'running';
    await writeDeletionReceipt(env, receipt);
    receipt.stages.sdkSessions.count = await eraseAllSdkTranscripts(env, receipt.id, nowMs);
    receipt.stages.sdkSessions.status = 'completed';

    receipt.stages.vectors.status = 'running';
    await writeDeletionReceipt(env, receipt);
    receipt.stages.vectors.count = await eraseAllMemoryVectors(env);
    receipt.stages.vectors.status = 'completed';

    receipt.stages.backups.status = 'running';
    await writeDeletionReceipt(env, receipt);
    receipt.stages.backups.count = await eraseAllManagedBackups(env);
    receipt.stages.backups.status = 'completed';

    receipt.stages.local.status = 'running';
    await writeDeletionReceipt(env, receipt);
    const local = await eraseLocalData(env);
    receipt.stages.local.rows = local.rows;
    receipt.stages.local.kvKeys = local.kvKeys;
    receipt.stages.local.status = 'completed';
    receipt.status = 'completed';
    receipt.completedAt = new Date(Date.now()).toISOString();
    await writeDeletionReceipt(env, receipt);
    return {
      tables: FORGET_ALL_TABLES.length,
      rows: local.rows,
      kvKeys: local.kvKeys,
      receiptId: receipt.id,
      external: {
        queues: receipt.stages.queues.count,
        sdkSessions: receipt.stages.sdkSessions.count,
        vectors: receipt.stages.vectors.count,
        backups: receipt.stages.backups.count,
      },
    };
  } catch (/** @type {any} */ e) {
    if (e instanceof ActiveBrainRunsError) {
      receipt.status = 'waiting_for_active_runs';
      receipt.deferredAt = new Date(Date.now()).toISOString();
      receipt.error =
        'Очікую завершення активного прогону; наступний scheduler tick продовжить cleanup.';
      await writeDeletionReceipt(env, receipt);
      return { pending: /** @type {true} */ (true), receiptId: receipt.id };
    }
    receipt.status = 'failed';
    receipt.failedAt = new Date(Date.now()).toISOString();
    // Без stack/id/текстів: receipt — не нове сховище приватного вмісту.
    receipt.error = deletionErrorSummary(e);
    try {
      await writeDeletionReceipt(env, receipt);
    } catch (writeError) {
      console.error('forget: квитанцію про збій не збережено', writeError);
    }
    throw e;
  }
}

/** Локальна частина виконується лише після зовнішніх підтверджень. @param {Env} env */
async function eraseLocalData(env) {
  const db = /** @type {NonNullable<Env['DB']>} */ (env.DB);
  let rows = 0;
  for (const table of FORGET_ALL_TABLES) {
    // Імена - з константного списку, не з вводу.
    const res = await db.prepare(`DELETE FROM ${table}`).bind().run();
    rows += Number(res?.meta?.changes ?? 0);
  }
  // Лічильники не видаляємо, а обнуляємо: рядок потрібен коду, значення - ні.
  await db.prepare('UPDATE counters SET value = 0').bind().run();
  for (const fts of FORGET_ALL_FTS) {
    await db.prepare(`DELETE FROM ${fts}`).bind().run();
  }

  // Canonical pending-proposal slot не є KV-копією: T2 має стерти його ДО
  // legacy mirror, інакше старе ✅ могло б пережити «забудь усе» у DO.
  await pendingClear(env);
  // /clear ring buffer має окремий canonical DO, тож KV delete недостатній.
  await clearSentMessages(env);
  await clearAssistantHistory(env);
  await assistantResumeClear(env);
  await weatherQuotaClear(env);

  let kvKeys = 0;
  for (const key of FORGET_ALL_KV_KEYS) {
    if ((await env.BRIEFING.get(key)) != null) {
      await env.BRIEFING.delete(key);
      kvKeys += 1;
    }
  }
  // `settings` уже canonical у StateStoreDO. Не дзеркалимо дефолти назад у
  // KV: T2 має лишити ключ видаленим, а DO-запис — порожнім.
  await clearSettings(env);
  // У новому rollout `stats` вже authoritative у StateStoreDO, а KV-ключ
  // лише сумісний snapshot. У legacy fallback він щойно видалений вище і
  // чіпати його не можна (інакше повернемо порожній ключ назад).
  if (typeof env.STATE_STORE?.getByName === 'function') {
    await updateStats(env, () => ({}));
  }
  await clearStateFields(env);
  return { rows, kvKeys };
}

/** @param {Env} env */
async function clearStateFields(env) {
  await updateState(env, (current) => {
    const blob = { ...current };
    let touched = false;
    for (const field of FORGET_ALL_STATE_FIELDS) {
      if (field in blob) {
        delete blob[field];
        touched = true;
      }
    }
    return touched ? blob : current;
  });
}

/** @param {unknown} value */
function safeIso(value) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return null;
  return value;
}

/** @param {unknown} value */
function safeCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/**
 * Коротка категорія збою замість сирого повідомлення адаптера. Останнє може
 * містити URL, id сесії чи діагностику стороннього сервісу, а квитанція — не
 * діагностичний лог. Локальні дані у всіх цих станах лишаються на місці.
 * @param {unknown} error
 */
function deletionErrorSummary(error) {
  const text = String(/** @type {any} */ (error)?.message ?? error ?? '');
  if (/active.*run|активн.*прогон/i.test(text)) {
    return 'Очікую завершення активного прогону; cleanup буде повторено автоматично.';
  }
  if (/VPS|SDK/i.test(text)) return 'VPS SDK не підтвердив видалення; локальні дані збережено.';
  if (/VECTORIZE|вектор/i.test(text)) {
    return 'Vectorize не підтвердив видалення; локальні дані збережено.';
  }
  if (/Drive|backup|OAuth/i.test(text)) {
    return 'Drive backup не підтвердив видалення; локальні дані збережено.';
  }
  if (/D1|DB|баз/i.test(text)) return 'Локальне стирання не завершилось; дані збережено.';
  return 'Крок видалення завершився помилкою; локальні дані збережено.';
}

/** @param {Record<string, any>} receipt @param {number} nowMs @returns {DeletionReceiptReport|null} */
function shapeDeletionReceiptReport(receipt, nowMs) {
  const requestedAt = safeIso(receipt.requestedAt);
  if (!requestedAt || receipt.scope !== 'all' || !RECEIPT_STATUSES.has(receipt.status)) return null;
  const requestedMs = Date.parse(requestedAt);
  if (nowMs - requestedMs > DELETION_RECEIPT_RETENTION_MS) return null;
  /** @type {Record<string, DeletionStageReport>} */
  const stages = {};
  for (const key of DELETION_STAGE_KEYS) {
    const stage = receipt.stages?.[key] ?? {};
    stages[key] = {
      status: STAGE_STATUSES.has(stage.status) ? stage.status : 'pending',
      count: safeCount(stage.count),
      ...(key === 'local' ? { rows: safeCount(stage.rows), kvKeys: safeCount(stage.kvKeys) } : {}),
    };
  }
  // fingerprint живе лише всередині функції: id може бути legacy/malformed,
  // тому дедуплікуємо за безпечним набором полів і НІКОЛИ не віддаємо його UI.
  const fingerprint = `${receipt.id ?? ''}:${requestedAt}`;
  return {
    fingerprint,
    requestedAt,
    updatedAt: safeIso(receipt.updatedAt) ?? requestedAt,
    retainedUntil: new Date(requestedMs + DELETION_RECEIPT_RETENTION_MS).toISOString(),
    status: receipt.status,
    scope: 'all',
    stages,
    error: receipt.status === 'failed' ? deletionErrorSummary(receipt.error) : null,
  };
}

/** @param {Record<string, any>} receipt */
function deletionReceiptHistoryKey(receipt) {
  // requestedAt створює сам код. Fallback потрібен лише для legacy receipt,
  // який scheduler може продовжити після rollout.
  const stamp = String(receipt.requestedAt ?? receipt.id ?? 'legacy').replace(/[^0-9A-Za-z]/g, '');
  return `${DELETION_RECEIPT_HISTORY_PREFIX}${stamp}-${String(receipt.id ?? 'legacy').slice(0, 64)}`;
}

/** @param {Env} env */
async function listDeletionReceiptKeys(env) {
  /** @type {{ name: string }[]} */
  const keys = [];
  /** @type {string|undefined} */
  let cursor;
  do {
    const page = await env.BRIEFING.list({
      prefix: DELETION_RECEIPT_HISTORY_PREFIX,
      ...(cursor ? { cursor } : {}),
    });
    keys.push(...page.keys);
    // Старі локальні стаби не мають list_complete/cursor. Відсутній cursor
    // коректно означає останню (і єдину) сторінку, як у реальному KV.
    cursor = page.list_complete === false ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

/** @param {Env} env @param {Record<string, any>} receipt */
async function writeDeletionReceipt(env, receipt) {
  const next = { ...receipt, updatedAt: new Date().toISOString() };
  Object.assign(receipt, next);
  // current спершу: якщо другий write впаде, scheduler все ще бачить незавершену
  // T2 і наступний tick зможе повторити запис без втрати адресатів для cleanup.
  await env.BRIEFING.put(DELETION_RECEIPT_KEY, JSON.stringify(next));
  const requestedMs = Date.parse(String(receipt.requestedAt));
  // Історичний ключ реально зникає з KV, а не лише фільтрується з відповіді.
  // TTL рахуємо від requestedAt: повторний scheduler tick не має непомітно
  // продовжувати retention одного й того самого T2 ще на 90 діб.
  const ttlSec = Math.max(
    60,
    Math.ceil((requestedMs + DELETION_RECEIPT_RETENTION_MS - Date.now()) / 1000),
  );
  await env.BRIEFING.put(deletionReceiptHistoryKey(next), JSON.stringify(next), {
    expirationTtl: ttlSec,
  });
  // Cleanup не бере участі в доказі поточного кроку: якщо KV list тимчасово
  // впав, уже записана квитанція лишається читабельною, а наступне T2/retry
  // повторить maintenance. Окремі ключі роблять цей best-effort безпечним для
  // паралельних записів — тут немає RMW спільного масиву.
  await pruneDeletionReceiptHistory(env, Date.now()).catch((error) =>
    console.error('forget: не вдалося прибрати старі квитанції', error),
  );
}

/** @param {Env} env @param {number} nowMs */
async function pruneDeletionReceiptHistory(env, nowMs) {
  const rows = await Promise.all(
    (await listDeletionReceiptKeys(env)).map(async (key) => {
      try {
        const receipt = JSON.parse((await env.BRIEFING.get(key.name)) ?? 'null');
        return { key: key.name, requestedAt: safeIso(receipt?.requestedAt) };
      } catch {
        return { key: key.name, requestedAt: null };
      }
    }),
  );
  const expired = rows.filter(
    (row) =>
      !row.requestedAt || nowMs - Date.parse(row.requestedAt) > DELETION_RECEIPT_RETENTION_MS,
  );
  const fresh = rows
    .filter((row) => row.requestedAt && !expired.includes(row))
    .sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt)));
  const excess = fresh.slice(DELETION_RECEIPT_HISTORY_LIMIT);
  await Promise.all([...expired, ...excess].map((row) => env.BRIEFING.delete(row.key)));
}
