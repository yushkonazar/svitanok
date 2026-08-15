import { describe, it, expect } from 'vitest';
// @ts-expect-error — JS-модуль Worker'а без типів
import { emptyStore, recordEvent } from '../web/stats-core.mjs';
// ⚠️ Кілька імпортів, а не один список — той самий прийом, що в
// checkin-model.test.ts. Prettier переносить довгий список на кілька рядків, і
// однорядковий @ts-expect-error відʼїжджає від рядка з помилкою: директива стає
// «невикористаною», а помилка типів лишається. Наступив на це вдруге.
// @ts-expect-error — JS-модуль Worker'а без типів
import { monthlyRollup, mergeArchive, ARCHIVE_KEY } from '../web/stats-archive.mjs';
// @ts-expect-error — JS-модуль Worker'а без типів
import { weeklyRollup, mergeWeekly } from '../web/stats-archive.mjs';
// @ts-expect-error — JS-модуль Worker'а без типів
import { WEEKLY_ARCHIVE_KEY, WEEKLY_ARCHIVE_CAP } from '../web/stats-archive.mjs';

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

/* ⚠️ ЗВОРОТНЕ ЗАПОВНЕННЯ — ПРИШПИЛЮЄМО ТЕ, ЩО ВЖЕ ПРАЦЮЄ.
 *
 * Я був упевнений, що крон пише «лише вперед» і вся історія, яка вже лежить у
 * гарячому сторі, в архів не потрапила. Перевірка кодом показала протилежне:
 * monthlyRollup згортає ВСІ місяці стору, а mergeArchive на порожньому архіві
 * записує їх усі. Тобто заповнення сталося на першому ж прогоні після релізу.
 *
 * Тест існує саме тому, що це поводження ніде не було закріплене — воно
 * випливало з двох функцій, і будь-яка «оптимізація» (згортати лише поточний
 * місяць — виглядає розумно!) тихо забрала б його. */
describe('архів — заповнення з наявної історії', () => {
  const multiMonth = () => {
    const checkins: Record<string, unknown> = {};
    const days: Record<string, unknown> = {};
    for (const m of ['05', '06', '07', '08']) {
      for (const d of ['05', '12', '19']) {
        checkins[`2026-${m}-${d}`] = { morning: { sleepH: 7 }, evening: { dayScore: 4 } };
        days[`2026-${m}-${d}`] = { opens: 3, mock: 1, news: 2 };
      }
    }
    return { checkins, days };
  };

  it('ПЕРШЕ злиття в порожній архів забирає ВСІ місяці стору, не лише поточний', () => {
    const fresh = monthlyRollup(multiMonth(), TODAY);
    const merged = mergeArchive({}, fresh, TODAY);
    expect(Object.keys(merged)).toEqual(['2026-05', '2026-06', '2026-07', '2026-08']);
  });

  it('те саме на тижневому рівні', () => {
    // Перевіряємо ВЛАСТИВІСТЬ (злиття нічого не губить), а не порахований
    // усно кількість тижнів: моя перша версія тесту падала саме на цьому.
    const fresh = weeklyRollup(multiMonth(), TODAY);
    const merged = mergeWeekly({}, fresh, TODAY);
    expect(Object.keys(merged)).toEqual(Object.keys(fresh));
    expect(Object.keys(merged).length).toBeGreaterThan(4); // не лише поточний місяць
  });
});

describe('weeklyRollup — той самий набір полів, інша сітка', () => {
  it('доби групуються за ISO-понеділком', () => {
    let s = emptyStore();
    // 10.08.2026 — понеділок; 12-те й 16-те (нд) у тому самому тижні.
    s = recordEvent(s, ck('morning', { sleepH: 7 }), '2026-08-10');
    s = recordEvent(s, ck('morning', { sleepH: 8 }), '2026-08-12');
    s = recordEvent(s, ck('morning', { sleepH: 6 }), '2026-08-17'); // наступний тиждень
    const w = weeklyRollup(s, '2026-08-17');
    expect(Object.keys(w)).toEqual(['2026-08-10', '2026-08-17']);
    expect(w['2026-08-10'].checkinDays).toBe(2);
    expect(w['2026-08-10'].sleepAvg).toBe(7.5);
  });

  it('неділя належить тижню, що ПОЧАВСЯ в понеділок, а не наступному', () => {
    let s = emptyStore();
    s = recordEvent(s, ck('morning', { sleepH: 7 }), '2026-08-16'); // неділя
    expect(Object.keys(weeklyRollup(s, '2026-08-16'))).toEqual(['2026-08-10']);
  });

  it('поля ті самі, що в місячній згортці — два рівні одного архіву', () => {
    let s = emptyStore();
    s = recordEvent(s, ck('morning', { sleepH: 7 }), '2026-08-12');
    const mk = Object.keys(monthlyRollup(s, TODAY)['2026-08']).sort();
    const wk = Object.keys(weeklyRollup(s, TODAY)['2026-08-10']).sort();
    expect(wk).toEqual(mk);
  });

  it('порожній стор -> порожньо, не виняток', () => {
    expect(weeklyRollup({}, TODAY)).toEqual({});
  });
});

describe('mergeWeekly — минуле не переписується, найстаріше відпадає', () => {
  const w = (n: number) => ({ checkinDays: n });

  it('минулий тиждень лишається недоторканим', () => {
    const prev = { '2026-08-03': w(7) };
    const out = mergeWeekly(prev, { '2026-08-03': w(1) }, '2026-08-13');
    expect(out['2026-08-03'].checkinDays).toBe(7);
  });

  it('ПОТОЧНИЙ тиждень перераховується — він ще росте', () => {
    const prev = { '2026-08-10': w(2) };
    const out = mergeWeekly(prev, { '2026-08-10': w(5) }, '2026-08-13');
    expect(out['2026-08-10'].checkinDays).toBe(5);
  });

  /* Кап ОГОЛОШЕНИЙ, а не з'ясований у день, коли запис перестане вміщатись у
     25 МіБ KV. Відпадає найстаріше — саме воно вже не має споживача. */
  it('понад WEEKLY_ARCHIVE_CAP тижнів -> найстаріші відпадають', () => {
    const prev: Record<string, unknown> = {};
    const d = new Date('2010-01-04T00:00:00Z');
    for (let i = 0; i < WEEKLY_ARCHIVE_CAP + 30; i++) {
      prev[d.toISOString().slice(0, 10)] = w(1);
      d.setUTCDate(d.getUTCDate() + 7);
    }
    const allKeys = Object.keys(prev);
    const out = mergeWeekly(prev, {}, '2026-08-13');
    const keys = Object.keys(out);
    expect(keys.length).toBe(WEEKLY_ARCHIVE_CAP);
    // Відпали САМЕ найстаріші 30, а не будь-які 30.
    expect(keys[0]).toBe(allKeys[30]);
    expect(keys[keys.length - 1]).toBe(allKeys[allKeys.length - 1]);
  });

  it('ключ тижневого архіву — ОКРЕМИЙ від місячного', () => {
    expect(WEEKLY_ARCHIVE_KEY).not.toBe(ARCHIVE_KEY);
  });
});
