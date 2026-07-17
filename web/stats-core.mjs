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
const STAGES = [...LINEAR_STAGES, ...TERMINAL_STAGES];
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
    reliability: { onTime: 0, total: 0, deadman: 0 },
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
      ...(typeof s.reliability?.lastCheckDate === 'string'
        ? { lastCheckDate: s.reliability.lastCheckDate }
        : {}),
    },
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
function lastWeekStarts(todayKey, n) {
  const d = new Date(weekStartKey(todayKey) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 7 * (n - 1));
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 7);
  }
  return out;
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
    mock: { weakTopics, streak: streak(s.days, todayKey, mocked) },
    // A2: розширені метрики (питання власника: стабільність / темп подач /
    // на що подаюсь / як змінюються інтереси).
    heatmap: buildHeatmap(s.days, todayKey),
    appliedWeekly: buildAppliedWeekly(s.appliedLog, todayKey),
    interestsTrend: buildInterestsTrend(s.interests, s.interestsWeekly, todayKey),
    // roadmap — НЕ тут: state.roadmapProgress живе в іншому KV-блобі (state,
    // не stats), merge робить handleStats (worker.js, Блок P3) окремо, щоб
    // цей чистий агрегатор не знав про roadmap-контент.
    interests,
    readPerDay: Math.round(totalReads / activeDays),
    // Контракт /api/stats — лише лічильники; lastCheckDate — внутрішній маркер стору.
    reliability: {
      onTime: s.reliability.onTime,
      total: s.reliability.total,
      deadman: s.reliability.deadman,
    },
    mockRatedToday: mocked(s.days[todayKey]),
    // F4: які саме питання оцінено — щоб картка пережила перезавантаження
    // (доти обраний варіант жив лише в стані сесії й після F5 зникав).
    mockRated: s.mockRated,
  };
}
