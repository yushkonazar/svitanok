import { describe, it, expect } from 'vitest';
import worker from '../web/worker.js';
import { handleAnalytics } from '../web/api-analytics.mjs';
import { workerEnv } from './helpers/env.js';

const levers = {
  weekOf: '2026-09-21',
  ready: true,
  weeks: 30,
  weeksNeeded: 0,
  tested: 2,
  rows: [],
};

const env = () =>
  workerEnv({
    BRIEFING: {
      get: async (key: string) => {
        if (key === 'stats') return JSON.stringify({ goal: { weeklyTarget: 5 } });
        if (key === 'levers') return JSON.stringify(levers);
        return null;
      },
    },
    ASSETS: { fetch: async () => new Response('nf', { status: 404 }) },
  });

describe('GET /api/analytics — owner-only, read-only контракт 4D', () => {
  it('неавторизований виклик не бачить аналітику', async () => {
    const res = await handleAnalytics(env(), { ok: false, status: 401, error: 'auth' });
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).not.toContain('hypotheses');
  });

  it('публікує тільки розділений snapshot і не кешує персональні агрегати', async () => {
    const res = await handleAnalytics(env(), { ok: true });
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as {
      facts: unknown[];
      hypotheses: unknown[];
      patterns: unknown[];
    };
    expect(body.facts.length).toBeGreaterThan(0);
    expect(body.hypotheses.length).toBeGreaterThan(0);
    expect(body.patterns).toEqual([]);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('%s не виконує жодної дії', async (method) => {
    const res = await worker.fetch(
      new Request('https://svitanok.example/api/analytics', { method }),
      env(),
      {
        waitUntil: () => {},
      },
    );
    expect(res.status).toBe(405);
  });
});
