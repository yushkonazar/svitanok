/// <reference types="@cloudflare/vitest-plugin/types" />

// Мінімальний, але справжній runtime-контур: binding-и з production
// wrangler.jsonc, D1-міграції й singleton Durable Object працюють у workerd,
// а не в Node-імітаціях із tests/stubs.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env as runtimeEnv } from 'cloudflare:workers';
import {
  applyD1Migrations,
  createExecutionContext,
  createScheduledController,
  introspectWorkflow,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
  waitOnExecutionContext,
} from 'cloudflare:test';
import type { D1Database } from '@cloudflare/workers-types';
import type { StateStoreDO } from '../../web/core/state-store/do.mjs';
import worker from '../../web/worker.js';

type RuntimeEnv = Env & {
  DB: D1Database;
  STATE_STORE: NonNullable<Env['STATE_STORE']>;
  TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
};

type DayPlanWorkflow = {
  create(options: {
    id: string;
    params: { chainId: string; date: string };
  }): Promise<{ id: string }>;
};

const env = runtimeEnv as RuntimeEnv;

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await reset();
});

describe('Workers runtime', () => {
  it('застосовує production D1-міграції та ізолює KV binding', async () => {
    await env.BRIEFING.put('workers-runtime', 'ready');
    expect(await env.BRIEFING.get('workers-runtime')).toBe('ready');

    const table = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runs'",
    ).first<{ name: string }>();
    expect(table?.name).toBe('runs');
  });

  it('виконує StateStoreDO у workerd і дзеркалить підтверджений CAS у KV', async () => {
    const stub = env.STATE_STORE.get(env.STATE_STORE.idFromName('state-store'));
    const result = await runInDurableObject(stub, async (instance) => {
      const store = instance as StateStoreDO;
      const initial = await store.read('settings', { theme: 'dark' });
      const committed = await store.compareAndSet('settings', initial.version, { theme: 'light' });
      return { initial, committed };
    });

    expect(result.initial).toEqual({ version: 0, value: { theme: 'dark' } });
    expect(result.committed).toMatchObject({ ok: true, record: { version: 1 } });
    expect(JSON.parse((await env.BRIEFING.get('settings')) ?? '{}')).toEqual({ theme: 'light' });
  });

  it('віддає production asset і дочікується scheduled waitUntil у Workers runtime', async () => {
    const ctx = createExecutionContext();
    const page = await worker.fetch(new Request('https://svitanok.test/app/index.html'), env, ctx);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<!doctype html>');

    await worker.scheduled(createScheduledController({ scheduledTime: Date.now() }), env, ctx);
    await waitOnExecutionContext(ctx);
  });

  it('виконує alarm SchedulerDO та запускає Workflow у локальному Workers runtime', async () => {
    const schedulerBinding = env.SCHEDULER!;
    const scheduler = schedulerBinding.get(schedulerBinding.idFromName('scheduler'));
    await runInDurableObject(scheduler, async (instance) => {
      await instance.watchdogTick(Date.now());
    });
    expect(await runDurableObjectAlarm(scheduler)).toBe(true);

    const status = await runInDurableObject(scheduler, async (instance) => instance.status());
    expect(status.jobs.length).toBeGreaterThan(0);

    // Завершуваний Workflow-сценарій: sleep та подія підконтрольні тесту,
    // зовнішня доставка Telegram локально підмінена.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ok: true, result: { message_id: 1 } })),
    );
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO chains (id, kind, status, created_at, updated_at)
       VALUES (?, 'day-plan', 'running', ?, ?)`,
    )
      .bind('workers-day-plan-smoke', now, now)
      .run();
    const dayPlan = env.DAY_PLAN! as DayPlanWorkflow;
    const workflows = await introspectWorkflow(dayPlan as never);
    try {
      await workflows.modifyAll(async (modifier) => {
        await modifier.disableSleeps();
        await modifier.mockEvent({ type: 'intent', payload: { choice: 'skip' } });
      });
      await dayPlan.create({
        id: 'workers-day-plan-smoke',
        params: { chainId: 'workers-day-plan-smoke', date: '2099-01-02' },
      });
      const [instance] = await workflows.get();
      expect(instance).toBeDefined();
      await instance!.waitForStatus('complete');
      expect(await instance!.getOutput()).toEqual({ outcome: 'skipped' });
    } finally {
      await workflows.dispose();
    }
  });
});
