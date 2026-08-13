import { describe, it, expect } from 'vitest';
// @ts-expect-error — JS-модуль Worker'а без типів
import { emptyStore, recordEvent } from '../web/stats-core.mjs';
// @ts-expect-error — JS-модуль Worker'а без типів
import { monthlyRollup, mergeArchive, ARCHIVE_KEY } from '../web/stats-archive.mjs';

/* Холодний архів місячних згорток.
 *
 * ⚠️ ЦЕ ПРО ВТРАТУ ДАНИХ, а не про майбутній графік. Стор ріже історію
 * капами: чек-іни й щоденна активність — 365 діб, надійність і журнал сну —
 * 90, тижневі інтереси — 26 тижнів, оцінки mock — останні 60. Тобто кожної
 * доби щось найстаріше зникає НАЗАВЖДИ, і жодного місця, де воно лишалось би
 * бодай у згорнутому вигляді, не існує.
 *
 * Архів — окремий KV-ключ, який крон дописує раз на добу. Гарячий блоб від
 * цього не росте (саме тому він і окремий: його читають і ПЕРЕЗАПИСУЮТЬ на
 * кожну подію), а історія перестає губитись.
 *
 * ⚠️ ГОЛОВНЕ ПРАВИЛО ЗЛИТТЯ: уже записаний МИНУЛИЙ місяць не перераховується
 * ніколи. Його дані вже частково поза ретеншеном, тож перерахунок дав би
 * ГІРШІ числа — тихо замінив би повний місяць на його огризок. */

const TODAY = '2026-08-13';
const ck = (slot: string, fields: Record<string, unknown>) => ({
  type: 'checkin',
  slot,
  ...fields,
});

describe('monthlyRollup — згортка по місяцях', () => {
  it('групує доби за місяцем і рахує середні', () => {
    let s = emptyStore();
    for (const d of ['2026-07-05', '2026-07-06']) {
      s = recordEvent(s, ck('morning', { sleepH: 7.5, energy: 4, mood: 4 }), d);
      s = recordEvent(s, ck('evening', { dayScore: 4, energy: 3, mood: 4 }), d);
    }
    const r = monthlyRollup(s, TODAY);
    expect(r['2026-07'].checkinDays).toBe(2);
    expect(r['2026-07'].sleepAvg).toBe(7.5);
    expect(r['2026-07'].dayScoreAvg).toBe(4);
  });

  it('порожній місяць не зʼявляється взагалі — нема чого зберігати', () => {
    const s = recordEvent(emptyStore(), ck('morning', { sleepH: 7 }), '2026-07-05');
    expect(Object.keys(monthlyRollup(s, TODAY))).toEqual(['2026-07']);
  });

  it('активність із days рахується окремо від чек-інів', () => {
    const s = emptyStore();
    s.days['2026-06-10'] = { opens: 3, mock: 1, news: 2 };
    s.days['2026-06-11'] = { opens: 1, mock: 0, news: 0 };
    const r = monthlyRollup(s, TODAY);
    expect(r['2026-06']).toMatchObject({ activeDays: 2, opens: 4, mock: 1, news: 2 });
  });

  it('подачі місяця беруться з appliedLog', () => {
    const s = emptyStore();
    s.appliedLog = [
      { url: 'a', ts: '2026-05-03' },
      { url: 'b', ts: '2026-05-20' },
      { url: 'c', ts: '2026-06-01' },
    ];
    const r = monthlyRollup(s, TODAY);
    expect(r['2026-05'].applied).toBe(2);
    expect(r['2026-06'].applied).toBe(1);
  });

  it('порожній стор -> порожній архів, не виняток', () => {
    expect(monthlyRollup(emptyStore(), TODAY)).toEqual({});
  });

  it('битий ключ доби ігнорується', () => {
    const s = emptyStore();
    s.days['не-дата'] = { opens: 5 };
    expect(monthlyRollup(s, TODAY)).toEqual({});
  });
});

describe('mergeArchive — минуле не переписується', () => {
  const prev = { '2026-06': { checkinDays: 30, sleepAvg: 7.2, activeDays: 30 } };

  it('уже записаний МИНУЛИЙ місяць лишається недоторканим', () => {
    // Свіжий перерахунок бачить лише огризок червня (решта поза ретеншеном).
    const fresh = { '2026-06': { checkinDays: 4, sleepAvg: 6.1, activeDays: 4 } };
    const out = mergeArchive(prev, fresh, TODAY);
    expect(out['2026-06'].checkinDays).toBe(30);
  });

  it('ПОТОЧНИЙ місяць перераховується щодня — він ще росте', () => {
    const out = mergeArchive(
      { '2026-08': { checkinDays: 5 } },
      { '2026-08': { checkinDays: 12 } },
      TODAY,
    );
    expect(out['2026-08'].checkinDays).toBe(12);
  });

  it('нові місяці додаються', () => {
    const out = mergeArchive(prev, { '2026-07': { checkinDays: 28 } }, TODAY);
    expect(Object.keys(out).sort()).toEqual(['2026-06', '2026-07']);
  });

  it('порожній свіжий зріз нічого не стирає', () => {
    expect(mergeArchive(prev, {}, TODAY)).toEqual(prev);
  });

  it('битий попередній архів не валить злиття', () => {
    expect(() => mergeArchive(null, { '2026-07': { checkinDays: 1 } }, TODAY)).not.toThrow();
    expect(
      mergeArchive('дурня', { '2026-07': { checkinDays: 1 } }, TODAY)['2026-07'],
    ).toBeDefined();
  });

  it('результат відсортований за місяцем — архів читають хронологічно', () => {
    const out = mergeArchive(
      { '2026-07': { checkinDays: 1 } },
      { '2026-05': { checkinDays: 2 } },
      TODAY,
    );
    expect(Object.keys(out)).toEqual(['2026-05', '2026-07']);
  });

  it('ключ архіву — ОКРЕМИЙ від гарячого блоба', () => {
    expect(ARCHIVE_KEY).not.toBe('stats');
  });
});
