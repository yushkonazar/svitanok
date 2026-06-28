import { describe, it, expect } from 'vitest';
import { decideSend } from '../src/core/guard-core.mjs';

// Базові параметри для бойового вікна [8, 12) — для перевірки меж.
const base = {
  sendHour: 8,
  sendWindowHours: 4,
  todayKey: '2026-06-29',
  lastSentDate: null as string | null,
};

describe('decideSend — вікно [sendHour, sendHour+sendWindowHours)', () => {
  it('усередині вікна — шле', () => {
    expect(decideSend({ ...base, kyivHour: 9 }).send).toBe(true);
  });

  it('нижня межа включна (kyivHour == sendHour) — шле (ловить спізнення cron)', () => {
    expect(decideSend({ ...base, kyivHour: 8 }).send).toBe(true);
  });

  it('остання година вікна (upper-1) — шле', () => {
    expect(decideSend({ ...base, kyivHour: 11 }).send).toBe(true);
  });

  it('до вікна — скіпає', () => {
    expect(decideSend({ ...base, kyivHour: 7 }).send).toBe(false);
  });

  it('верхня межа НЕВКЛЮЧНА (kyivHour == upper) — скіпає (не шле опівдні)', () => {
    expect(decideSend({ ...base, kyivHour: 12 }).send).toBe(false);
  });

  it('значно після вікна — скіпає', () => {
    expect(decideSend({ ...base, kyivHour: 23 }).send).toBe(false);
  });
});

describe('decideSend — тестовий період [1, 23)', () => {
  const test = { sendHour: 1, sendWindowHours: 22, todayKey: '2026-06-29', lastSentDate: null };

  it('01:00 — шле (нижня межа)', () => {
    expect(decideSend({ ...test, kyivHour: 1 }).send).toBe(true);
  });

  it('22:00 — шле (остання година)', () => {
    expect(decideSend({ ...test, kyivHour: 22 }).send).toBe(true);
  });

  it('23:00 — скіпає (верхня межа невключна)', () => {
    expect(decideSend({ ...test, kyivHour: 23 }).send).toBe(false);
  });

  it('00:00 — скіпає (до вікна)', () => {
    expect(decideSend({ ...test, kyivHour: 0 }).send).toBe(false);
  });
});

describe('decideSend — ідемпотентність', () => {
  it('сьогодні вже слали — скіпає навіть усередині вікна', () => {
    expect(decideSend({ ...base, kyivHour: 9, lastSentDate: '2026-06-29' }).send).toBe(false);
  });

  it('слали вчора — шле сьогодні', () => {
    expect(decideSend({ ...base, kyivHour: 9, lastSentDate: '2026-06-28' }).send).toBe(true);
  });
});

describe('decideSend — force (workflow_dispatch)', () => {
  it('обходить вікно', () => {
    expect(decideSend({ ...base, kyivHour: 3, force: true }).send).toBe(true);
  });

  it('обходить ідемпотентність', () => {
    expect(decideSend({ ...base, kyivHour: 3, lastSentDate: '2026-06-29', force: true }).send).toBe(
      true,
    );
  });
});
