// RunRegistry (етап 1, PR-4): DO на фейковому сховищі + фейковій D1, клієнт з
// гейтом за прапорцем. Телеметрія best-effort: жоден збій реєстру не сміє
// зірвати прогін — це і є головний контракт клієнта.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RunRegistryDO } from '../web/core/run-registry/do.mjs';
import {
  registryBegin,
  registryFinish,
  RUN_REGISTRY_DO_NAME,
} from '../web/core/run-registry/client.mjs';
import { agentRunWatchdog } from '../web/agent-runtime.mjs';
import { workerEnv } from './helpers/env.js';

const T0 = Date.parse('2026-08-27T10:00:00.000Z');

/** Фейкова D1: журнал prepare/bind — тест звіряє SQL і аргументи. */
function makeDb() {
  const calls: { sql: string; args: unknown[] }[] = [];
  return {
    calls,
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        run: async () => {
          calls.push({ sql, args });
        },
      }),
    }),
  };
}

function makeRegistry(db?: ReturnType<typeof makeDb> | null) {
  const kv = new Map<string, unknown>();
  const ctx = {
    storage: {
      get: async (k: string) => kv.get(k),
      put: async (k: string, v: unknown) => {
        kv.set(k, v);
      },
      deleteAll: async () => {
        kv.clear();
      },
      setAlarm: async () => {},
    },
  };
  const env = db === null ? {} : { DB: db ?? makeDb() };
  return { registry: new RunRegistryDO(ctx as never, env as never), db: env.DB };
}

describe('RunRegistryDO', () => {
  it('begin: активний набір росте, у D1 летить INSERT з ISO-часом', async () => {
    const db = makeDb();
    const { registry } = makeRegistry(db);
    const res = await registry.begin({ id: 'r1', trigger: 'chat', threadId: 42, startedMs: T0 });
    expect(res).toEqual({ active: 1 });
    expect(await registry.has('r1')).toBe(true);
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0]?.sql).toContain('INSERT INTO runs');
    expect(db.calls[0]?.args).toEqual(['r1', 'chat', null, '42', null, new Date(T0).toISOString()]);
  });

  it('finish: рахує duration від startedMs, прибирає з активних', async () => {
    const db = makeDb();
    const { registry } = makeRegistry(db);
    await registry.begin({ id: 'r1', trigger: 'chat', startedMs: T0 });
    await registry.finish('r1', { finishedMs: T0 + 7_500 });
    expect(await registry.has('r1')).toBe(false);
    const update = db.calls[1];
    expect(update?.sql).toContain('UPDATE runs');
    expect(update?.sql).toContain('finished_at IS NULL'); // ідемпотентність фінішу
    expect(update?.args).toEqual([new Date(T0 + 7_500).toISOString(), 7_500, null, null, 'r1']);
  });

  it('finish невідомого id: рядок закривається без duration, без падіння', async () => {
    const db = makeDb();
    const { registry } = makeRegistry(db);
    await registry.finish('ghost', { finishedMs: T0, error: 'timeout' });
    expect(db.calls[0]?.args).toEqual([new Date(T0).toISOString(), null, 'timeout', null, 'ghost']);
  });

  it('sweepStale: закриває лише прострочені, з error=timeout', async () => {
    const db = makeDb();
    const { registry } = makeRegistry(db);
    await registry.begin({ id: 'old', trigger: 'chat', startedMs: T0 });
    await registry.begin({ id: 'fresh', trigger: 'chat', startedMs: T0 + 5 * 60_000 });
    const closed = await registry.sweepStale(T0 + 6 * 60_000 + 1, 6 * 60_000);
    expect(closed).toEqual(['old']);
    expect(await registry.has('old')).toBe(false);
    expect(await registry.has('fresh')).toBe(true);
    const update = db.calls.find((c) => c.sql.includes('UPDATE'));
    expect(update?.args).toContain('timeout');
  });

  // Етап 4 PR-2: прогін в Actions (idea-analysis) живе до 40 хв - власна
  // стеля сторожа, інакше run_id закривався б до артефакту (403 run-unknown).
  it('sweepStale: staleMs прогону перекриває загальну стелю', async () => {
    const db = makeDb();
    const { registry } = makeRegistry(db);
    await registry.begin({ id: 'long', trigger: 'actions', startedMs: T0, staleMs: 45 * 60_000 });
    await registry.begin({ id: 'chat', trigger: 'chat', startedMs: T0 });
    expect(await registry.sweepStale(T0 + 20 * 60_000, 6 * 60_000)).toEqual(['chat']);
    expect(await registry.has('long')).toBe(true);
    expect(await registry.sweepStale(T0 + 46 * 60_000, 6 * 60_000)).toEqual(['long']);
  });

  it('consumeNonce: перший раз true, повтор false, старі чистяться за віком', async () => {
    const { registry } = makeRegistry();
    expect(await registry.consumeNonce('r1', 'n1', T0, 20 * 60_000)).toBe(true);
    expect(await registry.consumeNonce('r1', 'n1', T0 + 1_000, 20 * 60_000)).toBe(false);
    // Інший прогін із тим самим nonce — інший ключ, не колізія.
    expect(await registry.consumeNonce('r2', 'n1', T0, 20 * 60_000)).toBe(true);
    // Після вікна памʼяті nonce забуто (сам підпис на той час уже stale).
    expect(await registry.consumeNonce('r1', 'n1', T0 + 21 * 60_000, 20 * 60_000)).toBe(true);
  });

  it('без привʼязки DB control-plane begin лишається доступним', async () => {
    const { registry } = makeRegistry(null);
    await expect(registry.begin({ id: 'r1', trigger: 'chat', startedMs: T0 })).resolves.toEqual({
      active: 1,
    });
    expect(await registry.has('r1')).toBe(true);
  });

  it('finish залишає короткий completion window для idempotent report, але не для tools', async () => {
    const { registry } = makeRegistry();
    await registry.begin({ id: 'r1', trigger: 'chat', startedMs: T0 });
    expect(await registry.finish('r1', { finishedMs: T0 + 1 })).toMatchObject({
      newlyFinished: true,
    });
    expect(await registry.has('r1')).toBe(false);
    expect(await registry.hasOrCompleted('r1', T0 + 2)).toBe(true);
    expect(await registry.finish('r1', { finishedMs: T0 + 3 })).toMatchObject({
      newlyFinished: false,
    });
  });
});

describe('registryBegin/registryFinish — клієнт', () => {
  let begins: unknown[];
  let finishes: unknown[];
  let errors: string[];

  const stubNs = {
    getByName: (name: string) => {
      expect(name).toBe(RUN_REGISTRY_DO_NAME);
      return {
        begin: async (run: unknown) => {
          begins.push(run);
        },
        finish: async (id: string, patch: unknown) => {
          finishes.push([id, patch]);
        },
      };
    },
  };

  beforeEach(() => {
    begins = [];
    finishes = [];
    errors = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      errors.push(a.join(' '));
    });
  });

  it('off (прапорця немає): реєстр не викликається взагалі', async () => {
    const env = workerEnv({ RUN_REGISTRY: stubNs });
    await registryBegin(env, { id: 'r', trigger: 'chat', startedMs: T0 });
    await registryFinish(env, 'r', { finishedMs: T0 });
    expect(begins).toEqual([]);
    expect(finishes).toEqual([]);
    expect(errors).toEqual([]); // off — не помилка конфігурації, а норма
  });

  it('shadow: begin і finish долітають до DO', async () => {
    const env = workerEnv({ ASSISTANT_V2: 'shadow', RUN_REGISTRY: stubNs });
    await registryBegin(env, { id: 'r', trigger: 'chat', startedMs: T0 });
    await registryFinish(env, 'r', { finishedMs: T0 + 1 });
    expect(begins).toHaveLength(1);
    expect(finishes).toEqual([['r', { finishedMs: T0 + 1 }]]);
  });

  it('прапорець увімкнено, привʼязки немає — помилка конфігурації вголос', async () => {
    const env = workerEnv({ ASSISTANT_V2: 'shadow' });
    await registryBegin(env, { id: 'r', trigger: 'chat', startedMs: T0 });
    expect(errors.join('\n')).toContain('RUN_REGISTRY не привʼязано');
  });

  it('сторож старого агента закриває прогін у реєстрі з явною причиною', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 })),
    );
    const kv = new Map<string, string>([
      [
        'agentRuns',
        JSON.stringify({ r1: { startedMs: T0 - 10 * 60_000, chatId: '-1', threadId: null } }),
      ],
    ]);
    const env = workerEnv({
      ASSISTANT_V2: 'shadow',
      RUN_REGISTRY: stubNs,
      TELEGRAM_BOT_TOKEN: 't',
      TELEGRAM_CHAT_ID: '-1',
      BRIEFING: {
        get: async (k: string) => kv.get(k) ?? null,
        put: async (k: string, v: string) => void kv.set(k, v),
        list: async () => ({ keys: [] }),
      },
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
    try {
      await agentRunWatchdog(env);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
    expect(finishes).toEqual([['r1', expect.objectContaining({ error: 'timeout' })]]);
  });

  it('збій DO повертає false для fail-closed старту', async () => {
    const env = workerEnv({
      ASSISTANT_V2: 'on',
      RUN_REGISTRY: {
        getByName: () => ({
          begin: async () => {
            throw new Error('DO впав');
          },
          finish: async () => {
            throw new Error('DO впав');
          },
        }),
      },
    });
    await expect(registryBegin(env, { id: 'r', trigger: 'chat', startedMs: T0 })).resolves.toBe(
      false,
    );
    // finish тепер повертає інфо прогону; збій DO - чесний null, не виняток.
    await expect(registryFinish(env, 'r', { finishedMs: T0 })).resolves.toBeNull();
    expect(errors.join('\n')).toContain('begin впав');
  });
});

describe('runInfo: чернетка статусу', () => {
  it('віддається лише активному прогону треду - запізнілий deliver чужу не редагує', async () => {
    const { registry } = makeRegistry();
    await registry.begin({ id: 'r1', trigger: 'chat', threadId: 'dm', startedMs: T0 });
    await registry.begin({ id: 'r2', trigger: 'chat', threadId: 'dm', startedMs: T0 });
    await registry.threadClaim('dm', { text: 'перше', route: 'chat', attempts: 0, atMs: T0 });
    await registry.threadSetRun('dm', 'r1', 629, T0);

    expect(await registry.runInfo('r1')).toMatchObject({ threadId: 'dm', statusMessageId: 629 });

    // Тред пішов далі (ескалація або наступний запис черги) - чернетка тепер
    // чужа, і фінал r1 не сміє її переписати.
    await registry.threadSetRun('dm', 'r2', 700, T0);
    expect((await registry.runInfo('r1'))?.statusMessageId).toBeNull();
    expect((await registry.runInfo('r2'))?.statusMessageId).toBe(700);
  });

  it('прогін без треду (summarize) - чернетки немає, а не виняток', async () => {
    const { registry } = makeRegistry();
    await registry.begin({ id: 's1', trigger: 'scheduler', threadId: null, startedMs: T0 });
    expect(await registry.runInfo('s1')).toMatchObject({ statusMessageId: null });
  });
});
