import { readdirSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { d1FromSqlite } from './helpers/d1.js';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';
import { buildInitData } from './helpers/init-data.js';
import { handleSystem } from '../web/api-system.mjs';
import { systemPeriod, kyivMidnight, validDate } from '../web/core/ops/system-period.mjs';
import { recordUsage, recordModelUsage, readUsageLedger } from '../web/core/ops/usage-ledger.mjs';
import { readRunDashboard } from '../web/core/ops/run-dashboard.mjs';
import { readSystemServices } from '../web/core/ops/system-services.mjs';
import {
  saveSystemPreferences,
  readSystemPreferences,
} from '../web/core/ops/system-preferences.mjs';
import {
  fetchOpenAiBilling,
  fetchDeepgramBilling,
  refreshSystemBilling,
  readSystemBilling,
} from '../web/core/ops/system-billing.mjs';
import { systemSchema } from '../web/app/src/api/system-schema.ts';
const now = Date.parse('2026-10-13T09:00:00Z');
const period = systemPeriod(new URLSearchParams('range=month'), now);
function setup() {
  const d1 = d1FromSqlite(
    readdirSync('web/core/migrations')
      .filter((f) => f.endsWith('.sql'))
      .sort(),
  );
  const env = workerEnv({
    DB: d1.stub,
    BRIEFING: memoryKv(new Map()),
    TELEGRAM_BOT_TOKEN: 'private-test',
    TELEGRAM_OWNER_USER_ID: '123',
    TELEGRAM_CHAT_ID: '123',
    ASSISTANT_V2: 'on',
  });
  return { d1, env };
}
async function request(action?: unknown, search = '', user = 123) {
  return new Request(`https://example.test/api/system${search}`, {
    method: action ? 'POST' : 'GET',
    headers: {
      'X-Telegram-Init-Data': await buildInitData(user, 'private-test'),
      'content-type': 'application/json',
    },
    ...(action ? { body: JSON.stringify(action) } : {}),
  });
}
afterEach(() => vi.restoreAllMocks());
describe('system periods and accounting', () => {
  it('uses Kyiv calendar days across both DST transitions and rejects invalid/future ranges', () => {
    expect(kyivMidnight('2026-03-29')).toBe('2026-03-28T22:00:00.000Z');
    expect(kyivMidnight('2026-03-30')).toBe('2026-03-29T21:00:00.000Z');
    expect(kyivMidnight('2026-10-26')).toBe('2026-10-25T22:00:00.000Z');
    expect(
      systemPeriod(new URLSearchParams('range=today'), Date.parse('2026-10-12T22:15Z')).from,
    ).toBe('2026-10-13');
    expect(systemPeriod(new URLSearchParams('range=7d'), now).from).toBe('2026-10-07');
    expect(validDate('2026-02-30')).toBe(false);
    expect(validDate('2026-99-99')).toBe(false);
    for (const query of [
      'range=wrong',
      'range=custom&from=2026-10-15&to=2026-10-16',
      'range=custom&from=2026-10-13&to=2026-10-12',
    ])
      expect(() => systemPeriod(new URLSearchParams(query), now)).toThrow();
  });
  it('deduplicates model receipts against legacy steps and separates SDK equivalents from paid API estimates', async () => {
    const { d1, env } = setup();
    d1.db
      .prepare("INSERT INTO runs(id,trigger,profile,started_at) VALUES('r','chat','finance',?)")
      .run(new Date(now).toISOString());
    d1.db
      .prepare(
        "INSERT INTO run_steps(id,run_id,n,at,kind,name,note) VALUES('custom-id','r',1,?,'model','openai:example','cost_usd=0.9 input_tokens=999')",
      )
      .run(new Date(now).toISOString());
    const model = {
      kind: 'model',
      name: 'openai:example',
      at: new Date(now).toISOString(),
      ok: true,
      telemetry: {
        usage: { input_tokens: 100, output_tokens: 20 },
        estimatedCostUsd: 0.001,
        apiAttempts: 2,
      },
    };
    await recordModelUsage(env, 'r', model, 'finance', 1, now);
    await recordModelUsage(env, 'r', model, 'finance', 1, now);
    await recordUsage(env, {
      id: 'sdk',
      provider: 'claude',
      feature: 'assistant',
      sku: 'sdk-model',
      costUsd: 0.02,
      basis: 'api-equivalent',
      at: new Date(now).toISOString(),
    });
    await recordUsage(env, {
      id: 'maps',
      provider: 'google',
      feature: 'maps',
      sku: 'routes',
      costUsd: null,
      at: new Date(now).toISOString(),
      quantity: 1,
    });
    const usage = await readUsageLedger(env, period);
    expect(usage).toMatchObject({
      records: 3,
      knownCosts: 2,
      estimatedUsd: 0.001,
      equivalentUsd: 0.02,
      inputTokens: 100,
    });
    expect(usage.features.find((f) => f.feature === 'maps')).toMatchObject({
      costUsd: null,
      estimatedUsd: null,
    });
    expect(usage.features.find((f) => f.feature === 'finance')).toMatchObject({ records: 1 });
    expect(
      d1.db.prepare("SELECT COUNT(*) AS n FROM usage_receipts WHERE id='run:r:1'").get(),
    ).toMatchObject({ n: 1 });
  });
  it('accounts all new receipts past the former 5000-record cap without inventing missing amounts', async () => {
    const { d1, env } = setup();
    const insert = d1.db.prepare(
      "INSERT INTO usage_receipts(id,at,day,feature,provider,sku,basis,cost_nano_usd) VALUES(?,?,'2026-10-13','news','openai','example','estimate',1000)",
    );
    for (let i = 0; i < 6000; i++) insert.run(`receipt-${i}`, new Date(now).toISOString());
    const usage = await readUsageLedger(env, period);
    expect(usage).toMatchObject({
      records: 6000,
      knownCosts: 6000,
      estimatedUsd: 0.006,
      legacyTruncated: false,
    });
    expect(usage.daily).toHaveLength(1);
  });
  it('does not persist payloads or invalid metrics and survives missing/old databases', async () => {
    const { d1, env } = setup();
    await recordUsage(env, {
      id: 'safe',
      feature: 'injected-private',
      provider: 'injected-private',
      sku: 'private text',
      costUsd: NaN,
      inputTokens: -4,
      outputTokens: '88',
      at: new Date(now).toISOString(),
      prompt: 'NEVER-PERSIST',
      response: { secret: 'NEVER-PERSIST' },
    });
    const row = d1.db.prepare("SELECT * FROM usage_receipts WHERE id='safe'").get();
    expect(row).toMatchObject({
      feature: 'other',
      provider: 'other',
      sku: 'unknown',
      cost_nano_usd: null,
      input_tokens: null,
      output_tokens: null,
    });
    expect(JSON.stringify(row)).not.toContain('NEVER-PERSIST');
    expect(await recordUsage(workerEnv(), {})).toBe(false);
    const old = d1FromSqlite(['0003_telemetry.sql']);
    expect(await recordUsage(workerEnv({ DB: old.stub }), { id: 'old' })).toBe(false);
  });
  it('shows every model and period totals independently of the 50-task page', async () => {
    const { d1, env } = setup();
    const insert = d1.db.prepare(
      "INSERT INTO runs(id,trigger,profile,started_at,finished_at) VALUES(?,'chat','chat',?,?)",
    );
    for (let i = 0; i < 60; i++)
      insert.run(
        `r-${i.toString().padStart(2, '0')}`,
        new Date(now).toISOString(),
        new Date(now + 100).toISOString(),
      );
    d1.db
      .prepare(
        "INSERT INTO run_steps(id,run_id,n,at,kind,name,ms,ok,note) VALUES('one','r-59',1,?,'model','worker:researcher:claude:worker',0,1,'latency_unknown=1 prompt=secret')",
      )
      .run(new Date(now).toISOString());
    d1.db
      .prepare(
        "INSERT INTO run_steps(id,run_id,n,at,kind,name,ms,ok,note) VALUES('two','r-59',2,?,'model','openai:root',10,1,'input_tokens=10 output_tokens=2 cost_usd=0.01')",
      )
      .run(new Date(now).toISOString());
    const first = await readRunDashboard(env, period);
    expect(first.summary.total).toBe(60);
    expect(first.recent).toHaveLength(50);
    expect(first.recent[0]).toMatchObject({ model: 'openai:root' });
    expect(first.recent[0]!.models).toHaveLength(2);
    expect(first.recent[0]!.models[0]!.duration_ms).toBeNull();
    expect(JSON.stringify(first)).not.toContain('prompt=secret');
    const second = await readRunDashboard(env, { ...period, before: first.nextCursor! });
    expect(second.recent).toHaveLength(10);
    expect(second.summary.total).toBe(60);
    expect(new Set([...first.recent, ...second.recent].map((r) => r.id)).size).toBe(60);
  });
});
describe('owner API, preferences and cached health', () => {
  it('keeps legacy 30-day totals separate and groups the selected-period model projection across features', async () => {
    const { env, d1 } = setup();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    d1.db
      .prepare(
        "INSERT INTO runs(id,trigger,profile,started_at) VALUES('old','chat','chat','2026-09-20T09:00:00Z')",
      )
      .run();
    d1.db
      .prepare(
        "INSERT INTO run_steps(id,run_id,n,at,kind,name,note) VALUES('old-step','old',1,'2026-09-20T09:00:00Z','model','openai:example','cost_usd=0.5')",
      )
      .run();
    for (const feature of ['news', 'assistant', 'comparison'])
      await recordUsage(env, {
        id: feature,
        feature,
        provider: 'openai',
        sku: 'example',
        at: new Date(now).toISOString(),
        costUsd: 0.001,
      });
    const old = systemSchema.parse(await (await handleSystem(await request(), env)).json());
    expect(old.models.data!.items).toMatchObject([
      { model: 'openai:example', calls: 1, costUsd: 0.5 },
    ]);
    const selected = systemSchema.parse(
      await (await handleSystem(await request(undefined, '?range=month'), env)).json(),
    );
    expect(selected.models.data!.items).toHaveLength(2);
    expect(selected.models.data!.items).toMatchObject([
      { model: 'openai:example', calls: 2, costUsd: 0.002, shadow: false },
      { model: 'shadow:openai:example', calls: 1, costUsd: 0.001, shadow: true },
    ]);
    const day = systemSchema.parse(
      await (await handleSystem(await request(undefined, '?range=today'), env)).json(),
    );
    expect(day.selection!.range).toBe('today');
  });
  it('does not present stale or unrelated Google grants as calendar permissions', async () => {
    const { env } = setup();
    env.GOOGLE_CLIENT_ID = 'test-client';
    env.GOOGLE_CLIENT_SECRET = 'test-secret';
    env.GOOGLE_REFRESH_TOKEN = 'test-grant';
    const { googleGrantIdentity } = await import('../web/core/google-scopes.mjs');
    const grant = {
      scope: 'https://www.googleapis.com/auth/calendar.events',
      scopeCheckedAt: new Date(now - 1000).toISOString(),
      expMs: now + 60000,
      grantIdentity: await googleGrantIdentity(env),
    };
    await env.BRIEFING.put('googleToken', JSON.stringify(grant));
    let service = (await readSystemServices(env, now)).find((s) => s.id === 'calendar')!;
    expect(service).toMatchObject({
      state: 'configured',
      metrics: [{ value: 'Дозволено' }, { value: 'Дозволено' }],
    });
    env.GOOGLE_REFRESH_TOKEN = 'rotated-grant';
    service = (await readSystemServices(env, now)).find((s) => s.id === 'calendar')!;
    expect(service).toMatchObject({
      state: 'unknown',
      metrics: [{ value: 'Невідомо' }, { value: 'Невідомо' }],
    });
    expect(JSON.stringify(service)).not.toContain('test-grant');
    await env.BRIEFING.put(
      'googleToken',
      JSON.stringify({ ...grant, grantIdentity: await googleGrantIdentity(env), expMs: now - 1 }),
    );
    expect((await readSystemServices(env, now)).find((s) => s.id === 'calendar')).toMatchObject({
      state: 'unknown',
    });
  });
  it('validates the full client contract and does not call billing while loading', async () => {
    const { env } = setup();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must-not-call'));
    const result = await handleSystem(await request(), env);
    const body = await result.json();
    expect(result.status).toBe(200);
    const parsed = systemSchema.safeParse(body);
    expect(parsed.success, JSON.stringify(parsed.error)).toBe(true);
    expect(network).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toContain('private-test');
  });
  it('keeps the last successful section with its original time and an explicit failure', async () => {
    const { env } = setup();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    await handleSystem(await request(), env);
    env.DB = undefined;
    const response = await handleSystem(await request(undefined, '?refresh=1'), env);
    const body = (await response.json()) as {
      usage: { available: boolean; cached: boolean; checkedAt: string; data: unknown };
    };
    expect(body.usage).toMatchObject({
      available: false,
      cached: true,
      checkedAt: new Date(now).toISOString(),
    });
    expect(body.usage.data).not.toBeNull();
  });
  it('protects mutations and validates dates before reading private state', async () => {
    const { env } = setup();
    expect((await handleSystem(await request({ action: 'budgets' }, '', 456), env)).status).toBe(
      403,
    );
    expect(
      (await handleSystem(await request(undefined, '?range=custom&from=bad&to=bad'), env)).status,
    ).toBe(400);
    expect((await handleSystem(await request({ action: 'unsupported' }), env)).status).toBe(400);
  });
  it('creates, edits and clears display budgets with CAS, without stopping services or enabling alerts', async () => {
    const { env } = setup();
    const first = await saveSystemPreferences(
      env,
      { revision: 0, budgets: { overallUsd: 10, features: { news: 3 } } },
      now,
    );
    expect(first).toMatchObject({
      ok: true,
      preferences: { revision: 1, enforcement: false, notifications: false },
    });
    expect(
      await saveSystemPreferences(
        env,
        { revision: 0, budgets: { overallUsd: 99, features: {} } },
        now,
      ),
    ).toMatchObject({ ok: false, error: 'conflict' });
    expect(
      await saveSystemPreferences(
        env,
        { revision: 1, budgets: { overallUsd: null, features: {} } },
        now,
      ),
    ).toMatchObject({ ok: true });
    expect(await readSystemPreferences(env)).toMatchObject({
      revision: 2,
      budgets: { overallUsd: null, features: {} },
    });
    expect(
      await saveSystemPreferences(env, { revision: 2, budgets: { overallUsd: -1, features: {} } }),
    ).toMatchObject({ ok: false, error: 'invalid' });
  });
  it('distinguishes a partial source collection from empty/unconfigured services without leaking source payloads', async () => {
    const { env } = setup();
    await env.BRIEFING.put(
      'miniAppNewsSnapshot',
      JSON.stringify({
        generatedAt: new Date(now).toISOString(),
        attemptedAt: new Date(now).toISOString(),
        groups: [{ title: 'PRIVATE-HEADLINE' }],
        sources: [
          { name: 'BBC', enabled: true, ok: false, count: 0, error: 'PRIVATE-PROVIDER-ERROR' },
        ],
      }),
    );
    const services = await readSystemServices(env, now);
    expect(services.find((s) => s.id === 'news')).toMatchObject({ state: 'degraded' });
    expect(services.find((s) => s.id === 'mono')).toMatchObject({ state: 'not-configured' });
    expect(services.find((s) => s.id === 'memory')).toMatchObject({ state: 'empty' });
    expect(JSON.stringify(services)).not.toContain('PRIVATE-');
  });
});
describe('billing adapters are explicit, scoped and resilient', () => {
  function configure(env: ReturnType<typeof workerEnv>) {
    return Object.assign(env, {
      SYSTEM_BILLING_MODE: 'manual',
      OPENAI_BILLING_ADMIN_KEY: 'ADMIN-SECRET',
      OPENAI_BILLING_PROJECT_ID: 'proj-example',
      DEEPGRAM_BILLING_API_KEY: 'DEEPGRAM-SECRET',
      DEEPGRAM_BILLING_PROJECT_ID: 'project-example',
    });
  }
  const costs = (more = false) => ({
    data: [
      { results: [{ project_id: 'proj-example', amount: { value: '0.15', currency: 'usd' } }] },
    ],
    has_more: more,
    next_page: more ? 'page-2' : null,
  });
  it('reads all OpenAI pages in the specified project without pretending to know a prepaid balance', async () => {
    const { env } = setup();
    configure(env);
    const network = vi
      .fn()
      .mockResolvedValueOnce(Response.json(costs(true)))
      .mockResolvedValueOnce(Response.json(costs()));
    const result = await fetchOpenAiBilling(env, period, network);
    expect(result).toMatchObject({ costUsd: 0.3, balanceUsd: null, provisional: true });
    expect(new URL(network.mock.calls[0]![0]).searchParams.get('project_ids')).toBe('proj-example');
    expect(new URL(network.mock.calls[1]![0]).searchParams.get('page')).toBe('page-2');
  });
  it('rejects another project/currency, missing data and repeated pagination instead of accepting a partial bill', async () => {
    const { env } = setup();
    configure(env);
    for (const body of [
      { data: [{ results: [{ project_id: 'other', amount: { value: 1, currency: 'usd' } }] }] },
      {
        data: [
          { results: [{ project_id: 'proj-example', amount: { value: 1, currency: 'eur' } }] },
        ],
      },
      {},
      { data: [], has_more: true, next_page: null },
    ])
      await expect(
        fetchOpenAiBilling(env, period, vi.fn().mockResolvedValue(Response.json(body))),
      ).rejects.toThrow();
    await expect(
      fetchOpenAiBilling(
        env,
        period,
        vi.fn().mockImplementation(async () => Response.json(costs(true))),
      ),
    ).rejects.toThrow('incomplete');
  });
  it('reads Deepgram costs and USD balance separately, labels provider day boundaries, and verifies returned dates', async () => {
    const { env } = setup();
    configure(env);
    const network = vi.fn().mockImplementation(async (url: string) =>
      Response.json(
        url.includes('/balances')
          ? {
              balances: [
                { amount: 10, units: 'USD' },
                { amount: 999, units: 'EUR' },
              ],
            }
          : { start: period.from, end: period.to, results: [{ dollars: 0.02 }, { dollars: 0.03 }] },
      ),
    );
    expect(await fetchDeepgramBilling(env, period, network)).toMatchObject({
      costUsd: 0.05,
      balanceUsd: 10,
      timeZone: 'provider',
    });
    expect(new URL(network.mock.calls[0]![0]).searchParams.get('end')).toBe(period.to);
    const wrong = vi
      .fn()
      .mockImplementation(async (url: string) =>
        Response.json(
          url.includes('/balances')
            ? { balances: [] }
            : { start: '2000-01-01', end: period.to, results: [] },
        ),
      );
    await expect(fetchDeepgramBilling(env, period, wrong)).rejects.toThrow('scope');
  });
  it('requires dedicated configuration, prevents concurrent reads, and preserves a prior bill after access failure', async () => {
    const { env } = setup();
    const network = vi.fn().mockResolvedValue(Response.json(costs()));
    expect(await refreshSystemBilling(env, 'openai', period, now, network)).toMatchObject({
      ok: false,
      error: 'not-configured',
    });
    expect(network).not.toHaveBeenCalled();
    configure(env);
    expect(await refreshSystemBilling(env, 'openai', period, now, network)).toMatchObject({
      ok: true,
    });
    expect(await refreshSystemBilling(env, 'openai', period, now + 1, network)).toMatchObject({
      ok: false,
      error: 'cooldown',
    });
    network.mockResolvedValue(new Response('PRIVATE-PROVIDER-ERROR', { status: 403 }));
    expect(await refreshSystemBilling(env, 'openai', period, now + 60001, network)).toMatchObject({
      ok: false,
      error: 'access',
    });
    const result = await readSystemBilling(env, period);
    expect(result.items.find((i) => i.provider === 'openai')).toMatchObject({
      snapshot: { costUsd: 0.15 },
      errorClass: 'access',
    });
    expect(JSON.stringify(result)).not.toContain('PRIVATE-PROVIDER-ERROR');
    expect(JSON.stringify(result)).not.toContain('ADMIN-SECRET');
  });
});
