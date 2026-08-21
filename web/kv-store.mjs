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
//   2. Де писарів у ключа все одно кілька (`stats` і `state`) — читання-запис
//      іде через updateStats/updateState з одним retry, а не наївним put.
//      ⚠️ Додаєш писаря в один із цих ключів — бери update*, не put: наївний
//      load -> mutate -> put повертає рівно той клас утрат, який ці функції
//      й закривають.
//   3. Биття JSON НІКОЛИ не валить запит: кожен читач має свій нейтральний
//      дефолт. Порожній стан гірший за помилку лише в теорії; на практиці
//      власник побачив би 500 замість дашборда.

import { normalizeSettings } from './settings-core.mjs';
import { ASSISTANT_HISTORY_TTL_S } from './assistant-memory-core.mjs';

/**
 * Спільний читач: JSON із ключа або дефолт. Биття/відсутність -> дефолт.
 *
 * `any` тут — не лінь, а точне твердження: жоден із цих ключів поки що не має
 * оголошеної схеми (див. KvBlob у worker-env.d.ts). Публічні читачі нижче
 * звужують результат до KvBlob кожен за себе.
 * @param {Env} env
 * @param {string} key
 * @param {unknown} fallback
 * @returns {Promise<any>}
 */
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
 *  Цей самий ключ читає оркестратор (src/core/settings-overrides.ts).
 *  @param {Env} env */
export async function loadSettings(env) {
  return normalizeSettings(await readJson(env, 'settings', null));
}

/** Прочитати стор статистики з KV (ключ `stats`); биття -> {}.
 *  @param {Env} env
 *  @returns {Promise<KvBlob>} */
export async function loadStats(env) {
  return readJson(env, 'stats', {});
}

/**
 * @param {Env} env
 * @returns {Promise<KvBlob>}
 */
export async function loadState(env) {
  return readJson(env, 'state', {});
}

/** Ring-buffer message_id надісланих ботом (§C5, /clear) — ОКРЕМИЙ KV-ключ
 *  від 'state', щоб трекінг на КОЖНУ відповідь бота не ділив гонку писарів
 *  з reminders/roadmapProgress/mockWeights/... (той самий блоб 'state').
 *  @param {Env} env
 *  @returns {Promise<KvBlob>} */
export async function loadSentMessages(env) {
  return readJson(env, 'sentMessages', {});
}

/** Писар того самого ring-buffer. Окремо від читача, бо писарів двоє (репліки
 *  бота й вхідні повідомлення власника) — і обидва мусять merge-before-flush
 *  через recordSentMessage, а не класти сирий обʼєкт.
 *  @param {Env} env
 *  @param {KvBlob} sentMessages */
export async function putSentMessages(env, sentMessages) {
  await env.BRIEFING.put('sentMessages', JSON.stringify(sentMessages));
}

/** Прочитати останній опублікований брифінг (ключ `latest`) — для own-data
 *  дайджесту асистента (CC4, dataScope "briefing"/"all"); биття -> {}.
 *  @param {Env} env
 *  @returns {Promise<KvBlob>} */
export async function loadLatest(env) {
  return readJson(env, 'latest', {});
}

/** Прочитати ІСТОРИЧНИЙ (не latest!) снапшот дня — callback завжди резолвиться
 *  проти того самого брифінгу, що бачив власник, навіть через кілька днів.
 *  @param {Env} env
 *  @param {string} dateKey київська дата "YYYY-MM-DD"
 *  @returns {Promise<KvBlob>} */
export async function loadBriefingForDate(env, dateKey) {
  return readJson(env, `briefing:${dateKey}`, {});
}

/** Історія діалогу асистента per-thread (ключ `assistantHistory`, CM) — ОКРЕМИЙ
 *  KV-ключ від 'state' (як sentMessages: запис на кожен обмін не ділить гонку
 *  писарів state-блоба). Биття -> {}.
 *  @param {Env} env
 *  @returns {Promise<KvBlob>} */
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
 * @param {Env} env
 * @param {KvBlob} history
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
 *
 * @param {Env} env
 * @param {(store: KvBlob) => KvBlob} patch
 * @returns {Promise<KvBlob>}
 */
export async function updateStats(env, patch) {
  return updateJson(env, 'stats', patch);
}

/**
 * Те саме для 'state' (C4). Ключ ділять НЕЗАЛЕЖНІ писарі: вебхук (lastUpdateId),
 * крон нагадувань, дашборд (jobPrefs/mockWeights), асистент (roadmapProgress),
 * пропозиції. Крон ізольований послідовним прогоном — а вебхук і `/api/*`
 * бʼються з ним паралельно й цією ізоляцією не покриті.
 *
 * ⚠️ ЩО ЦЕ НЕ ЛАГОДИТЬ. Це не CAS: між другим читанням і `put` вікно лишається.
 * Воно на порядки вужче (мілісекунди замість «читання -> Telegram-виклик ->
 * запис»), але не нульове. Справжня межа тут — Durable Object на ключ; поки
 * писарів мало, дешевий варіант знімає рівно той клас утрат, який спостерігали.
 *
 * ⚠️ КОНТРАКТ PATCH. Чиста функція без побічних ефектів: при розбіжності вона
 * викликається вдруге, на свіжішій копії. Дельта («додай +1») від цього
 * коректна — вона застосується РІВНО раз, до тієї копії, яку зрештою пишемо.
 * А от `toggle` небезпечний: якщо чужий запис уже виставив той самий прапорець,
 * повторний toggle зніме його. Такі патчі мусять самі перевіряти стан
 * (`if (already) return store`), як це роблять виклики roadmapProgress.
 *
 * @param {Env} env
 * @param {(store: KvBlob) => KvBlob} patch
 * @returns {Promise<KvBlob>}
 */
export async function updateState(env, patch) {
  return updateJson(env, 'state', patch);
}

/**
 * Спільне ядро updateStats/updateState: прочитати, застосувати patch,
 * перечитати; якщо сирий рядок змінився — застосувати patch до свіжішої копії
 * замість того, щоб покласти зверху свою застарілу.
 *
 * Порівнюється саме СИРИЙ рядок, а не розібраний обʼєкт: будь-яка різниця
 * означає, що між читаннями хтось писав, і цього досить, щоб не ризикувати.
 *
 * @param {Env} env
 * @param {string} key
 * @param {(store: KvBlob) => KvBlob} patch
 * @returns {Promise<KvBlob>}
 */
async function updateJson(env, key, patch) {
  const raw1 = (await env.BRIEFING.get(key)) ?? '{}';
  const result1 = patch(parseBlob(raw1));
  const json1 = JSON.stringify(result1);
  const raw2 = (await env.BRIEFING.get(key)) ?? '{}';
  if (raw2 === raw1) {
    await env.BRIEFING.put(key, json1);
    return result1;
  }
  const result2 = patch(parseBlob(raw2));
  await env.BRIEFING.put(key, JSON.stringify(result2));
  return result2;
}

/**
 * Розібрати блоб; биття -> {}.
 *
 * Масив теж відкидається: `typeof [] === 'object'`, тож наївна перевірка його
 * пропускає, а кожен patch індексує аргумент як обʼєкт — `[].lastUpdateId = 2`
 * не кинуло б помилки, а тихо поклало б у KV масив із полем.
 *
 * @param {string} raw
 * @returns {any}
 */
function parseBlob(raw) {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** ВЛАСНИЙ KV-ключ пропозиції — НЕ в блобі 'state'.
 *
 *  Причина історична й лишається чинною. Блоб 'state' пишуть кілька незалежних
 *  писарів (lastUpdateId у вебхуку, крон checkReminders, дашборд applyEvent), і
 *  доки вони робили наївний read-modify-write, писар, що прочитав блоб за мить
 *  до запису пропозиції, затирав її назад — кожен ✅ падав у «Застаріла
 *  пропозиція» (баг, знайдений на проді 19.07).
 *
 *  ⚠️ Відтоді всі вони ходять через updateState (C4), тож САМЕ ЦЕЙ сценарій
 *  закрито. Ключ лишається окремим свідомо: updateState звужує вікно, але не
 *  прибирає його (це не CAS), а пропозиція — стан, де програна гонка коштує
 *  власнику дії, яку він щойно підтвердив. Той самий мотив, що
 *  [sentMessages]/[agentRuns]/[assistantHistory]. */
export const ASSISTANT_PENDING_KEY = 'assistantPending';

/**
 * Прочитати активну пропозицію -> pending|null.
 * Брифінг (src/orchestrator, mail.ts) тепер теж пише СЮДИ напряму (writeKvJson
 * на assistantPending, не в блоб `state`) — legacy-фолбек на `state.assistantPending`
 * прибрано разом із самим записом на тому боці.
 * @param {Env} env
 * @returns {Promise<KvBlob|null>}
 */
export async function loadAssistantPending(env) {
  return readJson(env, ASSISTANT_PENDING_KEY, null);
}

/**
 * Списати пропозицію: лише якщо це ДОСІ той самий id.
 *
 * ⚠️ НЕ АТОМАРНО, і доти цей коментар обіцяв протилежне («double-tap-safe»).
 * Це read-check-write, а KV не має CAS: два конкурентні виклики можуть обидва
 * прочитати той самий pending, обидва пройти перевірку id і обидва повернути
 * true. Коментар, що перебільшує, гірший за його відсутність — тим паче тут,
 * де за ним стоять НЕЗВОРОТНІ зовнішні записи (подія в календарі, контакт).
 *
 * Ідемпотентність тепер тримається не на цій функції, а на рівні ЕФЕКТУ —
 * markProposalExecuted нижче + зняття клавіатури одразу після claim
 * (web/proposals.mjs). Справжня серіалізація — Durable Object, він у проєкті
 * уже є (AGENT_RUN), і це стратегічний фікс, а не сьогоднішній.
 *
 * Put-null тумбстоун, а не delete: KV не має read-your-writes, тож видалений
 * ключ ще якийсь час читається як наявний, а покладений `null` — як `null`
 * одразу (той самий мотив, що markRunFinished). Повертає true, якщо саме цей
 * виклик списав.
 *
 * (Раніше тут стояла й друга причина — «delete немає в частині тест-моків».
 * Вона відпала: спільний стаб tests/helpers/kv.ts його має.)
 * @param {Env} env
 * @param {string} id
 */
export async function claimAssistantPending(env, id) {
  const pending = await loadAssistantPending(env);
  if (!pending || pending.id !== id) return false;
  await env.BRIEFING.put(ASSISTANT_PENDING_KEY, 'null');
  return true;
}

/** Скільки живе маркер виконаної пропозиції. Доба з запасом перекриває і
 *  подвійний тап, і будь-який ретрай доставки; довше тримати нема сенсу —
 *  пропозиція з таким id вже не повернеться. */
const EXECUTED_TTL_S = 86_400;
const executedKey = (/** @type {string} */ id) => `assistantExecuted:${id}`;

/**
 * Позначити пропозицію ВИКОНАНОЮ. true — цей виклик перший, можна робити
 * зовнішні записи; false — хтось уже зробив, треба тихо вийти.
 *
 * ⚠️ ЧОМУ ЦЕ, А НЕ «АТОМАРНИЙ CLAIM». Атомарного claim у Workers KV не буває —
 * CAS немає. Тому ідемпотентність переїхала туди, де вона справді потрібна: не
 * «хто списав пропозицію», а «чи вже створено подію». Вікно гонки при цьому
 * скорочується з тривалості ВСЬОГО обробника (claim -> кілька раундтріпів до
 * Google -> перепис повідомлення) до одного GET->PUT, тобто на два порядки.
 *
 * Це НЕ робить операцію атомарною, і робити вигляд, що робить, — та сама
 * помилка, за яку виправлено коментар вище. Разом зі зняттям клавіатури одразу
 * після claim цього досить, щоб подвійний тап людини не створював другої події;
 * гарантію дає лише Durable Object.
 * @param {Env} env
 * @param {string|null|undefined} id
 */
export async function markProposalExecuted(env, id) {
  if (!id) return false;
  const already = await env.BRIEFING.get(executedKey(id));
  if (already) return false;
  await env.BRIEFING.put(executedKey(id), '1', { expirationTtl: EXECUTED_TTL_S });
  return true;
}
