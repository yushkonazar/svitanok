import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { d1FromSqlite } from './helpers/d1.js';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';
import { buildInitData } from './helpers/init-data.js';
import { handleSystem, readModelUsage } from '../web/api-system.mjs';
import { readRunDashboard } from '../web/core/ops/run-dashboard.mjs';
function setup() {
  const d1 = d1FromSqlite(
    readdirSync('web/core/migrations')
      .filter((f) => f.endsWith('.sql'))
      .sort(),
  );
  const env = workerEnv({
    DB: d1.stub,
    BRIEFING: memoryKv(new Map()),
    TELEGRAM_BOT_TOKEN: 'system-test',
    TELEGRAM_OWNER_USER_ID: '123',
    TELEGRAM_CHAT_ID: '123',
    TELEGRAM_ALLOWED_USER_IDS: '456',
    ASSISTANT_V2: 'on',
  });
  return { d1, env };
}
describe('private system dashboard', () => {
  it('requires the primary owner, sets no-store, and isolates unavailable sections', async () => {
    const { env } = setup();
    const request = async (user: number) =>
      new Request('https://example.test/api/system', {
        headers: { 'X-Telegram-Init-Data': await buildInitData(user, 'system-test') },
      });
    expect((await handleSystem(new Request('https://example.test/api/system'), env)).status).toBe(
      401,
    );
    expect((await handleSystem(await request(456), env)).status).toBe(403);
    const result = await handleSystem(await request(123), env);
    expect(result.headers.get('cache-control')).toBe('private, no-store');
    const data = (await result.json()) as {
      scheduler: { available: boolean; data: null };
      runs: { available: boolean };
      billing: { balance: null };
    };
    expect(data.scheduler).toEqual({ available: false, data: null, reason: 'read-failed' });
    expect(data.runs.available).toBe(true);
    expect(data.billing.balance).toBeNull();
    expect(JSON.stringify(data)).not.toContain('system-test');
  });
  it('counts Claude and OpenAI separately and keeps unknown costs and outcomes unknown', async () => {
    const { d1, env } = setup(),
      at = new Date().toISOString();
    d1.db.prepare("INSERT INTO runs(id,trigger,started_at) VALUES ('r','chat',?)").run(at);
    const insert = d1.db.prepare(
      "INSERT INTO run_steps(id,run_id,n,at,kind,name,ms,ok,note) VALUES (?,'r',?,?, 'model',?, ?, ?, ?)",
    );
    insert.run(
      'a',
      1,
      at,
      'worker:researcher:claude:example-model',
      null,
      1,
      'latency_unknown=1 usage_complete=1 input_tokens=10 output_tokens=3 cost_usd=0.02 private=never-return',
    );
    insert.run('b', 2, at, 'worker:researcher:openai:example-model', 100, null, 'usage_complete=0');
    const usage = await readModelUsage(env, Date.now());
    expect(usage.items.find((item) => item.model.startsWith('openai:'))).toMatchObject({
      costUsd: null,
      inputTokens: null,
      knownCostCalls: 0,
    });
    expect(usage.items.find((item) => item.model.startsWith('claude:'))).toMatchObject({
      costUsd: 0.02,
      inputTokens: 10,
      knownCostCalls: 1,
    });
    expect((await readRunDashboard(env)).worker_quality[0]).toMatchObject({
      sample_size: 2,
      succeeded: 1,
      failed: 0,
      success_rate_pct: 100,
      avg_latency_ms: 100,
    });
    expect(JSON.stringify(usage)).not.toContain('never-return');
  });
});
