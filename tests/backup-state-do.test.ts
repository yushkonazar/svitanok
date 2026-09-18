import { describe, expect, it } from 'vitest';
import {
  backupStateClaim,
  backupStateComplete,
  backupStateRelease,
} from '../web/core/backup-state/client.mjs';
import { BACKUP_STATE_DO_NAME } from '../web/core/backup-state/contract.mjs';
import { BackupStateDO } from '../web/core/backup-state/do.mjs';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';

const STATE = { date: '2026-09-20', attempts: 1, done: false, alertedMissing: false };

function setup() {
  const kv = new Map<string, string>();
  const storage = new Map<string, unknown>();
  const env = workerEnv({ BRIEFING: memoryKv(kv) });
  const backup = new BackupStateDO(
    {
      storage: {
        get: async (key: string) => storage.get(key),
        put: async (key: string, value: unknown) => void storage.set(key, value),
        delete: async (key: string) => void storage.delete(key),
      },
    } as never,
    env,
  );
  env.BACKUP_STATE = {
    getByName: (name: string) => (name === BACKUP_STATE_DO_NAME ? backup : null),
  } as never;
  return { env, kv };
}

describe('BackupStateDO — one weekly Drive backup attempt at a time', () => {
  it('два cron ticks беруть рівно один lease', async () => {
    const { env } = setup();
    const claims = await Promise.all([
      backupStateClaim(env, STATE, 1_000, 60_000),
      backupStateClaim(env, STATE, 1_000, 60_000),
    ]);
    expect(claims.filter((claim) => claim.ok)).toHaveLength(1);
  });
  it('тільки власник lease завершує backup state і дзеркалить його у KV', async () => {
    const { env, kv } = setup();
    const claim = await backupStateClaim(env, STATE, 1_000, 60_000);
    await expect(backupStateComplete(env, 'wrong', { ...STATE, done: true })).resolves.toBe(false);
    await expect(backupStateComplete(env, claim.token, { ...STATE, done: true })).resolves.toBe(
      true,
    );
    expect(JSON.parse(kv.get('backupState') ?? '{}')).toMatchObject({ done: true });
  });
  it('після retryable помилки release дозволяє наступну спробу', async () => {
    const { env } = setup();
    const claim = await backupStateClaim(env, STATE, 1_000, 60_000);
    await backupStateRelease(env, claim.token);
    await expect(backupStateClaim(env, STATE, 1_001, 60_000)).resolves.toMatchObject({ ok: true });
  });
});
