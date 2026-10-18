// data.read scope=weekly | archive (07 §4, етап 3 PR-2): дайджест для
// тижневого звіту. Профіль weekly-review робить ОДИН виклик і має побачити
// всі блоки §1 інструкції цілком - тому тут JSON, а не однорядкові зрізи
// assistant-data-core (той дайджест дописується до транскрипту чату й тому
// капнутий 1 500; тут читач один, кап профільний 50k).
//
// Модуль чистий: на вході вже прочитані агрегати (aggregateStats, архіви,
// важелі, ряди плану), на виході - рядок. Стеля - не «обрізати рядок посередині
// JSON»: semantic compaction скорочує деталі всередині блоків, зберігаючи
// фінансові й особисті підсумки. Недостатній кап дає явний малий manifest,
// а не пакет із тихо видаленими задачами чи фінансами.

import { totalProgress } from '../../roadmap-core.mjs';
import { addDaysToDateKey } from '../../reminders-core.mjs';
import { weekStartKey } from '../../stats-core.mjs';
import { ToolArgumentError } from '../tool-arguments.mjs';
import { compactWeeklyDetails } from './weekly-compaction.mjs';

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
  if (!m)
    throw new ToolArgumentError(`period «${String(raw)}»: очікую Nd, Nw, «тиждень» або «місяць»`);
  const n = Number(m[1]);
  const days = m[2] === 'w' ? n * 7 : n;
  if (days < 1 || days > 366)
    throw new ToolArgumentError(`period «${String(raw)}»: від 1 дня до 366`);
  return days;
}

/**
 * Межі поточного тижня за Києвом (понеділок-неділя) для дати todayKey.
 * @param {string} todayKey YYYY-MM-DD
 */
export function weekBounds(todayKey) {
  // Понеділок - зі stats-core, а не своя копія: архів і звіт мусять кейзити
  // тижні однією арифметикою (шапка stats-archive.mjs про той самий дубль).
  const from = weekStartKey(todayKey);
  return { from, to: addDaysToDateKey(from, 6) };
}

/**
 * @typedef {{
 *   agg: Record<string, any>,
 *   roadmapProgress?: Record<string, any> | null,
 *   archive?: Record<string, any> | null,
 *   weeklyArchive?: Record<string, any> | null,
 *   levers?: Record<string, any> | null,
 *   plans?: Record<string, any> | null,
 *   todayKey: string,
 *   rawDays?: number | null,
 *   cap: number,
 *   sources?: Record<string, any>,
 *   period?: Record<string, any>,
 *   finance?: Record<string, any> | null,
 *   system?: Record<string, any> | null,
 *   personalPeriods?: Record<string, any> | null,
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
  const doc = structuredClone({
    packetVersion: 2,
    scope: 'weekly',
    sources: input.sources ?? {},
    period: input.period ?? null,
    finance: input.finance ?? null,
    system: input.system ?? null,
    personalPeriods: input.personalPeriods ?? null,
    today: todayKey,
    week,
    windows: agg.windows ?? null,
    checkin: {
      raw: windowRaw(agg.checkinRaw, todayKey, rawDays),
      series: agg.checkinSeries ?? null,
      weekly: agg.checkinWeekly ?? null,
      fill: agg.checkinFill
        ? { ...agg.checkinFill, questionnaire: 'legacy', allVersionCoverage: false }
        : null,
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
  });
  if (input.sources?.stats?.status === 'unavailable') {
    for (const key of ['checkin', 'index', 'habits', 'funnel', 'interests', 'reliability'])
      /** @type {any} */ (doc)[key] = null;
    doc.mastery.mock = null;
  }
  if (input.sources?.state?.status === 'unavailable')
    /** @type {any} */ (doc.mastery).roadmap = null;
  for (const level of [0, 1, 2, 3, 4]) {
    if (level) compactWeeklyDetails(doc, level);
    const text = JSON.stringify({ ...doc, dropped: [] });
    if (text.length <= input.cap) return { text, dropped: [] };
  }
  // Never exchange entire business summaries for a misleading partial packet.
  // A caller with an insufficient cap gets a small, explicitly unusable JSON.
  return shrinkToCap(doc, input.cap, []);
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
 *  @param {any} raw @param {string} todayKey @param {number} requestedDays */
function windowRaw(raw, todayKey, requestedDays) {
  const records = raw?.records && typeof raw.records === 'object' ? raw.records : {};
  // Джерело вже обрізане агрегатором (checkinDeep = 90): просити глибше
  // можна, дістати - ні, і заявлена глибина мусить казати правду.
  const sourceDays = Number.isFinite(raw?.days) ? Number(raw.days) : requestedDays;
  const days = Math.min(requestedDays, sourceDays);
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
    const remaining = {
      scope: doc.scope,
      period: doc.period,
      dropped: [...dropped, 'remaining-data'],
      truncated: true,
    };
    text = JSON.stringify(remaining);
    if (text.length > cap)
      text = JSON.stringify({ scope: doc.scope, dropped: ['remaining-data'], truncated: true });
  }
  return { text, dropped };
}
