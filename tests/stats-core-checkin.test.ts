import { describe, it, expect } from 'vitest';
// ⚠️ Два імпорти, а не один список: prettier переносить довгий список на кілька
// рядків, і однорядковий @ts-expect-error відʼїжджає від рядка з помилкою —
// тоді директива «невикористана», а помилка типів лишається. Патерн проєкту:
// окремий import на директиву, кожен має влазити в один рядок.
// @ts-expect-error — JS-модуль Worker'а без типів
import { emptyStore, recordEvent, aggregateStats } from '../web/stats-core.mjs';
// @ts-expect-error — JS-модуль Worker'а без типів
import { checkinSlot, checkinDateKey } from '../web/stats-core.mjs';

// Щоденний чек-ін (фідбек власника, п.7). Межі 08:00 / 14:00 / 20:00 — рішення
// власника; вечір іде до 02:00, 02:00–07:59 — тиха зона.

const ck = (slot: string, fields: Record<string, unknown>) => ({
  type: 'checkin',
  slot,
  ...fields,
});
const MORNING = { sleepH: 7.5, energy: 4, plan: 'work', planApply: 3 };

describe('checkinSlot — активний блок за київською годиною', () => {
  it('межі рівно там, де сказав власник', () => {
    expect(checkinSlot(8)).toBe('morning');
    expect(checkinSlot(13)).toBe('morning');
    expect(checkinSlot(14)).toBe('afternoon');
    expect(checkinSlot(19)).toBe('afternoon');
    expect(checkinSlot(20)).toBe('evening');
    expect(checkinSlot(23)).toBe('evening');
  });

  it('вечір перетинає північ: 00 і 01 — ще вечір', () => {
    expect(checkinSlot(0)).toBe('evening');
    expect(checkinSlot(1)).toBe('evening');
  });

  it('тиха зона 02:00–07:59 — жодного блоку', () => {
    for (const h of [2, 3, 4, 5, 6, 7]) expect(checkinSlot(h)).toBeNull();
  });

  it('битий вхід -> null, а не випадковий блок', () => {
    // Регресія: Number(null) === 0, а 0 — валідна година, що падає рівно у
    // вечірнє вікно (h < 2). Через м'яке приведення checkinSlot(null) віддавав
    // «evening» — тобто сміття мовчки ставало блоком.
    for (const h of [-1, 24, 99, NaN, null, undefined, '', '0', 'ранок', {}, []]) {
      expect(checkinSlot(h as never)).toBeNull();
    }
  });

  it('кожна година доби має однозначну відповідь', () => {
    for (let h = 0; h < 24; h++) {
      const s = checkinSlot(h);
      expect(s === null || ['morning', 'afternoon', 'evening'].includes(s)).toBe(true);
    }
  });
});

describe('checkinDateKey — вечір після півночі належить ВЧОРАШНІЙ добі', () => {
  it('о 00:30 вечірній чек-ін пишеться у вчора', () => {
    // Без цього о пів на першу вечір ліг би на добу, яка щойно почалась: у
    // вчорашньої зник би вечір, а в сьогоднішньої вечір зʼявився б РАНІШЕ за ранок.
    expect(checkinDateKey('2026-07-18', 0)).toBe('2026-07-17');
    expect(checkinDateKey('2026-07-18', 1)).toBe('2026-07-17');
  });

  it('удень і ввечері — доба як є', () => {
    for (const h of [8, 12, 14, 19, 20, 23])
      expect(checkinDateKey('2026-07-18', h)).toBe('2026-07-18');
  });

  it('перше число місяця -> останнє попереднього', () => {
    expect(checkinDateKey('2026-08-01', 1)).toBe('2026-07-31');
    expect(checkinDateKey('2026-01-01', 0)).toBe('2025-12-31');
  });

  it('битий ключ не ламає', () => {
    expect(checkinDateKey('wat', 1)).toBe('wat');
  });

  it('бита година НЕ зсуває дату (сумнів на користь «не чіпати»)', () => {
    // Та сама пастка Number(null)===0: без суворої перевірки null зсував би добу
    // на вчора «просто так».
    for (const h of [null, undefined, NaN, '', '1', {}]) {
      expect(checkinDateKey('2026-07-18', h as never)).toBe('2026-07-18');
    }
  });
});

describe('recordEvent — checkin', () => {
  it('пише блок під ключем дата+слот', () => {
    const s = recordEvent(emptyStore(), ck('morning', MORNING), '2026-07-17');
    expect(s.checkins['2026-07-17'].morning).toEqual(MORNING);
  });

  it('три блоки живуть поруч в одній добі', () => {
    let s = recordEvent(emptyStore(), ck('morning', MORNING), '2026-07-17');
    s = recordEvent(s, ck('afternoon', { pace: 'on', energy: 3, ate: 'learn' }), '2026-07-17');
    s = recordEvent(s, ck('evening', { dayScore: 4, kept: 'partly', energy: 2 }), '2026-07-17');
    expect(Object.keys(s.checkins['2026-07-17']).sort()).toEqual([
      'afternoon',
      'evening',
      'morning',
    ]);
  });

  it('повторна подія МЕРДЖИТЬ, а не стирає (клієнт шле дебаунсом)', () => {
    let s = recordEvent(emptyStore(), ck('morning', { sleepH: 7.5, energy: 4 }), '2026-07-17');
    s = recordEvent(s, ck('morning', { plan: 'work', planApply: 3 }), '2026-07-17');
    expect(s.checkins['2026-07-17'].morning).toEqual(MORNING);
  });

  it('зміна думки перезаписує поле', () => {
    let s = recordEvent(emptyStore(), ck('morning', { energy: 1 }), '2026-07-17');
    s = recordEvent(s, ck('morning', { energy: 5 }), '2026-07-17');
    expect(s.checkins['2026-07-17'].morning.energy).toBe(5);
  });

  // ── Валідація: невідоме ІГНОРУЄМО, а не видаляємо добу ──
  it('чужі поля не потрапляють у блок', () => {
    const s = recordEvent(
      emptyStore(),
      ck('morning', { sleepH: 7, dayScore: 5, wat: 1 }),
      '2026-07-17',
    );
    expect(s.checkins['2026-07-17'].morning).toEqual({ sleepH: 7 });
  });

  it('значення поза переліком/межами ігноруються ПОФІЛЬНО, решта пишеться', () => {
    const s = recordEvent(
      emptyStore(),
      ck('morning', { sleepH: 99, energy: 4, plan: 'вигадка', planApply: 2 }),
      '2026-07-17',
    );
    expect(s.checkins['2026-07-17'].morning).toEqual({ energy: 4, planApply: 2 });
  });

  it('null/порожній рядок НЕ стають нулем (пастка Number(null)===0)', () => {
    const s = recordEvent(
      emptyStore(),
      ck('morning', { sleepH: null, energy: '', planApply: 3 }),
      '2026-07-17',
    );
    expect(s.checkins['2026-07-17'].morning).toEqual({ planApply: 3 });
  });

  it('дробова енергія відкидається (має бути ціле)', () => {
    const s = recordEvent(emptyStore(), ck('morning', { energy: 3.7, sleepH: 6.5 }), '2026-07-17');
    expect(s.checkins['2026-07-17'].morning).toEqual({ sleepH: 6.5 });
  });

  it('невідомий слот -> тихо нічого, доба НЕ створюється', () => {
    const s = recordEvent(emptyStore(), ck('midnight', { sleepH: 7 }), '2026-07-17');
    expect(s.checkins['2026-07-17']).toBeUndefined();
  });

  it('жодного валідного поля -> порожня доба не створюється', () => {
    const s = recordEvent(emptyStore(), ck('morning', { sleepH: 'вісім' }), '2026-07-17');
    expect(s.checkins['2026-07-17']).toBeUndefined();
  });

  it('битий dateKey не пише нічого (як і решта подій)', () => {
    const s = recordEvent(emptyStore(), ck('morning', MORNING), 'not-a-date');
    expect(Object.keys(s.checkins)).toHaveLength(0);
  });

  it('кап 365 діб — блоб не росте роками', () => {
    let s = emptyStore();
    // 370 послідовних діб від 2025-01-01.
    const d = new Date('2025-01-01T00:00:00Z');
    for (let i = 0; i < 370; i++) {
      s = recordEvent(s, ck('morning', { sleepH: 7 }), d.toISOString().slice(0, 10));
      d.setUTCDate(d.getUTCDate() + 1);
    }
    const keys = Object.keys(s.checkins).sort();
    expect(keys).toHaveLength(365);
    expect(keys[0]).toBe('2025-01-06'); // найстаріші 5 зрізано
  });
});

describe('aggregateStats — чек-ін', () => {
  const withDays = (rows: Array<[string, Record<string, unknown>, Record<string, unknown>?]>) => {
    let s = emptyStore();
    for (const [date, m, e] of rows) {
      s = recordEvent(s, ck('morning', m), date);
      if (e) s = recordEvent(s, ck('evening', e), date);
    }
    return s;
  };

  it('checkinToday гідратує екран після перезаходу', () => {
    const s = recordEvent(emptyStore(), ck('morning', MORNING), '2026-07-17');
    expect(aggregateStats(s, '2026-07-17').checkinToday).toEqual({ morning: MORNING });
  });

  it('порожній стор -> null, а не {}', () => {
    expect(aggregateStats(emptyStore(), '2026-07-17').checkinToday).toBeNull();
  });

  it('енергія в ряді — СЕРЕДНЄ по блоках доби (крива, а не крапка)', () => {
    let s = recordEvent(emptyStore(), ck('morning', { energy: 2 }), '2026-07-17');
    s = recordEvent(s, ck('afternoon', { energy: 4 }), '2026-07-17');
    s = recordEvent(s, ck('evening', { energy: 3 }), '2026-07-17');
    const row = aggregateStats(s, '2026-07-17').checkinSeries.at(-1);
    expect(row.energy).toBe(3); // (2+4+3)/3
    expect(row.slots).toBe(3);
  });

  it('явка по блоках рахує пропуски — вони теж сигнал', () => {
    let s = recordEvent(emptyStore(), ck('morning', MORNING), '2026-07-17');
    s = recordEvent(s, ck('morning', MORNING), '2026-07-16');
    s = recordEvent(s, ck('evening', { dayScore: 4 }), '2026-07-16');
    const f = aggregateStats(s, '2026-07-17').checkinFill;
    expect(f.morning).toBe(2);
    expect(f.evening).toBe(1);
    expect(f.afternoon).toBe(0);
  });

  it('намір проти факту бере ФАКТ з appliedLog, а не зі слів (робочий день)', () => {
    const s = recordEvent(
      emptyStore(),
      ck('morning', { plan: 'work', planApply: 3 }),
      '2026-07-17',
    );
    s.appliedLog = [
      { url: 'a', ts: '2026-07-17' },
      { url: 'b', ts: '2026-07-17' },
    ];
    const rows = aggregateStats(s, '2026-07-17').planVsFact;
    expect(rows).toEqual([{ d: '2026-07-17', planned: 3, actual: 2 }]);
  });

  it('дні без planApply у порівняння не потрапляють', () => {
    const s = recordEvent(emptyStore(), ck('morning', { sleepH: 7 }), '2026-07-17');
    expect(aggregateStats(s, '2026-07-17').planVsFact).toEqual([]);
  });

  it('осиротіле planApply на НЕ-робочому дні у джоб-аналітику НЕ потрапляє (v2)', () => {
    // Обрав «Робота», ввів 3, перемкнув на «Навчання» — число лишилось, але день не робочий.
    const s = recordEvent(
      emptyStore(),
      ck('morning', { plan: 'learn', planApply: 3 }),
      '2026-07-17',
    );
    expect(aggregateStats(s, '2026-07-17').planVsFact).toEqual([]);
  });

  // ── Гейт кореляцій: головний запобіжник від впевненої брехні ──
  it('сон/оцінка-дня МОВЧИТЬ, поки кошики малі', () => {
    // 3 дні мало спав, 3 виспався — цього НЕ досить, щоб щось стверджувати.
    const rows: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [];
    for (let i = 1; i <= 3; i++) rows.push([`2026-07-0${i}`, { sleepH: 5.5 }, { dayScore: 2 }]);
    for (let i = 4; i <= 6; i++) rows.push([`2026-07-0${i}`, { sleepH: 8 }, { dayScore: 4 }]);
    const r = aggregateStats(withDays(rows), '2026-07-17').sleepVsDayScore;
    expect(r.ready).toBe(false);
    expect(r.needed).toBe(8);
    expect(r.lowAvg).toBeUndefined(); // жодних цифр, поки не набрали
  });

  it('сон/оцінка-дня говорить лише коли В КОЖНОМУ кошику ≥8 днів', () => {
    let s = emptyStore();
    const d = new Date('2026-06-01T00:00:00Z');
    for (let i = 0; i < 16; i++) {
      const key = d.toISOString().slice(0, 10);
      const low = i < 8;
      // Мало спав -> оцінка дня 2; виспався -> 4.
      s = recordEvent(s, ck('morning', { sleepH: low ? 5 : 8 }), key);
      s = recordEvent(s, ck('evening', { dayScore: low ? 2 : 4 }), key);
      d.setUTCDate(d.getUTCDate() + 1);
    }
    const r = aggregateStats(s, '2026-06-16').sleepVsDayScore;
    expect(r.ready).toBe(true);
    expect(r.low).toBe(8);
    expect(r.ok).toBe(8);
    expect(r.lowAvg).toBe(2);
    expect(r.okAvg).toBe(4);
  });

  it('перекошені кошики (15 проти 2) теж мовчать', () => {
    // Найпідступніший випадок: даних НІБИ багато, але порівнювати нема з чим.
    let s = emptyStore();
    const d = new Date('2026-06-01T00:00:00Z');
    for (let i = 0; i < 17; i++) {
      const key = d.toISOString().slice(0, 10);
      s = recordEvent(s, ck('morning', { sleepH: i < 15 ? 8 : 5 }), key);
      s = recordEvent(s, ck('evening', { dayScore: 3 }), key);
      d.setUTCDate(d.getUTCDate() + 1);
    }
    const r = aggregateStats(s, '2026-06-17').sleepVsDayScore;
    expect(r.ready).toBe(false);
    expect(r.low).toBe(2);
  });

  it('тижневий розбір: середні по тижню + скільки діб заповнено', () => {
    let s = recordEvent(emptyStore(), ck('morning', { sleepH: 6 }), '2026-07-13'); // пн
    s = recordEvent(s, ck('evening', { dayScore: 4 }), '2026-07-13');
    s = recordEvent(s, ck('morning', { sleepH: 8 }), '2026-07-14');
    const w = aggregateStats(s, '2026-07-17').checkinWeekly.at(-1);
    expect(w.n).toBe(2);
    expect(w.sleepAvg).toBe(7);
    expect(w.dayScoreAvg).toBe(4);
  });

  it('легасі-стор без checkins не валить агрегат', () => {
    const legacy = { ...emptyStore() };
    delete (legacy as Record<string, unknown>).checkins;
    expect(() => aggregateStats(legacy, '2026-07-17')).not.toThrow();
    expect(aggregateStats(legacy, '2026-07-17').checkinToday).toBeNull();
  });
});

describe('чек-ін — нові поля 18.07 (дзеркало questions.ts ↔ CHECKIN_FIELDS)', () => {
  it('bedtime/plan=project, ate-нові, applied/blocker-нові/helper приймаються', () => {
    let s = recordEvent(
      emptyStore(),
      ck('morning', { bedtime: 'e01', plan: 'project' }),
      '2026-07-17',
    );
    s = recordEvent(s, ck('afternoon', { ate: 'sport' }), '2026-07-17');
    s = recordEvent(
      s,
      ck('evening', { applied: 4, blocker: 'distract', helper: 'early' }),
      '2026-07-17',
    );
    expect(s.checkins['2026-07-17'].morning).toEqual({ bedtime: 'e01', plan: 'project' });
    expect(s.checkins['2026-07-17'].afternoon).toEqual({ ate: 'sport' });
    expect(s.checkins['2026-07-17'].evening).toEqual({
      applied: 4,
      blocker: 'distract',
      helper: 'early',
    });
  });

  it('невалідне значення нового enum ігнорується (не валить добу)', () => {
    const s = recordEvent(emptyStore(), ck('morning', { bedtime: 'опівночі' }), '2026-07-17');
    expect(s.checkins['2026-07-17']).toBeUndefined();
  });

  it('applied — ціле в межах [0,20]; дробове/поза межами відкидається', () => {
    const s = recordEvent(emptyStore(), ck('evening', { applied: 2.5, dayScore: 4 }), '2026-07-17');
    expect(s.checkins['2026-07-17'].evening).toEqual({ dayScore: 4 });
  });
});

describe('aggregateStats — нова аналітика чек-іну', () => {
  it('sleepVsDayScore: день без dayScore у порівняння не входить', () => {
    let s = emptyStore();
    const d = new Date('2026-06-01T00:00:00Z');
    // 20 днів сну БЕЗ жодної оцінки дня -> обидва кошики порожні.
    for (let i = 0; i < 20; i++) {
      s = recordEvent(s, ck('morning', { sleepH: i < 10 ? 5 : 8 }), d.toISOString().slice(0, 10));
      d.setUTCDate(d.getUTCDate() + 1);
    }
    const r = aggregateStats(s, '2026-06-20').sleepVsDayScore;
    expect([r.low, r.ok, r.ready]).toEqual([0, 0, false]);
  });

  it('categoryInsight: розподіл ate + сер. оцінка дня на категорію (гейт >=4 днів)', () => {
    let s = emptyStore();
    const d = new Date('2026-06-01T00:00:00Z');
    // 5 днів work (оцінки 3,3,3,3,3 -> має середню), 2 дні rest (без оцінок -> null).
    for (let i = 0; i < 5; i++) {
      const key = d.toISOString().slice(0, 10);
      s = recordEvent(s, ck('afternoon', { ate: 'work' }), key);
      s = recordEvent(s, ck('evening', { dayScore: 3 }), key);
      d.setUTCDate(d.getUTCDate() + 1);
    }
    for (let i = 0; i < 2; i++) {
      s = recordEvent(s, ck('afternoon', { ate: 'rest' }), d.toISOString().slice(0, 10));
      d.setUTCDate(d.getUTCDate() + 1);
    }
    const c = aggregateStats(s, '2026-06-16').categoryInsight;
    expect(c.total).toBe(7);
    expect(c.rows[0]).toEqual({ cat: 'work', n: 5, dayScore: 3 });
    // rest — лише 2 дні (менше гейта 4) -> оцінка null, але в розподілі є.
    expect(c.rows.find((r: { cat: string }) => r.cat === 'rest')).toEqual({
      cat: 'rest',
      n: 2,
      dayScore: null,
    });
  });

  it('categoryInsight: старі значення до v2 (apply/procrast) НЕ рахуються', () => {
    const s = recordEvent(emptyStore(), ck('afternoon', { ate: 'work' }), '2026-07-15');
    // Легасі-значення пишемо ПРЯМО в стор (валідатор запису їх би відкинув, але в
    // старому KV вони лежать) — агрегат мусить їх ігнорувати, не сирим слагом.
    s.checkins['2026-07-16'] = { afternoon: { ate: 'procrast' } };
    s.checkins['2026-07-17'] = { afternoon: { ate: 'apply' } };
    const c = aggregateStats(s, '2026-07-17').categoryInsight;
    expect(c.total).toBe(1);
    expect(c.rows).toEqual([{ cat: 'work', n: 1, dayScore: null }]);
  });

  it('appliedCalibration: matched / more(не залогував) / fewer проти appliedLog (робочі дні)', () => {
    let s = emptyStore();
    // Кожен день — робочий (plan='work'), бо тепер калібрація гейтиться на нього.
    for (const day of ['2026-07-15', '2026-07-16', '2026-07-17']) {
      s = recordEvent(s, ck('morning', { plan: 'work' }), day);
    }
    s = recordEvent(s, ck('evening', { applied: 2 }), '2026-07-15'); // факт 2 -> matched
    s = recordEvent(s, ck('evening', { applied: 3 }), '2026-07-16'); // факт 1 -> more
    s = recordEvent(s, ck('evening', { applied: 0 }), '2026-07-17'); // факт 1 -> fewer
    s.appliedLog = [
      { url: 'a', ts: '2026-07-15' },
      { url: 'b', ts: '2026-07-15' },
      { url: 'c', ts: '2026-07-16' },
      { url: 'd', ts: '2026-07-17' },
    ];
    expect(aggregateStats(s, '2026-07-17').appliedCalibration).toEqual({
      n: 3,
      matched: 1,
      more: 1,
      fewer: 1,
    });
  });

  it('appliedCalibration: applied на НЕ-робочому дні НЕ рахується (v2 гейт)', () => {
    let s = recordEvent(emptyStore(), ck('morning', { plan: 'rest' }), '2026-07-17');
    s = recordEvent(s, ck('evening', { applied: 2 }), '2026-07-17');
    expect(aggregateStats(s, '2026-07-17').appliedCalibration).toEqual({
      n: 0,
      matched: 0,
      more: 0,
      fewer: 0,
    });
  });

  it('checkinTops: мода блокера й помічника, без none', () => {
    let s = recordEvent(
      emptyStore(),
      ck('evening', { blocker: 'tired', helper: 'early' }),
      '2026-07-15',
    );
    s = recordEvent(s, ck('evening', { blocker: 'tired', helper: 'list' }), '2026-07-16');
    s = recordEvent(s, ck('evening', { blocker: 'none', helper: 'early' }), '2026-07-17');
    const t = aggregateStats(s, '2026-07-17').checkinTops;
    expect(t.blocker).toEqual({ value: 'tired', n: 2 });
    expect(t.helper).toEqual({ value: 'early', n: 2 });
  });

  it('checkinTops: порожньо -> null', () => {
    const t = aggregateStats(emptyStore(), '2026-07-17').checkinTops;
    expect([t.blocker, t.helper]).toEqual([null, null]);
  });

  it('bedtimeVsEnergy: гейт, тоді ранкова енергія рано vs пізно (join за добою)', () => {
    let s = emptyStore();
    const d = new Date('2026-06-01T00:00:00Z');
    for (let i = 0; i < 16; i++) {
      const early = i < 8;
      s = recordEvent(
        s,
        ck('morning', { bedtime: early ? 'e23' : 'late', energy: early ? 5 : 2 }),
        d.toISOString().slice(0, 10),
      );
      d.setUTCDate(d.getUTCDate() + 1);
    }
    const r = aggregateStats(s, '2026-06-16').bedtimeVsEnergy;
    expect(r.ready).toBe(true);
    expect([r.early, r.late]).toEqual([8, 8]);
    expect([r.earlyAvg, r.lateAvg]).toEqual([5, 2]);
  });

  it('bedtimeVsEnergy: середина 00–01 (e01) НЕ рахується в жодному кошику', () => {
    let s = emptyStore();
    const d = new Date('2026-06-01T00:00:00Z');
    for (let i = 0; i < 6; i++) {
      // e01 із дуже низькою енергією — якби потрапляв у late, зіпсував би середнє.
      s = recordEvent(
        s,
        ck('morning', { bedtime: 'e01', energy: 1 }),
        d.toISOString().slice(0, 10),
      );
      d.setUTCDate(d.getUTCDate() + 1);
    }
    const r = aggregateStats(s, '2026-06-16').bedtimeVsEnergy;
    expect([r.early, r.late]).toEqual([0, 0]);
  });
});
