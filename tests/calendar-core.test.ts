import { describe, it, expect } from 'vitest';
// @ts-expect-error — JS-модуль Worker'а без типів (namespace-імпорт).
import * as cal from '../web/calendar-core.mjs';
const { kyivDayBoundsUtc, parseEvents, buildCreateEventBody, formatEventsForPrompt } = cal;

describe('kyivDayBoundsUtc — DST межі дня (той самий трюк, що src/modules/calendar.ts)', () => {
  it('літо (Київ +3): межі зсунуті на 3 години', () => {
    const { timeMin, timeMax } = kyivDayBoundsUtc('2026-07-01');
    expect(timeMin).toBe('2026-06-30T21:00:00.000Z');
    expect(timeMax).toBe('2026-07-01T21:00:00.000Z');
  });

  it('зима (Київ +2): межі зсунуті на 2 години (НЕ хардкод +03:00)', () => {
    const { timeMin, timeMax } = kyivDayBoundsUtc('2026-01-01');
    expect(timeMin).toBe('2025-12-31T22:00:00.000Z');
    expect(timeMax).toBe('2026-01-01T22:00:00.000Z');
  });
});

describe('parseEvents', () => {
  it('подія з часом і id -> HH:MM Київ; без назви -> заглушка', () => {
    const evs = parseEvents({
      items: [
        { id: 'ev1', summary: 'Зустріч', start: { dateTime: '2026-07-01T09:30:00Z' } },
        { start: { date: '2026-07-01' } },
      ],
    });
    expect(evs[0]).toEqual({ id: 'ev1', title: 'Зустріч', time: '12:30' });
    expect(evs[1]).toEqual({ id: null, title: '(без назви)', time: null });
  });

  it('некоректний json -> []', () => {
    expect(parseEvents({})).toEqual([]);
    expect(parseEvents(null)).toEqual([]);
  });
});

describe('buildCreateEventBody', () => {
  it('будує тіло events.insert з Europe/Kyiv timeZone', () => {
    expect(
      buildCreateEventBody({
        title: 'Стоматолог',
        startIso: '2026-07-02T15:00:00+03:00',
        endIso: '2026-07-02T16:00:00+03:00',
      }),
    ).toEqual({
      summary: 'Стоматолог',
      start: { dateTime: '2026-07-02T15:00:00+03:00', timeZone: 'Europe/Kyiv' },
      end: { dateTime: '2026-07-02T16:00:00+03:00', timeZone: 'Europe/Kyiv' },
    });
  });
});

describe('formatEventsForPrompt', () => {
  it('порожньо -> "подій немає"', () => {
    expect(formatEventsForPrompt([])).toBe('подій немає');
    expect(formatEventsForPrompt(null)).toBe('подій немає');
  });

  it('з часом і на весь день -> компактний рядок через "; "', () => {
    expect(
      formatEventsForPrompt([
        { title: 'Стендап', time: '09:00' },
        { title: 'Відпустка', time: null },
      ]),
    ).toBe('09:00 Стендап; увесь день: Відпустка');
  });
});
