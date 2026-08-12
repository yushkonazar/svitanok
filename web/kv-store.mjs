// Доступ до KV — одне місце для КЛЮЧІВ і патернів читання/запису
// (Фаза 5, модуляризація worker.js, план A2 §5).
//
// НАВІЩО ЦЕ ОДИН ФАЙЛ. Ключі — це справжня схема даних проєкту, і досі її можна
// було дізнатись лише грепом по п'яти тисячах рядків. Тепер видно все одразу:
// що є ключем, хто його читає, і — головне — ЧОМУ ключів кілька, а не один
// блоб.
//
// ⚠️ ІНВАРІАНТ, ЗАРАДИ ЯКОГО ВСЕ ЦЕ. KV не має ні CAS, ні read-your-writes.
// Тому:
//   1. Кожен НЕЗАЛЕЖНИЙ писар має ВЛАСНИЙ ключ. Спільний блоб під конкурентним
//      записом мовчки губить дані — це вже ламало прод (19.07: писар `state`
//      затирав пропозицію асистента, і кожен ✅ падав у «Застаріла»). Звідси
//      окремі sentMessages/agentRuns/assistantHistory/assistantPending.
//   2. Де писарів у ключа все одно кілька (`stats`) — читання-запис іде через
//      updateStats з одним retry, а не наївним put.
//   3. Биття JSON НІКОЛИ не валить запит: кожен читач має свій нейтральний
//      дефолт. Порожній стан гірший за помилку лише в теорії; на практиці
//      власник побачив би 500 замість дашборда.

import { normalizeSettings } from './settings-core.mjs';
import { ASSISTANT_HISTORY_TTL_S } from './assistant-memory-core.mjs';

/** Спільний читач: JSON із ключа або дефолт. Биття/відсутність -> дефолт. */
async function readJson(env, key, fallback) {
  try {
    const parsed = JSON.parse((await env.BRIEFING.get(key)) ?? 'null');
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/** Налаштування власника (ключ `settings`, F2) — ОКРЕМИЙ блоб від 'state' (той
 *  ділять кілька писарів; тут пише лише власник із Mini App). Биття -> дефолти.
 *  Цей самий ключ читає оркестратор (src/core/settings-overrides.ts). */
export async function loadSettings(env) {
  return normalizeSettings(await readJson(env, 'settings', null));
}

/** Прочитати стор статистики з KV (ключ `stats`); биття -> {}. */
export async function loadStats(env) {
  return readJson(env, 'stats', {});
}

export async function loadState(env) {
  return readJson(env, 'state', {});
}

/** Ring-buffer message_id надісланих ботом (§C5, /clear) — ОКРЕМИЙ KV-ключ
 *  від 'state', щоб трекінг на КОЖНУ відповідь бота не ділив гонку писарів
 *  з reminders/roadmapProgress/mockWeights/... (той самий блоб 'state'). */
export async function loadSentMessages(env) {
  return readJson(env, 'sentMessages', {});
}

/** Писар того самого ring-buffer. Окремо від читача, бо писарів двоє (репліки
 *  бота й вхідні повідомлення власника) — і обидва мусять merge-before-flush
 *  через recordSentMessage, а не класти сирий обʼєкт. */
export async function putSentMessages(env, sentMessages) {
  await env.BRIEFING.put('sentMessages', JSON.stringify(sentMessages));
}

/** Прочитати останній опублікований брифінг (ключ `latest`) — для own-data
 *  дайджесту асистента (CC4, dataScope "briefing"/"all"); биття -> {}. */
export async function loadLatest(env) {
  return readJson(env, 'latest', {});
}

/** Прочитати ІСТОРИЧНИЙ (не latest!) снапшот дня — callback завжди резолвиться
 *  проти того самого брифінгу, що бачив власник, навіть через кілька днів. */
export async function loadBriefingForDate(env, dateKey) {
  return readJson(env, `briefing:${dateKey}`, {});
}

/** Історія діалогу асистента per-thread (ключ `assistantHistory`, CM) — ОКРЕМИЙ
 *  KV-ключ від 'state' (як sentMessages: запис на кожен обмін не ділить гонку
 *  писарів state-блоба). Биття -> {}. */
export async function loadAssistantHistory(env) {
  return readJson(env, 'assistantHistory', {});
}

/**
 * Єдиний писар памʼяті розмови — щоб TTL стояв в ОДНОМУ місці. Пропущений TTL
 * у другого писаря означав би ключ, що знову живе вічно, і помітити це можна
 * було б хіба випадково (аудит §KV).
 *
 * TTL тут — «стільки тиші»: кожен запис відсуває межу, тож жива розмова не
 * зникає посеред себе, а покинута прибирається сама.
 */
export async function putAssistantHistory(env, history) {
  await env.BRIEFING.put('assistantHistory', JSON.stringify(history), {
    expirationTtl: ASSISTANT_HISTORY_TTL_S,
  });
}

/**
 * Безпечний read-modify-write для 'stats' (оптимістична конкуренція, один
 * retry). KV не має вбудованого CAS, а незалежних писарів у цей ключ кілька:
 * Mini App-події (open/checkin/sleepStart), голосування за новину з чату,
 * і три 5-хвилинні крони (checkinNudgeCheck, sleepNudgeCheck, deadMansCheck).
 * Без цього кожен тихо втрачав зміни іншого (last-write-wins): реальний
 * кейс — власник тапнув «Ліг спати», вранці відкрив застосунок, авто-
 * заповнення sleepH/bedtime відбулось (recordEvent — чиста функція,
 * перевірено ізольовано на реальних даних), але крон, який стартував
 * читання ДО цього відкриття, а дописав у KV ПІСЛЯ (його власні Telegram-
 * виклики — секунди), переписав усе своєю застарілою до-заповнення копією.
 *
 * `patch` — ЧИСТА трансформація (store) -> store (той самий контракт, що
 * вже мають recordEvent/recordReliability, і вони теж уже ідемпотентні
 * всередині — case 'checkin' ігнорує confirmed, recordReliability ігнорує
 * повторний lastCheckDate). Якщо між першим і другим читанням хтось інший
 * встиг записати — застосовуємо ТОЙ САМИЙ patch ще раз до свіжішої копії,
 * замість того щоб мовчки затерти чужі зміни. НІКОЛИ не кладіть сюди
 * побічні ефекти (Telegram-виклики тощо) — вони виконались би двічі при
 * ретраї; лише саму мутацію стану, ПІСЛЯ того як side-effects уже сталися.
 */
export async function updateStats(env, patch) {
  const raw1 = (await env.BRIEFING.get('stats')) ?? '{}';
  let parsed1;
  try {
    parsed1 = JSON.parse(raw1);
  } catch {
    parsed1 = {};
  }
  const result1 = patch(parsed1);
  const json1 = JSON.stringify(result1);
  const raw2 = (await env.BRIEFING.get('stats')) ?? '{}';
  if (raw2 === raw1) {
    await env.BRIEFING.put('stats', json1);
    return result1;
  }
  let parsed2;
  try {
    parsed2 = JSON.parse(raw2);
  } catch {
    parsed2 = {};
  }
  const result2 = patch(parsed2);
  await env.BRIEFING.put('stats', JSON.stringify(result2));
  return result2;
}

/** ВЛАСНИЙ KV-ключ пропозиції — НЕ в блобі 'state'. Причина: блоб 'state' пишуть
 *  наївні read-modify-write писарі (lastUpdateId у вебхуку, крон checkReminders,
 *  дашборд applyEvent) БЕЗ merge-before-flush; KV не має read-your-writes, тож
 *  писар, що прочитав блоб за мить до запису пропозиції, затирає її назад — і
 *  кожен ✅ падає в «Застаріла пропозиція» (баг, знайдений на проді 19.07). Той
 *  самий мотив, що [sentMessages]/[agentRuns]/[assistantHistory] — окремий ключ. */
export const ASSISTANT_PENDING_KEY = 'assistantPending';

/**
 * Прочитати активну пропозицію -> pending|null.
 * Брифінг (src/orchestrator, mail.ts) тепер теж пише СЮДИ напряму (writeKvJson
 * на assistantPending, не в блоб `state`) — legacy-фолбек на `state.assistantPending`
 * прибрано разом із самим записом на тому боці.
 */
export async function loadAssistantPending(env) {
  return readJson(env, ASSISTANT_PENDING_KEY, null);
}

/**
 * Списати пропозицію (double-tap-safe): лише якщо це ДОСІ той самий id.
 * Put-null тумбстоун (не delete: KV без read-your-writes, і delete немає в
 * частині тест-моків — той самий мотив, що markRunFinished). Повертає true,
 * якщо саме цей виклик списав.
 */
export async function claimAssistantPending(env, id) {
  const pending = await loadAssistantPending(env);
  if (!pending || pending.id !== id) return false;
  await env.BRIEFING.put(ASSISTANT_PENDING_KEY, 'null');
  return true;
}
