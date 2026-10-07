import { describe, expect, it } from 'vitest';
import {
  requireClockRangeQuestions,
  applyNamedWorkClocks,
  exactAnswerClock,
  plannedRoute,
  requestsRouteCheck,
} from '../web/core/day-plan/clarifications.mjs';

describe('day-plan deterministic clarifications', () => {
  it('asks about explicit bare clock ranges rather than accepting model guesses', () => {
    const items = [
      { title: 'Прокинутися', kind: 'moment', hard_at: '08:00' },
      { title: 'Робота', role: 'work', hard_at: '09:00', hard_end: '16:00' },
    ];
    const questions = requireClockRangeQuestions(
      items,
      'Прокинутись о 8-9, працювати до 3-4, в 5 виїхати зі Львова до Немович.',
      [],
    );
    expect(questions).toEqual([
      {
        item: 0,
        field: 'hard_at',
        q: 'О котрій запланувати пробудження?',
        options: ['08:00', '09:00'],
      },
      {
        item: 1,
        field: 'hard_end',
        q: 'До котрої запланувати роботу?',
        options: ['15:00', '16:00'],
      },
      {
        item: 1,
        field: 'hard_at',
        q: 'О котрій починаєш роботу?',
        options: ['09:00', '10:00', 'не знаю'],
      },
    ]);
    expect(items[0]?.hard_at).toBeNull();
    expect(items[1]?.hard_end).toBeNull();
  });

  it('updates two explicitly named clocks, but never chooses a range endpoint', () => {
    const items = [
      { title: 'Робота', role: 'work', hard_at: null, hard_end: null, flexible: true },
    ];
    expect([...applyNamedWorkClocks(items, 'Починаю о 9-10, закінчую о 15-16')]).toEqual([]);
    expect([...applyNamedWorkClocks(items, 'Починаю о 9, закінчую о 16')]).toEqual([
      '0:hard_at',
      '0:hard_end',
    ]);
    expect(items[0]).toMatchObject({ hard_at: '09:00', hard_end: '16:00', flexible: false });
  });

  it('does not overwrite multiple work segments with one ambiguous answer', () => {
    const items = [
      { title: 'Робота', role: 'work' },
      { title: 'Робота після перерви', role: 'work' },
    ];
    expect([...applyNamedWorkClocks(items, 'Починаю о 9, закінчую о 16')]).toEqual([]);
  });

  it.each(['9-10', '09:00–10:00', '25:00', '09:00 і 16:00'])(
    'rejects uncertain/invalid answer %s',
    (text) => {
      expect(exactAnswerClock(text)).toBeNull();
    },
  );
  it.each([
    ['9', '09:00'],
    ['о 16', '16:00'],
    ['Починаю о 09:15', '09:15'],
  ])('accepts an exact clock %s', (text, expected) => {
    expect(exactAnswerClock(text)).toBe(expected);
  });

  it('keeps explicit endpoints but requires a transport choice', () => {
    expect(plannedRoute('О 17 виїхати зі Львова до Немович.')).toEqual({
      from: 'Львова',
      to: 'Немович',
      mode: null,
    });
    expect(plannedRoute('Авто, виїзд зі Львова до Немович.')).toMatchObject({ mode: 'car' });
    expect(plannedRoute('Їду додому')).toBeNull();
    expect(requestsRouteCheck('Починаю о 9-10. Скільки їхати глянь сам')).toBe(true);
    expect(requestsRouteCheck('Починаю о 9')).toBe(false);
  });
});
