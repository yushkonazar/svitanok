import { describe, expect, it } from 'vitest';
import {
  weeklyClaim,
  weeklyComplete,
  weeklyRelease,
} from '../web/core/weekly-review-state/client.mjs';
import { WEEKLY_REVIEW_STATE_DO_NAME } from '../web/core/weekly-review-state/contract.mjs';
import { WeeklyReviewStateDO } from '../web/core/weekly-review-state/do.mjs';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';

const STATE = { date: '2026-09-20', attempts: 1, runIds: ['r1'], alerted: false };

function setup() {
  const kv = new Map<string, string>();
  const storage = new Map<string, unknown>();
  const env = workerEnv({ BRIEFING: memoryKv(kv) });
  const review = new WeeklyReviewStateDO(
    {
      storage: {
        get: async (key: string) => storage.get(key),
        put: async (key: string, value: unknown) => void storage.set(key, value),
        delete: async (key: string) => void storage.delete(key),
      },
    } as never,
    env,
  );
  env.WEEKLY_REVIEW_STATE = {
    getByName: (name: string) => (name === WEEKLY_REVIEW_STATE_DO_NAME ? review : null),
  } as never;
  return { env, kv };
}

describe('WeeklyReviewStateDO — atomic weekly retry progression', () => {
  it('паралельні scheduler ticks отримують рівно один lease', async () => {
    const { env } = setup();
    const claims = await Promise.all([
      weeklyClaim(env, STATE, 1_000, 60_000),
      weeklyClaim(env, STATE, 1_000, 60_000),
    ]);
    expect(claims.filter((claim) => claim.ok)).toHaveLength(1);
  });

  it('лише lease owner може записати retry або фінальний alert', async () => {
    const { env, kv } = setup();
    const claim = await weeklyClaim(env, STATE, 1_000, 60_000);
    await expect(weeklyComplete(env, 'wrong', { ...STATE, attempts: 2 })).resolves.toBe(false);
    await expect(weeklyComplete(env, claim.token, { ...STATE, attempts: 2 })).resolves.toBe(true);
    expect(JSON.parse(kv.get('weeklyReviewState') ?? '{}')).toMatchObject({ attempts: 2 });
  });

  it('retryable шлях звільняє lease для наступного tick', async () => {
    const { env } = setup();
    const claim = await weeklyClaim(env, STATE, 1_000, 60_000);
    await expect(weeklyRelease(env, claim.token)).resolves.toBe(true);
    await expect(weeklyClaim(env, STATE, 1_001, 60_000)).resolves.toMatchObject({ ok: true });
  });
});
