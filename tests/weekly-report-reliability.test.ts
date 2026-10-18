import { afterEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { d1FromSqlite } from './helpers/d1.js';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';
import { readWeeklyFinance } from '../web/core/brain/weekly-finance.mjs';
import { weeklyPersonalPeriods } from '../web/core/brain/weekly-personal.mjs';
import { buildWeeklyReviewInput, saveWeeklyReport } from '../web/core/brain/weekly-review.mjs';
import {
  evaluateWeeklyReport,
  weeklyTextStatus,
} from '../web/core/brain/weekly-report-quality.mjs';
import { readFinanceAnalytics } from '../web/core/finance/analytics-store.mjs';
import { analyticsSelection } from '../web/core/finance/analytics.mjs';
import { runDataRead } from '../web/core/tools/read.mjs';
import { runRunsQuery } from '../web/core/tools/runs.mjs';
import { readReportState } from '../web/kv-store.mjs';
import { reportPeriod } from '../web/core/report-period.mjs';
import { handleInternal } from '../web/core/internal/router.mjs';
import { CoreClient } from '../brain/src/core-client.js';
import { makeRunner, type EngineRunOptions } from '../brain/src/agent.js';
import { instructionHash } from '../brain/src/instructions.js';

const NOW = Date.parse('2026-10-18T06:00:00.000Z'); // Sunday, Kyiv 09:00.
const TEXT =
  '📊 Тиждень 12.10 — 18.10\n\nГРОШІ\n• Усі рахунки: 7 780,23 грн.\n\nСИСТЕМА\n• Телеметрію прочитано.\n\nЩО ЗРОБИТИ\nЦього тижня від тебе нічого не потрібно';
const migrations = readdirSync(join(__dirname, '..', 'web/core/migrations'))
  .filter((f) => f.endsWith('.sql'))
  .sort();
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function setup() {
  const d1 = d1FromSqlite(migrations);
  const kv = new Map<string, string>([
    ['stats', JSON.stringify({ checkins: {} })],
    ['state', '{}'],
  ]);
  const env = workerEnv({ DB: d1.stub, BRIEFING: memoryKv(kv) });
  const add = (
    id: string,
    amount: number,
    options: { at?: string; bank?: boolean; kind?: string; uah?: number | null } = {},
  ) => {
    d1.db
      .prepare(
        'INSERT INTO transactions(id,at,amount,currency,amount_uah,description,category,flags_json,raw_json) VALUES(?,?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        options.at ?? '2026-10-12T09:00:00.000Z',
        amount,
        'UAH',
        options.uah === undefined ? amount : options.uah,
        'магазин',
        'продукти',
        '[]',
        JSON.stringify({
          ...(options.bank ? { account: 'card' } : {}),
          financeKind: options.kind ?? 'expense',
        }),
      );
  };
  // Imported history covers all four comparison windows, without inventing data.
  add('oldest', -1, { at: '2026-08-01T09:00:00.000Z', bank: true });
  return { d1, env, kv, add };
}

// Public fixtures are synthetic and contain no live owner amounts.
function exampleSlice(s: ReturnType<typeof setup>) {
  for (let i = 0; i < 17; i++) s.add(`mono-${i}`, -(i === 16 ? 456789 - 16 : 1), { bank: true });
  for (let i = 0; i < 6; i++) s.add(`manual-${i}`, -(i === 5 ? 321234 - 5 : 1));
  s.add('own-transfer', -900000, { kind: 'transfer', bank: true });
  s.add('fleet', -800000, { kind: 'taxi-settlement' });
  s.add('income', 600000, { kind: 'income' });
}

describe('weekly report reliability, synthetic weekly slice', () => {
  it('applies the additive migration without rewriting old reviews or manual financial rows', () => {
    const legacy = new DatabaseSync(':memory:');
    for (const file of migrations.filter((f) => !f.startsWith('0045_')))
      legacy.exec(readFileSync(join(__dirname, '..', 'web/core/migrations', file), 'utf8'));
    legacy
      .prepare(
        "INSERT INTO reports(id,kind,period_from,period_to,text_md,created_at) VALUES('old','weekly','2026-10-05','2026-10-11',?,'2026-10-11T06:00:00Z')",
      )
      .run('⚠️ Немає кредиту');
    legacy
      .prepare(
        "INSERT INTO transactions(id,at,amount,currency,amount_uah,description,raw_json) VALUES('manual','2026-10-12T09:00:00Z',-321234,'UAH',-321234,'Ручний запис','{}')",
      )
      .run();
    const reviews = legacy.prepare('SELECT * FROM reports').all();
    const transactions = legacy.prepare('SELECT * FROM transactions').all();
    legacy.exec(
      readFileSync(
        join(__dirname, '..', 'web/core/migrations/0045_weekly_report_quality.sql'),
        'utf8',
      ),
    );
    const after = legacy
      .prepare(
        'SELECT id,kind,period_from,period_to,text_md,instruction_hash,created_at FROM reports',
      )
      .all();
    expect(after).toEqual(reviews);
    expect(legacy.prepare('SELECT status FROM reports').get()?.status).toBeNull();
    expect(legacy.prepare('SELECT * FROM transactions').all()).toEqual(transactions);
    legacy.close();
  });

  it('matches the dashboard exactly: 4567.89 Mono + 3212.34 manual = 7780.23 UAH / 23, preserving ledger rows', async () => {
    const s = setup();
    exampleSlice(s);
    const before = s.d1.db.prepare('SELECT * FROM transactions ORDER BY id').all();
    const weekly = await readWeeklyFinance(s.env, NOW);
    const dashboard = await readFinanceAnalytics(
      s.env,
      new URLSearchParams({ from: '2026-10-12', to: '2026-10-18' }),
      NOW,
    );
    expect(weekly.summary).toEqual(dashboard.summary);
    expect(weekly.summary).toMatchObject({ expenseMinor: 778023, count: 23 });
    expect(weekly.sourceTotals).toEqual({
      mono: { expenseMinor: 456789, count: 17 },
      manual: { expenseMinor: 321234, count: 6 },
    });
    expect(s.d1.db.prepare('SELECT * FROM transactions ORDER BY id').all()).toEqual(before);
  });

  it('compares four matching Monday–Sunday 09:00 slices, excluding later Sunday purchases', async () => {
    const s = setup();
    s.add('now', -10000);
    for (const [i, monday, sunday] of [
      [1, '2026-10-05', '2026-10-11'],
      [2, '2026-09-28', '2026-10-04'],
      [3, '2026-09-21', '2026-09-27'],
      [4, '2026-09-14', '2026-09-20'],
    ] as const) {
      s.add(`baseline-${i}`, -20000, { at: `${monday}T09:00:00.000Z` });
      s.add(`after-${i}`, -999999, { at: `${sunday}T06:00:00.001Z` });
    }
    s.add('after-cutoff', -999999, { at: '2026-10-18T06:00:00.001Z' });
    const f = await readWeeklyFinance(s.env, NOW);
    expect(f.summary.expenseMinor).toBe(10000);
    expect(f.comparison).toMatchObject({
      complete: true,
      averageExpenseMinor: 20000,
      changeBps: -5000,
    });
    expect(f.comparison.weeks.map((w) => w.expenseMinor)).toEqual([20000, 20000, 20000, 20000]);
  });

  it('exposes missing baseline coverage, keeping a zero baseline percentage unknown', async () => {
    const s = setup();
    const zero = await readWeeklyFinance(s.env, NOW);
    expect(zero.comparison.averageExpenseMinor).toBe(0);
    expect(zero.comparison.changeBps).toBeNull();
    s.d1.db.prepare("DELETE FROM transactions WHERE id = 'oldest'").run();
    s.add('first-record', -10);
    const missing = await readWeeklyFinance(s.env, NOW);
    expect(missing.comparison.complete).toBe(false);
    expect(missing.comparison.averageExpenseMinor).toBeNull();
    expect(missing.comparison.changeBps).toBeNull();
  });

  it('does not present a percentage against unconverted baseline expenses', async () => {
    const s = setup();
    s.add('current', -100);
    s.add('unknown-uah', -500, { at: '2026-10-05T09:00:00Z', uah: null });
    const report = await readWeeklyFinance(s.env, NOW);
    expect(report.comparison.complete).toBe(false);
    expect(report.comparison.weeks[0]?.status).toBe('incomplete-data');
    expect(report.comparison.changeBps).toBeNull();
  });

  it('uses Kyiv midnight and equal wall time across DST and month comparison', () => {
    const day = reportPeriod('2026-10-25', '2026-10-25', Date.parse('2026-10-27T00:00:00Z'));
    expect(Date.parse(day.to) - Date.parse(day.from)).toBe(25 * 3600000);
    const s = analyticsSelection(
      new URLSearchParams({ from: '2026-10-19', to: '2026-10-25' }),
      Date.parse('2026-10-25T07:00:00Z'),
    );
    expect(s.period?.from).toBe('2026-10-18T21:00:00.000Z');
    expect(s.previousPeriod?.to).toBe('2026-10-18T06:00:00.001Z');
    const month = analyticsSelection(
      new URLSearchParams({ from: '2026-10-01', to: '2026-10-14', comparison: 'month' }),
      Date.parse('2026-10-14T06:00:00Z'),
    );
    expect(month.previousPeriod?.to).toBe('2026-09-14T06:00:00.001Z');
  });

  it('uses the same absolute telemetry window and excludes 11 October and future runs', async () => {
    const s = setup();
    const insert = s.d1.db.prepare(
      "INSERT INTO runs(id,trigger,profile,started_at,error) VALUES(?,'chat','chat',?,?)",
    );
    insert.run('before', '2026-10-11T20:59:59.999Z', 'old-error');
    insert.run('inside', '2026-10-11T21:00:00.000Z', null);
    insert.run('last', '2026-10-18T06:00:00.000Z', null);
    insert.run('after', '2026-10-18T06:00:00.001Z', 'future-error');
    const packet = JSON.parse((await runDataRead(s.env, { scope: 'weekly' }, NOW)).result);
    expect(packet.system.period.from).toBe(packet.period.from);
    expect(packet.system.period.to).toBe(packet.period.to);
    expect(packet.finance.period.to).toBe(packet.period.to);
    expect(packet.system.runs.total).toBe(2);
    expect(packet.system.runs.errors).toEqual([]);
  });

  it('aligns personal baselines and excludes later Sunday answers without altering check-ins', () => {
    const records = {
      '2026-10-18': {
        morning: { sleepH: 7, ts: '2026-10-18T05:00:00Z' },
        evening: { dayScore: 5, ts: '2026-10-18T17:00:00Z' },
      },
      '2026-10-11': {
        morning: { sleepH: 6, ts: '2026-10-11T05:00:00Z' },
        evening: { dayScore: 1, ts: '2026-10-11T17:00:00Z' },
      },
    };
    const before = JSON.stringify(records);
    const metrics = weeklyPersonalPeriods(records, NOW);
    expect(metrics.current.legacy.sleepHours).toEqual({ n: 1, average: 7 });
    expect(metrics.current.legacy.dayScore.n).toBe(0);
    expect(metrics.previousWeeks[0]?.legacy.sleepHours).toEqual({ n: 1, average: 6 });
    expect(metrics.previousWeeks[0]?.legacy.dayScore.n).toBe(0);
    expect(JSON.stringify(records)).toBe(before);
    const unknown = weeklyPersonalPeriods({ '2026-10-18': { morning: { sleepH: 7 } } }, NOW);
    expect(unknown.current.unknownTimingSlots).toBe(1);
    expect(unknown.current.legacy.sleepHours.n).toBe(0);
  });

  it('keeps other sources when personal statistics are unreadable, distinguishing empty data', async () => {
    const s = setup();
    exampleSlice(s);
    s.kv.set('stats', '{corrupt');
    const packet = JSON.parse((await runDataRead(s.env, { scope: 'weekly' }, NOW)).result);
    expect(packet.sources.stats.status).toBe('unavailable');
    expect(packet.sources.archive.status).toBe('empty');
    expect(packet.checkin).toBeNull();
    expect(packet.finance.summary.expenseMinor).toBe(778023);
    expect(packet.system.runs.total).toBe(0);
    expect(s.kv.get('stats')).toBe('{corrupt');
  });

  it('reads canonical personal data without seeding or consulting a broken KV mirror', async () => {
    const s = setup();
    const value = { checkins: { '2026-10-12': { morning: { sleepH: 7 } } } };
    const peek = vi.fn(async () => ({ version: 3, value }));
    const read = vi.fn();
    const get = vi.fn(async () => {
      throw new Error('storage-down');
    });
    const env = workerEnv({
      ...s.env,
      BRIEFING: { ...s.env.BRIEFING, get },
      STATE_STORE: { getByName: () => ({ peek, read }) },
    });
    expect(await readReportState(env, 'stats')).toEqual(value);
    expect(get).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it('returns valid JSON with an explicit gap when the packet cannot fit its cap', async () => {
    const s = setup();
    const text = (await runDataRead(s.env, { scope: 'weekly', cap: 500 }, NOW)).result;
    expect(text.length).toBeLessThanOrEqual(500);
    expect(JSON.parse(text)).toMatchObject({ truncated: true });
  });

  it('retains old failure rows but selects the previous usable review', async () => {
    const s = setup();
    const insert = s.d1.db.prepare(
      "INSERT INTO reports(id,kind,period_from,period_to,text_md,created_at) VALUES(?,'weekly',?,?,?,?)",
    );
    insert.run(
      'good',
      '2026-09-28',
      '2026-10-04',
      TEXT.replace('12.10 — 18.10', '28.09 — 04.10'),
      '2026-10-04T06:00:00Z',
    );
    insert.run(
      'bad',
      '2026-10-05',
      '2026-10-11',
      '⚠️ Вичерпано бюджет або кредит',
      '2026-10-11T06:00:00Z',
    );
    const input = await buildWeeklyReviewInput(s.env, NOW);
    expect(input.text).toContain('2026-09-28 - 2026-10-04');
    expect(input.text).not.toContain('Вичерпано бюджет');
    expect(s.d1.db.prepare('SELECT count(*) AS n FROM reports').get()?.n).toBe(2);
  });

  it('separates complete, partial and failed content and pins a delayed delivery to its original week', async () => {
    const s = setup();
    s.d1.db
      .prepare(
        "INSERT INTO runs(id,trigger,profile,started_at,weekly_context_json) VALUES('r','chat','weekly-review',?,?)",
      )
      .run(
        new Date(NOW).toISOString(),
        JSON.stringify({ missing: [], sources: { stats: { status: 'available' } } }),
      );
    expect((await evaluateWeeklyReport(s.env, TEXT, NOW, { runId: 'r' })).status).toBe('ready');
    expect(
      (
        await evaluateWeeklyReport(s.env, `${TEXT}\n\nЧОГО Я НЕ БАЧИВ\n• Сон недоступний`, NOW, {
          runId: 'r',
        })
      ).status,
    ).toBe('partial');
    expect(
      (await evaluateWeeklyReport(s.env, TEXT, NOW, { runId: 'r', failed: true })).status,
    ).toBe('failed');
    expect(weeklyTextStatus('⚠️ Немає кредиту')).toBe('failed');
    expect(
      weeklyTextStatus(TEXT.replace('📊 Тиждень 12.10 — 18.10', '# **📊 Тиждень 12.10 — 18.10**')),
    ).toBe('ready');
    const saved = await saveWeeklyReport(s.env, TEXT, Date.parse('2026-10-19T01:00:00Z'), {
      runId: 'r',
    });
    expect(saved).toMatchObject({
      periodFrom: '2026-10-12',
      periodTo: '2026-10-18',
      status: 'ready',
    });
    const row = s.d1.db.prepare('SELECT as_of, status FROM reports WHERE id = ?').get(saved.id);
    expect(row).toMatchObject({ as_of: new Date(NOW).toISOString(), status: 'ready' });
  });

  it('accepts exact calendar dates for telemetry and rejects incorrect arguments before querying', async () => {
    const s = setup();
    const out = JSON.parse(
      (await runRunsQuery(s.env, { period: '2026-10-12..2026-10-18' }, NOW)).result,
    );
    expect(out.period.from).toBe('2026-10-11T21:00:00.000Z');
    await expect(runRunsQuery(s.env, { period: 'invalid' }, NOW)).rejects.toMatchObject({
      name: 'ToolArgumentError',
    });
  });
});

describe('Brain → signed Core API → report quality', () => {
  function transport() {
    const s = setup();
    exampleSlice(s);
    s.d1.db
      .prepare(
        "INSERT INTO runs(id,trigger,profile,started_at) VALUES('run-1','chat','weekly-review',?)",
      )
      .run(new Date(NOW).toISOString());
    const env = workerEnv({
      ...s.env,
      ASSISTANT_V2: 'on',
      INTERNAL_HMAC_KEY: 'test-key',
      TELEGRAM_CHAT_ID: '100',
      TELEGRAM_BOT_TOKEN: 'test',
      RUN_REGISTRY: {
        getByName: () => ({
          has: async () => true,
          consumeNonce: async () => true,
          runInfo: async () => ({ chatId: 100, threadId: 'dm' }),
        }),
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 }),
      ),
    );
    const calls: { path: string; body: Record<string, unknown>; status: number }[] = [];
    const client = new CoreClient({
      baseUrl: 'https://core.test',
      hmacKey: 'test-key',
      accessClientId: null,
      accessClientSecret: null,
      now: () => NOW + 2000,
      fetchFn: (async (url, init) => {
        const request = new Request(url, init);
        const response = await handleInternal(request, env, NOW + 2000);
        calls.push({
          path: new URL(request.url).pathname,
          body: JSON.parse(String(init?.body)),
          status: response.status,
        });
        return response;
      }) as typeof fetch,
    });
    return { ...s, env, client, calls };
  }
  const instruction = {
    name: 'weekly-review',
    body_md: 'Пиши огляд із перевірених даних.',
    version_hash: instructionHash('Пиши огляд із перевірених даних.'),
  };

  it.each([{ period: '2026-10-12..2026-10-18' }, { period: 'wrong-format' }, { cap: 2000 }])(
    'corrects invalid weekly arguments %j exactly once and persists a ready report',
    async (args) => {
      const s = transport();
      const reportRuns = vi.fn(async () => undefined);
      const client = {
        callTool: s.client.callTool.bind(s.client),
        deliver: s.client.deliver.bind(s.client),
        status: vi.fn(),
        reportRuns,
        session: vi.fn(),
        instruction: vi.fn(),
        taint: vi.fn(),
      };
      const engine = {
        readTranscript: async () => null,
        run: async (opts: EngineRunOptions) => {
          const out = await opts.onToolCall('data_read', { scope: 'weekly', ...args });
          expect(out.isError).toBe(false);
          expect(JSON.parse(out.text).finance.summary.expenseMinor).toBe(778023);
          return { finalText: TEXT, sessionId: null };
        },
      };
      await makeRunner({ client, engine, now: () => NOW })({
        run_id: 'run-1',
        profile: 'weekly-review',
        thread_id: 'dm',
        input: { text: 'огляд' },
        instruction,
      });
      const reads = s.calls.filter((c) => c.path.endsWith('/data.read'));
      expect(reads.map((c) => c.status)).toEqual([400, 200]);
      expect(reads[1]?.body.args).toEqual({ scope: 'weekly' });
      expect(s.d1.db.prepare('SELECT status, as_of FROM reports').get()).toMatchObject({
        status: 'ready',
        as_of: new Date(NOW).toISOString(),
      });
      const steps = reportRuns.mock.calls[0] as unknown[] | undefined;
      expect(JSON.stringify(steps)).toContain('corrected once');
    },
  );

  it('delivers and stores a runtime failure as failed, without review action buttons', async () => {
    const s = transport();
    await s.client.deliver('run-1', '⚠️ Бюджет вичерпано', undefined, undefined, true);
    expect(s.d1.db.prepare('SELECT status FROM reports').get()?.status).toBe('failed');
    const outbox = s.d1.db.prepare('SELECT payload_json FROM outbox').all();
    expect(JSON.stringify(outbox)).not.toContain('m:wr:carry');
    expect(JSON.stringify(outbox)).toContain('Не сформовано');
  });

  it('uses the shared all-source reader for an ordinary weekly finance query', async () => {
    const s = transport();
    const out = await s.client.callTool('run-1', 'finance.query', { period: 'тиждень', flags: [] });
    expect(out.ok).toBe(true);
    if (out.ok)
      expect(out.result).toMatchObject({
        mode: 'analytics',
        summary: { expenseMinor: 778023, count: 23 },
      });
  });

  it('always names missing sources in a partial delivery', async () => {
    const s = transport();
    s.kv.set('stats', '{corrupt');
    await s.client.callTool('run-1', 'data.read', { scope: 'weekly' });
    await s.client.deliver('run-1', TEXT);
    expect(s.d1.db.prepare('SELECT status FROM reports').get()?.status).toBe('partial');
    const outbox = JSON.stringify(s.d1.db.prepare('SELECT payload_json FROM outbox').all());
    expect(outbox).toContain('Частковий звіт');
    expect(outbox).toContain('особиста статистика');
  });

  it('names incomplete API cost coverage in the partial header', async () => {
    const s = transport();
    s.d1.db
      .prepare('UPDATE runs SET weekly_context_json = ? WHERE id = ?')
      .run(JSON.stringify({ missing: ['system-cost-coverage'], sources: {} }), 'run-1');
    await s.client.deliver('run-1', TEXT);
    const outbox = JSON.stringify(s.d1.db.prepare('SELECT payload_json FROM outbox').all());
    expect(outbox).toContain('ціни й історія витрат API');
    expect(outbox).not.toContain('Неповні дані: джерело');
  });

  it.each([
    { status: 400, error: 'invalid-arguments', attempts: 2 },
    { status: 502, error: 'tool-failed', attempts: 1 },
  ])('bounds a $status failure to $attempts request(s)', async (failure) => {
    const callTool = vi.fn(async () => ({
      ok: false as const,
      status: failure.status,
      error: failure.error,
    }));
    const client = {
      callTool,
      deliver: vi.fn(),
      status: vi.fn(),
      reportRuns: vi.fn(),
      session: vi.fn(),
      instruction: vi.fn(),
      taint: vi.fn(),
    };
    const engine = {
      readTranscript: async () => null,
      run: async (opts: EngineRunOptions) => {
        const out = await opts.onToolCall('data_read', { scope: 'weekly', period: 'bad' });
        expect(out.isError).toBe(true);
        return { finalText: TEXT, sessionId: null };
      },
    };
    await makeRunner({ client, engine, now: () => NOW })({
      run_id: 'run-1',
      profile: 'weekly-review',
      thread_id: 'dm',
      input: { text: 'огляд' },
      instruction,
    });
    expect(callTool).toHaveBeenCalledTimes(failure.attempts);
  });
});
