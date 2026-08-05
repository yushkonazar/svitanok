import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// @ts-expect-error — JS-модуль Worker'а без типів.
import worker from '../web/worker.js';

/* Регресія на реальний баг (фідбек власника, 2026-08-05): тапнув «Ліг спати»
 * вночі, вранці відкрив застосунок — авто-заповнення сну в чек-іні не
 * зʼявилось. Розслідування: чиста recordEvent-логіка коректна (перевірено
 * ізольовано на реальних production-даних), але worker.js мав 5 незалежних
 * read-modify-write циклів на ОДИН і той самий KV-ключ 'stats' без жодного
 * захисту від конкурентного запису (applyEvent, голосування за новину, три
 * 5-хвилинні крони) — «останній записав перемагає» тихо стирало щойно
 * записане авто-заповнення, якщо крон встиг прочитати СТАРУ копію до
 * ранкового відкриття, а дописати ПІСЛЯ (його власні Telegram-виклики —
 * секунди, реальне вікно гонки).
 *
 * updateStats() — оптимістична конкуренція (один retry): якщо між першим і
 * другим читанням хтось інший записав, застосовуємо ТУ САМУ чисту мутацію ще
 * раз до свіжішої копії. Тест симулює конкурентного писаря РІВНО в тому
 * вікні, яке updateStats має покривати. */

const OWNER = 4242;
const BOT_TOKEN = 'bot-token-abc';

let kv: Map<string, string>;

function baseEnv() {
  return {
    BRIEFING: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => void kv.set(k, v),
      list: async () => ({ keys: [] }),
    },
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    TELEGRAM_OWNER_USER_ID: String(OWNER),
  };
}

async function buildInitData(userId: number, botToken: string, authDateSec?: number) {
  const user = JSON.stringify({ id: userId, first_name: 'O' });
  const authDate = authDateSec ?? Math.floor(Date.now() / 1000);
  const params = new URLSearchParams({ user, auth_date: String(authDate) });
  const dataCheck = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode('WebAppData'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const secretBytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(botToken)));
  const secretKey = await crypto.subtle.importKey(
    'raw',
    secretBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', secretKey, enc.encode(dataCheck)));
  const hash = [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
  params.set('hash', hash);
  return params.toString();
}

async function postEvent(body: Record<string, unknown>, e: unknown) {
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
});

afterEach(() => vi.useRealTimers());

describe('updateStats — конкурентний запис між двома читаннями не губить зміни', () => {
  it('ранкове відкриття (авто-заповнення сну) переживає крон, що вклинився МІЖ читаннями updateStats', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-05T05:30:00.000Z')); // ~08:30 Київ, ранок
    const initData = await buildInitData(OWNER, BOT_TOKEN);

    kv.set(
      'stats',
      JSON.stringify({
        sleepLog: {
          '2026-08-04': { startedAt: '2026-08-04T22:56:40.592Z', bedtimeBucket: 'e23' },
        },
        checkins: {},
        days: {},
      }),
    );

    let getCalls = 0;
    const e = {
      ...baseEnv(),
      BRIEFING: {
        get: async (k: string) => {
          if (k === 'stats') {
            getCalls++;
            // Виклики на 'stats' для одного POST /api/event {type:'open'}:
            // 1) applyEvent pre-check (loadStats), 2) updateStats перше
            // читання, 3) updateStats друге (конфлікт-перевірка) читання.
            // Вставляємо конкурентний запис РІВНО між (2) і (3) — той самий
            // проміжок, що реально стався: крон прочитав СТАРУ копію до
            // цього POST, а дописав (Telegram-виклики — секунди) уже ПІСЛЯ
            // того, як (2) відбулось, але ДО (3).
            if (getCalls === 3) {
              kv.set(
                'stats',
                JSON.stringify({
                  sleepLog: {
                    '2026-08-04': {
                      startedAt: '2026-08-04T22:56:40.592Z',
                      bedtimeBucket: 'e23',
                      nudgeCleared: true, // конкурентна зміна крону
                    },
                  },
                  checkins: {},
                  days: {},
                }),
              );
            }
          }
          return kv.get(k) ?? null;
        },
        put: async (k: string, v: string) => void kv.set(k, v),
        list: async () => ({ keys: [] }),
      },
    };

    const res = await postEvent({ type: 'open', initData }, e);
    expect(res.status).toBe(200);
    expect(getCalls).toBe(3); // підтверджуємо, що тест реально вклинився в очікуване вікно

    const stats = JSON.parse(kv.get('stats')!);
    // Авто-заповнення сну (з ранкового 'open') НЕ загублено...
    expect(stats.sleepLog['2026-08-04'].wokeAt).toBeTruthy();
    expect(stats.checkins['2026-08-05'].morning.sleepH).toBeGreaterThan(0);
    expect(stats.checkins['2026-08-05'].morning.bedtime).toBe('e23');
    // ...і конкурентна зміна крону теж НЕ загублена (обидві сторони гонки
    // збереглись — це й є суть retry «застосувати patch ще раз до свіжішого»).
    expect(stats.sleepLog['2026-08-04'].nudgeCleared).toBe(true);
  });

  it('без конфлікту (ніхто не встиг записати між читаннями) -> звичайний єдиний запис, як і раніше', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-05T05:30:00.000Z'));
    const initData = await buildInitData(OWNER, BOT_TOKEN);

    kv.set(
      'stats',
      JSON.stringify({
        sleepLog: {
          '2026-08-04': { startedAt: '2026-08-04T22:56:40.592Z', bedtimeBucket: 'e23' },
        },
        checkins: {},
        days: {},
      }),
    );

    const res = await postEvent({ type: 'open', initData }, baseEnv());
    expect(res.status).toBe(200);

    const stats = JSON.parse(kv.get('stats')!);
    expect(stats.sleepLog['2026-08-04'].wokeAt).toBeTruthy();
    expect(stats.checkins['2026-08-05'].morning.sleepH).toBeGreaterThan(0);
  });
});
