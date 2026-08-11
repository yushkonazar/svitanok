import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// ⚠️ Кілька імпортів, а не один список: prettier переносить довгий список на
// кілька рядків, і однорядковий @ts-expect-error відʼїжджає від рядка з
// помилкою — тоді директива «невикористана», а помилка типів лишається.
// @ts-expect-error — JS-модуль Worker'а без типів
import { FIELDS, INDICES, normalizeField } from '../web/checkin-model.mjs';
// @ts-expect-error — JS-модуль Worker'а без типів
import { dayIndices, fitWeights, dayIndexScore } from '../web/checkin-model.mjs';
// @ts-expect-error — JS-модуль Worker'а без типів
import { computeDrivers, computeLagged, computeArchetypes } from '../web/checkin-model.mjs';
// @ts-expect-error — JS-модуль Worker'а без типів
import { analyzeCheckinModel, flattenCheckinDay } from '../web/checkin-model.mjs';
// @ts-expect-error — JS-модуль Worker'а без типів
import { CHECKIN_FIELDS } from '../web/stats-core.mjs';

// Золоті вектори — згенеровані research/checkin_model.py (Python/numpy/scipy,
// та сама математика в читабельному вигляді). Розбіжність тут = регресія ПОРТУ
// в JS, а не «трохи інша, але прийнятна» відповідь: обидві сторони мусять
// рахувати ІДЕНТИЧНО, бо значущість/k-means свідомо зроблені без PRNG
// (Welch's t-test замість перестановок, детермінований maxmin-init) саме
// заради того, щоб це порівняння мало сенс.
const golden = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'checkin-golden.json'), 'utf8'));

const near = (a: number | null, b: number | null, eps = 1e-6) => {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) < eps;
};

describe('checkin-model — реєстр полів', () => {
  it('порядок і назви полів збігаються з Python-реєстром (fieldOrder)', () => {
    expect(FIELDS.map((f: { name: string }) => f.name)).toEqual(golden.fieldOrder);
  });

  it('константи гейтів збігаються з Python', () => {
    expect(golden.constants.MIN_FIELDS_PER_INDEX).toBe(2);
    expect(golden.constants.MIN_DAYS_FOR_FIT).toBe(20);
    expect(golden.constants.MIN_N_PER_BUCKET).toBe(8);
    expect(golden.constants.RIDGE_LAMBDA).toBe(1.0);
  });
});

describe('checkin-model — нормалізація 0..1', () => {
  it.each(golden.normalize as Array<{ field: string; raw: unknown; want: number }>)(
    '$field($raw) -> $want',
    ({ field, raw, want }) => {
      const f = FIELDS.find((x: { name: string }) => x.name === field)!;
      expect(near(normalizeField(f, raw), want)).toBe(true);
    },
  );

  it('сон: плато 7–9 год = 1.0, спад в обидва боки (не лінійна шкала)', () => {
    const sleepH = FIELDS.find((f: { name: string }) => f.name === 'sleepH')!;
    expect(normalizeField(sleepH, 7)).toBe(1);
    expect(normalizeField(sleepH, 9)).toBe(1);
    expect(normalizeField(sleepH, 8)).toBe(1);
    expect(normalizeField(sleepH, 3)).toBe(0); // 7-3=4 -> 1-4/4=0
    expect(normalizeField(sleepH, 12)).toBe(0); // 12-9=3 -> 1-3/3=0
  });

  it('polarity=-1 реверсить шкалу (румінація 5 — найгірше -> 0)', () => {
    const rum = FIELDS.find((f: { name: string }) => f.name === 'rumination')!;
    expect(normalizeField(rum, 1)).toBe(1);
    expect(normalizeField(rum, 5)).toBe(0);
  });

  it('невідоме значення в levels -> null, а не 0', () => {
    const bedtime = FIELDS.find((f: { name: string }) => f.name === 'bedtime')!;
    expect(normalizeField(bedtime, 'вигадка')).toBeNull();
  });
});

describe('checkin-model — sampleIndices (перші 3 доби golden-набору)', () => {
  it('dayIndices на перших 3 добах збігається з Python', () => {
    const days = golden.days as Array<Record<string, unknown>>;
    for (let i = 0; i < 3; i++) {
      const got = dayIndices(days[i]);
      const want = golden.sampleIndices[i];
      for (const idx of INDICES as string[]) expect(near(got[idx], want[idx])).toBe(true);
    }
  });
});

describe('checkin-model — fitWeights (ridge, 120 діб)', () => {
  it('ваги/R²/n збігаються з Python до 1e-6', () => {
    const days = golden.days as Array<Record<string, unknown> & { dayScore: number }>;
    const rows = days.map((d) => ({ indices: dayIndices(d), dayScore: d.dayScore }));
    const fit = fitWeights(rows);
    expect(fit.learned).toBe(golden.fit.learned);
    expect(fit.n).toBe(golden.fit.n);
    expect(near(fit.r2, golden.fit.r2, 1e-4)).toBe(true);
    for (const idx of INDICES as string[]) {
      expect(near(fit.weights[idx], golden.fit.weights[idx], 1e-4)).toBe(true);
    }
  });

  it('менше MIN_DAYS_FOR_FIT діб -> апріорні ваги, learned=false', () => {
    const rows = Array.from({ length: 5 }, () => ({
      indices: Object.fromEntries(INDICES.map((i: string) => [i, 0.5])),
      dayScore: 3,
    }));
    const fit = fitWeights(rows);
    expect(fit.learned).toBe(false);
    for (const idx of INDICES as string[]) expect(fit.weights[idx]).toBeCloseTo(1 / 5, 10);
  });
});

describe('checkin-model — dayIndexScore', () => {
  it('останній і середній індекс дня збігаються з Python', () => {
    const days = golden.days as Array<Record<string, unknown> & { dayScore: number }>;
    const idx = days.map((d) => dayIndices(d));
    const fit = fitWeights(idx.map((ix, i) => ({ indices: ix, dayScore: days[i]!.dayScore })));
    const scores = idx.map((ix) => dayIndexScore(ix, fit.weights));
    expect(near(scores[scores.length - 1], golden.dayIndex.last, 1e-1)).toBe(true);
  });

  it('перенормовує ваги на присутні індекси (частковий вхід не занижує штучно)', () => {
    const partial = { recovery: 1.0, resource: null, work: null, agency: null, body: null };
    const weights = Object.fromEntries(INDICES.map((i: string) => [i, 0.2]));
    expect(dayIndexScore(partial, weights)).toBe(100); // 1.0 * 100%, а не 1.0*20%=20
  });

  it('жодного індексу -> null, а не 0', () => {
    const empty = Object.fromEntries(INDICES.map((i: string) => [i, null]));
    const weights = Object.fromEntries(INDICES.map((i: string) => [i, 0.2]));
    expect(dayIndexScore(empty, weights)).toBeNull();
  });
});

describe('checkin-model — драйвери (Welch, без PRNG)', () => {
  it('топ-драйвери за |d| збігаються з Python (значення й порядок)', () => {
    const days = golden.days as Array<Record<string, unknown>>;
    const got = computeDrivers(days);
    const want = golden.drivers as Array<{ field: string; delta: number; d: number; p: number }>;
    expect(got.length).toBe(want.length);
    for (let i = 0; i < Math.min(6, want.length); i++) {
      const g = got[i];
      const w = want[i]!;
      expect(g.field).toBe(w.field);
      expect(near(g.delta, w.delta, 1e-2)).toBe(true);
      expect(near(g.d, w.d, 1e-2)).toBe(true);
      expect(near(g.p, w.p, 5e-3)).toBe(true);
    }
  });

  it('гейт n>=8 у КОЖНОМУ кошику: поле з рідкісним значенням не потрапляє в список', () => {
    const days = Array.from({ length: 30 }, (_, i) => ({
      output: i < 3 ? 5 : 3, // hi-кошик матиме лише 3 доби — менше MIN_N_PER_BUCKET
      dayScore: 3 + (i % 2),
    }));
    const got = computeDrivers(days);
    expect(got.find((r: { field: string }) => r.field === 'output')).toBeUndefined();
  });
});

describe('checkin-model — лаговий звʼязок (сьогодні -> завтра)', () => {
  it('rho/p для recovery/body збігаються з Python', () => {
    const days = golden.days as Array<Record<string, unknown>>;
    const rec = computeLagged(days, 'recovery');
    const body = computeLagged(days, 'body');
    expect(rec.ready).toBe(golden.lagged.recovery.ready);
    expect(near(rec.rho, golden.lagged.recovery.rho, 1e-2)).toBe(true);
    expect(body.ready).toBe(golden.lagged.body.ready);
    expect(near(body.rho, golden.lagged.body.rho, 1e-2)).toBe(true);
  });

  it('замало діб -> ready=false, без вигаданого числа', () => {
    const days = Array.from({ length: 5 }, () => ({ sleepH: 8, dayScore: 4 }));
    expect(computeLagged(days, 'recovery')).toMatchObject({ ready: false });
  });
});

describe('checkin-model — архетипи (k-means, детермінований maxmin-init)', () => {
  it('групи (n, share, top/low) збігаються з Python', () => {
    const days = golden.days as Array<Record<string, unknown>>;
    const got = computeArchetypes(days);
    const want = golden.archetypes;
    expect(got.ready).toBe(want.ready);
    expect(got.groups.length).toBe(want.groups.length);
    for (let i = 0; i < got.groups.length; i++) {
      expect(got.groups[i].n).toBe(want.groups[i].n);
      expect(got.groups[i].top).toBe(want.groups[i].top);
      expect(got.groups[i].low).toBe(want.groups[i].low);
    }
  });

  it('замало діб (< k*5) -> ready=false', () => {
    const days = Array.from({ length: 10 }, () => ({
      sleepH: 8,
      'energy@morning': 3,
      'mood@morning': 3,
      output: 3,
      autonomy: 3,
      moved: 'light',
      dayScore: 3,
    }));
    expect(computeArchetypes(days, 4)).toMatchObject({ ready: false });
  });
});

describe('checkin-model — analyzeCheckinModel (наскрізний прохід)', () => {
  it('повна модель на golden-наборі не кидає й дає узгоджені форми', () => {
    const days = golden.days as Array<Record<string, unknown>>;
    const res = analyzeCheckinModel(days);
    expect(res.n).toBe(120);
    expect(res.fit.learned).toBe(true);
    expect(res.drivers.length).toBeGreaterThan(0);
    expect(res.archetypes.ready).toBe(true);
  });
});

describe('flattenCheckinDay — адаптер nested checkins[date] -> плоский день', () => {
  const asList = (v: unknown): Array<string | number> =>
    Array.isArray(v)
      ? (v as Array<string | number>)
      : v == null || v === ''
        ? []
        : [v as string | number];
  const CATS = ['work', 'learn', 'rest'];

  it('мапить поля по слотах на очікувані ключі моделі', () => {
    const rec = {
      morning: { sleepH: 7.5, energy: 4, mood: 3, plan: ['work'] },
      afternoon: { energy: 3, ate: ['work'] },
      evening: { output: 4, dayScore: 4, autonomy: 5 },
    };
    const flat = flattenCheckinDay(rec, asList, CATS);
    expect(flat.sleepH).toBe(7.5);
    expect(flat['energy@morning']).toBe(4);
    expect(flat['energy@afternoon']).toBe(3);
    expect(flat.output).toBe(4);
    expect(flat.dayScore).toBe(4);
    expect(flat.intentMatch).toBe(1); // 'work' в обох -> влучив
  });

  it('план і факт не перетинаються -> intentMatch=0; відсутність одного з них -> null', () => {
    const hit = flattenCheckinDay(
      { morning: { plan: ['work'] }, afternoon: { ate: ['rest'] } },
      asList,
      CATS,
    );
    expect(hit.intentMatch).toBe(0);

    const noAte = flattenCheckinDay({ morning: { plan: ['work'] }, afternoon: {} }, asList, CATS);
    expect(noAte.intentMatch).toBeNull();
  });

  it('порожній rec не падає — усе null', () => {
    const flat = flattenCheckinDay(undefined, asList, CATS);
    expect(flat.sleepH).toBeNull();
    expect(flat.dayScore).toBeNull();
    expect(flat.intentMatch).toBeNull();
  });
});

describe('checkin-model — реєстр чек-іну й реєстр моделі не розʼїжджаються (B5)', () => {
  it('КОЖНЕ enum-значення CHECKIN_FIELDS відоме моделі (або явно оголошене легасі)', () => {
    // Механічний інваріант замість ручної звірки двох списків: значення, яке
    // чек-ін ЗБИРАЄ, а модель не знає, normalizeField перетворює на null. Для
    // BODY (moved+outdoor, а MIN_FIELDS_PER_INDEX=2) це означає null на весь
    // індекс -> доба взагалі не потрапляє у fitWeights/архетипи. Саме так
    // moved:'active' тихо викидав дні з навчання, і побачити це в UI було
    // неможливо.
    const drift: string[] = [];
    for (const [slot, spec] of Object.entries(
      CHECKIN_FIELDS as Record<string, Record<string, { enum?: string[] }>>,
    )) {
      for (const [field, def] of Object.entries(spec)) {
        if (!def.enum) continue;
        // Модель тримає частину полів у зрізах доби (energy@morning) — шукаємо
        // обидві форми; поля, яких у моделі немає взагалі (lateReason,
        // withWhom), вона свідомо не рахує, і це не дрейф.
        const mf = (FIELDS as Array<{ name: string; levels?: string[]; legacyUnscored?: string[] }>)
          .filter((f) => f.levels)
          .find((f) => f.name === field || f.name === `${field}@${slot}`);
        if (!mf) continue;
        const known = new Set([...(mf.levels ?? []), ...(mf.legacyUnscored ?? [])]);
        for (const v of def.enum) if (!known.has(v)) drift.push(`${slot}.${field}: "${v}"`);
      }
    }
    expect(drift).toEqual([]);
  });
});
