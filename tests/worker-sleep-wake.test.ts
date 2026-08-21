import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../web/worker.js';
import { SLEEP_H_BUCKETS, snapSleepHours } from '../web/stats-core.mjs';
import { memoryKv } from './helpers/kv.js';
import { buildInitData } from './helpers/init-data.js';
import { workerEnv } from './helpers/env.js';

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
  return workerEnv({
    BRIEFING: memoryKv(kv),
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    TELEGRAM_OWNER_USER_ID: String(OWNER),
    ...overrides,
  });
}

/** Той самий HMAC-алгоритм Telegram WebApp initData, що worker.js validateInitData. */

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
/**
 * Подія в конкретний момент.
 *
 * ⚠️ initData підписується НА ТОЙ САМИЙ момент, що й запит. Сценарій крутить
 * годинник на дні назад, тож підпис, зроблений один раз наперед, для воркера
 * лежав би в МАЙБУТНЬОМУ — і двобічна перевірка auth_date (SV-B3) чесно його
 * відкидала б. Це не обхід перевірки, а виправлення фікстури: справжній клієнт
 * теж підписує в момент запиту.
 */
async function at(iso: string, type: string, extra: Record<string, unknown> = {}) {
  vi.setSystemTime(new Date(iso));
  const initData = await buildInitData(OWNER, BOT_TOKEN, {
    authDateSec: Math.floor(new Date(iso).getTime() / 1000),
  });
  return postEvt({ type, initData, ...extra });
}

beforeEach(() => {
  kv = new Map();
  vi.useFakeTimers();
});

afterEach(() => vi.useRealTimers());

describe('sleepStart -> open: повний цикл через worker.fetch, дві ночі поспіль', () => {
  it('Ніч 1 (звичайний сценарій, 8.0 год) і Ніч 2 (РЕГРЕСІЯ: передсонний open того ж календарного дня, 5.0 год) — обидві коректно підставляють sleepH+bedtime', async () => {
    // ── Ніч 1: 23:00 Київ 04.08 -> 07:00 Київ 05.08 (рівно 8 год) ──────────
    let res = await at('2026-08-04T20:00:00Z', 'sleepStart'); // Kyiv 23:00
    expect(res.status).toBe(200);

    res = await at('2026-08-05T04:00:00Z', 'open'); // Kyiv 07:00, наступний день
    expect(res.status).toBe(200);

    let stats = JSON.parse(kv.get('stats')!);
    expect(stats.sleepLog['2026-08-04']).toEqual({
      startedAt: '2026-08-04T20:00:00.000Z',
      bedtimeBucket: 'e00', // тап о 23:00 Київ
      wokeAt: '2026-08-05T04:00:00.000Z',
    });
    // 8.0 год -> бакет «8–9» (8.5), НЕ голе 8: UI знає лише середини
    // діапазонів (SLEEP_H_BUCKETS) і звіряє їх суворою рівністю, тож 8
    // рендерилось би як «нічого не обрано» — саме цей баг ловив власник.
    expect(stats.checkins['2026-08-05'].morning).toEqual({ sleepH: 8.5, bedtime: 'e00' });

    // ── Ніч 2: РЕГРЕСІЯ. Спершу пізній передсонний open ТОГО Ж календарного
    //    дня (Kyiv 01:00 06.08 — вже після півночі, ДО тапу «Ліг спати»),
    //    який раніше зʼїдав firstOpenToday. ─────────────────────────────────
    res = await at('2026-08-05T22:00:00Z', 'open'); // Kyiv 01:00 06.08
    expect(res.status).toBe(200);

    // Тап «Ліг спати» 15 хв по тому — checkinDateKey зсуває ніч на 05.08.
    res = await at('2026-08-05T22:15:00Z', 'sleepStart'); // Kyiv 01:15 06.08
    expect(res.status).toBe(200);

    stats = JSON.parse(kv.get('stats')!);
    expect(stats.sleepLog['2026-08-05'].startedAt).toBe('2026-08-05T22:15:00.000Z');
    expect(stats.sleepLog['2026-08-05'].wokeAt).toBeUndefined(); // ще не прокинувся

    // Реальне ранкове відкриття — ТОЙ САМИЙ календарний день (06.08), що й
    // передсонний open вище. Рівно 5 год потому.
    res = await at('2026-08-06T03:15:00Z', 'open'); // Kyiv 06:15
    expect(res.status).toBe(200);

    stats = JSON.parse(kv.get('stats')!);
    expect(stats.sleepLog['2026-08-05']).toEqual({
      startedAt: '2026-08-05T22:15:00.000Z',
      bedtimeBucket: 'e02', // тап о 01:15 Київ
      wokeAt: '2026-08-06T03:15:00.000Z',
    });
    expect(stats.checkins['2026-08-06'].morning).toEqual({ sleepH: 5.5, bedtime: 'e02' }); // 5.0 -> «5–6»

    // Ніч 1 лишилась незачепленою другим циклом.
    expect(stats.checkins['2026-08-05'].morning).toEqual({ sleepH: 8.5, bedtime: 'e00' });
  });

  it('РЕГРЕСІЯ (фідбек власника: «досі не працює автоматична підстановка часу сну»): підставлене значення ЗАВЖДИ з набору бакетів UI, а не точне число', async () => {
    // 7 год 36 хв — саме той «некруглий» сон, що давав 7.6 і не підсвічувався
    // (UI звіряє суворою рівністю з SLEEP_H_BUCKETS).
    await at('2026-08-04T20:00:00Z', 'sleepStart'); // Kyiv 23:00
    await at('2026-08-05T03:36:00Z', 'open'); // Kyiv 06:36 -> 7.6 год

    const stats = JSON.parse(kv.get('stats')!);
    const { sleepH } = stats.checkins['2026-08-05'].morning;
    expect(sleepH).toBe(7.5); // бакет «7–8», не 7.6
    expect(SLEEP_H_BUCKETS).toContain(sleepH);
  });

  it('snapSleepHours: межі діапазонів і клемп по краях', () => {
    expect(snapSleepHours(7.6)).toBe(7.5); // 7–8
    expect(snapSleepHours(7.0)).toBe(7.5); // рівно 7 -> той самий «7–8»
    expect(snapSleepHours(7.99)).toBe(7.5);
    expect(snapSleepHours(8.0)).toBe(8.5); // межа переходить у «8–9»
    expect(snapSleepHours(2.3)).toBe(3.5); // нижче шкали -> «<4»
    expect(snapSleepHours(13.5)).toBe(9.5); // вище шкали -> «9+»
    // Інваріант: що б не виміряли, значення завжди рендериться в UI.
    for (let h = 0.1; h <= 14; h += 0.1) expect(SLEEP_H_BUCKETS).toContain(snapSleepHours(h));
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
      const res = await at(utcIso, 'sleepStart');
      expect(res.status).toBe(200);
      const stats = JSON.parse(kv.get('stats')!);
      const [night] = Object.values(stats.sleepLog) as { bedtimeBucket: string }[];
      expect(night?.bedtimeBucket).toBe(EXPECTED[hour]);
    });
  }
});
