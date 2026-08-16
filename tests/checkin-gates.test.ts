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
