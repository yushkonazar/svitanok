// data.read scope=weekly | archive (етап 3 PR-2): дайджест для тижневого
// звіту - усі блоки §1 weekly-review.md одним читанням, стеля 50k через
// драбину зрізу (знімає блоки й КАЖЕ, що зняла), period звужує сирі серії,
// план дня - зі справжньої міграції 0007 у node:sqlite.

import { describe, it, expect } from 'vitest';
import { aggregateStats } from '../web/stats-core.mjs';
import {
  buildWeeklyDigest,
  buildArchiveDigest,
  shrinkToCap,
  parsePeriodDays,
  weekBounds,
  WEEKLY_RAW_DAYS,
} from '../web/core/tools/weekly.mjs';
import {
  runDataRead,
  DATA_READ_WEEKLY_CAP,
  DATA_READ_DEFAULT_CAP,
  DATA_READ_SCOPES,
} from '../web/core/tools/read.mjs';
import { ARCHIVE_KEY, WEEKLY_ARCHIVE_KEY } from '../web/stats-archive.mjs';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';
import { d1FromSqlite } from './helpers/d1.js';

// Середа 02.09.2026 12:00 Київ (09:00Z).
const NOW = Date.parse('2026-09-02T09:00:00.000Z');
const TODAY = '2026-09-02';

/** Стор із чек-інами за N діб назад від TODAY. */
function statsWithCheckins(days: number) {
  const checkins: Record<string, unknown> = {};
  for (let i = 0; i < days; i += 1) {
    const d = new Date(`${TODAY}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    checkins[key] = {
      morning: { sleepH: 7, energy: 3, mood: 3 },
      evening: { dayScore: 3, sleepH: 7 },
    };
  }
  return { checkins, days: {}, funnel: {}, funnelMeta: {}, appliedLog: [] };
}

describe('parsePeriodDays / weekBounds', () => {
  it('Nd, Nw, слова; порожнє - null; крива форма - помилка', () => {
    expect(parsePeriodDays('30d')).toBe(30);
    expect(parsePeriodDays('12w')).toBe(84);
    expect(parsePeriodDays('тиждень')).toBe(7);
    expect(parsePeriodDays('місяць')).toBe(30);
    expect(parsePeriodDays(undefined)).toBeNull();
    expect(parsePeriodDays('')).toBeNull();
    expect(() => parsePeriodDays('завтра')).toThrow(/period/);
    expect(() => parsePeriodDays('0d')).toThrow(/від 1 дня/);
    expect(() => parsePeriodDays('60w')).toThrow(/366/);
  });

  it('тиждень понеділок-неділя за Києвом: середа → пн 31.08 … нд 06.09; неділя лишається в своєму тижні', () => {
    expect(weekBounds('2026-09-02')).toEqual({ from: '2026-08-31', to: '2026-09-06' });
    expect(weekBounds('2026-09-06')).toEqual({ from: '2026-08-31', to: '2026-09-06' });
    expect(weekBounds('2026-09-07')).toEqual({ from: '2026-09-07', to: '2026-09-13' });
  });
});

describe('buildWeeklyDigest', () => {
  const agg = aggregateStats(statsWithCheckins(120), TODAY);

  it('усі блоки §1 на місці, JSON валідний, нічого не знято при щедрому капі', () => {
    const { text, dropped } = buildWeeklyDigest({
      agg,
      roadmapProgress: {},
      archive: { '2026-07': { checkinDays: 20 } },
      weeklyArchive: { '2026-08-24': { checkinDays: 7 } },
      levers: { weeksUsable: 12 },
      plans: { days: [], items: [] },
      todayKey: TODAY,
      cap: DATA_READ_WEEKLY_CAP,
    });
    const doc = JSON.parse(text);
    expect(dropped).toEqual([]);
    expect(doc.scope).toBe('weekly');
    expect(doc.week).toEqual({ from: '2026-08-31', to: '2026-09-06' });
    for (const block of [
      'checkin',
      'index',
      'habits',
      'funnel',
      'mastery',
      'interests',
      'reliability',
      'plan',
      'archive',
      'levers',
    ]) {
      expect(doc[block]).toBeDefined();
    }
    // Глибина сирих чек-інів - вікно моделі, не весь стор (120 діб у сторі).
    expect(doc.checkin.raw.days).toBe(WEEKLY_RAW_DAYS);
    expect(Object.keys(doc.checkin.raw.records)).toHaveLength(90);
    expect(doc.archive.monthly['2026-07'].checkinDays).toBe(20);
    expect(doc.archive.weeksTotal).toBe(1);
  });

  it('period звужує сирі серії (rawDays), решта блоків незмінна', () => {
    const { text } = buildWeeklyDigest({
      agg,
      plans: { days: [], items: [] },
      todayKey: TODAY,
      rawDays: 7,
      cap: DATA_READ_WEEKLY_CAP,
    });
    const doc = JSON.parse(text);
    expect(doc.checkin.raw.days).toBe(7);
    expect(Object.keys(doc.checkin.raw.records)).toHaveLength(7);
    expect(doc.checkin.raw.from).toBe('2026-08-27');
    expect(doc.checkin.series).not.toBeNull();
  });

  it('тісний кап: драбина знімає блоки по порядку і називає їх; текст ≤ cap і лишається JSON', () => {
    const { text, dropped } = buildWeeklyDigest({
      agg,
      plans: { days: [], items: [] },
      archive: { '2026-07': { checkinDays: 20 } },
      weeklyArchive: Object.fromEntries(
        Array.from({ length: 60 }, (_, i) => [`2025-0${(i % 9) + 1}-${10 + (i % 19)}`, { x: i }]),
      ),
      todayKey: TODAY,
      cap: 6_000,
    });
    expect(text.length).toBeLessThanOrEqual(6_000);
    const doc = JSON.parse(text);
    expect(dropped[0]).toBe('checkin.raw');
    expect(doc.checkin.raw).toBeNull();
    expect(doc.dropped).toEqual(dropped);
    // Скелет цілий - модель бачить, ЩО саме зняли, а не обірваний документ.
    expect(doc.truncated).toBeUndefined();
  });

  it('кап менший за скелет - жорсткий зріз із маркером truncated', () => {
    const { text } = shrinkToCap({ a: 'x'.repeat(2_000), b: 'y'.repeat(2_000) }, 600, []);
    expect(text.length).toBe(600);
    expect(text.endsWith(',"truncated":true}')).toBe(true);
  });
});

describe('buildArchiveDigest', () => {
  it('лише холодні згортки + важелі; тижневих - останній рік', () => {
    const weeks = Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [
        `2025-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}-${i}`,
        { i },
      ]),
    );
    const { text } = buildArchiveDigest({
      archive: { '2026-01': { checkinDays: 3 } },
      weeklyArchive: weeks,
      levers: null,
      todayKey: TODAY,
      cap: DATA_READ_DEFAULT_CAP,
    });
    const doc = JSON.parse(text);
    expect(doc.scope).toBe('archive');
    expect(Object.keys(doc.archive.weekly)).toHaveLength(52);
    expect(doc.archive.weeksTotal).toBe(60);
    expect(doc.levers).toBeNull();
    expect(doc.checkin).toBeUndefined();
  });
});

describe('runDataRead: weekly і archive наскрізь (KV + D1 0007)', () => {
  function env(planRows = true) {
    const store = new Map<string, string>([
      ['stats', JSON.stringify(statsWithCheckins(30))],
      ['state', JSON.stringify({ roadmapProgress: {} })],
      [ARCHIVE_KEY, JSON.stringify({ '2026-06': { checkinDays: 12 } })],
      [WEEKLY_ARCHIVE_KEY, JSON.stringify({ '2026-08-17': { checkinDays: 5 } })],
      ['levers', JSON.stringify({ weeksUsable: 9 })],
    ]);
    const d1 = d1FromSqlite(['0007_instructions_plans.sql']);
    if (planRows) {
      d1.db
        .prepare(
          `INSERT INTO day_plans (date, status, fill_ratio, created_at) VALUES ('2026-09-01', 'reviewed', 0.6, '2026-08-31T18:00:00Z')`,
        )
        .run();
      d1.db
        .prepare(
          `INSERT INTO plan_items (id, date, title, kind, est_min, window_start, window_end, status, done_at)
           VALUES ('i1', '2026-09-01', 'Презентація', 'deep', 90, '09:00', '10:30', 'done', '2026-09-01T08:20:00Z')`,
        )
        .run();
    }
    return workerEnv({ BRIEFING: memoryKv(store), DB: d1.stub });
  }

  it('скоупи етапу 3 у переліку', () => {
    expect(DATA_READ_SCOPES).toContain('weekly');
    expect(DATA_READ_SCOPES).toContain('archive');
  });

  it('weekly: кап 50k за замовчуванням, план дня з D1, архів і важелі з KV', async () => {
    const { result } = await runDataRead(env(), { scope: 'weekly' }, NOW);
    const text = String(result);
    expect(text.length).toBeLessThanOrEqual(DATA_READ_WEEKLY_CAP);
    const doc = JSON.parse(text);
    expect(doc.scope).toBe('weekly');
    expect(doc.plan.days).toEqual([
      expect.objectContaining({ date: '2026-09-01', status: 'reviewed', fill_ratio: 0.6 }),
    ]);
    expect(doc.plan.items[0]).toEqual(
      expect.objectContaining({ title: 'Презентація', status: 'done', est_min: 90 }),
    );
    expect(doc.archive.monthly['2026-06'].checkinDays).toBe(12);
    expect(doc.levers.weeksUsable).toBe(9);
    expect(Object.keys(doc.checkin.raw.records)).toHaveLength(30);
  });

  it('weekly з period=7d - сім діб сирих; крива period - помилка контракту ДО читань', async () => {
    const { result } = await runDataRead(env(), { scope: 'weekly', period: '7d' }, NOW);
    expect(Object.keys(JSON.parse(String(result)).checkin.raw.records)).toHaveLength(7);
    await expect(runDataRead(env(), { scope: 'weekly', period: 'колись' }, NOW)).rejects.toThrow(
      /period/,
    );
  });

  it('weekly без DB - блок плану з error, решта читається', async () => {
    const e = env();
    e.DB = undefined;
    const doc = JSON.parse(String((await runDataRead(e, { scope: 'weekly' }, NOW)).result));
    expect(doc.plan.error).toMatch(/DB/);
    expect(doc.habits).toBeDefined();
  });

  it('archive: кап chat 12k, без чек-інів', async () => {
    const { result } = await runDataRead(env(), { scope: 'archive' }, NOW);
    const text = String(result);
    expect(text.length).toBeLessThanOrEqual(DATA_READ_DEFAULT_CAP);
    const doc = JSON.parse(text);
    expect(doc.scope).toBe('archive');
    expect(doc.archive.weekly['2026-08-17'].checkinDays).toBe(5);
    expect(doc.checkin).toBeUndefined();
  });

  it('cap понад стелю ріжеться до 50k, менший за 500 піднімається до 500', async () => {
    const big = await runDataRead(env(), { scope: 'weekly', cap: 999_999 }, NOW);
    expect(String(big.result).length).toBeLessThanOrEqual(DATA_READ_WEEKLY_CAP);
    const tiny = await runDataRead(env(), { scope: 'weekly', cap: 10 }, NOW);
    expect(String(tiny.result).length).toBeLessThanOrEqual(500);
  });
});
