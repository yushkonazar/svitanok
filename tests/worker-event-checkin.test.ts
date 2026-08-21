import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../web/worker.js';
import { buildInitData } from './helpers/init-data.js';
import { workerEnv } from './helpers/env.js';

/* Інтеграційні тести POST /api/event для checkin (Mini App шлях, на відміну
 * від /api/agent-step, який тестує worker-agent-step.test.ts для агента).
 * Той самий стиль, що worker-weather.test.ts: справжній worker.fetch, стаб KV.
 *
 * Фокус — locked-контракт (applyEvent -> handleEvent): підтверджений блок
 * мусить (1) чесно повертати {ok:true, locked:true}, а не мовчати про
 * відкинутий запис, і (2) НЕ писати в KV даремно (put незмінених даних палить
 * ліміт KV 1 запис/сек без жодної користі). */

const OWNER = 4242;
const BOT_TOKEN = 'bot-token-abc';

let kv: Map<string, string>;
let putCalls: string[];

function env(overrides: Record<string, unknown> = {}) {
  return workerEnv({
    BRIEFING: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => {
        putCalls.push(k);
        kv.set(k, v);
      },
      list: async () => ({ keys: [] }),
    },
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    TELEGRAM_OWNER_USER_ID: String(OWNER),
    ...overrides,
  });
}

/** Той самий HMAC-алгоритм Telegram WebApp initData, що worker.js validateInitData. */

async function postCheckin(body: Record<string, unknown>, e = env()) {
  return worker.fetch(
    new Request('https://svitanok.example/api/event', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    e,
    { waitUntil: () => {} },
  );
}

beforeEach(() => {
  kv = new Map();
  putCalls = [];
});

afterEach(() => vi.useRealTimers());

describe('POST /api/event — checkin, locked-контракт', () => {
  it('звичайний запис -> {ok:true, locked:false}, KV оновлено', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T08:00:00Z')); // Київ 11:00 -> ранок
    const initData = await buildInitData(OWNER, BOT_TOKEN);
    const res = await postCheckin({ type: 'checkin', energy: 4, initData });
    expect(await res.json()).toEqual({ ok: true, locked: false });
    const stats = JSON.parse(kv.get('stats')!);
    const dateKey = Object.keys(stats.checkins)[0]!;
    expect(stats.checkins[dateKey].morning).toEqual({ energy: 4 });
  });

  it('вже підтверджений блок -> {ok:true, locked:true}, KV НЕ переписується', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T08:00:00Z')); // Київ 11:00 -> ранок
    const initData = await buildInitData(OWNER, BOT_TOKEN);

    await postCheckin({ type: 'checkin', energy: 4, initData });
    await postCheckin({ type: 'checkin', confirmed: true, initData });
    putCalls.length = 0; // цікавить лише ТРЕТІЙ виклик (на вже замкнений блок)

    const res = await postCheckin({ type: 'checkin', energy: 1, sleepH: 3, initData });
    expect(await res.json()).toEqual({ ok: true, locked: true });
    // Жодного нового запису в KV — замкнений блок не мусить палити ліміт
    // 1 запис/сек на дані, які однаково не зміняться.
    expect(putCalls).toEqual([]);

    const stats = JSON.parse(kv.get('stats')!);
    const dateKey = Object.keys(stats.checkins)[0]!;
    expect(stats.checkins[dateKey].morning).toEqual({ energy: 4, confirmed: true });
  });
});
