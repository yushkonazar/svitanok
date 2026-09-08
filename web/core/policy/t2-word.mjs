// Слово-підтвердження T2 адресує РІВНО одну пропозицію (виправлення
// security-ревʼю етапу 7).
//
// ⚠️ ЩО БУЛО НЕ ТАК. Слово шукало пропозицію запитом «остання відкрита T2 з
// таким словом у цьому треді». Слів усього чотири, а модель бачила своє слово
// у відповіді інструмента - отже могла створити кілька T2 поспіль, доки одній
// не випаде те саме слово, і показати власнику лише невинну з них. Власник
// писав слово під картинку, а виконувалась остання створена - наприклад
// `forget target=all`. Ціна помилки тут не «зайва дія», а безповоротно стерта
// база.
//
// ⚠️ ЯК ТЕПЕР. Слово діє лише для тієї пропозиції, про яку ядро САМЕ щойно
// спитало: у момент «напиши слово» тред запамʼятовує id, і напис резолвить
// його - або нічого. Модель слова більше не бачить взагалі (internal API
// зрізає його з відповіді), тож підібрати колізію ні до чого: навіть вгадане
// слово адресує ту саму, показану власнику, пропозицію.
//
// Стан - ВЛАСНИЙ ключ KV, не блоб `state` (та сама доктрина, що в
// ASSISTANT_PENDING_KEY): у `state` кілька писарів, а програна гонка тут
// коштує власнику дії, яку він щойно підтвердив.

/** Ключ KV зі станом «тред чекає слово». */
export const T2_PENDING_KEY = 't2Pending';
/** Скільки живе очікування - стільки ж, скільки сама T2-пропозиція. */
export const T2_PENDING_TTL_MS = 10 * 60_000;

/**
 * @typedef {{ id: string, word: string, at: number }} PendingT2
 * @typedef {Record<string, PendingT2>} PendingMap
 */

/** @param {unknown} raw @returns {PendingMap} */
function parseMap(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  /** @type {PendingMap} */
  const out = {};
  for (const [thread, value] of Object.entries(raw)) {
    const v = /** @type {any} */ (value);
    if (v && typeof v.id === 'string' && typeof v.word === 'string' && Number.isFinite(v.at)) {
      out[thread] = { id: v.id, word: v.word, at: Number(v.at) };
    }
  }
  return out;
}

/**
 * ⚠️ Збій СХОВИЩА кидається далі, а битий JSON - ні. Різниця несуча: биття
 * означає «нічого не чекали» (і слово піде в модель як звичайний текст, що
 * нешкідливо), а недоступний KV означає «не знаю» - і тоді слово мовчки
 * поїхало б у модель замість того, щоб виконати дію (ревʼю етапу 7).
 * @param {Env} env @returns {Promise<PendingMap>}
 */
async function readMap(env) {
  const raw = await env.BRIEFING.get(T2_PENDING_KEY);
  try {
    return parseMap(JSON.parse(raw ?? 'null'));
  } catch {
    return {};
  }
}

/**
 * Запамʼятати, про яку пропозицію ядро щойно спитало слово.
 * @param {Env} env @param {string} threadKey
 * @param {{ id: string, word: string }} proposal @param {number} nowMs
 */
export async function rememberT2(env, threadKey, proposal, nowMs) {
  const map = await readMap(env);
  // Заразом прибираємо прострочені: мапа не має рости від тредів, у яких
  // власник передумав писати слово.
  for (const [thread, entry] of Object.entries(map)) {
    if (nowMs - entry.at >= T2_PENDING_TTL_MS) delete map[thread];
  }
  map[threadKey] = { id: proposal.id, word: proposal.word.toUpperCase(), at: nowMs };
  await env.BRIEFING.put(T2_PENDING_KEY, JSON.stringify(map));
}

/**
 * Взяти пропозицію, до якої належить слово. Повертає id або null (слово не
 * те, прострочено, або ядро нічого не питало). Запис споживається: друге
 * написання того самого слова вже нічого не виконає.
 * @param {Env} env @param {string} threadKey @param {string} word @param {number} nowMs
 * @returns {Promise<string | null>}
 */
export async function takeT2(env, threadKey, word, nowMs) {
  const map = await readMap(env);
  const entry = map[threadKey];
  if (!entry) return null;
  if (nowMs - entry.at >= T2_PENDING_TTL_MS) {
    delete map[threadKey];
    await env.BRIEFING.put(T2_PENDING_KEY, JSON.stringify(map));
    return null;
  }
  if (entry.word !== word.trim().toUpperCase()) return null;
  delete map[threadKey];
  await env.BRIEFING.put(T2_PENDING_KEY, JSON.stringify(map));
  return entry.id;
}
