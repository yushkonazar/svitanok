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
//   mockTopics:{ '<topic>': { seen, weak } }                 // самооцінка mock
//   goal:      { weeklyTarget }
//   fitApplied:[ int ]                                       // fit% поданих вакансій
//   opensMin:  [ int ]                                       // хв після 08:00 до відкриття
//   appliedLog:[ { url, ts } ]                               // для тижневого лічильника
//   reliability:{ onTime, total, deadman }                   // з прогонів brief

const UA_DAYS = ['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const STAGES = ['saved', 'applied', 'interview', 'offer'];

export function emptyStore() {
  return {
    days: {},
    funnel: {},
    funnelMeta: {},
    saved: [],
    interests: {},
    mockTopics: {},
    goal: { weeklyTarget: 5 },
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
    mockTopics: s.mockTopics && typeof s.mockTopics === 'object' ? s.mockTopics : e.mockTopics,
    goal: { weeklyTarget: Number(s.goal?.weeklyTarget) || e.goal.weeklyTarget },
    fitApplied: Array.isArray(s.fitApplied) ? s.fitApplied : e.fitApplied,
    opensMin: Array.isArray(s.opensMin) ? s.opensMin : e.opensMin,
    appliedLog: Array.isArray(s.appliedLog) ? s.appliedLog : e.appliedLog,
    reliability: {
      onTime: Number(s.reliability?.onTime) || 0,
      total: Number(s.reliability?.total) || 0,
      deadman: Number(s.reliability?.deadman) || 0,
    },
  };
}

const bump = (obj, key, by = 1) => {
  obj[key] = (Number(obj[key]) || 0) + by;
};
const dayBucket = (store, dateKey) => {
  if (!store.days[dateKey]) store.days[dateKey] = { opens: 0, mock: 0, step: 0, news: 0 };
  return store.days[dateKey];
};

/**
 * Застосувати подію до стору (мутує й повертає його). `ev.type`:
 *  open · tab · news_click · save_news · unsave_news · save_item · unsave_item ·
 *  job_stage · job_dismiss · mock_answer · vote. `dateKey`="YYYY-MM-DD" київський,
 *  `nowMin`=хв після 08:00.
 */
export function recordEvent(store, ev, dateKey, nowMin = null) {
  const s = normalize(store);
  const t = ev?.type;
  switch (t) {
    case 'open':
      bump(dayBucket(s, dateKey), 'opens');
      if (typeof nowMin === 'number' && nowMin >= 0) s.opensMin.push(Math.round(nowMin));
      break;
    case 'news_click':
      bump(dayBucket(s, dateKey), 'news');
      if (ev.category) bump(s.interests, ev.category);
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
        if (ev.category) bump(s.interests, ev.category, 2);
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
        if (ev.topic) bump(s.interests, ev.topic, 2);
      }
      break;
    case 'unsave_item':
      s.saved = s.saved.filter((x) => !(x.kind === ev.kind && x.id === ev.id));
      break;
    case 'vote':
      if (ev.category) bump(s.interests, ev.category, ev.dir === 'down' ? -1 : 1);
      break;
    case 'job_stage':
      if (ev.url) {
        if (ev.stage && STAGES.includes(ev.stage)) {
          s.funnel[ev.url] = ev.stage;
          // Мета (title+дата) — щоб дашборд показував СПИСОК вакансій стадії наскрізь
          // по днях, а не лише з поточного брифінгу (вакансії дедупляться на 7 днів).
          s.funnelMeta[ev.url] = {
            title: ev.title || s.funnelMeta[ev.url]?.title || '',
            ts: dateKey,
          };
          if (ev.stage === 'applied') {
            s.appliedLog.push({ url: ev.url, ts: dateKey });
            if (typeof ev.fit === 'number' && ev.fit >= 0) s.fitApplied.push(ev.fit);
          }
        } else {
          delete s.funnel[ev.url]; // stage null -> зняти
          delete s.funnelMeta[ev.url];
        }
      }
      break;
    case 'job_dismiss':
      // «Не релевантно» — ефемерне: у постійному сторі НЕ тримаємо.
      break;
    case 'mock_answer':
      bump(dayBucket(s, dateKey), 'mock');
      if (ev.topic) {
        if (!s.mockTopics[ev.topic]) s.mockTopics[ev.topic] = { seen: 0, weak: 0 };
        bump(s.mockTopics[ev.topic], 'seen');
        if (ev.rating === 'hard') bump(s.mockTopics[ev.topic], 'weak');
      }
      break;
    case 'step_done':
      bump(dayBucket(s, dateKey), 'step');
      break;
    default:
      break; // невідома подія — ігноруємо (не валимо)
  }
  return s;
}

/** Обчислити стрік «днів поспіль» до сьогодні за предикатом дня. */
function streak(days, dateKey, pred) {
  let cur = 0;
  const d = new Date(dateKey + 'T00:00:00Z');
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

/** Агрегувати стор у контракт /api/stats. `todayKey`="YYYY-MM-DD" київський. */
export function aggregateStats(store, todayKey) {
  const s = normalize(store);
  const opened = (x) => (x?.opens || 0) > 0;
  const stepped = (x) => (x?.step || 0) > 0;
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
  const funnel = { saved: 0, applied: 0, interview: 0, offer: 0 };
  for (const st of Object.values(s.funnel)) if (funnel[st] != null) funnel[st]++;
  const stageOrder = { saved: 0, applied: 1, interview: 2, offer: 3 };
  const funnelList = Object.entries(s.funnel)
    .filter(([, st]) => stageOrder[st] != null)
    .map(([url, st]) => ({
      url,
      stage: st,
      title: s.funnelMeta[url]?.title || '',
      ts: s.funnelMeta[url]?.ts || '',
    }))
    .sort(
      (a, b) => stageOrder[a.stage] - stageOrder[b.stage] || (b.ts || '').localeCompare(a.ts || ''),
    );

  // тижневі відгуки (за 7 днів)
  const weekAgo = new Date(todayKey + 'T00:00:00Z');
  weekAgo.setUTCDate(weekAgo.getUTCDate() - 6);
  const weekAgoKey = weekAgo.toISOString().slice(0, 10);
  const weeklyApplied = s.appliedLog.filter((a) => a.ts >= weekAgoKey).length;

  const conv = (a, b) => (a > 0 ? Math.round((b / a) * 100) : 0);
  const avgFit = s.fitApplied.length
    ? Math.round(s.fitApplied.reduce((x, y) => x + y, 0) / s.fitApplied.length)
    : null;

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

  const totalReads = Object.values(s.days).reduce((a, d) => a + (d.news || 0), 0);
  const activeDays = Object.values(s.days).filter((d) => opened(d)).length || 1;

  return {
    streaks: {
      openDays: streak(s.days, todayKey, opened),
      stepDays: streak(s.days, todayKey, stepped),
      mockDays: streak(s.days, todayKey, mocked),
      bestOpenDays: bestStreak(s.days, opened),
      bestStepDays: bestStreak(s.days, stepped),
    },
    timeToOpenMin: median(s.opensMin),
    weekly,
    funnel,
    goal: { weeklyTarget: s.goal.weeklyTarget, weeklyApplied },
    conversion: {
      appliedToInterview: conv(
        funnel.applied + funnel.interview + funnel.offer,
        funnel.interview + funnel.offer,
      ),
      interviewToOffer: conv(funnel.interview + funnel.offer, funnel.offer),
    },
    avgFitApplied: avgFit,
    funnelList,
    savedCount: s.saved.length,
    savedList: s.saved.slice(0, 8).map((x) => ({
      kind: x.kind || 'news',
      id: x.id || x.url || null,
      title: x.title || '',
      url: x.url || null,
      ts: x.ts || '',
    })),
    mock: { weakTopics, streak: streak(s.days, todayKey, mocked) },
    roadmap: { done: 0, total: 0 }, // з форум-групи (пізніше)
    interests,
    readPerDay: Math.round(totalReads / activeDays),
    reliability: s.reliability,
    stepDoneToday: stepped(s.days[todayKey]),
  };
}
