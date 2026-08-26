// Чиста логіка планувальника (web/core/scheduler/core.mjs): прострочення,
// наступний alarm, крок періоду з пропуском появ, dedupe-ключ, рішення
// сторожа, статистика джитера. Платформи тут немає — саме тому це тестується
// звичайним vitest без DO.

import { describe, it, expect } from 'vitest';
import {
  dueJobs,
  nextAlarmMs,
  occurrenceDedupeKey,
  advanceDueAt,
  shouldWatchdogTick,
  recordJitterSample,
  jitterStats,
  WATCHDOG_GRACE_MS,
} from '../web/core/scheduler/core.mjs';

/** Мінімальний рядок jobs: тестам важливі лише due_at і kind. */
const job = (id: string, dueAt: string) => ({
  id,
  kind: id,
  due_at: dueAt,
  period: 5,
  payload_json: null,
  last_run_at: null,
  last_status: null,
  attempts: 0,
  dedupe_key: null,
});

const T0 = Date.parse('2026-08-26T10:00:00.000Z');

describe('dueJobs', () => {
  it('фільтрує майбутнє і сортує за давністю (найдавніша перша)', () => {
    const jobs = [
      job('later', '2026-08-26T10:05:00.000Z'),
      job('oldest', '2026-08-26T09:50:00.000Z'),
      job('newer', '2026-08-26T09:55:00.000Z'),
    ];
    expect(dueJobs(jobs, T0).map((j) => j.id)).toEqual(['oldest', 'newer']);
  });

  it('due_at рівно зараз — уже прострочене', () => {
    expect(dueJobs([job('now', new Date(T0).toISOString())], T0)).toHaveLength(1);
  });
});

describe('nextAlarmMs', () => {
  it('мінімальний due_at серед задач', () => {
    const jobs = [job('a', '2026-08-26T10:10:00.000Z'), job('b', '2026-08-26T10:03:00.000Z')];
    expect(nextAlarmMs(jobs)).toBe(Date.parse('2026-08-26T10:03:00.000Z'));
  });

  it('без задач — null (alarm не потрібен)', () => {
    expect(nextAlarmMs([])).toBeNull();
  });
});

describe('advanceDueAt', () => {
  it('звичайний крок: наступна поява через period', () => {
    expect(advanceDueAt('2026-08-26T10:00:00.000Z', 5, T0)).toBe('2026-08-26T10:05:00.000Z');
  });

  it('пропущені появи не наздоганяються: після простою — одразу наступна', () => {
    // Задача мала з’являтись 10:00, 10:05, …, зараз 10:23 -> наступна 10:25,
    // а не черга з чотирьох пропущених.
    const now = Date.parse('2026-08-26T10:23:00.000Z');
    expect(advanceDueAt('2026-08-26T10:00:00.000Z', 5, now)).toBe('2026-08-26T10:25:00.000Z');
  });

  it('результат завжди в майбутньому відносно now', () => {
    const now = Date.parse('2026-08-27T03:17:42.000Z');
    const next = Date.parse(advanceDueAt('2026-08-26T10:00:00.000Z', 1440, now));
    expect(next).toBeGreaterThan(now);
  });
});

describe('occurrenceDedupeKey', () => {
  it('формат kind:дата:хвилина-доби (київські)', () => {
    // 10:00 UTC влітку = 13:00 Київ = хвилина 780.
    expect(occurrenceDedupeKey('heartbeat', '2026-08-26T10:00:00.000Z')).toBe(
      'heartbeat:2026-08-26:780',
    );
  });

  it('різні появи — різні ключі; та сама поява — той самий ключ', () => {
    const a = occurrenceDedupeKey('x', '2026-08-26T10:00:00.000Z');
    expect(occurrenceDedupeKey('x', '2026-08-26T10:00:00.000Z')).toBe(a);
    expect(occurrenceDedupeKey('x', '2026-08-26T10:05:00.000Z')).not.toBe(a);
  });
});

describe('shouldWatchdogTick', () => {
  it('alarm відсутній — тікати', () => {
    expect(shouldWatchdogTick(null, T0)).toBe(true);
  });

  it('alarm у майбутньому — не чіпати', () => {
    expect(shouldWatchdogTick(T0 + 60_000, T0)).toBe(false);
  });

  it('alarm запізнюється в межах грейсу — ще його тік', () => {
    expect(shouldWatchdogTick(T0 - WATCHDOG_GRACE_MS + 1_000, T0)).toBe(false);
  });

  it('alarm прострочений понад грейс — рятувати', () => {
    expect(shouldWatchdogTick(T0 - WATCHDOG_GRACE_MS - 1_000, T0)).toBe(true);
  });
});

describe('джитер', () => {
  it('вибірка тримає стелю: старі витісняються, нові в кінці', () => {
    let samples: number[] = [];
    for (let i = 0; i < 10; i += 1) samples = recordJitterSample(samples, i, 4);
    expect(samples).toEqual([6, 7, 8, 9]);
  });

  it('статистика: min/avg/p95/max', () => {
    const s = jitterStats([100, 200, 300, 400, 1000]);
    expect(s).toEqual({ count: 5, minMs: 100, avgMs: 400, p95Ms: 1000, maxMs: 1000 });
  });

  it('порожня вибірка — null, а не нулі (нема даних ≠ нульовий джитер)', () => {
    expect(jitterStats([])).toBeNull();
  });
});
