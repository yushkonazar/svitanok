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

    const f1 = await reg.threadFinish('dm');
    expect(f1.next).toMatchObject({ text: 'друге' });
    // Тред усе ще взятий (під 'друге'), у черзі лишилось 'третє' - нове стає
    // за ним, позиція 2.
    expect(await reg.threadClaim('dm', entry('четверте'))).toEqual({ queued: 2 });

    expect((await reg.threadFinish('dm')).next).toMatchObject({ text: 'третє' });
    expect((await reg.threadFinish('dm')).next).toMatchObject({ text: 'четверте' });
    expect((await reg.threadFinish('dm')).next).toBeNull();
    // Тред звільнено - claim знову start.
    expect(await reg.threadClaim('dm', entry('пʼяте'))).toEqual({ start: true });
  });

  it('finish без claim (summarize-прогін) - тихий null, нічого не ламає', async () => {
    const reg = makeRegistry();
    expect((await reg.threadFinish('нема-такого')).next).toBeNull();
  });

  it('setRun запамʼятовує runId і статусник; clear віддає їх і чистить чергу (S-0-3)', async () => {
    const reg = makeRegistry();
    await reg.threadClaim('dm', entry('перше'));
    await reg.threadSetRun('dm', 'run-1', 77);
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
    expect(await registryThreadFinish(env, 'dm')).toEqual({ next: null });
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
