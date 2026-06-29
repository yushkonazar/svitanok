import { describe, it, expect } from 'vitest';
import { createClock } from '../src/core/clock.js';

const at = (iso: string) => createClock(() => new Date(iso));

describe('clock — DST (Europe/Kyiv)', () => {
  it('літо: Київ = UTC+3 (EEST)', () => {
    // 05:30 UTC + 3 = 08:30 Kyiv
    const c = at('2026-07-01T05:30:00Z');
    expect(c.kyivHour()).toBe(8);
    expect(c.todayKey()).toBe('2026-07-01');
  });

  it('зима: Київ = UTC+2 (EET)', () => {
    // 05:30 UTC + 2 = 07:30 Kyiv
    const c = at('2026-01-01T05:30:00Z');
    expect(c.kyivHour()).toBe(7);
    expect(c.todayKey()).toBe('2026-01-01');
  });

  it('перетин півночі: todayKey за київською датою, не UTC', () => {
    // 21:30 UTC влітку = 00:30 наступної доби в Києві
    const c = at('2026-07-01T21:30:00Z');
    expect(c.kyivHour()).toBe(0);
    expect(c.todayKey()).toBe('2026-07-02');
  });
});

describe('clock — isSunday (за київською датою)', () => {
  it('2026-06-28 — неділя', () => {
    expect(at('2026-06-28T10:00:00Z').isSunday()).toBe(true);
  });

  it('2026-06-29 — понеділок', () => {
    expect(at('2026-06-29T10:00:00Z').isSunday()).toBe(false);
  });

  it('неділя визначається за київським днем, а не UTC', () => {
    // 22:30 UTC у суботу 2026-06-27 = 01:30 неділі 2026-06-28 у Києві
    const c = at('2026-06-27T22:30:00Z');
    expect(c.todayKey()).toBe('2026-06-28');
    expect(c.isSunday()).toBe(true);
  });
});

describe('clock — now() повертає інстант', () => {
  it('віддає переданий час без зсуву', () => {
    const d = new Date('2026-03-15T12:00:00Z');
    expect(at('2026-03-15T12:00:00Z').now().toISOString()).toBe(d.toISOString());
  });
});
