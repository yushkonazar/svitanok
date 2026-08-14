import { describe, it, expect } from 'vitest';
// @ts-expect-error — JS-модуль Worker'а без типів
import { emptyStore, recordEvent, aggregateStats, STATS_WINDOWS } from '../web/stats-core.mjs';

/* Вікна агрегації.
 *
 * ⚠️ ПРИВІД. Екран «Статистика» рахував на пʼятьох різних глибинах одночасно —
 * 30 діб (топи, категорії, дрейф, явка), 60 (соцконтекст), 90 (модель, карта),
 * 8 тижнів (тренди) і «вся історія» (теплокарта, утримання, ритуал) — і майже
 * ніде цього не писав. Читач бачив числа поруч і природно вважав, що вони про
 * один період. «Найчастіше заважала втома» і «куди йде час» — це різні місяці,
 * якщо чек-ін заповнювався нерівно.
 *
 * Гірше: у RhythmBlock глибина була ЗАШИТА В РЯДОК («FIT% ПОДАНИХ · 8 ТИЖНІВ»)
 * окремо від серверної константи. Розійшлись би — підпис збрехав би мовчки, і
 * дізнатись про це не було б звідки. Той самий клас помилки, що B10.
 *
 * Тому вікна названі, їдуть у payload і перевіряються тут МЕХАНІЧНО: не «чи
 * константа дорівнює 30», а чи дані справді обрізані там, де обіцяно. */

const TODAY = '2026-08-13';
const back = (n: number) => {
  const d = new Date(TODAY + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
const ck = (slot: string, fields: Record<string, unknown>) => ({
  type: 'checkin',
  slot,
  ...fields,
});

describe('STATS_WINDOWS — вікна оголошені й доїжджають до клієнта', () => {
  it('payload несе вікна, а не лише результати', () => {
    const w = aggregateStats(emptyStore(), TODAY).windows;
    expect(w).toEqual(STATS_WINDOWS);
    expect(Object.keys(w).length).toBeGreaterThan(0);
  });

  it('усі оголошені вікна — додатні числа (нуль тихо вимкнув би блок)', () => {
    for (const [k, v] of Object.entries(STATS_WINDOWS as Record<string, number>)) {
      expect(typeof v, k).toBe('number');
      expect(v, k).toBeGreaterThan(0);
    }
  });
});

/* ⚠️ МІНА, знайдена цими ж тестами. Поле `days` означало РІЗНЕ в різних
   місцях того самого payload: у checkinFill — глибину вікна (30), а в
   checkinTops і socialContext — кількість ЗАПОВНЕНИХ діб. Обидва рендерились
   однаково («· N ДІБ»), тож «ЩО ЗАВАЖАЛО · 12 ДІБ» читалось як «за останні 12
   днів», а насправді означало «12 заповнених діб із останніх 30». Тепер
   `days` — завжди вікно, `filled` — завжди скільки в ньому заповнено. */
describe('days — це ВІКНО, filled — скільки в ньому заповнено', () => {
  it('однакова назва означає одне й те саме в усьому payload', () => {
    let s = emptyStore();
    for (const o of [0, 1, 2]) {
      s = recordEvent(s, ck('evening', { blocker: ['tired'] }), back(o));
      s = recordEvent(s, ck('afternoon', { withWhom: 'alone' }), back(o));
    }
    const agg = aggregateStats(s, TODAY);
    expect(agg.checkinFill.days).toBe(STATS_WINDOWS.checkinRecent);
    expect(agg.checkinTops.days).toBe(STATS_WINDOWS.checkinRecent);
    expect(agg.socialContext.days).toBe(STATS_WINDOWS.checkinMid);
    expect(agg.categoryInsight.days).toBe(STATS_WINDOWS.checkinRecent);
    expect(agg.intentDrift.days).toBe(STATS_WINDOWS.checkinRecent);
  });

  it('filled рахує заповнені доби й НЕ дорівнює вікну', () => {
    let s = emptyStore();
    for (const o of [0, 1, 2]) s = recordEvent(s, ck('evening', { blocker: ['tired'] }), back(o));
    const tops = aggregateStats(s, TODAY).checkinTops;
    expect(tops.filled).toBe(3);
    expect(tops.days).toBe(STATS_WINDOWS.checkinRecent);
  });
});

/* Механічна перевірка: доба рівно на межі вікна ВСЕРЕДИНІ, наступна — зовні.
 * Саме це й ламається, коли хтось міняє константу в одному місці з двох. */
describe('оголошене вікно = справжня межа даних', () => {
  const withCheckins = (offsets: number[], fields: Record<string, unknown>) => {
    let s = emptyStore();
    for (const o of offsets) {
      s = recordEvent(s, ck('morning', { sleepH: 7.5, energy: 3, mood: 3, ...fields }), back(o));
      s = recordEvent(s, ck('afternoon', { energy: 3, mood: 3, withWhom: 'alone' }), back(o));
      s = recordEvent(
        s,
        ck('evening', { energy: 3, mood: 3, dayScore: 3, blocker: ['tired'] }),
        back(o),
      );
    }
    return s;
  };

  it('checkinTops обрізає рівно на checkinRecent', () => {
    const edge = STATS_WINDOWS.checkinRecent - 1;
    const inside = aggregateStats(withCheckins([edge], {}), TODAY).checkinTops;
    const outside = aggregateStats(withCheckins([edge + 1], {}), TODAY).checkinTops;
    expect(inside.blockers.length).toBe(1);
    expect(outside.blockers.length).toBe(0);
  });

  it('categoryInsight обрізає рівно на checkinRecent', () => {
    const edge = STATS_WINDOWS.checkinRecent - 1;
    const mk = (o: number) =>
      recordEvent(emptyStore(), ck('afternoon', { ate: ['work'] }), back(o));
    expect(aggregateStats(mk(edge), TODAY).categoryInsight.total).toBe(1);
    expect(aggregateStats(mk(edge + 1), TODAY).categoryInsight.total).toBe(0);
  });

  it('socialContext обрізає рівно на checkinMid', () => {
    const edge = STATS_WINDOWS.checkinMid - 1;
    expect(aggregateStats(withCheckins([edge], {}), TODAY).socialContext.tops.length).toBe(1);
    expect(aggregateStats(withCheckins([edge + 1], {}), TODAY).socialContext.tops.length).toBe(0);
  });

  it('checkinRaw обрізає рівно на checkinDeep', () => {
    const edge = STATS_WINDOWS.checkinDeep - 1;
    const rec = (o: number) => aggregateStats(withCheckins([o], {}), TODAY).checkinRaw.records;
    expect(Object.keys(rec(edge))).toHaveLength(1);
    expect(Object.keys(rec(edge + 1))).toHaveLength(0);
  });

  it('checkinSeries не бере нічого старшого за checkinRecent', () => {
    const edge = STATS_WINDOWS.checkinRecent - 1;
    const s = withCheckins([0, edge, edge + 1, edge + 40], {});
    const days = aggregateStats(s, TODAY).checkinSeries.map((p: { d: string }) => p.d);
    expect(days).toContain(back(edge));
    expect(days).not.toContain(back(edge + 1));
  });

  it('тренди подач — рівно trendWeeks тижнів', () => {
    const agg = aggregateStats(emptyStore(), TODAY);
    expect(agg.appliedWeekly.length).toBe(STATS_WINDOWS.trendWeeks);
    expect(agg.fitWeekly.length).toBe(STATS_WINDOWS.trendWeeks);
  });

  it('checkinWeekly — рівно checkinWeeks тижнів', () => {
    expect(aggregateStats(emptyStore(), TODAY).checkinWeekly.length).toBe(
      STATS_WINDOWS.checkinWeeks,
    );
  });
});

/* ⚠️ ДЕФЕКТ, який знайшовся під час проходу по блоках. «Ритуал відкриття»
   рахувався по ВСЬОМУ масиву opensMin — а це кап HISTORY_CAP, тобто до року.
   Медіана й розкид за рік не рухаються від того, що звичка змінилась три
   місяці тому: свіжі 90 діб тонуть у 275 старих. Блок при цьому обіцяє
   відповісти «наскільки це ритуал ЗАРАЗ», а показує середнє по році.

   Вікно тут рахується в ЗАПИСАХ, а не в календарних добах: opensMin — плаский
   масив хвилин без дат, один запис = одна доба, коли застосунок відкривали.
   Тобто це «останні N діб з відкриттям», і підпис мусить казати саме так. */
describe('openRhythm — ритуал міряється по СВІЖИХ добах', () => {
  const store = (mins: number[]) => ({ ...emptyStore(), opensMin: mins });

  it('бере лише останні rhythmOpens записів', () => {
    // 300 ранніх діб (о 08:00) + 90 пізніх (о 12:00). Вікно 90 -> медіана пізня.
    const mins = [...Array(300).fill(0), ...Array(STATS_WINDOWS.rhythmOpens).fill(240)];
    expect(aggregateStats(store(mins), TODAY).openRhythm.median).toBe(240);
  });

  it('без вікна та сама історія дала б медіану старої звички', () => {
    // Контроль: якби рахували ВСЕ, медіана 390 записів була б 0 (більшість — старі).
    const mins = [...Array(300).fill(0), ...Array(STATS_WINDOWS.rhythmOpens).fill(240)];
    const all = [...mins].sort((a, b) => a - b);
    expect(all[Math.floor(all.length / 2)]).toBe(0);
  });

  it('n у відповіді — розмір ВИКОРИСТАНОЇ вибірки, не всієї історії', () => {
    const mins = Array(300).fill(30);
    expect(aggregateStats(store(mins), TODAY).openRhythm.n).toBe(STATS_WINDOWS.rhythmOpens);
  });

  it('історії менше за вікно -> беремо скільки є', () => {
    expect(aggregateStats(store([10, 20, 30, 40, 50, 60]), TODAY).openRhythm.n).toBe(6);
  });

  it('замало записів -> не готово, як і раніше', () => {
    expect(aggregateStats(store([10, 20]), TODAY).openRhythm.ready).toBe(false);
  });
});

/* Дрейф ритуалу: перша половина вікна проти другої.
 *
 * ⚠️ Заради ЦЬОГО блок і існує. Коробка з вусами описує вікно ЦІЛКОМ, тобто
 * каже «як було загалом» — але блок обіцяє відповісти на «наскільки це ВЖЕ
 * ритуал», а ритуал це процес: розкид, який падає, і розкид, який стоїть,
 * дають ту саму коробку. Різницю видно лише в порівнянні половин. */
describe('openRhythm — чи затискається ритм', () => {
  const store = (mins: number[]) => ({ ...emptyStore(), opensMin: mins });

  it('розкид упав -> late.iqr помітно менший за early.iqr', () => {
    // 20 хаотичних записів, далі 20 майже однакових.
    const chaos = Array.from({ length: 20 }, (_, i) => (i % 2 ? 0 : 240));
    const tight = Array.from({ length: 20 }, (_, i) => 60 + (i % 2));
    const d = aggregateStats(store([...chaos, ...tight]), TODAY).openRhythm.drift;
    expect(d).not.toBeNull();
    expect(d.early.iqr).toBeGreaterThan(100);
    expect(d.late.iqr).toBeLessThan(5);
  });

  it('половини рівні -> обидва розкиди однакові, висновку про зміну немає', () => {
    const mins = Array.from({ length: 40 }, (_, i) => (i % 2 ? 30 : 90));
    const d = aggregateStats(store(mins), TODAY).openRhythm.drift;
    expect(d.early.iqr).toBe(d.late.iqr);
  });

  /* Гейт на КОЖНУ половину окремо. «Замало для порівняння» і «розкид не
     змінився» — різні відповіді, і сплутати їх тут найлегше: нуль різниці
     виглядає як стабільність. */
  it('половини коротшої за гейт -> drift = null, а не нульова різниця', () => {
    const mins = Array.from({ length: 10 }, () => 60); // half = 5 < 8
    expect(aggregateStats(store(mins), TODAY).openRhythm.drift).toBeNull();
  });

  it('половини рахуються за ПОРЯДКОМ записів, а не за значенням', () => {
    // Якби ділили відсортований ряд, «раніше» завжди було б меншим за «тепер».
    const mins = [...Array(20).fill(200), ...Array(20).fill(10)];
    const d = aggregateStats(store(mins), TODAY).openRhythm.drift;
    expect(d.early.median).toBe(200);
    expect(d.late.median).toBe(10);
  });
});
