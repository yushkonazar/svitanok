import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
// ⚠️ Два імпорти, а не один список: prettier переносить довгий список на кілька
// рядків, і однорядковий @ts-expect-error відʼїжджає від рядка з помилкою —
// тоді директива «невикористана», а помилка типів лишається. Патерн проєкту:
// окремий import на директиву, кожен має влазити в один рядок.
// @ts-expect-error — JS-модуль Worker'а без типів
import { emptyStore, recordEvent, aggregateStats } from '../web/stats-core.mjs';
// @ts-expect-error — JS-модуль Worker'а без типів
import { checkinSlot, checkinDateKey } from '../web/stats-core.mjs';
// @ts-expect-error — JS-модуль Worker'а без типів
import { CHECKIN_NUDGE_WINDOWS, matchCheckinNudgeWindow } from '../web/stats-core.mjs';
// @ts-expect-error — JS-модуль Worker'а без типів
import { isCheckinSlotFilled } from '../web/stats-core.mjs';
// @ts-expect-error — JS-модуль Worker'а без типів
import { shouldSendCheckinNudge } from '../web/stats-core.mjs';
// @ts-expect-error — JS-модуль Worker'а без типів
import { inSleepNudgeWindow, shouldSendSleepNudge, staleSleepNudges } from '../web/stats-core.mjs';

// Щоденний чек-ін (фідбек власника, п.7). Межі 08:00 / 14:00 / 20:00 — рішення
// власника; вечір іде до 02:00, 02:00–07:59 — тиха зона.

const ck = (slot: string, fields: Record<string, unknown>) => ({
  type: 'checkin',
  slot,
  ...fields,
});
// `plan` — мультивибір (масив). Легасі-форму (голий рядок) валідатор і далі
// приймає й нормалізує в масив — окремий тест нижче.
const MORNING = { sleepH: 7.5, energy: 4, plan: ['work'], planApply: 3 };

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
    s = recordEvent(s, ck('morning', { plan: ['work'], planApply: 3 }), '2026-07-17');
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

describe('recordEvent — checkin, ЯВНЕ очищення поля (null/[])', () => {
  it('null очищує скалярне поле — раніше лишалось старе значення', () => {
    let s = recordEvent(emptyStore(), ck('morning', { sleepH: 6.5, energy: 4 }), '2026-07-20');
    s = recordEvent(s, ck('morning', { sleepH: null }), '2026-07-20');
    expect(s.checkins['2026-07-20'].morning).toEqual({ energy: 4 });
  });

  it('null очищує enum-поле', () => {
    let s = recordEvent(emptyStore(), ck('morning', { bedtime: 'e23', sleepH: 7 }), '2026-07-20');
    s = recordEvent(s, ck('morning', { bedtime: null }), '2026-07-20');
    expect(s.checkins['2026-07-20'].morning).toEqual({ sleepH: 7 });
  });

  it('[] очищує мультивибір', () => {
    let s = recordEvent(emptyStore(), ck('morning', { plan: ['work', 'learn'] }), '2026-07-20');
    s = recordEvent(s, ck('morning', { plan: [] }), '2026-07-20');
    expect(s.checkins['2026-07-20'].morning).toEqual({});
  });

  it('null теж очищує мультивибір (симетрія зі скалярними полями)', () => {
    let s = recordEvent(emptyStore(), ck('evening', { blocker: ['tired'] }), '2026-07-20');
    s = recordEvent(s, ck('evening', { blocker: null }), '2026-07-20');
    expect(s.checkins['2026-07-20'].evening).toEqual({});
  });

  it('непорожній масив, що після фільтра лишився порожнім (саме сміття) — НЕ очищує', () => {
    let s = recordEvent(emptyStore(), ck('morning', { plan: ['work'] }), '2026-07-20');
    // 'вигадка' не в CATEGORY_VALUES -> фільтр дає [], але це РІЗНЕ від
    // клієнтського [] (явний намір) — сміття не мусить випадково стирати поле.
    s = recordEvent(s, ck('morning', { plan: ['вигадка'] }), '2026-07-20');
    expect(s.checkins['2026-07-20'].morning).toEqual({ plan: ['work'] });
  });

  it('відсутній ключ і далі НЕ чіпає — регресія для агента (часткові оновлення)', () => {
    let s = recordEvent(
      emptyStore(),
      ck('morning', { sleepH: 7.5, energy: 4, plan: ['work'] }),
      '2026-07-20',
    );
    // Агент шле лише щойно згадане поле — решта не в event взагалі.
    s = recordEvent(s, ck('morning', { energy: 5 }), '2026-07-20');
    expect(s.checkins['2026-07-20'].morning).toEqual({ sleepH: 7.5, energy: 5, plan: ['work'] });
  });

  it('очищення й нове значення в ОДНІЙ події — обидва застосовуються', () => {
    let s = recordEvent(
      emptyStore(),
      ck('morning', { sleepH: 6.5, bedtime: 'late' }),
      '2026-07-20',
    );
    s = recordEvent(s, ck('morning', { sleepH: null, energy: 4 }), '2026-07-20');
    expect(s.checkins['2026-07-20'].morning).toEqual({ bedtime: 'late', energy: 4 });
  });

  it('підтверджений блок ігнорує ОЧИЩЕННЯ так само, як і будь-яку іншу правку', () => {
    let s = recordEvent(emptyStore(), ck('morning', { sleepH: 7 }), '2026-07-20');
    s = recordEvent(s, ck('morning', { confirmed: true }), '2026-07-20');
    s = recordEvent(s, ck('morning', { sleepH: null }), '2026-07-20');
    expect(s.checkins['2026-07-20'].morning).toEqual({ sleepH: 7, confirmed: true });
  });
});

describe('recordEvent — checkin, confirmed (кнопка «Підтвердити»)', () => {
  it('confirmed:true фіксує блок разом із будь-якими полями в тому самому запиті', () => {
    const s = recordEvent(
      emptyStore(),
      ck('morning', { sleepH: 7.5, energy: 4, confirmed: true }),
      '2026-07-17',
    );
    expect(s.checkins['2026-07-17'].morning).toEqual({ sleepH: 7.5, energy: 4, confirmed: true });
  });

  it('confirmed:true без нових полів фіксує те, що вже було збережено раніше', () => {
    let s = recordEvent(emptyStore(), ck('morning', { sleepH: 7.5, energy: 4 }), '2026-07-17');
    s = recordEvent(s, ck('morning', { confirmed: true }), '2026-07-17');
    expect(s.checkins['2026-07-17'].morning).toEqual({ sleepH: 7.5, energy: 4, confirmed: true });
  });

  it('після confirmed:true БУДЬ-ЯКІ подальші правки ігноруються (нічого не змінити)', () => {
    let s = recordEvent(emptyStore(), ck('morning', { energy: 4, confirmed: true }), '2026-07-17');
    // Спроба змінити вже підтверджене поле.
    s = recordEvent(s, ck('morning', { energy: 1 }), '2026-07-17');
    // Спроба додати НОВЕ поле в підтверджений блок.
    s = recordEvent(s, ck('morning', { sleepH: 3 }), '2026-07-17');
    expect(s.checkins['2026-07-17'].morning).toEqual({ energy: 4, confirmed: true });
  });

  it('підтвердити ПОРОЖНІЙ блок (без жодної відповіді) -> тихо нічого, доба не створюється', () => {
    const s = recordEvent(emptyStore(), ck('morning', { confirmed: true }), '2026-07-17');
    expect(s.checkins['2026-07-17']).toBeUndefined();
  });

  it('confirmed стосується ЛИШЕ свого слоту — інші блоки того ж дня редагуються як завжди', () => {
    let s = recordEvent(emptyStore(), ck('morning', { energy: 4, confirmed: true }), '2026-07-17');
    s = recordEvent(s, ck('afternoon', { energy: 3 }), '2026-07-17');
    s = recordEvent(s, ck('afternoon', { energy: 5 }), '2026-07-17');
    expect(s.checkins['2026-07-17'].morning).toEqual({ energy: 4, confirmed: true });
    expect(s.checkins['2026-07-17'].afternoon).toEqual({ energy: 5 });
  });

  it('повторний confirmed:true — ідемпотентно, без помилок і без зміни даних', () => {
    let s = recordEvent(emptyStore(), ck('morning', { energy: 4, confirmed: true }), '2026-07-17');
    s = recordEvent(s, ck('morning', { confirmed: true }), '2026-07-17');
    expect(s.checkins['2026-07-17'].morning).toEqual({ energy: 4, confirmed: true });
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

/* ── Гаряче вікно сирих чек-інів ───────────────────────────────────────────
   НАВІЩО ОКРЕМЕ ПОЛЕ, коли вже є checkinSeries. Ряд віддає лише скаляри
   (сон/енергія/крива/оцінка) — усі ТЕГИ доби (blocker, helper, withWhom,
   lateReason, pace…) з нього викинуті, бо кожен із них уже має власний
   передрахований рол-ап. Рол-ап відповідає «як часто», але НЕ вміє відповісти
   «а що було саме в ці доби» — а це і є питання, яке ставить карта станів,
   коли тапаєш клітинку.

   Свідома межа глибини: 90 діб. Це не кругле число, а межа ГАРЯЧОГО блоба —
   стор читається й перезаписується на кожну подію, тож він мусить лишатись
   малим; довші періоди колись поїдуть із місячних згорток, не звідси. */
describe('aggregateStats — гаряче вікно сирих чек-інів', () => {
  const TODAY = '2026-08-13';
  const back = (n: number) => {
    const d = new Date(TODAY + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
  };

  it('віддає СИРІ теги слоту — те, чого в checkinSeries немає', () => {
    let s = recordEvent(emptyStore(), ck('afternoon', { withWhom: 'alone' }), TODAY);
    s = recordEvent(s, ck('evening', { blocker: ['tired', 'distract'], dayScore: 2 }), TODAY);
    const raw = aggregateStats(s, TODAY).checkinRaw;
    expect(raw.records[TODAY].afternoon.withWhom).toBe('alone');
    expect(raw.records[TODAY].evening.blocker).toEqual(['tired', 'distract']);
  });

  it('вікно ГЛИБШЕ за checkinSeries — інакше поле не мало б сенсу', () => {
    let s = emptyStore();
    for (let i = 0; i < 80; i++) s = recordEvent(s, ck('evening', { dayScore: 3 }), back(i));
    const agg = aggregateStats(s, TODAY);
    expect(agg.checkinSeries.length).toBe(30);
    expect(Object.keys(agg.checkinRaw.records).length).toBe(80);
  });

  it('доба поза вікном не потрапляє', () => {
    let s = recordEvent(emptyStore(), ck('evening', { dayScore: 5 }), back(89));
    s = recordEvent(s, ck('evening', { dayScore: 1 }), back(90));
    const rec = aggregateStats(s, TODAY).checkinRaw.records;
    expect(rec[back(89)]).toBeDefined();
    expect(rec[back(90)]).toBeUndefined();
  });

  it('незаповнені доби не займають місця (розріджено, не 90 дірок)', () => {
    const s = recordEvent(emptyStore(), ck('morning', MORNING), back(5));
    expect(Object.keys(aggregateStats(s, TODAY).checkinRaw.records)).toEqual([back(5)]);
  });

  it('from/to описують РЕАЛЬНЕ вікно — підпис глибини не має брехати', () => {
    const raw = aggregateStats(emptyStore(), TODAY).checkinRaw;
    expect(raw.days).toBe(90);
    expect(raw.to).toBe(TODAY);
    expect(raw.from).toBe(back(89)); // 90 діб включно з сьогоднішньою
  });

  it('порожній стор -> порожні records, але метадані на місці', () => {
    const raw = aggregateStats(emptyStore(), TODAY).checkinRaw;
    expect(raw.records).toEqual({});
    expect(raw.days).toBe(90);
  });

  it('легасі-стор без checkins не валить агрегат', () => {
    const legacy = { ...emptyStore() };
    delete (legacy as Record<string, unknown>).checkins;
    expect(() => aggregateStats(legacy, TODAY)).not.toThrow();
    expect(aggregateStats(legacy, TODAY).checkinRaw.records).toEqual({});
  });
});

describe('чек-ін — нові поля 18.07 (дзеркало questions.ts ↔ CHECKIN_FIELDS)', () => {
  it('bedtime/plan=project, ate-нові, applied/blocker-нові/helper приймаються', () => {
    let s = recordEvent(
      emptyStore(),
      ck('morning', { bedtime: 'e01', plan: ['project'] }),
      '2026-07-17',
    );
    s = recordEvent(s, ck('afternoon', { ate: ['sport'] }), '2026-07-17');
    s = recordEvent(
      s,
      ck('evening', { applied: 4, blocker: ['distract'], helper: ['early'] }),
      '2026-07-17',
    );
    expect(s.checkins['2026-07-17'].morning).toEqual({ bedtime: 'e01', plan: ['project'] });
    expect(s.checkins['2026-07-17'].afternoon).toEqual({ ate: ['sport'] });
    expect(s.checkins['2026-07-17'].evening).toEqual({
      applied: 4,
      blocker: ['distract'],
      helper: ['early'],
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

describe('чек-ін — мультивибір (plan/ate/blocker/helper)', () => {
  it('масив зберігається як масив; сміття всередині відкидається поштучно', () => {
    const s = recordEvent(
      emptyStore(),
      ck('evening', { blocker: ['tired', 'вигадка', 'overload'] }),
      '2026-07-17',
    );
    expect(s.checkins['2026-07-17'].evening.blocker).toEqual(['tired', 'overload']);
  });

  it('ЛЕГАСІ: голий рядок і далі приймається й нормалізується в масив', () => {
    const s = recordEvent(emptyStore(), ck('afternoon', { ate: 'sport' }), '2026-07-17');
    expect(s.checkins['2026-07-17'].afternoon.ate).toEqual(['sport']);
  });

  it('дублікати схлопуються, довжина капиться (день не має пʼяти причин)', () => {
    const s = recordEvent(
      emptyStore(),
      ck('evening', { blocker: ['tired', 'tired', 'stuck', 'anxious', 'health', 'nomotiv'] }),
      '2026-07-17',
    );
    expect(s.checkins['2026-07-17'].evening.blocker).toEqual(['tired', 'stuck', 'anxious']);
  });

  it('plan капиться на 2 (головних справ на день не буває пʼять)', () => {
    const s = recordEvent(
      emptyStore(),
      ck('morning', { plan: ['work', 'learn', 'sport'] }),
      '2026-07-17',
    );
    expect(s.checkins['2026-07-17'].morning.plan).toEqual(['work', 'learn']);
  });

  it('масив із самого сміття -> поле відсутнє, доба не створюється порожньою', () => {
    const s = recordEvent(emptyStore(), ck('evening', { blocker: ['ой', 'йой'] }), '2026-07-17');
    expect(s.checkins['2026-07-17']).toBeUndefined();
  });

  it('flames: масив зберігається, сміття відкидається, дублікати схлопуються (без капу нижче 5)', () => {
    const s = recordEvent(
      emptyStore(),
      ck('evening', {
        flames: ['tiktok', 'tiktok', 'вигадка', 'duolingo', 'snapchat', 'bereal', 'chess'],
      }),
      '2026-07-17',
    );
    expect(s.checkins['2026-07-17'].evening.flames).toEqual([
      'tiktok',
      'duolingo',
      'snapchat',
      'bereal',
      'chess',
    ]);
  });

  it('топ блокерів/помічників рахує КОЖЕН вибір дня, "none" не рахується', () => {
    let s = emptyStore();
    s = recordEvent(s, ck('evening', { blocker: ['tired', 'stuck'] }), '2026-07-15');
    s = recordEvent(
      s,
      ck('evening', { blocker: ['tired'], helper: ['move', 'none'] }),
      '2026-07-16',
    );
    const st = aggregateStats(s, '2026-07-16');
    expect(st.checkinTops.blocker).toEqual({ value: 'tired', n: 2 });
    expect(st.checkinTops.helper).toEqual({ value: 'move', n: 1 });
  });

  it('«куди йде час» рахує обидві категорії дня і терпить легасі-рядок', () => {
    let s = emptyStore();
    s = recordEvent(s, ck('afternoon', { ate: ['work', 'learn'] }), '2026-07-15');
    // легасі-доба: рядок замість масиву
    s.checkins['2026-07-16'] = { afternoon: { ate: 'work' } };
    const rows = aggregateStats(s, '2026-07-16').categoryInsight.rows;
    expect(rows.find((r: { cat: string }) => r.cat === 'work').n).toBe(2);
    expect(rows.find((r: { cat: string }) => r.cat === 'learn').n).toBe(1);
  });
});

describe('чек-ін — дрейф наміру (plan -> ate, на вже зібраних даних)', () => {
  it('повний збіг і повна розбіжність: 100% і 0%, пара з розбіжної доби', () => {
    let s = emptyStore();
    s = recordEvent(s, ck('morning', { plan: ['work'] }), '2026-07-15');
    s = recordEvent(s, ck('afternoon', { ate: ['work'] }), '2026-07-15');
    s = recordEvent(s, ck('morning', { plan: ['learn'] }), '2026-07-16');
    s = recordEvent(s, ck('afternoon', { ate: ['chores'] }), '2026-07-16');
    const dr = aggregateStats(s, '2026-07-16').intentDrift;
    expect(dr.total).toBe(2);
    expect(dr.full).toBe(1);
    expect(dr.partial).toBe(0);
    expect(dr.pct).toBe(50); // (1 + 0) / 2
    // Одна пара, один раз -> нижче DRIFT_PAIR_MIN_N, у топ не йде.
    expect(dr.top).toEqual([]);
  });

  /* ⚠️ РЕГРЕСІЯ, заради якої цей опис і переписаний. Доти критерієм було
     plan.some(p => ate.includes(p)) — «влучив бодай у щось». Доба з планом
     [робота, спорт] і фактом [спорт, відпочинок] зараховувалась ПОВНІСТЮ, хоч
     робота не сталась. Наслідок системний: що більше категорій обираєш уранці,
     то вищий відсоток — при двох пунктах досить влучити в один.

     Той самий критерій успадковував intentMatch у моделі, тобто завищувався не
     лише цей блок, а й індекс AGENCY і через нього «Індекс дня». */
  it('ЧАСТКОВИЙ збіг дає ЧАСТКУ, а не повний залік', () => {
    let s = emptyStore();
    s = recordEvent(s, ck('morning', { plan: ['work', 'sport'] }), '2026-07-16');
    s = recordEvent(s, ck('afternoon', { ate: ['sport', 'rest'] }), '2026-07-16');
    const dr = aggregateStats(s, '2026-07-16').intentDrift;
    expect(dr.total).toBe(1);
    expect(dr.full).toBe(0);
    expect(dr.partial).toBe(1);
    expect(dr.pct).toBe(50); // один плановий пункт із двох
  });

  it('пара будується з НЕВИКОНАНОГО плану проти НЕЗАПЛАНОВАНОГО факту', () => {
    let s = emptyStore();
    // Дві однакові часткові доби: 'work' не сталась, натомість 'rest'.
    // 'sport' збігся — у пари не йде, бо збіг нічого не пояснює.
    for (const d of ['2026-07-15', '2026-07-16']) {
      s = recordEvent(s, ck('morning', { plan: ['work', 'sport'] }), d);
      s = recordEvent(s, ck('afternoon', { ate: ['sport', 'rest'] }), d);
    }
    const dr = aggregateStats(s, '2026-07-16').intentDrift;
    expect(dr.top).toEqual([{ from: 'work', to: 'rest', n: 2 }]);
  });

  it('пара, що трапилась ОДИН раз, у топ не потрапляє', () => {
    let s = emptyStore();
    s = recordEvent(s, ck('morning', { plan: ['work'] }), '2026-07-16');
    s = recordEvent(s, ck('afternoon', { ate: ['rest'] }), '2026-07-16');
    expect(aggregateStats(s, '2026-07-16').intentDrift.top).toEqual([]);
  });

  it('доба без плану АБО без факту у знаменник не входить', () => {
    let s = emptyStore();
    s = recordEvent(s, ck('morning', { plan: ['work'] }), '2026-07-16');
    const dr = aggregateStats(s, '2026-07-16').intentDrift;
    expect(dr.total).toBe(0);
    expect(dr.pct).toBeNull();
  });
});

describe('чек-ін — крива енергії/настрою (форма дня, не середнє)', () => {
  it('три слоти дають три точки в порядку ранок->день->вечір', () => {
    let s = emptyStore();
    s = recordEvent(s, ck('morning', { energy: 5, mood: 4 }), '2026-07-16');
    s = recordEvent(s, ck('afternoon', { energy: 3 }), '2026-07-16');
    s = recordEvent(s, ck('evening', { energy: 1, mood: 2 }), '2026-07-16');
    const row = aggregateStats(s, '2026-07-16').checkinSeries.at(-1);
    expect(row.energyCurve).toEqual([5, 3, 1]);
    // Незаповнений слот -> null (дірка), а не 0: нуль читався б як «сил немає».
    expect(row.moodCurve).toEqual([4, null, 2]);
    expect(row.energy).toBe(3); // середнє лишається для сумісності
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
    expect([t.blockers, t.helpers]).toEqual([[], []]);
    expect(t.lateReasons).toEqual([]);
    expect(t.lateNights).toBe(0);
  });

  it('checkinTops: lateReasons — рейтинг причин пізнього відбою (умовне ранкове поле)', () => {
    let s = emptyStore();
    s = recordEvent(s, ck('morning', { lateReason: 'scroll' }), '2026-07-15');
    s = recordEvent(s, ck('morning', { lateReason: 'scroll' }), '2026-07-16');
    s = recordEvent(s, ck('morning', { lateReason: 'work' }), '2026-07-17');
    const t = aggregateStats(s, '2026-07-17').checkinTops;
    expect(t.lateReasons).toEqual([
      { value: 'scroll', n: 2 },
      { value: 'work', n: 1 },
    ]);
    expect(t.lateNights).toBe(3);
  });

  it('checkinTops: ПОВНИЙ рейтинг, не лише мода; filled = діб із вечірнім вибором', () => {
    let s = emptyStore();
    s = recordEvent(
      s,
      ck('evening', { blocker: ['tired', 'distract'], helper: ['early'] }),
      '2026-07-15',
    );
    s = recordEvent(
      s,
      ck('evening', { blocker: ['tired', 'stuck'], helper: ['early', 'list'] }),
      '2026-07-16',
    );
    s = recordEvent(s, ck('evening', { blocker: ['tired'], helper: ['none'] }), '2026-07-17');
    const t = aggregateStats(s, '2026-07-17').checkinTops;
    // Мода лишається як була (сумісність контракту) і збігається з головою рейтингу.
    expect(t.blocker).toEqual({ value: 'tired', n: 3 });
    expect(t.blockers[0]).toEqual({ value: 'tired', n: 3 });
    // Хвіст теж віддається — саме його доти ніде не було видно.
    expect(t.blockers.map((r: { value: string }) => r.value)).toEqual([
      'tired',
      'distract',
      'stuck',
    ]);
    // 'none' — свідоме «нічого не допомогло», не варіант рейтингу.
    expect(t.helpers).toEqual([
      { value: 'early', n: 2 },
      { value: 'list', n: 1 },
    ]);
    expect(t.filled).toBe(3);
  });

  it('checkinTops: рейтинг капиться на 5 (хвіст не роздуває картку)', () => {
    const many = ['tired', 'anxious', 'stuck', 'distract', 'nomotiv', 'overload'];
    let s = emptyStore();
    // По одній добі на кожен блокер -> 6 різних значень, у рейтинг влазить 5.
    many.forEach((b, i) => {
      s = recordEvent(s, ck('evening', { blocker: [b] }), `2026-07-${10 + i}`);
    });
    const t = aggregateStats(s, '2026-07-17').checkinTops;
    expect(t.blockers).toHaveLength(5);
  });

  it('checkinModel: порожній стор -> ваги апріорні, драйвери/архетипи не готові', () => {
    const m = aggregateStats(emptyStore(), '2026-07-17').checkinModel;
    expect(m.fit.learned).toBe(false);
    expect(m.dayIndex).toMatchObject({ last: null, mean: null, scored: 0 });
    expect(m.drivers).toEqual([]);
    expect(m.archetypes.ready).toBe(false);
    expect(m.lagged.recovery.ready).toBe(false);
    expect(m.lagged.body.ready).toBe(false);
  });

  it('checkinModel: 25 діб стабільно хороших даних -> ваги вчаться, індекс дня близький до 100', () => {
    let s = emptyStore();
    const d = new Date('2026-06-01T00:00:00Z');
    let lastKey = '';
    for (let i = 0; i < 25; i++) {
      lastKey = d.toISOString().slice(0, 10);
      s = recordEvent(s, ck('morning', { sleepH: 8, sleepQ: 5, energy: 5, mood: 5 }), lastKey);
      s = recordEvent(s, ck('afternoon', { energy: 5, mood: 5 }), lastKey);
      s = recordEvent(
        s,
        ck('evening', {
          dayScore: 5,
          output: 5,
          focusQuality: 5,
          autonomy: 5,
          jobConfidence: 5,
          moved: 'workout',
          outdoor: 'long',
          energy: 5,
          mood: 5,
        }),
        lastKey,
      );
      d.setUTCDate(d.getUTCDate() + 1);
    }
    // todayKey = ОСТАННІЙ день із записом, не наступний: інакше вікно моделі
    // закінчується порожньою добою, і dayIndex.last рахує null, не сьогодні.
    const m = aggregateStats(s, lastKey).checkinModel;
    expect(m.fit.learned).toBe(true);
    expect(m.dayIndex.last).toBeGreaterThan(90);
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

describe('aggregateStats — соціальний контекст (withWhom)', () => {
  it('tops: рейтинг частоти, filled = діб із відповіддю (не глибина вікна)', () => {
    let s = emptyStore();
    const seq = ['alone', 'alone', 'friends', 'work', 'alone'];
    seq.forEach((who, i) => {
      s = recordEvent(s, ck('afternoon', { withWhom: who }), `2026-07-${10 + i}`);
    });
    const sc = aggregateStats(s, '2026-07-14').socialContext;
    expect(sc.tops).toEqual([
      { value: 'alone', n: 3 },
      { value: 'friends', n: 1 },
      { value: 'work', n: 1 },
    ]);
    expect(sc.filled).toBe(5);
  });

  it('aloneVsOthers: гейт CORR_MIN_N — не готово, поки в кожному кошику <8', () => {
    let s = emptyStore();
    for (let i = 0; i < 7; i++) {
      const key = `2026-07-${10 + i}`;
      s = recordEvent(s, ck('afternoon', { withWhom: 'alone' }), key);
      s = recordEvent(s, ck('evening', { dayScore: 5 }), key);
    }
    const r = aggregateStats(s, '2026-07-16').socialContext.aloneVsOthers;
    expect(r).toEqual({ ready: false, needed: 8, nAlone: 7, nOthers: 0 });
  });

  it('aloneVsOthers: 8+8 із чіткою різницею -> ready, правильний напрямок і величина ефекту', () => {
    let s = emptyStore();
    // Розкид навмисний (не константа): нульова дисперсія в кошику робить
    // cohensD/welchP виродженими (pooled=0 -> d=0, se2=0 -> p=1), а не
    // «дуже значущим» — той самий інваріант, що вже в checkin-model.mjs.
    const aloneScores = [5, 4, 5, 3, 5, 4, 5, 4]; // серед. 4.375 -> round1 4.4
    const otherWho = [
      'friends',
      'family',
      'friends',
      'family',
      'friends',
      'family',
      'friends',
      'family',
    ];
    const otherScores = [2, 3, 2, 3, 2, 3, 2, 3]; // серед. 2.5
    const d = new Date('2026-07-01T00:00:00Z');
    let lastKey = '';
    for (let i = 0; i < 8; i++) {
      lastKey = d.toISOString().slice(0, 10);
      s = recordEvent(s, ck('afternoon', { withWhom: 'alone' }), lastKey);
      s = recordEvent(s, ck('evening', { dayScore: aloneScores[i] }), lastKey);
      d.setUTCDate(d.getUTCDate() + 1);
    }
    for (let i = 0; i < 8; i++) {
      lastKey = d.toISOString().slice(0, 10);
      s = recordEvent(s, ck('afternoon', { withWhom: otherWho[i] }), lastKey);
      s = recordEvent(s, ck('evening', { dayScore: otherScores[i] }), lastKey);
      d.setUTCDate(d.getUTCDate() + 1);
    }
    const r = aggregateStats(s, lastKey).socialContext.aloneVsOthers;
    expect(r.ready).toBe(true);
    expect([r.nAlone, r.nOthers]).toEqual([8, 8]);
    expect([r.aloneAvg, r.othersAvg]).toEqual([4.4, 2.5]);
    // «Сам» помітно вище — d великий і додатний, p значущий. Не вимагаємо
    // точних плаваючих чисел (їх уже golden-звіряє checkin-model.test.ts),
    // лише що buildSocialContext правильно розкладає по кошиках і передає далі.
    expect(r.d).toBeGreaterThan(2);
    expect(r.p).toBeLessThan(0.01);
  });
});

describe('aggregateStats — вогники (flames, evening)', () => {
  it('tops: рейтинг частоти + activeNights', () => {
    let s = emptyStore();
    s = recordEvent(s, ck('evening', { flames: ['duolingo', 'chess'] }), '2026-07-10');
    s = recordEvent(s, ck('evening', { flames: ['duolingo'] }), '2026-07-11');
    s = recordEvent(s, ck('evening', { flames: ['tiktok'] }), '2026-07-12');
    const f = aggregateStats(s, '2026-07-12').flameStats;
    expect(f.tops).toEqual([
      { value: 'duolingo', n: 2 },
      { value: 'chess', n: 1 },
      { value: 'tiktok', n: 1 },
    ]);
    expect(f.activeNights).toBe(3);
  });

  it('streak/best: рахує ЛИШЕ доби з УСІМА пʼятьма вогниками, не «скільки обрано»', () => {
    let s = emptyStore();
    const all5 = ['tiktok', 'duolingo', 'snapchat', 'bereal', 'chess'];
    s = recordEvent(s, ck('evening', { flames: all5 }), '2026-07-10');
    s = recordEvent(s, ck('evening', { flames: all5 }), '2026-07-11');
    // Не повний день (лише 2 з 5) -> ламає стрік, навіть коли flames ВІДПОВІДЖЕНО.
    s = recordEvent(s, ck('evening', { flames: ['duolingo', 'chess'] }), '2026-07-12');
    s = recordEvent(s, ck('evening', { flames: all5 }), '2026-07-13');
    const f = aggregateStats(s, '2026-07-13').flameStats;
    expect(f.streak).toBe(1); // лише 13-те — 12-те не повне
    expect(f.best).toBe(2); // 10-11
  });

  /* ⚠️ ДВА ПРЕДИКАТИ В ОДНІЙ КАРТЦІ — саме те, що робило блок незрозумілим.
     Графік малював «хоч один вогник», стрік поруч вимагав УСІ ПʼЯТЬ: графік
     показував «майже завжди повно», стрік показував нуль, і обидва були праві.
     Тепер обидва лічильники їдуть у payload по тижнях, щоб екран міг показати
     різницю явно, а не лишати один із них невидимим. */
  it('weekly: active («хоч один») і full («всі пʼять») — різні числа того самого тижня', () => {
    let s = emptyStore();
    const all5 = ['tiktok', 'duolingo', 'snapchat', 'bereal', 'chess'];
    s = recordEvent(s, ck('evening', { flames: all5 }), '2026-07-06');
    s = recordEvent(s, ck('evening', { flames: ['duolingo'] }), '2026-07-07');
    s = recordEvent(s, ck('evening', { flames: ['chess', 'tiktok'] }), '2026-07-08');
    const w = aggregateStats(s, '2026-07-08').flameStats.weekly;
    const cur = w[w.length - 1]!;
    expect(cur.active).toBe(3); // три вечори з хоч одним
    expect(cur.full).toBe(1); // і лише один повний
  });

  it('weekly.full = 0, коли жодного повного вечора — це нуль, а не відсутність', () => {
    let s = emptyStore();
    s = recordEvent(s, ck('evening', { flames: ['duolingo'] }), '2026-07-06');
    const w = aggregateStats(s, '2026-07-06').flameStats.weekly;
    const cur = w[w.length - 1]!;
    expect(cur.active).toBe(1);
    expect(cur.full).toBe(0);
  });

  it('missedTops: лічильник ПРОПУЩЕНОГО, лише на добах з вечірнім чек-іном (не порожня історія)', () => {
    let s = emptyStore();
    s = recordEvent(s, ck('evening', { flames: ['duolingo', 'chess'] }), '2026-07-10');
    s = recordEvent(s, ck('evening', { flames: ['duolingo'] }), '2026-07-11');
    const f = aggregateStats(s, '2026-07-11').flameStats;
    const byValue = Object.fromEntries(
      f.missedTops.map((r: { value: string; n: number }) => [r.value, r.n]),
    );
    // 10-те: пропущено tiktok/snapchat/bereal. 11-те: пропущено ще й chess.
    expect(byValue.tiktok).toBe(2);
    expect(byValue.snapchat).toBe(2);
    expect(byValue.bereal).toBe(2);
    expect(byValue.chess).toBe(1);
    expect(byValue.duolingo).toBeUndefined(); // жодного разу не пропущено
  });

  it('missedTops: порожні доби БЕЗ вечірнього чек-іну не рахуються (не шумлять рейтинг)', () => {
    let s = emptyStore();
    s = recordEvent(s, ck('evening', { flames: ['duolingo', 'chess'] }), '2026-07-10');
    // Вікно росте ВІД першого чек-іну (weeksAvailable, stats-core.mjs), тож тут
    // воно й так лише 1 тиждень — жодної порожньої до-стартової доби нема. Тест
    // лишається валідним: у ВІКНІ (з 06.07 по 10.07) лише 10.07 має чек-ін,
    // решта днів без запису взагалі й не рахуються в missedTops (гейт нижче).
    const f = aggregateStats(s, '2026-07-10').flameStats;
    const byValue = Object.fromEntries(
      f.missedTops.map((r: { value: string; n: number }) => [r.value, r.n]),
    );
    expect(byValue.tiktok).toBe(1);
    expect(byValue.snapchat).toBe(1);
    expect(byValue.bereal).toBe(1);
    expect(byValue.duolingo).toBeUndefined();
    expect(byValue.chess).toBeUndefined();
  });

  it('weekly: конструктивні (duolingo/chess) і споживчі (tiktok/snapchat/bereal) не змішуються (далека історія, без стелі)', () => {
    let s = emptyStore();
    s = recordEvent(s, ck('evening', { flames: ['tiktok'] }), '2026-01-01'); // далека історія — вікно без верхньої межі
    s = recordEvent(s, ck('evening', { flames: ['duolingo', 'tiktok'] }), '2026-07-06');
    const fw = aggregateStats(s, '2026-07-07').flameStats.weekly;
    expect(fw).toHaveLength(28); // рівно стільки тижнів між 2026-01-01 (Пн того тижня) і 2026-07-07
    const cur = fw[fw.length - 1];
    expect(cur.constructive).toBe(1);
    expect(cur.consumptive).toBe(1);
    expect(cur.active).toBe(1);
  });

  it('weekly: знаменник — лише доби, що НАСТАЛИ (поточний тиждень не штрафується)', () => {
    let s = emptyStore();
    s = recordEvent(s, ck('evening', { flames: ['chess'] }), '2026-07-06');
    s = recordEvent(s, ck('evening', { flames: ['chess'] }), '2026-07-07');
    const fw = aggregateStats(s, '2026-07-07').flameStats.weekly;
    const cur = fw[fw.length - 1];
    expect(cur.week).toBe('2026-07-06');
    expect(cur.days).toBe(2); // не 7 — інакше живий тиждень завжди «провальний»
    expect(cur.active).toBe(2);
  });
});

describe('matchCheckinNudgeWindow — вікна нагадувань про чек-ін', () => {
  it('усередині вікна -> правильний слот; поза вікном -> null', () => {
    expect(matchCheckinNudgeWindow(780)?.slot).toBe('morning'); // 13:00
    expect(matchCheckinNudgeWindow(809)?.slot).toBe('morning'); // 13:29
    expect(matchCheckinNudgeWindow(810)).toBeNull(); // 13:30 — межа виключена
    expect(matchCheckinNudgeWindow(1140)?.slot).toBe('afternoon'); // 19:00
    expect(matchCheckinNudgeWindow(1350)?.slot).toBe('evening'); // 22:30
    expect(matchCheckinNudgeWindow(0)).toBeNull(); // північ
    expect(matchCheckinNudgeWindow(600)).toBeNull(); // 10:00 — узагалі поза вікнами
  });

  it('вікна не перетинаються й усі мають text/slot', () => {
    for (const w of CHECKIN_NUDGE_WINDOWS) {
      expect(w.fromMin).toBeLessThan(w.toMin);
      expect(typeof w.text).toBe('string');
      expect(w.text.length).toBeGreaterThan(0);
    }
  });
});

describe('shouldSendCheckinNudge — гейт (тихі години / вже нагадали / слот заповнено)', () => {
  it('усі прапорці false -> надіслати', () => {
    expect(
      shouldSendCheckinNudge({ quiet: false, alreadyNudgedToday: false, slotFilled: false }),
    ).toBe(true);
  });

  it('тихі години -> НЕ слати, навіть якщо слот порожній і ще не нагадували', () => {
    expect(
      shouldSendCheckinNudge({ quiet: true, alreadyNudgedToday: false, slotFilled: false }),
    ).toBe(false);
  });

  it('уже нагадали цей слот сьогодні -> НЕ слати вдруге', () => {
    expect(
      shouldSendCheckinNudge({ quiet: false, alreadyNudgedToday: true, slotFilled: false }),
    ).toBe(false);
  });

  it('слот уже заповнено -> НЕ слати (нема про що нагадувати)', () => {
    expect(
      shouldSendCheckinNudge({ quiet: false, alreadyNudgedToday: false, slotFilled: true }),
    ).toBe(false);
  });
});

describe('inSleepNudgeWindow — вікно «Ліг спати» (23:00–02:00, з переходом через північ)', () => {
  it('23:00–23:59 і 00:00–01:59 -> у вікні', () => {
    expect(inSleepNudgeWindow(1380)).toBe(true); // 23:00
    expect(inSleepNudgeWindow(1439)).toBe(true); // 23:59
    expect(inSleepNudgeWindow(0)).toBe(true); // 00:00
    expect(inSleepNudgeWindow(119)).toBe(true); // 01:59
  });

  it('02:00 і вдень -> поза вікном', () => {
    expect(inSleepNudgeWindow(120)).toBe(false); // 02:00 — межа виключена
    expect(inSleepNudgeWindow(600)).toBe(false); // 10:00
    expect(inSleepNudgeWindow(1379)).toBe(false); // 22:59
  });
});

describe('shouldSendSleepNudge — гейт (тихі години / вже слали цієї ночі)', () => {
  it('обидва прапорці false -> надіслати', () => {
    expect(shouldSendSleepNudge({ quiet: false, alreadySentTonight: false })).toBe(true);
  });
  it('тихі години -> НЕ слати', () => {
    expect(shouldSendSleepNudge({ quiet: true, alreadySentTonight: false })).toBe(false);
  });
  it('уже слали цієї ночі -> НЕ слати вдруге', () => {
    expect(shouldSendSleepNudge({ quiet: false, alreadySentTonight: true })).toBe(false);
  });
});

describe('staleSleepNudges — завислі кнопки з МИНУЛИХ ночей (власник: не мусить просто висіти)', () => {
  it('минула ніч, надіслано, не натиснуто, не прибрано -> у списку', () => {
    const sleepLog = { '2026-07-10': { nudgeMsgId: 42 } };
    expect(staleSleepNudges(sleepLog, '2026-07-11')).toEqual([
      { dateKey: '2026-07-10', nudgeMsgId: 42 },
    ]);
  });

  it('ПОТОЧНА ніч -> НЕ в списку, навіть якщо ще не натиснуто', () => {
    const sleepLog = { '2026-07-11': { nudgeMsgId: 42 } };
    expect(staleSleepNudges(sleepLog, '2026-07-11')).toEqual([]);
  });

  it('уже натиснуто (є startedAt) -> НЕ в списку', () => {
    const sleepLog = { '2026-07-10': { nudgeMsgId: 42, startedAt: '2026-07-10T23:00:00.000Z' } };
    expect(staleSleepNudges(sleepLog, '2026-07-11')).toEqual([]);
  });

  it('уже прибрано (nudgeCleared) -> НЕ в списку вдруге', () => {
    const sleepLog = { '2026-07-10': { nudgeMsgId: 42, nudgeCleared: true } };
    expect(staleSleepNudges(sleepLog, '2026-07-11')).toEqual([]);
  });

  it('нагадування не надсилалось (нема nudgeMsgId) -> НЕ в списку', () => {
    const sleepLog = { '2026-07-10': {} };
    expect(staleSleepNudges(sleepLog, '2026-07-11')).toEqual([]);
  });
});

/* ⚠️ ПОРОЖНІЙ СЛОТ — БАГ, ЩО ВИМИКАВ НАГАДУВАННЯ.
 *
 * `checkinNudgeCheck` рахував «слот заповнено» через Boolean(store.checkins[d][slot]),
 * а порожній обʼєкт ІСТИННИЙ. Достатньо було відмітити відповідь і зняти її
 * повторним тапом: запис лишався як `{}`, нагадування на добу вимикалось
 * назавжди — і при цьому «Явка по слотах» той самий слот бачила порожнім, бо
 * рахувала Object.keys().length.
 *
 * Два визначення одного поняття, які розʼїхались. Тепер визначення ОДНЕ, і ці
 * тести стережуть саме його. */
describe('isCheckinSlotFilled — одне визначення «слот заповнено»', () => {
  it('слот із відповіддю — заповнений', () => {
    expect(isCheckinSlotFilled({ morning: { sleepQ: 4 } }, 'morning')).toBe(true);
  });

  it('ПОРОЖНІЙ обʼєкт — НЕ заповнений (саме тут ламалось)', () => {
    expect(isCheckinSlotFilled({ morning: {} }, 'morning')).toBe(false);
  });

  it('слоту немає / доби немає / сміття — не заповнений, без винятку', () => {
    expect(isCheckinSlotFilled({ morning: { sleepQ: 4 } }, 'evening')).toBe(false);
    expect(isCheckinSlotFilled(undefined, 'morning')).toBe(false);
    expect(isCheckinSlotFilled({ morning: 'сміття' }, 'morning')).toBe(false);
  });

  /* Регресія в її ПОВНОМУ вигляді: не «функція повертає false», а весь шлях —
     заповнив, зняв, і нагадування МУСИТЬ прийти. Саме цього не було. */
  it('заповнив і зняв -> слот порожній -> нагадування ВСЕ ОДНО спрацює', () => {
    let s = emptyStore();
    s = recordEvent(s, ck('morning', { sleepQ: 4 }), '2026-08-16');
    s = recordEvent(s, ck('morning', { sleepQ: null }), '2026-08-16');
    const slot = s.checkins['2026-08-16']?.morning;
    expect(Object.keys(slot)).toHaveLength(0);
    // Стара умова дала б true й з'їла нагадування:
    expect(Boolean(slot)).toBe(true);
    expect(
      shouldSendCheckinNudge({
        quiet: false,
        alreadyNudgedToday: false,
        slotFilled: isCheckinSlotFilled(s.checkins['2026-08-16'], 'morning'),
      }),
    ).toBe(true);
  });

  it('справді заповнений слот нагадування НЕ отримує', () => {
    let s = emptyStore();
    s = recordEvent(s, ck('morning', { sleepQ: 4 }), '2026-08-16');
    expect(
      shouldSendCheckinNudge({
        quiet: false,
        alreadyNudgedToday: false,
        slotFilled: isCheckinSlotFilled(s.checkins['2026-08-16'], 'morning'),
      }),
    ).toBe(false);
  });

  /* «Явка по слотах» і нагадування мусять бачити те саме — інакше розбіжність
     заведеться вдруге, просто в іншому місці. */
  it('порожній слот не рахується і в «Явці по слотах»', () => {
    let s = emptyStore();
    s = recordEvent(s, ck('morning', { sleepQ: 4 }), '2026-08-16');
    s = recordEvent(s, ck('morning', { sleepQ: null }), '2026-08-16');
    expect(aggregateStats(s, '2026-08-16').checkinFill.morning).toBe(0);
  });
});

/* ⚠️ МЕХАНІЧНИЙ ЗАМОК НА МІСЦЕ ВИКОРИСТАННЯ.
 *
 * Тести вище стережуть сам предикат — але не те, що крон ним КОРИСТУЄТЬСЯ.
 * Повернути там `Boolean(...)` можна однією правкою, і жоден поведінковий тест
 * не впаде: нагадування живе за таймером у проді, а не в тестах.
 *
 * Той самий прийом, що вже стереже назву KV-ключа publicStatus. */
describe('checkinNudgeCheck — предикат заповненості не можна підмінити назад', () => {
  const cron = readFileSync(new URL('../web/cron.mjs', import.meta.url), 'utf8');

  it('слот перевіряється спільним предикатом, а не Boolean(...)', () => {
    expect(cron).toContain('isCheckinSlotFilled(store.checkins');
    expect(cron).not.toMatch(/slotFilled:\s*Boolean\(/);
  });
});
