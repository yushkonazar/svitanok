// Чиста логіка статистики дашборда (F1): запис подій + агрегація для /api/stats.
// Без залежностей і без I/O — щоб покрити тестами (worker.js імпортує це, KV-I/O
// робить Worker). Стор — один JSON-блоб у KV (ключ `stats`).
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
];

const CHECKIN_FIELDS = {
  morning: {
    sleepH: { num: [0, 14] },
    bedtime: { enum: ['e23', 'e00', 'e01', 'e02', 'late'] },
    energy: { num: [1, 5], int: true },
    plan: { enum: CATEGORY_VALUES },
    planApply: { num: [0, 20], int: true },
  },
  afternoon: {
    pace: { enum: ['on', 'off', 'better'] },
    energy: { num: [1, 5], int: true },
    ate: { enum: CATEGORY_VALUES },
  },
  evening: {
    dayScore: { num: [1, 5], int: true },
    kept: { enum: ['yes', 'partly', 'no'] },
    applied: { num: [0, 20], int: true },
    energy: { num: [1, 5], int: true },
    blocker: { enum: ['tired', 'anxious', 'stuck', 'external', 'distract', 'health', 'none'] },
    helper: { enum: ['early', 'list', 'breaks', 'support', 'none'] },
  },
};

/**
 * Активний блок за КИЇВСЬКОЮ годиною, або null у тиху зону (02:00–07:59).
 *
 * ⚠️ Рахує сервер, не клієнт. Інакше «ранковий» чек-ін можна надіслати опівночі,
 * перевівши годинник на телефоні, — і дані стануть художнім твором.
 */
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
  return d.toISOString().slice(0, 10);
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

/** Лишити тільки валідні поля блоку. Невідоме/биле ІГНОРУЄМО, а не видаляємо. */
function cleanCheckin(slot, ev) {
  const spec = CHECKIN_FIELDS[slot];
  if (!spec) return null;
  const out = {};
  for (const [k, rule] of Object.entries(spec)) {
    const v = ev[k];
    if (v === undefined || v === null) continue;
    if (rule.enum) {
      if (rule.enum.includes(v)) out[k] = v;
      continue;
    }
    // typeof, а не Number(): Number(null)===0 і Number('')===0 тихо
    // перетворили б «нічого» на валідну відповідь.
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    if (rule.int && !Number.isInteger(v)) continue;
    const [lo, hi] = rule.num;
    if (v < lo || v > hi) continue;
    out[k] = v;
  }
  return out;
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
/** "YYYY-MM-DD"? Битий ключ у date-математиці кидає RangeError — гардимо на вході. */
const isDateKey = (k) => typeof k === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(k);
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
  return d.toISOString().slice(0, 10);
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
export function recordEvent(store, ev, dateKey, nowMin = null) {
  const s = normalize(store);
  if (!isDateKey(dateKey)) return s; // без валідної дати подію не приймаємо (не валимо)
  const t = ev?.type;
  switch (t) {
    case 'open': {
      const day = dayBucket(s, dateKey);
      // «Час до відкриття» — лише ПЕРШЕ відкриття дня: клієнт шле open на кожне
      // завантаження, і без цього гейта повторні заходи (обід/вечір) тягнуть
      // медіану в сотні хвилин, знецінюючи метрику.
      if (!(day.opens > 0) && typeof nowMin === 'number' && nowMin >= 0)
        capPush(s.opensMin, Math.round(nowMin));
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
      // «Не релевантно» — ефемерне: у постійному сторі НЕ тримаємо.
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
      const prev = qId ? s.mockRated[qId] : undefined;
      const first = !prev;

      if (first) bump(dayBucket(s, dateKey), 'mock');
      if (ev.topic) {
        if (!s.mockTopics[ev.topic]) s.mockTopics[ev.topic] = { seen: 0, weak: 0 };
        const t = s.mockTopics[ev.topic];
        if (first) bump(t, 'seen');
        if (prev !== rating) {
          if (rating === 'hard') bump(t, 'weak');
          else if (prev === 'hard') t.weak = Math.max(0, (Number(t.weak) || 0) - 1);
        }
      }
      if (qId) {
        s.mockRated[qId] = rating;
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
      const clean = cleanCheckin(ev.slot, ev);
      // Невідомий слот або жодного валідного поля -> тихо нічого. М'який ігнор,
      // як у mock_answer, а НЕ як у job_stage (там невідоме значення означає
      // «видалити» — для чек-іну це знищувало б добу).
      if (!clean || !Object.keys(clean).length) break;
      if (!s.checkins[dateKey] || typeof s.checkins[dateKey] !== 'object') s.checkins[dateKey] = {};
      // Мерджимо, а не замінюємо: клієнт шле блок дебаунсом, і часткова відповідь
      // не має стирати те, що вже відповіли раніше в цьому ж блоці.
      s.checkins[dateKey][ev.slot] = { ...s.checkins[dateKey][ev.slot], ...clean };
      capCheckins(s);
      break;
    }
    // 'step_done' прибрано (D4, «Крок до офера»); старі days[].step у KV просто
    // ігноруються (без міграції).
    default:
      break; // невідома подія — ігноруємо (не валимо)
  }
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
    const k = d.toISOString().slice(0, 10);
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

/** Теплокарта активності: від понеділка ~12 тижнів тому до сьогодні (вкл.).
 *  value = сума дій дня (opens+mock+news), level 0..4 — фіксовані пороги,
 *  щоб колір мав стале значення день у день. */
function buildHeatmap(days, todayKey) {
  const d = new Date(todayKey + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 83);
  // до понеділка — тим самим weekStartKey, що й тижневі кошики (одна конвенція)
  d.setTime(Date.parse(weekStartKey(d.toISOString().slice(0, 10)) + 'T00:00:00Z'));
  const out = [];
  for (;;) {
    const k = d.toISOString().slice(0, 10);
    if (k > todayKey) break;
    const day = days[k];
    const v = (day?.opens || 0) + (day?.mock || 0) + (day?.news || 0); // step прибрано (D4)
    const l = v <= 0 ? 0 : v === 1 ? 1 : v <= 3 ? 2 : v <= 6 ? 3 : 4;
    out.push({ d: k, v, l });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** Понеділки останніх `n` тижнів (старіші→новіші), включно з поточним. */
export function lastWeekStarts(todayKey, n) {
  const d = new Date(weekStartKey(todayKey) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 7 * (n - 1));
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 7);
  }
  return out;
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

/** Ряд «сон / енергія / оцінка дня» за останні N діб (лише заповнені). */
function buildCheckinSeries(checkins, todayKey, days = 30) {
  const out = [];
  const d = new Date(todayKey + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - (days - 1));
  for (let i = 0; i < days; i++) {
    const key = d.toISOString().slice(0, 10);
    const c = checkins[key];
    if (c) {
      // Енергія — до трьох точок за добу; це і є крива, а не крапка.
      const en = CHECKIN_SLOTS.map((sl) => c[sl]?.energy).filter((v) => typeof v === 'number');
      out.push({
        d: key,
        sleepH: typeof c.morning?.sleepH === 'number' ? c.morning.sleepH : null,
        energy: round1(avg(en)),
        dayScore: typeof c.evening?.dayScore === 'number' ? c.evening.dayScore : null,
        slots: CHECKIN_SLOTS.filter((sl) => c[sl] && Object.keys(c[sl]).length).length,
      });
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/**
 * Явка по блоках за останні N діб. Самі пропуски — теж сигнал: ранок заповнений
 * 25 разів, а вечір 4 — це вже висновок, і чесніший за будь-яку кореляцію.
 */
function buildCheckinFill(checkins, todayKey, days = 30) {
  const fill = { morning: 0, afternoon: 0, evening: 0 };
  const d = new Date(todayKey + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - (days - 1));
  for (let i = 0; i < days; i++) {
    const c = checkins[d.toISOString().slice(0, 10)];
    if (c) for (const sl of CHECKIN_SLOTS) if (c[sl] && Object.keys(c[sl]).length) fill[sl]++;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return { ...fill, days };
}

/**
 * Намір проти факту: скільки подач планував уранці — і скільки їх реально було
 * (за appliedLog, а не за словами). Єдина відповідь, яку застосунок ПЕРЕВІРЯЄ.
 */
function buildPlanVsFact(checkins, appliedLog, todayKey, days = 30) {
  const byDay = {};
  for (const a of appliedLog) if (isDateKey(a?.ts)) byDay[a.ts] = (byDay[a.ts] || 0) + 1;

  const rows = [];
  const d = new Date(todayKey + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - (days - 1));
  for (let i = 0; i < days; i++) {
    const key = d.toISOString().slice(0, 10);
    const m = checkins[key]?.morning;
    // Лише РОБОЧІ дні (plan='work'): у v2 planApply опційне й показується тільки
    // там. Без гейта на plan осиротіле число (обрав «Робота», ввів, перемкнув на
    // «Навчання») пролазило б у джоб-рядок на не-робочому дні.
    if (m?.plan === 'work' && typeof m.planApply === 'number') {
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
function buildSleepVsDayScore(checkins, todayKey, days = 60) {
  const low = [];
  const ok = [];
  const d = new Date(todayKey + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - (days - 1));
  for (let i = 0; i < days; i++) {
    const c = checkins[d.toISOString().slice(0, 10)];
    const sleep = c?.morning?.sleepH;
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
function buildCategoryInsight(checkins, todayKey, days = 30) {
  const buckets = {};
  const d = new Date(todayKey + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - (days - 1));
  for (let i = 0; i < days; i++) {
    const c = checkins[d.toISOString().slice(0, 10)];
    const cat = c?.afternoon?.ate;
    // Лише ВІДОМІ категорії: старі значення до v2 (apply/interview/procrast) не
    // мусять пролазити сирим слагом у «куди йде час» і спотворювати відсотки.
    if (typeof cat === 'string' && CATEGORY_VALUES.includes(cat)) {
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
  return { total, rows };
}

/**
 * Час відходу до сну проти РАНКОВОЇ енергії (обидва — поля ранку, тож join за
 * тією ж добою). Рано (до 00:00) vs пізно (після 01:00); межу 00–01 не рахуємо.
 * Гейт CORR_MIN_N — та сама дисципліна «не брехати на малій вибірці».
 */
function buildBedtimeVsEnergy(checkins, todayKey, days = 60) {
  // Середину 00–01 (e01) НЕ рахуємо в жодному кошику: краї мають контрастувати,
  // а не змазуватись (та сама логіка, що виключення нейтральної середини всюди).
  const EARLY = new Set(['e23', 'e00']);
  const LATE = new Set(['e02', 'late']);
  const early = [];
  const late = [];
  const d = new Date(todayKey + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - (days - 1));
  for (let i = 0; i < days; i++) {
    const m = checkins[d.toISOString().slice(0, 10)]?.morning;
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
 * Калібрація: вечірній САМОЗВІТ подач проти appliedLog (факту). Не кореляція, а
 * звірка per-day, тож без гейта — показуємо як planVsFact, коли є хоч день.
 *  more  = сказав більше, ніж у журналі  -> подавав ПОЗА застосунком (не залогував)
 *  fewer = сказав менше -> залогував зайве / плутанина з добою
 */
function buildAppliedCalibration(checkins, appliedLog, todayKey, days = 30) {
  const byDay = {};
  for (const a of appliedLog) if (isDateKey(a?.ts)) byDay[a.ts] = (byDay[a.ts] || 0) + 1;

  let n = 0;
  let matched = 0;
  let more = 0;
  let fewer = 0;
  const d = new Date(todayKey + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - (days - 1));
  for (let i = 0; i < days; i++) {
    const key = d.toISOString().slice(0, 10);
    const c = checkins[key];
    const self = c?.evening?.applied;
    // Лише робочі дні (plan='work'): осиротіле «скільки вийшло» на не-робочому
    // дні не мусить потрапляти в джоб-калібрацію.
    if (c?.morning?.plan === 'work' && typeof self === 'number') {
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

/**
 * Найчастіший блокер / помічник за N діб (мода, без 'none'). Не кореляція, а
 * розподіл — тож без гейта, лише n=0 -> null. Оживляє blocker (доти збирався,
 * але ніде не читався) і робить helper аналітичним.
 */
function buildCheckinTops(checkins, todayKey, days = 30) {
  const bC = {};
  const hC = {};
  const d = new Date(todayKey + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - (days - 1));
  for (let i = 0; i < days; i++) {
    const ev = checkins[d.toISOString().slice(0, 10)]?.evening;
    if (ev) {
      if (typeof ev.blocker === 'string' && ev.blocker !== 'none')
        bC[ev.blocker] = (bC[ev.blocker] || 0) + 1;
      if (typeof ev.helper === 'string' && ev.helper !== 'none')
        hC[ev.helper] = (hC[ev.helper] || 0) + 1;
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  const top = (m) => {
    const e = Object.entries(m).sort((a, b) => b[1] - a[1])[0];
    return e ? { value: e[0], n: e[1] } : null;
  };
  return { blocker: top(bC), helper: top(hC) };
}

/** Чек-ін по тижнях: середні сон / енергія / оцінка дня + скільки діб заповнено. */
function buildCheckinWeekly(checkins, todayKey, weeks = 8) {
  const starts = lastWeekStarts(todayKey, weeks);
  const buckets = {};
  for (const w of starts) buckets[w] = { sleep: [], energy: [], score: [], n: 0 };
  for (const [key, c] of Object.entries(checkins)) {
    if (!isDateKey(key)) continue;
    const w = weekStartKey(key);
    const b = buckets[w];
    if (!b) continue;
    b.n++;
    if (typeof c.morning?.sleepH === 'number') b.sleep.push(c.morning.sleepH);
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
function buildAppliedWeekly(appliedLog, todayKey, weeks = 8) {
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
function buildFitWeekly(appliedLog, todayKey, weeks = 8) {
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

/** Тренд інтересів: топ-`topN` тем за всю історію × останні `weeks` тижнів. */
function buildInterestsTrend(interests, interestsWeekly, todayKey, weeks = 6, topN = 5) {
  const starts = lastWeekStarts(todayKey, weeks);
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
    const k = wd.toISOString().slice(0, 10);
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
  const weekAgoKey = weekAgo.toISOString().slice(0, 10);
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
    .map(([name, v]) => ({ name, value: v.seen ? Math.round((v.weak / v.seen) * 100) : 0 }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 6);

  // Загальний recency-сигнал БЕЗ розбивки по темі: mockRated не прив'язує
  // qId до теми (лише {qId: рейтинг}), тож "останні N ПО ТЕМІ" вимагав би
  // схема-міграції — свідомо відкладено. Це дешевший, безризиковий різ:
  // частка 'easy' серед уже наявних (капнутих на 60) оцінок, доповнює
  // all-time weakTopics% свіжішим "як я зараз", без нового сховища.
  const mockRatings = Object.values(s.mockRated);
  const mockRecentEasyPct = mockRatings.length
    ? Math.round((mockRatings.filter((r) => r === 'easy').length / mockRatings.length) * 100)
    : null;

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
    },
    // A2: розширені метрики (питання власника: стабільність / темп подач /
    // на що подаюсь / як змінюються інтереси).
    heatmap: buildHeatmap(s.days, todayKey),
    appliedWeekly: buildAppliedWeekly(s.appliedLog, todayKey),
    fitWeekly: buildFitWeekly(s.appliedLog, todayKey),
    // 26 тижнів — уся глибина, що реально зберігається (WEEKLY_CAP), не
    // дефолтне «6» buildInterestsTrend: тренд-графік у статистиці показує
    // повні пів року, короткий 2-точковий стрілочка-тренд у InterestsBlock
    // читає лише останні два елементи того самого масиву.
    interestsTrend: buildInterestsTrend(s.interests, s.interestsWeekly, todayKey, WEEKLY_CAP),
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
    mockRated: s.mockRated,
    // Чек-ін (п.7). checkinToday — щоб екран гідратувався після перезаходу й не
    // питав удруге те, на що вже відповіли. Активний слот сюди НЕ кладемо: він
    // залежить від години, а /api/stats кешується — його додає worker.js.
    checkinToday: s.checkins[todayKey] ?? null,
    checkinSeries: buildCheckinSeries(s.checkins, todayKey),
    checkinWeekly: buildCheckinWeekly(s.checkins, todayKey),
    checkinFill: buildCheckinFill(s.checkins, todayKey),
    planVsFact: buildPlanVsFact(s.checkins, s.appliedLog, todayKey),
    sleepVsDayScore: buildSleepVsDayScore(s.checkins, todayKey),
    bedtimeVsEnergy: buildBedtimeVsEnergy(s.checkins, todayKey),
    categoryInsight: buildCategoryInsight(s.checkins, todayKey),
    appliedCalibration: buildAppliedCalibration(s.checkins, s.appliedLog, todayKey),
    checkinTops: buildCheckinTops(s.checkins, todayKey),
  };
}
