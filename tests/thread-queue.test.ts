// Черга треду в RunRegistry DO (ADR-039, етап 2 PR-3): один активний прогін на
// тред, claim/queue/finish/clear, стеля черги, ізольованість тредів. Клієнт -
// fail-closed на claim (краще «спробуй пізніше», ніж два паралельні прогони).

import { describe, it, expect, vi } from 'vitest';
import { RunRegistryDO, THREAD_QUEUE_MAX } from '../web/core/run-registry/do.mjs';
import {
  registryThreadClaim,
  registryThreadFinish,
  registryThreadClear,
} from '../web/core/run-registry/client.mjs';
import { workerEnv } from './helpers/env.js';

const T0 = Date.parse('2026-08-27T10:00:00.000Z');

function makeRegistry() {
  const kv = new Map<string, unknown>();
  const ctx = {
    storage: {
      get: async (k: string) => kv.get(k),
      put: async (k: string, v: unknown) => {
        kv.set(k, v);
      },
    },
  };
  return new RunRegistryDO(ctx as never, {} as never);
}

const entry = (text: string, over: Record<string, unknown> = {}) => ({
  text,
  route: 'chat',
  attempts: 0,
  atMs: T0,
  ...over,
});

describe('RunRegistryDO: черга треду', () => {
  it('перший claim - start; другий - queued 1 (S-0-2); чужий тред - незалежний start', async () => {
    const reg = makeRegistry();
    expect(await reg.threadClaim('dm', entry('перше'))).toEqual({ start: true });
    expect(await reg.threadClaim('dm', entry('друге'))).toEqual({ queued: 1 });
    expect(await reg.threadClaim('dm', entry('третє'))).toEqual({ queued: 2 });
    expect(await reg.threadClaim('42', entry('інший тред'))).toEqual({ start: true });
  });

  it('finish віддає чергу по порядку і тримає тред взятим; порожня черга звільняє', async () => {
    const reg = makeRegistry();
    await reg.threadClaim('dm', entry('перше'));
    await reg.threadClaim('dm', entry('друге'));
    await reg.threadClaim('dm', entry('третє'));

    const f1 = await reg.threadFinish('dm', null);
    expect(f1.next).toMatchObject({ text: 'друге' });
    // Тред усе ще взятий (під 'друге'), у черзі лишилось 'третє' - нове стає
    // за ним, позиція 2.
    expect(await reg.threadClaim('dm', entry('четверте'))).toEqual({ queued: 2 });

    expect((await reg.threadFinish('dm', null)).next).toMatchObject({ text: 'третє' });
    expect((await reg.threadFinish('dm', null)).next).toMatchObject({ text: 'четверте' });
    expect((await reg.threadFinish('dm', null)).next).toBeNull();
    // Тред звільнено - claim знову start.
    expect(await reg.threadClaim('dm', entry('пʼяте'))).toEqual({ start: true });
  });

  it('finish без claim (summarize-прогін) - тихий null, нічого не ламає', async () => {
    const reg = makeRegistry();
    expect((await reg.threadFinish('нема-такого', null)).next).toBeNull();
  });

  it('setRun запамʼятовує runId і статусник; clear віддає їх і чистить чергу (S-0-3)', async () => {
    const reg = makeRegistry();
    await reg.threadClaim('dm', entry('перше'));
    await reg.threadSetRun('dm', 'run-1', 77, T0);
    await reg.threadClaim('dm', entry('друге'));
    await reg.threadClaim('dm', entry('третє'));

    const cleared = await reg.threadClear('dm');
    expect(cleared).toEqual({ activeRunId: 'run-1', statusMessageId: 77, cleared: 2 });
    // Після «стоп» тред вільний.
    expect(await reg.threadClaim('dm', entry('нове'))).toEqual({ start: true });
    // clear порожнього - нулі, не виняток.
    expect(await reg.threadClear('чужий')).toEqual({
      activeRunId: null,
      statusMessageId: null,
      cleared: 0,
    });
  });

  it('clear до setRun (прогін ще pending) - activeRunId null: нема кого абортити', async () => {
    const reg = makeRegistry();
    await reg.threadClaim('dm', entry('перше'));
    const cleared = await reg.threadClear('dm');
    expect(cleared.activeRunId).toBeNull();
  });

  it('стеля черги: понад THREAD_QUEUE_MAX - queued:-1 (чесна відмова)', async () => {
    const reg = makeRegistry();
    await reg.threadClaim('dm', entry('активне'));
    for (let i = 0; i < THREAD_QUEUE_MAX; i += 1) {
      expect(await reg.threadClaim('dm', entry(`q${i}`))).toEqual({ queued: i + 1 });
    }
    expect(await reg.threadClaim('dm', entry('зайве'))).toEqual({ queued: -1 });
  });
});

describe('клієнт черги: fail-closed', () => {
  it('збій DO на claim - {queued:-1}, finish/clear - порожні відповіді, без винятків', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = workerEnv({
      ASSISTANT_V2: 'on',
      RUN_REGISTRY: {
        getByName: () => ({
          threadClaim: async () => {
            throw new Error('DO впав');
          },
          threadFinish: async () => {
            throw new Error('DO впав');
          },
          threadClear: async () => {
            throw new Error('DO впав');
          },
        }),
      },
    });
    expect(await registryThreadClaim(env, 'dm', entry('x'))).toEqual({ queued: -1 });
    expect(await registryThreadFinish(env, 'dm', null)).toEqual({ next: null });
    expect(await registryThreadClear(env, 'dm')).toEqual({
      activeRunId: null,
      statusMessageId: null,
      cleared: 0,
    });
  });

  it('при off реєстру «не існує» - claim теж відмовляє (новий шлях вимкнено)', async () => {
    const env = workerEnv({ ASSISTANT_V2: 'off' });
    expect(await registryThreadClaim(env, 'dm', entry('x'))).toEqual({ queued: -1 });
  });
});

describe('RunRegistryDO: власність і сторож (ревʼю PR-3)', () => {
  it('threadFinish чужим runId (summarize) - no-op notOwner: черга і claim цілі', async () => {
    const reg = makeRegistry();
    await reg.threadClaim('dm', entry('перше'));
    await reg.threadSetRun('dm', 'run-chat', 77, T0);
    await reg.threadClaim('dm', entry('у черзі'));

    const foreign = await reg.threadFinish('dm', 'run-summarize');
    expect(foreign).toEqual({ next: null, notOwner: true });
    // Claim живий, черга не вкрадена, «стоп» досі бачить справжній прогін.
    expect(await reg.threadClaim('dm', entry('третє'))).toEqual({ queued: 2 });
    const own = await reg.threadFinish('dm', 'run-chat');
    expect(own.next).toMatchObject({ text: 'у черзі' });
  });

  it('threadSetRun на зниклому треді («стоп» у вікні pending) - claimed:false', async () => {
    const reg = makeRegistry();
    await reg.threadClaim('dm', entry('перше'));
    await reg.threadClear('dm');
    expect(await reg.threadSetRun('dm', 'run-1', 77, T0)).toEqual({ claimed: false });
    // Живий тред - claimed:true (і ескалація легітимно переписує runId).
    await reg.threadClaim('dm', entry('нове'));
    expect(await reg.threadSetRun('dm', 'run-2', 78, T0)).toEqual({ claimed: true });
    expect(await reg.threadSetRun('dm', 'run-3-escalated', 78, T0 + 1)).toEqual({ claimed: true });
  });

  it('threadRetry ставить на ПОЧАТОК черги і звільняє тред; kickNext бере голову', async () => {
    const reg = makeRegistry();
    await reg.threadClaim('dm', entry('активне'));
    await reg.threadClaim('dm', entry('друге'));
    await reg.threadRetry('dm', { ...entry('ретрай'), attempts: 1, statusMessageId: 42 });
    // Тред вільний із чергою: нове повідомлення стає ПОЗАДУ ретраю.
    expect(await reg.threadClaim('dm', entry('третє'))).toEqual({ queued: 3 });
    const kick = await reg.threadKickNext('dm');
    expect(kick.next).toMatchObject({ text: 'ретрай', attempts: 1, statusMessageId: 42 });
    // Тред знову взятий - другий kick мовчить.
    expect((await reg.threadKickNext('dm')).next).toBeNull();
  });

  it('threadSweep: мертвий claim звільняється після grace, живий і свіжий - ні', async () => {
    const reg = makeRegistry();
    // Живий: активний у реєстрі (begin без D1 неможливий - стаб db).
    // Використовуємо два «мертві» треди і один свіжий pending.
    await reg.threadClaim('dead', { ...entry('загублений'), statusMessageId: 71, chatId: 999 });
    await reg.threadSetRun('dead', 'run-dead', 71, T0);
    await reg.threadClaim('dead', entry('чекає в черзі'));
    await reg.threadClaim('fresh', entry('щойно'));

    // Свіжий pending (grace не вийшов) - не чіпається.
    let freed = await reg.threadSweep(T0 + 10_000, 90_000);
    expect(freed).toEqual([]);

    // Після grace: run-dead не значиться в активних → тред звільнено, черга
    // лишилась; fresh теж прострочений pending → звільнено і видалено (без черги).
    freed = await reg.threadSweep(T0 + 120_000, 90_000);
    expect(freed).toHaveLength(2);
    expect(freed.find((f: { threadId: string }) => f.threadId === 'dead')).toMatchObject({
      statusMessageId: 71,
      chatId: 999,
      queued: 1,
    });
    // Черга dead піднімається kick-ом.
    expect((await reg.threadKickNext('dead')).next).toMatchObject({ text: 'чекає в черзі' });
    // fresh зник цілком.
    expect(await reg.threadClaim('fresh', entry('нове'))).toEqual({ start: true });
  });

  it('threadSweep НЕ чіпає тред, чий прогін живий у реєстрі активних', async () => {
    const db = { prepare: () => ({ bind: () => ({ run: async () => ({}) }) }) };
    const kv = new Map<string, unknown>();
    const ctx = {
      storage: {
        get: async (k: string) => kv.get(k),
        put: async (k: string, v: unknown) => void kv.set(k, v),
      },
    };
    const reg = new RunRegistryDO(ctx as never, { DB: db } as never);
    await reg.begin({ id: 'run-live', trigger: 'chat', threadId: 'dm', startedMs: T0 });
    await reg.threadClaim('dm', entry('живе'));
    await reg.threadSetRun('dm', 'run-live', 77, T0);
    const freed = await reg.threadSweep(T0 + 999_999, 90_000);
    expect(freed).toEqual([]);
  });
});
