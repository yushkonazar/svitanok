import { describe, it, expect } from 'vitest';
import worker from '../web/worker.js';
import { ARCHIVE_KEY } from '../web/stats-archive.mjs';
import { handleArchive } from '../web/api-archive.mjs';
import { workerEnv } from './helpers/env.js';

/* GET /api/archive — читання холодного архіву місячних згорток.
 *
 * ⚠️ ОКРЕМИЙ ЕНДПОІНТ, а не поле в /api/stats. Той крутить aggregateStats на
 * КОЖЕН запит у бюджеті 10 мс CPU, і ми щойно виграли там 3.4 мс; додати туди
 * ще одне KV-читання заради даних, які потрібні лише коли людина відкриє
 * «Історію», означало б платити цю ціну на кожному відкритті дашборда.
 *
 * ⚠️ ПРИВАТНИЙ, на відміну від /api/status: тут середні по сну, енергії й
 * настрою за роки — це не «сервіс живий», це щоденник. */

const env = (value: string | null, extra: Partial<Env> = {}) =>
  workerEnv({
    BRIEFING: { get: async (k: string) => (k === ARCHIVE_KEY ? value : null) },
    ASSETS: { fetch: async () => new Response('nf', { status: 404 }) },
    ...extra,
  });

const call = (e: Env, headers: Record<string, string> = {}) =>
  worker.fetch(new Request('https://svitanok.yushko.dev/api/archive', { headers }), e, {
    waitUntil: () => {},
  });

describe('GET /api/archive — доступ', () => {
  it('без initData -> 401, а не дані', async () => {
    const res = await call(env(JSON.stringify({ '2026-07': { checkinDays: 30 } })));
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).not.toContain('checkinDays');
  });

  it('не отримує публічних CORS-заголовків (це НЕ /api/status)', async () => {
    const res = await call(env(null));
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('GET /api/archive — форма відповіді', () => {
  // Авторизацію тут не імітуємо (вона покрита auth-core.test.ts) — перевіряємо
  // саме перетворення архіву у відповідь через експортований хендлер.
  it('порожній архів -> порожній список, не виняток', async () => {
    const res = await handleArchive(env(null), { ok: true });
    expect(await res.json()).toEqual({ months: [] });
  });

  it('місяці віддаються масивом, ХРОНОЛОГІЧНО', async () => {
    const raw = JSON.stringify({
      '2026-07': { checkinDays: 30, sleepAvg: 7.2 },
      '2026-05': { checkinDays: 28, sleepAvg: 6.8 },
      '2026-06': { checkinDays: 29, sleepAvg: 7.0 },
    });
    const body = (await (await handleArchive(env(raw), { ok: true })).json()) as {
      months: { month: string; sleepAvg?: number }[];
    };
    expect(body.months.map((m: { month: string }) => m.month)).toEqual([
      '2026-05',
      '2026-06',
      '2026-07',
    ]);
    expect(body.months[0]!.sleepAvg).toBe(6.8);
  });

  it('битий архів -> порожній список, а не 500', async () => {
    expect(await (await handleArchive(env('не-json'), { ok: true })).json()).toEqual({
      months: [],
    });
  });

  it('битий місяць пропускається, решта лишається', async () => {
    const raw = JSON.stringify({
      '2026-07': { checkinDays: 30 },
      'не-місяць': { x: 1 },
      bad: null,
    });
    const body = (await (await handleArchive(env(raw), { ok: true })).json()) as {
      months: { month: string; sleepAvg?: number }[];
    };
    expect(body.months.map((m: { month: string }) => m.month)).toEqual(['2026-07']);
  });

  it('не кешується публічно — це приватні дані', async () => {
    const res = await handleArchive(env(null), { ok: true });
    expect(res.headers.get('cache-control') ?? '').not.toContain('public');
  });
});
