// «Важелі» — шар звʼязків між доменами (Крок 8 роадмепу статистики).
//
// Блок відповідає не на «яке в мене число», а на «що на що тягне»: сон цього
// тижня -> подачі наступного, роадмеп -> оцінка дня. Рядок показується лише
// тоді, коли звʼязок витримує поправку; решта мовчить.
//
// ⚠️ ГОЛОВНИЙ РИЗИК ЦЬОГО БЛОКУ — він уміє впевнено брехати, і помітити це з
// екрана неможливо: числа виглядають переконливо й РОСТУТЬ із накопиченням
// даних. Наївний перебір пар із ранговою кореляцією на тижневих рядах дає 33
// хибні «відкриття» зі 156 навіть із поправкою Беньяміні-Хохберга, бо тижні
// автокорельовані, а p рахується так, ніби вони незалежні. Тому математика тут
// обрана заміром, а не смаком — деталі в .workspace/StatsRevision/
// levers-method-measurement-2026-08-21.md, коротко:
//
//   · самі перші різниці ПЕРЕЛІКОВУЮТЬ автокореляцію на майже білому ряді
//     (diff білого шуму дає ACF(1) = -0.5) — хибний рядок у 20-29% тижнів,
//     причому НА БУДЬ-ЯКОМУ N: чекання не лікує;
//   · сама поправка ефективного N чиста, але сліпа до слабких звʼязків від
//     автокорельованого драйвера;
//   · ПЕРЕТИН обох (рядок мусить витримати BH і там, і там) — 3-8% прогонів
//     із хибним рядком, тобто в межах обіцяного q=0.10.
//
// research/levers_model.py — та сама математика в читабельному вигляді й
// джерело золотих векторів (tests/fixtures/levers-golden.json). Розбіжність
// між файлами = регресія порту, а не «інша, але прийнятна» відповідь.
//
// Рахується КРОНОМ раз на тиждень у власний KV-ключ, не на /api/stats: там
// бюджет 10 мс і він уже витрачений (aggregateStats = 3.74 мс).
import { spearman, cohensD, sleepHoursOf } from './checkin-model.mjs';
import { asList, isDateKey, dayKey, weekStartKey, FLAME_VALUES } from './stats-core.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// РЕЄСТР ТИЖНЕВИХ ОЗНАК
//
// Порядок — контракт із research/levers_model.py (золоті вектори позиційні):
// НЕ переставляти, лише дописувати в кінець.
// ─────────────────────────────────────────────────────────────────────────────

/** @type {Record<string, string>} */
export const LEVER_DOMAINS = {
  recovery: 'Відновлення',
  affect: 'Самопочуття',
  habits: 'Звички',
  learning: 'Навчання',
  search: 'Пошук роботи',
  attention: 'Увага',
};

/**
 * ⚠️ `more`/`less` — ГОТОВІ ФРАЗИ, а не рід із прикметником у шаблоні.
 *
 * Перша версія збирала речення як «коли {label} вищий за звичайний», і на
 * екрані виходило «оцінка дня більше» та «коли роадмеп вищий» — прикметник не
 * узгоджувався з родом ознаки. Граматичний рушій заради одинадцяти рядків був
 * би дорожчим за самі рядки й однаково помилявся б на наступній ознаці, тож
 * форма лежить поруч із назвою: додав ознаку — написав дві фрази.
 *
 * @type {{key: string, domain: string, label: string, emoji: string, unit: string,
 *         more: string, less: string}[]}
 */
export const LEVER_FEATURES = [
  {
    key: 'sleep',
    domain: 'recovery',
    label: 'Сон',
    emoji: '🌙',
    unit: 'год',
    more: 'більше сну',
    less: 'менше сну',
  },
  {
    key: 'energy',
    domain: 'affect',
    label: 'Енергія',
    emoji: '⚡',
    unit: '',
    more: 'більше енергії',
    less: 'менше енергії',
  },
  {
    key: 'mood',
    domain: 'affect',
    label: 'Настрій',
    emoji: '🙂',
    unit: '',
    more: 'кращий настрій',
    less: 'гірший настрій',
  },
  {
    key: 'dayScore',
    domain: 'affect',
    label: 'Оцінка дня',
    emoji: '⭐',
    unit: '',
    more: 'вища оцінка дня',
    less: 'нижча оцінка дня',
  },
  {
    key: 'flames',
    domain: 'habits',
    label: 'Вогники',
    emoji: '🔥',
    unit: '',
    more: 'більше вогників',
    less: 'менше вогників',
  },
  {
    key: 'mock',
    domain: 'learning',
    label: 'Питання',
    emoji: '🧠',
    unit: '',
    more: 'більше питань',
    less: 'менше питань',
  },
  {
    key: 'roadmap',
    domain: 'learning',
    label: 'Роадмеп',
    emoji: '📚',
    unit: 'тем',
    more: 'більше тем роадмепу',
    less: 'менше тем роадмепу',
  },
  {
    key: 'applied',
    domain: 'search',
    label: 'Подачі',
    emoji: '📨',
    unit: '',
    more: 'більше подач',
    less: 'менше подач',
  },
  {
    key: 'funnelMoves',
    domain: 'search',
    label: 'Рух воронки',
    emoji: '📈',
    unit: '',
    more: 'більше руху у воронці',
    less: 'менше руху у воронці',
  },
  {
    key: 'news',
    domain: 'attention',
    label: 'Новини',
    emoji: '📰',
    unit: '',
    more: 'більше новин',
    less: 'менше новин',
  },
  {
    key: 'opens',
    domain: 'attention',
    label: 'Відкриття',
    emoji: '👀',
    unit: '',
    more: 'більше відкриттів',
    less: 'менше відкриттів',
  },
];

export const LEVER_FEATURE_KEYS = LEVER_FEATURES.map((f) => f.key);

// ─────────────────────────────────────────────────────────────────────────────
// КУРОВАНИЙ СПИСОК ГІПОТЕЗ
//
// ⚠️ НЕ декартів добуток. BH ділить бюджет помилки на кількість гіпотез, тож
// кожна пара, яку ти не збирався перевіряти, зʼїдає чутливість тих, які
// збирався. Заміряно: скорочення зі 156 пар до 24 ПОДВОЮЄ потужність при
// 26-52 тижнях (44% проти 19% на 26 тижнях) і не додає хибних рядків.
//
// Критерій включення один: чи можна з рядка щось ЗРОБИТИ. «Сон -> подачі» веде
// до рішення; «новини -> вогники» — ні, навіть якби витримало поправку.
//
// lag: 1 — «наступного тижня», 0 — «того ж тижня». Лаг лежить у гіпотезі, бо в
// списку співіснують обидва види.
// ─────────────────────────────────────────────────────────────────────────────

/** @type {{from: string, to: string, lag: number}[]} */
export const LEVER_HYPOTHESES = [
  { from: 'sleep', to: 'applied', lag: 1 },
  { from: 'sleep', to: 'mock', lag: 1 },
  { from: 'sleep', to: 'roadmap', lag: 1 },
  { from: 'sleep', to: 'energy', lag: 1 },
  { from: 'sleep', to: 'dayScore', lag: 0 },
  { from: 'flames', to: 'sleep', lag: 1 },
  { from: 'flames', to: 'energy', lag: 1 },
  { from: 'flames', to: 'roadmap', lag: 1 },
  { from: 'energy', to: 'applied', lag: 1 },
  { from: 'energy', to: 'roadmap', lag: 1 },
  { from: 'mood', to: 'applied', lag: 1 },
  { from: 'mood', to: 'funnelMoves', lag: 1 },
  { from: 'applied', to: 'energy', lag: 1 },
  { from: 'applied', to: 'mood', lag: 1 },
  { from: 'applied', to: 'sleep', lag: 1 },
  { from: 'roadmap', to: 'dayScore', lag: 0 },
  { from: 'roadmap', to: 'mood', lag: 1 },
  { from: 'mock', to: 'dayScore', lag: 0 },
  { from: 'funnelMoves', to: 'mood', lag: 1 },
  { from: 'funnelMoves', to: 'dayScore', lag: 0 },
  { from: 'news', to: 'applied', lag: 1 },
  { from: 'opens', to: 'roadmap', lag: 1 },
  { from: 'opens', to: 'applied', lag: 1 },
  { from: 'applied', to: 'funnelMoves', lag: 1 },
];

// ─────────────────────────────────────────────────────────────────────────────
// КОНСТАНТИ (дзеркало research/levers_model.py — звіряються золотими векторами)
// ─────────────────────────────────────────────────────────────────────────────

/** Частка хибних серед ПОКАЗАНИХ рядків, яку допускає поправка BH. */
export const LEVERS_Q = 0.1;
/** Менше точок після вирівнювання — пара не рахується взагалі. */
export const MIN_PAIR_N = 10;
/** Нижче — блок каже «потрібно ще N тижнів» замість «звʼязків не знайдено». */
export const GATE_WEEKS = 26;
/** Заміряна межа, з якої блок починає бути корисним (для тексту, не для гейта). */
export const USEFUL_WEEKS = 39;
/** Діб чек-іну, щоб тиждень вважався придатним.
 *  ⚠️ Це судження, не замір: тижневе середнє з однієї-двох діб каже більше про
 *  те, які доби випадково заповнились, ніж про тиждень. */
export const MIN_CHECKIN_DAYS = 3;
/** Ряд, де одне значення займає більш ніж стільки тижнів, — не ряд. */
export const MAX_MODE_SHARE = 0.5;
/** І де менше стількох різних значень — теж. */
export const MIN_DISTINCT = 4;
/**
 * Скільки тижнів бере тижневий розрахунок.
 *
 * 52 — не кругле число, а стеля даних: `checkins`/`days` живуть 365 діб
 * (CHECKIN_CAP / DAYS_CAP), тож глибше просто немає з чого рахувати. Наслідок —
 * вікно КОТИТЬСЯ: коли історія переросте рік, найдавніші тижні випадатимуть.
 * Для «що на що тягне ЗАРАЗ» це радше правильно, ніж ні: важіль трирічної
 * давнини вже не важіль.
 */
export const LEVERS_WEEKS_WINDOW = 52;

// ─────────────────────────────────────────────────────────────────────────────
// МАТЕМАТИКА
// ─────────────────────────────────────────────────────────────────────────────

/** Автокореляція лагу 1 — наскільки тиждень схожий на попередній.
 *  @param {number[]} xs */
export function acf1(xs) {
  const n = xs.length;
  if (n < 2) return 0;
  const m = xs.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const d = (xs[i] ?? 0) - m;
    den += d * d;
    if (i > 0) num += ((xs[i - 1] ?? 0) - m) * d;
  }
  return den > 1e-12 ? num / den : 0;
}

/**
 * Кенʼєлл-Квенуй: N_eff = N * (1 - r1x*r1y) / (1 + r1x*r1y).
 *
 * Скільки НЕЗАЛЕЖНОЇ інформації насправді в двох автокорельованих рядах. Без
 * цього p систематично занижене: 44 хибні пари зі 156 при φ=0.75 проти 8 при
 * φ=0. Затиснуто в [4, N] — відʼємний добуток автокореляцій дав би N_eff > N,
 * тобто більше інформації, ніж є спостережень.
 * @param {number[]} xs
 * @param {number[]} ys
 */
export function effN(xs, ys) {
  const a = acf1(xs);
  const b = acf1(ys);
  const f = (1 - a * b) / (1 + a * b + 1e-12);
  return Math.max(4, xs.length * Math.min(1, Math.max(0.05, f)));
}

/**
 * Беньяміні-Хохберг: які гіпотези лишаються при частці хибних <= q.
 *
 * ⚠️ Береться НАЙБІЛЬШИЙ ранг, що пройшов поріг, і лишається все до нього —
 * а не «кожна окремо». Провал у середині не відкидає дрібніші за нього p.
 * @param {number[]} pvals
 * @param {number} [q]
 * @returns {boolean[]}
 */
export function bhKeep(pvals, q = LEVERS_Q) {
  const m = pvals.length;
  if (!m) return [];
  const order = pvals.map((_, i) => i).sort((i, j) => (pvals[i] ?? 1) - (pvals[j] ?? 1));
  let thr = 0;
  order.forEach((idx, i) => {
    if ((pvals[idx] ?? 1) <= (q * (i + 1)) / m) thr = i + 1;
  });
  const keep = new Array(m).fill(false);
  order.forEach((idx, i) => {
    if (i < thr) keep[idx] = true;
  });
  return keep;
}

/**
 * Рівнева вибірка пари: тижні, де присутні обидва кінці.
 * @param {(number|null)[]} drv
 * @param {(number|null)[]} tgt
 * @param {number} lag
 */
export function levelSamples(drv, tgt, lag) {
  /** @type {number[]} */
  const xs = [];
  /** @type {number[]} */
  const ys = [];
  for (let i = 0; i < drv.length - lag; i++) {
    const a = drv[i];
    const b = tgt[i + lag];
    if (a != null && b != null) {
      xs.push(a);
      ys.push(b);
    }
  }
  return { xs, ys };
}

/**
 * Різницева вибірка: лише СУСІДНІ присутні тижні.
 *
 * ⚠️ Різниця через діру означала б «зміну за два тижні», а це вже інша
 * величина — тиждень без чек-іну не можна перестрибнути мовчки.
 * @param {(number|null)[]} drv
 * @param {(number|null)[]} tgt
 * @param {number} lag
 */
export function diffSamples(drv, tgt, lag) {
  /** @type {number[]} */
  const xs = [];
  /** @type {number[]} */
  const ys = [];
  for (let i = 1; i < drv.length - lag; i++) {
    const a0 = drv[i - 1];
    const a1 = drv[i];
    const b0 = tgt[i + lag - 1];
    const b1 = tgt[i + lag];
    if (a0 != null && a1 != null && b0 != null && b1 != null) {
      xs.push(a1 - a0);
      ys.push(b1 - b0);
    }
  }
  return { xs, ys };
}

/** Частка тижнів, зайнята НАЙЧАСТІШИМ значенням ряду.
 *  @param {number[]} xs */
export function modeShare(xs) {
  if (!xs.length) return 1;
  /** @type {Map<number, number>} */
  const counts = new Map();
  let top = 0;
  for (const v of xs) {
    const c = (counts.get(v) ?? 0) + 1;
    counts.set(v, c);
    if (c > top) top = c;
  }
  return top / xs.length;
}

/**
 * Чи має ряд достатньо варіативності, щоб рангова кореляція щось значила.
 *
 * ⚠️ Це не косметика. Заміряно: розріджений лічильник (0.7 події на тиждень,
 * 49% нульових тижнів) зрізає спостережуваний |rho| з 0.75 до 0.20 — такого
 * звʼязку не побачити НІ ЗА ЯКОГО N. Такий ряд треба виключати чесно й
 * називати причину, а не мовчки показувати «звʼязку не знайдено»: друге
 * читалось би як «перевірено й нема», хоча перевірки не було.
 * @param {(number|null)[]} xs
 * @returns {{ok: boolean, reason: string}}
 */
export function seriesUsable(xs) {
  const vals = xs.filter((v) => v != null);
  if (vals.length < MIN_PAIR_N) return { ok: false, reason: 'мало тижнів' };
  if (new Set(vals).size < MIN_DISTINCT) return { ok: false, reason: 'майже стале значення' };
  if (modeShare(vals) > MAX_MODE_SHARE)
    return { ok: false, reason: 'одне значення в більшості тижнів' };
  return { ok: true, reason: '' };
}

/** Медіана (парна довжина — середнє двох середніх, як np.median).
 *  @param {number[]} xs */
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (!n) return 0;
  const mid = n >> 1;
  return n % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

const mean = (/** @type {number[]} */ xs) => xs.reduce((s, v) => s + v, 0) / (xs.length || 1);
const round2 = (/** @type {number} */ v) => Math.round(v * 100) / 100;
const round3 = (/** @type {number} */ v) => Math.round(v * 1000) / 1000;
const round4 = (/** @type {number} */ v) => Math.round(v * 10000) / 10000;
const round6 = (/** @type {number} */ v) => Math.round(v * 1e6) / 1e6;

/**
 * Читабельний ефект: «12 проти 6». Медіанний спліт драйвера -> середні цілі.
 *
 * Саме це робить рядок ВАЖЕЛЕМ: rho=0.59 нічого не каже про те, за що тягнути,
 * а «11 подач проти 5» — каже.
 * @param {(number|null)[]} drv
 * @param {(number|null)[]} tgt
 * @param {number} lag
 */
export function contrast(drv, tgt, lag) {
  return contrastOf(levelSamples(drv, tgt, lag));
}

/**
 * Те саме на ВЖЕ вирівняній вибірці — щоб `analyzeLevers` не будував її
 * втретє: рівневі пари там пораховані ще до поправок.
 * @param {{xs: number[], ys: number[]}} samples
 */
export function contrastOf({ xs, ys }) {
  if (xs.length < MIN_PAIR_N) return null;
  const med = median(xs);
  /** @type {number[]} */
  const hi = [];
  /** @type {number[]} */
  const lo = [];
  xs.forEach((x, i) => (x > med ? hi : lo).push(ys[i] ?? 0));
  if (hi.length < 3 || lo.length < 3) return null;
  return {
    high: round2(mean(hi)),
    low: round2(mean(lo)),
    nHigh: hi.length,
    nLow: lo.length,
    d: round3(cohensD(hi, lo)),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// АНАЛІЗ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {Record<string, (number|null)[]>} series ключ ознаки -> ряд по тижнях
 * @param {number} weeksUsable скільки тижнів визнано придатними
 * @param {{from: string, to: string, lag: number}[]} [hypotheses]
 */
export function analyzeLevers(series, weeksUsable, hypotheses = LEVER_HYPOTHESES) {
  /** @type {{key: string, reason: string}[]} */
  const skipped = [];
  // ⚠️ Map, а не обʼєкт: `usable['constructor']` на звичайному обʼєкті
  // правдиве через ланцюг прототипів, тож гіпотеза з таким імʼям ознаки
  // пройшла б гейт придатності. Той самий клас, від якого в stats-core.mjs
  // живе `isSafeKey`.
  /** @type {Map<string, boolean>} */
  const usable = new Map();
  for (const key of LEVER_FEATURE_KEYS) {
    const v = seriesUsable(series[key] ?? []);
    usable.set(key, v.ok);
    if (!v.ok) skipped.push({ key, reason: v.reason });
  }

  /** @type {Record<string, unknown>[]} */
  const considered = [];
  /** @type {number[]} */
  const pEff = [];
  /** @type {number[]} */
  const pDiff = [];
  /** @type {{xs: number[], ys: number[]}[]} */
  const levels = [];
  for (const h of hypotheses) {
    if (!usable.get(h.from) || !usable.get(h.to)) continue;
    const drv = series[h.from] ?? [];
    const tgt = series[h.to] ?? [];
    const lvl = levelSamples(drv, tgt, h.lag);
    const dif = diffSamples(drv, tgt, h.lag);
    if (lvl.xs.length < MIN_PAIR_N || dif.xs.length < MIN_PAIR_N) continue;
    // ⚠️ ОДИН виклик на рівневу пару, не два. `nEff` підмінює лише ступені
    // свободи, тож `rho` в обох випадках той самий — другий виклик заново
    // сортував би ті самі ранги заради числа, яке вже пораховане.
    const withEff = spearman(lvl.xs, lvl.ys, effN(lvl.xs, lvl.ys));
    const diff = spearman(dif.xs, dif.ys);
    considered.push({
      from: h.from,
      to: h.to,
      lag: h.lag,
      rho: round4(withEff.rho),
      rhoDiff: round4(diff.rho),
      n: lvl.xs.length,
      nDiff: dif.xs.length,
    });
    pEff.push(withEff.p);
    pDiff.push(diff.p);
    levels.push(lvl);
  }

  const keepEff = bhKeep(pEff);
  const keepDiff = bhKeep(pDiff);

  /** @type {Record<string, unknown>[]} */
  const rows = [];
  considered.forEach((c, i) => {
    if (!keepEff[i] || !keepDiff[i]) return;
    // ⚠️ Знак мусить збігатися в обох поправках. Розбіжність означає, що
    // рівневий і різницевий погляди сперечаються про НАПРЯМОК звʼязку —
    // показувати тоді нічого, хай навіть обидва p дрібні.
    const rho = /** @type {number} */ (c.rho);
    const rhoDiff = /** @type {number} */ (c.rhoDiff);
    if (rho * rhoDiff <= 0) return;
    rows.push({
      ...c,
      // p рядка — ГІРШИЙ із двох, не кращий: рядок настільки надійний,
      // наскільки надійна слабша з двох поправок.
      p: round6(Math.max(pEff[i] ?? 1, pDiff[i] ?? 1)),
      effect: contrastOf(levels[i] ?? { xs: [], ys: [] }),
    });
  });
  rows.sort(
    (a, b) =>
      /** @type {number} */ (a.p) - /** @type {number} */ (b.p) ||
      Math.abs(/** @type {number} */ (b.rho)) - Math.abs(/** @type {number} */ (a.rho)),
  );

  const ready = weeksUsable >= GATE_WEEKS;
  return {
    ready,
    weeks: weeksUsable,
    weeksNeeded: Math.max(0, GATE_WEEKS - weeksUsable),
    tested: considered.length,
    // ⚠️ tested/shown їдуть НАЗОВНІ й показуються поруч із рядками. Без цього
    // три рядки читаються як істина, а не як три вижилі з двох десятків
    // перевірених гіпотез.
    shown: ready ? rows.length : 0,
    rows: ready ? rows : [],
    skipped,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ЗБІР ТИЖНЕВИХ РЯДІВ ЗІ СТОРУ
// ─────────────────────────────────────────────────────────────────────────────

/** Сума днів тижня для лічильника з `days`. */
const dayNum = (/** @type {KvBlob|undefined} */ d, /** @type {string} */ f) =>
  typeof d?.[f] === 'number' ? d[f] : 0;

/**
 * Тижневі ряди з гарячого стору.
 *
 * ⚠️ ПОТОЧНИЙ ТИЖДЕНЬ НЕ ВХОДИТЬ. Він неповний, тож усі суми (подачі, питання,
 * новини) у ньому систематично занижені — а систематичний зсув в останній
 * точці ряду це рівно те, що рангова кореляція прийме за сигнал.
 *
 * ⚠️ Архів тут не потрібен: `checkins` і `days` живуть 365 діб (CHECKIN_CAP /
 * DAYS_CAP), тобто добова гранулярність тримається рік і тижневі згортки
 * рахуються з неї на льоту. Холодний архів (місячні середні) стає потрібним
 * аж тоді, коли історія переросте рік.
 *
 * @param {KvBlob} store блоб `stats`
 * @param {KvBlob} state блоб `state` (звідси лише roadmapProgress)
 * @param {string} todayKey
 * @param {number} weeks скільки тижневих кошиків будувати (не рахуючи поточного)
 */
export function buildWeeklySeries(store, state, todayKey, weeks) {
  const s = store && typeof store === 'object' ? store : {};
  const checkins = s.checkins && typeof s.checkins === 'object' ? s.checkins : {};
  const days = s.days && typeof s.days === 'object' ? s.days : {};

  // Останній ПОВНИЙ тиждень — той, що передує поточному.
  const thisWeek = weekStartKey(todayKey);
  const lastFull = dayKey(new Date(Date.parse(thisWeek + 'T00:00:00Z') - 7 * 86400000));
  /** @type {string[]} */
  const weekStarts = [];
  for (let i = weeks - 1; i >= 0; i--) {
    weekStarts.push(dayKey(new Date(Date.parse(lastFull + 'T00:00:00Z') - i * 7 * 86400000)));
  }
  const index = new Map(weekStarts.map((w, i) => [w, i]));
  /**
   * Дата -> номер кошика, або -1 поза вікном.
   *
   * ⚠️ ОДНА функція замість пари inRange/slotOf: обидві рахували
   * `weekStartKey`, а той конструює Date і форматує рядок — тобто кожен запис
   * стору платив за це двічі. На 365 добах це коштувало більше, ніж уся
   * математика блоку разом.
   */
  const slotOf = (/** @type {string} */ k) =>
    isDateKey(k) ? (index.get(weekStartKey(k)) ?? -1) : -1;

  /** @type {Record<string, number[][]>} накопичувачі значень по тижнях */
  const acc = {};
  for (const key of LEVER_FEATURE_KEYS) acc[key] = weekStarts.map(() => []);
  const checkinDays = weekStarts.map(() => 0);

  /**
   * Найраніший тиждень вікна, у якому стор має ХОЧ ЩОСЬ.
   *
   * ⚠️ БЕЗ ЦЬОГО ЛІЧИЛЬНИКИ БРЕХАЛИ Б. Вікно — 52 тижні, а історія коротша:
   * `days` пишеться з 07.07.2026, чек-ін із 17.07. Тижні до появи даних
   * діставали нуль («подій не було») замість діри («даних не було») — і
   * СПІЛЬНИЙ блок фальшивих нулів робив будь-які два лічильники схожими.
   *
   * Заміряно на двох НЕЗАЛЕЖНИХ випадкових лічильниках (400 прогонів): без
   * префікса середній |rho| = 0.158 і обидві поправки проходять у 6% випадків;
   * із 26-тижневим нуль-префіксом — |rho| = 0.675 і 32%. Гейт `modeShare > 0.5`
   * тут не рятує: за рівно половини нулів частка дорівнює 0.500, тобто не
   * більша. Саме така пропорція буде в січні 2027, коли блок уперше вмикається.
   */
  let firstData = weekStarts.length;
  const seen = (/** @type {number} */ i) => {
    if (i >= 0 && i < firstData) firstData = i;
  };

  for (const [d, rec] of Object.entries(checkins)) {
    if (d > todayKey || !rec || typeof rec !== 'object') continue;
    const i = slotOf(d);
    if (i < 0) continue;
    const slots = ['morning', 'afternoon', 'evening'].filter(
      (sl) => rec[sl] && typeof rec[sl] === 'object',
    );
    if (!slots.length) continue;
    seen(i);
    // ⚠️ Доба рахується за ЗАПИСАНИМ ЗНАЧЕННЯМ, а не за наявністю обʼєкта
    // слоту. Порожній `{}` — теж обʼєкт, і без цієї перевірки тиждень із
    // трьох порожніх слотів ставав «придатним», тобто йшов у знаменник
    // гейта 26 тижнів, не давши жодного числа.
    let recorded = false;
    const sleepH = sleepHoursOf(rec.morning);
    if (typeof sleepH === 'number') {
      acc.sleep?.[i]?.push(sleepH);
      recorded = true;
    }
    if (typeof rec.evening?.dayScore === 'number') {
      acc.dayScore?.[i]?.push(rec.evening.dayScore);
      recorded = true;
    }
    for (const sl of slots) {
      if (typeof rec[sl].energy === 'number') {
        acc.energy?.[i]?.push(rec[sl].energy);
        recorded = true;
      }
      if (typeof rec[sl].mood === 'number') {
        acc.mood?.[i]?.push(rec[sl].mood);
        recorded = true;
      }
    }
    // ⚠️ Вогники пишемо, ЛИШЕ якщо поле справді є. Інакше вечір, у якому про
    // них не питали, ставав нулем — і «не запалив жодного» зливалося з
    // «питання не було», зміщуючи весь ряд донизу.
    if (rec.evening && typeof rec.evening === 'object' && rec.evening.flames !== undefined) {
      const flames = asList(rec.evening.flames).filter((f) => FLAME_VALUES.includes(f));
      acc.flames?.[i]?.push(flames.length);
      recorded = true;
    }
    if (recorded) checkinDays[i] = (checkinDays[i] ?? 0) + 1;
  }

  for (const [d, rec] of Object.entries(days)) {
    if (d > todayKey || !rec || typeof rec !== 'object') continue;
    const i = slotOf(d);
    if (i < 0) continue;
    seen(i);
    acc.mock?.[i]?.push(dayNum(rec, 'mock'));
    acc.news?.[i]?.push(dayNum(rec, 'news'));
    acc.opens?.[i]?.push(dayNum(rec, 'opens'));
  }

  for (const a of Array.isArray(s.appliedLog) ? s.appliedLog : []) {
    if (a && typeof a.ts === 'string' && a.ts <= todayKey) {
      const i = slotOf(a.ts);
      if (i < 0) continue;
      seen(i);
      acc.applied?.[i]?.push(1);
    }
  }

  const funnelMeta = s.funnelMeta && typeof s.funnelMeta === 'object' ? s.funnelMeta : {};
  for (const meta of Object.values(funnelMeta)) {
    for (const h of Array.isArray(meta?.history) ? meta.history : []) {
      if (h && typeof h.ts === 'string' && h.ts <= todayKey) {
        const i = slotOf(h.ts);
        if (i < 0) continue;
        seen(i);
        acc.funnelMoves?.[i]?.push(1);
      }
    }
  }

  const progress =
    state?.roadmapProgress && typeof state.roadmapProgress === 'object'
      ? state.roadmapProgress
      : {};
  for (const iso of Object.values(progress)) {
    if (typeof iso !== 'string') continue;
    const d = iso.slice(0, 10);
    if (d > todayKey) continue;
    const i = slotOf(d);
    if (i < 0) continue;
    seen(i);
    acc.roadmap?.[i]?.push(1);
  }

  // Придатний тиждень — той, де чек-ін заповнено достатньо діб. Той САМИЙ
  // предикат живить і лічильник «потрібно ще N тижнів», і сам розрахунок:
  // інакше вони розійшлися б у визначенні, і блок обіцяв би одне, а рахував
  // на іншому.
  const usableWeek = checkinDays.map((c) => c >= MIN_CHECKIN_DAYS);

  /** @type {Record<string, (number|null)[]>} */
  const series = {};
  for (const f of LEVER_FEATURES) {
    const fromCheckin = f.domain === 'recovery' || f.domain === 'affect' || f.domain === 'habits';
    series[f.key] = weekStarts.map((_, i) => {
      const vals = acc[f.key]?.[i] ?? [];
      if (fromCheckin) {
        // Середнє по заповнених добах; непридатний тиждень — діра, не нуль.
        if (i < firstData || !usableWeek[i] || !vals.length) return null;
        return round2(mean(vals));
      }
      // Лічильники: у межах ери даних відсутність запису означає «нуль
      // подій», і нуль тут чесний. ДО початку історії — діра: там не було не
      // подій, а самого запису.
      if (i < firstData) return null;
      return vals.reduce((a, b) => a + b, 0);
    });
  }

  return {
    weekStarts,
    series,
    checkinDays,
    weeksUsable: usableWeek.filter(Boolean).length,
  };
}
