// Знижки на ігри (етап 5 PR-5, S-5-1…S-5-4, S-5-12): адаптери Steam/ITAD
// (батчі, розбір цін, ключ поза текстами помилок), задача steam-check о
// 10:00 (одне повідомлення, мовчання без знижок, пропуски й алерт на третій
// день, ознака розпродажу), імпорт wishlist і бажання type=game з чату.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  steamSearch,
  steamAppDetails,
  steamWishlist,
  itadLookup,
  itadPrices,
  bestDeal,
  historyLow,
  itadApiKey,
  STEAM_BATCH_MAX,
} from '../web/core/adapters/steam.mjs';
import {
  steamCheckTask,
  importSteamWishlist,
  resolveGameWish,
  listGameWishes,
  discountLine,
  salePrefix,
  settingSteamId,
  STEAM_MARKER_KEY,
  STEAM_MISS_KEY,
  STEAM_SALE_KEY,
  MISS_ALERT,
} from '../web/core/steam/check.mjs';
import { applyPolicy, resolveUndo } from '../web/core/policy/proposals.mjs';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';
import { d1FromSqlite } from './helpers/d1.js';

const MIGRATIONS = [
  '0001_base.sql',
  '0002_assistant.sql',
  '0003_telemetry.sql',
  '0004_ideas_travel.sql',
  '0007_instructions_plans.sql',
];
// Понеділок 07.09.2026 10:10 Києва (вікно задачі).
const AT_10 = Date.parse('2026-09-07T07:10:00.000Z');
const AT_09 = Date.parse('2026-09-07T06:10:00.000Z');

function setup(kv: Record<string, string> = {}) {
  const d1 = d1FromSqlite(MIGRATIONS);
  const env = workerEnv({
    DB: d1.stub,
    BRIEFING: memoryKv(new Map(Object.entries(kv))),
    TELEGRAM_CHAT_ID: '555',
    TOPIC_ASSISTANT: '99',
    TOPIC_SYSTEM: '77',
    ITAD_API_KEY: 'itad-secret',
  });
  return { d1, db: d1.db, env };
}

function seedWish(
  db: ReturnType<typeof setup>['db'],
  id: string,
  title: string,
  payload: Record<string, unknown>,
  status = 'active',
) {
  db.prepare(
    `INSERT INTO wishes (id, type, title, payload_json, status, created_at)
     VALUES (?, 'game', ?, ?, ?, '2026-09-01T00:00:00Z')`,
  ).run(id, title, JSON.stringify(payload), status);
}

function seedPoint(
  db: ReturnType<typeof setup>['db'],
  wishId: string,
  price: number,
  at = '2026-09-06T07:00:00Z',
) {
  db.prepare(
    `INSERT INTO price_points (id, wish_id, at, source, price, currency, url, is_low)
     VALUES (?, ?, ?, 'Steam', ?, 'UAH', '', 0)`,
  ).run(crypto.randomUUID(), wishId, at, price);
}

/** Маршрутизатор fetch: URL → відповідь. Невідомий URL - гучний провал. */
function routeFetch(routes: { match: string; body: unknown; status?: number }[]) {
  const calls: string[] = [];
  const fn = vi.fn(async (input: string) => {
    const url = String(input);
    calls.push(url);
    const hit = routes.find((r) => url.includes(r.match));
    if (!hit) throw new Error(`несподіваний запит: ${url}`);
    return new Response(JSON.stringify(hit.body), { status: hit.status ?? 200 });
  });
  vi.stubGlobal('fetch', fn);
  return { calls, fn };
}

const PRICES = (over: Record<string, unknown> = {}) => [
  {
    id: 'itad-1',
    historyLow: { all: { amount: 4.99, amountInt: 49900, currency: 'UAH' } },
    deals: [
      {
        shop: { id: 61, name: 'Steam' },
        price: { amount: 5.19, amountInt: 51900, currency: 'UAH' },
        regular: { amountInt: 64900, currency: 'UAH' },
        cut: 20,
        url: 'https://store.steampowered.com/app/1145350/',
      },
      {
        shop: { id: 16, name: 'GOG' },
        price: { amount: 6.49, amountInt: 64900, currency: 'UAH' },
        cut: 0,
        url: 'https://gog.com/x',
      },
    ],
    ...over,
  },
];

afterEach(() => vi.restoreAllMocks());

describe('адаптери Steam і ITAD', () => {
  it('пошук у Steam повертає appid, назву й ціну', async () => {
    routeFetch([
      {
        match: 'storesearch',
        body: {
          items: [{ id: 1145350, name: 'Hades II', price: { final: 64900, currency: 'UAH' } }],
        },
      },
    ]);
    expect(await steamSearch('Hades II', 1)).toEqual([
      { appid: 1145350, name: 'Hades II', price_minor: 64900, currency: 'UAH' },
    ]);
    await expect(steamSearch('   ')).rejects.toThrow(/порожній запит/);
  });

  it('appdetails: батчі по 50, ціна й знижка, назва лише коли просять', async () => {
    const { calls } = routeFetch([
      {
        match: 'appdetails',
        body: {
          '1': {
            success: true,
            data: {
              name: 'Гра',
              price_overview: {
                currency: 'UAH',
                initial: 64900,
                final: 51900,
                discount_percent: 20,
              },
            },
          },
          '2': { success: false },
        },
      },
    ]);
    const one = await steamAppDetails([1, 2]);
    expect(one.get(1)).toMatchObject({ price_minor: 51900, discount: 20, currency: 'UAH' });
    expect(one.has(2)).toBe(false);
    expect(calls[0]).toContain('filters=price_overview');
    expect(calls[0]).toContain('cc=UA');
    // Понад стелю батча - кілька викликів.
    const many = Array.from({ length: STEAM_BATCH_MAX + 1 }, (_, i) => i + 1);
    await steamAppDetails(many, { withName: true });
    expect(calls).toHaveLength(3);
    expect(calls[1]).not.toContain('filters=');
  });

  it('wishlist: лише SteamID64, порожній профіль - порожній список', async () => {
    routeFetch([
      { match: 'GetWishlist', body: { response: { items: [{ appid: 1 }, { appid: 2 }, {}] } } },
    ]);
    expect(await steamWishlist('76561198000000000')).toEqual([1, 2]);
    await expect(steamWishlist('123')).rejects.toThrow(/17 цифр/);
  });

  it('ITAD: lookup, батч цін, найкраща пропозиція і мінімум; ключ поза текстом помилки', async () => {
    const { env } = setup();
    routeFetch([
      { match: 'games/lookup', body: { found: true, game: { id: 'itad-1', title: 'Hades II' } } },
      { match: 'games/prices', body: PRICES() },
    ]);
    expect(await itadLookup(env, 1145350)).toEqual({ id: 'itad-1', title: 'Hades II' });
    const prices = await itadPrices(env, ['itad-1']);
    expect(prices.get('itad-1')).toEqual({
      best: {
        shop: 'Steam',
        price_minor: 51900,
        currency: 'UAH',
        cut: 20,
        url: 'https://store.steampowered.com/app/1145350/',
      },
      low_minor: 49900,
      low_currency: 'UAH',
    });
    // Помилка не несе ані ключа, ані URL.
    routeFetch([{ match: 'games/prices', body: {}, status: 500 }]);
    await expect(itadPrices(env, ['itad-1'])).rejects.toThrow(/^ITAD: HTTP 500$/);
    const { env: bare } = setup();
    (bare as { ITAD_API_KEY?: string }).ITAD_API_KEY = undefined;
    expect(() => itadApiKey(bare)).toThrow(/ITAD_API_KEY не заданий/);
  });

  it('розбір: найдешевша пропозиція з валідною ціною, мінімум «all»', () => {
    expect(bestDeal([{ price: { amountInt: 0 } }, { shop: {}, price: {} }])).toBeNull();
    expect(
      bestDeal([
        { shop: { name: 'A' }, price: { amountInt: 900, currency: 'UAH' }, cut: 10, url: 'u' },
        { shop: { name: 'B' }, price: { amountInt: 500, currency: 'UAH' }, cut: 50, url: 'v' },
      ]),
    ).toMatchObject({ shop: 'B', price_minor: 500 });
    expect(historyLow({ all: { amountInt: 100, currency: 'UAH' } })).toEqual({
      low_minor: 100,
      low_currency: 'UAH',
    });
    expect(historyLow(null)).toEqual({ low_minor: null, low_currency: null });
  });
});

describe('задача steam-check', () => {
  it('поза 10:00 і вдруге за день - не працює', async () => {
    const { env, db } = setup({ [STEAM_MARKER_KEY]: '2026-09-07' });
    seedWish(db, 'w1', 'Hades II', { steam_appid: 1, itad_id: 'itad-1' });
    expect(await steamCheckTask(env, AT_09)).toEqual({ skipped: 'hour' });
    expect(await steamCheckTask(env, AT_10)).toEqual({ skipped: 'done' });
  });

  it('знижка - одне повідомлення, ціна лягає в price_points', async () => {
    const { env, db } = setup();
    seedWish(db, 'w1', 'Hades II', { steam_appid: 1, itad_id: 'itad-1', target_price: 50_000 });
    seedPoint(db, 'w1', 64_900);
    routeFetch([{ match: 'games/prices', body: PRICES() }]);
    const out = await steamCheckTask(env, AT_10);
    expect(out).toMatchObject({ sent: true, games: 1, lines: 1 });
    const row = db.prepare('SELECT payload_json FROM outbox').get() as { payload_json: string };
    const text = JSON.parse(row.payload_json).text as string;
    expect(text).toContain('Знижки:');
    expect(text).toContain('«Hades II» −20 %');
    expect(text).toContain('519 грн');
    const point = db
      .prepare('SELECT price, currency, source FROM price_points ORDER BY at DESC LIMIT 1')
      .get() as { price: number; currency: string; source: string };
    expect(point).toMatchObject({ price: 51_900, currency: 'UAH', source: 'Steam' });
    expect(await env.BRIEFING.get(STEAM_MARKER_KEY)).toBe('2026-09-07');
  });

  it('ціна не змінилась - мовчання (повідомлення лише про новину)', async () => {
    const { env, db } = setup();
    seedWish(db, 'w1', 'Hades II', { steam_appid: 1, itad_id: 'itad-1' });
    seedPoint(db, 'w1', 51_900);
    routeFetch([{ match: 'games/prices', body: PRICES() }]);
    const out = await steamCheckTask(env, AT_10);
    expect(out).toMatchObject({ sent: false, lines: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM outbox').get()).toMatchObject({ n: 0 });
  });

  it('бажанню без itad_id id шукається один раз і записується', async () => {
    const { env, db } = setup();
    seedWish(db, 'w1', 'Hades II', { steam_appid: 1145350 });
    const { calls } = routeFetch([
      { match: 'games/lookup', body: { found: true, game: { id: 'itad-1', title: 'Hades II' } } },
      { match: 'games/prices', body: PRICES() },
    ]);
    await steamCheckTask(env, AT_10);
    expect(calls.filter((c) => c.includes('games/lookup'))).toHaveLength(1);
    const wish = (await listGameWishes(env))[0]!;
    expect(wish.itad_id).toBe('itad-1');
  });

  it('ITAD недоступний: пропуск дня, на третій - алерт у «Систему» (S-5-12)', async () => {
    const { env, db } = setup();
    seedWish(db, 'w1', 'Hades II', { steam_appid: 1, itad_id: 'itad-1' });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const day of ['2026-09-07', '2026-09-08', '2026-09-09']) {
      routeFetch([{ match: 'games/prices', body: {}, status: 503 }]);
      await env.BRIEFING.delete(STEAM_MARKER_KEY);
      const out = await steamCheckTask(env, Date.parse(`${day}T07:10:00.000Z`));
      expect(out).toMatchObject({ skipped: 'itad-failed' });
    }
    expect(await env.BRIEFING.get(STEAM_MISS_KEY)).toBe(String(MISS_ALERT));
    const rows = db.prepare('SELECT thread_id, payload_json FROM outbox').all() as {
      thread_id: string;
      payload_json: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.thread_id).toBe('77');
    expect(JSON.parse(rows[0]!.payload_json).text).toContain('3 дні поспіль');
    // Успішний день скидає лічильник.
    routeFetch([{ match: 'games/prices', body: PRICES() }]);
    await env.BRIEFING.delete(STEAM_MARKER_KEY);
    await steamCheckTask(env, Date.parse('2026-09-10T07:10:00.000Z'));
    expect(await env.BRIEFING.get(STEAM_MISS_KEY)).toBe('0');
  });

  it('розпродаж: кажемо лише про частку знижок і лише в день стрибка (S-5-4)', async () => {
    const { env } = setup();
    expect(await salePrefix(env, 0.7, 10, 7)).toContain('великий розпродаж');
    // Наступного дня частка та сама - мовчимо (розпродаж уже названо).
    expect(await salePrefix(env, 0.7, 10, 7)).toBe('');
    // Мало ігор - висновку не робимо.
    await env.BRIEFING.put(STEAM_SALE_KEY, '0');
    expect(await salePrefix(env, 1, 3, 3)).toBe('');
  });

  it('рядок знижки: відсоток, ціна, магазин, мінімум і ціль', () => {
    const wish = {
      id: 'w1',
      title: 'Hades II',
      appid: 1,
      itad_id: 'itad-1',
      target_price: 52_000,
      currency: 'UAH',
    };
    const best = {
      shop: 'Steam',
      price_minor: 51_900,
      currency: 'UAH',
      cut: 20,
      url: 'https://store.steampowered.com/app/1/',
    };
    const line = discountLine(wish, best, { low_minor: 49_900, isLow: true });
    expect(line).toBe('• «Hades II» −20 % (519 грн, Steam, мінімум за весь час) 🎯 ціль');
  });
});

describe('бажання-ігри з чату', () => {
  it('wishes.create type=game знаходить гру в Steam і ITAD (S-5-1)', async () => {
    const { env, db } = setup();
    routeFetch([
      {
        match: 'storesearch',
        body: {
          items: [{ id: 1145350, name: 'Hades II', price: { final: 64900, currency: 'UAH' } }],
        },
      },
      { match: 'games/lookup', body: { found: true, game: { id: 'itad-1', title: 'Hades II' } } },
      {
        match: 'appdetails',
        body: {
          '1145350': {
            success: true,
            data: {
              price_overview: {
                currency: 'UAH',
                initial: 64900,
                final: 64900,
                discount_percent: 0,
              },
            },
          },
        },
      },
    ]);
    const out = await applyPolicy(
      env,
      {
        kind: 'wishes.create',
        payload: { type: 'game', title: 'Hades II' },
        threadId: '99',
        chatId: 555,
        tainted: false,
      },
      AT_10,
    );
    if (out.mode !== 'executed') throw new Error(`mode ${out.mode}`);
    expect(String((out.result as { text: string }).text)).toBe(
      'Додав «Hades II» (Steam, зараз 649 грн). Скажу про будь-яку знижку.',
    );
    const wish = (await listGameWishes(env))[0]!;
    expect(wish).toMatchObject({ appid: 1145350, itad_id: 'itad-1', currency: 'UAH' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM wishes').get()).toMatchObject({ n: 1 });
  });

  it('гри немає в Steam - бажання лишається, причина названа', async () => {
    const { env } = setup();
    routeFetch([{ match: 'storesearch', body: { items: [] } }]);
    const out = await applyPolicy(
      env,
      { kind: 'wishes.create', payload: { type: 'game', title: 'Невідома' }, tainted: false },
      AT_10,
    );
    if (out.mode !== 'executed') throw new Error(`mode ${out.mode}`);
    expect(String((out.result as { note: string }).note)).toContain('не знайшов');
    expect((await listGameWishes(env)).map((w) => w.title)).toEqual(['Невідома']);
  });

  it('Steam упав під час створення - бажання записане, збій названий', async () => {
    const { env } = setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    routeFetch([{ match: 'storesearch', body: {}, status: 500 }]);
    const out = await applyPolicy(
      env,
      { kind: 'wishes.create', payload: { type: 'game', title: 'Hades II' }, tainted: false },
      AT_10,
    );
    if (out.mode !== 'executed') throw new Error(`mode ${out.mode}`);
    expect(String((out.result as { note: string }).note)).toContain('Steam/ITAD недоступні');
    expect(await listGameWishes(env)).toHaveLength(1);
  });

  it('resolveGameWish із відомим appid не шукає в магазині', async () => {
    const { env, db } = setup();
    seedWish(db, 'w1', 'Hades II', { steam_appid: 1145350 });
    const { calls } = routeFetch([
      { match: 'games/lookup', body: { found: true, game: { id: 'itad-1' } } },
      { match: 'appdetails', body: { '1145350': { success: false } } },
    ]);
    const out = await resolveGameWish(env, { id: 'w1', title: 'Hades II', appid: 1145350 });
    expect(out?.itad_id).toBe('itad-1');
    expect(calls.some((c) => c.includes('storesearch'))).toBe(false);
  });
});

describe('імпорт wishlist Steam (S-5-2)', () => {
  it('додає нові ігри, не дублює наявні, «↩» прибирає рівно імпортовані', async () => {
    const { env, db } = setup();
    seedWish(db, 'w1', 'Стара', { steam_appid: 1 });
    const iso = new Date(AT_10).toISOString();
    db.prepare(
      `INSERT INTO facts (id, kind, key, value_json, source, confidence, created_at, updated_at)
       VALUES ('f1', 'setting', 'steam_id', ?, 'owner', 1, ?, ?)`,
    ).run(JSON.stringify('76561198000000000'), iso, iso);
    expect(await settingSteamId(env)).toBe('76561198000000000');
    routeFetch([
      {
        match: 'GetWishlist',
        body: { response: { items: [{ appid: 1 }, { appid: 2 }, { appid: 3 }] } },
      },
      {
        match: 'appdetails',
        body: {
          '2': {
            success: true,
            data: {
              name: 'Гра 2',
              price_overview: { currency: 'UAH', final: 100, initial: 100, discount_percent: 0 },
            },
          },
          '3': { success: true, data: { name: 'Гра 3' } },
        },
      },
    ]);
    const out = await applyPolicy(
      env,
      {
        kind: 'wishes.import',
        payload: { source: 'steam' },
        threadId: '99',
        chatId: 555,
        tainted: false,
      },
      AT_10,
    );
    if (out.mode !== 'executed') throw new Error(`mode ${out.mode}`);
    expect(out.result).toMatchObject({ added: 2, skipped: 1 });
    expect(String((out.result as { text: string }).text)).toContain('Імпортував 2');
    expect((await listGameWishes(env)).map((w) => w.title).sort()).toEqual([
      'Гра 2',
      'Гра 3',
      'Стара',
    ]);
    expect(await resolveUndo(env, out.undo!.id, AT_10 + 1000)).toEqual({
      ok: true,
      status: 'undone',
    });
    expect((await listGameWishes(env)).map((w) => w.title)).toEqual(['Стара']);
  });

  it('без steam_id - чесне питання, без записів', async () => {
    const { env, db } = setup();
    await expect(importSteamWishlist(env, {}, AT_10)).rejects.toThrow(/steam id/i);
    expect(db.prepare('SELECT COUNT(*) AS n FROM wishes').get()).toMatchObject({ n: 0 });
  });

  it('закритий профіль - порожній список і пояснення, а не помилка', async () => {
    const { env } = setup();
    routeFetch([{ match: 'GetWishlist', body: { response: {} } }]);
    const out = await importSteamWishlist(env, { steam_id: '76561198000000000' }, AT_10);
    expect(out.result).toMatchObject({ added: 0 });
    expect(String(out.result.text)).toContain('приватності');
  });

  it('джерело, крім steam, - відмова', async () => {
    const { env } = setup();
    await expect(
      applyPolicy(
        env,
        { kind: 'wishes.import', payload: { source: 'gog' }, tainted: false },
        AT_10,
      ),
    ).rejects.toThrow(/не підтримується/);
  });
});
