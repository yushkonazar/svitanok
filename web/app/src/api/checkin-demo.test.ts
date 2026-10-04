import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readCheckinDemo, writeCheckinDemo, resetCheckinDemo } from './checkin-demo.ts';
describe('confirmed local check-in preview', () => {
  beforeEach(() => {
    const saved = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => saved.set(key, value),
      removeItem: (key: string) => saved.delete(key),
      clear: () => saved.clear(),
    });
    localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-04T09:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
    vi.unstubAllGlobals();
  });
  it('persists confirmation, never overwrites a confirmed slot, isolates calendar days and supports resetting the preview', () => {
    writeCheckinDemo({ slot: 'morning', energy: 4, confirmed: false });
    expect(readCheckinDemo()).toEqual({});
    writeCheckinDemo({ slot: 'morning', energy: 4, confirmed: true, dateKey: '2026-10-04' });
    expect(readCheckinDemo().morning).toMatchObject({ energy: 4, confirmed: true });
    writeCheckinDemo({ slot: 'morning', energy: 1, confirmed: true });
    expect(readCheckinDemo().morning?.energy).toBe(4);
    expect(readCheckinDemo('2026-10-05')).toEqual({});
    resetCheckinDemo();
    expect(readCheckinDemo()).toEqual({});
  });
  it('drops corrupt storage and rejects expired-date confirmations', () => {
    localStorage.setItem('svitanok:confirmed-demo-checkins:2026-10-04', 'bad-json');
    expect(readCheckinDemo()).toEqual({});
    writeCheckinDemo({ slot: 'afternoon', confirmed: true, dateKey: '2026-10-03' });
    expect(readCheckinDemo()).toEqual({});
  });
});
