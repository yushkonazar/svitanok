// «Індекс дня» — статистична модель чек-іну (композитні індекси, ваги, що
// вчаться, драйвери, лаговий звʼязок, архетипи). Порт research/checkin_model.py
// (Python/numpy/scipy — читабельна специфікація й тест-оракул) у чистий JS без
// бібліотек: Worker (Cloudflare) виконує лише JS, Python туди не потрапляє.
//
// Контракт: tests/checkin-model.test.ts звіряє ЦЕЙ файл проти golden-векторів
// (tests/fixtures/checkin-golden.json, згенерованих Python-стороною) до 6-7
// знаку. Розбіжність = регресія порту, а не «трохи інша, але ок» відповідь.
//
// Дизайн-рішення, зроблені САМЕ заради крос-мовної відтворюваності (перша
// версія research/checkin_model.py використовувала numpy PRNG — perm-тест і
// k-means++ на ньому НЕ відтворювані біт-у-біт у JS):
//   - значущість драйверів — Welch's t-test (замкнута форма), не перестановки;
//   - ініціалізація k-means — детермінований maxmin (farthest-point), без seed.
// Обидва рахуються ОДНАКОВО в Python і JS без жодного PRNG.

// ─────────────────────────────────────────────────────────────────────────────
// 1. РЕЄСТР ПОЛІВ — дзеркало research/checkin_model.py FIELDS. Порядок — контракт
//    із golden-векторами (fieldOrder), не переставляти, лише дописувати в кінець.
// ─────────────────────────────────────────────────────────────────────────────

export const RECOVERY = 'recovery';
export const RESOURCE = 'resource';
export const WORK = 'work';
export const AGENCY = 'agency';
export const BODY = 'body';
export const INDICES = [RECOVERY, RESOURCE, WORK, AGENCY, BODY];
export const INDEX_LABEL = {
  [RECOVERY]: 'Відновлення',
  [RESOURCE]: 'Ресурс',
  [WORK]: 'Робота',
  [AGENCY]: 'Автономія',
  [BODY]: 'Тіло',
};

/**
 * @typedef {{
 *   name: string, slot: string, index: string, weight: number, polarity: 1|-1,
 *   levels?: string[], span?: [number, number], curve?: 'sleep_hours'
 * }} ModelField
 */

/** @type {ModelField[]} */
export const FIELDS = [
  // ── Відновлення ────────────────────────────────────────────────────────────
  // ⚠️ sleepKind — РЕЖИМ ночі, а не її тривалість, і він стоїть перед усім
  // іншим про сон. «Не спав» і «дрімав уривками» доти лягали в sleepH як
  // «мало спав», тобто три різні ночі ставали однією.
  //
  // Він НЕ замінює sleepH/sleepQ, а гейтить їх у чек-іні: на не-нічних
  // варіантах ті два питання не показуються, а значення ВИВОДЯТЬСЯ (нижче, у
  // flattenCheckinDay). Лишити їх порожніми було б найгіршим варіантом:
  // RECOVERY утратив би два з чотирьох ранкових полів саме в ту добу, яка
  // найінформативніша, і при MIN_FIELDS_PER_INDEX=2 найгірші ночі зникали б з
  // моделі взагалі.
  {
    name: 'sleepKind',
    slot: 'morning',
    index: RECOVERY,
    weight: 1.2,
    polarity: 1,
    levels: ['none', 'naps', 'slept'],
  },
  {
    name: 'sleepH',
    slot: 'morning',
    index: RECOVERY,
    weight: 1.5,
    polarity: 1,
    curve: 'sleep_hours',
  },
  { name: 'sleepQ', slot: 'morning', index: RECOVERY, weight: 1.2, polarity: 1 },
  {
    name: 'sleepLatency',
    slot: 'morning',
    index: RECOVERY,
    weight: 0.8,
    polarity: -1,
    levels: ['fast', 'mid', 'slow', 'vslow'],
  },
  // Нічні пробудження — ТРЕТІЙ незалежний вимір сну поряд із тривалістю та
  // якістю. Consensus Sleep Diary міряє їх окремо саме тому, що одне з одного
  // вони не виводяться: 8 годин із чотирма пробудженнями — це не 8 годин.
  {
    name: 'awakenings',
    slot: 'morning',
    index: RECOVERY,
    weight: 0.8,
    polarity: -1,
    levels: ['no', 'once', 'few', 'many'],
  },
  {
    name: 'bedtime',
    slot: 'morning',
    index: RECOVERY,
    weight: 0.8,
    polarity: -1,
    levels: ['e23', 'e00', 'e01', 'e02', 'late'],
  },
  {
    name: 'detached',
    slot: 'evening',
    index: RECOVERY,
    weight: 1.2,
    polarity: 1,
    levels: ['no', 'partly', 'yes'],
  },
  { name: 'rumination', slot: 'evening', index: RECOVERY, weight: 1.2, polarity: -1 },
  {
    name: 'screen',
    slot: 'evening',
    index: RECOVERY,
    weight: 0.6,
    polarity: -1,
    levels: ['low', 'mid', 'high', 'vhigh'],
  },
  { name: 'caffeine', slot: 'evening', index: RECOVERY, weight: 0.4, polarity: -1, span: [0, 4] },
  // ── Ресурс (афект: три зрізи доби) ──────────────────────────────────────────
  { name: 'energy@morning', slot: 'morning', index: RESOURCE, weight: 1.0, polarity: 1 },
  { name: 'energy@afternoon', slot: 'afternoon', index: RESOURCE, weight: 1.0, polarity: 1 },
  { name: 'energy@evening', slot: 'evening', index: RESOURCE, weight: 1.0, polarity: 1 },
  { name: 'mood@morning', slot: 'morning', index: RESOURCE, weight: 1.0, polarity: 1 },
  { name: 'mood@afternoon', slot: 'afternoon', index: RESOURCE, weight: 1.0, polarity: 1 },
  { name: 'mood@evening', slot: 'evening', index: RESOURCE, weight: 1.0, polarity: 1 },
  { name: 'worryAM', slot: 'morning', index: RESOURCE, weight: 0.8, polarity: -1 },
  // Очікуване навантаження дня. Полярність −1 за тим самим зразком, що worryAM:
  // обидва — РАНКОВІ передчуття, які тиснуть на ресурс ще до того, як день
  // стався. Напрямок при цьому НЕ вгадується наперед: драйвери покажуть, чи
  // справді щільний день виходить гіршим — у власника цілком може бути
  // навпаки, і порожній день гнітитиме сильніше за завантажений.
  { name: 'dayLoad', slot: 'morning', index: RESOURCE, weight: 0.8, polarity: -1 },
  { name: 'rushed', slot: 'afternoon', index: RESOURCE, weight: 0.8, polarity: -1 },
  // Переривання ЗЗОВНІ — окремо від власного відволікання. Доти обидві
  // причини зливались у блокер 'distract', хоч рішення в них різні.
  {
    name: 'interrupted',
    slot: 'afternoon',
    index: RESOURCE,
    weight: 0.8,
    polarity: -1,
    levels: ['none', 'few', 'many'],
  },
  // ── Робота ───────────────────────────────────────────────────────────────────
  { name: 'output', slot: 'evening', index: WORK, weight: 1.5, polarity: 1 },
  { name: 'focusQuality', slot: 'evening', index: WORK, weight: 1.2, polarity: 1 },
  { name: 'effort', slot: 'evening', index: WORK, weight: 0.6, polarity: 1 },
  {
    name: 'kept',
    slot: 'evening',
    index: WORK,
    weight: 1.2,
    polarity: 1,
    levels: ['no', 'partly', 'changed', 'yes'],
  },
  {
    name: 'pace',
    slot: 'afternoon',
    index: WORK,
    weight: 0.8,
    polarity: 1,
    levels: ['overload', 'behind', 'other', 'on', 'better'],
    // Легасі-значення з KV, якому НЕМАЄ чесного рівня: старе «Збився» пізніше
    // розділили на три РІЗНІ дні (behind/other/overload), і відновити заднім
    // числом, який саме це був, неможливо. Свідомо лишається null: поле випадає,
    // ваги WORK перенормовуються на присутні (WORK має 6 полів, тож індекс
    // виживає) — це чесніше за здогадку, що вигадала б інформацію.
    // Оголошено ЯВНО, щоб assert «enum ⊆ levels» відрізняв свідоме виключення
    // від забутого рівня (як було з moved:'active').
    legacyUnscored: ['off'],
  },
  { name: 'jobProgress', slot: 'evening', index: WORK, weight: 0.6, polarity: 1 },
  // Прогрес на ОБІД — друга не-вечірня опора WORK після pace. До неї індекс
  // тримався поза вечором на одному полі.
  {
    name: 'mainProgress',
    slot: 'afternoon',
    index: WORK,
    weight: 1.0,
    polarity: 1,
    levels: ['none', 'started', 'half', 'most'],
  },
  // ── Автономія / сенс ─────────────────────────────────────────────────────────
  { name: 'autonomy', slot: 'evening', index: AGENCY, weight: 1.5, polarity: 1 },
  { name: 'intentMatch', slot: 'derived', index: AGENCY, weight: 1.2, polarity: 1, span: [0, 1] },
  { name: 'jobConfidence', slot: 'evening', index: AGENCY, weight: 0.6, polarity: 1 },
  // Очікуваний контроль над днем (ранок) — пара до вечірньої autonomy.
  { name: 'dayControl', slot: 'morning', index: AGENCY, weight: 1.0, polarity: 1 },
  // ── Тіло / режим ─────────────────────────────────────────────────────────────
  {
    name: 'moved',
    slot: 'evening',
    index: BODY,
    weight: 1.5,
    polarity: 1,
    // 'active' («🔥 Активно») чек-ін збирає з самого початку, а модель його не
    // знала -> normalizeField давав null -> BODY (лише 2 поля при
    // MIN_FIELDS_PER_INDEX=2) ставав null -> УСЯ доба випадала з навчання ваг
    // і архетипів (B5). Ординально 'active' стоїть між 'light' і 'workout'.
    levels: ['none', 'light', 'active', 'workout'],
  },
  {
    name: 'outdoor',
    slot: 'evening',
    index: BODY,
    weight: 1.2,
    polarity: 1,
    levels: ['none', 'short', 'long'],
  },
  // ⚠️ ДВА НЕ-ВЕЧІРНІ ВХОДИ В BODY — і це головна причина, чому вони тут.
  // Доти індекс мав РІВНО два поля, обидва вечірні, при MIN_FIELDS_PER_INDEX=2:
  // запасу не було взагалі, і один пропущений тап робив BODY=null на всю добу,
  // а отже викидав її з архетипів. Заміряно: при явці вечора 20% архетипи
  // діставали 10 придатних діб із потрібних 20.
  //
  // Рівні дзеркалять вечірні аналоги слово в слово (none/light/workout проти
  // moved; none/short/long проти outdoor) — інакше пара «намір проти факту»
  // порівнювала б різні шкали.
  //
  // ⚠️ Рівні movePlan — ТІ САМІ ЧОТИРИ, що в moved, і це не косметика. Доти їх
  // було три (без 'active'), тобто нормалізація розʼїжджалась тихо: «легко» в
  // намірі давало 0.50, а «легко» у факті — 0.33. Пара «намір проти факту»
  // порівнювала два різні нулі-до-одиниці й систематично завищувала намір.
  {
    name: 'movePlan',
    slot: 'morning',
    index: BODY,
    weight: 1.0,
    polarity: 1,
    levels: ['none', 'light', 'active', 'workout'],
  },
  {
    name: 'outdoorNow',
    slot: 'afternoon',
    index: BODY,
    weight: 1.0,
    polarity: 1,
    levels: ['none', 'short', 'long'],
  },
  // Стан тіла зранку — ТРЕТІЙ не-вечірній вхід у BODY і єдиний, що міряє саме
  // тіло, а не його використання: рух і час надворі — це поведінка. Найдешевший
  // спосіб відрізнити «мало рухався, бо лінь» від «мало рухався, бо болить».
  { name: 'bodyFeel', slot: 'morning', index: BODY, weight: 1.0, polarity: 1 },
];

// Гейти — свідомо консервативні (той самий інваріант, що вже в stats-core:
// CORR_MIN_N, CATEGORY_SCORE_MIN). Цей блок легко зробити брехливим, і
// брехня тут виглядає як аналітика, тобто підштовхує до рішень.
export const MIN_FIELDS_PER_INDEX = 2;
export const MIN_DAYS_FOR_FIT = 20;
export const MIN_N_PER_BUCKET = 8;

/**
 * Скільки з пʼяти індексів мусить дати доба, щоб «Індекс дня» узагалі рахувався.
 *
 * ⚠️ Три — не круглий вибір, а межа, за якою число перестає бути порівнюваним
 * саме з собою: два виміри доступні вже з самого ранку (обидва мають ≥2
 * ранкові поля), тож поріг 2 означав би «оцінка доби, поки доба ще не почалась».
 */
export const MIN_INDICES_FOR_SCORE = 3;
// λ більше НЕ константа: обирається за LOO-CV із RIDGE_GRID (див. fitWeights).

// ─────────────────────────────────────────────────────────────────────────────
// 2. НОРМАЛІЗАЦІЯ 0..1
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Сон -> 0..1 нелінійно: 7–9 год = плато 1.0, штраф в обидва боки. Лінійна
 * шкала карала б 10 годин як «краще за 8» — плато описує реальну норму.
 */
function sleepHoursScore(h) {
  if (h >= 7 && h <= 9) return 1;
  if (h < 7) return Math.max(0, 1 - (7 - h) / 4);
  return Math.max(0, 1 - (h - 9) / 3);
}

/** Сире значення поля -> 0..1 з урахуванням полярності; null лишається null. */
export function normalizeField(f, raw) {
  if (raw === null || raw === undefined) return null;
  let v;
  if (f.curve === 'sleep_hours') {
    v = sleepHoursScore(Number(raw));
  } else if (f.levels) {
    const i = f.levels.indexOf(raw);
    if (i < 0) return null;
    v = i / (f.levels.length - 1);
  } else if (f.span) {
    const [lo, hi] = f.span;
    v = (Number(raw) - lo) / (hi - lo);
  } else {
    v = (Number(raw) - 1) / 4;
  }
  v = Math.min(1, Math.max(0, v));
  return f.polarity < 0 ? 1 - v : v;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. КОМПОЗИТНІ ІНДЕКСИ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Доба (плоский обʼєкт сирих полів, ключі = ModelField.name) -> {індекс: 0..1|null}.
 * Ваги ПЕРЕНОРМОВУЮТЬСЯ на присутні поля — чек-ін заповнюється нерівно (вечір
 * частіше порожній), без цього доба з одним полем була б систематично занижена.
 */
export function dayIndices(day) {
  const out = {};
  for (const idx of INDICES) {
    let num = 0;
    let den = 0;
    let seen = 0;
    for (const f of FIELDS) {
      if (f.index !== idx) continue;
      const v = normalizeField(f, day[f.name]);
      if (v === null) continue;
      num += v * f.weight;
      den += f.weight;
      seen++;
    }
    out[idx] = seen >= MIN_FIELDS_PER_INDEX && den > 0 ? num / den : null;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. ЛІНІЙНА АЛГЕБРА — Гаус із частковим піворотом (5×5, без бібліотек)
// ─────────────────────────────────────────────────────────────────────────────

/** Розвʼязує A·x = b для квадратної матриці A (масив рядків). Мутує копії. */
function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row) => row.slice());
  const y = b.slice();
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (piv !== col) {
      [M[col], M[piv]] = [M[piv], M[col]];
      [y[col], y[piv]] = [y[piv], y[col]];
    }
    const pivot = M[col][col];
    if (Math.abs(pivot) < 1e-12) continue;
    for (let r = col + 1; r < n; r++) {
      const factor = M[r][col] / pivot;
      if (factor === 0) continue;
      for (let c = col; c < n; c++) M[r][c] -= factor * M[col][c];
      y[r] -= factor * y[col];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = y[r];
    for (let c = r + 1; c < n; c++) s -= M[r][c] * x[c];
    x[r] = Math.abs(M[r][r]) > 1e-12 ? s / M[r][r] : 0;
  }
  return x;
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** A⁻¹ через n розвʼязків A·z = eᵢ. Для 5×5 це дешевше за окремий алгоритм. */
function invertMatrix(A) {
  const n = A.length;
  return Array.from({ length: n }, (_, i) => {
    const e = new Array(n).fill(0);
    e[i] = 1;
    return solveLinear(A, e);
  });
}

/**
 * Сітка λ для підбору за LOO-CV.
 *
 * ⚠️ Доти λ була ОДНА (1.0) і зашита. На 20-30 добах проти 5 предикторів це
 * означає, що регуляризація могла домінувати над сигналом: ваги виходили
 * рівнішими, ніж дані, і «модель вивела їх із твоїх діб» перетворювалось на
 * «модель майже нічого не вивела, але показала рівні смуги». Тепер λ
 * обирається за крос-валідацією — тобто за здатністю передбачати НЕ ті доби,
 * на яких училась.
 */
export const RIDGE_GRID = [0.05, 0.15, 0.5, 1.5, 5, 15];

/**
 * Ridge-регресія 5 індексів -> dayScore. Не ми вирішуємо, з чого складається
 * «хороший день» — модель вчиться на власних оцінках дня людини.
 * rows: [{indices, dayScore}]. Повертає {weights, beta, intercept, r2, n, learned}.
 */
export function fitWeights(rows) {
  const full = rows.filter(
    (r) =>
      INDICES.every((i) => r.indices[i] !== null) &&
      r.dayScore !== null &&
      r.dayScore !== undefined,
  );
  const prior = Object.fromEntries(INDICES.map((i) => [i, 1 / INDICES.length]));
  if (full.length < MIN_DAYS_FOR_FIT) {
    return { weights: prior, r2: null, n: full.length, learned: false };
  }

  const X = full.map((r) => INDICES.map((i) => r.indices[i]));
  const y = full.map((r) => (r.dayScore - 1) / 4);
  const n = INDICES.length;
  const nRows = X.length;
  const Xm = INDICES.map((_, j) => mean(X.map((row) => row[j])));
  const ym = mean(y);
  // ⚠️ СТАНДАРТИЗАЦІЯ, а не саме центрування. Ridge штрафує КОЕФІЦІЄНТИ, тож
  // без спільного масштабу предиктор із меншим розкидом отримує більший β і
  // сильніший штраф — регуляризація починає залежати від того, наскільки
  // рівний вимір, а не наскільки він важливий. Індекси всі 0..1, але їхні
  // стандартні відхилення різняться втричі.
  const sd = INDICES.map((_, j) => {
    const col = X.map((row) => row[j] - Xm[j]);
    const v = col.reduce((s, d) => s + d * d, 0) / Math.max(1, nRows - 1);
    return Math.sqrt(v) > 1e-9 ? Math.sqrt(v) : 1;
  });
  const Xz = X.map((row) => row.map((v, j) => (v - Xm[j]) / sd[j]));
  const yc = y.map((v) => v - ym);
  const ssTot = yc.reduce((s, v) => s + v * v, 0);

  const gram = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => {
      let s = 0;
      for (let k = 0; k < nRows; k++) s += Xz[k][i] * Xz[k][j];
      return s;
    }),
  );
  const rhs = Array.from({ length: n }, (_, i) => {
    let s = 0;
    for (let k = 0; k < nRows; k++) s += Xz[k][i] * yc[k];
    return s;
  });

  /**
   * Підгонка при заданій λ + LOO-CV у ЗАМКНУТІЙ формі.
   *
   * PRESS через діагональ капелюшної матриці: залишок відкинутої доби дорівнює
   * eᵢ/(1−hᵢᵢ), тож перенавчати модель `nRows` разів не треба. 1/nRows у hᵢᵢ — це
   * внесок вільного члена, який ми зняли центруванням; без нього LOO був би
   * оптимістичним рівно на нього.
   */
  const fitAt = (lambda) => {
    const A = gram.map((row, i) => row.map((v, j) => v + (i === j ? lambda : 0)));
    const beta = solveLinear(A, rhs);
    const Ainv = invertMatrix(A);
    let press = 0;
    let ssRes = 0;
    for (let k = 0; k < nRows; k++) {
      const xk = Xz[k];
      let h = 1 / nRows;
      for (let i = 0; i < n; i++) {
        let ai = 0;
        for (let j = 0; j < n; j++) ai += Ainv[i][j] * xk[j];
        h += xk[i] * ai;
      }
      const pred = xk.reduce((s, v, j) => s + v * beta[j], 0);
      const e = yc[k] - pred;
      ssRes += e * e;
      // ⚠️ Клемп ЗНИЗУ, не фолбек на e². Знайдено рев'ю: попередній варіант при
      // h -> 1 підставляв сам залишок, тобто в найгіршому для моделі випадку
      // (доба, яку підгонка «вивчила напамʼять») штраф ставав НАЙМЕНШИМ —
      // помилка в бік оптимізму рівно там, де CV мусить бути суворим. Тепер
      // знаменник не менший за 1e-6, тож така доба дає великий штраф.
      const denom = Math.max(1 - h, 1e-6);
      press += (e / denom) ** 2;
    }
    return { lambda, beta, ssRes, press };
  };

  // Обираємо λ за здатністю передбачати НЕ ті доби, на яких училась.
  let best = null;
  for (const lambda of RIDGE_GRID) {
    const cand = fitAt(lambda);
    if (!best || cand.press < best.press) best = cand;
  }
  const { lambda, beta, ssRes, press } = best;

  const r2 = ssTot > 1e-12 ? 1 - ssRes / ssTot : null;
  // ⚠️ CV-R² може бути ВІДʼЄМНИМ, і це не помилка: означає, що модель
  // передбачає гірше за просте середнє. Обрізати його до нуля означало б
  // сховати єдиний випадок, коли їй узагалі не варто вірити.
  const r2cv = ssTot > 1e-12 ? 1 - press / ssTot : null;

  // Коефіцієнти повертаємо у ВИХІДНОМУ масштабі індексів (β/sd), інакше
  // intercept і будь-яке порівняння з попередніми версіями поїхали б.
  const betaRaw = beta.map((b, j) => b / sd[j]);
  const mag = betaRaw.map(Math.abs);
  const magSum = mag.reduce((a, b) => a + b, 0);
  const share = magSum > 1e-12 ? mag.map((m) => m / magSum) : INDICES.map(() => 1 / n);

  return {
    weights: Object.fromEntries(INDICES.map((i, j) => [i, share[j]])),
    beta: Object.fromEntries(INDICES.map((i, j) => [i, betaRaw[j]])),
    // Знак окремо від величини: смуги пояснення показують ВАГУ виміру, а
    // рахунок мусить знати НАПРЯМОК. Доти знак губився в Math.abs, і вимір,
    // що тягне день униз, підіймав «Індекс дня».
    signs: Object.fromEntries(INDICES.map((i, j) => [i, betaRaw[j] < 0 ? -1 : 1])),
    intercept: ym - Xm.reduce((s, v, j) => s + v * betaRaw[j], 0),
    lambda,
    r2,
    r2cv,
    n: full.length,
    learned: true,
  };
}

/**
 * 5 індексів + ваги -> «Індекс дня» 0..100. Ваги перенормовуються на наявні.
 *
 * ⚠️ ЗНАК МАЄ ЗНАЧЕННЯ. Ваги — це |β|/Σ|β|, тобто чиста величина внеску. Якщо
 * у виміру відʼємний коефіцієнт (більше — гірший день), то в середнє входить
 * його ДОПОВНЕННЯ: інакше високе значення шкідливого виміру підіймало б
 * оцінку дня, і «Індекс» рухався б у протилежний бік від того, що людина сама
 * поставила. `signs` необовʼязковий — без нього поведінка та сама, що й доти
 * (апріорні ваги знака не мають).
 */
export function dayIndexScore(indices, weights, signs = null) {
  let num = 0;
  let den = 0;
  for (const i of INDICES) {
    if (indices[i] === null) continue;
    const v = signs && signs[i] < 0 ? 1 - indices[i] : indices[i];
    num += v * weights[i];
    den += weights[i];
  }
  return den > 0 ? Math.round(((100 * num) / den) * 10) / 10 : null;
}

/** Скільки з пʼяти індексів доба реально дає. */
export function indicesPresent(indices) {
  return INDICES.filter((i) => indices[i] !== null).length;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. СТАТИСТИКА — lgamma/incomplete-beta (Student-t), Cohen's d, Welch, Spearman
//
// Значущість — замкнута форма (Welch's t-test), НЕ перестановочний тест: PRNG
// не переноситься між Python і JS біт-у-біт, а замкнута форма дає ІДЕНТИЧНЕ
// число в обох мовах без жодного seed.
// ─────────────────────────────────────────────────────────────────────────────

// Lanczos-апроксимація lgamma (g=7, 9 коефіцієнтів) — стандартна, ~1e-13 точності.
const LANCZOS_G = 7;
const LANCZOS_C = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
];

function lgamma(x) {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  x -= 1;
  let a = LANCZOS_C[0];
  const t = x + LANCZOS_G + 0.5;
  for (let i = 1; i < LANCZOS_G + 2; i++) a += LANCZOS_C[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

// Continued fraction для неповної бета-функції (Numerical Recipes betacf).
function betacf(a, b, x) {
  const MAXIT = 200;
  const EPS = 3e-14;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Регуляризована неповна бета-функція I_x(a,b) — той самий будівельний блок
 *  для Welch p-value і Spearman p-value, обидва зводяться до Student-t. */
function betai(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(
    lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  return x < (a + 1) / (a + b + 2)
    ? (bt * betacf(a, b, x)) / a
    : 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** Двобічне p-значення Student-t: P(|T|>=|t|), df може бути дробовим (Welch). */
function studentTTwoSidedP(t, df) {
  if (!Number.isFinite(t) || df <= 0) return 1;
  return betai(df / 2, 0.5, df / (df + t * t));
}

export function cohensD(a, b) {
  const na = a.length;
  const nb = b.length;
  if (na < 2 || nb < 2) return 0;
  const ma = mean(a);
  const mb = mean(b);
  const va = a.reduce((s, v) => s + (v - ma) ** 2, 0) / (na - 1);
  const vb = b.reduce((s, v) => s + (v - mb) ** 2, 0) / (nb - 1);
  const pooled = Math.sqrt(((na - 1) * va + (nb - 1) * vb) / (na + nb - 2));
  return pooled > 1e-9 ? (ma - mb) / pooled : 0;
}

/** Welch's t-test p-значення — не передбачає рівних дисперсій (кошики різного розміру). */
export function welchP(a, b) {
  const na = a.length;
  const nb = b.length;
  const ma = mean(a);
  const mb = mean(b);
  const va = a.reduce((s, v) => s + (v - ma) ** 2, 0) / (na - 1);
  const vb = b.reduce((s, v) => s + (v - mb) ** 2, 0) / (nb - 1);
  const se2 = va / na + vb / nb;
  if (se2 <= 1e-12) return 1;
  const t = (ma - mb) / Math.sqrt(se2);
  const df = se2 ** 2 / ((va / na) ** 2 / (na - 1) + (vb / nb) ** 2 / (nb - 1));
  return studentTTwoSidedP(t, df);
}

/** Ранги з усередненням при звʼязках (потрібно для Spearman). */
function ranks(xs) {
  const idx = xs.map((_, i) => i).sort((i, j) => xs[i] - xs[j]);
  const r = new Array(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && xs[idx[j + 1]] === xs[idx[i]]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k]] = avg;
    i = j + 1;
  }
  return r;
}

/** Spearman rho + p (t-апроксимація — той самий формула, що scipy.stats.spearmanr). */
export function spearman(xs, ys) {
  const n = xs.length;
  const rx = ranks(xs);
  const ry = ranks(ys);
  const mx = mean(rx);
  const my = mean(ry);
  let num = 0;
  let dx2 = 0;
  let dy2 = 0;
  for (let i = 0; i < n; i++) {
    const ddx = rx[i] - mx;
    const ddy = ry[i] - my;
    num += ddx * ddy;
    dx2 += ddx * ddx;
    dy2 += ddy * ddy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  const rho = denom > 1e-12 ? num / denom : 0;
  if (n <= 2 || Math.abs(rho) >= 1) return { rho, p: Math.abs(rho) >= 1 ? 0 : 1 };
  const t = (rho * Math.sqrt(n - 2)) / Math.sqrt(1 - rho * rho);
  return { rho, p: studentTTwoSidedP(t, n - 2) };
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. ДРАЙВЕРИ
// ─────────────────────────────────────────────────────────────────────────────

const round2 = (v) => Math.round(v * 100) / 100;
const round3 = (v) => Math.round(v * 1000) / 1000;
const round4 = (v) => Math.round(v * 10000) / 10000;

/**
 * Кожне бінаризовне поле -> вплив на цільову оцінку (за замовч. dayScore),
 * відсортовано за |d|. Один генеричний прохід замість картки на поле: нове
 * поле в FIELDS саме зʼявляється в аналізі, коли набереться вибірка.
 */
export function computeDrivers(days, target = 'dayScore') {
  const out = [];
  for (const f of FIELDS) {
    const hi = [];
    const lo = [];
    for (const d of days) {
      const t = d[target];
      const v = normalizeField(f, d[f.name]);
      if (t === null || t === undefined || v === null) continue;
      if (v >= 0.75) hi.push(t);
      else if (v <= 0.25) lo.push(t);
    }
    if (hi.length < MIN_N_PER_BUCKET || lo.length < MIN_N_PER_BUCKET) continue;
    out.push({
      field: f.name,
      index: f.index,
      delta: round2(mean(hi) - mean(lo)),
      d: round2(cohensD(hi, lo)),
      p: round4(welchP(hi, lo)),
      nHigh: hi.length,
      nLow: lo.length,
    });
  }
  applyBH(out);
  return out.sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
}

/** Рівень значущості родини драйверів. */
const BH_ALPHA = 0.05;

/**
 * Поправка Бенʼяміні-Хохберга на МНОЖИННІ порівняння — на місці, в рядках.
 *
 * ⚠️ НАВІЩО. Драйверів десятки, і кожен перевіряється власним тестом при
 * p<0.05. На 25 полях приблизно один «значущий» результат очікується ЧИСТО
 * ВИПАДКОВО — тобто підпис «значущо» на найгучнішому рядку блоку був майже
 * гарантований навіть на шумі. BH контролює частку хибних відкриттів у всій
 * родині, а не ймовірність помилки в окремому тесті.
 *
 * Обрано BH, а не Бонферроні: останній при 25 порівняннях вимагав би p<0.002 і
 * не пропустив би нічого, крім найгрубіших ефектів. Для розвідки власних даних
 * це надто суворо — краще контрольована частка хибних, ніж мовчання.
 *
 * q рахується монотонно з кінця: без цього крок BH міг би оголосити значущим
 * рядок із БІЛЬШИМ p, ніж у визнаного незначущим сусіда.
 */
function applyBH(rows) {
  const m = rows.length;
  if (!m) return;
  const order = rows.map((_, i) => i).sort((a, b) => rows[a].p - rows[b].p);
  let running = 1;
  for (let k = m - 1; k >= 0; k--) {
    const row = rows[order[k]];
    running = Math.min(running, (m / (k + 1)) * row.p);
    row.q = round4(running);
    row.passesBH = running <= BH_ALPHA;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. ЛАГОВІ ЗВʼЯЗКИ — сьогодні -> ЗАВТРА
// ─────────────────────────────────────────────────────────────────────────────

export function computeLagged(days, srcIndex, target = 'dayScore') {
  const xs = [];
  const ys = [];
  for (let i = 0; i < days.length - 1; i++) {
    const v = dayIndices(days[i])[srcIndex];
    const t = days[i + 1][target];
    if (v !== null && t !== null && t !== undefined) {
      xs.push(v);
      ys.push(t);
    }
  }
  if (xs.length < MIN_N_PER_BUCKET * 2) {
    return { ready: false, n: xs.length, needed: MIN_N_PER_BUCKET * 2 };
  }
  const { rho, p } = spearman(xs, ys);
  return { ready: true, n: xs.length, rho: round3(rho), p: round4(p), src: srcIndex, target };
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. АРХЕТИПИ — k-means, ІНІЦІАЛІЗАЦІЯ ДЕТЕРМІНОВАНА (maxmin, без PRNG)
// ─────────────────────────────────────────────────────────────────────────────

function sqDist(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return s;
}

/** Перший центр — найближча до середнього доба; кожен наступний — та, що
 *  максимізує мінімальну відстань до вже обраних. Без seed: Python і JS
 *  дають ІДЕНТИЧНИЙ результат з точністю до плаваючої коми. */
function farthestPointInit(Xs, k) {
  const n = Xs.length;
  const dim = Xs[0].length;
  const centroidMean = Array.from({ length: dim }, (_, j) => mean(Xs.map((row) => row[j])));
  let first = 0;
  let bestD = Infinity;
  for (let i = 0; i < n; i++) {
    const d = sqDist(Xs[i], centroidMean);
    if (d < bestD) {
      bestD = d;
      first = i;
    }
  }
  const chosen = [first];
  const dist = Xs.map((row) => sqDist(row, Xs[first]));
  for (let step = 1; step < k; step++) {
    let nxt = 0;
    let best = -Infinity;
    for (let i = 0; i < n; i++)
      if (dist[i] > best) {
        best = dist[i];
        nxt = i;
      }
    chosen.push(nxt);
    for (let i = 0; i < n; i++) dist[i] = Math.min(dist[i], sqDist(Xs[i], Xs[nxt]));
  }
  return chosen.map((i) => Xs[i].slice());
}

/**
 * k-means на стандартизованих 5-вимірних індексах. Замість «середнього дня»
 * (якого не існує) — 3-4 ТИПИ днів із частотою й профілем.
 */
export function computeArchetypes(days, k = 4) {
  const V = [];
  for (const d of days) {
    const ix = dayIndices(d);
    if (INDICES.every((i) => ix[i] !== null)) V.push(INDICES.map((i) => ix[i]));
  }
  if (V.length < k * 5) return { ready: false, n: V.length, needed: k * 5 };

  const dim = INDICES.length;
  const colMean = Array.from({ length: dim }, (_, j) => mean(V.map((row) => row[j])));
  const colStd = Array.from({ length: dim }, (_, j) => {
    const m = colMean[j];
    const v = mean(V.map((row) => (row[j] - m) ** 2));
    return Math.sqrt(v) < 1e-9 ? 1 : Math.sqrt(v);
  });
  const Xs = V.map((row) => row.map((v, j) => (v - colMean[j]) / colStd[j]));

  let C = farthestPointInit(Xs, k);
  let labels = new Array(Xs.length).fill(0);
  for (let iter = 0; iter < 60; iter++) {
    let changed = false;
    labels = Xs.map((row) => {
      let best = 0;
      let bestD = Infinity;
      for (let j = 0; j < k; j++) {
        const d = sqDist(row, C[j]);
        if (d < bestD) {
          bestD = d;
          best = j;
        }
      }
      return best;
    });
    const newC = Array.from({ length: k }, (_, j) => {
      const members = Xs.filter((_, i) => labels[i] === j);
      return members.length
        ? Array.from({ length: dim }, (_, d) => mean(members.map((row) => row[d])))
        : C[j];
    });
    for (let j = 0; j < k; j++) {
      if (sqDist(newC[j], C[j]) > 1e-18) changed = true;
    }
    C = newC;
    if (!changed) break;
  }

  const groups = [];
  for (let j = 0; j < k; j++) {
    const memberIdx = labels.map((l, i) => (l === j ? i : -1)).filter((i) => i >= 0);
    if (!memberIdx.length) continue;
    const profile = Array.from({ length: dim }, (_, d) => mean(memberIdx.map((i) => V[i][d])));
    let topI = 0;
    let lowI = 0;
    for (let d = 1; d < dim; d++) {
      if (profile[d] > profile[topI]) topI = d;
      if (profile[d] < profile[lowI]) lowI = d;
    }
    groups.push({
      n: memberIdx.length,
      share: round3(memberIdx.length / V.length),
      profile: Object.fromEntries(INDICES.map((i, d) => [i, round3(profile[d])])),
      top: INDICES[topI],
      low: INDICES[lowI],
    });
  }
  groups.sort((a, b) => b.n - a.n);
  return { ready: true, k, n: V.length, groups };
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. ТОЧКА ВХОДУ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Повний прохід моделі на масиві плоских «днів» (формат ModelField.name-ключів,
 * як повертає flattenCheckinDay нижче). Не читає KV напряму — чиста функція
 * над уже підготованими рядками, той самий стиль, що решта stats-core.mjs.
 */
export function analyzeCheckinModel(days) {
  const idx = days.map((d) => dayIndices(d));
  const fit = fitWeights(idx.map((ix, i) => ({ indices: ix, dayScore: days[i].dayScore })));
  // ⚠️ ГЕЙТ ПОКРИТТЯ — найбільше джерело хибного прочитання в усьому блоці.
  // «Індекс дня» перенормовує ваги на НАЯВНІ індекси, тож о 09:00, коли
  // заповнено лише ранок, доступні щонайбільше два виміри — і «92» означало
  // «я виспався», а виглядало як підсумок доби. Далі число дрейфувало весь
  // день, а середнє усереднювало ці різні за змістом величини.
  //
  // Тому доба з покриттям нижче порогу не отримує оцінки взагалі. Це не
  // «немає даних» — це «ще рано», і екран мусить сказати саме так.
  const cover = idx.map(indicesPresent);
  const scores = idx.map((ix, i) =>
    cover[i] >= MIN_INDICES_FOR_SCORE ? dayIndexScore(ix, fit.weights, fit.signs) : null,
  );
  const validScores = scores.filter((s) => s !== null);
  return {
    n: days.length,
    fit,
    dayIndex: {
      last: scores.length ? scores[scores.length - 1] : null,
      mean: validScores.length ? Math.round(mean(validScores) * 10) / 10 : null,
      // Скільки вимірів дала ОСТАННЯ доба і скільки треба — щоб підказка могла
      // сказати «заповни вечір», а не мовчати прочерком.
      lastCoverage: cover.length ? cover[cover.length - 1] : 0,
      needCoverage: MIN_INDICES_FOR_SCORE,
      // Скільки діб вікна взагалі дотягнули до порогу — чесний знаменник
      // середнього, якого доти не було видно.
      scored: validScores.length,
    },
    drivers: computeDrivers(days),
    lagged: Object.fromEntries([RECOVERY, BODY].map((i) => [i, computeLagged(days, i)])),
    archetypes: computeArchetypes(days),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. АДАПТЕР — нested checkins[date] (morning/afternoon/evening) -> плоский день
// ─────────────────────────────────────────────────────────────────────────────

/**
 * checkins[dateKey] (реальна форма сховища) -> плоский день для моделі.
 * intentMatch — ЄДИНЕ похідне поле: ЧАСТКА планового, що справді зайняла час.
 *
 * ⚠️ Доти був критерій «влучив бодай у щось» (plan.some(p => ate.includes(p))),
 * і це систематично завищувало AGENCY. План [робота, спорт], факт [спорт,
 * відпочинок] -> повна одиниця, хоч робота не сталась. Тобто що більше
 * категорій обираєш уранці, то легше «виконати план»: при двох пунктах досить
 * влучити в один. Той самий критерій ішов і в картку «План проти реальності»,
 * тож обидва місця брехали однаково — і саме тому виправляються разом.
 *
 * Частка |plan ∩ ate| / |plan| відповідає на те саме питання чесно, і span
 * поля [0,1] під неї вже був: міняється не контракт, а чим його заповнюють.
 */
export function flattenCheckinDay(rec, asListFn, categoryValues) {
  const m = rec?.morning ?? {};
  const a = rec?.afternoon ?? {};
  const e = rec?.evening ?? {};
  const plan = asListFn(m.plan).filter((x) => categoryValues.includes(x));
  const ate = asListFn(a.ate).filter((x) => categoryValues.includes(x));
  const intentMatch =
    plan.length && ate.length ? plan.filter((p) => ate.includes(p)).length / plan.length : null;

  // ⚠️ ВИВЕДЕННЯ СНУ, а не пропуск. На «не спав» і «дрімав» чек-ін не питає
  // тривалість і якість — питати нема про що. Але ЛИШИТИ ЇХ null означало б
  // забрати в RECOVERY два з чотирьох ранкових полів саме в найінформативнішу
  // добу, а при MIN_FIELDS_PER_INDEX=2 це часто робить весь індекс null —
  // тобто найгірші ночі просто зникали б з моделі. Результат, протилежний
  // тому, заради чого питання й додане.
  //
  // Числа не з повітря: 'none' — нижня межа обох шкал (0 год, якість 1);
  // 'naps' — 2 год розірваного сну і якість 2, тобто гірше за будь-яку
  // реальну відповідь, окрім найгіршої. Відповідь власника при цьому НЕ
  // перезаписується: якщо поле все ж заповнене (легасі-доба, ручна правка),
  // береться воно.
  // ⚠️ ВИВЕДЕНЕ ПЕРЕКРИВАЄ ЗБЕРЕЖЕНЕ, а не навпаки — і це другий захист, не
  // основний. Основний стоїть в UI: закритий showIf чистить відповідь (див.
  // clearGatedAnswers у questions.ts). Але послідовність «обрав Спав → 8 годин
  // → передумав, Не спав» лишала в KV sleepH=8 разом із sleepKind='none', і
  // при старому `m.sleepH ?? derived` модель читала б безсонну ніч як 8 годин
  // сну — найгірший з можливих результатів для поля, яке додано саме заради
  // таких ночей. Легасі-доби це не зачіпає: там sleepKind=null, отже derived
  // немає взагалі, і береться збережене.
  const DERIVED_SLEEP = { none: { h: 0, q: 1 }, naps: { h: 2, q: 2 } };
  const kind = m.sleepKind ?? null;
  const derived = kind ? DERIVED_SLEEP[kind] : undefined;

  return {
    sleepKind: kind,
    sleepH: derived?.h ?? m.sleepH ?? null,
    sleepQ: derived?.q ?? m.sleepQ ?? null,
    sleepLatency: m.sleepLatency ?? null,
    awakenings: m.awakenings ?? null,
    bedtime: m.bedtime ?? null,
    bodyFeel: m.bodyFeel ?? null,
    dayLoad: m.dayLoad ?? null,
    'energy@morning': m.energy ?? null,
    'energy@afternoon': a.energy ?? null,
    'energy@evening': e.energy ?? null,
    'mood@morning': m.mood ?? null,
    'mood@afternoon': a.mood ?? null,
    'mood@evening': e.mood ?? null,
    worryAM: m.worryAM ?? null,
    rushed: a.rushed ?? null,
    interrupted: a.interrupted ?? null,
    mainProgress: a.mainProgress ?? null,
    outdoorNow: a.outdoorNow ?? null,
    movePlan: m.movePlan ?? null,
    dayControl: m.dayControl ?? null,
    pace: a.pace ?? null,
    output: e.output ?? null,
    focusQuality: e.focusQuality ?? null,
    effort: e.effort ?? null,
    kept: e.kept ?? null,
    jobProgress: e.jobProgress ?? null,
    autonomy: e.autonomy ?? null,
    intentMatch,
    jobConfidence: e.jobConfidence ?? null,
    moved: e.moved ?? null,
    outdoor: e.outdoor ?? null,
    detached: e.detached ?? null,
    rumination: e.rumination ?? null,
    screen: e.screen ?? null,
    caffeine: e.caffeine ?? null,
    dayScore: e.dayScore ?? null,
  };
}
