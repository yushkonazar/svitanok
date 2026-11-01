import { afterEach, describe, expect, it, vi } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { completedWeekPeriod } from '../web/core/report-period.mjs';
import { buildWeeklyDigest } from '../web/core/tools/weekly.mjs';
import { weeklySummary } from '../web/core/tools/weekly-summary.mjs';
import { weeklyPersonalPeriods } from '../web/core/brain/weekly-personal.mjs';
import {
  evaluateWeeklyReport,
  mergeWeeklyEvidence,
  weeklyPacketQuality,
} from '../web/core/brain/weekly-report-quality.mjs';
import {
  parseWeeklyDecision,
  renderWeeklyOverview,
} from '../web/core/brain/weekly-report-format.mjs';
import { weeklyEvidenceFingerprint } from '../web/core/brain/weekly-delivery.mjs';
import { weeklyReportPathForStartParam } from '../web/core/brain/weekly-links.mjs';
import { readWeeklyReports, handleWeeklyReports } from '../web/api-weekly-reports.mjs';
import { runDataRead } from '../web/core/tools/read.mjs';
import { d1FromSqlite } from './helpers/d1.js';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';
import { conciseFixture } from './helpers/weekly-fixture.js';
import { buildInitData } from './helpers/init-data.js';

const NOW = Date.parse('2026-10-26T06:00:00Z'); // Monday 08:00, after Kyiv DST change.
const MIGRATIONS = readdirSync(join(__dirname, '../web/core/migrations'))
  .filter((f) => f.endsWith('.sql'))
  .sort();
const decision = JSON.stringify({
  highlights: [
    { kind: 'finance', text: 'Обліковані витрати — 100 грн; порівняння потребує довшої історії.' },
  ],
  actions: [],
});
afterEach(() => vi.unstubAllGlobals());

describe('completed weekly period and bounded evidence', () => {
  it.each([
    ['2026-10-26T06:00:00Z', '2026-10-19', '2026-10-25', 169],
    ['2026-03-30T05:00:00Z', '2026-03-23', '2026-03-29', 167],
    ['2027-01-04T06:00:00Z', '2026-12-28', '2027-01-03', 168],
  ])(
    'uses complete Kyiv calendar weeks across DST and year boundary (%s)',
    (now, from, to, hours) => {
      const p = completedWeekPeriod(Date.parse(now));
      expect(p).toMatchObject({ dateFrom: from, dateTo: to, complete: true });
      expect(Date.parse(p.to) - Date.parse(p.from)).toBe(hours * 3600000);
    },
  );

  it('preserves useful summaries even when arbitrary categorical maps survive every old compaction level', () => {
    const f = conciseFixture();
    const large = Object.fromEntries(
      Array.from({ length: 5000 }, (_, i) => [
        `context-${i}`,
        'unbounded categorical detail'.repeat(10),
      ]),
    );
    const input = {
      todayKey: f.period.dateTo,
      cap: 50000,
      sources: f.sources,
      period: f.period,
      agg: { checkinTops: large, funnel: { applied: 4 }, reliability: { onTime: 6, total: 7 } },
      plans: f.plan,
      finance: f.finance,
      personalPeriods: f.personalPeriods,
      system: f.system,
    };
    const before = JSON.stringify(input);
    const packet = buildWeeklyDigest(input);
    const doc = JSON.parse(packet.text);
    expect(packet.text.length).toBeLessThan(50000);
    expect(doc).toMatchObject({
      packetVersion: 3,
      dropped: [],
      compaction: { summariesPreserved: true },
    });
    expect(doc.plan.summary).toEqual(f.plan.summary);
    expect(doc.finance.summary).toEqual(f.finance.summary);
    expect(doc.finance.sourceTotals).toEqual(f.finance.sourceTotals);
    expect(
      doc.finance.comparison.weeks.map((w: { expenseMinor: number }) => w.expenseMinor),
    ).toEqual([12000, 12000, 12000, 12000]);
    expect(doc.personalPeriods.current.observationsV3['morning.energy']).toEqual({
      n: 4,
      sum: 16,
      average: 4,
    });
    expect(weeklyPacketQuality(doc).missing).not.toContain('truncated-data');
    expect(JSON.stringify(input)).toBe(before);
  });

  it('includes Sunday answers without timestamps in a completed week and excludes all Monday answers', () => {
    const p = completedWeekPeriod(NOW);
    const checkins = {
      '2026-10-25': { morning: { questionVersion: 3, confirmed: true, energy: 4 } },
      '2026-10-26': { morning: { questionVersion: 3, confirmed: true, energy: 1 } },
    };
    const current = weeklyPersonalPeriods(checkins, NOW, p).current;
    expect(current.observationsV3['morning.energy']).toMatchObject({ n: 1, average: 4 });
    expect(current.unknownTimingSlots).toBe(0);
  });

  it('reads plan, finance, personal and telemetry with the identical closed week and leaves storage unchanged', async () => {
    const d1 = d1FromSqlite(MIGRATIONS);
    const kv = new Map([
      ['stats', JSON.stringify({ checkins: {} })],
      ['state', '{}'],
    ]);
    const env = workerEnv({ DB: d1.stub, BRIEFING: memoryKv(kv) });
    const before = d1.db.prepare('SELECT * FROM transactions').all();
    const doc = JSON.parse((await runDataRead(env, { scope: 'weekly' }, NOW)).result);
    for (const p of [
      doc.finance.period,
      doc.personalPeriods.current.period,
      doc.plan.period,
      doc.system.period,
    ])
      expect([p.from, p.to]).toEqual([doc.period.from, doc.period.to]);
    expect(doc.period).toMatchObject({
      complete: true,
      dateFrom: '2026-10-19',
      dateTo: '2026-10-25',
    });
    expect(d1.db.prepare('SELECT * FROM transactions').all()).toEqual(before);
  });
});

describe('short report contract, coverage and recovery', () => {
  it('never publishes raw decision JSON when no prepared evidence was read', async () => {
    const result = await evaluateWeeklyReport(workerEnv({}), decision, NOW);
    expect(result.status).toBe('failed');
    expect(result.overview?.text).not.toContain('highlights');
    expect(result.overview?.text).toContain('Не вдалося');
  });

  it('retains detail-omission flags through stored projections and uses numeric sample denominators', () => {
    const f = conciseFixture();
    const first = weeklySummary({
      ...f,
      plan: {
        ...f.plan,
        tasks: Array.from({ length: 20 }, (_, i) => ({ id: `t-${i}`, title: 'Task' })),
      },
    });
    expect(weeklySummary(first).plan?.taskDetailsOmitted).toBe(true);
    const details = weeklySummary({
      ...f,
      personalPeriods: {
        current: { observationsV3: { 'morning.energy': { n: 6, numericN: 3, average: 4 } } },
        previousWeeks: [
          { observationsV3: { 'morning.energy': { n: 4, numericN: 3, average: 3 } } },
        ],
      },
    });
    const fallback = renderWeeklyOverview('non-JSON', { period: f.period, details, missing: [] });
    expect(fallback.text).toContain('3 і 3 відповідей');
  });
  it('does not make an otherwise usable overview partial solely for unpriced historical API events', async () => {
    const d1 = d1FromSqlite(MIGRATIONS);
    const context = weeklyPacketQuality(conciseFixture());
    d1.db
      .prepare(
        `INSERT INTO runs(id,trigger,profile,started_at,weekly_context_json) VALUES('weekly-test','chat','weekly-review',?,?)`,
      )
      .run(new Date(NOW).toISOString(), JSON.stringify(context));
    const q = await evaluateWeeklyReport(workerEnv({ DB: d1.stub }), decision, NOW, {
      runId: 'weekly-test',
    });
    expect(q.status).toBe('ready');
    expect(q.missing).toContain('system-cost-coverage');
    expect(q.retryable).toEqual([]);
    expect(q.overview?.text).toContain('19.10 — 25.10');
    expect(q.overview?.text.length).toBeLessThanOrEqual(2200);
    expect(q.overview?.text).not.toContain('СИСТЕМА');
    expect(q.overview?.text).not.toContain('140');
  });

  it('keeps a provider failure failed, while long or malformed model formatting uses checked facts', () => {
    const details = weeklySummary(conciseFixture());
    const quality = { period: details.period, details, missing: [] };
    expect(renderWeeklyOverview(decision, quality, true).valid).toBe(false);
    const fallback = renderWeeklyOverview('A very long answer '.repeat(1000), quality);
    expect(fallback).toMatchObject({ valid: true, fallback: true });
    expect(fallback.text.length).toBeLessThanOrEqual(2200);
    expect(fallback.text).toContain('100');
    expect(
      parseWeeklyDecision(
        JSON.stringify({
          highlights: [{ kind: ['finance'], text: 'Wrong kind type' }],
          actions: [],
        }),
      ),
    ).toBeNull();
    expect(
      parseWeeklyDecision(JSON.stringify({ highlights: [], actions: ['a', 'b', 'c'] })),
    ).toBeNull();
    expect(
      parseWeeklyDecision(
        JSON.stringify({
          highlights: [{ kind: 'system', text: 'internal inventory' }],
          actions: [],
        }),
      ),
    ).toBeNull();
  });

  it('repairs only the exact all-source expense coverage, keeping unreturned context and baselines missing', () => {
    const f = conciseFixture();
    const packet = {
      ...f,
      finance: null,
      sources: { ...f.sources, finance: { status: 'unavailable' } },
    };
    const context = weeklyPacketQuality(packet);
    const result = {
      mode: 'analytics',
      selection: { period: f.period },
      summary: f.finance.summary,
      sourceTotals: f.finance.sourceTotals,
      categories: f.finance.categories,
      quality: f.finance.quality,
    };
    const args = { period: '2026-10-19..2026-10-25', view: 'analytics' };
    const next = mergeWeeklyEvidence(context, 'finance.query', args, result);
    expect(next.missing).not.toContain('finance');
    expect(next.missing).toEqual(
      expect.arrayContaining([
        'finance-context-coverage',
        'finance-comparison',
        'finance-evidence-coverage',
      ]),
    );
    expect(next.sources.finance.coverage).toBe('expenses-only');
    expect(next.details.finance.context).toBeNull();
    expect(next.retryable).not.toContain('finance');
    expect(
      mergeWeeklyEvidence(context, 'finance.query', { ...args, account: 'one-card' }, result),
    ).toBe(context);
    expect(
      mergeWeeklyEvidence(context, 'finance.query', args, {
        ...result,
        selection: { period: completedWeekPeriod(NOW - 7 * 86400000) },
      }),
    ).toBe(context);
  });

  it('ignores cost/call count changes and prose but detects changed owner results and money', async () => {
    const f = conciseFixture(),
      quality = weeklyPacketQuality(f);
    const q = {
      ...quality,
      status: 'ready',
      periodFrom: f.period.dateFrom,
      periodTo: f.period.dateTo,
    };
    const before = await weeklyEvidenceFingerprint(q);
    const other = structuredClone(q);
    Object.assign(other.details!.system!.costs!.month!, { estimatedUsd: 4.56 });
    Object.assign(other.details!.system!.runs!, { total: 200 });
    expect(await weeklyEvidenceFingerprint(other)).toBe(before);
    other.details!.finance!.summary!.expenseMinor = 10001;
    expect(await weeklyEvidenceFingerprint(other)).not.toBe(before);
  });
  it('detects corrections to personal comparison bases and next-week deadlines', async () => {
    const f = conciseFixture();
    const q = {
      ...weeklyPacketQuality(f),
      status: 'ready',
      periodFrom: f.period.dateFrom,
      periodTo: f.period.dateTo,
    };
    q.details!.personalPeriods!.previousWeeks = [
      { observationsV3: { 'morning.energy': { n: 4, average: 3 } } },
    ];
    const baseline = await weeklyEvidenceFingerprint(q);
    q.details!.personalPeriods!.previousWeeks[0].observationsV3['morning.energy'].average = 4;
    expect(await weeklyEvidenceFingerprint(q)).not.toBe(baseline);
    q.details!.plan!.upcomingOutsidePeriod.tasks = [{ id: 'next', dueAt: '2026-10-27T08:00:00Z' }];
    const deadline = await weeklyEvidenceFingerprint(q);
    q.details!.plan!.upcomingOutsidePeriod.tasks[0]!.dueAt = '2026-10-28T08:00:00Z';
    expect(await weeklyEvidenceFingerprint(q)).not.toBe(deadline);
  });
});

describe('private saved overview workspace', () => {
  it('keeps a good saved version visible after a failed update and hides provider errors', async () => {
    const d1 = d1FromSqlite(MIGRATIONS);
    const insert = d1.db
      .prepare(`INSERT INTO reports(id,kind,period_from,period_to,text_md,status,created_at,quality_json)
      VALUES(?,'weekly','2026-10-19','2026-10-25',?,?,?,?)`);
    insert.run(
      'good',
      '📊 Тиждень 19.10 — 25.10\n• Гроші: Обліковано 100 грн.',
      'partial',
      '2026-10-26T06:00:00Z',
      JSON.stringify(weeklyPacketQuality(conciseFixture())),
    );
    insert.run('error', 'raw provider error PRIVATE', 'failed', '2026-10-26T10:00:00Z', '{}');
    const data = await readWeeklyReports(workerEnv({ DB: d1.stub }));
    expect(data.report?.id).toBe('good');
    expect(data.history).toHaveLength(1);
    expect(JSON.stringify(data)).not.toContain('PRIVATE');
    const empty = await readWeeklyReports(workerEnv({ DB: d1.stub }), '2026-10-12');
    expect(empty.report).toBeNull();
  });

  it('requires owner authentication and does not generate reports on reads', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const response = await handleWeeklyReports(
      new Request('https://test/api/reports/weekly'),
      workerEnv({}),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(fetch).not.toHaveBeenCalled();
    expect(
      (
        await handleWeeklyReports(
          new Request('https://test/api/reports/weekly', { method: 'POST' }),
          workerEnv({}),
        )
      ).status,
    ).toBe(405);
  });

  it('keeps saved finance and system details primary-owner only and rejects invalid calendar dates', async () => {
    const d1 = d1FromSqlite(MIGRATIONS);
    const env = workerEnv({
      DB: d1.stub,
      TELEGRAM_BOT_TOKEN: 'synthetic-bot',
      TELEGRAM_OWNER_USER_ID: '1',
      TELEGRAM_COOWNER_USER_IDS: '2',
    });
    const coowner = await buildInitData(2, 'synthetic-bot');
    expect(
      (
        await handleWeeklyReports(
          new Request('https://test/api/reports/weekly', {
            headers: { 'X-Telegram-Init-Data': coowner },
          }),
          env,
        )
      ).status,
    ).toBe(403);
    const owner = await buildInitData(1, 'synthetic-bot');
    const headers = { 'X-Telegram-Init-Data': owner };
    expect(
      (await handleWeeklyReports(new Request('https://test/api/reports/weekly', { headers }), env))
        .status,
    ).toBe(200);
    expect(
      (
        await handleWeeklyReports(
          new Request('https://test/api/reports/weekly?week=2026-02-30', { headers }),
          env,
        )
      ).status,
    ).toBe(400);
  });

  it.each(['weekly_20260230', 'weekly_20261301', 'weekly_99999999', 'weekly_<script>'])(
    'rejects invalid exact navigation %s',
    (value) => {
      expect(weeklyReportPathForStartParam(value)).toBeNull();
    },
  );
  it('links the actual saved week without executing an action', () => {
    expect(weeklyReportPathForStartParam('weekly_20261019')).toBe('/weekly-report?week=2026-10-19');
  });
});
