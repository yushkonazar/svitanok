import { describe, it, expect } from 'vitest';
import {
  kyivHour,
  kyivDateKey,
  kyivMinAfter8,
  kyivMinuteOfDay,
  bedtimeBucketForHour,
} from '../web/kyiv-time.mjs';

/* Київський час, витягнутий із worker.js (Фаза 5, модуляризація). Досі ці
 * функції можна було перевірити лише через HTTP-виклик усього воркера — а на
 * них тримається КОЖНЕ часове рішення: вікно брифінгу, тихі години, слот
 * чек-іну, дедуплікація за добу.
 *
 * Головне, що тут доводиться: жодного ручного зсуву годин. Київ — UTC+2 взимку
 * і UTC+3 влітку, тож саме DST і є той випадок, який ламав би `+3` у коді. */

const SUMMER = new Date('2026-07-10T08:00:00Z'); // EEST, UTC+3 -> 11:00 Київ
const WINTER = new Date('2026-01-10T08:00:00Z'); // EET,  UTC+2 -> 10:00 Київ

describe('kyivHour / kyivDateKey — DST рахує Intl, не арифметика', () => {
  it('літо -> UTC+3, зима -> UTC+2 (та сама UTC-година дає різні київські)', () => {
    expect(kyivHour(SUMMER)).toBe(11);
    expect(kyivHour(WINTER)).toBe(10);
  });

  it('дата — київська, а не UTC: 22:30 UTC влітку це вже НАСТУПНА доба', () => {
    // Класична пастка дедуплікації «раз на добу»: за UTC це ще 10-те.
    expect(kyivDateKey(new Date('2026-07-10T22:30:00Z'))).toBe('2026-07-11');
    expect(kyivDateKey(SUMMER)).toBe('2026-07-10');
  });
});

describe('kyivMinuteOfDay / kyivMinAfter8 — вікна доби', () => {
  it('хвилина доби рахується від київської півночі', () => {
    expect(kyivMinuteOfDay(SUMMER)).toBe(11 * 60);
    expect(kyivMinuteOfDay(WINTER)).toBe(10 * 60);
  });

  it('«після 08:00» дає хвилини лише в межах 08:00–20:00, інакше null', () => {
    expect(kyivMinAfter8(SUMMER)).toBe(3 * 60); // 11:00 Київ
    expect(kyivMinAfter8(new Date('2026-07-10T04:59:00Z'))).toBeNull(); // 07:59 Київ
    expect(kyivMinAfter8(new Date('2026-07-10T05:00:00Z'))).toBe(0); // рівно 08:00
    expect(kyivMinAfter8(new Date('2026-07-10T17:01:00Z'))).toBeNull(); // 20:01 Київ
  });
});

/* Регресія з прод-KV (запис 2026-08-04T22:56:40Z = 01:56 Київ мав 'e23'):
   умова `h < 23` стояла ПЕРШОЮ й ловила всі години 0-22, тож нічні бакети були
   мертвим кодом і кожен тап після півночі писався як «ліг раніше 23:00». */
describe('bedtimeBucketForHour — нічні години НЕ падають у e23', () => {
  it('точні години раніше за фолбек', () => {
    expect(bedtimeBucketForHour(23)).toBe('e00');
    expect(bedtimeBucketForHour(0)).toBe('e01');
    expect(bedtimeBucketForHour(1)).toBe('e02');
  });

  it('2–5 -> late (глибока ніч)', () => {
    for (const h of [2, 3, 4, 5]) expect(bedtimeBucketForHour(h)).toBe('late');
  });

  it('20–22 -> e23 (фолбек, а не пастка)', () => {
    for (const h of [20, 21, 22]) expect(bedtimeBucketForHour(h)).toBe('e23');
  });
});
