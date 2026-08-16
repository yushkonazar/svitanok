import { z } from 'zod';

// Контракт /api/stats (роадмеп v3, E1). Форми списані 1:1 з aggregateStats
// (web/stats-core.mjs:435-481) + доповнень handleStats (web/worker.js:483-508:
// roadmap, mastery, votes). Zod-об'єкти за замовчуванням відкидають зайві ключі,
// тож схема стійка до нових полів сервера; nullable/optional — там, де джерело
// реально їх повертає (median -> null, best-стрік -> може бути 0, votes відсутні
// поза голосуванням). Валідація — safeParse у client.ts: биті дані -> плейсхолдери,
// не краш вкладки.

const num = z.number();
const int = z.number();

export const weeklyDaySchema = z.object({
  day: z.string(),
  value: num,
  active: z.boolean(),
});

// Воронка v2 (F1): 4 лінійні + термінальні rejected/failed.
// ⚠️ Цей enum — найкрихкіше місце контракту: варто серверу віддати стадію, якої
// тут немає, і safeParse валить ВЕСЬ /api/stats (не один елемент) -> вкладки
// «Статистика» й «Вакансії» йдуть у помилку. Розширювати синхронно зі stats-core.
export const stageSchema = z.enum(['saved', 'applied', 'interview', 'offer', 'rejected', 'failed']);

export const funnelSchema = z.object({
  saved: int,
  applied: int,
  interview: int,
  offer: int,
  // .default(0) — старий сервер (до F1) цих полів не віддає; без дефолту дашборд
  // ліг би на першому ж завантаженні під час деплою.
  rejected: int.default(0),
  failed: int.default(0),
});

/** Один перехід у журналі стадій — для «Історії» у шторці вакансії. */
export const stageEventSchema = z.object({ stage: stageSchema, ts: z.string() });

export const funnelItemSchema = z.object({
  url: z.string(),
  stage: stageSchema,
  title: z.string(),
  /** Дата ПЕРШОГО входу у воронку (F1), не останнього переходу. */
  ts: z.string(),
  /** Журнал переходів; легасі-записи (до F1) його не мають -> порожній. */
  history: z.array(stageEventSchema).default([]),
});

/** Скільки вакансій КОЛИСЬ дійшли до стадії — знаменники конверсій (F1). */
export const reachedSchema = z.object({
  saved: int.default(0),
  applied: int.default(0),
  interview: int.default(0),
  offer: int.default(0),
});

export const savedItemSchema = z.object({
  kind: z.string(),
  id: z.string().nullable(),
  title: z.string(),
  url: z.string().nullable(),
  ts: z.string(),
});

/** Сторінка архіву збереженого — GET /api/saved (F3). */
export const savedPageSchema = z.object({
  items: z.array(savedItemSchema).default([]),
  total: int.default(0),
});

export const weakTopicSchema = z.object({ name: z.string(), value: num });

// o/m/n — склад активності дня (opens/mock/news). .default(0): старий воркер
// віддає лише d/v/l, і без дефолтів safeParse валив би ВЕСЬ /api/stats.
export const heatmapCellSchema = z.object({
  d: z.string(),
  v: num,
  l: int,
  o: int.default(0),
  m: int.default(0),
  n: int.default(0),
});

/** Розподіл часу першого відкриття — коробка з вусами (p10/q1/median/q3/p90). */
/** Половина вікна ритуалу — для порівняння «раніше» проти «тепер». */
const rhythmHalfSchema = z.object({
  n: int.default(0),
  median: num.nullable().default(null),
  iqr: num.nullable().default(null),
});

export const openRhythmSchema = z.object({
  ready: z.boolean().default(false),
  n: int.default(0),
  needed: int.optional(),
  p10: num.nullable().optional(),
  q1: num.nullable().optional(),
  median: num.nullable().optional(),
  q3: num.nullable().optional(),
  p90: num.nullable().optional(),
  iqr: num.nullable().optional(),
  /** null — половин замало для порівняння. Це НЕ «розкид не змінився». */
  drift: z.object({ early: rhythmHalfSchema, late: rhythmHalfSchema }).nullable().default(null),
});

/** Тиждень звички: активні доби зі СПРАВЖНЬОГО знаменника + склад активності. */
export const habitWeekSchema = z.object({
  week: z.string(),
  active: int.default(0),
  days: int.default(0),
  opens: int.default(0),
  mock: int.default(0),
  news: int.default(0),
});

export const appliedWeekSchema = z.object({ week: z.string(), count: int });

/**
 * Швидкість воронки: скільки триває кожен крок і що лежить без руху.
 *
 * ⚠️ medianDays nullable ЗІ ЗМІСТОМ: null — «переходів замало для медіани»,
 * а не «нуль днів». Нуль тут читався б як «миттєво», тобто найкраща можлива
 * оцінка діставалась би кроку, який ще жодного разу нормально не пройшли.
 */
export const funnelStepSchema = z.object({
  from: stageSchema,
  to: stageSchema,
  n: int.default(0),
  medianDays: num.nullable().default(null),
});

export const staleJobSchema = z.object({
  url: z.string(),
  stage: stageSchema,
  title: z.string().default(''),
  days: int.default(0),
});

export const funnelSpeedSchema = z.object({
  steps: z.array(funnelStepSchema).default([]),
  stale: z.array(staleJobSchema).default([]),
  staleAfterDays: int.default(21),
});

export const interestSchema = z.object({ topic: z.string(), score: num });

export const interestsTrendSchema = z.object({
  weeks: z.array(z.string()),
  topics: z.array(z.object({ topic: z.string(), series: z.array(num) })),
});

export const roadmapSchema = z.object({ done: int, total: int });

export const masteryThemeSchema = z.object({
  id: z.string(),
  title: z.string(),
  done: int,
  total: int,
});

export const masteryHintSchema = z.object({
  mockTopic: z.string(),
  themes: z.array(masteryThemeSchema),
});

export const themeOfWeekSchema = z.object({
  week: z.string(),
  topicId: z.string(),
  title: z.string(),
  done: int,
  total: int,
  mockTopics: z.array(z.string()),
});

/** Куроване джерело з роадмепу — «Вивчити» в картці питання (F4/F5). */
export const materialSchema = z.object({ title: z.string(), url: z.string() });

/**
 * Готовність однієї теми роадмепу: прогрес × як даються питання по ній.
 *
 * ⚠️ easePct НЕ nullable «про всяк випадок» — null тут має ЗМІСТ: питань по
 * темі не було. Нуль читався б як «усе складно», тобто найгірша оцінка
 * діставалась би темі лише за те, що її жодного разу не питали. Екран мусить
 * показувати такі теми окремо, а не в одному рейтингу з реально слабкими.
 */
export const masteryTopicSchema = z.object({
  id: z.string(),
  title: z.string(),
  done: int.default(0),
  total: int.default(0),
  seen: int.default(0),
  weak: int.default(0),
  easePct: num.nullable().default(null),
});

export const masterySchema = z.object({
  hints: z.array(masteryHintSchema).default([]),
  themeOfWeek: themeOfWeekSchema.nullable().default(null),
  topics: z.array(masteryTopicSchema).default([]),
});

/* ── Чек-ін (п.7) ──────────────────────────────────────────────────────────
   Форми 1:1 зі stats-core.mjs. Поля блоків — .optional(), бо блок пишеться
   дебаунсом і цілком легально буває заповнений частково. */

// Життєві категорії — дзеркало CATEGORIES/CATEGORY_VALUES (stats-core.mjs).
const category = z.enum([
  'work',
  'learn',
  'project',
  'travel',
  'chores',
  'sport',
  'rest',
  'people',
  'create',
  'health',
  'admin',
  // Три статті часу, що доти тонули в 'chores' і 'rest' — тобто спотворювали
  // саме ті кошики, які вже працювали.
  'food',
  'scroll',
  'games',
]);
// ⚠️ checkinToday — це HYDRATION-дані, які міг записати СТАРІШИЙ сервер (інша
// версія переліку: до v2 plan/ate мали apply/interview/procrast). Тому enum-поля
// ТУТ толерантні (.catch(undefined)): невідоме значення тихо стає undefined —
// одне поле деградує, а не валиться safeParse УСЬОГО /api/stats (це зачорнило б
// Статистику+Вакансії до півночі для тих, хто вже зробив чек-ін до деплою).
const lenient = <T extends z.ZodType>(s: T) => s.optional().catch(undefined);
/**
 * Мультивибір: сервер нормалізує запис у МАСИВ, але в KV лежать роки записів,
 * де це поле було голим рядком. Приймаємо обидві форми й зводимо до масиву —
 * інакше стара доба валила б гідратацію екрана (а lenient сховав би її тихо,
 * і чек-ін виглядав би незаповненим).
 */
const multi = <T extends z.ZodType>(s: T) =>
  z
    .union([z.array(s), s])
    .transform((v) => (Array.isArray(v) ? v : [v]))
    .optional()
    .catch(undefined);
export const checkinMorningSchema = z.object({
  /** Режим ночі. Гейтить sleepH/sleepQ у чек-іні; значення для моделі виводить
   *  flattenCheckinDay, тож пропуск двох питань НЕ обнуляє RECOVERY. */
  sleepKind: lenient(z.enum(['none', 'naps', 'slept'])),
  sleepH: num.optional(),
  sleepQ: int.optional(),
  sleepLatency: lenient(z.enum(['fast', 'mid', 'slow', 'vslow'])),
  /** Причина зіпсованої ночі — мультивибір: одна ніч рідко має одну причину. */
  nightReason: multi(
    z.enum([
      'wait',
      'work',
      'cant',
      'uncomf',
      'anxious',
      'health',
      'people',
      'scroll',
      'travel',
      'other',
    ]),
  ),
  /** Четвертий вимір сну: з тривалості й якості не виводиться. */
  awakenings: lenient(z.enum(['no', 'once', 'few', 'many'])),
  bedtime: lenient(z.enum(['e23', 'e00', 'e01', 'e02', 'late'])),
  lateReason: lenient(
    z.enum(['work', 'scroll', 'metime', 'anxious', 'social', 'late_home', 'other']),
  ),
  energy: int.optional(),
  mood: int.optional(),
  plan: multi(category),
  planApply: int.optional(),
  worryAM: int.optional(),
  /** Тіло зранку — третій не-вечірній вхід у BODY. */
  bodyFeel: int.optional(),
  /** Очікуване навантаження дня — пара до обіднього `rushed`. */
  dayLoad: int.optional(),
  /** ⚠️ Усі ЧОТИРИ рівні `moved`: інакше «легко» в намірі важить 0.50, а
   *  «легко» у факті — 0.33, і пара «намір проти факту» завищує намір. */
  movePlan: lenient(z.enum(['none', 'light', 'active', 'workout'])),
  dayControl: int.optional(),
  dayExpect: int.optional(),
  // Кнопка «Підтвердити» (сервер: stats-core.mjs case 'checkin') — після
  // цього прапорця бекенд ІГНОРУЄ будь-які подальші правки блоку. Живе тут,
  // а не в окремій схемі, бо приходить у ТОМУ САМОМУ checkinToday[slot].
  confirmed: z.boolean().optional(),
});
export const checkinAfternoonSchema = z.object({
  pace: lenient(z.enum(['on', 'off', 'behind', 'other', 'overload', 'better'])),
  energy: int.optional(),
  mood: int.optional(),
  ate: multi(category),
  rushed: int.optional(),
  withWhom: lenient(
    z.enum(['alone', 'partner', 'family', 'friends', 'work', 'public', 'mixed']),
  ),
  outdoorNow: lenient(z.enum(['none', 'short', 'long'])),
  mainProgress: lenient(z.enum(['none', 'started', 'half', 'most'])),
  interrupted: lenient(z.enum(['none', 'few', 'many'])),
  confirmed: z.boolean().optional(),
});
export const checkinEveningSchema = z.object({
  dayScore: int.optional(),
  kept: lenient(z.enum(['yes', 'partly', 'no', 'changed'])),
  applied: int.optional(),
  energy: int.optional(),
  mood: int.optional(),
  effort: int.optional(),
  output: int.optional(),
  blocker: multi(
    z.enum([
      'tired',
      'anxious',
      'stuck',
      'external',
      'distract',
      'health',
      'nomotiv',
      'overload',
      'waiting',
      'procrast',
      'forgot',
      'noplan',
      'context',
      'perfect',
      'noise',
      'none',
    ]),
  ),
  helper: multi(
    z.enum([
      'early',
      'list',
      'breaks',
      'support',
      'move',
      'rest',
      'smallstep',
      'nodistract',
      'deadline',
      'music',
      'plan',
      'timer',
      'clean',
      'food',
      'none',
    ]),
  ),
  detached: lenient(z.enum(['yes', 'partly', 'no'])),
  rumination: int.optional(),
  autonomy: int.optional(),
  moved: lenient(z.enum(['none', 'light', 'active', 'workout'])),
  outdoor: lenient(z.enum(['none', 'short', 'long'])),
  screen: lenient(z.enum(['low', 'mid', 'high', 'vhigh'])),
  caffeine: int.optional(),
  jobProgress: int.optional(),
  jobConfidence: int.optional(),
  focusQuality: int.optional(),
  flames: multi(z.enum(['tiktok', 'duolingo', 'snapchat', 'bereal', 'chess'])),
  confirmed: z.boolean().optional(),
});
export const checkinDaySchema = z.object({
  morning: checkinMorningSchema.optional(),
  afternoon: checkinAfternoonSchema.optional(),
  evening: checkinEveningSchema.optional(),
});

/**
 * Гаряче вікно сирих чек-інів — доби з УСІМА тегами, ще не зведеними в рол-ап.
 *
 * Потрібне рівно там, де рол-ап безсилий: «тапнув клітинку карти станів — які
 * саме це були доби й що в них було». `checkinTops` знає, що втома траплялась
 * 14 разів, але не знає, чи серед них ці чотири вечори.
 *
 * ⚠️ Валідується СТРОГО (той самий checkinDaySchema, що й checkinToday), хоч
 * тут 90 діб замість однієї. Заміряно перед вибором: строго 0.55 мс проти
 * 0.13 мс вільно, на 90 добах, на КЛІЄНТІ — тобто різниця нижча за похибку
 * одного рендера, а натомість деталі клітинки читають `rec.evening.blocker`
 * із типами, а не як `unknown`. `.catch` на кожній добі (через lenient-стиль
 * усередині схеми) означає, що одна побита доба не забирає з собою вікно.
 *
 * from/to — РЕАЛЬНІ межі вікна, а не номінальні: підпис глибини малюється з
 * них, і саме через це блок «Чек-ін» перестає обіцяти period, якого не має.
 */
export const checkinRawSchema = z.object({
  days: int.default(90),
  from: z.string().default(''),
  to: z.string().default(''),
  records: z.record(z.string(), checkinDaySchema.catch({})).default({}),
});
/**
 * Глибини агрегації, оголошені сервером.
 *
 * ⚠️ Усі з дефолтами: старіший воркер поля `windows` не віддає, і без них
 * safeParse завалив би ВЕСЬ /api/stats під час деплою. Дефолти навмисно
 * дорівнюють нинішнім значенням STATS_WINDOWS — гірший сценарій тоді просто
 * «підпис показує вчорашню глибину», а не чорна вкладка.
 */
export const statsWindowsSchema = z.object({
  checkinRecent: int.default(30),
  checkinMid: int.default(60),
  checkinDeep: int.default(90),
  trendWeeks: int.default(8),
  checkinWeeks: int.default(8),
  reliabilityDays: int.default(90),
  /** «Ритуал відкриття» — рахується в ДОБАХ ІЗ ВІДКРИТТЯМ, не календарних. */
  rhythmOpens: int.default(90),
});

export const checkinPointSchema = z.object({
  d: z.string(),
  sleepH: num.nullable().default(null),
  energy: num.nullable().default(null),
  // Форма дня, а не лише її середнє: [ранок, день, вечір], null — незаповнений
  // слот (дірка), не нуль. Старий сервер полів не віддає -> порожній масив.
  energyCurve: z.array(num.nullable()).default([]),
  moodCurve: z.array(num.nullable()).default([]),
  dayScore: num.nullable().default(null),
  slots: int.default(0),
});

/** Ніч журналу сну (Блок «Сон») — тап «Ліг спати» + автоматичне «прокинувся»
 *  (перше відкриття наступного дня). durationMin — лише коли є ОБИДВА
 *  таймстемпи; одна нога без другої лишається null, а не здогадкою. */
export const sleepNightSchema = z.object({
  d: z.string(),
  startedAt: z.string().nullable().default(null),
  wokeAt: z.string().nullable().default(null),
  durationMin: num.nullable().default(null),
});

/** Дрейф наміру: план (ранок) проти того, що реально зайняло час (день). */
export const intentDriftSchema = z.object({
  days: int.default(0),
  total: int.default(0),
  // ⚠️ `matched` більше немає: воно означало «збігся БОДАЙ ОДИН плановий
  // пункт», тобто зараховувало добу цілком за половину зробленого. Замість
  // нього два ЧЕСНІ лічильники — повністю й частково, — і pct як СЕРЕДНЯ
  // частка виконаного плану, а не частка «зарахованих» діб.
  full: int.default(0),
  partial: int.default(0),
  pct: num.nullable().default(null),
  top: z.array(z.object({ from: z.string(), to: z.string(), n: int })).default([]),
});
export const checkinWeekSchema = z.object({
  week: z.string(),
  n: int.default(0),
  sleepAvg: num.nullable().default(null),
  energyAvg: num.nullable().default(null),
  dayScoreAvg: num.nullable().default(null),
});
export const checkinFillSchema = z.object({
  morning: int.default(0),
  afternoon: int.default(0),
  evening: int.default(0),
  days: int.default(30),
});
/** Пара-кошик із гейтом (ready=false -> цифр НЕМА: мала вибірка бреше впевнено).
 *  Форма спільна для «сон -> оцінка дня» (v2). */
export const corrPairSchema = z.object({
  ready: z.boolean().default(false),
  needed: int.default(8),
  low: int.default(0),
  ok: int.default(0),
  lowAvg: num.nullable().optional(),
  okAvg: num.nullable().optional(),
});
/** Куди йде час: розподіл категорій + сер. оцінка дня на категорію (null до гейта). */
export const categoryRowSchema = z.object({
  cat: z.string(),
  n: int.default(0),
  dayScore: num.nullable().default(null),
});
export const categoryInsightSchema = z.object({
  days: int.default(0),
  total: int.default(0),
  rows: z.array(categoryRowSchema).default([]),
});
/** Той самий гейт, кошики за часом відходу до сну. */
export const bedtimeVsEnergySchema = z.object({
  ready: z.boolean().default(false),
  needed: int.default(8),
  early: int.default(0),
  late: int.default(0),
  earlyAvg: num.nullable().optional(),
  lateAvg: num.nullable().optional(),
});
/** Найчастіший блокер/помічник (мода за N діб) — або null, коли порожньо. */
export const checkinTopSchema = z.object({ value: z.string(), n: int.default(0) });
/**
 * Як минали ночі: скільки зіпсованих і чому.
 *
 * ⚠️ effect під гейтом (той самий CORR_MIN_N): зіпсовані ночі рідкісні, і
 * «після безсонної день гірший на 1.2» на двох спостереженнях — монетка, яка
 * читається як висновок.
 */
export const nightKindsSchema = z.object({
  days: int.default(30),
  nights: int.default(0),
  slept: int.default(0),
  naps: int.default(0),
  none: int.default(0),
  rough: int.default(0),
  /** Дати самих ночей — факт, не висновок, тож без гейта. */
  dates: z.array(z.string()).default([]),
  reasons: z.array(checkinTopSchema).default([]),
  effect: z
    .object({
      ready: z.boolean().default(false),
      needed: int.optional(),
      nRough: int.default(0),
      roughAvg: num.optional(),
      restAvg: num.optional(),
    })
    .default({ ready: false, nRough: 0 }),
});
export const checkinTopsSchema = z.object({
  blocker: checkinTopSchema.nullable().default(null),
  helper: checkinTopSchema.nullable().default(null),
  // Повний рейтинг (не лише мода) — blocker/helper мультивибірні, тож їх немає
  // в реєстрі «Індексу дня»; ця картка — єдине місце, де вони видні.
  blockers: z.array(checkinTopSchema).default([]),
  helpers: z.array(checkinTopSchema).default([]),
  // ⚠️ Варіанти, які за все вікно не обрано ЖОДНОГО разу. Питання «що зі списку
  // зайве» доти вирішувалось здогадкою, а здогадка тут дорога в обидва боки:
  // прибрати варіант, що трапляється раз на місяць, — назавжди втратити рідкісну
  // причину; лишити мертвий — щовечора платити за нього увагою.
  unusedBlockers: z.array(z.string()).default([]),
  unusedHelpers: z.array(z.string()).default([]),
  // ⚠️ days — ГЛИБИНА ВІКНА, filled — скільки діб у ньому заповнено. Доти тут
  // лежало одне поле `days` зі значенням filled, і воно рендерилось як «· N
  // ДІБ», тобто читалось як глибина. «ЩО ЗАВАЖАЛО · 12 ДІБ» означало «12
  // заповнених із останніх 30», а виглядало як «за останні 12 днів». Поруч у
  // checkinFill те саме поле означало саме вікно — одна назва, протилежний
  // зміст, в одному payload.
  days: int.default(0),
  filled: int.default(0),
  // lateReason (ранкове, умовне поле) — той самий рейтинг, приєднаний з тієї ж
  // причини: причина пізнього відбою теж поза реєстром моделі.
  lateReasons: z.array(checkinTopSchema).default([]),
  lateNights: int.default(0),
});

/** Сам проти «з людьми» на вечірній оцінці дня — Cohen's d + Welch p. */
export const aloneVsOthersSchema = z.object({
  ready: z.boolean().default(false),
  needed: int.optional(),
  nAlone: int.default(0),
  nOthers: int.default(0),
  aloneAvg: num.nullable().optional(),
  othersAvg: num.nullable().optional(),
  d: num.nullable().optional(),
  p: num.nullable().optional(),
});
/**
 * Калібрування очікувань: ранковий dayExpect проти вечірнього dayScore.
 *
 * ⚠️ ЄДИНИЙ споживач dayExpect — поле навмисно поза індексами моделі, бо
 * описує прогноз про добу, а не саму добу.
 */
export const expectCalibrationSchema = z.object({
  days: int.default(30),
  n: int.default(0),
  ready: z.boolean().default(false),
  needed: int.optional(),
  avgExpect: num.nullable().optional(),
  avgActual: num.nullable().optional(),
  bias: num.nullable().optional(),
  better: int.optional(),
  same: int.optional(),
  worse: int.optional(),
});

/** Намір руху (ранок) проти факту (вечір). */
export const moveIntentSchema = z.object({
  days: int.default(30),
  n: int.default(0),
  ready: z.boolean().default(false),
  needed: int.optional(),
  planned: int.optional(),
  kept: int.optional(),
  /** null — планів не було взагалі; це НЕ «0% виконано». */
  keptPct: num.nullable().optional(),
  noPlanDays: int.optional(),
  noPlanButMoved: int.optional(),
});

/** Соціальний контекст дня (afternoon.withWhom): частота + сам-vs-люди. */
export const socialContextSchema = z.object({
  tops: z.array(checkinTopSchema).default([]),
  days: int.default(0),
  filled: int.default(0),
  aloneVsOthers: aloneVsOthersSchema.default({ ready: false, nAlone: 0, nOthers: 0 }),
});

/** Тиждень вогників: композиція конструктивні/споживчі (той самий знаменник
 *  «доби, що вже настали», що habitWeekSchema). */
export const flameWeekSchema = z.object({
  week: z.string(),
  /** Вечорів із ХОЧ ОДНИМ вогником. */
  active: int.default(0),
  /** Вечорів, де горіли ВСІ пʼять — той самий предикат, що стрік повної рутини. */
  full: int.default(0),
  days: int.default(0),
  constructive: int.default(0),
  consumptive: int.default(0),
});
/** Вогники сторонніх застосунків (evening.flames): рейтинг + тижнева композиція
 *  + стрік ПОВНОЇ рутини (усі FLAME_VALUES за добу). */
export const flameStatsSchema = z.object({
  tops: z.array(checkinTopSchema).default([]),
  activeNights: int.default(0),
  streak: int.default(0),
  best: int.default(0),
  weekly: z.array(flameWeekSchema).default([]),
});

// «Індекс дня» (checkin-model.mjs): композитні індекси, ваги, що вчаться на
// власних dayScore, драйвери, лаговий звʼязок, архетипи. Форми 1:1 з JS-
// портом моделі (analyzeCheckinModel) — golden-звірений з research/checkin_model.py.
export const modelIndexKeySchema = z.enum(['recovery', 'resource', 'work', 'agency', 'body']);
export const checkinFitSchema = z.object({
  weights: z.record(modelIndexKeySchema, num),
  /** Знак β окремо від величини: смуги показують ВАГУ, рахунок — НАПРЯМОК. */
  signs: z.record(modelIndexKeySchema, num).optional(),
  /** Обрана крос-валідацією регуляризація (доти була зашита в 1.0). */
  lambda: num.optional(),
  r2: num.nullable().default(null),
  /**
   * Крос-валідований R² (leave-one-out).
   *
   * ⚠️ Може бути ВІДʼЄМНИМ — це не помилка, а «передбачає гірше за просте
   * середнє». Саме той випадок, коли моделі не варто вірити, тож ховати його
   * не можна. Внутрішньовибірковий r2 завжди оптимістичніший.
   */
  r2cv: num.nullable().optional(),
  n: int.default(0),
  learned: z.boolean().default(false),
});
export const checkinDayIndexSchema = z.object({
  /** null, коли доба не дотягнула до needCoverage — «ще рано», не «нема даних». */
  last: num.nullable().default(null),
  mean: num.nullable().default(null),
  /** Скільки з пʼяти вимірів дала остання доба і скільки треба. */
  lastCoverage: int.default(0),
  needCoverage: int.default(3),
  /** Скільки діб вікна взагалі отримали оцінку — чесний знаменник середнього. */
  scored: int.default(0),
});
export const checkinDriverSchema = z.object({
  field: z.string(),
  index: modelIndexKeySchema,
  delta: num,
  d: num,
  p: num,
  /** p після поправки Бенʼяміні-Хохберга на всю родину драйверів. */
  q: num.optional(),
  /** Чи витримує поправку на множинні порівняння. */
  passesBH: z.boolean().optional(),
  nHigh: int,
  nLow: int,
});
/** Той самий гейт-патерн, що corrPairSchema/bedtimeVsEnergySchema, лише для
 *  лагового звʼязку «сьогодні -> завтра» (rho/p зʼявляються тільки ready). */
export const checkinLaggedSchema = z.object({
  ready: z.boolean().default(false),
  n: int.default(0),
  needed: int.optional(),
  rho: num.nullable().optional(),
  p: num.nullable().optional(),
  src: z.string().optional(),
  target: z.string().optional(),
});
export const checkinArchetypeGroupSchema = z.object({
  n: int.default(0),
  share: num.default(0),
  profile: z.record(modelIndexKeySchema, num),
  top: modelIndexKeySchema,
  low: modelIndexKeySchema,
});
export const checkinArchetypesSchema = z.object({
  ready: z.boolean().default(false),
  n: int.default(0),
  needed: int.optional(),
  k: int.optional(),
  groups: z.array(checkinArchetypeGroupSchema).default([]),
});
export const checkinModelSchema = z.object({
  n: int.default(0),
  fit: checkinFitSchema,
  dayIndex: checkinDayIndexSchema,
  drivers: z.array(checkinDriverSchema).default([]),
  // Ключі — підмножина INDICES (сервер рахує лаг лише для recovery/body,
  // FIELD 7 у research/checkin_model.py), не всі 5: string-record, не enum-record.
  lagged: z.record(z.string(), checkinLaggedSchema),
  archetypes: checkinArchetypesSchema,
});

const EMPTY_CHECKIN_MODEL = {
  n: 0,
  fit: { weights: { recovery: 0.2, resource: 0.2, work: 0.2, agency: 0.2, body: 0.2 }, r2: null, n: 0, learned: false },
  dayIndex: { last: null, mean: null, lastCoverage: 0, needCoverage: 3, scored: 0 },
  drivers: [],
  lagged: { recovery: { ready: false, n: 0 }, body: { ready: false, n: 0 } },
  archetypes: { ready: false, n: 0, groups: [] },
};

export const statsSchema = z.object({
  streaks: z.object({
    openDays: int.default(0),
    mockDays: int.default(0),
    bestOpenDays: int.optional(),
  }),
  timeToOpenMin: num.nullable().default(null),
  weekly: z.array(weeklyDaySchema).default([]),
  funnel: funnelSchema,
  goal: z.object({ weeklyTarget: num.nullable().default(null), weeklyApplied: int.default(0) }),
  conversion: z.object({ appliedToInterview: num, interviewToOffer: num }),
  // F1: знаменники конверсій — щоб «50%» читалось як «1 з 2». Старий сервер поля
  // не віддає -> дефолт нулями.
  reached: reachedSchema.default({ saved: 0, applied: 0, interview: 0, offer: 0 }),
  avgFitApplied: num.nullable().default(null),
  funnelList: z.array(funnelItemSchema).default([]),
  dismissedUrls: z.array(z.string()).default([]),
  savedCount: int.default(0),
  savedList: z.array(savedItemSchema).default([]),
  mock: z.object({
    weakTopics: z.array(weakTopicSchema).default([]),
    streak: int.default(0),
    // Загальний recency-сигнал (без розбивки по темі — mockRated не прив'язує
    // qId до теми) поруч із all-time weakTopics%. null, доки жодної оцінки.
    recentEasyPct: num.nullable().default(null),
    /**
     * Частка «легко» по тижнях.
     *
     * ⚠️ Стало можливим лише з таймстемпом на оцінці. Доти хронологію довелось
     * би виводити з порядку ключів обʼєкта — а він не гарантований (усе-цифровий
     * base36-ключ JS переставляє на початок), тобто тренд міг мовчки
     * перевернутись. easePct=null означає «тиждень без питань», а не «все було
     * складно»: нуль злив би дві протилежні відповіді.
     */
    easeTrend: z
      .array(z.object({ week: z.string(), n: int.default(0), easePct: num.nullable().default(null) }))
      .default([]),
    /** {тема: {seen, weak}} за останні 60 діб — на противагу all-time weakTopics. */
    recentByTopic: z
      .record(z.string(), z.object({ seen: int.default(0), weak: int.default(0) }))
      .default({}),
  }),
  heatmap: z.array(heatmapCellSchema).default([]),
  appliedWeekly: z.array(appliedWeekSchema).default([]),
  funnelSpeed: funnelSpeedSchema.default({ steps: [], stale: [], staleAfterDays: 21 }),
  // Fit% поданих по тижнях — той самий {week,count}-шейп духом, що appliedWeekly,
  // але avgFit замість count (nullable — тиждень без жодного fit-запису).
  fitWeekly: z.array(z.object({ week: z.string(), avgFit: num.nullable() })).default([]),
  // Ріст роадмепу по тижнях — перевикористовує appliedWeekSchema {week,count},
  // не нова форма контракту (той самий підхід, що вже є для appliedWeekly).
  roadmapWeekly: z.array(appliedWeekSchema).default([]),
  interestsTrend: interestsTrendSchema.default({ weeks: [], topics: [] }),
  interests: z.array(interestSchema).default([]),
  readPerDay: num.default(0),
  reliability: z.object({
    onTime: int.default(0),
    total: int.default(0),
    deadman: int.default(0),
    streak: int.default(0),
    best: int.default(0),
    days: z.array(z.object({ d: z.string(), ok: z.boolean() })).default([]),
  }),
  mockRatedToday: z.boolean().optional(),
  // F4: qId -> обрана оцінка. Доти вибір жив лише в стані сесії й зникав після
  // перезавантаження: чипи були заблоковані, але жоден не підсвічений.
  mockRated: z.record(z.string(), z.enum(['easy', 'hard'])).default({}),
  // F4: mock-тема -> матеріали роадмепу. Старий сервер поля не віддає -> {}.
  mockMaterials: z.record(z.string(), z.array(materialSchema)).default({}),
  roadmap: roadmapSchema.optional(),
  mastery: masterySchema.optional(),
  // zod 4: z.record ВИМАГАЄ обидві схеми — ключа й значення. З одним аргументом
  // v4 читає його як схему КЛЮЧА (у v3 це була схема значення), тобто мовчазна
  // інверсія сенсу: замість «url -> голос» вийшло б «ключі мусять бути up/down»,
  // і кожен реальний votes завалював би валідацію -> вкладка «Статистика» в
  // помилку. Ключ тут — url новини.
  votes: z.record(z.string(), z.enum(['up', 'down'])).optional(),

  // ── Чек-ін (п.7) ──
  // Усе .optional()/.default() — старий воркер цих полів не віддає, а safeParse
  // валить ЦІЛИЙ /api/stats, не одне поле (див. попередження зверху файлу).
  checkinSlot: z.enum(['morning', 'afternoon', 'evening']).nullable().optional(),
  checkinToday: checkinDaySchema.nullable().optional(),
  checkinSeries: z.array(checkinPointSchema).default([]),
  checkinRaw: checkinRawSchema.default({ days: 90, from: '', to: '', records: {} }),
  // Глибини агрегації, оголошені сервером (STATS_WINDOWS у stats-core.mjs).
  // Підписи «за N діб / N тижнів» малюються ЗВІДСИ, а не з памʼяті клієнта:
  // доти «8 ТИЖНІВ» стояло зашитим рядком у RhythmBlock окремо від серверної
  // константи, і розійшлись би вони мовчки.
  windows: statsWindowsSchema.default({
    checkinRecent: 30,
    checkinMid: 60,
    checkinDeep: 90,
    trendWeeks: 8,
    checkinWeeks: 8,
    reliabilityDays: 90,
    rhythmOpens: 90,
  }),
  sleepLog: z.array(sleepNightSchema).default([]),
  checkinWeekly: z.array(checkinWeekSchema).default([]),
  checkinFill: checkinFillSchema.default({ morning: 0, afternoon: 0, evening: 0, days: 30 }),
  // Аналітика чек-іну v2 (трекер життя). Усе .default() — старий воркер полів не
  // віддає, а safeParse валить ЦІЛИЙ /api/stats.
  sleepVsDayScore: corrPairSchema.default({ ready: false, needed: 8, low: 0, ok: 0 }),
  bedtimeVsEnergy: bedtimeVsEnergySchema.default({ ready: false, needed: 8, early: 0, late: 0 }),
  categoryInsight: categoryInsightSchema.default({ days: 30, total: 0, rows: [] }),
  checkinTops: checkinTopsSchema.default({
    blocker: null,
    helper: null,
    blockers: [],
    helpers: [],
    unusedBlockers: [],
    unusedHelpers: [],
    days: 30,
    filled: 0,
    lateReasons: [],
    lateNights: 0,
  }),
  nightKinds: nightKindsSchema.default({
    days: 30,
    nights: 0,
    slept: 0,
    naps: 0,
    none: 0,
    rough: 0,
    dates: [],
    reasons: [],
    effect: { ready: false, nRough: 0 },
  }),
  expectCalibration: expectCalibrationSchema.default({ days: 30, n: 0, ready: false }),
  moveIntent: moveIntentSchema.default({ days: 30, n: 0, ready: false }),
  socialContext: socialContextSchema.default({
    tops: [],
    days: 60,
    filled: 0,
    aloneVsOthers: { ready: false, nAlone: 0, nOthers: 0 },
  }),
  checkinModel: checkinModelSchema.default(EMPTY_CHECKIN_MODEL),
  openRhythm: openRhythmSchema.default({ ready: false, n: 0, drift: null }),
  habitWeekly: z.array(habitWeekSchema).default([]),
  flameStats: flameStatsSchema.default({
    tops: [],
    activeNights: 0,
    streak: 0,
    best: 0,
    weekly: [],
  }),
  // Працює на ВЖЕ зібраних даних (plan/ate є роками) — не чекає накопичення
  // нових полів чек-іну.
  intentDrift: intentDriftSchema.default({ days: 30, total: 0, full: 0, partial: 0, pct: null, top: [] }),
});

export type Stats = z.infer<typeof statsSchema>;
export type CheckinSlot = 'morning' | 'afternoon' | 'evening';
export type CheckinDay = z.infer<typeof checkinDaySchema>;
export type CheckinPoint = z.infer<typeof checkinPointSchema>;
export type CheckinRaw = z.infer<typeof checkinRawSchema>;
export type CheckinWeek = z.infer<typeof checkinWeekSchema>;
export type WeeklyDay = z.infer<typeof weeklyDaySchema>;
export type Funnel = z.infer<typeof funnelSchema>;
export type FunnelItem = z.infer<typeof funnelItemSchema>;
export type StageEvent = z.infer<typeof stageEventSchema>;
export type Reached = z.infer<typeof reachedSchema>;
export type Material = z.infer<typeof materialSchema>;
export type SavedPage = z.infer<typeof savedPageSchema>;
export type SavedItem = z.infer<typeof savedItemSchema>;
export type WeakTopic = z.infer<typeof weakTopicSchema>;
export type HeatmapCell = z.infer<typeof heatmapCellSchema>;
export type MasteryTopic = z.infer<typeof masteryTopicSchema>;

/**
 * Місячна згортка з холодного архіву (GET /api/archive).
 *
 * ⚠️ Усе, крім `month`, — з дефолтами. Архів пишеться раз на добу й переживає
 * роки: запис, зроблений старішою версією згортки, не має валити екран через
 * поле, якого тоді ще не існувало.
 */
export const archiveMonthSchema = z.object({
  month: z.string(),
  checkinDays: int.default(0),
  sleepAvg: num.nullable().default(null),
  energyAvg: num.nullable().default(null),
  moodAvg: num.nullable().default(null),
  dayScoreAvg: num.nullable().default(null),
  activeDays: int.default(0),
  opens: int.default(0),
  mock: int.default(0),
  news: int.default(0),
  applied: int.default(0),
});

export const archiveSchema = z.object({ months: z.array(archiveMonthSchema).default([]) });
export type ArchiveMonth = z.infer<typeof archiveMonthSchema>;
export type AppliedWeek = z.infer<typeof appliedWeekSchema>;
export type Interest = z.infer<typeof interestSchema>;
export type InterestsTrend = z.infer<typeof interestsTrendSchema>;
export type Mastery = z.infer<typeof masterySchema>;
export type MasteryHint = z.infer<typeof masteryHintSchema>;
export type ThemeOfWeek = z.infer<typeof themeOfWeekSchema>;
export type Roadmap = z.infer<typeof roadmapSchema>;
