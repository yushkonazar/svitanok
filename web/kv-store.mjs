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
//      окремі короткоживучі ключі; active `agentRuns`, `assistantPending`,
//      `sentMessages` і `assistantHistory` уже переїхали у свої Durable
//      Object control planes.
//   2. `state`, `stats` і `settings` — виняток із legacy-сумісності. Їхній source of truth
//      тепер StateStoreDO (версійний CAS), а KV — лише snapshot для старого
//      ранкового briefing-а та backup. Без привʼязки DO (локальні тести або
//      старий rollback) лишається чітко позначений compatibility fallback.
//   3. Биття JSON НІКОЛИ не валить запит: кожен читач має свій нейтральний
//      дефолт. Порожній стан гірший за помилку лише в теорії; на практиці
//      власник побачив би 500 замість дашборда.

import { normalizeSettings } from './settings-core.mjs';
import { appendTurn } from './assistant-memory-core.mjs';
import {
  mergeSentMessages,
  recordSentMessage,
  sentMessagesKey,
  trackedMessages,
} from './tg-core.mjs';
import { ASSISTANT_HISTORY_TTL_S } from './assistant-memory-core.mjs';
import { STATE_STORE_DO_NAME } from './core/state-store/contract.mjs';
import {
  ASSISTANT_PENDING_KEY as PENDING_KEY,
  pendingClaim,
  pendingRead,
  pendingReplace,
  pendingUpdate,
} from './core/pending-proposals/client.mjs';
import {
  sentMessagesClear,
  sentMessagesForget,
  sentMessagesRead,
  sentMessagesRecord,
  sentMessagesReplace,
} from './core/sent-messages/client.mjs';
import { SENT_MESSAGES_KEY } from './core/sent-messages/contract.mjs';
import {
  historyAppend,
  historyClear,
  historyRead,
  historyReplace,
} from './core/assistant-history/client.mjs';
import { ASSISTANT_HISTORY_KEY } from './core/assistant-history/contract.mjs';

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
export async function readJson(env, key, fallback) {
  try {
    const parsed = JSON.parse((await env.BRIEFING.get(key)) ?? 'null');
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/** Налаштування власника (F2). Canonical structured blob живе у
 * StateStoreDO; KV `settings` — compatibility mirror для оркестратора та
 * rollback. Биття legacy-сnapshot -> дефолти.
 * @param {Env} env */
export async function loadSettings(env) {
  return normalizeSettings(await loadMutableJson(env, 'settings'));
}

/** Повна заміна settings (PUT-семантика). Серіалізований CAS прибирає вікно
 * між читанням і записом, але сам payload лишається свідомим «останній
 * підтверджений повний snapshot перемагає». @param {Env} env
 * @param {KvBlob|null|undefined} settings */
export async function putSettings(env, settings) {
  const next = normalizeSettings(settings);
  return normalizeSettings(await updateJson(env, 'settings', () => next));
}

/** Застосувати pure patch до найсвіжішого canonical settings і зберегти
 * точний preimage для undo. Патч може бути викликаний повторно після CAS
 * конфлікту, тому побічні ефекти тут заборонені.
 * @param {Env} env
 * @param {(settings: ReturnType<typeof normalizeSettings>) => KvBlob} patch
 * @returns {Promise<{ previous: ReturnType<typeof normalizeSettings>, settings: ReturnType<typeof normalizeSettings> }>}
 */
export async function updateSettings(env, patch) {
  /** @type {ReturnType<typeof normalizeSettings>} */
  let previous = normalizeSettings(null);
  const settings = normalizeSettings(
    await updateJson(env, 'settings', (current) => {
      previous = normalizeSettings(current);
      return normalizeSettings(patch(previous));
    }),
  );
  return { previous, settings };
}

/** T2 скидає canonical owner settings без віддзеркалення їх назад у вже
 * видалений KV. Відсутній binding — безпечний legacy path, де ключ очищено
 * FORGET_ALL_KV_KEYS. @param {Env} env */
export async function clearSettings(env) {
  const stub = stateStoreStub(env);
  if (!stub) return false;
  await stub.clear('settings');
  return true;
}

/** Прочитати стор статистики з KV (ключ `stats`); биття -> {}.
 *  @param {Env} env
 *  @returns {Promise<KvBlob>} */
export async function loadStats(env) {
  return loadMutableJson(env, 'stats');
}

/**
 * @param {Env} env
 * @returns {Promise<KvBlob>}
 */
export async function loadState(env) {
  return loadMutableJson(env, 'state');
}

/** @param {unknown} value @returns {KvBlob} */
function mutableBlob(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {KvBlob} */ (value)
    : {};
}

/** StateStoreDO не потрібен у локальних unit tests і на rollback-версії.
 * @param {Env} env @returns {any | null} */
function stateStoreStub(env) {
  const ns = env.STATE_STORE;
  return typeof ns?.getByName === 'function' ? ns.getByName(STATE_STORE_DO_NAME) : null;
}

/** Authoritative read з одноразовим seed із legacy KV. @param {Env} env
 * @param {'state'|'stats'|'settings'} key @returns {Promise<KvBlob>} */
async function loadMutableJson(env, key) {
  const legacy = mutableBlob(await readJson(env, key, {}));
  const stub = stateStoreStub(env);
  if (!stub) return legacy;
  const record = await stub.read(key, legacy);
  return mutableBlob(record?.value);
}

/**
 * Canonical snapshot для backup/export. `null` означає legacy rollout, де KV
 * ще є source of truth і `dumpKv` already містить усі structured keys.
 * @param {Env} env
 * @returns {Promise<{ state: KvBlob, stats: KvBlob, settings: KvBlob } | null>}
 */
export async function mutableStateSnapshot(env) {
  if (!stateStoreStub(env)) return null;
  const [state, stats, settings] = await Promise.all([
    loadMutableJson(env, 'state'),
    loadMutableJson(env, 'stats'),
    loadMutableJson(env, 'settings'),
  ]);
  return { state, stats, settings: normalizeSettings(settings) };
}

// ⚠️ ЛУНА ЧИТАЧА для legacy sentMessages fallback. KV не дає read-your-writes:
// `get` одразу після `put` може повернути СТАРЕ значення. Production binding
// іде через SentMessagesDO нижче; ця луна зберігає rollback/local поведінку,
// де ще лишився whole-blob KV path.
//
// Луна прив'язана до САМОГО обʼєкта прив'язки (WeakMap), а не до модуля:
// інакше вона пережила б і той env, якому належала. Між ізолятами вона не
// гарантує цілісність, саме тому canonical path не користується нею.
//
// ⚠️ ЩО САМЕ ЗАБУТО - КАЖЕ ВИКЛИКАЧ, а не здогад (ревʼю релізу). Перша
// редакція рахувала «зникло між знімками» - і записувала в забуті ще й те,
// що просто випало зі стелі ring-buffer'а на 51-му повідомленні. За добу
// активного чату множина забивалась цим сміттям, FIFO витісняв справжні
// /clear-ові id, і застаріле читання KV повертало їх назад - тобто рівно той
// дефект, проти якого луна й будувалась.
//
// ⚠️ І ПО ЧАТАХ ОКРЕМО: message_id унікальний лише в межах чату, тож пласка
// множина викидала з DM повідомлення з тим самим номером, що стерли в групі.
/** @type {WeakMap<object, { echo: KvBlob, forgotten: Map<string, Set<number>> }>} */
const sentEcho = new WeakMap();
/** Стеля забутих id НА ЧАТ. */
const SENT_FORGOTTEN_CAP = 200;
/** І стеля на кількість чатів, за якими взагалі щось памʼятаємо. */
const SENT_FORGOTTEN_KEYS = 20;

/** @param {Env} env */
function echoSlot(env) {
  const key = /** @type {object} */ (/** @type {unknown} */ (env.BRIEFING));
  let slot = sentEcho.get(key);
  if (!slot) {
    slot = { echo: {}, forgotten: new Map() };
    sentEcho.set(key, slot);
  }
  return slot;
}

/** Legacy compatibility writer ring-buffer-а. Production callers мають
 *  користуватися atomic recordTrackedMessage/forgetTrackedMessages нижче.
 *  @param {Env} env
 *  @returns {Promise<KvBlob>} */
export async function loadSentMessages(env) {
  const fromKv = await readJson(env, SENT_MESSAGES_KEY, {});
  const canonical = await sentMessagesRead(env, fromKv);
  if (canonical.canonical) return canonical.value;
  const slot = echoSlot(env);
  slot.echo = mergeSentMessages(fromKv, slot.echo, slot.forgotten);
  return slot.echo;
}

/** Писар того самого ring-buffer. Окремо від читача, бо писарів двоє (репліки
 *  бота й вхідні повідомлення власника) — і обидва мусять merge-before-flush
 *  через recordSentMessage, а не класти сирий обʼєкт.
 *  @param {Env} env
 *  @param {KvBlob} sentMessages
 *  @param {{ key: string, ids: number[] }} [forget] - що саме ЗНЯТО назавжди
 *    (лише /clear: він єдиний видаляє повідомлення, а не додає) */
export async function putSentMessages(env, sentMessages, forget = undefined) {
  // New production writers use recordTrackedMessage/forgetTrackedMessages.
  // This whole-blob path stays only for rollback and local unit tests.
  if (await sentMessagesReplace(env, sentMessages)) return;
  const slot = echoSlot(env);
  if (forget && forget.ids.length > 0) {
    const set = slot.forgotten.get(forget.key) ?? new Set();
    for (const id of forget.ids) set.add(id);
    // Стеля на чат: множина живе стільки, скільки прив'язка.
    while (set.size > SENT_FORGOTTEN_CAP) {
      set.delete(/** @type {number} */ (set.values().next().value));
    }
    slot.forgotten.set(forget.key, set);
    // ⚠️ Стеля і на КІЛЬКІСТЬ чатів (другий прохід ревʼю): id обмежені в
    // межах чату, а самих ключів ніщо не тримало. Практично їх одиниці, але
    // інваріант має бути, а не «практично».
    while (slot.forgotten.size > SENT_FORGOTTEN_KEYS) {
      slot.forgotten.delete(/** @type {string} */ (slot.forgotten.keys().next().value));
    }
  }
  slot.echo = sentMessages;
  await env.BRIEFING.put(SENT_MESSAGES_KEY, JSON.stringify(sentMessages));
}

/** Додати повідомлення atomically. Саме цією функцією мусять ходити Worker
 * writers: `load -> recordSentMessage -> put` не є безпечним між ізолятами.
 * @param {Env} env
 * @param {string|number|null|undefined} chatId
 * @param {string|number|null|undefined} threadId
 * @param {number} messageId @param {boolean} [own]
 * @returns {Promise<KvBlob>} */
export async function recordTrackedMessage(env, chatId, threadId, messageId, own = false) {
  const legacy = await readJson(env, SENT_MESSAGES_KEY, {});
  const canonical = await sentMessagesRecord(env, legacy, chatId, threadId, messageId, own);
  if (canonical.canonical) return canonical.value;

  // Rollback/local compatibility. Production binding never silently reaches
  // this branch; only old workers still rely on best-effort KV RMW.
  const next = recordSentMessage(await loadSentMessages(env), chatId, threadId, messageId, own);
  await putSentMessages(env, next);
  return next;
}

/** Прибрати саме ті id, які /clear вже успішно або остаточно відхилено
 * Telegram. Нові паралельні записи не губляться.
 * @param {Env} env
 * @param {string|number|null|undefined} chatId
 * @param {string|number|null|undefined} threadId @param {number[]} ids
 * @returns {Promise<KvBlob>} */
export async function forgetTrackedMessages(env, chatId, threadId, ids) {
  const legacy = await readJson(env, SENT_MESSAGES_KEY, {});
  const canonical = await sentMessagesForget(env, legacy, chatId, threadId, ids);
  if (canonical.canonical) return canonical.value;
  const key = sentMessagesKey(chatId, threadId);
  const forgotten = new Set(ids);
  const fresh = await loadSentMessages(env);
  const next = {
    ...fresh,
    [key]: trackedMessages(fresh[key]).filter((entry) => !forgotten.has(entry.id)),
  };
  await putSentMessages(env, next, { key, ids });
  return next;
}

/** Canonical snapshot for backup/export. @param {Env} env
 * @returns {Promise<KvBlob|null>} */
export async function sentMessagesSnapshot(env) {
  const legacy = await readJson(env, SENT_MESSAGES_KEY, {});
  const result = await sentMessagesRead(env, legacy);
  return result.canonical ? result.value : null;
}

/** T2 canonical cleanup. Legacy KV is deleted by FORGET_ALL_KV_KEYS.
 * @param {Env} env */
export async function clearSentMessages(env) {
  return sentMessagesClear(env);
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
 *  KV-ключ від 'state', тож запис на кожен обмін не ділить гонку писарів
 *  state-блоба. Биття -> {}.
 *  @param {Env} env
 *  @returns {Promise<KvBlob>} */
export async function loadAssistantHistory(env) {
  const legacy = await readJson(env, ASSISTANT_HISTORY_KEY, {});
  return (await historyRead(env, legacy)).history;
}

/** Atomically append an ordered batch to one assistant thread. Production
 * writers must use this instead of load → appendTurn → put whole history.
 * @param {Env} env
 * @param {string|number|null|undefined} chatId
 * @param {string|number|null|undefined} threadId
 * @param {{ role: string, text: string }[]} turns
 * @returns {Promise<KvBlob>} */
export async function appendAssistantHistory(env, chatId, threadId, turns) {
  const legacy = await readJson(env, ASSISTANT_HISTORY_KEY, {});
  const canonical = await historyAppend(env, legacy, chatId, threadId, turns);
  if (canonical.canonical) return canonical.history;
  let history = await loadAssistantHistory(env);
  for (const turn of turns) {
    history = appendTurn(history, chatId, threadId, turn.role, turn.text);
  }
  await putAssistantHistory(env, history);
  return history;
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
  if (await historyReplace(env, history)) return;
  await env.BRIEFING.put(ASSISTANT_HISTORY_KEY, JSON.stringify(history), {
    expirationTtl: ASSISTANT_HISTORY_TTL_S,
  });
}

/** Canonical snapshot for backup/export. @param {Env} env
 * @returns {Promise<KvBlob|null>} */
export async function assistantHistorySnapshot(env) {
  const legacy = await readJson(env, ASSISTANT_HISTORY_KEY, {});
  const result = await historyRead(env, legacy);
  return result.canonical ? result.history : null;
}

/** T2 canonical cleanup; KV mirror is deleted by FORGET_ALL_KV_KEYS.
 * @param {Env} env */
export async function clearAssistantHistory(env) {
  return historyClear(env);
}

/**
 * Ключ шару звʼязків «Важелі».
 *
 * ⚠️ ОКРЕМИЙ КЛЮЧ, не поле в `stats` і не в `state`. Обидва блоби читаються й
 * ПЕРЕЗАПИСУЮТЬСЯ на кожну подію (тап чек-іну, голос, зміна стадії), тож усе,
 * що в них лежить, коштує на кожному тапі. «Важелі» ж пишуться раз на тиждень
 * і читаються лише коли відкрито вкладку статистики. Той самий мотив, що в
 * `statsArchive`/`statsArchiveWeekly`.
 *
 * ⚠️ Назва оголошена ОДИН раз і тут. Розʼїзд літерала між писарем і читачем —
 * уже спійманий у цьому репозиторії клас помилки (ключ publicStatus).
 */
export const LEVERS_KEY = 'levers';

/** Прочитати шар звʼязків; биття або відсутність -> null (блок покаже, що ще
 *  не рахувалось, а не вдаватиме порожній результат).
 *  @param {Env} env
 *  @returns {Promise<KvBlob|null>} */
export async function loadLevers(env) {
  return readJson(env, LEVERS_KEY, null);
}

/**
 * Єдиний писар «Важелів» — тижневий крон.
 *
 * Без read-modify-write і без CAS свідомо: писар один, і зміст повністю
 * перераховується з нуля, тобто зливати нема з чим. Це не та ситуація, що з
 * `stats`, де писарів кілька й кожен міняє СВОЄ поле.
 * @param {Env} env
 * @param {KvBlob} payload
 */
export async function putLevers(env, payload) {
  await env.BRIEFING.put(LEVERS_KEY, JSON.stringify(payload));
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
 * ⚠️ ЩО ЦЕ НЕ ЛАГОДИТЬ — ДВІ РІЗНІ ДІРКИ, і плутати їх не варто.
 *
 * 1. Це не CAS. Між другим читанням і `put` вікно лишається — на порядки
 *    вужче (мілісекунди замість «читання -> Telegram-виклик -> запис»), але
 *    не нульове.
 * 2. Друге читання може ВЗАГАЛІ не побачити чужого запису. KV кешує читання в
 *    колонії (мінімальний cacheTtl — 60 с, знизити не можна), тож два `get`
 *    підряд майже напевно віддають той самий кешований рядок. `raw2 === raw1`
 *    означає «моя колонія не бачила змін», а не «ніхто не писав». Власний
 *    `put` кеш колонії інвалідує, тому послідовні писарі в ОДНІЙ колонії
 *    одне одного бачать; писар з іншої колонії (крон Cloudflare проти запиту
 *    власника) може лишитись невидимим до хвилини.
 *
 * Тобто виграш реальний, але це мітигація, а не гарантія. Справжня межа —
 * Durable Object на ключ `state` (інфраструктура вже є: AGENT_RUN); поки
 * писарів мало, дешевий варіант знімає рівно той клас утрат, який спостерігали.
 *
 * ⚠️ Тести цього шару мокають KV як `Map` — з миттєвою консистентністю, якої в
 * KV немає. Вони доводять ЛОГІКУ retry, не поведінку проти справжнього KV;
 * межу задокументовано тестом `updateJson — межа мітигації` в
 * tests/kv-store.test.ts.
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
 * Спільне ядро updateStats/updateState/updateSettings: прочитати, застосувати patch,
 * перечитати; якщо сирий рядок змінився — застосувати patch до свіжішої копії
 * замість того, щоб покласти зверху свою застарілу.
 *
 * Порівнюється саме СИРИЙ рядок, а не розібраний обʼєкт: будь-яка різниця
 * означає, що між читаннями хтось писав, і цього досить, щоб не ризикувати.
 *
 * @param {Env} env
 * @param {'state'|'stats'|'settings'} key
 * @param {(store: KvBlob) => KvBlob} patch
 * @returns {Promise<KvBlob>}
 */
async function updateJson(env, key, patch) {
  const stub = stateStoreStub(env);
  if (!stub) return updateJsonLegacy(env, key, patch);

  // Перший read сіє DO старим KV значенням; надалі саме record.version, а не
  // cache KV, визначає свіжість. patch лишається локальною pure-функцією, бо
  // Durable Object не приймає код через RPC.
  let record = await stub.read(key, mutableBlob(await readJson(env, key, {})));
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const next = patch(mutableBlob(record?.value));
    const result = await stub.compareAndSet(key, Number(record?.version), next);
    if (result?.ok) return mutableBlob(result.record?.value);
    record = result?.record;
  }
  // Вісім реальних CAS-конфліктів поспіль означають pathological writer, а не
  // «можна тихо втратити patch». Викликач отримає retry/error замість брехні.
  throw new Error(`state-store: ${key} надто конкурентний, повтори операцію`);
}

/**
 * Compatibility fallback для тестів/rollback без STATE_STORE. Він лишається
 * best-effort retry, але production конфіг завжди має Durable Object.
 * @param {Env} env
 * @param {'state'|'stats'|'settings'} key
 * @param {(store: KvBlob) => KvBlob} patch
 * @returns {Promise<KvBlob>}
 */
async function updateJsonLegacy(env, key, patch) {
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

/** Single-slot pending-пропозиція — НЕ в блобі 'state'.
 *
 *  Причина історична й лишається чинною. Блоб 'state' пишуть кілька незалежних
 *  писарів (lastUpdateId у вебхуку, крон checkReminders, дашборд applyEvent), і
 *  доки вони робили наївний read-modify-write, писар, що прочитав блоб за мить
 *  до запису пропозиції, затирав її назад — кожен ✅ падав у «Застаріла
 *  пропозиція» (баг, знайдений на проді 19.07).
 *
 *  `PendingProposalsDO` тепер дає цьому slot-у CAS і атомарний claim перед
 *  зовнішньою дією. KV нижче — одноразовий seed і compatibility mirror, не
 *  джерело рішення. */
export const ASSISTANT_PENDING_KEY = PENDING_KEY;

/**
 * Прочитати активну пропозицію -> pending|null.
 * Брифінг (src/orchestrator, mail.ts) тепер теж пише СЮДИ напряму (writeKvJson
 * на assistantPending, не в блоб `state`) — legacy-фолбек на `state.assistantPending`
 * прибрано разом із самим записом на тому боці.
 * @param {Env} env
 * @returns {Promise<KvBlob|null>}
 */
export async function loadAssistantPending(env) {
  const legacy = await readJson(env, ASSISTANT_PENDING_KEY, null);
  return (await pendingRead(env, legacy)).pending;
}

/** Поставити новий pending slot. Нова пропозиція свідомо замінює стару; її id
 * не дає кнопці старого повідомлення виконати нову дію.
 * @param {Env} env @param {KvBlob|null} pending */
export async function putAssistantPending(env, pending) {
  if (await pendingReplace(env, pending)) return;
  await env.BRIEFING.put(ASSISTANT_PENDING_KEY, JSON.stringify(pending));
}

/**
 * Змінити active pending лише якщо id досі той самий. У DO patch повторюється
 * через CAS на свіжій версії, тож два циклічні тапи не гублять один одного.
 * @param {Env} env
 * @param {string} id
 * @param {(pending: KvBlob) => KvBlob} patch
 * @returns {Promise<{ ok: boolean, pending: KvBlob|null }>}
 */
export async function updateAssistantPending(env, id, patch) {
  const canonical = await pendingUpdate(env, id, patch);
  if (canonical.canonical) return { ok: canonical.ok, pending: canonical.pending };

  // Rollback/local compatibility: точна поведінка старого KV-шляху. Тут CAS
  // неможливий, тому production binding не може непомітно сюди потрапити.
  const pending = await readJson(env, ASSISTANT_PENDING_KEY, null);
  if (!pending || pending.id !== id) return { ok: false, pending: null };
  const next = patch(pending);
  await env.BRIEFING.put(ASSISTANT_PENDING_KEY, JSON.stringify(next));
  return { ok: true, pending: next };
}

/**
 * Списати пропозицію: лише якщо це ДОСІ той самий id.
 *
 * PendingProposalsDO робить read-check-tombstone одним serializable рішенням:
 * з двох одночасних callback-ів рівно один поверне true. Без binding лишається
 * legacy fallback для rollback/local tests; production-конфіг тримає binding.
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
  // Спершу read: саме він одноразово сіє DO з legacy KV під час rollout.
  // Ухвала все одно нижче, у serializable `claim`, а не в цьому read-check.
  const pending = await loadAssistantPending(env);
  if (!pending || pending.id !== id) return false;
  const claimed = await pendingClaim(env, id);
  if (claimed !== null) return claimed;
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
 * Це другий, короткоживучий захист сумісності після atomic DO-claim. У
 * production паралельний callback вже не доходить сюди; KV-маркер лишається
 * для rollback і ретраю доставки без повторного зовнішнього ефекту.
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
