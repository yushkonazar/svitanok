import { describe, it, expect } from 'vitest';
import {
  factsOf,
  cellDetail,
  causeLabel,
  CAUSE_MIN_N,
  DAY_SCORE_MIN_N,
} from '../web/app/src/lib/stateMap.ts';
import type { CheckinRaw, CheckinDay } from '../web/app/src/api/schema.ts';

// Деталі клітинки карти станів: які саме це були доби й що в них було.
//
// ⚠️ ЦЕЙ БЛОК ЛЕГКО ЗРОБИТИ БРЕХЛИВИМ. «У цих вечорах утома траплялась удвічі
// частіше» звучить як висновок, а на трьох зрізах це монетка. Тому причини
// гейтяться так само, як решта аналітики чек-іну (CORR_MIN_N=8 у stats-core):
// замало зрізів у клітинці -> рахуємо по ЗОНІ сусідніх клітинок і ЯВНО це
// підписуємо; замало навіть у зоні -> причин немає взагалі, лише дати.
//
// Дати при цьому показуються ЗАВЖДИ: «ось ці чотири вечори» чесно за будь-якої
// вибірки, бо це факт, а не висновок.

const raw = (records: CheckinRaw['records']): CheckinRaw => ({
  days: 90,
  from: '2026-05-16',
  to: '2026-08-13',
  records,
});

/** n діб поспіль з однаковим вечором. */
const nights = (n: number, evening: NonNullable<CheckinDay['evening']>, from = 1) => {
  const out: CheckinRaw['records'] = {};
  for (let i = 0; i < n; i++) {
    out[`2026-06-${String(from + i).padStart(2, '0')}`] = { evening };
  }
  return out;
};

describe('factsOf — що спостережно в записі слоту', () => {
  it('ранок: сон, якість, пізній відбій — усе з ТІЄЇ САМОЇ ночі', () => {
    const f = factsOf({ morning: { sleepH: 5.5, sleepQ: 2, bedtime: 'e02' } }, 'morning');
    expect(f).toContain('sleep:short');
    expect(f).toContain('sleepQ:bad');
    expect(f).toContain('bedtime:late');
  });

  it('ранок: виспаний і рано ліг — протилежні факти, не відсутність фактів', () => {
    const f = factsOf({ morning: { sleepH: 8.5, bedtime: 'e23' } }, 'morning');
    expect(f).toContain('sleep:long');
    expect(f).toContain('bedtime:early');
  });

  it('вечір: КОЖЕН блокер і помічник — окремий факт (мультивибір)', () => {
    const f = factsOf({ evening: { blocker: ['tired', 'distract'], helper: ['list'] } }, 'evening');
    expect(f).toEqual(expect.arrayContaining(['blocker:tired', 'blocker:distract', 'helper:list']));
  });

  it('«Нічого» — свідома відповідь, а не причина: у факти не йде', () => {
    const f = factsOf({ evening: { blocker: ['none'], helper: ['none'] } }, 'evening');
    expect(f).toEqual([]);
  });

  it('факти беруться ЛИШЕ зі свого слоту — інакше звʼязок ні до чого привʼязати', () => {
    const rec: CheckinDay = {
      morning: { sleepH: 5.5 },
      evening: { blocker: ['tired'] },
    };
    expect(factsOf(rec, 'morning')).toEqual(['sleep:short']);
    expect(factsOf(rec, 'evening')).toEqual(['blocker:tired']);
  });

  /* ⚠️ ТРИ ПОЛЯ, ЩО ЖИВИЛИ МОДЕЛЬ, АЛЕ НЕ ВМІЛИ ПОЯСНИТИ ЖОДНУ КЛІТИНКУ.
     sleepLatency, rumination і autonomy валідувались, зберігались і входили в
     індекси RECOVERY/AGENCY — тобто найглибша аналітика ними користувалась, а
     сказати «ось чому цей вечір такий» ними було неможливо. Причому це
     найцінніші кандидати в причини: вони про ГОЛОВУ, а не про обставини. */
  it('ранок: довге засинання — окремий факт, не те саме, що мало спав', () => {
    expect(factsOf({ morning: { sleepLatency: 'vslow' } }, 'morning')).toContain('latency:slow');
    expect(factsOf({ morning: { sleepLatency: 'fast' } }, 'morning')).toContain('latency:fast');
  });

  it('ранок: середнє засинання фактом НЕ стає — воно нічого не характеризує', () => {
    expect(factsOf({ morning: { sleepLatency: 'mid' } }, 'morning')).toEqual([]);
  });

  it('вечір: румінація й автономія на обох краях шкали', () => {
    const hi = factsOf({ evening: { rumination: 5, autonomy: 1 } }, 'evening');
    expect(hi).toEqual(expect.arrayContaining(['rumination:high', 'autonomy:low']));
    const lo = factsOf({ evening: { rumination: 1, autonomy: 5 } }, 'evening');
    expect(lo).toEqual(expect.arrayContaining(['rumination:low', 'autonomy:high']));
  });

  it('вечір: середина шкали (3) фактом не стає — той самий поріг, що в сусідів', () => {
    expect(factsOf({ evening: { rumination: 3, autonomy: 3 } }, 'evening')).toEqual([]);
  });

  it('нові факти мають людські підписи, а не сирі ключі', () => {
    for (const k of [
      'latency:slow',
      'latency:fast',
      'rumination:high',
      'rumination:low',
      'autonomy:high',
      'autonomy:low',
    ]) {
      expect(causeLabel(k)).not.toBe(k);
    }
  });

  it('порожній слот -> порожні факти, не виняток', () => {
    expect(factsOf({}, 'afternoon')).toEqual([]);
  });
});

describe('cellDetail — дати завжди, причини під гейтом', () => {
  it('дати вибраної клітинки віддаються навіть на одному зрізі', () => {
    const r = raw({
      '2026-06-01': { evening: { energy: 1, mood: 1, blocker: ['tired'] } },
      '2026-06-02': { evening: { energy: 5, mood: 5 } },
    });
    const d = cellDetail(r, 'evening', { energy: 1, mood: 1 });
    expect(d.readings.map((x) => x.d)).toEqual(['2026-06-01']);
    expect(d.causes).toEqual([]); // одна доба — жодних висновків
  });

  it(`менше ${CAUSE_MIN_N} зрізів у клітинці -> причини по ЗОНІ, і це підписано`, () => {
    // 3 зрізи рівно в клітинці (1,1) + 8 у сусідній (2,2) — зона їх зшиває.
    // Плюс фон із добрих діб, щоб причинам було з чим порівнюватись.
    const r = raw({
      ...nights(3, { energy: 1, mood: 1, blocker: ['tired'] }, 1),
      ...nights(8, { energy: 2, mood: 2, blocker: ['tired'] }, 4),
      ...nights(20, { energy: 5, mood: 5, helper: ['early'] }, 12),
    });
    const d = cellDetail(r, 'evening', { energy: 1, mood: 1 });
    expect(d.readings).toHaveLength(3); // сама клітинка
    expect(d.scope).toBe('zone');
    expect(d.n).toBeGreaterThanOrEqual(CAUSE_MIN_N);
    expect(d.causes.map((c) => c.key)).toContain('blocker:tired');
  });

  it('достатньо зрізів у клітинці -> причини по КЛІТИНЦІ, без розмивання', () => {
    const r = raw({
      ...nights(10, { energy: 1, mood: 1, blocker: ['tired'] }, 1),
      ...nights(20, { energy: 5, mood: 5, helper: ['early'] }, 11),
    });
    const d = cellDetail(r, 'evening', { energy: 1, mood: 1 });
    expect(d.scope).toBe('cell');
    expect(d.n).toBe(10);
    const tired = d.causes.find((c) => c.key === 'blocker:tired');
    expect(tired?.n).toBe(10);
    expect(tired?.of).toBe(10);
  });

  it('замало навіть у зоні -> причин НЕМАЄ, а не «×1.0» з двох точок', () => {
    const r = raw(nights(4, { energy: 1, mood: 1, blocker: ['tired'] }, 1));
    const d = cellDetail(r, 'evening', { energy: 1, mood: 1 });
    expect(d.causes).toEqual([]);
    expect(d.readings).toHaveLength(4); // дати все одно є
  });

  it('lift рахується проти РЕШТИ зрізів, а не проти всіх', () => {
    // 10 поганих вечорів усі з втомою; 30 добрих — жодного разу.
    const r = raw({
      ...nights(10, { energy: 1, mood: 1, blocker: ['tired'] }, 1),
      ...nights(20, { energy: 5, mood: 5 }, 11),
    });
    const tired = cellDetail(r, 'evening', { energy: 1, mood: 1 }).causes.find(
      (c) => c.key === 'blocker:tired',
    );
    // 100% у вибраних проти 0% у решті — верхня межа, а не NaN/Infinity.
    expect(tired?.share).toBe(1);
    expect(tired?.baseShare).toBe(0);
    expect(Number.isFinite(tired!.lift)).toBe(true);
  });

  it('факт, поширений СКРІЗЬ, не потрапляє в причини', () => {
    // Втома в кожній добі — вона не характеризує саме цю клітинку.
    const r = raw({
      ...nights(10, { energy: 1, mood: 1, blocker: ['tired'] }, 1),
      ...nights(20, { energy: 5, mood: 5, blocker: ['tired'] }, 11),
    });
    const d = cellDetail(r, 'evening', { energy: 1, mood: 1 });
    expect(d.causes.map((c) => c.key)).not.toContain('blocker:tired');
  });

  it('відсутність теж сигнал: «ранній старт» тут трапляється РІДШЕ', () => {
    const r = raw({
      ...nights(10, { energy: 1, mood: 1 }, 1),
      ...nights(20, { energy: 5, mood: 5, helper: ['early'] }, 11),
    });
    const d = cellDetail(r, 'evening', { energy: 1, mood: 1 });
    const early = d.causes.find((c) => c.key === 'helper:early');
    expect(early).toBeDefined();
    expect(early!.lift).toBeLessThan(1);
  });

  it('причини впорядковані за силою звʼязку, найсильніша перша', () => {
    const r = raw({
      ...nights(10, { energy: 1, mood: 1, blocker: ['tired', 'forgot'] }, 1),
      // 'forgot' трапляється й у половині добрих діб -> звʼязок слабший
      ...nights(10, { energy: 5, mood: 5, blocker: ['forgot'] }, 11),
      ...nights(10, { energy: 5, mood: 5 }, 21),
    });
    const keys = cellDetail(r, 'evening', { energy: 1, mood: 1 }).causes.map((c) => c.key);
    expect(keys[0]).toBe('blocker:tired');
    expect(keys.indexOf('blocker:tired')).toBeLessThan(keys.indexOf('blocker:forgot'));
  });

  it('порожня клітинка -> порожні деталі, не виняток', () => {
    const r = raw(nights(10, { energy: 5, mood: 5 }, 1));
    const d = cellDetail(r, 'evening', { energy: 1, mood: 1 });
    expect(d.readings).toEqual([]);
    expect(d.causes).toEqual([]);
  });
});

/* ⚠️ РЕГРЕСІЯ, знайдена наживо в демо. У режимі «Усі» клітинка з самими
   ВЕЧІРНІМИ зрізами показувала «🫂 Друзі — 0 із 17, норма 28%» і «🛌 Спав 6–8
   год — 0 із 17». Виглядало як висновок («у ці стани ти не буваєш із людьми»),
   а насправді вечірній блок про компанію взагалі не питає: поле не існує в
   цьому слоті. Відсутність ПОЛЯ видавалась за відсутність ЯВИЩА — найгірший
   різновид брехні для цього блоку, бо він саме про «що поруч».

   Тому кожен факт порівнюється лише в межах свого слоту. */
describe('cellDetail — факт не виходить за межі свого слоту', () => {
  it('вечірня клітинка не звинувачує ранкові й денні поля у відсутності', () => {
    const records: CheckinRaw['records'] = {};
    for (let i = 0; i < 10; i++) {
      records[`2026-06-${String(i + 1).padStart(2, '0')}`] = {
        // Ранок і день заповнені, але їхні зрізи стоять В ІНШИХ клітинках.
        morning: { energy: 5, mood: 5, sleepH: 7.5 },
        afternoon: { energy: 5, mood: 5, withWhom: 'friends' },
        evening: { energy: 1, mood: 1, blocker: ['tired'] },
      };
    }
    for (let i = 0; i < 10; i++) {
      records[`2026-07-${String(i + 1).padStart(2, '0')}`] = {
        morning: { energy: 5, mood: 5, sleepH: 7.5 },
        afternoon: { energy: 5, mood: 5, withWhom: 'friends' },
        evening: { energy: 5, mood: 5 },
      };
    }
    const r = raw(records);
    const keys = cellDetail(r, 'all', { energy: 1, mood: 1 }).causes.map((c) => c.key);
    expect(keys).toContain('blocker:tired'); // свій слот — рахується
    expect(keys).not.toContain('with:friends'); // чужий слот — мовчимо
    expect(keys).not.toContain('sleep:mid');
  });

  it('знаменник факту — зрізи ЙОГО слоту, а не вся вибірка', () => {
    const records: CheckinRaw['records'] = {};
    // 10 діб, де і ранок, і вечір падають в одну клітинку (1,1).
    for (let i = 0; i < 10; i++) {
      records[`2026-06-${String(i + 1).padStart(2, '0')}`] = {
        morning: { energy: 1, mood: 1, sleepH: 5.5 },
        evening: { energy: 1, mood: 1, blocker: ['tired'] },
      };
    }
    for (let i = 0; i < 10; i++) {
      records[`2026-07-${String(i + 1).padStart(2, '0')}`] = {
        morning: { energy: 5, mood: 5, sleepH: 7.5 },
        evening: { energy: 5, mood: 5 },
      };
    }
    const d = cellDetail(raw(records), 'all', { energy: 1, mood: 1 });
    expect(d.n).toBe(20); // 10 ранків + 10 вечорів у клітинці
    // Але «спав <6» рахується з 10 РАНКІВ, не з 20 зрізів.
    expect(d.causes.find((c) => c.key === 'sleep:short')?.of).toBe(10);
    expect(d.causes.find((c) => c.key === 'blocker:tired')?.of).toBe(10);
  });
});

describe('cellDetail — оцінка дня як окреме число', () => {
  it('середня оцінка вибраних діб проти решти', () => {
    const r = raw({
      ...nights(10, { energy: 1, mood: 1, dayScore: 2 }, 1),
      ...nights(10, { energy: 5, mood: 5, dayScore: 4 }, 11),
    });
    const d = cellDetail(r, 'evening', { energy: 1, mood: 1 });
    expect(d.dayScore).toEqual({ avg: 2, base: 4, n: 10 });
  });

  it('без оцінок -> null, а не 0 (0 читалось би як «жахливий день»)', () => {
    const r = raw({
      ...nights(10, { energy: 1, mood: 1 }, 1),
      ...nights(10, { energy: 5, mood: 5 }, 11),
    });
    expect(cellDetail(r, 'evening', { energy: 1, mood: 1 }).dayScore).toBeNull();
  });

  // ⚠️ Доти гейта тут не було ВЗАГАЛІ — єдине таке місце в блоці. Одна доба
  // давала впевнене «2 проти 4», ще й розфарбоване в червоний, тобто читалось
  // як висновок. «Оцінка ТАКИХ ДНІВ» із одного дня — це оцінка одного дня.
  it('менше DAY_SCORE_MIN_N діб у клітинці -> порівняння з нормою немає', () => {
    const r = raw({
      ...nights(DAY_SCORE_MIN_N - 1, { energy: 1, mood: 1, dayScore: 2 }, 1),
      ...nights(10, { energy: 5, mood: 5, dayScore: 4 }, 11),
    });
    expect(cellDetail(r, 'evening', { energy: 1, mood: 1 }).dayScore).toBeNull();
  });

  it('рівно DAY_SCORE_MIN_N діб — уже показуємо, з розміром вибірки', () => {
    const r = raw({
      ...nights(DAY_SCORE_MIN_N, { energy: 1, mood: 1, dayScore: 2 }, 1),
      ...nights(10, { energy: 5, mood: 5, dayScore: 4 }, 11),
    });
    expect(cellDetail(r, 'evening', { energy: 1, mood: 1 }).dayScore).toEqual({
      avg: 2,
      base: 4,
      n: DAY_SCORE_MIN_N,
    });
  });

  // Норма з однієї доби так само не норма, як і середнє з однієї — тому гейт
  // стоїть на ОБОХ боках, а не лише на клітинці.
  it('замало діб У РЕШТІ вибірки -> норми немає, отже й порівняння', () => {
    const r = raw({
      ...nights(10, { energy: 1, mood: 1, dayScore: 2 }, 1),
      ...nights(DAY_SCORE_MIN_N - 1, { energy: 5, mood: 5, dayScore: 4 }, 11),
    });
    expect(cellDetail(r, 'evening', { energy: 1, mood: 1 }).dayScore).toBeNull();
  });
});
