// Квоти (етап 1, PR-10): період за київським місяцем, upsert за (key, period),
// алерти 80 %/100 % рівно один раз на перетин, /api/assistant-status для
// приймання етапу. D1 - node:sqlite зі справжніми міграціями 0002 (outbox) і
// 0003 (quota_counters).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { bumpQuota, readQuotas, quotaPeriod, QUOTA_LIMITS } from '../web/core/quota/quota.mjs';
import { handleAssistantStatus } from '../web/core/assistant-status.mjs';
import { buildInitData } from './helpers/init-data.js';
import { workerEnv } from './helpers/env.js';

const NOW = Date.parse('2026-08-28T12:00:00.000Z'); // Київ: 2026-08

function d1() {
  const db = new DatabaseSync(':memory:');
  for (const f of ['0002_assistant.sql', '0003_telemetry.sql']) {
    db.exec(readFileSync(join(__dirname, '..', 'web', 'core', 'migrations', f), 'utf8'));
  }
  return {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        run: async () => {
          // @ts-expect-error node:sqlite приймає біндинги варіативно
          const info = db.prepare(sql).run(...args);
          return { meta: { changes: Number(info.changes) } };
        },
        all: async () => ({
          // @ts-expect-error те саме для all
          results: db.prepare(sql).all(...args),
        }),
      }),
    }),
  };
}

let tgSent: string[];
let env: Env;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  tgSent = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('api.telegram.org')) {
        tgSent.push(JSON.parse(String(init?.body)).text);
        return new Response('{"ok":true}', { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }),
  );
  env = workerEnv({
    DB: d1(),
    TELEGRAM_BOT_TOKEN: 't',
    TELEGRAM_CHAT_ID: '-100',
    TOPIC_SYSTEM: '9',
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('bumpQuota', () => {
  it('період - київський місяць; послідовні bump-и сумуються в одному рядку', async () => {
    expect(quotaPeriod(NOW)).toBe('2026-08');
    await bumpQuota(env, { key: 'places_text', amount: 3, limit: 100, nowMs: NOW });
    const res = await bumpQuota(env, { key: 'places_text', amount: 2, limit: 100, nowMs: NOW });
    expect(res).toMatchObject({ value: 5, crossed80: false, crossed100: false });
    const rows = await readQuotas(env, NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: 'places_text', value: 5, limit_value: 100 });
  });

  it('новий місяць - новий рядок, старий лишається (ретенція 12 міс)', async () => {
    await bumpQuota(env, { key: 'routes', amount: 7, limit: 100, nowMs: NOW });
    const nextMonth = Date.parse('2026-09-02T12:00:00.000Z');
    const res = await bumpQuota(env, { key: 'routes', amount: 1, limit: 100, nowMs: nextMonth });
    expect(res.value).toBe(1); // не 8 - період інший
    expect(await readQuotas(env, nextMonth)).toHaveLength(1);
    expect(await readQuotas(env, NOW)).toHaveLength(1);
  });

  it('алерт 80 % - рівно один раз на перетин, 100 % - окремий', async () => {
    await bumpQuota(env, { key: 'gemini_usd', amount: 79, limit: 100, nowMs: NOW });
    expect(tgSent).toHaveLength(0);
    const cross = await bumpQuota(env, { key: 'gemini_usd', amount: 2, limit: 100, nowMs: NOW });
    expect(cross.crossed80).toBe(true);
    expect(tgSent).toHaveLength(1);
    expect(tgSent[0]).toContain('80 %');
    // Далі БЕЗ повторного 80-алерту.
    await bumpQuota(env, { key: 'gemini_usd', amount: 5, limit: 100, nowMs: NOW });
    expect(tgSent).toHaveLength(1);
    const full = await bumpQuota(env, { key: 'gemini_usd', amount: 20, limit: 100, nowMs: NOW });
    expect(full.crossed100).toBe(true);
    expect(tgSent).toHaveLength(2);
    expect(tgSent[1]).toContain('100 %');
  });

  it('невалідні amount/limit і відсутній DB - гучні винятки', async () => {
    await expect(bumpQuota(env, { key: 'x', amount: 0, limit: 10 })).rejects.toThrow(/додатним/);
    await expect(bumpQuota(env, { key: 'x', amount: 1, limit: 0 })).rejects.toThrow(/додатним/);
    await expect(bumpQuota(workerEnv(), { key: 'x', amount: 1, limit: 10 })).rejects.toThrow(/DB/);
  });

  it('довідник лімітів несе стелі 01 §7', () => {
    expect(QUOTA_LIMITS.places_text).toBe(5_000);
    expect(QUOTA_LIMITS.routes).toBe(10_000);
    expect(QUOTA_LIMITS.gemini_usd).toBe(10);
  });
});

describe('GET /api/assistant-status', () => {
  const OWNER = 777;
  const BOT = 'bot-token-abc';

  const call = async (e: Env, initData?: string) =>
    handleAssistantStatus(
      new Request('https://svitanok.test/api/assistant-status', {
        headers: initData ? { 'X-Telegram-Init-Data': initData } : {},
      }),
      e,
    );

  const statusEnv = (over: Record<string, unknown> = {}) =>
    workerEnv({
      ASSISTANT_V2: 'shadow',
      TELEGRAM_BOT_TOKEN: BOT,
      TELEGRAM_OWNER_USER_ID: String(OWNER),
      DB: d1(),
      SCHEDULER: {
        getByName: () => ({
          status: async () => ({ jobs: [{ kind: 'heartbeat' }], jitter: null }),
        }),
      },
      RUN_REGISTRY: { getByName: () => ({ snapshot: async () => ({ active: {} }) }) },
      ...over,
    });

  it('off - 404; без initData - 401', async () => {
    expect((await call(workerEnv({ TELEGRAM_BOT_TOKEN: BOT }))).status).toBe(404);
    expect((await call(statusEnv())).status).toBe(401);
  });

  it('власник бачить планувальник, прогони і квоти; збій блоку не ховає решту', async () => {
    const initData = await buildInitData(OWNER, BOT);
    const okRes = await call(statusEnv(), initData);
    expect(okRes.status).toBe(200);
    const body = (await okRes.json()) as {
      mode: string;
      scheduler: { jobs: unknown[] };
      quotas: unknown[];
    };
    expect(body.mode).toBe('shadow');
    expect(body.scheduler.jobs).toHaveLength(1);
    expect(Array.isArray(body.quotas)).toBe(true);

    // Без привʼязки SCHEDULER блок несе явний error, а квоти живі.
    const broken = await call(statusEnv({ SCHEDULER: undefined }), initData);
    const bBody = (await broken.json()) as { scheduler: { error?: string } };
    expect(broken.status).toBe(200);
    expect(bBody.scheduler.error).toContain('SCHEDULER');
  });
});
