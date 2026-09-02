// runs.query (етап 3 PR-2): телеметрія за профілями з реальної міграції
// 0003 у node:sqlite, квоти місяця, чесні «токени невідомі», кап рядків.

import { describe, it, expect } from 'vitest';
import {
  runRunsQuery,
  summarizeRuns,
  RUNS_QUERY_ROW_CAP,
  RUNS_QUERY_ERRORS_MAX,
} from '../web/core/tools/runs.mjs';
import { TOOLS } from '../web/core/tools/index.mjs';
import { validateAgainst } from '../web/core/internal/schemas.mjs';
import { QUOTA_LIMITS } from '../web/core/quota/quota.mjs';
import { workerEnv } from './helpers/env.js';
import { d1FromSqlite } from './helpers/d1.js';

const NOW = Date.parse('2026-09-02T09:00:00.000Z');

function seeded() {
  const d1 = d1FromSqlite(['0003_telemetry.sql']);
  const ins = d1.db.prepare(
    `INSERT INTO runs (id, trigger, profile, thread_id, model, started_at, finished_at, duration_ms, steps, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString();
  ins.run('r1', 'chat', 'chat', '6', 'claude-sonnet-5', at(1), at(1), 5_000, 2, null);
  ins.run('r2', 'chat', 'chat', '6', 'claude-sonnet-5', at(2), at(2), 9_000, 3, null);
  ins.run('r3', 'chat', 'chat', '6', 'claude-sonnet-5', at(3), at(3), 7_000, 1, 'timeout');
  ins.run('r4', 'quick', 'quick', '6', 'claude-haiku-4-5', at(4), at(4), 1_200, 1, null);
  ins.run('r5', 'scheduler', 'summarize', 'dm', 'claude-haiku-4-5', at(30), null, null, null, null);
  // Поза періодом (8 діб тому) - у тижневу вибірку не входить.
  ins.run('r6', 'chat', 'chat', '6', 'claude-sonnet-5', at(8 * 24), at(8 * 24), 4_000, 1, null);
  d1.db
    .prepare(
      `INSERT INTO quota_counters (key, period, value, limit_value, updated_at) VALUES ('deepgram_min', '2026-09', 12.5, 46500, ?)`,
    )
    .run(new Date(NOW).toISOString());
  return { d1, env: workerEnv({ DB: d1.stub }) };
}

describe('runs.query', () => {
  it('зареєстрований у ядрі без обовʼязкових полів; period ≤ 16', () => {
    const tool = TOOLS['runs.query'];
    expect(tool).toBeDefined();
    expect(tool?.tainting).toBeFalsy();
    expect(validateAgainst(tool!.args, {}).ok).toBe(true);
    expect(validateAgainst(tool!.args, { period: 'x'.repeat(17) }).ok).toBe(false);
  });

  it('тиждень за замовчуванням: профілі, медіана/p90, помилки, незавершені; старе не входить', async () => {
    const { env } = seeded();
    const { result } = await runRunsQuery(env, {}, NOW);
    const doc = JSON.parse(String(result));
    expect(doc.period.days).toBe(7);
    expect(doc.runs.total).toBe(5);
    expect(doc.runs.capped).toBe(false);
    const chat = doc.runs.profiles.find((p: { profile: string }) => p.profile === 'chat');
    expect(chat).toEqual(
      expect.objectContaining({
        n: 3,
        errors: 1,
        unfinished: 0,
        median_ms: 7_000,
        p90_ms: 9_000,
        steps_avg: 2,
        tokens_known: 0,
        tokens_in: null,
      }),
    );
    const summarize = doc.runs.profiles.find((p: { profile: string }) => p.profile === 'summarize');
    expect(summarize).toEqual(expect.objectContaining({ n: 1, unfinished: 1, median_ms: null }));
    expect(doc.runs.errors).toEqual([
      expect.objectContaining({ profile: 'chat', error: 'timeout' }),
    ]);
  });

  it('квоти: рядок місяця з лімітом і довідник лімітів із коду; secrets - чесна нотатка', async () => {
    const { env } = seeded();
    const doc = JSON.parse(String((await runRunsQuery(env, { period: '30d' }, NOW)).result));
    expect(doc.period.days).toBe(30);
    expect(doc.runs.total).toBe(6);
    expect(doc.quotas.month).toEqual([
      expect.objectContaining({ key: 'deepgram_min', value: 12.5, limit: 46_500 }),
    ]);
    expect(doc.quotas.limits).toEqual(QUOTA_LIMITS);
    expect(doc.secrets.note).toMatch(/secret-expiry/);
  });

  it('крива period - помилка; без DB - помилка, не порожній звіт', async () => {
    const { env } = seeded();
    await expect(runRunsQuery(env, { period: 'вчора' }, NOW)).rejects.toThrow(/period/);
    await expect(runRunsQuery(workerEnv(), {}, NOW)).rejects.toThrow(/DB/);
  });

  it('summarizeRuns: кап рядків позначається, помилки - не більше стелі', () => {
    const rows = Array.from({ length: RUNS_QUERY_ERRORS_MAX + 5 }, (_, i) => ({
      profile: 'chat',
      trigger: 'chat',
      started_at: new Date(NOW - i * 1000).toISOString(),
      duration_ms: 100 + i,
      tokens_in: null,
      tokens_out: null,
      steps: 1,
      error: `e${i}`,
    }));
    const out = summarizeRuns(rows, true);
    expect(out.capped).toBe(true);
    expect(out.errors).toHaveLength(RUNS_QUERY_ERRORS_MAX);
    expect(out.errors[0]?.error).toBe('e0');
    expect(RUNS_QUERY_ROW_CAP).toBeGreaterThan(RUNS_QUERY_ERRORS_MAX);
  });

  it('токени: коли мозок їх звітує - сума і кількість відомих', () => {
    const base = {
      trigger: 'chat',
      started_at: '2026-09-01T00:00:00Z',
      duration_ms: 1,
      steps: 1,
      error: null,
    };
    const out = summarizeRuns(
      [
        { ...base, profile: 'chat', tokens_in: 100, tokens_out: 20 },
        { ...base, profile: 'chat', tokens_in: null, tokens_out: null },
      ],
      false,
    );
    expect(out.profiles[0]).toEqual(
      expect.objectContaining({ tokens_in: 100, tokens_out: 20, tokens_known: 1 }),
    );
  });
});
