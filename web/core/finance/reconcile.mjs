// Звірка з Mono (07 §7 `mono-reconcile`, S-4-9, S-4-11, S-4-12, 01 §3.6).
//
// Щодня о 23:30 Києва: перевірити, що вебхук стоїть на нашій адресі, і
// перечитати виписку за добу - дедуп за id закриває все, що вебхук не доніс
// (Mono знімає адресу після кількох невдач і не повторює доставку).
//
// ⚠️ Ліміт Mono - один запит на 60 секунд на КОЖЕН читальний ендпоїнт, тому
// задача робить РІВНО ОДИН зовнішній виклик за тік планувальника (тік = 5 хв
// > 60 с) і тримає крок у KV. Це ж дає безкоштовно S-4-11: первинне
// завантаження за 31 добу йде рахунок за рахунком, по одному на тік.
//
// Список рахунків (`facts.setting.mono_accounts`) - ще й бар'єр вебхука
// (S-4-12), тому фаза `client` вмикається САМА, у будь-яку годину, поки
// списку немає: інакше перший день після встановлення секрету вебхук
// відмовляв би всім транзакціям до 23:30.

import { kyivDateKey, kyivHour, kyivMinuteOfDay } from '../../kyiv-time.mjs';
import { kyivDayStartMs } from './query.mjs';
import { sendSystemAlert } from '../tg/outbox.mjs';
import { MonoTooSoonError, clientInfo, setWebhook, statement } from '../adapters/mono.mjs';
import { isLoud } from './rules.mjs';
import { announceTransaction } from './notify.mjs';
import { monoWebhookUrl } from './webhook.mjs';
import {
  monoReconcileClaim,
  monoReconcileComplete,
  monoReconcileRelease,
} from '../mono-reconcile/client.mjs';
import { MONO_RECONCILE_LEASE_MS } from '../mono-reconcile/contract.mjs';
import {
  hasAnyTransaction,
  ingestTransaction,
  readMonoAccounts,
  writeMonoAccounts,
} from './store.mjs';

/** Година й хвилина звірки за Києвом (07 §7). */
export const RECONCILE_HOUR = 23;
export const RECONCILE_MINUTE = 30;
/** Compatibility mirror key; canonical state belongs to MonoReconcileDO. */
export const RECONCILE_STATE_KEY = 'monoReconcile';
/** Вікно первинного завантаження (S-4-11: ліміт вікна Mono - 31 доба). */
export const INITIAL_DAYS = 31;
/** Скільки пропущених покупок називаємо поштучно; решта - одним рядком. */
export const ANNOUNCE_MAX = 3;
/** Скільки живе сеанс звірки: досить, щоб дійти до останнього рахунку. */
export const SESSION_MAX_MS = 4 * 3_600_000;

/**
 * @typedef {{ date: string, phase: 'client' | 'statement' | 'done', idx: number,
 *   initial: boolean, fromS: number, toS: number, imported: number, loud: number,
 *   startedMs: number, alerted: boolean }} ReconcileState
 */

/** Стан сеансу з KV; null - сеансу ще не було. @param {Env} env
 *  @returns {Promise<ReconcileState | null>} */
async function readState(env) {
  /** @type {any} */
  let saved = null;
  try {
    saved = JSON.parse((await env.BRIEFING.get(RECONCILE_STATE_KEY)) ?? 'null');
  } catch (/** @type {any} */ e) {
    console.error('mono-reconcile: стан не читається, починаю з нуля', e?.message);
  }
  return normalizeState(saved);
}

/** @param {unknown} saved @returns {ReconcileState | null} */
function normalizeState(saved) {
  const raw = /** @type {any} */ (saved);
  if (!raw?.date) return null;
  return {
    date: String(raw.date),
    phase: raw.phase === 'statement' || raw.phase === 'done' ? raw.phase : 'client',
    idx: Number.isInteger(raw.idx) ? raw.idx : 0,
    initial: raw.initial === true,
    fromS: Number(raw.fromS) || 0,
    toS: Number(raw.toS) || 0,
    imported: Number(raw.imported) || 0,
    loud: Number(raw.loud) || 0,
    startedMs: Number(raw.startedMs) || 0,
    alerted: raw.alerted === true,
  };
}

/** @param {string} today @param {number} nowMs @returns {ReconcileState} */
function freshState(today, nowMs) {
  return {
    date: today,
    phase: 'client',
    idx: 0,
    initial: false,
    fromS: 0,
    toS: 0,
    imported: 0,
    loud: 0,
    startedMs: nowMs,
    alerted: false,
  };
}

/**
 * Задача `mono-reconcile`.
 * @param {Env} env @param {number} [nowMs]
 */
export async function monoReconcileTask(env, nowMs = Date.now()) {
  if (!env.DB) {
    console.error('mono-reconcile: привʼязки DB немає - звірка неможлива');
    return { skipped: 'no-db' };
  }
  if (!env.MONO_TOKEN) {
    // Тиха деградація заборонена, але й алерт щопʼять хвилин - не діло:
    // відсутній ключ видно в логах і в /status.
    console.error('mono-reconcile: MONO_TOKEN не заданий - звірки немає');
    return { skipped: 'no-token' };
  }

  const now = new Date(nowMs);
  const today = kyivDateKey(now);
  const minute = kyivMinuteOfDay(now);
  const accounts = await readMonoAccounts(env);
  const dueByClock = kyivHour(now) === RECONCILE_HOUR && minute % 60 >= RECONCILE_MINUTE;

  const legacyState = await readState(env);
  const claim = await monoReconcileClaim(env, legacyState, nowMs, MONO_RECONCILE_LEASE_MS);
  if (!claim.ok) return { skipped: claim.reason ?? 'busy' };
  const state = normalizeState(claim.state);
  // Незакінчений сеанс ПРОДОВЖУЄМО в будь-яку годину. Вікно [23:30, 24:00) -
  // це лише шість тіків, тобто пʼять рахунків після фази client-info; шостий
  // не звірявся б ніколи, бо опівночі змінюється київська доба. Тепер доба
  // визначає, коли сеанс ПОЧАТИ, а не коли його обірвати.
  const running = state != null && state.phase !== 'done';
  const startNew = dueByClock && state?.date !== today;
  // Списку рахунків немає - вебхук відмовляє всім транзакціям (S-4-12), тож
  // не чекаємо 23:30, а йдемо по нього одразу. Але РІВНО РАЗ на добу: якщо
  // Mono взагалі не віддає рахунків, список так і лишиться порожнім, і без
  // цієї умови фаза client-info крутилася б щопʼять хвилин разом з алертом.
  const startNow = !accounts.length && !running && state?.date !== today;
  if (!running && !startNew && !startNow) {
    if (claim.canonical) await monoReconcileRelease(env, claim.token);
    return { skipped: state?.date === today ? 'done' : 'not-due' };
  }
  const live = running ? /** @type {ReconcileState} */ (state) : freshState(today, nowMs);
  let completed = false;
  /** @param {ReconcileState} next */
  const writeState = async (next) => {
    const ok = await monoReconcileComplete(env, claim.token, next);
    if (!ok) throw new Error('mono-reconcile lease втрачено під час commit');
    completed = true;
  };
  // Сеанс не вічний. Продовження після опівночі потрібне, щоб дійти до
  // останнього рахунку; але якщо Mono лежить, кожен тік ловив би виняток - і
  // без цієї стелі власник діставав би 288 однакових скарг на добу.
  if (live.startedMs && nowMs - live.startedMs > SESSION_MAX_MS) {
    await writeState({ ...live, phase: 'done' });
    if (!live.alerted) {
      await sendSystemAlert(
        env,
        '⚠️ Звірка Mono не дійшла до кінця за ніч - спробую завтра.',
        nowMs,
      );
    }
    return { skipped: 'session-expired' };
  }

  try {
    if (live.phase === 'client') return await phaseClient(env, live, nowMs, writeState);
    return await phaseStatement(env, live, accounts, nowMs, writeState);
  } catch (/** @type {any} */ e) {
    if (e instanceof MonoTooSoonError) {
      // Не збій: наступний тік через 5 хв - Mono вже пустить.
      console.log('mono-reconcile: Mono просить зачекати, спробую наступним тіком');
      return { skipped: 'too-soon' };
    }
    console.error(`mono-reconcile: фаза ${live.phase} впала`, e?.message);
    // Скаржимось РАЗ на сеанс: наступні тіки повторюють ту саму фазу, і
    // повторювати той самий алерт кожні пʼять хвилин - не інформація, а шум.
    if (!live.alerted) {
      await sendSystemAlert(env, `⚠️ Звірка Mono впала: ${String(e?.message ?? e)}`, nowMs);
      await writeState({ ...live, alerted: true });
    }
    return { failed: live.phase };
  } finally {
    if (!completed && claim.canonical) await monoReconcileRelease(env, claim.token);
  }
}

/**
 * Фаза 1: client-info - рахунки власника і чинна адреса вебхука (S-4-9).
 * @param {Env} env @param {ReconcileState} state @param {number} nowMs
 * @param {(state: ReconcileState) => Promise<void>} writeState
 */
async function phaseClient(env, state, nowMs, writeState) {
  const info = await clientInfo(env);
  const accounts = info.accounts.map((a) => ({
    id: a.id,
    currency: a.currency,
    maskedPan: a.maskedPan,
  }));
  if (!accounts.length) {
    await sendSystemAlert(env, '⚠️ Mono не віддав жодного рахунку - звірка без цілі.', nowMs);
    await writeState({ ...state, phase: 'done' });
    return { skipped: 'no-accounts' };
  }
  await writeMonoAccounts(env, accounts, nowMs);

  let rearmed = false;
  const origin = String(env.MINI_APP_URL ?? '').replace(/\/+$/, '');
  if (!origin) {
    console.error('mono-reconcile: MINI_APP_URL не заданий - адресу вебхука не перевірити');
  } else {
    const expected = monoWebhookUrl(env, origin);
    if (info.webHookUrl !== expected) {
      await setWebhook(env, expected);
      rearmed = true;
      await sendSystemAlert(
        env,
        info.webHookUrl
          ? '⚠️ Вебхук Mono вказував не на нас - поставив свою адресу заново.'
          : '⚠️ Вебхук Mono був порожній - поставив заново.',
        nowMs,
      );
    }
  }

  // Первинне завантаження (S-4-11) - лише коли транзакцій ще жодної.
  const initial = !(await hasAnyTransaction(env));
  const toS = Math.floor(nowMs / 1000);
  const fromS = initial ? toS - INITIAL_DAYS * 86_400 : dayStartS(nowMs);
  await writeState({ ...state, phase: 'statement', idx: 0, initial, fromS, toS });
  return { accounts: accounts.length, rearmed, initial };
}

/**
 * Фаза 2: виписка одного рахунку за тік.
 * @param {Env} env @param {ReconcileState} state
 * @param {import('./store.mjs').StoredAccount[]} accounts @param {number} nowMs
 * @param {(state: ReconcileState) => Promise<void>} writeState
 */
async function phaseStatement(env, state, accounts, nowMs, writeState) {
  const account = accounts[state.idx];
  if (!account) {
    await writeState({ ...state, phase: 'done' });
    return await finish(env, state, nowMs);
  }
  const items = await statement(env, {
    account: account.id,
    fromS: state.fromS,
    toS: state.toS,
  });
  let imported = 0;
  let loud = state.loud;
  // Старіші перші: власник побачить пропущені покупки в тому ж порядку, у
  // якому вони сталися.
  for (const item of [...items].reverse()) {
    const { inserted, tx } = await ingestTransaction(env, {
      item,
      account: account.id,
      accountCurrency: account.currency,
      silent: state.initial,
    });
    if (!inserted || !tx) continue;
    imported += 1;
    if (isLoud(tx.flags)) {
      loud += 1;
      // Перші кілька - повноцінними повідомленнями з кнопками; далі рядок
      // у підсумку, щоб добова прогалина не перетворилась на потік.
      if (loud <= ANNOUNCE_MAX) await announceTransaction(env, tx, nowMs);
    }
  }
  const next = {
    ...state,
    idx: state.idx + 1,
    imported: state.imported + imported,
    loud,
  };
  if (next.idx >= accounts.length) {
    await writeState({ ...next, phase: 'done' });
    return await finish(env, next, nowMs);
  }
  await writeState(next);
  return { account: account.id, imported, pending: accounts.length - next.idx };
}

/**
 * Підсумок звірки. Мовчимо, коли нічого не змінилось - штатний результат.
 * @param {Env} env @param {ReconcileState} state @param {number} nowMs
 */
async function finish(env, state, nowMs) {
  if (state.initial && state.imported) {
    await sendSystemAlert(
      env,
      `Завантажив історію Mono за ${INITIAL_DAYS} діб: ${state.imported} транзакцій.`,
      nowMs,
    );
  } else if (state.loud > ANNOUNCE_MAX) {
    await sendSystemAlert(
      env,
      `Звірка Mono: ще ${state.loud - ANNOUNCE_MAX} незвичних покупок, поки вебхук мовчав.`,
      nowMs,
    );
  }
  return { done: true, imported: state.imported, loud: state.loud };
}

/** Київська північ сьогодні в unix-секундах (той самий розрахунок, що у
 *  finance.query - разом із зрізаними секундами). @param {number} nowMs */
function dayStartS(nowMs) {
  return Math.floor(kyivDayStartMs(nowMs) / 1000);
}
