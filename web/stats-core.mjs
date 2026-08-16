// Чиста логіка статистики дашборда (F1): запис подій + агрегація для /api/stats.
// Без залежностей і без I/O — щоб покрити тестами (worker.js імпортує це, KV-I/O
// робить Worker). Стор — один JSON-блоб у KV (ключ `stats`).
//
// checkin-model.mjs — окремий файл (портована математика: індекси/ridge-ваги/
// драйвери/архетипи), а не inline тут: research/checkin_model.py лишається
// специфікацією-оракулом, і держати JS-порт в одному місці з однією назвою
// файлу простіше звіряти з golden-векторами (tests/checkin-model.test.ts).
import {
  analyzeCheckinModel,
  flattenCheckinDay,
  cohensD,
  welchP,
  sleepHoursOf,
} from './checkin-model.mjs';
//
// Форма стору (усе опційне, defaults у emptyStore):
//   days:      { 'YYYY-MM-DD': { opens, mock, step, news } }  // денна активність
//   funnel:    { '<url>': 'saved'|'applied'|'interview'|'offer' }  // стадія вакансії
//   funnelMeta:{ '<url>': { title, ts } }                    // мета стадії (для списку)
//   saved:     [ { kind, url?, title, category?, ts } ]       // обране: news/fact/quote/question
//   interests: { '<topic>': score }                          // з голосів/кліків
//   interestsWeekly:{ '<пн-YYYY-MM-DD>': { topic: score } }  // тижневі кошики інтересів (тренд)
//   mockTopics:{ '<topic>': { seen, weak } }                 // самооцінка mock (по темі)
//   mockRated: { '<qId>': 'easy'|'hard' }                    // оцінка по ПИТАННЮ (F4, кап 60)
//   goal:      { weeklyTarget }
//   fitApplied:[ int ]                                       // ЛЕГАСІ fit% (до ревʼю D; тепер fit у appliedLog[].fit)
//   opensMin:  [ int ]                                       // хв після 08:00 до відкриття
//   appliedLog:[ { url, ts, fit? } ]                         // подачі (дедуп по url) — лічильник тижня + fit
//   reliability:{ onTime, total, deadman, lastCheckDate? }   // облік доставки (dead-man, 10:00 Київ)
//   checkins:  { 'YYYY-MM-DD': { morning?, afternoon?, evening? } }  // чек-ін (кап 365)

const UA_DAYS = ['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

// Воронка v2 (роадмеп v3, F1). Чотири лінійні стадії + ДВІ ТЕРМІНАЛЬНІ:
//   rejected — відмовили після подачі (до співбесіди);
//   failed   — провал співбесіди.
// Термінальні свідомо ПОЗА лінійним порядком: це не «далі по воронці», а вихід
// із неї. Тому STAGE_RANK їх не містить — «дійшов до» рахується лише лінійними.
//
// ⚠️ Незнана стадія НЕ ігнорується: recordEvent трактує її як stage:null, тобто
// ВИДАЛЯЄ вакансію з воронки. Тому будь-яка нова стадія має спершу зʼявитись
// тут, і лише потім у клієнтах.
const LINEAR_STAGES = ['saved', 'applied', 'interview', 'offer'];
const TERMINAL_STAGES = ['rejected', 'failed'];
// export: recordAction/jobStage (agent-core.mjs схема + worker.js валідація)
// має відкидати НЕ-STAGES значення, а не пускати їх у recordEvent(job_stage),
// де відсутня/невідома стадія тихо ВИДАЛЯЄ вакансію з воронки (див. ⚠️ вище).
export const STAGES = [...LINEAR_STAGES, ...TERMINAL_STAGES];
const STAGE_RANK = { saved: 0, applied: 1, interview: 2, offer: 3 };

// Скільки збереженого показує /api/stats (прев'ю на вкладці «Інтереси»).
// Повний список — /api/saved зі сторінками (F3).
const SAVED_PREVIEW = 8;
const SAVED_PAGE_MAX = 50;

// Оцінені питання (F4): qId -> 'easy'|'hard'. Кап — щоб блоб не ріс роками;
// підсвітка потрібна лише свіжим питанням, які ще на екрані.
const MOCK_RATED_CAP = 60;

// Скільки переходів тримаємо на вакансію (журнал для «Історії» у шторці).
// Обмеження — щоб блоб KV не ріс безмежно на вакансії, яку ганяють туди-сюди.
const HISTORY_PER_JOB = 12;

// Тижнева ціль подач (F2): діапазон слайдера в Mini App. Клампимо і на записі
// (set_goal), і на читанні (normalize) — щоб биті/легасі значення в KV
// самолікувались, а не малювали смугу прогресу на 4000%.
const GOAL_MIN = 1;
const GOAL_MAX = 10;
const GOAL_DEFAULT = 5;
const clampGoal = (v) => Math.min(GOAL_MAX, Math.max(GOAL_MIN, v));

/* ── Чек-ін (фідбек власника, п.7) ─────────────────────────────────────────
   Три блоки за часом доби. Межі — рішення власника: 08:00 / 14:00 / 20:00.
   Вечір перетинає північ (20:00–02:00), 02:00–08:00 — тиха зона, коли не
   відкритий жоден блок.

   Питання закриті (число або перелік) свідомо: вільний текст неможливо
   порівняти з учора, а вся цінність чек-іну — у порівнянні. Найсильніші два —
   `planApply` (скільки подач планую) і `kept` (чи зробив): це єдині відповіді,
   які застосунок може ПЕРЕВІРИТИ проти appliedLog, а не лише записати. */

export const CHECKIN_SLOTS = ['morning', 'afternoon', 'evening'];

/** Година (київська), з якої блок відкритий. Кінець = початок наступного. */
export const CHECKIN_FROM = { morning: 8, afternoon: 14, evening: 20 };

/** Скільки діб тримаємо чек-іни. Як HISTORY_CAP — блоб не має рости роками. */
const CHECKIN_CAP = 365;

/**
 * Опис полів блоку — він же валідатор.
 * `num: [min, max]` — число в межах; `int` — ще й ціле; `enum` — закритий перелік.
 */
// Бакети "О котрій ліг?" — той самий enum, що CHECKIN_FIELDS.morning.bedtime
// нижче; іменований export, бо case 'sleepStart' (тап «Ліг спати») теж
// звіряється з ним, зберігаючи бакет на sleepLog-записі.
export const BEDTIME_BUCKETS = ['e23', 'e00', 'e01', 'e02', 'late'];

/**
 * Дозволені значення "Скільки годин ти спав?" — СЕРЕДИНИ діапазонів
 * (<4, 4–5, …, 9+). ДЗЕРКАЛО `qs.sleepH.o` у
 * web/app/src/components/checkin/questions.ts: змінюєш тут — міняй і там.
 *
 * ⚠️ Це не декоративний перелік, а контракт із UI. CheckinScreen підсвічує
 * варіант СУВОРОЮ рівністю (`answers[q.id] === v`), тож будь-яке значення поза
 * цим набором рендериться як «нічого не обрано».
 */
export const SLEEP_H_BUCKETS = [3.5, 4.5, 5.5, 6.5, 7.5, 8.5, 9.5];

/**
 * Приліпити виміряні години сну до бакета UI (7.6год -> 7.5, тобто «7–8»).
 *
 * ⚠️ Регресія (фідбек власника: «досі не працює автоматична підстановка часу
 * сну»). Автозаповнення писало ТОЧНЕ число (Math.round(h*10)/10 -> 7.6), а UI
 * знає лише сім середин вище й звіряє їх сувору рівність — 7.6 !== 7.5, тож
 * жоден варіант не підсвічувався й екран виглядав порожнім, хоч значення в KV
 * лежало. Точність при цьому НЕ втрачається: «🌙 Точний сон» у Статистиці
 * рахується з sleepLog (startedAt/wokeAt), а не з цього поля.
 *
 * floor(h)+0.5 — рівно семантика діапазонів: 7.0..7.99 -> «7–8».
 */
export function snapSleepHours(h) {
  const mid = Math.floor(h) + 0.5;
  return Math.min(SLEEP_H_BUCKETS[SLEEP_H_BUCKETS.length - 1], Math.max(SLEEP_H_BUCKETS[0], mid));
}

// Дев'ять життєвих категорій (v2, трекер життя) — дзеркало CATEGORIES у
// web/app/src/components/checkin/questions.ts.
// export: recordAction/checkin (agent-core.mjs схема) посилається на ТОЙ САМИЙ
// перелік — щоб enum не розходився й не вимагав ручного дзеркалення.
export const CATEGORY_VALUES = [
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
  // ⚠️ ТРИ ДОДАНІ КАТЕГОРІЇ І ЇХНЯ ЦІНА. Перелік спільний для «головне на
  // сьогодні» й «на що пішов час», тож кожна нова категорія РОЗРІДЖУЄ кошики
  // buildCategoryInsight (там свій поріг CATEGORY_SCORE_MIN) — за це платимо
  // свідомо, бо доти три реальні статті часу не мали куди лягти й тонули в
  // 'chores' та 'rest', тобто спотворювали саме ті кошики, які вже працюють.
  //
  // 'scroll' навмисно є і в плані: він там ніколи не зʼявиться, і це РОБИТЬ
  // РОБОТУ — intentMatch рахує |план ∩ факт| / |план|, тож доба, де час пішов
  // у стрічку замість плану, тепер видно як розрив, а не як «відпочинок».
  'food',
  'scroll',
  'games',
];

/** Скільки варіантів максимум приймаємо в мультивиборі (день не має 5 причин). */
const MULTI_MAX = 3;

/**
 * Перешкоди/помічники розширені й СПІВСТАВЛЕНІ: майже кожній перешкоді
 * відповідає правдоподібний помічник (distract↔nodistract, stuck↔smallstep,
 * tired↔move, anxious↔support). Це те, що робить питання «що спрацювало
 * проти саме цієї перешкоди» взагалі відповідальним.
 */
export const BLOCKER_VALUES = [
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
  // Чотири причини, яким доти не було куди лягти, і кожна має свою пару нижче.
  // «Не було плану» тонуло в 'stuck' (не знав з чого) — хоч це різні дні:
  // одному бракує першого кроку, другому взагалі списку. «Перемикався» тонуло
  // в 'distract', хоч відволікання приходить ЗЗОВНІ, а перемикання робиш сам.
  'noplan',
  'context',
  'perfect',
  'noise',
  'none',
];
export const HELPER_VALUES = [
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
  // Пари до нових перешкод: noplan↔plan, context↔timer, noise↔clean,
  // tired/health↔food. Без пари помічник не додається — інакше список росте, а
  // відповісти «що спрацювало проти саме цієї перешкоди» стає НЕ легше.
  'plan',
  'timer',
  'clean',
  'food',
  'none',
];
// П'ять незалежних щоденних стріків (кожен додаток рахує свій окремо) —
// нема капу нижче кількості значень: усі п'ять цілком реально запалити
// в один день, на відміну від blocker/helper де 3 з ~10 — розумна стеля.
export const FLAME_VALUES = ['tiktok', 'duolingo', 'snapchat', 'bereal', 'chess'];
// Розподіл на "конструктивні" (навчання/гра розуму) проти "споживчих"
// (стрічка) — не деталь UI, а свідомий поділ: композиція звички цікавіша за
// сирий перелік застосунків (buildFlameStats нижче).
export const CONSTRUCTIVE_FLAMES = new Set(['duolingo', 'chess']);

// Експортується не заради Worker'а (він читає це локально), а заради
// CI-assert'у «enum ⊆ levels»: значення, яке ЗБИРАЄ чек-ін, але яке не знає
// checkin-model.mjs, нормалізується в null і тихо вибиває поле — а для BODY
// (лише 2 поля при MIN_FIELDS_PER_INDEX=2) це викидає ВСЮ добу з навчання
// ваг і архетипів. Саме так сталося з moved:'active' (B5).
export const CHECKIN_FIELDS = {
  morning: {
    // ⚠️ Режим ночі стоїть ПЕРЕД тривалістю й гейтить її разом із якістю:
    // на 'none'/'naps' ті питання не показуються, а значення виводить
    // flattenCheckinDay. Рівні дзеркалять checkin-model.mjs.
    sleepKind: { enum: ['none', 'naps', 'slept'] },
    sleepH: { num: [0, 14] },
    // Якість окремо від тривалості — стандарт Consensus Sleep Diary (1..5).
    // Без неї поріг «<6.5год» рахує 8 годин поганого сну виспаним.
    sleepQ: { num: [1, 5], int: true },
    // ⚠️ Причина зіпсованої ночі — мультивибір, дзеркало lateReason. Ніч без
    // сну рідко має одну причину: чекав ранку І було незручно І доробляв
    // проєкт — типова комбінація, а не рідкість.
    nightReason: {
      enumMulti: [
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
      ],
      max: MULTI_MAX,
    },
    // Скільки засинав — третій незалежний факт (ліг / засинав / проспав).
    sleepLatency: { enum: ['fast', 'mid', 'slow', 'vslow'] },
    // Четвертий: скільки разів ніч рвалась. Із трьох попередніх не виводиться.
    awakenings: { enum: ['no', 'once', 'few', 'many'] },
    bedtime: { enum: BEDTIME_BUCKETS },
    // Тіло зранку — третій не-вечірній вхід у BODY і єдиний про САМОПОЧУТТЯ
    // (рух і час надворі — це поведінка).
    bodyFeel: { num: [1, 5], int: true },
    // Очікуване навантаження дня — пара до обіднього `rushed`.
    dayLoad: { num: [1, 5], int: true },
    // Чому пізно — питається УМОВНО (лише коли лягав пізно), тож у нормальні
    // дні коштує нуль тапів. «Мстива прокрастинація сну»: стресовий день ->
    // лягаю пізніше, щоб урвати час для себе.
    lateReason: {
      enum: ['work', 'scroll', 'metime', 'anxious', 'social', 'late_home', 'other'],
    },
    energy: { num: [1, 5], int: true },
    // Настрій (валентність) поруч з енергією (активація) — разом дають 2D
    // афект замість однієї осі. Обидва йдуть з ОДНОГО тапу по паду.
    mood: { num: [1, 5], int: true },
    plan: { enumMulti: CATEGORY_VALUES, max: 2 },
    planApply: { num: [0, 20], int: true },
    worryAM: { num: [1, 5], int: true },
    // Намір руху — перший НЕ-вечірній вхід у BODY. Рівні дзеркалять `moved`
    // слово в слово (усі ЧОТИРИ, включно з 'active'), інакше пара «намір проти
    // факту» порівнює два різні нулі-до-одиниці й завищує намір.
    movePlan: { enum: ['none', 'light', 'active', 'workout'] },
    // Пад «очікування × контроль»: один тап, два поля (той самий прийом, що
    // AFFECT і work2d). dayControl живить AGENCY, dayExpect — калібрування
    // проти вечірнього dayScore.
    dayControl: { num: [1, 5], int: true },
    dayExpect: { num: [1, 5], int: true },
  },
  afternoon: {
    // «off» лишається (легасі-записи), але розділено на конкретніші причини:
    // відстаю / роблю інше / перевантажений — це три різні дні.
    pace: { enum: ['on', 'off', 'behind', 'other', 'overload', 'better'] },
    energy: { num: [1, 5], int: true },
    mood: { num: [1, 5], int: true },
    ate: { enumMulti: CATEGORY_VALUES, max: 2 },
    rushed: { num: [1, 5], int: true },
    // ⚠️ Пари з questions.ts: значення, яке збирає чек-ін, але якого немає
    // тут, нормалізується в null і ТИХО вибиває поле (так було з moved:'active',
    // баг B5). CI-assert «enum ⊆ levels» стереже саме цю пару.
    withWhom: { enum: ['alone', 'partner', 'family', 'friends', 'work', 'public', 'mixed'] },
    // Другий не-вечірній вхід у BODY; рівні дзеркалять вечірній `outdoor`.
    outdoorNow: { enum: ['none', 'short', 'long'] },
    // Друга не-вечірня опора WORK після pace.
    mainProgress: { enum: ['none', 'started', 'half', 'most'] },
    // Переривання ЗЗОВНІ — окремо від власного відволікання: доти обидві
    // причини зливались у блокер 'distract', хоч рішення в них різні.
    interrupted: { enum: ['none', 'few', 'many'] },
  },
  evening: {
    dayScore: { num: [1, 5], int: true },
    // «changed» — свідома зміна пріоритетів, це НЕ провал. Доти вона тонула
    // в «no» і псувала і статистику дотримання, і звʼязок з автономією.
    kept: { enum: ['yes', 'partly', 'no', 'changed'] },
    applied: { num: [0, 20], int: true },
    energy: { num: [1, 5], int: true },
    mood: { num: [1, 5], int: true },
    // Зусилля × результат (NASA-TLX: effort і performance — РІЗНІ виміри).
    // Теж один тап по паду. Квадранти: потік / гриндж / легкий день / застій.
    effort: { num: [1, 5], int: true },
    output: { num: [1, 5], int: true },
    blocker: { enumMulti: BLOCKER_VALUES, max: MULTI_MAX },
    helper: { enumMulti: HELPER_VALUES, max: MULTI_MAX },
    // Відновлення й румінація — єдині поля, чия цінність у звʼязку з
    // ЗАВТРАШНІМ днем (перший лагований звʼязок у цьому застосунку).
    detached: { enum: ['yes', 'partly', 'no'] },
    rumination: { num: [1, 5], int: true },
    autonomy: { num: [1, 5], int: true },
    moved: { enum: ['none', 'light', 'active', 'workout'] },
    outdoor: { enum: ['none', 'short', 'long'] },
    screen: { enum: ['low', 'mid', 'high', 'vhigh'] },
    caffeine: { num: [0, 10], int: true },
    jobProgress: { num: [1, 5], int: true },
    jobConfidence: { num: [1, 5], int: true },
    focusQuality: { num: [1, 5], int: true },
    flames: { enumMulti: FLAME_VALUES, max: FLAME_VALUES.length },
  },
};

/**
 * Значення мультивибору як масив.
 *
 * ⚠️ Сумісність: `plan`/`ate`/`blocker`/`helper` РАНІШЕ зберігались рядком, і
 * в KV лежать роки таких записів. Кожен читач цих полів мусить іти через цей
 * хелпер, інакше стара доба тихо випаде з аналітики (а не впаде помітно).
 */
export function asList(v) {
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string' && x);
  return typeof v === 'string' && v ? [v] : [];
}

/**
 * Активний блок за КИЇВСЬКОЮ годиною, або null у тиху зону (02:00–07:59).
 *
 * ⚠️ Рахує сервер, не клієнт. Інакше «ранковий» чек-ін можна надіслати опівночі,
 * перевівши годинник на телефоні, — і дані стануть художнім твором.
 */
/**
 * Чи слот чек-іну справді заповнений.
 *
 * ⚠️ ЄДИНЕ ВИЗНАЧЕННЯ НА ВЕСЬ ПРОЄКТ — і саме тому воно тут, а не по місцях.
 * Доти їх було два, і вони розходились: «Явка по слотах» рахувала
 * `Object.keys(...).length`, а нагадування — `Boolean(...)`. Порожній обʼєкт
 * ІСТИННИЙ, тож достатньо було відмітити відповідь і зняти її повторним тапом:
 * запис лишався як `{}`, нагадування на добу вимикалось назавжди, а статистика
 * той самий слот бачила порожнім.
 *
 * Той самий клас, що вже ловили з полем `days` і назвою KV-ключа: два способи
 * сказати одне й те саме, які мовчки розʼїжджаються.
 *
 * `confirmed` НЕ рахується сам по собі: підтвердити порожній блок неможливо
 * (recordEvent це відсікає), тож ключ ніколи не буває там наодинці.
 */
export function isCheckinSlotFilled(rec, slot) {
  const v = rec?.[slot];
  return !!v && typeof v === 'object' && Object.keys(v).length > 0;
}

export function checkinSlot(hour) {
  // Суворо number, без Number(): Number(null) === 0, а нуль — ВАЛІДНА година,
  // яка падає рівно у вечірнє вікно (h < 2). Тобто м'яке приведення робило б із
  // null/''/[] «вечір» — та сама пастка, що колись ставила goal=1 на будь-яке
  // сміття в set_goal.
  if (typeof hour !== 'number' || !Number.isFinite(hour)) return null;
  const h = Math.floor(hour);
  if (h < 0 || h > 23) return null;
  if (h >= CHECKIN_FROM.morning && h < CHECKIN_FROM.afternoon) return 'morning';
  if (h >= CHECKIN_FROM.afternoon && h < CHECKIN_FROM.evening) return 'afternoon';
  if (h >= CHECKIN_FROM.evening || h < 2) return 'evening';
  return null;
}

/**
 * Доба, якій НАЛЕЖИТЬ чек-ін, за київською годиною й датою «зараз».
 *
 * ⚠️ Не те саме, що kyivDateKey. Вечір іде до 02:00, а о 00:30 календарна дата
 * вже нова — вечірній чек-ін ліг би на добу, яка щойно почалась, і зіпсував би
 * обидві: у вчорашньої зник би вечір, у сьогоднішньої зʼявився б вечір раніше за
 * ранок. Тому ніч до 6-ї віддаємо попередній добі.
 */
export function checkinDateKey(kyivDate, hour) {
  if (!isDateKey(kyivDate)) return kyivDate;
  // Суворо number — інакше Number(null)===0 зсунув би дату на вчора «просто так».
  // Сумнів завжди на користь НЕ зсувати: зсунути помилково гірше, ніж не зсунути.
  if (typeof hour !== 'number' || !Number.isFinite(hour)) return kyivDate;
  const h = Math.floor(hour);
  if (h >= 6) return kyivDate;
  const d = new Date(kyivDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return dayKey(d);
}

/** dateKey, зсунутий на n діб (може бути відʼємним). Ніч сну -> ранок, що йде
 *  за нею (case 'open', авто-заповнення sleepH/bedtime), використовує n=1. */
function addDays(dateKey, n) {
  const d = new Date(dateKey + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return dayKey(d);
}

/*
 * Нагадування про незаповнений чек-ін (фідбек власника: «забуваю інколи про
 * них»). Вікна — НЕ технічний кінець слоту (checkinSlot: вечір формально до
 * 02:00), а практичний момент «ще встигаєш»: нагадувати вночі безглуздо.
 */
export const CHECKIN_NUDGE_WINDOWS = [
  {
    slot: 'morning',
    fromMin: 780,
    toMin: 810, // 13:00–13:30, слот закінчується 14:00
    text: '🌅 Ще не заповнив ранковий чек-ін — швидко зробити зараз?',
  },
  {
    slot: 'afternoon',
    fromMin: 1140,
    toMin: 1170, // 19:00–19:30, слот закінчується 20:00
    text: '☀️ Ще не заповнив післяобідній чек-ін — швидко зробити зараз?',
  },
  {
    slot: 'evening',
    fromMin: 1350,
    toMin: 1380, // 22:30–23:00, практичний момент «ще не спиш», не 02:00
    text: '🌙 Ще не заповнив вечірній чек-ін — доки не пізно?',
  },
];

/** Яке вікно нагадування відповідає поточній київській хвилині доби (0..1439)
 *  -> {slot,text}|null. Чисто lookup, жодного I/O. */
export function matchCheckinNudgeWindow(minuteOfDay) {
  return (
    CHECKIN_NUDGE_WINDOWS.find((w) => minuteOfDay >= w.fromMin && minuteOfDay < w.toMin) ?? null
  );
}

/**
 * Чи слати нагадування зараз (worker.js уже знайшов вікно й зібрав ці три
 * прапорці з KV: тихі години, чи вже нагадали цей слот сьогодні, чи слот уже
 * заповнено) -> boolean. Той самий стиль, що shouldAutoDispatchBrief
 * (tg-core.mjs) — уся логіка "чи" ізольована й тестована без KV/fetch.
 */
export function shouldSendCheckinNudge({ quiet, alreadyNudgedToday, slotFilled }) {
  if (quiet) return false;
  if (alreadyNudgedToday) return false;
  if (slotFilled) return false;
  return true;
}

/* ── Сон: нагадування «Ліг спати» (Блок «Сон») ─────────────────────────────
   Вікно 23:00–02:00 Київ, розбите на ДВІ половини через північ (minuteOfDay
   не «переходить» північ сам — 00:00–01:59 належить НАСТУПНІЙ календарній
   добі). Обидві половини worker.js зводить до ОДНІЄЇ ночі через
   checkinDateKey (той самий зсув, що вже коректно приписує вечірній чек-ін
   до 02:00 «вчорашньому вечору») — тут нова математика не потрібна. */
export const SLEEP_NUDGE_TEXT = '🌙 Ще не зафіксував відхід до сну — тисни, якщо вже лягаєш.';

/** У вікні нагадування «Ліг спати» (23:00–23:59 АБО 00:00–01:59)? */
export function inSleepNudgeWindow(minuteOfDay) {
  return (minuteOfDay >= 1380 && minuteOfDay <= 1439) || (minuteOfDay >= 0 && minuteOfDay < 120);
}

/** Чи слати нагадування «Ліг спати» зараз — той самий стиль, що shouldSendCheckinNudge. */
export function shouldSendSleepNudge({ quiet, alreadySentTonight }) {
  if (quiet) return false;
  if (alreadySentTonight) return false;
  return true;
}

/**
 * Ночі з надісланим, але НЕ натиснутим нагадуванням «Ліг спати» — з
 * ПОПЕРЕДНІХ (не поточної) ночей. Власник явно попросив: сповіщення не мусить
 * просто висіти, якщо тап так і не стався — worker.js бере цей список і
 * прибирає кнопку/дописує текст на кожній.
 */
export function staleSleepNudges(sleepLog, currentNightKey) {
  return Object.entries(sleepLog ?? {})
    .filter(
      ([k, v]) => v?.nudgeMsgId != null && !v.startedAt && !v.nudgeCleared && k !== currentNightKey,
    )
    .map(([dateKey, v]) => ({ dateKey, nudgeMsgId: v.nudgeMsgId }));
}

/**
 * Лишити тільки валідні поля блоку. Невідоме/бите ІГНОРУЄМО (як і раніше).
 *
 * ⚠️ Відсутній ключ і ЯВНИЙ намір «очисти» — РІЗНІ речі, які раніше сервер
 * плутав (обидва тихо ігнорувались — cleanCheckin пропускав undefined і null
 * однаково). Це робило зняття відповіді неможливим: клієнт «знімав» поле
 * ЛОКАЛЬНО (delete), але на дроті відсутній ключ означає «не чіпай», а не
 * «прибери» — той самий контракт, на який покладається агент, коли шле
 * ЧАСТКОВЕ оновлення (лише щойно згадані поля з розмови) і не мусить стирати
 * решту вже записаного.
 *
 * Тому явний сигнал очищення ОКРЕМИЙ від «не чіпай»:
 *   - скалярне/enum поле: null -> ОЧИСТИТИ (не «невалідне число», а намір);
 *   - мультивибір:        []   -> ОЧИСТИТИ (порожній вибір, а не сміття);
 *   - будь-яке поле відсутнє в ev -> НЕ ЧІПАТИ (як і завжди).
 *
 * Повертає { set, clear }: `set` — нові/змінені значення (як раніше єдиний
 * обʼєкт), `clear` — ключі, які треба ВИДАЛИТИ з існуючого блоку.
 */
function cleanCheckin(slot, ev) {
  const spec = CHECKIN_FIELDS[slot];
  if (!spec) return null;
  const set = {};
  const clear = [];
  for (const [k, rule] of Object.entries(spec)) {
    const v = ev[k];
    if (v === undefined) continue; // ключ відсутній у цій події -> не чіпаємо
    if (rule.enumMulti) {
      // null АБО порожній масив — явне очищення. Непорожній масив, що після
      // фільтра лишився порожнім (саме сміття) — ТИХО ігнорується, як і
      // раніше: сміття не мусить випадково стирати поле.
      if (v === null || (Array.isArray(v) && v.length === 0)) {
        clear.push(k);
        continue;
      }
      // Приймаємо і масив (нова форма), і голий рядок (легасі-клієнт/агент, що
      // ще шле одне значення) — asList зводить обидва до масиву. Дедуп + кап:
      // «день не має пʼяти причин», а без капу сюди можна залити весь enum.
      const list = [...new Set(asList(v))]
        .filter((x) => rule.enumMulti.includes(x))
        .slice(0, rule.max ?? MULTI_MAX);
      if (list.length) set[k] = list;
      continue;
    }
    if (v === null) {
      clear.push(k);
      continue;
    }
    if (rule.enum) {
      if (rule.enum.includes(v)) set[k] = v;
      continue;
    }
    // typeof, а не Number(): Number(null)===0 і Number('')===0 тихо
    // перетворили б «нічого» на валідну відповідь.
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    if (rule.int && !Number.isInteger(v)) continue;
    const [lo, hi] = rule.num;
    if (v < lo || v > hi) continue;
    set[k] = v;
  }
  return { set, clear };
}

/** Кап чек-інів: лишаємо останні CHECKIN_CAP діб (ключі сортуються лексично). */
function capCheckins(s) {
  const keys = Object.keys(s.checkins).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - CHECKIN_CAP))) delete s.checkins[k];
}

const RELIABILITY_CAP = 90;
/** Кап журналу надійності: лишаємо останні RELIABILITY_CAP діб. */
function capReliabilityDays(s) {
  const keys = Object.keys(s.reliability.days).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - RELIABILITY_CAP))) {
    delete s.reliability.days[k];
  }
}

/**
 * Кап архіву збереженого (S3). `saved` — єдиний масив у сторі, що ріс безмежно:
 * власник зберігає новини й факти роками, а блоб 'stats' читається й
 * переписується на КОЖНУ подію (відкриття застосунку, чек-ін, голос, три
 * 5-хвилинні крони). Тобто розмір тут — не «місце в KV», а латентність усіх
 * цих операцій. Тисяча записів — це роки збереженого при реальному темпі, тож
 * межа не ріже живе користування; обрізаємо з ХВОСТА (unshift кладе найновіше
 * на початок).
 */
export const SAVED_CAP = 1000;
function capSaved(s) {
  if (s.saved.length > SAVED_CAP) s.saved.length = SAVED_CAP;
}

/**
 * Кап денних бакетів (S3). Той самий горизонт, що CHECKIN_CAP: усе, що читає
 * days (стрік, тренди, «активний день тижня»), і так дивиться максимум на рік.
 */
export const DAYS_CAP = CHECKIN_CAP;
function capDays(s) {
  const keys = Object.keys(s.days).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - DAYS_CAP))) delete s.days[k];
}

const SLEEP_LOG_CAP = 90;
/** Кап журналу сну: лишаємо останні SLEEP_LOG_CAP ночей. */
function capSleepLog(s) {
  const keys = Object.keys(s.sleepLog).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - SLEEP_LOG_CAP))) {
    delete s.sleepLog[k];
  }
}

export function emptyStore() {
  return {
    days: {},
    funnel: {},
    funnelMeta: {},
    saved: [],
    interests: {},
    interestsWeekly: {},
    mockTopics: {},
    mockRated: {},
    goal: { weeklyTarget: GOAL_DEFAULT },
    fitApplied: [],
    opensMin: [],
    appliedLog: [],
    reliability: { onTime: 0, total: 0, deadman: 0, days: {} },
    checkins: {},
    sleepLog: {},
    checkinNudgeDates: {},
    dismissedUrls: [],
  };
}

/** Нормалізувати частковий стор до повної форми (стійко до старих/битих даних). */
export function normalize(s) {
  const e = emptyStore();
  if (!s || typeof s !== 'object') return e;
  return {
    days: s.days && typeof s.days === 'object' ? s.days : e.days,
    funnel: s.funnel && typeof s.funnel === 'object' ? s.funnel : e.funnel,
    funnelMeta: s.funnelMeta && typeof s.funnelMeta === 'object' ? s.funnelMeta : e.funnelMeta,
    saved: Array.isArray(s.saved) ? s.saved : e.saved,
    interests: s.interests && typeof s.interests === 'object' ? s.interests : e.interests,
    interestsWeekly:
      s.interestsWeekly && typeof s.interestsWeekly === 'object'
        ? s.interestsWeekly
        : e.interestsWeekly,
    mockTopics: s.mockTopics && typeof s.mockTopics === 'object' ? s.mockTopics : e.mockTopics,
    mockRated: s.mockRated && typeof s.mockRated === 'object' ? s.mockRated : e.mockRated,
    goal: { weeklyTarget: clampGoal(Number(s.goal?.weeklyTarget) || e.goal.weeklyTarget) },
    fitApplied: Array.isArray(s.fitApplied) ? s.fitApplied : e.fitApplied,
    opensMin: Array.isArray(s.opensMin) ? s.opensMin : e.opensMin,
    appliedLog: Array.isArray(s.appliedLog) ? s.appliedLog : e.appliedLog,
    reliability: {
      onTime: Number(s.reliability?.onTime) || 0,
      total: Number(s.reliability?.total) || 0,
      deadman: Number(s.reliability?.deadman) || 0,
      days: s.reliability?.days && typeof s.reliability.days === 'object' ? s.reliability.days : {},
      ...(typeof s.reliability?.lastCheckDate === 'string'
        ? { lastCheckDate: s.reliability.lastCheckDate }
        : {}),
    },
    checkins: s.checkins && typeof s.checkins === 'object' ? s.checkins : e.checkins,
    sleepLog: s.sleepLog && typeof s.sleepLog === 'object' ? s.sleepLog : e.sleepLog,
    checkinNudgeDates:
      s.checkinNudgeDates && typeof s.checkinNudgeDates === 'object'
        ? s.checkinNudgeDates
        : e.checkinNudgeDates,
    dismissedUrls: Array.isArray(s.dismissedUrls) ? s.dismissedUrls : e.dismissedUrls,
  };
}

const bump = (obj, key, by = 1) => {
  obj[key] = (Number(obj[key]) || 0) + by;
};
const dayBucket = (store, dateKey) => {
  // Пересоздаємо бакет і коли він битий (примітив зі старого/зіпсутого стору) —
  // bump по примітиву в strict mode кидає TypeError.
  const cur = store.days[dateKey];
  if (!cur || typeof cur !== 'object') store.days[dateKey] = { opens: 0, mock: 0, news: 0 };
  return store.days[dateKey];
};
/**
 * Date -> "YYYY-MM-DD" БЕЗ toISOString.
 *
 * ⚠️ Не мікрооптимізація заради краси. toISOString форматує ПОВНИЙ ISO —
 * час, мілісекунди, зону, — з якого ми щоразу беремо перші 10 символів. За
 * один /api/stats білдери проходять ~1500 діб (теплокарта, утримання,
 * вогники — по 365 кожен, плюс десяток вікон по 30-90), тож ця дрібниця
 * коштувала ~2 мс із десятимілісекундного бюджету CPU воркера. Заміряно:
 * ×5.4 на послідовності з 400 діб, вивід символ-у-символ той самий.
 *
 * getUTC* навмисно: увесь date-шар модуля працює в UTC, тож локальна зона
 * не має жодного шансу зсунути ключ.
 */
const pad2 = (n) => (n < 10 ? '0' + n : String(n));
export function dayKey(d) {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** "YYYY-MM-DD"? Битий ключ у date-математиці кидає RangeError — гардимо на вході. */
/**
 * Чи безпечно використати рядок як КЛЮЧ обʼєкта-мапи.
 *
 * ⚠️ Знайдено рев'ю: мапи стору кейзяться рядками з події (mockTopics[ev.topic]
 * і подібні), а патерн `if (!m[k]) m[k] = {...}; m[k].seen++` на ключі
 * '__proto__' НЕ створює запису — m['__proto__'] уже істинний (це
 * Object.prototype), тож інкремент іде В ПРОТОТИП. Після цього кожен порожній
 * обʼєкт у цьому ізоляті має поле `seen`, і будь-яка перевірка виду
 * `if (!obj.seen)` деінде починає брехати. Ізолят живе довго й обслуговує
 * наступні запити вже отруєним.
 *
 * Джерело ключа — POST /api/event власника, тобто це не шлях зловмисника, а
 * латентна пастка: досить одного кривого клієнта. Гард стоїть на ОБОХ межах —
 * на записі й на читанні, — бо стор, записаний до гарда, уже лежить у KV, і
 * виправити його заднім числом неможливо.
 */
export const isSafeKey = (k) =>
  typeof k === 'string' && k !== '__proto__' && k !== 'constructor' && k !== 'prototype';

export const isDateKey = (k) => typeof k === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(k);
// Кап історійних масивів (opensMin/fitApplied/appliedLog): медіані/трендам
// достатньо останнього року, стор не росте безмежно.
const HISTORY_CAP = 365;
const capPush = (arr, v) => {
  arr.push(v);
  if (arr.length > HISTORY_CAP) arr.splice(0, arr.length - HISTORY_CAP);
};

/** Понеділок тижня, що містить dateKey (ключ тижневих кошиків/трендів). */
export function weekStartKey(dateKey) {
  const d = new Date(dateKey + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return dayKey(d);
}

// Тижневих кошиків інтересів тримаємо пів року — тренду вистачає 6 тижнів.
const WEEKLY_CAP = 26;
/** ЄДИНА точка інкременту інтересу: сумарний бал + тижневий кошик разом —
 *  щоб нова подія не могла підняти чипи, забувши тренд (або навпаки). */
const bumpInterest = (s, dateKey, topic, by = 1) => {
  bump(s.interests, topic, by);
  const wk = weekStartKey(dateKey);
  if (!s.interestsWeekly[wk] || typeof s.interestsWeekly[wk] !== 'object')
    s.interestsWeekly[wk] = {};
  bump(s.interestsWeekly[wk], topic, by);
  const keys = Object.keys(s.interestsWeekly).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - WEEKLY_CAP))) delete s.interestsWeekly[k];
};

/**
 * Застосувати подію до стору (мутує й повертає його). `ev.type`:
 *  open · news_click · save_news · unsave_news · save_item · unsave_item ·
 *  job_stage · job_dismiss · mock_answer · step_done · vote.
 *  `dateKey`="YYYY-MM-DD" київський, `nowMin`=хв після 08:00.
 */
export function recordEvent(store, ev, dateKey, nowMin = null, nowIso = null) {
  const s = normalize(store);
  if (!isDateKey(dateKey)) return s; // без валідної дати подію не приймаємо (не валимо)
  const t = ev?.type;
  switch (t) {
    case 'open': {
      const day = dayBucket(s, dateKey);
      // «Час до відкриття» — лише ПЕРШЕ відкриття дня: клієнт шле open на кожне
      // завантаження, і без цього гейта повторні заходи (обід/вечір) тягнуть
      // медіану в сотні хвилин, знецінюючи метрику.
      const firstOpenToday = !(day.opens > 0);
      if (firstOpenToday && typeof nowMin === 'number' && nowMin >= 0)
        capPush(s.opensMin, Math.round(nowMin));
      // Сон: перше відкриття ПІСЛЯ реального сну — безкоштовний проксі
      // «прокинувся». Закриває БУДЬ-ЯКУ ще не закриту МИНУЛУ ніч (ключ !=
      // поточна дата) — не лише вчорашню: якщо застосунок не відкривали
      // кілька днів, перше ж відкриття закриває найдавнішу відкриту ніч теж.
      //
      // ⚠️ Регресія (фідбек власника): раніше цей блок гейтився firstOpenToday
      // — тим самим прапорцем, що й opensMin вище. Пізній передсонний тап
      // (Kyiv-доба вже перевалила північ, до тапу «Ліг спати») з'їдав «перше
      // відкриття дня» ще ДО сну; РЕАЛЬНЕ ранкове відкриття того ж
      // календарного дня більше не було «першим», і автозаповнення чек-іну
      // мовчки не спрацьовувало. Замість дня — поріг мінімального часу від
      // старту сну: підстраховує від миттєвого повторного відкриття одразу
      // після тапу «Ліг спати» (той самий edge case, що раніше прикривав
      // firstOpenToday), але не залежить від календарної доби.
      const MIN_HOURS_BEFORE_WAKE = 1;
      if (typeof nowIso === 'string' && nowIso) {
        let touchedCheckins = false;
        for (const [k, night] of Object.entries(s.sleepLog)) {
          const hours = night?.startedAt
            ? (Date.parse(nowIso) - Date.parse(night.startedAt)) / 3_600_000
            : NaN;
          if (
            night?.startedAt &&
            !night.wokeAt &&
            k !== dateKey &&
            hours >= MIN_HOURS_BEFORE_WAKE
          ) {
            night.wokeAt = nowIso;
            // Авто-заповнення ранкового чек-іну точними даними (власник,
            // Блок «Сон»: без цього ранкові sleepH/bedtime лишались
            // окремим, розбіжним джерелом від точних тапу+пробудження).
            // ЛИШЕ якщо ще НЕ відповіли самі — undefined, не == null: явне
            // очищення (null) теж НЕ перезаписуємо, той самий контракт, що
            // cleanCheckin.
            const morningDay = addDays(k, 1);
            if (!s.checkins[morningDay] || typeof s.checkins[morningDay] !== 'object') {
              s.checkins[morningDay] = {};
            }
            const morning = { ...(s.checkins[morningDay].morning ?? {}) };
            let filled = false;
            // Той самий діапазон, що CHECKIN_FIELDS.morning.sleepH (num [0,14]) —
            // поза ним тиша зона/кількаденна перерва дала б абсурдне число.
            if (morning.sleepH === undefined && hours > 0 && hours <= 14) {
              // Бакет UI, а не точне число — інакше варіант не підсвітиться
              // (див. snapSleepHours: сувора рівність у CheckinScreen).
              morning.sleepH = snapSleepHours(hours);
              filled = true;
            }
            if (morning.bedtime === undefined && night.bedtimeBucket) {
              morning.bedtime = night.bedtimeBucket;
              filled = true;
            }
            if (filled) {
              s.checkins[morningDay].morning = morning;
              touchedCheckins = true;
            }
          }
        }
        if (touchedCheckins) capCheckins(s);
      }
      bump(day, 'opens');
      break;
    }
    case 'news_click':
      bump(dayBucket(s, dateKey), 'news');
      if (ev.category) bumpInterest(s, dateKey, ev.category, 1);
      break;
    case 'save_news':
      if (ev.url && !s.saved.some((x) => x.url === ev.url)) {
        s.saved.unshift({
          kind: 'news',
          url: ev.url,
          title: ev.title || '',
          category: ev.category || '',
          ts: dateKey,
        });
        if (ev.category) bumpInterest(s, dateKey, ev.category, 2);
      }
      break;
    case 'unsave_news':
      s.saved = s.saved.filter((x) => x.url !== ev.url);
      break;
    case 'save_item':
      // Обране для нетекстових-з-url блоків (факт/цитата/питання): id рахує
      // клієнт (детермінований хеш тексту) — стабільний ключ дедупу замість url.
      if (ev.kind && ev.id && !s.saved.some((x) => x.kind === ev.kind && x.id === ev.id)) {
        s.saved.unshift({ kind: ev.kind, id: ev.id, title: ev.title || '', ts: dateKey });
        if (ev.topic) bumpInterest(s, dateKey, ev.topic, 2);
      }
      break;
    case 'unsave_item':
      s.saved = s.saved.filter((x) => !(x.kind === ev.kind && x.id === ev.id));
      break;
    case 'vote': {
      // Category-aware облік інтересу (C3, ревʼю): знімаємо ефект СТАРОГО голосу
      // з його теми (ev.prevCategory) і додаємо новий до поточної (ev.category).
      // Той самий url може прийти під іншою темою — тоді це дві різні теми, і
      // «повний дельта на одну» лишав би застряглий бал на старій. Коли теми
      // збігаються (звичайний випадок) — це зводиться до чистого val(new)-val(prev).
      // Без prevDir (старий клієнт без url) знімати нічого -> просто ±1 за new.
      //
      // ⚠️ Гілку 'down' НЕ прибирати, хоч ❤️ її вже не створює (фідбек власника,
      // п.5). Вона потрібна для ЧИТАННЯ prevDir: у KV лежать старі дизлайки, і
      // коли власник лайкне раніше дизлайкнуту новину, сюди прилетить
      // prevDir:'down'. Прибереш гілку — val('down') стане 0 замість -1, старий
      // мінус не знімешся, і бал теми назавжди лишиться на одиницю нижчим.
      const val = (d) => (d === 'up' ? 1 : d === 'down' ? -1 : 0);
      const prevCat = ev.prevCategory ?? ev.category;
      if (prevCat && ev.prevDir) bumpInterest(s, dateKey, prevCat, -val(ev.prevDir));
      if (ev.category && ev.dir) bumpInterest(s, dateKey, ev.category, val(ev.dir));
      break;
    }
    case 'job_stage':
      if (ev.url) {
        if (ev.stage && STAGES.includes(ev.stage)) {
          const prev = s.funnelMeta[ev.url];
          const prevStage = s.funnel[ev.url];
          s.funnel[ev.url] = ev.stage;
          // Мета (title+дата) — щоб дашборд показував СПИСОК вакансій стадії наскрізь
          // по днях, а не лише з поточного брифінгу (вакансії дедупляться на 7 днів).
          //
          // F1: `ts` — дата ПЕРШОГО потрапляння у воронку, далі незмінна. Доти вона
          // перезаписувалась на КОЖНІЙ зміні стадії, тобто напис «у воронці з …» у
          // шторці показував дату останнього переходу — просто неправда.
          //
          // `history` — журнал переходів (для «Історії»). Пишемо лише РЕАЛЬНУ зміну:
          // повторна подія тією ж стадією (напр. повторний тап) журнал не роздуває.
          const history = Array.isArray(prev?.history) ? [...prev.history] : [];
          if (prevStage !== ev.stage) {
            history.push({ stage: ev.stage, ts: dateKey });
            if (history.length > HISTORY_PER_JOB)
              history.splice(0, history.length - HISTORY_PER_JOB);
          }
          s.funnelMeta[ev.url] = {
            title: ev.title || prev?.title || '',
            ts: prev?.ts || dateKey,
            history,
          };
          if (ev.stage === 'applied') {
            // Ревʼю D: дедуп по url — одна вакансія = один запис подачі (fit живе в
            // самому записі). Повторний applied того ж url (напр. після delete+
            // re-apply з D5-контролів) оновлює дату/fit, а не додає рядок — інакше
            // «подач за тиждень» і гістограма fit роздувались.
            s.appliedLog = s.appliedLog.filter((a) => a.url !== ev.url);
            const entry = { url: ev.url, ts: dateKey };
            if (typeof ev.fit === 'number' && ev.fit >= 0) entry.fit = ev.fit;
            capPush(s.appliedLog, entry);
          } else if (ev.stage === 'saved') {
            // Назад у «збережено» = подачу знято -> прибрати з лічильника.
            // interview/offer НЕ чіпаємо: вакансію таки подано, вона прогресує.
            s.appliedLog = s.appliedLog.filter((a) => a.url !== ev.url);
          }
        } else {
          delete s.funnel[ev.url]; // stage null -> зняти
          delete s.funnelMeta[ev.url];
          // Видалення з воронки -> прибрати й з appliedLog (ревʼю D: інакше
          // видалена вакансія й далі рахувалась як подача).
          s.appliedLog = s.appliedLog.filter((a) => a.url !== ev.url);
        }
      }
      break;
    case 'job_dismiss':
      // Фідбек власника: «Не цікавить» мала прибирати вакансію зі списку
      // НАЗАВЖДИ, не лише на сесію. Раніше тут був no-op (ephemeral-рішення
      // стосувалось лише scorer-сигналу нижче, jobPrefs у worker.js) — і
      // React-стан `hidden` (сесійний Set) скидався на кожен перезахід,
      // тож вакансія поверталась. Дедуп по url — повторний тап того самого
      // «Не цікавить» не мусить роздувати список.
      if (typeof ev.url === 'string' && ev.url && !s.dismissedUrls.some((d) => d.url === ev.url)) {
        capPush(s.dismissedUrls, { url: ev.url, ts: dateKey });
      }
      break;
    case 'mock_answer': {
      // F4: оцінка привʼязана до ПИТАННЯ (qId), а не до дня.
      //
      // Доти запис не мав жодного дедупу: кожен POST знову бампав seen/weak, тож
      // повторний тап (або ретрай мережі) двічі рахував тему й криво тягнув
      // ваги генератора. Тепер qId — ключ ідемпотентності: перша оцінка рахує
      // seen і день (стрік = ДНІ практики, не кількість тапів), а зміна думки
      // лише переставляє weak.
      const rating = ev.rating === 'hard' ? 'hard' : ev.rating === 'easy' ? 'easy' : null;
      if (!rating) break; // сміття не рахуємо
      const qId = typeof ev.qId === 'string' && ev.qId ? ev.qId : null;
      // ⚠️ Порівнюємо ОЦІНКУ, а не сирий запис: відколи mockRated тримає обʼєкт,
      // `prev !== rating` було б істинним ЗАВЖДИ, і кожен повторний тап
      // накручував би weak. Дедуп по qId — саме те, заради чого qId і зʼявився.
      const prevRec = qId ? readRating(s.mockRated[qId]) : null;
      const prev = prevRec ? prevRec.r : undefined;
      const first = !prevRec;

      if (first) bump(dayBucket(s, dateKey), 'mock');
      if (ev.topic && isSafeKey(ev.topic)) {
        if (!s.mockTopics[ev.topic]) s.mockTopics[ev.topic] = { seen: 0, weak: 0 };
        const t = s.mockTopics[ev.topic];
        if (first) bump(t, 'seen');
        if (prev !== rating) {
          if (rating === 'hard') bump(t, 'weak');
          else if (prev === 'hard') t.weak = Math.max(0, (Number(t.weak) || 0) - 1);
        }
      }
      if (qId) {
        // ⚠️ ОБʼЄКТ, а не голий рядок. Доти було {qId: 'easy'|'hard'} — без часу
        // й без теми, і це блокувало одразу дві речі: тренд «чи стає легше»
        // (порядок ключів у JS-обʼєкті не гарантований — усе-цифровий base36
        // рушає на початок, тож хронологія на ньому була б вигадкою) і
        // «останні N по КОЖНІЙ темі». `at` оновлюється й при зміні думки:
        // свіжість стосується РІШЕННЯ, а не першого показу питання.
        s.mockRated[qId] = { r: rating, at: dateKey, topic: ev.topic || null };
        // Кап: ключі рядків зберігають порядок вставки, тож ріжемо найстаріші.
        const keys = Object.keys(s.mockRated);
        for (const k of keys.slice(0, Math.max(0, keys.length - MOCK_RATED_CAP)))
          delete s.mockRated[k];
      }
      break;
    }
    case 'set_goal': {
      // F2, слайдер «Тижнева ціль подач». Ціль ЖИВЕ в цьому сторі (goal.weeklyTarget
      // тут же й агрегується з weeklyApplied), тож їй не треба ні окремого
      // KV-ключа, ні ендпоінта — це подія, як і решта мутацій дашборда.
      // Суворо number: Number(null)/Number('')/Number([]) === 0, тож м'яке
      // приведення мовчки ставило б ціль 1 на будь-яке сміття замість ігнору.
      if (typeof ev.value === 'number' && Number.isFinite(ev.value)) {
        s.goal.weeklyTarget = clampGoal(Math.round(ev.value));
      }
      break;
    }
    case 'checkin': {
      // Слот і дату рахує ВОРКЕР (див. checkinSlot/checkinDateKey) — сюди вони
      // вже приходять готовими в ev.slot і dateKey.
      //
      // Підтверджений блок (confirmed:true) — далі ІГНОРУЄМО будь-які правки.
      // Це навмисне рішення власника: кнопка «Підтвердити» має сенс лише
      // якщо після неї справді нічого не можна змінити, інакше вона просто
      // бреше про остаточність. Перевірка ДО cleanCheckin — щоб жодне поле
      // (включно з повторним confirm) не могло торкнутись замкненого блоку.
      const existing = s.checkins[dateKey]?.[ev.slot];
      if (existing?.confirmed) break;

      const cleaned = cleanCheckin(ev.slot, ev);
      const clean = cleaned?.set ?? null;
      const clear = cleaned?.clear ?? [];
      const confirming = ev.confirmed === true;
      const hasClean = !!clean && Object.keys(clean).length > 0;
      const hasClear = clear.length > 0;
      // Невідомий слот, чи жодної зміни (ні нового значення, ні очищення) І не
      // підтвердження -> тихо нічого. М'який ігнор, як у mock_answer, а НЕ як
      // у job_stage (там невідоме значення означає «видалити» — для чек-іну це
      // знищувало б добу).
      if (!hasClean && !hasClear && !confirming) break;

      const merged = { ...existing, ...(clean ?? {}) };
      // Явне очищення (null/[] від клієнта) — ВИДАЛЯЄ ключ, а не залишає старе
      // значення. Саме цього не було раніше: {...existing, ...clean} умів лише
      // додавати/перезаписувати, ніколи не прибирав — «повторний тап знімає»
      // (questions.ts) працювало тільки локально, до першого дебаунсу.
      for (const k of clear) delete merged[k];
      if (confirming) {
        // Підтверджувати ПОРОЖНІЙ блок нема сенсу — це замкнуло б добу, де
        // жодної відповіді ще нема, назавжди без жодних даних усередині.
        if (!Object.keys(merged).length) break;
        merged.confirmed = true;
      }
      if (!s.checkins[dateKey] || typeof s.checkins[dateKey] !== 'object') s.checkins[dateKey] = {};
      // Мерджимо, а не замінюємо: клієнт шле блок дебаунсом, і часткова відповідь
      // не має стирати те, що вже відповіли раніше в цьому ж блоці.
      s.checkins[dateKey][ev.slot] = merged;
      capCheckins(s);
      break;
    }
    case 'sleepStart': {
      // Тап «🌙 Ліг спати» (Блок «Сон»). dateKey рахує ВОРКЕР через checkinDateKey
      // (той самий зсув, що вечірній чек-ін) — ніч до 06:00 лишається «вчорашньою».
      // Перший тап виграє (idempotent): повторний тап тієї ж ночі нічого не міняє —
      // той самий дух, що confirmed-лок чек-іну.
      if (typeof nowIso === 'string' && nowIso) {
        if (!s.sleepLog[dateKey] || typeof s.sleepLog[dateKey] !== 'object')
          s.sleepLog[dateKey] = {};
        if (!s.sleepLog[dateKey].startedAt) {
          s.sleepLog[dateKey].startedAt = nowIso;
          // Бакет "О котрій ліг?" рахує ВОРКЕР (kyivHour у момент тапу) — той
          // самий enum, що CHECKIN_FIELDS.morning.bedtime; зберігаємо тут, щоб
          // авто-заповнення ранкового чек-іну (case 'open' вище) не мусило
          // саме лізти в часові пояси.
          if (BEDTIME_BUCKETS.includes(ev.bedtimeBucket)) {
            s.sleepLog[dateKey].bedtimeBucket = ev.bedtimeBucket;
          }
        }
        capSleepLog(s);
      }
      break;
    }
    // 'step_done' прибрано (D4, «Крок до офера»); старі days[].step у KV просто
    // ігноруються (без міграції).
    default:
      break; // невідома подія — ігноруємо (не валимо)
  }
  // Кепи, що не привʼязані до конкретної гілки (S3): saved росте лише в
  // save_*, days — майже в кожній, тож дешевше підрізати один раз на виході.
  // Обидва — no-op, поки межа не перейдена.
  capSaved(s);
  capDays(s);
  return s;
}

/**
 * Записати результат щоденної dead-man-перевірки доставки (мутує й повертає стор).
 * Викликає Worker о 10:00 Київ: `delivered`=true, якщо `latest` свіжий за сьогодні.
 * onTime = «доставлено до dead-man дедлайну»; спізнення в межах вікна після 10:00
 * свідомо рахується як deadman (алерт тоді вже відправлено). Ідемпотентно за день
 * через reliability.lastCheckDate — повторний виклик тим самим dateKey — no-op.
 */
export function recordReliability(store, dateKey, delivered) {
  const s = normalize(store);
  const r = s.reliability;
  if (r.lastCheckDate === dateKey) return s;
  r.lastCheckDate = dateKey;
  r.total += 1;
  if (delivered) r.onTime += 1;
  else r.deadman += 1;
  r.days[dateKey] = { ok: delivered };
  capReliabilityDays(s);
  return s;
}

/** Обчислити стрік «днів поспіль» до сьогодні за предикатом дня.
 *  Грейс: якщо сьогодні ще «не зіграно», стрік НЕ зламано — рахуємо від учора
 *  (інакше лічильник обнулявся б щоночі до першої дії, а /api/stats при
 *  завантаженні гнався б із асинхронною подією open). */
function streak(days, dateKey, pred) {
  let cur = 0;
  const d = new Date(dateKey + 'T00:00:00Z');
  if (!pred(days[dateKey])) d.setUTCDate(d.getUTCDate() - 1);
  for (;;) {
    const k = dayKey(d);
    if (pred(days[k])) {
      cur++;
      d.setUTCDate(d.getUTCDate() - 1);
    } else break;
  }
  return cur;
}
function bestStreak(days, pred) {
  const keys = Object.keys(days).sort();
  let best = 0,
    run = 0,
    prev = null;
  for (const k of keys) {
    if (!pred(days[k])) {
      run = 0;
      prev = k;
      continue;
    }
    if (prev && dayDiff(prev, k) === 1) run++;
    else run = 1;
    prev = k;
    if (run > best) best = run;
  }
  return best;
}
function dayDiff(a, b) {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}

/**
 * Стрік надійності — НЕ голий streak(), бо тут грейс streak() був би хибним:
 * streak()'s "!pred(days[dateKey]) -> дивись учора" не розрізняє "сьогодні ще
 * не перевірено" (запису нема — грейс доречний, той самий сенс, що й для
 * streaks.openDays) від "сьогодні явно зафіксовано збій" (запис {ok:false}
 * Є — це вже факт, не "ще не сьогодні", і грейс сховав би сьогоднішній
 * зрив до завтра). Явний збій сьогодні -> стрік=0 одразу, без грейсу.
 */
function reliabilityStreak(days, dateKey) {
  const today = days[dateKey];
  if (today !== undefined && today.ok !== true) return 0;
  return streak(days, dateKey, (d) => d?.ok === true);
}
const median = (arr) => {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
};

/** Теплокарта активності: від понеділка тижня ПЕРШОГО реального запису
 *  активності до сьогодні (вкл.) — без верхньої межі (weeksSinceFirst).
 *  value = сума дій дня (opens+mock+news), level 0..4 — фіксовані пороги,
 *  щоб колір мав стале значення день у день.
 *
 *  o/m/n — СКЛАД тієї суми (opens/mock/news). Доти клітинка знала лише «скільки»,
 *  і три різні дні (тричі заходив / відповів на питання / читав новини) виглядали
 *  однаково. Тепер тап по клітинці може сказати, ЩО саме то був за день. */
function buildHeatmap(days, todayKey) {
  const weeks = weeksSinceFirst(days, todayKey);
  const d = new Date(lastWeekStarts(todayKey, weeks)[0] + 'T00:00:00Z');
  const out = [];
  for (;;) {
    const k = dayKey(d);
    if (k > todayKey) break;
    const day = days[k];
    const o = day?.opens || 0;
    const m = day?.mock || 0;
    const nw = day?.news || 0;
    const v = o + m + nw; // step прибрано (D4)
    const l = v <= 0 ? 0 : v === 1 ? 1 : v <= 3 ? 2 : v <= 6 ? 3 : 4;
    out.push({ d: k, v, l, o, m, n: nw });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/**
 * ВІКНА АГРЕГАЦІЇ — усі, в одному місці, і назовні разом із даними.
 *
 * ⚠️ ПРИВІД. Екран рахував на пʼятьох глибинах одночасно (30/60/90 діб,
 * 8 тижнів, «вся історія») і майже ніде цього не писав. Читач бачить числа
 * поруч і природно вважає, що вони про один період: «найчастіше заважала
 * втома» й «куди йде час» — це різні місяці, якщо чек-ін заповнювався нерівно.
 *
 * Гірше було з трендами подач: глибина стояла ЗАШИТОЮ В РЯДОК на клієнті
 * («FIT% ПОДАНИХ · 8 ТИЖНІВ») окремо від цієї константи. Розійшлись би —
 * підпис збрехав би мовчки, і дізнатись про це не було б звідки. Той самий
 * клас помилки, що B10 (три шари графіка на різних шкалах).
 *
 * Тому вікна їдуть у payload: підпис на екрані малюється З ДАНИХ, а не з
 * власної пам'яті про те, що там на сервері.
 *
 * ⚠️ ЧОМУ ЇХ ДОСІ КІЛЬКА, а не одне. Різна глибина тут ОСМИСЛЕНА, а не
 * випадкова: «що заважало» цінне саме СВІЖИМ (місяць — це те, на що ще можна
 * вплинути), а модель і карта станів потребують вибірки, тож дивляться на
 * квартал. Проблемою була невидимість, не різниця. Звести все в одне число
 * означало б зіпсувати або перше, або друге.
 */
export const STATS_WINDOWS = {
  /** «Останнім часом»: топи, категорії, дрейф наміру, явка, калібрування. */
  checkinRecent: 30,
  /** Порівняння, яким потрібна вибірка в обох кошиках (соцконтекст). */
  checkinMid: 60,
  /**
   * Модель «Індексу дня» і карта станів — усе, що претендує на висновок.
   *
   * ⚠️ 90 — не «щоб більше», а стеля, яку задає CPU. aggregateStats крутиться
   * на КОЖЕН /api/stats без кешу, Workers Free дає 10 мс CPU на запит, і час
   * росте лінійно з історією: заміряно 90 діб ≈ 7 мс, рік ≈ 11 мс, три роки
   * ≈ 22 мс. Тобто десь на річному горизонті бюджет закінчується, і довші
   * періоди мусять поїхати з місячних згорток окремим холодним ключем, а не
   * розширенням цього числа.
   */
  checkinDeep: 90,
  /** Тренди подач і fit% — тижневі стовпчики. */
  trendWeeks: 8,
  /** Тижневий розбір чек-іну. */
  checkinWeeks: 8,
  /** Журнал доставки (кап самого стору). */
  reliabilityDays: RELIABILITY_CAP,
  /**
   * «Ритуал відкриття» — скільки ОСТАННІХ діб із відкриттям беремо.
   *
   * ⚠️ Рахується в ЗАПИСАХ, не в календарних добах: opensMin — плаский масив
   * хвилин без дат, один запис = одна доба, коли застосунок відкривали. Тобто
   * це «останні 90 діб із відкриттям», і підпис мусить казати саме так.
   *
   * Вікно тут не косметика: доти медіана й розкид рахувались по ВСЬОМУ масиву
   * (кап HISTORY_CAP, до року), тож звичка, що змінилась три місяці тому,
   * тонула в старих записах — блок обіцяв «наскільки це ритуал ЗАРАЗ», а
   * показував середнє по році.
   */
  rhythmOpens: 90,
};

/**
 * Сирі записи чек-іну за гаряче вікно — рівно те, що лежить у сторі.
 *
 * НАВІЩО, коли є checkinSeries і десяток рол-апів. Ряд віддає лише скаляри,
 * а рол-апи (checkinTops, categoryInsight, socialContext…) відповідають на
 * «як ЧАСТО». Жоден із них не вміє відповісти на «а що було саме в ЦІ доби» —
 * питання, яке ставить карта станів, коли тапаєш клітинку. Для цього потрібні
 * теги, ще не зведені в підсумок.
 *
 * Поля НЕ фільтруються свідомо: щойно сервер почне вирішувати, які теги
 * «важливі», кожна зміна дизайну графіка стає зміною воркера. Клієнт бере
 * потрібне сам. Розріджено (лише заповнені доби) — дірки нічого не додають,
 * а на порожньому старті це різниця між {} і 90 пустишками.
 */
function buildCheckinRaw(checkins, todayKey, days = STATS_WINDOWS.checkinDeep) {
  const from = addDays(todayKey, -(days - 1));
  const records = {};
  for (const [key, rec] of Object.entries(checkins ?? {})) {
    if (key < from || key > todayKey) continue;
    if (rec && typeof rec === 'object') records[key] = rec;
  }
  return { days, from, to: todayKey, records };
}

/* ── Швидкість воронки ─────────────────────────────────────────────────────
   ⚠️ ПРОГАЛИНА, яку це закриває. Блок «Ритм» відповідав лише на «скільки»:
   конверсії у відсотках, тижнева ціль, два тренди. Питання «а СКІЛЬКИ ЦЕ
   ТРИВАЄ» і «що лежить без руху» не мало відповіді ніде — при тому, що дані
   для неї збираються давно: funnelMeta[url].history пише {stage, ts} на кожній
   реальній зміні стадії, і цей журнал уже їде в /api/stats заради «Історії» у
   шторці вакансії. Бракувало не даних, а їх зведення.

   Для того, хто шукає роботу, це найпрактичніше з усього блоку: «подав 12 діб
   тому й тиша» — привід написати, а не чекати далі. */

/** Лінійні кроки воронки; термінальні (rejected/failed) сюди не входять. */
const SPEED_STEPS = [
  ['saved', 'applied'],
  ['applied', 'interview'],
  ['interview', 'offer'],
];

/** Нижче цього медіана — не медіана, а одне-два спостереження. */
const SPEED_MIN_N = 3;

/**
 * Скільки діб вакансія стоїть без руху, перш ніж це варто помітити.
 *
 * ⚠️ Поріг ОДИН на всі стадії — свідомо. Спокуса зробити його різним («подано»
 * чекає довше за «збережено») означала б зашити в код припущення про те, як
 * поводяться роботодавці, якого дані не підтверджують. Формулювання при цьому
 * описове — «лежить без руху», не «протерміновано»: застосунок констатує факт,
 * а не звинувачує.
 */
const STALE_AFTER_DAYS = 21;

/** Активні стадії: у термінальних нічого не «лежить», там уже все вирішено. */
const ACTIVE_STAGES = ['saved', 'applied', 'interview'];

function funnelSpeed(funnel, funnelMeta, todayKey) {
  const meta = funnelMeta && typeof funnelMeta === 'object' ? funnelMeta : {};
  const durations = new Map(SPEED_STEPS.map(([, to]) => [to, []]));

  for (const m of Object.values(meta)) {
    const hist = Array.isArray(m?.history) ? m.history : [];
    for (let i = 1; i < hist.length; i++) {
      const from = hist[i - 1];
      const to = hist[i];
      if (!isDateKey(from?.ts) || !isDateKey(to?.ts)) continue;
      // Лише кроки ВПЕРЕД у лінійному порядку. Відкат (applied -> saved) сам по
      // собі не крок; але наступний рух уперед після нього — знову крок, і
      // рахується від дати відкату, бо саме звідти почалось нове очікування.
      const pair = SPEED_STEPS.find(([f, t]) => f === from.stage && t === to.stage);
      if (!pair) continue;
      const d = dayDiff(from.ts, to.ts);
      if (d >= 0) durations.get(to.stage).push(d);
    }
  }

  const steps = SPEED_STEPS.map(([from, to]) => {
    const xs = durations.get(to).sort((a, b) => a - b);
    return {
      from,
      to,
      n: xs.length,
      // Гейт на медіану, не на сам крок: показати «1 перехід» чесно, а от
      // «медіана по одному спостереженню» — це вже вигляд статистики без неї.
      medianDays: xs.length >= SPEED_MIN_N ? median(xs) : null,
    };
  });

  const stale = [];
  for (const [url, stage] of Object.entries(funnel ?? {})) {
    if (!ACTIVE_STAGES.includes(stage)) continue;
    const m = meta[url];
    const hist = Array.isArray(m?.history) ? m.history : [];
    // Дата ОСТАННЬОГО руху, а не входу у воронку: вакансія може лежати в ній
    // пів року, але якщо стадію змінили вчора — це рух, а не застій. Легасі-
    // записи журналу не мають, для них лишається дата входу.
    const last =
      hist.length && isDateKey(hist[hist.length - 1]?.ts) ? hist[hist.length - 1].ts : m?.ts;
    if (!isDateKey(last)) continue;
    const days = dayDiff(last, todayKey);
    if (days >= STALE_AFTER_DAYS) {
      stale.push({ url, stage, title: m?.title || '', days });
    }
  }
  stale.sort((a, b) => b.days - a.days);

  return { steps, stale, staleAfterDays: STALE_AFTER_DAYS };
}

/** Скільки тижнів у тренді легкості. */
const EASE_TREND_WEEKS = 8;

/** Вікно «як дається зараз» у розрізі тем. */
const MOCK_RECENT_DAYS = 60;

/**
 * Запис оцінки в обох формах -> {r, at, topic}.
 *
 * Легасі — голий рядок 'easy'|'hard' без часу й теми. Він і далі рахується там,
 * де для цього досить самої оцінки, і мовчки випадає там, де потрібен час: це
 * чесніше за здогадку про дату, яка вигадала б хронологію.
 */
function readRating(v) {
  if (v === 'easy' || v === 'hard') return { r: v, at: null, topic: null };
  if (!v || typeof v !== 'object') return null;
  const r = v.r === 'easy' || v.r === 'hard' ? v.r : null;
  if (!r) return null;
  return {
    r,
    at: isDateKey(v.at) ? v.at : null,
    topic: typeof v.topic === 'string' ? v.topic : null,
  };
}

/** Частка «легко» по тижнях — той самий {week,...}-шейп, що інші тижневі ряди. */
function buildEaseTrend(mockRated, todayKey, weeks = EASE_TREND_WEEKS) {
  const starts = lastWeekStarts(todayKey, weeks);
  const buckets = Object.fromEntries(starts.map((k) => [k, { easy: 0, n: 0 }]));
  for (const raw of Object.values(mockRated ?? {})) {
    const rec = readRating(raw);
    if (!rec || !rec.at) continue;
    const wk = weekStartKey(rec.at);
    const b = buckets[wk];
    if (!b) continue;
    b.n++;
    if (rec.r === 'easy') b.easy++;
  }
  return starts.map((week) => {
    const b = buckets[week];
    // n=0 -> null, а не 0: «тиждень без питань» і «тиждень, де все було
    // складно» — протилежні відповіді, і нуль злив би їх в одну.
    return { week, n: b.n, easePct: b.n ? Math.round((b.easy / b.n) * 100) : null };
  });
}

/** {тема: {seen, weak}} за останні MOCK_RECENT_DAYS — на противагу all-time. */
function buildRecentByTopic(mockRated, todayKey, days = MOCK_RECENT_DAYS) {
  const from = addDays(todayKey, -(days - 1));
  const out = {};
  for (const raw of Object.values(mockRated ?? {})) {
    const rec = readRating(raw);
    if (!rec || !rec.at || !rec.topic || rec.at < from) continue;
    if (!isSafeKey(rec.topic)) continue;
    if (!out[rec.topic]) out[rec.topic] = { seen: 0, weak: 0 };
    out[rec.topic].seen++;
    if (rec.r === 'hard') out[rec.topic].weak++;
  }
  return out;
}

/** Персентиль за лінійною інтерполяцією (той самий метод, що median вище). */
function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo));
}

/**
 * Ритм відкриття: РОЗПОДІЛ хвилин після 08:00 до першого заходу, не лише
 * медіана. Доти з усього масиву opensMin назовні йшло одне число
 * (timeToOpenMin), тобто розкид — власне те, що відрізняє звичку від
 * випадковості — викидався. «О 8:20 ± 15 хв» і «о 8:20 ± 3 год» — це
 * протилежні історії з однаковою медіаною.
 *
 * Вуса — p10/p90, а не min/max: одна ніч, коли відкрив о 23:00, розтягнула б
 * шкалу так, що коробка стала б невидимою смужкою.
 */
/** Мінімум записів на половину, щоб порівнювати «раніше» з «тепер». */
const RHYTHM_HALF_MIN = 8;

function buildOpenRhythm(opensMin, days = STATS_WINDOWS.rhythmOpens) {
  // slice ДО фільтра: вікно рахується в записах журналу, а не у валідних
  // значеннях — інакше пачка битих записів мовчки розтягнула б період.
  const win = opensMin.slice(-days).filter((v) => typeof v === 'number' && v >= 0);
  const xs = [...win].sort((a, b) => a - b);
  if (xs.length < 5) return { ready: false, n: xs.length, needed: 5 };
  const q1 = percentile(xs, 0.25);
  const q3 = percentile(xs, 0.75);
  return {
    ready: true,
    n: xs.length,
    p10: percentile(xs, 0.1),
    q1,
    median: percentile(xs, 0.5),
    q3,
    p90: percentile(xs, 0.9),
    // Розкид середньої половини діб — і є «наскільки це ритуал».
    iqr: q3 - q1,
    // ⚠️ ДРЕЙФ — відповідь на питання, заради якого блок існує: «наскільки це
    // ВЖЕ ритуал». Сама коробка описує вікно цілком, тобто каже, як було
    // загалом, — але не каже, чи звичка ЗАТИСКАЄТЬСЯ. Тому вікно ділиться
    // навпіл по ПОРЯДКУ ЗАПИСІВ (win, не відсортований xs) і кожна половина
    // отримує свої медіану й розкид.
    //
    // Гейт на кожну половину окремо: 8 записів — та сама межа, що в решті
    // порівнянь чек-іну. Нижче — null, а не «розкид не змінився»: відсутність
    // порівняння й висновок «стабільно» тут найлегше сплутати.
    drift: driftHalves(win),
  };
}

/** Медіана й розкид у першій та другій половині вікна (за порядком записів). */
function driftHalves(win) {
  const half = Math.floor(win.length / 2);
  if (half < RHYTHM_HALF_MIN) return null;
  const box = (arr) => {
    const s = [...arr].sort((a, b) => a - b);
    const a = percentile(s, 0.25);
    const b = percentile(s, 0.75);
    return { n: s.length, median: percentile(s, 0.5), iqr: b - a };
  };
  return { early: box(win.slice(0, half)), late: box(win.slice(-half)) };
}

/**
 * Звички по тижнях: скільки діб тижня були активними + СКЛАД активності.
 * Теплокарта показує щоденну щільність, але не відповідає на «чи я тримаюсь
 * краще, ніж місяць тому» — для цього потрібен тренд, а не сітка.
 */
function buildHabitWeekly(days, todayKey) {
  const starts = lastWeekStarts(todayKey, weeksSinceFirst(days, todayKey));
  const buckets = Object.fromEntries(
    starts.map((k) => [k, { active: 0, days: 0, opens: 0, mock: 0, news: 0 }]),
  );
  const today = new Date(todayKey + 'T00:00:00Z');
  const first = new Date(starts[0] + 'T00:00:00Z');
  for (const d = new Date(first); d <= today; d.setUTCDate(d.getUTCDate() + 1)) {
    const k = dayKey(d);
    const b = buckets[weekStartKey(k)];
    if (!b) continue;
    // Знаменник — лише доби, що вже НАСТАЛИ: інакше поточний тиждень завжди
    // виглядав би провальним (7 у знаменнику, коли минуло 2 дні).
    b.days++;
    const day = days[k];
    b.opens += day?.opens || 0;
    b.mock += day?.mock || 0;
    b.news += day?.news || 0;
    if ((day?.opens || 0) > 0) b.active++;
  }
  return starts.map((week) => ({
    week,
    active: buckets[week].active,
    days: buckets[week].days,
    opens: buckets[week].opens,
    mock: buckets[week].mock,
    news: buckets[week].news,
  }));
}

/**
 * Вогники (стріки в СТОРОННІХ застосунках, evening.flames): рейтинг частоти +
 * тижнева композиція конструктивні/споживчі + стрік ПОВНОЇ рутини. Свідомо в
 * Звичках, не в Чек-іні: це сигнал «чи тримаю звичку в іншому застосунку»,
 * той самий тип питання, що opens/mock/news у habitWeekly вище — не про
 * добробут дня, тож у реєстрі «Індексу дня» (checkin-model.mjs) цього поля й
 * не може бути.
 *
 * Той самий патерн ітерації, що buildHabitWeekly: знаменник тижня — лише доби,
 * що вже НАСТАЛИ (інакше поточний тиждень завжди виглядав би провальним).
 *
 * ⚠️ Ідея за полем — «пам'ятати заходити у ВСІ застосунки» (власник), не
 * «скільки разів обирав який». Стара «частота вибору» тривіальна: коли
 * flames взагалі відповідають, це майже завжди всі 5 разом (all-or-nothing),
 * тож рейтинг вибору завжди рівний і нічого не каже. Замість цього:
 *   - completeDays: день "повний", коли зафіксовано ВСІ FLAME_VALUES.
 *     Відсутність відповіді того дня теж НЕ повна (той самий дух, що
 *     streak механіки в Duolingo/Snapchat — пропуск ламає стрік, байдуже
 *     чому) — тому map будується для КОЖНОЇ доби вікна, не лише
 *     відповіджених.
 *   - streak/best — той самий generic streak()/bestStreak(), що вже рахує
 *     reliability/openDays, лише інший предикат.
 *   - missedTops — дзеркало tops, але лічильник НЕВІДМІЧЕНОГО за день:
 *     «що частіше пропускаю», дієвіший сигнал за «що частіше обирав».
 */
function buildFlameStats(checkins, todayKey) {
  const starts = lastWeekStarts(todayKey, weeksSinceFirst(checkins, todayKey));
  // ⚠️ active і full — ДВА РІЗНІ ПРЕДИКАТИ, і саме їх мовчазне сусідство робило
  // блок незрозумілим: графік малював «хоч один вогник за вечір», а стрік поруч
  // вимагав УСІ ПʼЯТЬ. Тобто графік показував «майже завжди повно», а стрік —
  // нуль, і обидва були праві. Тепер full їде в payload, і перемикач на екрані
  // показує обидва явно, замість того щоб один із них лишався невидимим.
  const buckets = Object.fromEntries(
    starts.map((k) => [k, { active: 0, full: 0, days: 0, constructive: 0, consumptive: 0 }]),
  );
  const counts = {};
  const missed = {};
  const completeDays = {};
  let activeNights = 0;
  const today = new Date(todayKey + 'T00:00:00Z');
  const first = new Date(starts[0] + 'T00:00:00Z');
  for (const d = new Date(first); d <= today; d.setUTCDate(d.getUTCDate() + 1)) {
    const k = dayKey(d);
    const flames = asList(checkins[k]?.evening?.flames).filter((f) => FLAME_VALUES.includes(f));
    completeDays[k] = { complete: flames.length === FLAME_VALUES.length };
    // missed рахуємо ЛИШЕ на добах, де вечірній чек-ін реально торкались —
    // інакше кожна порожня доба 12-тижневого вікна (нема чек-іну взагалі)
    // додала б +1 УСІМ пʼятьом застосункам однаково, і рейтинг завжди
    // виглядав би майже рівним (шум порожньої історії забиває сигнал).
    if (checkins[k]?.evening !== undefined) {
      for (const f of FLAME_VALUES) if (!flames.includes(f)) missed[f] = (missed[f] || 0) + 1;
    }
    const b = buckets[weekStartKey(k)];
    if (!b) continue;
    b.days++;
    if (flames.length) {
      b.active++;
      activeNights++;
    }
    if (flames.length === FLAME_VALUES.length) b.full++;
    for (const f of flames) {
      counts[f] = (counts[f] || 0) + 1;
      if (CONSTRUCTIVE_FLAMES.has(f)) b.constructive++;
      else b.consumptive++;
    }
  }
  return {
    tops: rankCounts(counts),
    missedTops: rankCounts(missed),
    activeNights,
    streak: streak(completeDays, todayKey, (d) => d?.complete === true),
    best: bestStreak(completeDays, (d) => d?.complete === true),
    weekly: starts.map((week) => ({ week, ...buckets[week] })),
  };
}

/** Понеділки останніх `n` тижнів (старіші→новіші), включно з поточним. */
export function lastWeekStarts(todayKey, n) {
  const d = new Date(weekStartKey(todayKey) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 7 * (n - 1));
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(dayKey(d));
    d.setUTCDate(d.getUTCDate() + 7);
  }
  return out;
}

/** Понеділок тижня НАЙДАВНІШОГО ключа "YYYY-MM-DD" в obj, або null коли порожньо. */
function earliestWeekStart(dateKeyedObj) {
  // Мінімум одним проходом замість filter+sort: ISO-ключі лексикографічно
  // впорядковані так само, як хронологічно, тож сортувати весь рік заради
  // першого елемента — зайва робота. ⚠️ На заміру це НЕ дало помітного
  // виграшу (сортування 365 рядків тут не вузьке місце) — лишено як простіший
  // код, а не як оптимізація.
  let min = null;
  for (const k of Object.keys(dateKeyedObj)) {
    if (isDateKey(k) && (min === null || k < min)) min = k;
  }
  return min === null ? null : weekStartKey(min);
}

/**
 * Скільки тижнів минуло від тижня першого запису в obj до todayKey (мінімум
 * 1). Порожній obj -> 1 (нема з чого рахувати; порожній результат однаково не
 * рендериться — усі споживачі гейтяться на length>=2/якийсь v>0 далі по стеку).
 *
 * ⚠️ Фідбек власника (2 ітерації): спершу вікно росло від першого запису, але
 * лишалось капнуте на старий максимум (12/26 тижнів) — власник явно попросив
 * прибрати й цю стелю: «Відмова від 12 тижнів, тепер показуємо дані з моменту
 * початку їх отримання» — БЕЗ верхньої межі, а не «до 12». Раніше фіксовані
 * вікна (12/26 тижнів) завжди рахувались НАЗАД від today, тож перші місяці
 * після запуску Світанку вікно захоплювало тижні ДО того, як застосунок
 * узагалі існував — порожні тижні тягнули середні показники вниз і псували
 * графіки (heatmap/«найактивніший день»/утримання/тренд інтересу).
 */
function weeksSinceFirst(dateKeyedObj, todayKey) {
  const first = earliestWeekStart(dateKeyedObj);
  if (!first) return 1;
  return Math.floor(dayDiff(first, weekStartKey(todayKey)) / 7) + 1;
}

/* ── Агрегація чек-іну ─────────────────────────────────────────────────────
   ⚠️ ГОЛОВНИЙ РИЗИК ЦІЄЇ ФІЧІ — вона вміє впевнено брехати. «У дні, коли ти спав
   менше 6 годин, подач удвічі менше» звучить як висновок, а на третьому тижні це
   три точки проти чотирьох — шум у краватці. І така брехня ВИГЛЯДАЄ як аналітика,
   тобто підштовхує до рішень.

   Тому кореляції гейтяться: жодного порівняння, поки в КОЖНОМУ кошику менше
   CORR_MIN_N днів. Доти віддаємо лише сирі ряди, які нічого не стверджують.
   Це коштує ~2 місяці мовчання на старті — чесна ціна. */

const CORR_MIN_N = 8;

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round1 = (v) => (v === null ? null : Math.round(v * 10) / 10);
const round2 = (v) => (v === null ? null : Math.round(v * 100) / 100);
const round4 = (v) => (v === null ? null : Math.round(v * 10000) / 10000);

/** Ряд «сон / енергія / оцінка дня» за останні N діб (лише заповнені). */
function buildCheckinSeries(checkins, todayKey, days = STATS_WINDOWS.checkinRecent) {
  const out = [];
  const d = new Date(todayKey + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - (days - 1));
  for (let i = 0; i < days; i++) {
    const key = dayKey(d);
    const c = checkins[key];
    if (c) {
      // Енергія — до трьох точок за добу; це і є крива, а не крапка.
      const en = CHECKIN_SLOTS.map((sl) => c[sl]?.energy).filter((v) => typeof v === 'number');
      out.push({
        d: key,
        // sleepHoursOf, а не сире поле: у добу без сну того поля немає, і
        // крива мовчки пропускала б найінформативнішу ніч замість нуля.
        sleepH: sleepHoursOf(c.morning),
        energy: round1(avg(en)),
        // Сама КРИВА, не лише її середнє: три дні із середнім 3.0 можуть бути
        // «рівний день», «згорів надвечір» і «розігнався надвечір» — за avg
        // вони нерозрізненні, і саме ця форма губилась досі.
        energyCurve: CHECKIN_SLOTS.map((sl) =>
          typeof c[sl]?.energy === 'number' ? c[sl].energy : null,
        ),
        moodCurve: CHECKIN_SLOTS.map((sl) => (typeof c[sl]?.mood === 'number' ? c[sl].mood : null)),
        dayScore: typeof c.evening?.dayScore === 'number' ? c.evening.dayScore : null,
        slots: CHECKIN_SLOTS.filter((sl) => c[sl] && Object.keys(c[sl]).length).length,
      });
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/**
 * Дрейф наміру: що планував уранці (`plan`) проти того, що реально зʼїло день
 * (`ate`). Обидва поля збирались роками й НІКОЛИ не порівнювались — `plan`
 * узагалі використовувався лише як гейт «робочий день». Тут нічого нового не
 * питаємо, лише читаємо вже наявне.
 *
 * `matched` — доба, де хоч одна запланована категорія опинилась серед тих, що
 * зайняли час (з мультивибором «влучив бодай у щось» — чесніший критерій за
 * сувору рівність).
 */
/** Пара «планував X -> зʼїло Y» мусить трапитись двічі, щоб щось означати. */
const DRIFT_PAIR_MIN_N = 2;

function buildIntentDrift(checkins, todayKey, days = STATS_WINDOWS.checkinRecent) {
  const pairs = {};
  let full = 0;
  let partial = 0;
  let doneSum = 0;
  let total = 0;
  const d = new Date(todayKey + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - (days - 1));
  for (let i = 0; i < days; i++) {
    const c = checkins[dayKey(d)];
    d.setUTCDate(d.getUTCDate() + 1);
    const plan = asList(c?.morning?.plan).filter((x) => CATEGORY_VALUES.includes(x));
    const ate = asList(c?.afternoon?.ate).filter((x) => CATEGORY_VALUES.includes(x));
    if (!plan.length || !ate.length) continue;
    total++;
    const kept = plan.filter((p) => ate.includes(p));
    doneSum += kept.length / plan.length;
    if (kept.length === plan.length) {
      full++;
      continue;
    }
    if (kept.length) partial++;
    // ⚠️ Пари будуються з НЕВИКОНАНОГО плану проти НЕЗАПЛАНОВАНОГО факту, і
    // тепер із ЧАСТКОВИХ діб теж. Доти доба з частковим збігом уся йшла в
    // «matched» і зникала — а саме в ній і видно дрейф: одне планове сталось,
    // друге підмінилось. Збіги в пари не йдуть: вони нічого не пояснюють.
    const missed = plan.filter((p) => !ate.includes(p));
    const extra = ate.filter((a) => !plan.includes(a));
    for (const p of missed) {
      for (const a of extra) {
        const key = `${p}>${a}`;
        pairs[key] = (pairs[key] || 0) + 1;
      }
    }
  }
  const top = Object.entries(pairs)
    .map(([k, n]) => ({ from: k.split('>')[0], to: k.split('>')[1], n }))
    .filter((r) => r.n >= DRIFT_PAIR_MIN_N)
    .sort((a, b) => b.n - a.n)
    .slice(0, 5);
  return {
    days,
    total,
    full,
    partial,
    // ⚠️ pct — СЕРЕДНЯ ЧАСТКА виконаного плану, не «частка діб за планом».
    // Доти доба зараховувалась цілком, якщо збігся бодай один пункт із двох,
    // тож число росло від самої звички планувати ширше. Тепер два планові
    // пункти й один виконаний дають 50%, а не 100%.
    pct: total ? Math.round((doneSum / total) * 100) : null,
    top,
  };
}

/**
 * Калібрування очікувань: ранкове «яким очікую день» проти вечірньої оцінки.
 *
 * ⚠️ ЄДИНИЙ СПОЖИВАЧ dayExpect — і це навмисно. Поле не входить у жоден індекс
 * моделі: воно описує не добу, а ПРОГНОЗ про неї, і змішати їх означало б
 * зробити «Індекс дня» частково передбаченням самого себе.
 *
 * Що з цього видно, чого не видно більше нізвідки: систематичний зсув. Якщо
 * bias стабільно відʼємний — ти недооцінюєш свої дні, і це окрема інформація
 * від того, які вони насправді.
 *
 * Гейт CORR_MIN_N: на пʼятьох добах «ти песиміст» — це монетка.
 */
function buildExpectCalibration(checkins, todayKey, days = STATS_WINDOWS.checkinRecent) {
  const pairs = [];
  const d = new Date(todayKey + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - (days - 1));
  for (let i = 0; i < days; i++) {
    const c = checkins[dayKey(d)];
    d.setUTCDate(d.getUTCDate() + 1);
    const exp = c?.morning?.dayExpect;
    const act = c?.evening?.dayScore;
    if (typeof exp !== 'number' || typeof act !== 'number') continue;
    pairs.push({ exp, act });
  }
  const n = pairs.length;
  if (n < CORR_MIN_N) return { days, n, needed: CORR_MIN_N, ready: false };
  const diffs = pairs.map((p) => p.act - p.exp);
  // Три кошики, а не лише середнє: bias=0 буває і коли щодня точно, і коли
  // половина днів гірша, половина краща. Це різні люди.
  return {
    days,
    n,
    ready: true,
    avgExpect: round1(avg(pairs.map((p) => p.exp))),
    avgActual: round1(avg(pairs.map((p) => p.act))),
    bias: round1(avg(diffs)),
    better: diffs.filter((x) => x > 0).length,
    same: diffs.filter((x) => x === 0).length,
    worse: diffs.filter((x) => x < 0).length,
  };
}

/** Рівні наміру й факту руху на одній ординальній шкалі. */
const MOVE_RANK = { none: 0, light: 1, active: 2, workout: 3 };

/**
 * Намір руху (ранок) проти факту (вечір).
 *
 * ⚠️ ДВА РІЗНІ ПИТАННЯ, а не одне. «Скільки разів намір збувся» і «скільки
 * разів рух стався без наміру» — різні речі: перше про виконання, друге про
 * те, що рух буває й непланованим. Зводити їх в один відсоток означало б
 * втратити половину картини.
 *
 * Намір вважається виконаним, коли ФАКТ не нижчий за план: запланував легкий
 * рух, а вийшло тренування — це виконано, а не «мимо».
 */
function buildMoveIntent(checkins, todayKey, days = STATS_WINDOWS.checkinRecent) {
  let planned = 0;
  let keptPlan = 0;
  let noPlanButMoved = 0;
  let noPlanDays = 0;
  const d = new Date(todayKey + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - (days - 1));
  for (let i = 0; i < days; i++) {
    const c = checkins[dayKey(d)];
    d.setUTCDate(d.getUTCDate() + 1);
    const plan = c?.morning?.movePlan;
    const fact = c?.evening?.moved;
    if (plan === undefined || fact === undefined) continue;
    const pr = MOVE_RANK[plan];
    const fr = MOVE_RANK[fact];
    if (pr === undefined || fr === undefined) continue;
    if (pr > 0) {
      planned++;
      if (fr >= pr) keptPlan++;
    } else {
      noPlanDays++;
      if (fr > 0) noPlanButMoved++;
    }
  }
  const total = planned + noPlanDays;
  if (total < MOVE_MIN_N) return { days, n: total, needed: MOVE_MIN_N, ready: false };
  return {
    days,
    n: total,
    ready: true,
    planned,
    kept: keptPlan,
    // Порожній знаменник -> null, а не 0%: «нуль із нуля» і «нуль із десяти» —
    // різні твердження, і плутати їх ми вже перестали в конверсіях воронки.
    keptPct: planned > 0 ? Math.round((keptPlan / planned) * 100) : null,
    noPlanDays,
    noPlanButMoved,
  };
}

/** Нижче — і «намір збувається в 100%» стоїть на одній добі. */
const MOVE_MIN_N = 5;

/**
 * Явка по блоках за останні N діб. Самі пропуски — теж сигнал: ранок заповнений
 * 25 разів, а вечір 4 — це вже висновок, і чесніший за будь-яку кореляцію.
 */
function buildCheckinFill(checkins, todayKey, days = STATS_WINDOWS.checkinRecent) {
  const fill = { morning: 0, afternoon: 0, evening: 0 };
  const d = new Date(todayKey + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - (days - 1));
  for (let i = 0; i < days; i++) {
    const c = checkins[dayKey(d)];
    if (c) for (const sl of CHECKIN_SLOTS) if (isCheckinSlotFilled(c, sl)) fill[sl]++;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return { ...fill, days };
}

/**
 * Намір проти факту: скільки подач планував уранці — і скільки їх реально було
 * (за appliedLog, а не за словами). Єдина відповідь, яку застосунок ПЕРЕВІРЯЄ.
 */
function buildPlanVsFact(checkins, appliedLog, todayKey, days = STATS_WINDOWS.checkinRecent) {
  const byDay = {};
  for (const a of appliedLog) if (isDateKey(a?.ts)) byDay[a.ts] = (byDay[a.ts] || 0) + 1;

  const rows = [];
  const d = new Date(todayKey + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - (days - 1));
  for (let i = 0; i < days; i++) {
    const key = dayKey(d);
    const m = checkins[key]?.morning;
    // Лише РОБОЧІ дні (plan='work'): у v2 planApply опційне й показується тільки
    // там. Без гейта на plan осиротіле число (обрав «Робота», ввів, перемкнув на
    // «Навчання») пролазило б у джоб-рядок на не-робочому дні.
    if (asList(m?.plan).includes('work') && typeof m.planApply === 'number') {
      rows.push({ d: key, planned: m.planApply, actual: byDay[key] || 0 });
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return rows;
}

/**
 * Сон проти ОЦІНКИ ДНЯ — ДВА кошики (мало спав <6.5 / виспався), і лише якщо в
 * кожному CORR_MIN_N днів. Загальний звʼязок «як ніч впливає на день» — без
 * привʼязки до пошуку роботи (v2). Інакше null: краще нічого, ніж вигадка.
 */
function buildSleepVsDayScore(checkins, todayKey, days = STATS_WINDOWS.checkinMid) {
  const low = [];
  const ok = [];
  const d = new Date(todayKey + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - (days - 1));
  for (let i = 0; i < days; i++) {
    const c = checkins[dayKey(d)];
    // ⚠️ Через sleepHoursOf: доти безсонні ночі ВИПАДАЛИ з порівняння, тобто
    // «мало сну проти нормального» рахувалось без найгіршого кошика.
    const sleep = sleepHoursOf(c?.morning);
    const score = c?.evening?.dayScore;
    if (typeof sleep === 'number' && typeof score === 'number') {
      (sleep < 6.5 ? low : ok).push(score);
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  if (low.length < CORR_MIN_N || ok.length < CORR_MIN_N) {
    return { ready: false, needed: CORR_MIN_N, low: low.length, ok: ok.length };
  }
  return {
    ready: true,
    needed: CORR_MIN_N,
    low: low.length,
    ok: ok.length,
    lowAvg: round1(avg(low)),
    okAvg: round1(avg(ok)),
  };
}

/** Скільки днів має набратись у КАТЕГОРІЇ, щоб показати її середню оцінку дня. */
const CATEGORY_SCORE_MIN = 4;

/**
 * Куди йде час (v2): розподіл ДЕННОЇ категорії `afternoon.ate` за N діб + середня
 * оцінка дня на категорію. Розподіл (лічильник) чесний за будь-якого N; середню
 * оцінку показуємо лише для категорій із >=CATEGORY_SCORE_MIN оцінених днів
 * (інакше null — та сама дисципліна «не брехати на дрібній вибірці»).
 */
function buildCategoryInsight(checkins, todayKey, days = STATS_WINDOWS.checkinRecent) {
  const buckets = {};
  const d = new Date(todayKey + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - (days - 1));
  for (let i = 0; i < days; i++) {
    const c = checkins[dayKey(d)];
    // Лише ВІДОМІ категорії: старі значення до v2 (apply/interview/procrast) не
    // мусять пролазити сирим слагом у «куди йде час» і спотворювати відсотки.
    // asList: поле стало мультивибором, але легасі-доби тримають рядок.
    for (const cat of asList(c?.afternoon?.ate)) {
      if (!CATEGORY_VALUES.includes(cat)) continue;
      const b = buckets[cat] || (buckets[cat] = { n: 0, scores: [] });
      b.n++;
      const score = c?.evening?.dayScore;
      if (typeof score === 'number') b.scores.push(score);
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  const rows = Object.entries(buckets)
    .map(([cat, b]) => ({
      cat,
      n: b.n,
      dayScore: b.scores.length >= CATEGORY_SCORE_MIN ? round1(avg(b.scores)) : null,
    }))
    .sort((a, b) => b.n - a.n);
  const total = rows.reduce((s, r) => s + r.n, 0);
  return { days, total, rows };
}

/**
 * Час відходу до сну проти РАНКОВОЇ енергії (обидва — поля ранку, тож join за
 * тією ж добою). Рано (до 00:00) vs пізно (після 01:00); межу 00–01 не рахуємо.
 * Гейт CORR_MIN_N — та сама дисципліна «не брехати на малій вибірці».
 */
function buildBedtimeVsEnergy(checkins, todayKey, days = STATS_WINDOWS.checkinMid) {
  // Середину 00–01 (e01) НЕ рахуємо в жодному кошику: краї мають контрастувати,
  // а не змазуватись (та сама логіка, що виключення нейтральної середини всюди).
  const EARLY = new Set(['e23', 'e00']);
  const LATE = new Set(['e02', 'late']);
  const early = [];
  const late = [];
  const d = new Date(todayKey + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - (days - 1));
  for (let i = 0; i < days; i++) {
    const m = checkins[dayKey(d)]?.morning;
    if (m && typeof m.energy === 'number' && typeof m.bedtime === 'string') {
      if (EARLY.has(m.bedtime)) early.push(m.energy);
      else if (LATE.has(m.bedtime)) late.push(m.energy);
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  if (early.length < CORR_MIN_N || late.length < CORR_MIN_N) {
    return { ready: false, needed: CORR_MIN_N, early: early.length, late: late.length };
  }
  return {
    ready: true,
    needed: CORR_MIN_N,
    early: early.length,
    late: late.length,
    earlyAvg: round1(avg(early)),
    lateAvg: round1(avg(late)),
  };
}

/**
 * Соціальний контекст дня (afternoon.withWhom): розподіл ЧАСТОТИ (той самий
 * рейтинговий підхід, що blocker/helper/lateReason) + СПРАВЖНЄ порівняння
 * «сам» проти «з людьми» на вечірній оцінці дня.
 *
 * На відміну від buildSleepVsDayScore/buildBedtimeVsEnergy (голі середні двох
 * кошиків) тут — Cohen's d + Welch p, той самий апарат, що вже рахує
 * computeDrivers у checkin-model.mjs (golden-тестований). withWhom не
 * скалярне поле, тож у реєстрі моделі його бути не може за побудовою — але
 * рівень строгості порівняння лишається той самий, а не слабший.
 *
 * Шестистороннього розподілу занадто мало для тесту в кожному кошику
 * (family/friends/work/public/mixed рідко назбирають CORR_MIN_N кожен) —
 * тому порівняння БІНАРНЕ: «сам» проти «решта разом», найконтрастніша й
 * найреалістичніша межа, яка взагалі має шанс набрати вибірку.
 */
function buildSocialContext(checkins, todayKey, days = STATS_WINDOWS.checkinMid) {
  const counts = {};
  const aloneScores = [];
  const otherScores = [];
  let filled = 0;
  const d = new Date(todayKey + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - (days - 1));
  for (let i = 0; i < days; i++) {
    const c = checkins[dayKey(d)];
    const who = c?.afternoon?.withWhom;
    if (typeof who === 'string' && who) {
      filled++;
      counts[who] = (counts[who] || 0) + 1;
      const score = c?.evening?.dayScore;
      if (typeof score === 'number') (who === 'alone' ? aloneScores : otherScores).push(score);
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  const ready = aloneScores.length >= CORR_MIN_N && otherScores.length >= CORR_MIN_N;
  return {
    tops: rankCounts(counts),
    days,
    filled,
    aloneVsOthers: ready
      ? {
          ready: true,
          nAlone: aloneScores.length,
          nOthers: otherScores.length,
          aloneAvg: round1(avg(aloneScores)),
          othersAvg: round1(avg(otherScores)),
          d: round2(cohensD(aloneScores, otherScores)),
          p: round4(welchP(aloneScores, otherScores)),
        }
      : {
          ready: false,
          needed: CORR_MIN_N,
          nAlone: aloneScores.length,
          nOthers: otherScores.length,
        },
  };
}

/**
 * Калібрація: вечірній САМОЗВІТ подач проти appliedLog (факту). Не кореляція, а
 * звірка per-day, тож без гейта — показуємо як planVsFact, коли є хоч день.
 *  more  = сказав більше, ніж у журналі  -> подавав ПОЗА застосунком (не залогував)
 *  fewer = сказав менше -> залогував зайве / плутанина з добою
 */
function buildAppliedCalibration(
  checkins,
  appliedLog,
  todayKey,
  days = STATS_WINDOWS.checkinRecent,
) {
  const byDay = {};
  for (const a of appliedLog) if (isDateKey(a?.ts)) byDay[a.ts] = (byDay[a.ts] || 0) + 1;

  let n = 0;
  let matched = 0;
  let more = 0;
  let fewer = 0;
  const d = new Date(todayKey + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - (days - 1));
  for (let i = 0; i < days; i++) {
    const key = dayKey(d);
    const c = checkins[key];
    const self = c?.evening?.applied;
    // Лише робочі дні (plan='work'): осиротіле «скільки вийшло» на не-робочому
    // дні не мусить потрапляти в джоб-калібрацію.
    if (asList(c?.morning?.plan).includes('work') && typeof self === 'number') {
      n++;
      const obj = byDay[key] || 0;
      if (self === obj) matched++;
      else if (self > obj) more++;
      else fewer++;
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return { n, matched, more, fewer };
}

/** Скільки варіантів блокерів/помічників віддаємо в рейтингу (решта — хвіст). */
const TOPS_RANK_LIMIT = 5;

/** Обʼєкт лічильників {value: n} -> рейтинг спадання (нічия — за абеткою), TOP N. */
function rankCounts(counts, limit = TOPS_RANK_LIMIT) {
  return Object.entries(counts)
    .map(([value, n]) => ({ value, n }))
    .sort((a, b) => b.n - a.n || a.value.localeCompare(b.value))
    .slice(0, limit);
}

/**
 * Блокери / помічники за N діб — ПОВНИЙ рейтинг, не лише мода. Не кореляція,
 * а розподіл, тож без статистичного гейта (лише порожньо -> null/[]).
 *
 * Ці два поля — мультивибір, і саме тому їх НЕМАЄ в реєстрі «Індексу дня»
 * (checkin-model.mjs FIELDS оперує скалярними/порядковими полями). Тобто це
 * єдина картка, яка їх узагалі показує — дублювання з моделлю тут неможливе
 * за побудовою.
 *
 * `blocker`/`helper` (мода) лишаються для сумісності контракту; `blockers`/
 * `helpers` — новий рейтинг, `days` — скільки діб мали вечірній запис
 * (знаменник, без якого «6×» не має масштабу).
 *
 * lateReason (ранкове, УМОВНЕ поле — питається лише коли лягав пізно) —
 * той самий рейтинговий підхід, приєднаний в ОДНОМУ проході з blocker/helper:
 * причина пізнього відбою теж ніде, крім тут, не показується (вільна від
 * реєстру моделі за тією ж логікою — це причина-тег, а не скалярне поле).
 */
function buildCheckinTops(checkins, todayKey, days = STATS_WINDOWS.checkinRecent) {
  const bC = {};
  const hC = {};
  const lC = {};
  let filled = 0;
  let lateNights = 0;
  const d = new Date(todayKey + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - (days - 1));
  for (let i = 0; i < days; i++) {
    const rec = checkins[dayKey(d)];
    const ev = rec?.evening;
    if (ev) {
      // asList: обидва стали мультивибором; 'none' — свідома відповідь «нічого
      // не завадило», а не варіант для топу, тож не рахуємо її як причину.
      const bs = asList(ev.blocker);
      const hs = asList(ev.helper);
      if (bs.length || hs.length) filled++;
      for (const b of bs) if (b !== 'none') bC[b] = (bC[b] || 0) + 1;
      for (const h of hs) if (h !== 'none') hC[h] = (hC[h] || 0) + 1;
    }
    const reason = rec?.morning?.lateReason;
    if (typeof reason === 'string' && reason) {
      lateNights++;
      lC[reason] = (lC[reason] || 0) + 1;
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  const blockers = rankCounts(bC);
  const helpers = rankCounts(hC);
  return {
    blocker: blockers[0] ?? null,
    helper: helpers[0] ?? null,
    blockers,
    helpers,
    // ⚠️ ЩО ЖОДНОГО РАЗУ НЕ ОБИРАЛОСЬ — і чому це окреме поле, а не «те, чого
    // немає в blockers». Питання «які варіанти зайві» доти можна було вирішити
    // лише здогадкою, а здогадка тут дорога: викинути варіант, який справді
    // трапляється раз на місяць, означає назавжди втратити рідкісну причину.
    // Тепер відповідь дають ДАНІ — і рішення про прибирання ухвалюється, коли
    // варіант простояв порожнім усе вікно, а не коли він видався зайвим.
    //
    // 'none' виключена: це свідома відповідь «нічого не завадило», і в топ вона
    // не рахується (вище), тож у «невикористаних» виглядала б як хибний докір.
    unusedBlockers: BLOCKER_VALUES.filter((v) => v !== 'none' && !bC[v]),
    unusedHelpers: HELPER_VALUES.filter((v) => v !== 'none' && !hC[v]),
    days,
    filled,
    lateReasons: rankCounts(lC),
    lateNights,
  };
}

/**
 * Як минали ночі: скільки було зіпсованих і ЧОМУ.
 *
 * ⚠️ БЕЗ ЦЬОГО НОВЕ ПИТАННЯ БУЛО Б НАПІВПОРОЖНІМ. Режим ночі живив «Індекс
 * дня» — тобто безсонна ніч впливала на число, але ніде не була НАЗВАНА. А це
 * та подія, яку треба бачити прямо: «дві ночі за місяць ти не спав узагалі» —
 * факт, з яким можна щось зробити, на відміну від «Відновлення 34%».
 *
 * Причина при цьому важливіша за сам факт: «чекав ранку через комендантську»,
 * «допрацьовував проєкт» і «не міг заснути» — три різні ночі з трьома різними
 * висновками, і лише остання з них узагалі про сон.
 *
 * Порівняння оцінки дня — під тим самим гейтом, що решта блоку (CORR_MIN_N):
 * зіпсовані ночі рідкісні, і «після безсонної ночі день гірший на 1.2» на двох
 * спостереженнях було б не висновком, а монеткою.
 */
function buildNightKinds(checkins, todayKey, days = STATS_WINDOWS.checkinRecent) {
  const kinds = { slept: 0, naps: 0, none: 0 };
  const reasons = {};
  const roughScores = [];
  const restScores = [];
  const roughDates = [];
  const d = new Date(todayKey + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - (days - 1));
  for (let i = 0; i < days; i++) {
    const key = dayKey(d);
    d.setUTCDate(d.getUTCDate() + 1);
    const rec = checkins[key];
    const kind = rec?.morning?.sleepKind;
    if (!kind || !(kind in kinds)) continue;
    kinds[kind]++;
    const score = rec?.evening?.dayScore;
    const rough = kind !== 'slept';
    if (rough) {
      roughDates.push(key);
      for (const r of asList(rec?.morning?.nightReason)) reasons[r] = (reasons[r] || 0) + 1;
    }
    if (typeof score === 'number') (rough ? roughScores : restScores).push(score);
  }
  const nights = kinds.slept + kinds.naps + kinds.none;
  const rough = kinds.naps + kinds.none;
  return {
    days,
    nights,
    ...kinds,
    rough,
    // Дати самих ночей — факт, а не висновок, тож без гейта. Саме вони дають
    // «це було позавчора», якого не дасть жоден відсоток. Кап на 5: далі йде
    // хвіст, який ніхто не читає.
    dates: roughDates.slice(-5),
    reasons: rankCounts(reasons),
    effect:
      roughScores.length >= CORR_MIN_N && restScores.length >= CORR_MIN_N
        ? {
            ready: true,
            roughAvg: round1(avg(roughScores)),
            restAvg: round1(avg(restScores)),
            nRough: roughScores.length,
          }
        : { ready: false, needed: CORR_MIN_N, nRough: roughScores.length },
  };
}

/**
 * «Індекс дня» — повна модель (checkin-model.mjs) над останніми
 * STATS_WINDOWS.checkinDeep добами. КОЖЕН календарний день вікна стає рядком (навіть
 * повністю порожній -> усі поля null): лаговий звʼязок «сьогодні->завтра»
 * порівнює СУСІДНІ елементи масиву, тож пропуск дня зсунув би пари й почав
 * би порівнювати не по-справжньому суміжні доби. Той самий принцип
 * ітерації, що вже в buildCheckinSeries/buildCheckinFill (день за днем,
 * незалежно від наявності запису).
 */
function buildCheckinModel(checkins, todayKey, days = STATS_WINDOWS.checkinDeep) {
  const flat = [];
  const d = new Date(todayKey + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - (days - 1));
  for (let i = 0; i < days; i++) {
    const key = dayKey(d);
    flat.push(flattenCheckinDay(checkins[key], asList, CATEGORY_VALUES));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return analyzeCheckinModel(flat);
}

/** Чек-ін по тижнях: середні сон / енергія / оцінка дня + скільки діб заповнено. */
function buildCheckinWeekly(checkins, todayKey, weeks = STATS_WINDOWS.checkinWeeks) {
  const starts = lastWeekStarts(todayKey, weeks);
  const buckets = {};
  for (const w of starts) buckets[w] = { sleep: [], energy: [], score: [], n: 0 };
  for (const [key, c] of Object.entries(checkins)) {
    if (!isDateKey(key)) continue;
    const w = weekStartKey(key);
    const b = buckets[w];
    if (!b) continue;
    b.n++;
    // Те саме джерело: без нього тижневий середній сон рахувався ЛИШЕ по
    // ночах, коли ти спав, — тобто був завищений рівно тими ночами, які
    // найбільше на нього впливають.
    const sh = sleepHoursOf(c.morning);
    if (sh !== null) b.sleep.push(sh);
    if (typeof c.evening?.dayScore === 'number') b.score.push(c.evening.dayScore);
    const en = CHECKIN_SLOTS.map((sl) => c[sl]?.energy).filter((v) => typeof v === 'number');
    if (en.length) b.energy.push(avg(en));
  }
  return starts.map((w) => ({
    week: w,
    n: buckets[w].n,
    sleepAvg: round1(avg(buckets[w].sleep)),
    energyAvg: round1(avg(buckets[w].energy)),
    dayScoreAvg: round1(avg(buckets[w].score)),
  }));
}

/** Подачі по тижнях (останні 8, нульові тижні присутні; поточний — частковий). */
function buildAppliedWeekly(appliedLog, todayKey, weeks = STATS_WINDOWS.trendWeeks) {
  const starts = lastWeekStarts(todayKey, weeks);
  const counts = Object.fromEntries(starts.map((k) => [k, 0]));
  for (const a of appliedLog) {
    const wk = isDateKey(a?.ts) ? weekStartKey(a.ts) : null;
    if (wk && counts[wk] != null) counts[wk]++;
  }
  return starts.map((k) => ({ week: k, count: counts[k] }));
}

/** Fit% поданих по тижнях (останні 8) — той самий appliedLog[].fit, що
 *  avgFitApplied (всі-часи), лише розбитий по тижнях. Легасі s.fitApplied
 *  сюди НЕ йде (немає ts, поділити на тижні нічим) — той самий виняток,
 *  що вже в buildAppliedWeekly. null для тижня без жодного fit-запису
 *  (не 0 — 0% виглядав би як «поганий fit», а не «даних немає»). */
function buildFitWeekly(appliedLog, todayKey, weeks = STATS_WINDOWS.trendWeeks) {
  const starts = lastWeekStarts(todayKey, weeks);
  const buckets = Object.fromEntries(starts.map((k) => [k, []]));
  for (const a of appliedLog) {
    const wk = isDateKey(a?.ts) ? weekStartKey(a.ts) : null;
    if (wk && buckets[wk] && typeof a.fit === 'number') buckets[wk].push(a.fit);
  }
  return starts.map((k) => ({
    week: k,
    avgFit: buckets[k].length ? Math.round(avg(buckets[k])) : null,
  }));
}

/** Тренд інтересів: топ-`topN` тем за всю історію × усі тижні від першого
 *  тижневого кошика (weeksSinceFirst) — верхньої межі нема, лише природна
 *  стеля WEEKLY_CAP на самому сторі interestsWeekly (bumpInterest). */
function buildInterestsTrend(interests, interestsWeekly, todayKey, topN = 5) {
  const starts = lastWeekStarts(todayKey, weeksSinceFirst(interestsWeekly, todayKey));
  const topics = Object.entries(interests)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([t]) => t);
  return {
    weeks: starts,
    topics: topics.map((topic) => ({
      topic,
      series: starts.map((wk) => Number(interestsWeekly[wk]?.[topic]) || 0),
    })),
  };
}

/** Агрегувати стор у контракт /api/stats. `todayKey`="YYYY-MM-DD" київський. */
/**
 * Скільки вакансій КОЛИСЬ дійшли до кожної лінійної стадії (F1).
 *
 * Навіщо окремо від лічильників `funnel`: ті тримають лише ПОТОЧНУ стадію, тож
 * конверсія з них страждає на survivorship bias — щойно вакансія стає rejected,
 * вона зникає з `applied`, знаменник падає, і що більше відмов ти фіксуєш, то
 * КРАЩОЮ виглядає конверсія. Абсурд. Журнал переходів дає чесну відповідь:
 * «подав 10, до співбесіди дійшло 2» лишається правдою й після десяти відмов.
 *
 * Легасі-записи без history: виводимо лінійно з поточної стадії (вакансія на
 * `offer` колись пройшла applied+interview). Це та сама гіпотеза, що її робила
 * стара формула, тож регресії немає — лише поступова заміна на факти в міру
 * накопичення журналу.
 */
export function reachedCounts(store) {
  const s = normalize(store);
  const out = Object.fromEntries(LINEAR_STAGES.map((st) => [st, 0]));
  for (const [url, cur] of Object.entries(s.funnel)) {
    const hist = s.funnelMeta[url]?.history;
    const seen = new Set();
    if (Array.isArray(hist) && hist.length) {
      for (const h of hist) if (STAGE_RANK[h?.stage] != null) seen.add(h.stage);
    } else if (STAGE_RANK[cur] != null) {
      // Легасі: без журналу вважаємо, що лінійний шлях пройдено до поточної.
      for (const st of LINEAR_STAGES) if (STAGE_RANK[st] <= STAGE_RANK[cur]) seen.add(st);
    }
    for (const st of seen) out[st]++;
  }
  return out;
}

/** Один запис збереженого у формі контракту (спільна для прев'ю і сторінок). */
function savedRow(x) {
  return {
    kind: x.kind || 'news',
    id: x.id || x.url || null,
    title: x.title || '',
    url: x.url || null,
    ts: x.ts || '',
  };
}

/**
 * Сторінка збереженого (F3): повний архів у KV не обрізаний — обрізав лише
 * READ у aggregateStats. Тож «показати все» не потребує ні міграції, ні нового
 * сховища: лише чесного доступу до того, що вже лежить.
 * Порядок — новіші перші (s.saved наповнюється unshift).
 */
export function pageSaved(store, { offset = 0, limit = 20 } = {}) {
  const s = normalize(store);
  const off = Math.max(0, Math.floor(Number(offset)) || 0);
  // Кап зверху — щоб ?limit=100000 не тягнув увесь блоб одним махом.
  const lim = Math.min(SAVED_PAGE_MAX, Math.max(1, Math.floor(Number(limit)) || 20));
  return { items: s.saved.slice(off, off + lim).map(savedRow), total: s.saved.length };
}

/**
 * Останні `nights` ночей журналу сну (Блок «Сон») — {d, startedAt, wokeAt,
 * durationMin}. durationMin — ЛИШЕ коли є ОБИДВА таймстемпи (тап «Ліг спати» +
 * автоматичне «прокинувся» з першого відкриття наступного дня); одна нога без
 * другої — null, а не здогадка.
 */
function buildSleepLog(sleepLog, nights = 30) {
  return Object.keys(sleepLog ?? {})
    .sort()
    .slice(-nights)
    .map((d) => {
      const night = sleepLog[d] ?? {};
      const durationMin =
        night.startedAt && night.wokeAt
          ? Math.round((Date.parse(night.wokeAt) - Date.parse(night.startedAt)) / 60000)
          : null;
      return {
        d,
        startedAt: night.startedAt ?? null,
        wokeAt: night.wokeAt ?? null,
        durationMin,
      };
    });
}

export function aggregateStats(store, todayKey) {
  const s = normalize(store);
  // Битий todayKey не валить агрегат (RangeError у date-математиці) — детермінований
  // фолбек: форма валідна, стріки/тиждень порожні.
  if (!isDateKey(todayKey)) todayKey = '1970-01-01';
  const opened = (x) => (x?.opens || 0) > 0;
  const mocked = (x) => (x?.mock || 0) > 0;

  // тижнева активність (останні 7 днів, старіші→новіші)
  const weekly = [];
  const wd = new Date(todayKey + 'T00:00:00Z');
  wd.setUTCDate(wd.getUTCDate() - 6);
  for (let i = 0; i < 7; i++) {
    const k = dayKey(wd);
    const day = s.days[k];
    weekly.push({ day: UA_DAYS[wd.getUTCDay()], value: day?.opens || 0, active: opened(day) });
    wd.setUTCDate(wd.getUTCDate() + 1);
  }

  // воронка: лічильники + список вакансій за стадією (з title/дати у funnelMeta).
  const funnel = Object.fromEntries(STAGES.map((st) => [st, 0]));
  for (const st of Object.values(s.funnel)) if (funnel[st] != null) funnel[st]++;
  // Порядок показу: лінійні за прогресом, термінальні — в кінці.
  const listOrder = Object.fromEntries(STAGES.map((st, i) => [st, i]));
  const funnelList = Object.entries(s.funnel)
    .filter(([, st]) => listOrder[st] != null)
    .map(([url, st]) => ({
      url,
      stage: st,
      title: s.funnelMeta[url]?.title || '',
      ts: s.funnelMeta[url]?.ts || '',
      // Журнал переходів для «Історії» у шторці. Легасі-записи його не мають —
      // віддаємо порожній, і шторка чесно покаже лише дату входу.
      history: Array.isArray(s.funnelMeta[url]?.history) ? s.funnelMeta[url].history : [],
    }))
    .sort(
      (a, b) => listOrder[a.stage] - listOrder[b.stage] || (b.ts || '').localeCompare(a.ts || ''),
    );

  // тижневі відгуки (за 7 днів)
  const weekAgo = new Date(todayKey + 'T00:00:00Z');
  weekAgo.setUTCDate(weekAgo.getUTCDate() - 6);
  const weekAgoKey = dayKey(weekAgo);
  const weeklyApplied = s.appliedLog.filter((a) => a.ts >= weekAgoKey).length;

  const conv = (a, b) => (a > 0 ? Math.round((b / a) * 100) : 0);
  const reached = reachedCounts(s);
  // fit% подач — з самих записів appliedLog (дедуплено по url, ревʼю D), плюс
  // легасі s.fitApplied (стара форма без url — щоб не втратити історію до фіксу;
  // у новий стор більше не пишемо, тож подвійного рахунку немає).
  const fits = [...s.appliedLog.map((a) => a.fit), ...s.fitApplied].filter(
    (f) => typeof f === 'number' && f >= 0,
  );
  const avgFit = fits.length ? Math.round(fits.reduce((x, y) => x + y, 0) / fits.length) : null;

  // mock: слабкі теми (weak/seen), стрік днів mock
  const weakTopics = Object.entries(s.mockTopics)
    .filter(([name]) => isSafeKey(name))
    .map(([name, v]) => ({ name, value: v.seen ? Math.round((v.weak / v.seen) * 100) : 0 }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 6);

  // Загальний recency-сигнал БЕЗ розбивки по темі: mockRated не прив'язує
  // qId до теми (лише {qId: рейтинг}), тож "останні N ПО ТЕМІ" вимагав би
  // схема-міграції — свідомо відкладено. Це дешевший, безризиковий різ:
  // частка 'easy' серед уже наявних (капнутих на 60) оцінок, доповнює
  // all-time weakTopics% свіжішим "як я зараз", без нового сховища.
  // Легасі-форма (голий рядок) лежить у KV роками: читати її ОБОВʼЯЗКОВО,
  // інакше вся історія оцінок зникла б у день деплою. Час і тема в неї просто
  // відсутні — тоді запис рахується в загальному відсотку, але не в тих
  // зрізах, які без них порахувати неможливо.
  const mockRatings = Object.values(s.mockRated).map(readRating).filter(Boolean);
  const mockRecentEasyPct = mockRatings.length
    ? Math.round((mockRatings.filter((r) => r.r === 'easy').length / mockRatings.length) * 100)
    : null;
  const easeTrend = buildEaseTrend(s.mockRated, todayKey);
  const recentByTopic = buildRecentByTopic(s.mockRated, todayKey);

  const interests = Object.entries(s.interests)
    .filter(([, v]) => v > 0)
    .map(([topic, score]) => ({ topic, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  const totalReads = Object.values(s.days).reduce((a, d) => a + (d?.news || 0), 0);
  // Знаменник: дні з відкриттям АБО кліками новин — інакше день з news_click без
  // open інфлює середнє (чисельник росте, знаменник ні).
  const activeDays =
    Object.values(s.days).filter((d) => opened(d) || (d?.news || 0) > 0).length || 1;

  return {
    streaks: {
      openDays: streak(s.days, todayKey, opened),
      mockDays: streak(s.days, todayKey, mocked),
      bestOpenDays: bestStreak(s.days, opened),
    },
    timeToOpenMin: median(s.opensMin),
    // Розподіл часу відкриття (не лише медіана) + тренд утримання по тижнях —
    // «Звички» відповідають на «наскільки це ритуал» і «чи тримаюсь краще».
    openRhythm: buildOpenRhythm(s.opensMin),
    habitWeekly: buildHabitWeekly(s.days, todayKey),
    // Вогники сторонніх застосунків — та сама «звичка», не добробут, тому тут,
    // а не серед полів чек-іну нижче.
    flameStats: buildFlameStats(s.checkins, todayKey),
    weekly,
    funnel,
    goal: { weeklyTarget: s.goal.weeklyTarget, weeklyApplied },
    // F1: конверсії — з «дійшов до» (reachedCounts), а НЕ з поточних стадій.
    // Стара формула рахувала живі стадії, тож відмова прибирала вакансію зі
    // знаменника: що більше відмов, то вища «конверсія». Тепер подана вакансія
    // лишається в знаменнику назавжди, чим би не скінчилась.
    conversion: {
      appliedToInterview: conv(reached.applied, reached.interview),
      interviewToOffer: conv(reached.interview, reached.offer),
    },
    // Скільки вакансій колись дійшли до стадії (знаменники конверсій — видимі,
    // щоб «50%» читалось як «1 з 2», а не як магія).
    reached,
    avgFitApplied: avgFit,
    funnelList,
    // Швидкість воронки: скільки триває кожен крок і що лежить без руху.
    // Читає той самий funnelMeta[].history, що вже їде заради «Історії» у
    // шторці — нових даних не збирає, лише зводить наявні.
    funnelSpeed: funnelSpeed(s.funnel, s.funnelMeta, todayKey),
    // «Не цікавить» (job_dismiss) — персистентне (фідбек власника): клієнт
    // фільтрує сьогоднішній список брифінгу за цими url, не лише за
    // сесійним React-станом.
    dismissedUrls: s.dismissedUrls.map((d) => d.url),
    savedCount: s.saved.length,
    // ТОП-8 у /api/stats — свідомо: це «останнє збережене» на вкладці, а не
    // архів. Повний список — окремим ендпоінтом /api/saved (F3), бо тягти сотні
    // записів у кожен /api/stats заради рядка «Ти зберіг N» — марно.
    savedList: s.saved.slice(0, SAVED_PREVIEW).map((x) => ({
      kind: x.kind || 'news',
      id: x.id || x.url || null,
      title: x.title || '',
      url: x.url || null,
      ts: x.ts || '',
    })),
    mock: {
      weakTopics,
      streak: streak(s.days, todayKey, mocked),
      recentEasyPct: mockRecentEasyPct,
      // Розблоковано таймстемпом на оцінці: «чи стає легше» по тижнях і «як
      // дається ЗАРАЗ» у розрізі тем. Обидва до цього були неможливі.
      easeTrend,
      recentByTopic,
    },
    // A2: розширені метрики (питання власника: стабільність / темп подач /
    // на що подаюсь / як змінюються інтереси).
    heatmap: buildHeatmap(s.days, todayKey),
    appliedWeekly: buildAppliedWeekly(s.appliedLog, todayKey),
    fitWeekly: buildFitWeekly(s.appliedLog, todayKey),
    // Без верхньої межі (weeksSinceFirst у buildInterestsTrend) — природна
    // стеля лишається WEEKLY_CAP на самому сторі interestsWeekly. Короткий
    // 2-точковий стрілочка-тренд у InterestsBlock читає лише останні два
    // елементи того самого масиву.
    interestsTrend: buildInterestsTrend(s.interests, s.interestsWeekly, todayKey),
    // roadmap — НЕ тут: state.roadmapProgress живе в іншому KV-блобі (state,
    // не stats), merge робить handleStats (worker.js, Блок P3) окремо, щоб
    // цей чистий агрегатор не знав про roadmap-контент.
    interests,
    readPerDay: Math.round(totalReads / activeDays),
    // Контракт /api/stats — лічильники + журнал; lastCheckDate — внутрішній
    // маркер стору, назовні не йде. streak/best — той самий streak()/
    // bestStreak(), що вже рахує stréaks.openDays/mockDays, лише інший
    // предикат (ok===true) над reliability.days замість s.days.
    reliability: {
      onTime: s.reliability.onTime,
      total: s.reliability.total,
      deadman: s.reliability.deadman,
      streak: reliabilityStreak(s.reliability.days, todayKey),
      best: bestStreak(s.reliability.days, (d) => d?.ok === true),
      days: Object.keys(s.reliability.days)
        .sort()
        .map((d) => ({ d, ok: s.reliability.days[d].ok })),
    },
    mockRatedToday: mocked(s.days[todayKey]),
    // F4: які саме питання оцінено — щоб картка пережила перезавантаження
    // (доти обраний варіант жив лише в стані сесії й після F5 зникав).
    // ⚠️ НАЗОВНІ — стара пласка форма {qId: 'easy'|'hard'}. Клієнт читає її
    // рівно для одного: підсвітити вже обрану оцінку в картці питання дня.
    // Час і тема потрібні лише серверним зрізам вище, тож роздувати ними
    // контракт (і ламати гідратацію) немає жодної причини — внутрішнє
    // сховище й зовнішній контракт тут навмисно різні.
    mockRated: Object.fromEntries(
      Object.entries(s.mockRated)
        .map(([qId, raw]) => [qId, readRating(raw)?.r])
        .filter(([, r]) => r),
    ),
    // Чек-ін (п.7). checkinToday — щоб екран гідратувався після перезаходу й не
    // питав удруге те, на що вже відповіли. Активний слот сюди НЕ кладемо: він
    // залежить від години, а /api/stats кешується — його додає worker.js.
    checkinToday: s.checkins[todayKey] ?? null,
    // Вікна їдуть РАЗОМ із даними: підпис глибини на екрані малюється з них, а
    // не з власної пам'яті клієнта про те, що там на сервері. Доти «8 ТИЖНІВ»
    // стояло зашитим рядком у RhythmBlock окремо від константи — розійшлись би
    // мовчки.
    windows: { ...STATS_WINDOWS },
    checkinSeries: buildCheckinSeries(s.checkins, todayKey),
    // Сирі записи за гаряче вікно — джерело для «деталей клітинки» карти
    // станів (які саме доби й що в них було). Рол-апи нижче лишаються: вони
    // відповідають на інше питання й дешевші для решти блоків.
    checkinRaw: buildCheckinRaw(s.checkins, todayKey),
    // Сон (Блок «Сон») — точні таймстемпи замість ранкового бакета, коли є:
    // тап «Ліг спати» + автоматичне «прокинувся» з першого відкриття наступного дня.
    sleepLog: buildSleepLog(s.sleepLog),
    // Дрейф наміру — на ВЖЕ зібраних даних (plan/ate є роками), тож працює з
    // першого дня, не чекає накопичення нових полів.
    intentDrift: buildIntentDrift(s.checkins, todayKey),
    // ⚠️ Обидва блоки існують, щоб нові ранкові питання не збирались у пусту:
    // dayExpect не входить у жоден індекс, а movePlan сам по собі лише живить
    // BODY — пару «намір проти факту» без цієї функції ніхто б не побачив.
    expectCalibration: buildExpectCalibration(s.checkins, todayKey),
    moveIntent: buildMoveIntent(s.checkins, todayKey),
    checkinWeekly: buildCheckinWeekly(s.checkins, todayKey),
    checkinFill: buildCheckinFill(s.checkins, todayKey),
    planVsFact: buildPlanVsFact(s.checkins, s.appliedLog, todayKey),
    sleepVsDayScore: buildSleepVsDayScore(s.checkins, todayKey),
    bedtimeVsEnergy: buildBedtimeVsEnergy(s.checkins, todayKey),
    categoryInsight: buildCategoryInsight(s.checkins, todayKey),
    appliedCalibration: buildAppliedCalibration(s.checkins, s.appliedLog, todayKey),
    checkinTops: buildCheckinTops(s.checkins, todayKey),
    nightKinds: buildNightKinds(s.checkins, todayKey),
    socialContext: buildSocialContext(s.checkins, todayKey),
    // «Індекс дня» — окрема статистична модель (checkin-model.mjs): композитні
    // індекси, ваги, що вчаться на власних dayScore, драйвери, лаговий звʼязок,
    // архетипи. Читає ті самі checkins, нічого нового не питає в людини.
    checkinModel: buildCheckinModel(s.checkins, todayKey),
  };
}
