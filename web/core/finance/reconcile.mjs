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
import { sendSystemAlert } from '../tg/outbox.mjs';
import { MonoTooSoonError, clientInfo, setWebhook, statement } from '../adapters/mono.mjs';
import { isLoud } from './rules.mjs';
import { announceTransaction } from './notify.mjs';
import { monoWebhookUrl } from './webhook.mjs';
import {
  hasAnyTransaction,
  ingestTransaction,
  readMonoAccounts,
  writeMonoAccounts,
} from './store.mjs';

/** Година й хвилина звірки за Києвом (07 §7). */
export const RECONCILE_HOUR = 23;
export const RECONCILE_MINUTE = 30;
/** Ключ стану машини в KV. */
export const RECONCILE_STATE_KEY = 'monoReconcile';
/** Вікно первинного завантаження (S-4-11: ліміт вікна Mono - 31 доба). */
export const INITIAL_DAYS = 31;
/** Скільки пропущених покупок називаємо поштучно; решта - одним рядком. */
export const ANNOUNCE_MAX = 3;

/**
 * @typedef {{ date: string, phase: 'client' | 'statement' | 'done', idx: number,
 *   initial: boolean, fromS: number, toS: number, imported: number, loud: number }} ReconcileState
 */

/** @param {Env} env @param {string} today @returns {Promise<ReconcileState>} */
async function readState(env, today) {
  /** @type {any} */
  let saved = null;
  try {
    saved = JSON.parse((await env.BRIEFING.get(RECONCILE_STATE_KEY)) ?? 'null');
  } catch (/** @type {any} */ e) {
    console.error('mono-reconcile: стан не читається, починаю з нуля', e?.message);
  }
  if (saved?.date === today) {
    return {
      date: today,
      phase: saved.phase === 'statement' || saved.phase === 'done' ? saved.phase : 'client',
      idx: Number.isInteger(saved.idx) ? saved.idx : 0,
      initial: saved.initial === true,
      fromS: Number(saved.fromS) || 0,
      toS: Number(saved.toS) || 0,
      imported: Number(saved.imported) || 0,
      loud: Number(saved.loud) || 0,
    };
  }
  return {
    date: today,
    phase: 'client',
    idx: 0,
    initial: false,
    fromS: 0,
    toS: 0,
    imported: 0,
    loud: 0,
  };
}

/** @param {Env} env @param {ReconcileState} state */
async function writeState(env, state) {
  await env.BRIEFING.put(RECONCILE_STATE_KEY, JSON.stringify(state));
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
  // Списку рахунків немає - вебхук відмовляє всім транзакціям (S-4-12), тож
  // не чекаємо 23:30, а йдемо по нього одразу.
  if (!dueByClock && accounts.length) return { skipped: 'not-due' };

  const state = await readState(env, today);
  if (state.phase === 'done') return { skipped: 'done' };

  try {
    if (state.phase === 'client') return await phaseClient(env, state, nowMs);
    return await phaseStatement(env, state, accounts, nowMs);
  } catch (/** @type {any} */ e) {
    if (e instanceof MonoTooSoonError) {
      // Не збій: наступний тік через 5 хв - Mono вже пустить.
      console.log('mono-reconcile: Mono просить зачекати, спробую наступним тіком');
      return { skipped: 'too-soon' };
    }
    console.error(`mono-reconcile: фаза ${state.phase} впала`, e?.message);
    await sendSystemAlert(env, `⚠️ Звірка Mono впала: ${String(e?.message ?? e)}`, nowMs);
    // Мітка дня НЕ ставиться: наступний тік спробує ту саму фазу ще раз.
    return { failed: state.phase };
  }
}

/**
 * Фаза 1: client-info - рахунки власника і чинна адреса вебхука (S-4-9).
 * @param {Env} env @param {ReconcileState} state @param {number} nowMs
 */
async function phaseClient(env, state, nowMs) {
  const info = await clientInfo(env);
  const accounts = info.accounts.map((a) => ({
    id: a.id,
    currency: a.currency,
    maskedPan: a.maskedPan,
  }));
  if (!accounts.length) {
    await sendSystemAlert(env, '⚠️ Mono не віддав жодного рахунку - звірка без цілі.', nowMs);
    await writeState(env, { ...state, phase: 'done' });
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
  await writeState(env, { ...state, phase: 'statement', idx: 0, initial, fromS, toS });
  return { accounts: accounts.length, rearmed, initial };
}

/**
 * Фаза 2: виписка одного рахунку за тік.
 * @param {Env} env @param {ReconcileState} state
 * @param {import('./store.mjs').StoredAccount[]} accounts @param {number} nowMs
 */
async function phaseStatement(env, state, accounts, nowMs) {
  const account = accounts[state.idx];
  if (!account) {
    await writeState(env, { ...state, phase: 'done' });
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
    await writeState(env, { ...next, phase: 'done' });
    return await finish(env, next, nowMs);
  }
  await writeState(env, next);
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

/** Київська північ сьогодні в unix-секундах. @param {number} nowMs */
function dayStartS(nowMs) {
  const minute = kyivMinuteOfDay(new Date(nowMs));
  return Math.floor((nowMs - minute * 60_000) / 1000);
}
