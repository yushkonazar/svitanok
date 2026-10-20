import { afterEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { d1FromSqlite } from './helpers/d1.js';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';
import { reportPeriod } from '../web/core/report-period.mjs';
import { recordUsage } from '../web/core/ops/usage-ledger.mjs';
import {
  readReportCosts,
  readReportCredentials,
  readReportToolCalls,
} from '../web/core/ops/reporting.mjs';
import { readCredentials, saveCredentialMetadata } from '../web/core/ops/credentials.mjs';
import { runRunsQuery } from '../web/core/tools/runs.mjs';
import { runDataRead } from '../web/core/tools/read.mjs';
import { weeklyPacketQuality } from '../web/core/brain/weekly-report-quality.mjs';
import { emptyPlan, applyPlanCommand, type PlanState } from '../web/core/motivation/model.mjs';
import { readPlanReport } from '../web/core/motivation/reporting.mjs';

const NOW = Date.parse('2026-10-18T06:00:00.000Z');
const PERIOD = reportPeriod('2026-10-12', '2026-10-18', NOW);
const migrations = readdirSync(join(__dirname, '..', 'web/core/migrations'))
  .filter((f) => f.endsWith('.sql'))
  .sort();
function setup(files = migrations) {
  const d1 = d1FromSqlite(files);
  const env = workerEnv({
    DB: d1.stub,
    BRIEFING: memoryKv(
      new Map([
        ['stats', '{}'],
        ['state', '{}'],
      ]),
    ),
    OPENAI_API_KEY: 'NEVER_OUTPUT_SECRET',
    MAPS_API_KEY: 'PRIVATE_MAPS_KEY',
  });
  return { d1, env };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function plan(s: ReturnType<typeof setup>) {
  let state: PlanState = emptyPlan();
  state.balance = 200;
  const events: Record<string, unknown>[] = [];
  let serial = 0;
  function act(op: string, at: string, payload: Record<string, unknown> = {}, id?: string) {
    const r = applyPlanCommand(
      state,
      { op, payload, id, commandId: `report-fixture-${++serial}` },
      Date.parse(at),
    );
    state = r.state;
    events.push(...r.events);
    return r.receipt.id;
  }
  act('settings', '2026-10-12T07:00:00Z', { enabled: true });
  function task(title: string, date: string, dueAt: string) {
    const id = act('task-save', `${date}T07:00:00Z`, {
      title,
      date,
      dueAt,
      deadlineKind: 'time',
      criterion: 'Два результати',
      target: 2,
      xp: 35,
      effort: 1,
      contribution: 1,
      estimateMinutes: 30,
    });
    act('accept', `${date}T07:01:00Z`, { date }, id);
    return id;
  }
  function save() {
    s.d1.db
      .prepare(
        'INSERT INTO motivation_account(id,revision,data_json) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,data_json=excluded.data_json',
      )
      .run(state.revision, JSON.stringify({ ...state, records: undefined }));
    for (const r of Object.values(state.records))
      s.d1.db
        .prepare(
          'INSERT OR REPLACE INTO motivation_records(id,kind,date,data_json) VALUES(?,?,?,?)',
        )
        .run(r.id, r.kind, r.date ?? null, JSON.stringify(r));
    for (const e of events)
      s.d1.db
        .prepare(
          'INSERT OR IGNORE INTO motivation_ledger(id,command_id,at,kind,delta,experience_delta,data_json) VALUES(?,?,?,?,?,?,?)',
        )
        .run(
          String(e.id),
          'fixture',
          String(e.at),
          String(e.kind),
          Number(e.delta),
          Number(e.experienceDelta),
          JSON.stringify(e),
        );
  }
  return {
    act,
    task,
    save,
    get state() {
      return state;
    },
  };
}

describe('weekly system report, audit block 3', () => {
  it('separates estimates, SDK equivalents, provider snapshots and envelopes, with 55 of 174 weekly prices known', async () => {
    const s = setup(),
      fetch = vi.fn(() => {
        throw new Error('No provider calls permitted');
      });
    vi.stubGlobal('fetch', fetch);
    for (let i = 0; i < 174; i++)
      await recordUsage(s.env, {
        id: `cost-${i}`,
        at: '2026-10-13T10:00:00Z',
        feature: i === 54 ? 'comparison' : 'assistant',
        provider: i === 54 ? 'claude' : 'openai',
        sku: 'fixture-model',
        basis: i === 54 ? 'api-equivalent' : 'estimate',
        costUsd: i < 54 ? 0.01 : i === 54 ? 2 : undefined,
      });
    await recordUsage(s.env, {
      id: 'prior-week',
      at: '2026-10-05T10:00:00Z',
      provider: 'openai',
      costUsd: 0.2,
    });
    await recordUsage(s.env, {
      id: 'future',
      at: '2026-10-18T06:00:00.001Z',
      provider: 'openai',
      costUsd: 100,
    });
    s.d1.db
      .prepare("INSERT INTO system_preferences(id,value_json,updated_at) VALUES('owner',?,?)")
      .run(
        JSON.stringify({ overallUsd: 25, features: { assistant: 10 } }),
        new Date(NOW).toISOString(),
      );
    const snapshot = {
      costUsd: 9.99,
      balanceUsd: null,
      currency: 'USD',
      from: '2026-10-01',
      to: '2026-10-18',
      collectedAt: '2026-10-18T05:00:00Z',
    };
    s.d1.db
      .prepare(
        'INSERT INTO system_billing_snapshots(id,provider,snapshot_json,attempted_at,collected_at) VALUES(?,?,?,?,?)',
      )
      .run(
        'openai:2026-10-01:2026-10-18',
        'openai',
        JSON.stringify(snapshot),
        snapshot.collectedAt,
        snapshot.collectedAt,
      );
    const costs = await readReportCosts(s.env, PERIOD, NOW);
    expect(costs.selected).toMatchObject({
      records: 174,
      knownCostRecords: 55,
      unpricedRecords: 119,
      estimatedUsd: 0.54,
      apiEquivalentUsd: 2,
    });
    expect(costs.month).toMatchObject({ records: 175, estimatedUsd: 0.74, apiEquivalentUsd: 2 });
    expect(costs.month?.period.to).toBe(PERIOD.to);
    expect(costs.budgets).toMatchObject({ overallUsd: 25, enforcement: false });
    expect(costs.billing).toMatchObject({ combinedWithEstimates: false, balanceUsd: null });
    expect(
      costs.billing?.providers.find((p: { provider: string }) => p.provider === 'openai')?.snapshot,
    ).toMatchObject({ costUsd: 9.99 });
    expect(costs.month).not.toHaveProperty('costUsd');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps unconfigured budgets and missing costs unknown and deduplicates receipt-backed legacy model steps', async () => {
    const s = setup();
    s.d1.db
      .prepare(
        "INSERT INTO runs(id,trigger,profile,started_at) VALUES('legacy','chat','chat','2026-10-13T09:00:00Z')",
      )
      .run();
    s.d1.db
      .prepare(
        "INSERT INTO run_steps(id,run_id,n,at,kind,name,note) VALUES('model','legacy',1,'2026-10-13T09:01:00Z','model','openai:fixture','cost_usd=999')",
      )
      .run();
    await recordUsage(s.env, {
      id: 'run:legacy:1',
      at: '2026-10-13T09:01:00Z',
      provider: 'openai',
      costUsd: 0.3,
    });
    const c = await readReportCosts(s.env, PERIOD, NOW);
    expect(c.selected).toMatchObject({ records: 1, estimatedUsd: 0.3 });
    expect(c.budgets?.overallUsd).toBeNull();
    expect(c.billing?.balanceUsd).toBeNull();
    const empty = await readReportCosts(setup().env, PERIOD, NOW);
    expect(empty.month).toMatchObject({ records: 0, estimatedUsd: null, apiEquivalentUsd: null });
  });

  it('counts failed tools in successful runs and uses the step timestamp rather than the parent run start', async () => {
    const s = setup();
    s.d1.db.exec(
      "INSERT INTO runs(id,trigger,profile,started_at,finished_at,duration_ms,error) VALUES('ok','chat','chat','2026-10-12T07:00:00Z','2026-10-12T07:05:00Z',300000,NULL),('old','chat','chat','2026-10-11T20:00:00Z','2026-10-12T08:00:00Z',1000,'PRIVATE failure')",
    );
    const ins = s.d1.db.prepare(
      "INSERT INTO run_steps(id,run_id,n,at,kind,name,ok,note) VALUES(?,?,?,?, 'tool',?,?,?)",
    );
    ins.run(
      'bad-args',
      'ok',
      1,
      '2026-10-12T07:01:00Z',
      'data.read',
      0,
      'http=400 invalid-arguments PRIVATE_PERSONAL_DATA',
    );
    ins.run('retry', 'ok', 2, '2026-10-12T07:02:00Z', 'data.read', 1, 'ok');
    ins.run(
      'old-parent',
      'old',
      1,
      '2026-10-12T07:03:00Z',
      'finance.query',
      0,
      'timeout PRIVATE_TOKEN',
    );
    ins.run('unknown', 'ok', 3, '2026-10-12T07:04:00Z', 'data.read', null, null);
    ins.run('before', 'ok', 4, '2026-10-11T20:59:59Z', 'data.read', 0, 'old');
    ins.run('after', 'ok', 5, '2026-10-18T06:00:00.001Z', 'data.read', 0, 'future');
    const tools = await readReportToolCalls(s.env, PERIOD);
    expect(tools).toMatchObject({
      total: 4,
      failed: 2,
      succeeded: 1,
      unknown: 1,
      failedInCompletedRuns: 1,
    });
    expect(tools.errors.map((r) => r.errorClass)).toEqual(['timeout', 'invalid-arguments']);
    const doc = JSON.parse((await runRunsQuery(s.env, { period: 'тиждень' }, NOW)).result);
    expect(doc.runs.total).toBe(1);
    expect(doc.toolCalls.failed).toBe(2);
    expect(JSON.stringify(doc)).not.toMatch(/PRIVATE|NEVER_OUTPUT_SECRET/);
  });

  it('keeps other system sources when one reader fails and records the gap in report quality', async () => {
    const s = setup();
    const original = s.d1.stub.prepare;
    s.d1.stub.prepare = (sql) => {
      if (sql.includes('FROM usage_receipts')) throw new Error('PRIVATE_DB_ERROR');
      return original(sql);
    };
    const packet = JSON.parse((await runDataRead(s.env, { scope: 'weekly' }, NOW)).result);
    expect(packet.system.sources.runs.status).toBe('available');
    expect(packet.system.costs.sources.monthUsage.status).toBe('unavailable');
    expect(packet.system.costs.month).toBeNull();
    expect(weeklyPacketQuality(packet).missing).toContain('system-cost-sources');
    expect(JSON.stringify(packet)).not.toContain('PRIVATE_DB_ERROR');
  });

  it('uses current tasks, reports, deadlines and explanations without changing XP or legacy rows', async () => {
    const s = setup(),
      p = plan(s);
    const done = p.task('Практика SQL', '2026-10-12', '2026-10-12T10:00:00Z');
    p.act('report', '2026-10-12T09:00:00Z', { units: 2, actualAt: '2026-10-12T09:00:00Z' }, done);
    const missed = p.task('Прочитати розділ', '2026-10-13', '2026-10-13T10:00:00Z');
    p.act('task-note', '2026-10-13T11:00:00Z', { reason: 'Заснув після зміни' }, missed);
    p.save();
    s.d1.db.exec(
      "INSERT INTO day_plans(date,status,created_at) VALUES('2026-10-12','reviewed','2026-10-12T07:00:00Z')",
    );
    const before = [
      'motivation_account',
      'motivation_records',
      'motivation_ledger',
      'day_plans',
    ].map((t) => s.d1.db.prepare(`SELECT * FROM ${t}`).all());
    const report = await readPlanReport(s.env, PERIOD);
    expect(report).toMatchObject({
      source: 'motivation',
      dayBoundary: '03:00',
      complete: true,
      summary: {
        acceptedCommitments: 2,
        distinctResults: 2,
        completedDistinctResults: 1,
        actualMinutes: null,
      },
    });
    expect(report.summary.lifecycle).toMatchObject({ completed: 1, missed: 1 });
    expect(report.tasks.find((t) => t.id === missed)).toMatchObject({
      outcomeNote: 'Заснув після зміни',
      lifecycle: 'missed',
      status: 'accepted',
    });
    expect(report.explanations[0]?.reason).toBe('Заснув після зміни');
    expect(before).toEqual(
      ['motivation_account', 'motivation_records', 'motivation_ledger', 'day_plans'].map((t) =>
        s.d1.db.prepare(`SELECT * FROM ${t}`).all(),
      ),
    );
  });

  it('counts one shared result across recommitted promises and excludes reports after the cutoff', async () => {
    const s = setup(),
      p = plan(s);
    const old = p.task('Продовжувана задача', '2026-10-12', '2026-10-12T10:00:00Z');
    p.act('forfeit', '2026-10-12T11:00:00Z', {}, old);
    const next = p.act('recommit', '2026-10-13T07:00:00Z', { date: '2026-10-13' }, old);
    p.act('accept', '2026-10-13T07:01:00Z', { date: '2026-10-13' }, next);
    p.act('report', '2026-10-13T09:00:00Z', { units: 2 }, next);
    p.save();
    const r = await readPlanReport(s.env, PERIOD);
    expect(r.summary).toMatchObject({
      acceptedCommitments: 2,
      distinctResults: 1,
      completedDistinctResults: 1,
      recommitted: 1,
    });
    const pending = p.task('Результат після зрізу', '2026-10-17', '2026-10-18T10:00:00Z');
    p.act('report', '2026-10-18T06:00:00.001Z', { units: 2 }, pending);
    const future = p.task('Після зрізу', '2026-10-18', '2026-10-18T20:00:00Z');
    p.act('report', '2026-10-18T07:02:00Z', { units: 2 }, future);
    p.save();
    const frozen = await readPlanReport(s.env, PERIOD);
    expect(frozen.snapshotAfterCutoff).toBe(true);
    expect(frozen.complete).toBe(false);
    expect(frozen.tasks.some((t) => t.id === future)).toBe(false);
    expect(frozen.tasks.find((t) => t.id === pending)?.units).toBe(0);
  });

  it('counts a factual late time-sensitive result in the review without awarding XP or requesting it again', async () => {
    const s = setup(),
      p = plan(s);
    const id = p.act('task-save', '2026-10-12T07:00:00Z', {
      title: 'Почати практику до строку',
      date: '2026-10-12',
      dueAt: '2026-10-12T08:00:00Z',
      deadlineKind: 'time',
      timeSensitive: true,
      criterion: 'Почати одну практику',
      target: 1,
      xp: 20,
      effort: 1,
      contribution: 0,
    });
    p.act('accept', '2026-10-12T07:01:00Z', { date: '2026-10-12' }, id);
    p.act('report', '2026-10-12T09:00:00Z', { units: 1 }, id);
    p.save();
    const before = s.d1.db.prepare('SELECT * FROM motivation_account').all();
    const r = await readPlanReport(s.env, PERIOD);
    expect(r.summary).toMatchObject({
      completedDistinctResults: 1,
      lifecycle: { 'completed-late': 1, missed: 0 },
    });
    expect(r.tasks.find((t) => t.id === id)).toMatchObject({
      lifecycle: 'completed-late',
      units: 1,
      eligibleUnits: 0,
      onTimeUnits: 0,
    });
    expect(s.d1.db.prepare('SELECT * FROM motivation_account').all()).toEqual(before);
    expect(p.state.experience).toBe(0);
  });

  it('distinguishes unavailable tasks from an empty plan while leaving other data available', async () => {
    const s = setup();
    s.d1.db.exec('DROP TABLE motivation_records');
    const packet = JSON.parse((await runDataRead(s.env, { scope: 'weekly' }, NOW)).result);
    expect(packet.sources.plans.status).toBe('unavailable');
    expect(packet.sources.system.status).toBe('available');
    expect(weeklyPacketQuality(packet).missing).toContain('plans');
  });

  it('exposes missing report times and future drafts without treating either as a completed weekly task', async () => {
    const s = setup(),
      p = plan(s);
    const id = p.task('Звіт без часу', '2026-10-12', '2026-10-12T10:00:00Z');
    p.act('report', '2026-10-12T09:00:00Z', { units: 2 }, id);
    const future = p.act('task-save', '2026-10-17T12:00:00Z', {
      title: 'На понеділок',
      date: '2026-10-19',
      dueAt: '2026-10-19T10:00:00Z',
      deadlineKind: 'time',
      criterion: 'Два кроки',
      target: 2,
      xp: 35,
      effort: 1,
      contribution: 1,
    });
    p.save();
    const resultId = p.state.records[id].resultId;
    s.d1.db
      .prepare(
        "UPDATE motivation_records SET data_json=json_remove(data_json,'$.reports[0].recordedAt') WHERE id=?",
      )
      .run(resultId);
    const r = await readPlanReport(s.env, PERIOD);
    expect(r).toMatchObject({ complete: false, unknownReportTimingCount: 1 });
    expect(r.tasks.find((t) => t.id === id)?.units).toBe(0);
    expect(r.tasks.some((t) => t.id === future)).toBe(false);
    expect(r.upcomingOutsidePeriod.tasks[0]).toMatchObject({ id: future, lifecycle: 'draft' });
  });

  it('distinguishes explicit non-expiry, unknown dates, unconfigured locations and rotation reminders', async () => {
    const s = setup();
    const base = { version: 0, rotatedAt: '2026-09-01', expiresAt: null, rotateAfterDays: null };
    await saveCredentialMetadata(
      s.env,
      { ...base, id: 'OPENAI_API_KEY:cloudflare', expiryKind: 'non-expiring' },
      NOW,
    );
    await saveCredentialMetadata(
      s.env,
      { ...base, id: 'OPENAI_API_KEY:vps', expiresAt: '2026-11-01' },
      NOW,
    );
    await saveCredentialMetadata(
      s.env,
      { ...base, id: 'MAPS_API_KEY:cloudflare', rotateAfterDays: 30 },
      NOW,
    );
    await saveCredentialMetadata(
      s.env,
      { ...base, id: 'MONO_TOKEN:cloudflare', expiresAt: '2026-10-17' },
      NOW,
    );
    const r = await readReportCredentials(s.env, NOW);
    expect(
      r.entries.find((e) => e.label === 'OpenAI' && e.location === 'cloudflare'),
    ).toMatchObject({ expiryState: 'non-expiring', configuration: 'configured' });
    expect(r.expiring.find((e) => e.label === 'OpenAI')).toMatchObject({
      location: 'vps',
      configuration: 'unknown',
    });
    expect(r.expiring.some((e) => e.label === 'Monobank')).toBe(false);
    expect(r.rotationReminders.find((e) => e.label === 'Карти й маршрути')).toMatchObject({
      expiryState: 'unknown',
    });
    expect(r.inventory.legacyLocations).toBeGreaterThan(0);
    expect(JSON.stringify(r)).not.toMatch(/NEVER_OUTPUT_SECRET|PRIVATE_MAPS_KEY/);
    const entry = (await readCredentials(s.env, NOW)).entries.find(
      (e) => e.id === 'OPENAI_API_KEY:cloudflare',
    )!;
    await saveCredentialMetadata(
      s.env,
      { ...base, id: entry.id, version: entry.version, rotateAfterDays: 90 },
      NOW,
    );
    expect(
      (await readCredentials(s.env, NOW)).entries.find((e) => e.id === entry.id)?.expiryKind,
    ).toBe('non-expiring');
    await expect(
      saveCredentialMetadata(
        s.env,
        {
          ...base,
          id: 'OPENAI_API_KEY:github',
          expiryKind: 'non-expiring',
          expiresAt: '2026-11-01',
        },
        NOW,
      ),
    ).rejects.toThrow(/строк/);
  });

  it('expands expiry metadata without rewriting historical dates or assuming non-expiry', async () => {
    const s = setup(migrations.filter((f) => !f.startsWith('0046_')));
    s.d1.db.exec(
      "INSERT INTO credential_metadata(id,expires_at,updated_at) VALUES('OPENAI_API_KEY:vps','2026-11-01','2026-10-01T07:00:00Z'),('OPENAI_API_KEY:github',NULL,'2026-10-01T07:00:00Z')",
    );
    const before = s.d1.db
      .prepare('SELECT id,expires_at,updated_at FROM credential_metadata ORDER BY id')
      .all();
    s.d1.db.exec(
      readFileSync(
        join(__dirname, '../web/core/migrations/0046_credential_expiry_kind.sql'),
        'utf8',
      ),
    );
    expect(
      s.d1.db.prepare('SELECT id,expires_at,updated_at FROM credential_metadata ORDER BY id').all(),
    ).toEqual(before);
    const rows = (await readCredentials(s.env, NOW)).entries;
    expect(rows.find((e) => e.id === 'OPENAI_API_KEY:vps')?.expiryKind).toBe('date');
    expect(rows.find((e) => e.id === 'OPENAI_API_KEY:github')?.expiryKind).toBe('unknown');
  });
});
