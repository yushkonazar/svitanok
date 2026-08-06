import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// @ts-expect-error — JS-модуль Worker'а без типів.
import worker from '../web/worker.js';

/* Інтеграційний тест повного циклу «Ліг спати» -> ранкове відкриття ->
 * автозаповнення чек-іну, через СПРАВЖНІЙ worker.fetch (POST /api/event), а
 * не пряме звернення до recordEvent (те лишається в stats-core.test.ts).
 *
 * Причина окремого файлу: фідбек власника після фіксу — «прожени окремий
 * тест… поетапно спроектуй робочу ситуацію». Це відтворення на РЕАЛЬНОМУ
 * ланцюжку подій (sleepStart -> open) із КОНТРОЛЬОВАНИМ годинником
 * (vi.useFakeTimers), той самий стиль, що worker-event-checkin.test.ts —
 * але stats-core.test.ts бʼє напряму в recordEvent(store, ev, dateKey, ...)
 * з РУЧНО підібраними dateKey/nowIso, тож НЕ перевіряє, що worker.js сам
 * правильно рахує kyivHour/checkinDateKey/kyivDateKey навколо півночі —
 * саме тут і жив баг (регресія: firstOpenToday рахувався по calendar-дню,
 * який worker.js виводить із ЦИХ функцій, а не з переданого вручну dateKey).
 *
 * Дві ночі, ДВА РІЗНІ значення тривалості сну (8.0 і 5.0 год) — щоб
 * переконатись, що підстановка не завʼязана на один конкретний випадок:
 * - Ніч 1: звичайний сценарій (сон -> ранкове відкриття наступного
 *   календарного дня, jitter-нейтральний).
 * - Ніч 2: ТОЧНЕ відтворення регресії — пізній передсонний open ТОГО Ж
 *   календарного дня, що й пізніше ранкове відкриття (Kyiv-доба вже за
 *   північчю до тапу «Ліг спати»), яке раніше зʼїдало firstOpenToday. */

const OWNER = 4242;
const BOT_TOKEN = 'bot-token-abc';

let kv: Map<string, string>;

function env(overrides: Record<string, unknown> = {}) {
  return {
    BRIEFING: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => void kv.set(k, v),
      list: async () => ({ keys: [] }),
    },
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    TELEGRAM_OWNER_USER_ID: String(OWNER),
    ...overrides,
  };
}

/** Той самий HMAC-алгоритм Telegram WebApp initData, що worker.js validateInitData. */
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

async function postEvt(body: Record<string, unknown>, e = env()) {
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

/** Просуває фейковий годинник і одразу шле подію в цей момент — щоб kyivHour/
 *  kyivDateKey/checkinDateKey усередині worker.js рахували ТОЙ САМИЙ момент,
 *  що бачить тест (а не розсинхронізований nowIso). */
async function at(
  iso: string,
  type: string,
  initData: string,
  extra: Record<string, unknown> = {},
) {
  vi.setSystemTime(new Date(iso));
  return postEvt({ type, initData, ...extra });
}

beforeEach(() => {
  kv = new Map();
  vi.useFakeTimers();
});

afterEach(() => vi.useRealTimers());

describe('sleepStart -> open: повний цикл через worker.fetch, дві ночі поспіль', () => {
  it('Ніч 1 (звичайний сценарій, 8.0 год) і Ніч 2 (РЕГРЕСІЯ: передсонний open того ж календарного дня, 5.0 год) — обидві коректно підставляють sleepH+bedtime', async () => {
    const initData = await buildInitData(OWNER, BOT_TOKEN);

    // ── Ніч 1: 23:00 Київ 04.08 -> 07:00 Київ 05.08 (рівно 8 год) ──────────
    let res = await at('2026-08-04T20:00:00Z', 'sleepStart', initData); // Kyiv 23:00
    expect(res.status).toBe(200);

    res = await at('2026-08-05T04:00:00Z', 'open', initData); // Kyiv 07:00, наступний день
    expect(res.status).toBe(200);

    let stats = JSON.parse(kv.get('stats')!);
    expect(stats.sleepLog['2026-08-04']).toEqual({
      startedAt: '2026-08-04T20:00:00.000Z',
      bedtimeBucket: 'e00', // тап о 23:00 Київ
      wokeAt: '2026-08-05T04:00:00.000Z',
    });
    expect(stats.checkins['2026-08-05'].morning).toEqual({ sleepH: 8, bedtime: 'e00' });

    // ── Ніч 2: РЕГРЕСІЯ. Спершу пізній передсонний open ТОГО Ж календарного
    //    дня (Kyiv 01:00 06.08 — вже після півночі, ДО тапу «Ліг спати»),
    //    який раніше зʼїдав firstOpenToday. ─────────────────────────────────
    res = await at('2026-08-05T22:00:00Z', 'open', initData); // Kyiv 01:00 06.08
    expect(res.status).toBe(200);

    // Тап «Ліг спати» 15 хв по тому — checkinDateKey зсуває ніч на 05.08.
    res = await at('2026-08-05T22:15:00Z', 'sleepStart', initData); // Kyiv 01:15 06.08
    expect(res.status).toBe(200);

    stats = JSON.parse(kv.get('stats')!);
    expect(stats.sleepLog['2026-08-05'].startedAt).toBe('2026-08-05T22:15:00.000Z');
    expect(stats.sleepLog['2026-08-05'].wokeAt).toBeUndefined(); // ще не прокинувся

    // Реальне ранкове відкриття — ТОЙ САМИЙ календарний день (06.08), що й
    // передсонний open вище. Рівно 5 год потому.
    res = await at('2026-08-06T03:15:00Z', 'open', initData); // Kyiv 06:15
    expect(res.status).toBe(200);

    stats = JSON.parse(kv.get('stats')!);
    expect(stats.sleepLog['2026-08-05']).toEqual({
      startedAt: '2026-08-05T22:15:00.000Z',
      bedtimeBucket: 'e02', // тап о 01:15 Київ
      wokeAt: '2026-08-06T03:15:00.000Z',
    });
    expect(stats.checkins['2026-08-06'].morning).toEqual({ sleepH: 5, bedtime: 'e02' });

    // Ніч 1 лишилась незачепленою другим циклом.
    expect(stats.checkins['2026-08-05'].morning).toEqual({ sleepH: 8, bedtime: 'e00' });
  });
});

describe('bedtimeBucketForHour (worker.js, приватна — лише через реальний HTTP): весь реалістичний діапазон тапу', () => {
  // РЕГРЕСІЯ: стара умова `h < 23` ловила години 0-22 ще ДО перевірок на
  // конкретні 0/1 -> будь-який тап після півночі писав 'e23' замість
  // коректного бакета. Перевіряємо ВЕСЬ діапазон 20:00-05:00 Київ, по одній
  // ночі на годину — кожна година мусить дати СВІЙ бакет, не 'e23' за замовчуванням.
  const KYIV_HOUR_TO_UTC_DATE: [number, string][] = [
    [20, '2026-08-04T17:00:00Z'],
    [21, '2026-08-04T18:00:00Z'],
    [22, '2026-08-04T19:00:00Z'],
    [23, '2026-08-04T20:00:00Z'],
    [0, '2026-08-04T21:00:00Z'], // Kyiv 00:00 05.08
    [1, '2026-08-04T22:00:00Z'], // Kyiv 01:00 05.08
    [2, '2026-08-04T23:00:00Z'], // Kyiv 02:00 05.08
    [5, '2026-08-05T02:00:00Z'], // Kyiv 05:00 05.08
  ];
  const EXPECTED: Record<number, string> = {
    20: 'e23',
    21: 'e23',
    22: 'e23',
    23: 'e00',
    0: 'e01',
    1: 'e02',
    2: 'late',
    5: 'late',
  };

  for (const [hour, utcIso] of KYIV_HOUR_TO_UTC_DATE) {
    it(`Київ ${hour}:00 -> bedtimeBucket "${EXPECTED[hour]}"`, async () => {
      kv = new Map();
      const initData = await buildInitData(OWNER, BOT_TOKEN);
      const res = await at(utcIso, 'sleepStart', initData);
      expect(res.status).toBe(200);
      const stats = JSON.parse(kv.get('stats')!);
      const [night] = Object.values(stats.sleepLog) as { bedtimeBucket: string }[];
      expect(night?.bedtimeBucket).toBe(EXPECTED[hour]);
    });
  }
});
