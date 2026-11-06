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
  it('persists confirmation, never overwrites a confirmed slot, isolates calendar days and supports resetting the preview', async () => {
    await writeCheckinDemo({ slot: 'morning', energy: 4, confirmed: false });
    expect(readCheckinDemo()).toEqual({});
    await writeCheckinDemo({ slot: 'morning', energy: 4, confirmed: true, dateKey: '2026-10-04' });
    expect(readCheckinDemo().morning).toMatchObject({ energy: 4, confirmed: true });
    await writeCheckinDemo({ slot: 'morning', energy: 1, confirmed: true });
    expect(readCheckinDemo().morning?.energy).toBe(4);
    expect(readCheckinDemo('2026-10-05')).toEqual({});
    resetCheckinDemo();
    expect(readCheckinDemo()).toEqual({});
  });
  it('drops corrupt storage and rejects expired-date confirmations', async () => {
    localStorage.setItem('svitanok:confirmed-demo-checkins:2026-10-04', 'bad-json');
    expect(readCheckinDemo()).toEqual({});
    await writeCheckinDemo({ slot: 'afternoon', confirmed: true, dateKey: '2026-10-03' });
    expect(readCheckinDemo()).toEqual({});
  });
  it('confirms the new format with a real demo timestamp and preserves plan context', async () => {
    await expect(
      writeCheckinDemo({ slot: 'morning', questionVersion: 4, confirmed: true, energy: 3 }),
    ).rejects.toThrow('показані питання');
    await writeCheckinDemo({
      slot: 'morning',
      questionVersion: 4,
      confirmed: true,
      sleepModeV4: 'none',
      energy: 3,
      mood: 4,
      priorityV4: 'course',
      priorityStepV4: 'Другий урок',
    });
    expect(readCheckinDemo().morning?.confirmedAtV3).toBe('2026-10-04T09:00:00.000Z');
    await writeCheckinDemo({
      slot: 'afternoon',
      questionVersion: 4,
      confirmed: true,
      energy: 2,
      mood: 3,
      priorityPaceV4: 'changed',
      newPriorityV4: 'Прогулятися',
    });
    expect(readCheckinDemo().afternoon?.newPriorityV4).toBe('Прогулятися');
    await writeCheckinDemo({
      slot: 'evening',
      questionVersion: 4,
      confirmed: true,
      energy: 3,
      mood: 4,
      priorityOutcomeV4: 'finished',
      developmentActualV4: ['none'],
      freeTimeV4: '60_119',
      napV4: 'unknown',
      satisfactionV4: 4,
    });
    expect(readCheckinDemo().evening?.planTextV4).toBe('Прогулятися');
  });
});
