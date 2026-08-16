import { describe, it, expect } from 'vitest';
import {
  BLOCKS,
  clearGatedAnswers,
  coreQuestions,
  visibleQuestions,
} from '../web/app/src/components/checkin/questions.ts';
// @ts-expect-error — JS-модулі Worker'а без типів
import { emptyStore, recordEvent, aggregateStats, BLOCKER_VALUES } from '../web/stats-core.mjs';
// @ts-expect-error — JS-модуль Worker'а без типів
import { FIELDS, normalizeField, dayIndices } from '../web/checkin-model.mjs';
// @ts-expect-error — JS-модуль Worker'а без типів
import { checkinSlot, checkinSlotEndsInMin } from '../web/stats-core.mjs';

/* Умовні питання чек-іну: сховане питання не перестає існувати для сервера й
 * моделі — воно перестає існувати лише на екрані. Саме на цьому місці блок
 * «чому лягаєш пізно» показував ночі, яких не було. */

const morning = BLOCKS.find((b) => b.id === 'morning')!;

describe('showIf — гейти сну', () => {
  it('«не спав» ховає всі чотири питання про ніч', () => {
    const shown = visibleQuestions(morning, false, { sleepKind: 'none' }).map((q) => q.id);
    for (const id of ['sleepH', 'sleepQ', 'sleepLatency', 'bedtime', 'awakenings']) {
      expect(shown).not.toContain(id);
    }
    expect(shown).toContain('sleepKind');
  });

  it('«спав» повертає їх усі', () => {
    const shown = visibleQuestions(morning, false, { sleepKind: 'slept' }).map((q) => q.id);
    for (const id of ['sleepH', 'sleepQ', 'sleepLatency', 'bedtime', 'awakenings']) {
      expect(shown).toContain(id);
    }
  });

  it('«скільки засинав» стоїть у трійці про сон, а не в «Детальніше»', () => {
    const core = coreQuestions(morning, false, { sleepKind: 'slept' }).map((q) => q.id);
    expect(core).toContain('sleepLatency');
    // Порядок: ліг / засинав / проспав мусять читатись підряд.
    expect(core.indexOf('sleepLatency')).toBeGreaterThan(core.indexOf('sleepQ'));
    expect(core.indexOf('sleepLatency')).toBeLessThan(core.indexOf('bedtime'));
  });

  it('режим ночі — ПЕРШЕ питання дня', () => {
    expect(coreQuestions(morning, false, {})[0]!.id).toBe('sleepKind');
  });
});

describe('clearGatedAnswers — залишки від попереднього вибору', () => {
  it('зміна режиму ночі гасить години, якість, засинання й відбій', () => {
    const cleared = clearGatedAnswers(morning, {
      sleepKind: 'none',
      sleepH: 8,
      sleepQ: 5,
      sleepLatency: 'fast',
      bedtime: 'e23',
    });
    expect(cleared).toEqual({ sleepH: null, sleepQ: null, sleepLatency: null, bedtime: null });
  });

  /* ⚠️ ЛАНЦЮЖОК. sleepKind закриває bedtime, а закритий bedtime закриває
     lateReason — за один прохід причина пізнього відбою пережила б зникнення
     самого відбою, і buildCheckinTops рахував би ніч, якої не було. */
  it('гасить і те, що залежало від уже погашеного', () => {
    const cleared = clearGatedAnswers(morning, {
      sleepKind: 'none',
      bedtime: 'late',
      lateReason: 'scroll',
    });
    expect(cleared).toEqual({ bedtime: null, lateReason: null });
  });

  it('свій же ланцюжок у межах «спав»: ранній відбій прибирає причину пізнього', () => {
    const cleared = clearGatedAnswers(morning, {
      sleepKind: 'slept',
      bedtime: 'e23',
      lateReason: 'scroll',
    });
    expect(cleared).toEqual({ lateReason: null });
  });

  it('нічого зайвого не чіпає', () => {
    expect(clearGatedAnswers(morning, { sleepKind: 'slept', sleepH: 7.5, bedtime: 'e02' })).toEqual(
      {},
    );
  });

  /* needsWork СВІДОМО не чиститься: він залежить від ранкового «головне на
     сьогодні», тож прибрати «Робота» о 21:00 стерло б уже дані вечора. */
  it('гейт робочого дня не чистить вечірні відповіді', () => {
    const evening = BLOCKS.find((b) => b.id === 'evening')!;
    expect(clearGatedAnswers(evening, { jobProgress: 4, jobConfidence: 3 })).toEqual({});
  });
});

/* ⚠️ ОДНА ШКАЛА НА ПАРУ. movePlan і moved порівнюються між собою в «намір
   проти факту», тож нормалізація мусить давати їм ОДНАКОВІ числа. Доти в
   намірі бракувало 'active', і «легко» важило 0.50 проти 0.33 у факті —
   намір виглядав завищеним просто через різну довжину переліку. */
describe('movePlan ↔ moved — той самий нуль-до-одиниці', () => {
  const f = (name: string) => FIELDS.find((x: { name: string }) => x.name === name)!;

  it('однакові рівні', () => {
    expect(f('movePlan').levels).toEqual(f('moved').levels);
  });

  it('однакове значення на кожному рівні', () => {
    for (const lvl of ['none', 'light', 'active', 'workout']) {
      expect(normalizeField(f('movePlan'), lvl)).toBe(normalizeField(f('moved'), lvl));
    }
  });
});

/* Третій не-вечірній вхід у BODY: індекс мусить рахуватись із самого ранку. */
describe('bodyFeel — BODY тримається без вечора', () => {
  it('самих ранкових полів досить', () => {
    const ix = dayIndices({ movePlan: 'workout', bodyFeel: 5 });
    expect(ix.body).not.toBeNull();
    expect(ix.body).toBeGreaterThan(0.9);
  });
});

/* «Жодного разу» — відповідь на «які варіанти зайві» від ДАНИХ, а не від
   здогадки. Здогадка тут дорога в обидва боки. */
describe('checkinTops — варіанти, яких не обирали', () => {
  const TODAY = '2026-08-16';
  const store = (() => {
    let s = emptyStore();
    const d = new Date(`${TODAY}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 9);
    for (let i = 0; i < 10; i++) {
      s = recordEvent(
        s,
        { type: 'checkin', slot: 'evening', blocker: ['tired'], helper: ['list'] },
        d.toISOString().slice(0, 10),
      );
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return s;
  })();

  const tops = aggregateStats(store, TODAY).checkinTops;

  it('обране в перелік невикористаних не потрапляє', () => {
    expect(tops.unusedBlockers).not.toContain('tired');
    expect(tops.unusedHelpers).not.toContain('list');
  });

  it('решта переліку — потрапляє', () => {
    expect(tops.unusedBlockers).toEqual(expect.arrayContaining(['noplan', 'context', 'perfect']));
    expect(tops.unusedHelpers).toEqual(expect.arrayContaining(['plan', 'timer', 'clean', 'food']));
  });

  /* «Нічого» — свідома відповідь «нічого не завадило». У топ вона не йде, тож і
     в «невикористаних» виглядала б хибним докором. */
  it('«нічого» не рахується невикористаним варіантом', () => {
    expect(tops.unusedBlockers).not.toContain('none');
    expect(tops.unusedHelpers).not.toContain('none');
    expect(BLOCKER_VALUES).toContain('none');
  });
});

/* ⚠️ ГОЛОВНА ДІРА, ЯКУ ЗАКРИВАЄ sleepHoursOf.
   Виведення сну жило всередині моделі, і ним користувалась ЛИШЕ вона. Решта
   агрегацій читала morning.sleepH напряму — а в добу без сну того поля немає
   (питання сховане й почищене). Тобто безсонна ніч випадала з кривої сну, з
   тижневого середнього й з порівняння «сон проти оцінки дня»: середній сон
   рахувався тільки по ночах, коли ти спав, і був завищений рівно тими ночами,
   які на нього найбільше впливають. */
describe('sleepHoursOf — одне джерело виведення на всі агрегації', () => {
  const TODAY = '2026-08-16';
  /** n діб: ranges — масив ранків, циклічно. */
  const build = (mornings: Array<Record<string, unknown>>, evening: Record<string, unknown>) => {
    let s = emptyStore();
    const d = new Date(`${TODAY}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - (mornings.length - 1));
    for (const m of mornings) {
      const key = d.toISOString().slice(0, 10);
      s = recordEvent(s, { type: 'checkin', slot: 'morning', ...m }, key);
      s = recordEvent(s, { type: 'checkin', slot: 'evening', ...evening }, key);
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return s;
  };

  it('ніч без сну входить у криву сну нулем, а не пропуском', () => {
    const st = build([{ sleepKind: 'slept', sleepH: 8 }, { sleepKind: 'none' }], { dayScore: 3 });
    const series = aggregateStats(st, TODAY).checkinSeries;
    expect(series.map((p: { sleepH: number | null }) => p.sleepH)).toEqual([8, 0]);
  });

  it('тижневий середній сон більше не рахується лише по ночах, коли ти спав', () => {
    const st = build([{ sleepKind: 'slept', sleepH: 8 }, { sleepKind: 'none' }], { dayScore: 3 });
    const wk = aggregateStats(st, TODAY).checkinWeekly.at(-1)!;
    // 8 і 0 -> 4. Доти було б 8: безсонна ніч просто зникала зі знаменника.
    expect(wk.sleepAvg).toBe(4);
  });

  it('«дрімав» теж рахується — двома годинами, а не пропуском', () => {
    const st = build([{ sleepKind: 'naps' }], { dayScore: 3 });
    expect(aggregateStats(st, TODAY).checkinSeries[0]!.sleepH).toBe(2);
  });
});

/* «Ніч без сну» мусить звучати СЛОВАМИ, а не лише впливати на число. */
describe('nightKinds — зіпсовані ночі названо прямо', () => {
  const TODAY = '2026-08-16';
  const store = (() => {
    let s = emptyStore();
    const d = new Date(`${TODAY}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 4);
    const kinds = [
      { sleepKind: 'slept', sleepH: 7.5 },
      { sleepKind: 'none', nightReason: ['wait', 'work'] },
      { sleepKind: 'slept', sleepH: 8 },
      { sleepKind: 'naps', nightReason: ['cant'] },
      { sleepKind: 'slept', sleepH: 7 },
    ];
    for (const m of kinds) {
      const key = d.toISOString().slice(0, 10);
      s = recordEvent(s, { type: 'checkin', slot: 'morning', ...m }, key);
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return s;
  })();
  const nk = aggregateStats(store, TODAY).nightKinds;

  it('рахує режими ночі окремо', () => {
    expect([nk.slept, nk.naps, nk.none, nk.rough]).toEqual([3, 1, 1, 2]);
  });

  it('причини — мультивибір, кожна окремо', () => {
    expect(nk.reasons).toEqual(
      expect.arrayContaining([
        { value: 'wait', n: 1 },
        { value: 'work', n: 1 },
        { value: 'cant', n: 1 },
      ]),
    );
  });

  it('дати самих ночей — факт, тож без гейта', () => {
    expect(nk.dates).toHaveLength(2);
  });

  /* Зіпсовані ночі рідкісні: «після безсонної день гірший на 1.2» на двох
     спостереженнях — монетка, яка читається як висновок. */
  it('порівняння з рештою днів мовчить, поки вибірка мала', () => {
    expect(nk.effect.ready).toBe(false);
    expect(nk.effect.needed).toBeGreaterThanOrEqual(8);
  });
});

/* ⚠️ Таймер закриття блоку: межі мусять бути ТІ САМІ, що в checkinSlot. Другий
   перелік годин розійшовся б із першим тихо — таймер обіцяв би час, якого блок
   уже не має. Тому тест бʼє по обох одразу. */
describe('checkinSlotEndsInMin — скільки блоку лишилось жити', () => {
  const cases: Array<[number, string | null, number | null]> = [
    [8 * 60, 'morning', 360],
    [13 * 60 + 59, 'morning', 1],
    [14 * 60, 'afternoon', 360],
    [19 * 60 + 59, 'afternoon', 1],
    [20 * 60, 'evening', 360],
    [23 * 60 + 59, 'evening', 121],
    [0, 'evening', 120],
    [1 * 60 + 59, 'evening', 1],
    // Тиха зона: блоку немає, отже й таймера немає — не «0 хвилин».
    [2 * 60, null, null],
    [7 * 60 + 59, null, null],
  ];

  for (const [min, slot, left] of cases) {
    it(`${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')} -> ${slot ?? 'немає блоку'} / ${left ?? '—'}`, () => {
      expect(checkinSlot(Math.floor(min / 60))).toBe(slot);
      expect(checkinSlotEndsInMin(min)).toBe(left);
    });
  }

  it('вечір перетинає північ безперервно — жодного стрибка на 00:00', () => {
    // 23:59 -> 121, 00:00 -> 120: різниця рівно хвилина, а не «ще 24 години».
    expect(checkinSlotEndsInMin(23 * 60 + 59) - checkinSlotEndsInMin(0)).toBe(1);
  });

  it('битий вхід -> null, а не випадкове число (та сама пастка, що в checkinSlot)', () => {
    for (const v of [-1, 1440, NaN, null, undefined, '', '600', {}, []]) {
      expect(checkinSlotEndsInMin(v as never)).toBeNull();
    }
  });
});

/* Квадранти «зусилля × результат»: єдиний споживач пада work2d поза моделлю. */
describe('workQuadrants — чотири типи робочого дня', () => {
  const TODAY = '2026-08-16';
  const build = (evenings: Array<Record<string, unknown>>) => {
    let s = emptyStore();
    const d = new Date(`${TODAY}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - (evenings.length - 1));
    for (const e of evenings) {
      s = recordEvent(s, { type: 'checkin', slot: 'evening', ...e }, d.toISOString().slice(0, 10));
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return aggregateStats(s, TODAY).workQuadrants;
  };

  it('кожен кут ловить свій день', () => {
    const q = build([
      { effort: 1, output: 5 }, // потік
      { effort: 5, output: 5 }, // важка перемога
      { effort: 5, output: 1 }, // гриндж
      { effort: 1, output: 1 }, // тихий
    ]);
    expect([q.cells.flow.n, q.cells.hardwin.n, q.cells.grind.n, q.cells.quiet.n]).toEqual([
      1, 1, 1, 1,
    ]);
    expect(q.n).toBe(4);
    expect(q.mid).toBe(0);
  });

  /* ⚠️ Трійка по осі — НЕ кут. Заштовхати середину в найближчий означало б
     вигадати позицію дня, якої власник не називав. */
  it('трійка по будь-якій осі йде в mid, а не в кут', () => {
    const q = build([
      { effort: 3, output: 5 },
      { effort: 5, output: 3 },
      { effort: 3, output: 3 },
    ]);
    expect(q.mid).toBe(3);
    const cells = Object.values(q.cells) as Array<{ n: number }>;
    expect(cells.every((c) => c.n === 0)).toBe(true);
  });

  it('доба без однієї з осей не рахується взагалі — половина пада це не день', () => {
    const q = build([{ effort: 5 }, { output: 5 }, { dayScore: 4 }]);
    expect(q.n).toBe(0);
  });

  /* Прочерк замість середнього — не «нуль», а «діб замало». Нуль читався б як
     найгірша оцінка там, де оцінки просто немає. */
  it('середня оцінка кута мовчить, поки діб менше за поріг', () => {
    const q3 = build(Array.from({ length: 3 }, () => ({ effort: 5, output: 1, dayScore: 2 })));
    expect(q3.cells.grind.n).toBe(3);
    expect(q3.cells.grind.dayScore).toBeNull();
    const q4 = build(Array.from({ length: 4 }, () => ({ effort: 5, output: 1, dayScore: 2 })));
    expect(q4.cells.grind.dayScore).toBe(2);
  });
});
