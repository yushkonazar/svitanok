// data.read scope=weekly | archive (07 §4, етап 3 PR-2): дайджест для
// тижневого звіту. Профіль weekly-review робить ОДИН виклик і має побачити
// всі блоки §1 інструкції цілком - тому тут JSON, а не однорядкові зрізи
// assistant-data-core (той дайджест дописується до транскрипту чату й тому
// капнутий 1 500; тут читач один, кап профільний 50k).
//
// Модуль чистий: на вході вже прочитані агрегати (aggregateStats, архіви,
// важелі, ряди плану), на виході - рядок. Стеля - не «обрізати рядок посередині
// JSON»: драбина SHRINK_LADDER знімає найважчі блоки по одному, доки текст не
// вміститься, і КАЖЕ, що зняла (`dropped`), - модель бачить межу даних, а не
// зламаний документ. Зріз посередині лишається останнім кроком, коли навіть
// скелет не влазить (кап < 500 неможливий за схемою, тож це страховка).

import { totalProgress } from '../../roadmap-core.mjs';
import { addDaysToDateKey } from '../../reminders-core.mjs';

/** Глибина сирих чек-інів у weekly за замовчуванням = вікно моделі
 *  «Індексу дня» (STATS_WINDOWS.checkinDeep). */
export const WEEKLY_RAW_DAYS = 90;
/** Ряди плану дня: 8 тижнів (weekly-review §1 «План дня»). */
export const WEEKLY_PLAN_DAYS = 56;
/** Тижневих згорток архіву в дайджесті: рік. */
export const ARCHIVE_WEEKS_IN_DIGEST = 52;

/**
 * `period` з 07 §4 («30d», «12w», «тиждень», «місяць») → доби. null = не
 * задано; невідомий формат - помилка контракту, не тихий дефолт.
 * @param {unknown} raw
 * @returns {number | null}
 */
export function parsePeriodDays(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim().toLowerCase();
  if (s === 'день' || s === 'day') return 1;
  if (s === 'тиждень' || s === 'week') return 7;
  if (s === 'місяць' || s === 'month') return 30;
  const m = /^(\d{1,3})\s*([dw])$/.exec(s);
  if (!m) throw new Error(`period «${String(raw)}»: очікую Nd, Nw, «тиждень» або «місяць»`);
  const n = Number(m[1]);
  const days = m[2] === 'w' ? n * 7 : n;
  if (days < 1 || days > 366) throw new Error(`period «${String(raw)}»: від 1 дня до 366`);
  return days;
}

/**
 * Межі поточного тижня за Києвом (понеділок-неділя) для дати todayKey.
 * @param {string} todayKey YYYY-MM-DD
 */
export function weekBounds(todayKey) {
  // getUTCDay на «дата + T00:00Z» - той самий прийом, що weekStartKey у
  // stats-core: ключ уже київський, зсув потрібен лише день тижня.
  const dow = new Date(`${todayKey}T00:00:00Z`).getUTCDay(); // 0 = нд
  const back = dow === 0 ? 6 : dow - 1;
  const from = addDaysToDateKey(todayKey, -back);
  return { from, to: addDaysToDateKey(from, 6) };
}

/**
 * @typedef {{
 *   agg: Record<string, any>,
 *   roadmapProgress?: Record<string, any> | null,
 *   archive?: Record<string, any> | null,
 *   weeklyArchive?: Record<string, any> | null,
 *   levers?: Record<string, any> | null,
 *   plans?: { days: any[], items: any[] } | { error: string } | null,
 *   todayKey: string,
 *   rawDays?: number | null,
 *   cap: number,
 * }} WeeklyInput
 */

/**
 * Дайджест weekly: усі блоки §1 weekly-review.md + план дня + архів + важелі.
 * @param {WeeklyInput} input
 * @returns {{ text: string, dropped: string[] }}
 */
export function buildWeeklyDigest(input) {
  const { agg, todayKey } = input;
  const rawDays = input.rawDays ?? WEEKLY_RAW_DAYS;
  const week = weekBounds(todayKey);
  const doc = {
    scope: 'weekly',
    today: todayKey,
    week,
    windows: agg.windows ?? null,
    checkin: {
      raw: windowRaw(agg.checkinRaw, todayKey, rawDays),
      series: agg.checkinSeries ?? null,
      weekly: agg.checkinWeekly ?? null,
      fill: agg.checkinFill ?? null,
      tops: agg.checkinTops ?? null,
      sleepLog: agg.sleepLog ?? null,
      sleepVsDayScore: agg.sleepVsDayScore ?? null,
      bedtimeVsEnergy: agg.bedtimeVsEnergy ?? null,
      intentDrift: agg.intentDrift ?? null,
      expectCalibration: agg.expectCalibration ?? null,
      moveIntent: agg.moveIntent ?? null,
      categoryInsight: agg.categoryInsight ?? null,
      nightKinds: agg.nightKinds ?? null,
      workQuadrants: agg.workQuadrants ?? null,
      socialContext: agg.socialContext ?? null,
    },
    index: agg.checkinModel ?? null,
    habits: {
      streaks: agg.streaks ?? null,
      timeToOpenMin: agg.timeToOpenMin ?? null,
      openRhythm: agg.openRhythm ?? null,
      habitWeekly: agg.habitWeekly ?? null,
      heatmap: agg.heatmap ?? null,
      weekly: agg.weekly ?? null,
      flameStats: agg.flameStats ?? null,
      readPerDay: agg.readPerDay ?? null,
    },
    funnel: {
      counts: agg.funnel ?? null,
      list: Array.isArray(agg.funnelList) ? agg.funnelList : [],
      speed: agg.funnelSpeed ?? null,
      goal: agg.goal ?? null,
      conversion: agg.conversion ?? null,
      reached: agg.reached ?? null,
      avgFitApplied: agg.avgFitApplied ?? null,
      appliedWeekly: agg.appliedWeekly ?? null,
      fitWeekly: agg.fitWeekly ?? null,
    },
    mastery: {
      roadmap: totalProgress(input.roadmapProgress ?? {}),
      mock: agg.mock ?? null,
    },
    interests: { top: agg.interests ?? null, trend: agg.interestsTrend ?? null },
    reliability: agg.reliability ?? null,
    plan: input.plans ?? { error: 'план дня не читався' },
    archive: buildArchiveBlock(input.archive, input.weeklyArchive),
    levers: input.levers ?? null,
  };
  return shrinkToCap(doc, input.cap, WEEKLY_LADDER);
}

/**
 * Дайджест archive: холодні згортки + важелі (для chat на прямий запит
 * «як було торік»; кап профілю chat 12k, тож драбина тут коротша).
 * @param {{ archive?: Record<string, any> | null, weeklyArchive?: Record<string, any> | null,
 *   levers?: Record<string, any> | null, todayKey: string, cap: number }} input
 */
export function buildArchiveDigest(input) {
  const doc = {
    scope: 'archive',
    today: input.todayKey,
    archive: buildArchiveBlock(input.archive, input.weeklyArchive),
    levers: input.levers ?? null,
  };
  return shrinkToCap(doc, input.cap, ARCHIVE_LADDER);
}

/** Сирі чек-іни за останні `days` діб із агрегованого checkinRaw (записи
 *  лежать під ключами YYYY-MM-DD, тож вікно - порівняння ключів).
 *  @param {any} raw @param {string} todayKey @param {number} days */
function windowRaw(raw, todayKey, days) {
  const records = raw?.records && typeof raw.records === 'object' ? raw.records : {};
  const from = addDaysToDateKey(todayKey, -(days - 1));
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const key of Object.keys(records).sort()) {
    if (key >= from && key <= todayKey) out[key] = records[key];
  }
  return { days, from, to: todayKey, records: out };
}

/** Місячні згортки - усі (їх ≤ десятки), тижневі - останній рік.
 *  @param {any} monthly @param {any} weekly */
function buildArchiveBlock(monthly, weekly) {
  const months = monthly && typeof monthly === 'object' ? monthly : null;
  const weeks = weekly && typeof weekly === 'object' ? weekly : null;
  const weekKeys = weeks ? Object.keys(weeks).sort() : [];
  const recentWeeks = weekKeys.slice(-ARCHIVE_WEEKS_IN_DIGEST);
  return {
    monthly: months,
    weekly: weeks ? Object.fromEntries(recentWeeks.map((k) => [k, weeks[k]])) : null,
    weeksTotal: weekKeys.length,
  };
}

/**
 * Драбина зрізу: кожен крок - {name, apply(doc) → true, якщо щось зняв}.
 * Порядок - від найважчого і найменш потрібного звіту до скелета.
 * @type {{ name: string, apply: (doc: any) => boolean }[]}
 */
const WEEKLY_LADDER = [
  step('checkin.raw', (d) => dropKey(d.checkin, 'raw')),
  step('habits.heatmap', (d) => dropKey(d.habits, 'heatmap')),
  step('archive.weekly', (d) => dropKey(d.archive, 'weekly')),
  step('funnel.list.history', (d) => {
    let touched = false;
    for (const row of d.funnel?.list ?? []) {
      if (row && 'history' in row) {
        delete row.history;
        touched = true;
      }
    }
    return touched;
  }),
  step('index', (d) => dropKey(d, 'index')),
  step('checkin.sleepLog', (d) => dropKey(d.checkin, 'sleepLog')),
  step('habits.openRhythm', (d) => dropKey(d.habits, 'openRhythm')),
  step('checkin.series', (d) => dropKey(d.checkin, 'series')),
  step('archive.monthly', (d) => dropKey(d.archive, 'monthly')),
  step('levers', (d) => dropKey(d, 'levers')),
  // Нижче - скелет: цілі блоки по одному, від найменш потрібного звіту.
  // Після цих кроків лишаються заголовок і `dropped`, тобто модель дістає
  // чесний перелік того, чого не побачила, а не обірваний JSON.
  step('interests', (d) => dropKey(d, 'interests')),
  step('mastery', (d) => dropKey(d, 'mastery')),
  step('habits', (d) => dropKey(d, 'habits')),
  step('funnel', (d) => dropKey(d, 'funnel')),
  step('checkin', (d) => dropKey(d, 'checkin')),
  step('reliability', (d) => dropKey(d, 'reliability')),
  step('plan', (d) => dropKey(d, 'plan')),
  step('archive', (d) => dropKey(d, 'archive')),
];

const ARCHIVE_LADDER = [
  step('archive.weekly', (d) => dropKey(d.archive, 'weekly')),
  step('levers', (d) => dropKey(d, 'levers')),
];

/** @param {string} name @param {(doc: any) => boolean} apply */
function step(name, apply) {
  return { name, apply };
}

/** @param {any} obj @param {string} key */
function dropKey(obj, key) {
  if (!obj || typeof obj !== 'object' || !(key in obj) || obj[key] == null) return false;
  obj[key] = null;
  return true;
}

/**
 * Серіалізація зі стелею: знімати блоки драбиною, доки не вміститься; знято -
 * названо в `dropped`. Якщо навіть скелет довший за кап - жорсткий зріз із
 * маркером `"truncated":true` у кінці, щоб модель бачила обрив.
 * @param {Record<string, any>} doc
 * @param {number} cap
 * @param {{ name: string, apply: (doc: any) => boolean }[]} ladder
 * @returns {{ text: string, dropped: string[] }}
 */
export function shrinkToCap(doc, cap, ladder) {
  /** @type {string[]} */
  const dropped = [];
  let text = JSON.stringify({ ...doc, dropped });
  let i = 0;
  while (text.length > cap && i < ladder.length) {
    const s = /** @type {{ name: string, apply: (doc: any) => boolean }} */ (ladder[i]);
    i += 1;
    if (!s.apply(doc)) continue;
    dropped.push(s.name);
    text = JSON.stringify({ ...doc, dropped });
  }
  if (text.length > cap) {
    const tail = ',"truncated":true}';
    text = text.slice(0, Math.max(0, cap - tail.length)) + tail;
  }
  return { text, dropped };
}
