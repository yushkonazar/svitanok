// @ts-check
// Ваги вподобань — чисті функції (Фаза 5, модуляризація worker.js).
//
// ЩО ТУТ. Три незалежні шкали, які Worker мутує у відповідь на дії власника:
//   preferenceWeights — теми новин (👍/👎 у дашборді);
//   jobPrefs          — токени заголовків вакансій (воронка: dismiss/applied…);
//   mockWeights       — теми mock-питань (легко/важко).
//
// ⚠️ УСІ ТРИ — ДЗЕРКАЛА TypeScript-модулів оркестратора (`src/modules/news.ts`,
// `jobs.ts`, `mock.ts`): Worker не імпортує TS, а ваги мусять рахуватись
// ОДНАКОВО з обох боків — інакше та сама дія дає різний результат залежно від
// того, хто її обробив. Міняючи щось тут, міняй і там (і навпаки).
//
// Спільна властивість, заради якої це чисті функції: жодна нічого не пише — усі
// повертають НОВИЙ обʼєкт, а запис у KV робить викликач у своєму
// read-modify-write. Тому їх можна ганяти в тестах напряму, без KV і HTTP.

/* ── preferenceWeights (теми новин) ─────────────────────────────────────── */

export const WEIGHT_MIN = 0.5;
export const WEIGHT_MAX = 2.0;
export const WEIGHT_STEP = 0.15;

/**
 * Шкала ваг: тема/токен -> множник. Порожній обʼєкт означає «жодного голосу»,
 * а не «нулі»: відсутній ключ читається як 1.0.
 * @typedef {Record<string, number>} WeightMap
 */

const clampWeight = (/** @type {number} */ w) => Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, w));

/**
 * @param {WeightMap} weights
 * @param {string} category
 * @param {string} dir 'up' | 'down'
 * @returns {WeightMap}
 */
export function applyVote(weights, category, dir) {
  const cur = weights[category] ?? 1.0;
  return { ...weights, [category]: clampWeight(cur + (dir === 'up' ? WEIGHT_STEP : -WEIGHT_STEP)) };
}

/** Застосувати зсув до ваги теми з clamp; повернути {weights, delta(реальний)}.
 *  @param {WeightMap} weights
 *  @param {string} category
 *  @param {number} step */
function bumpWeight(weights, category, step) {
  const before = weights[category] ?? 1.0;
  const after = clampWeight(before + step);
  return { weights: { ...weights, [category]: after }, delta: after - before };
}

/**
 * votedUrls: чесний облік голосів per-url (C3, дзеркало applyUrlVote з news.ts —
 * канонічна версія тестована в news.test.ts). Кожен url впливає на вагу максимум
 * раз; повторний той самий голос знімає, зміна — переставляє. `delta` — реально
 * застосований зсув (після clamp), щоб відкат був точним і на межі [0.5,2.0].
 * @param {WeightMap|null|undefined} weights
 * @param {KvBlob|null|undefined} votedUrls
 * @param {string} url
 * @param {string} category
 * @param {string} clickedDir 'up' | 'down'
 */
export function applyUrlVote(weights, votedUrls, url, category, clickedDir) {
  /** @type {KvBlob} */
  const vu = votedUrls && typeof votedUrls === 'object' ? { ...votedUrls } : {};
  const prev = vu[url];
  /** @type {WeightMap} */
  let w = weights ?? {};
  if (prev && typeof prev.delta === 'number' && prev.delta !== 0) {
    const cat = prev.category ?? category;
    w = { ...w, [cat]: clampWeight((w[cat] ?? 1.0) - prev.delta) };
  }
  const newDir = prev && prev.dir === clickedDir ? null : clickedDir;
  if (newDir) {
    const r = bumpWeight(w, category, newDir === 'up' ? WEIGHT_STEP : -WEIGHT_STEP);
    w = r.weights;
    vu[url] = { dir: newDir, category, delta: r.delta };
  } else {
    delete vu[url];
  }
  return {
    weights: w,
    votedUrls: vu,
    prevDir: prev?.dir ?? null,
    prevCategory: prev?.category ?? null,
    newDir,
  };
}

/* ── jobPrefs (памʼять скорера вакансій) ────────────────────────────────── */

export const JOB_PREFS_CAP = 20;

const JOB_STOP_WORDS = new Set([
  'job',
  'jobs',
  'vacancy',
  'вакансія',
  'вакансии',
  'developer',
  'розробник',
  'engineer',
  'інженер',
  'junior',
  'trainee',
  'intern',
  'стажист',
  'джуніор',
  'full',
  'part',
  'time',
  'remote',
  'hybrid',
  'офіс',
  'дистанційно',
  'stack',
]);

function titleTokens(/** @type {string} */ title) {
  return (title.toLowerCase().match(/[a-zа-яїієґ0-9+#.]{3,}/gi) ?? []).filter(
    (t) => !JOB_STOP_WORDS.has(t),
  );
}

/**
 * @param {{ liked: string[], disliked: string[] }} prefs
 * @param {string} signal 'dismiss' -> у disliked, решта -> у liked
 * @param {string} title
 */
export function updateJobPrefs(prefs, signal, title) {
  const tokens = titleTokens(title);
  if (tokens.length === 0) return prefs;
  const toAdd = signal === 'dismiss' ? 'disliked' : 'liked';
  const toRemove = toAdd === 'liked' ? 'disliked' : 'liked';
  const merged = [...tokens, ...prefs[toAdd].filter((t) => !tokens.includes(t))].slice(
    0,
    JOB_PREFS_CAP,
  );
  const filtered = prefs[toRemove].filter((t) => !tokens.includes(t));
  return { ...prefs, [toAdd]: merged, [toRemove]: filtered };
}

/* ── mockWeights (теми mock-питань) ─────────────────────────────────────── */

export const MOCK_WEIGHT_MIN = 0.5;
export const MOCK_WEIGHT_MAX = 2.0;
export const MOCK_WEIGHT_STEP = 0.2;

const clampMockWeight = (/** @type {number} */ w) =>
  Math.min(MOCK_WEIGHT_MAX, Math.max(MOCK_WEIGHT_MIN, w));

/**
 * @param {WeightMap} weights
 * @param {string|null|undefined} topic
 * @param {string} rating 'hard' підіймає вагу, решта опускає
 * @returns {WeightMap}
 */
export function updateMockWeight(weights, topic, rating) {
  if (!topic) return weights;
  const cur = weights[topic] ?? 1.0;
  const next = clampMockWeight(cur + (rating === 'hard' ? MOCK_WEIGHT_STEP : -MOCK_WEIGHT_STEP));
  return { ...weights, [topic]: next };
}
