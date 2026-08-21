import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../web/worker.js';
import { memoryKv } from './helpers/kv.js';
import { buildInitData } from './helpers/init-data.js';
import { workerEnv } from './helpers/env.js';

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
  return workerEnv({
    BRIEFING: memoryKv(kv),
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    TELEGRAM_OWNER_USER_ID: String(OWNER),
  });
}

async function postEvent(body: Record<string, unknown>, e: Env) {
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

async function postVote(body: Record<string, unknown>, e: Env) {
  return worker.fetch(
    new Request('https://svitanok.example/api/vote', {
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
    const e = workerEnv({
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
    });

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

/* B4 (аудит 11.08.2026): handleVote був ЄДИНИМ писарем 'stats' повз updateStats —
 * сирий put() після одного loadStats(). ❤️ по новині, що збіглося з 5-хвилинним
 * кроном, тихо стирало бік, який програв гонку. Симптом той самий, що й у
 * блоку вище, лише інша точка входу (POST /api/vote замість /api/event). */
describe('handleVote — голос за новину не затирає конкурентного писаря stats', () => {
  it('❤️ у вікні 5-хв крона: і інтерес, і зміна крона лишаються в KV', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-05T05:30:00.000Z'));
    const initData = await buildInitData(OWNER, BOT_TOKEN);

    kv.set('stats', JSON.stringify({ interests: {}, sleepLog: {}, days: {} }));

    let getCalls = 0;
    const e = workerEnv({
      ...baseEnv(),
      BRIEFING: {
        get: async (k: string) => {
          if (k === 'stats') {
            getCalls++;
            // Конкурентний крон уклинюється РІВНО між першим і другим читанням
            // updateStats — тим самим вікном, що покриває оптимістичний retry.
            if (getCalls === 1) {
              kv.set(
                'stats',
                JSON.stringify({
                  interests: {},
                  sleepLog: { '2026-08-04': { nudgeCleared: true } },
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
    });

    const res = await postVote({ category: 'Технології', dir: 'up', initData }, e);
    expect(res.status).toBe(200);
    // Рівно два читання 'stats' == голос пройшов через updateStats, а не через
    // loadStats + сирий put (той робив би одне).
    expect(getCalls).toBe(2);

    const stats = JSON.parse(kv.get('stats')!);
    expect(stats.interests['Технології']).toBe(1); // голос зарахований...
    expect(stats.sleepLog['2026-08-04'].nudgeCleared).toBe(true); // ...і крон не затертий
  });
});

/* S3: тіло запиту без стелі означало, що вартість обробки задає той, хто його
 * шле — Worker спершу матеріалізує скільки завгодно даних і лише потім бачить,
 * що вони не потрібні. Найбільше законне тіло тут — блоб settings (сотні
 * байтів), тож 16КБ — запас на два порядки. */
describe('стеля розміру тіла запиту (S3)', () => {
  it('тіло понад 16КБ -> 413 ще ДО розбору JSON і ДО авторизації', async () => {
    const huge = JSON.stringify({ type: 'open', pad: 'я'.repeat(20_000) });
    const res = await worker.fetch(
      new Request('https://svitanok.example/api/event', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: huge,
      }),
      baseEnv(),
      { waitUntil: () => {} },
    );
    expect(res.status).toBe(413);
    expect(kv.get('stats')).toBeUndefined();
  });

  it('кирилиця рахується в БАЙТАХ, не символах (UTF-8 — два байти на літеру)', async () => {
    // ~9000 кириличних символів = ~18КБ. Перевірка по .length пропустила б.
    const body = JSON.stringify({ type: 'open', pad: 'я'.repeat(9_000) });
    expect(body.length).toBeLessThan(16 * 1024);
    const res = await worker.fetch(
      new Request('https://svitanok.example/api/event', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
      baseEnv(),
      { waitUntil: () => {} },
    );
    expect(res.status).toBe(413);
  });

  it('звичайне тіло проходить як раніше', async () => {
    const res = await postEvent({ type: 'open' }, baseEnv());
    expect([400, 401, 403]).toContain(res.status); // без initData — авторизація, не 413
  });
});
