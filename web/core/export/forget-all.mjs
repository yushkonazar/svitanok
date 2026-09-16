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
//   нього і власні ключі даних (перелік нижче).

import { BACKUP_TABLES } from '../backup/core.mjs';
import { updateState, updateStats } from '../../kv-store.mjs';
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
    receipt.error = String(e?.message ?? 'невідомий збій').slice(0, 240);
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

  let kvKeys = 0;
  for (const key of FORGET_ALL_KV_KEYS) {
    if ((await env.BRIEFING.get(key)) != null) {
      await env.BRIEFING.delete(key);
      kvKeys += 1;
    }
  }
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

/** @param {Env} env @param {Record<string, unknown>} receipt */
async function writeDeletionReceipt(env, receipt) {
  await env.BRIEFING.put(DELETION_RECEIPT_KEY, JSON.stringify(receipt));
}
