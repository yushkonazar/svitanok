import { describe, it, expect } from 'vitest';
import { pluralUk } from '../web/app/src/lib/plural.ts';
import { timeAgo } from '../web/app/src/lib/timeAgo.ts';
import { pluralizeNova } from '../web/app/src/components/news/pluralize.ts';
import { pluralizePytannya } from '../web/app/src/components/checkin/questions.ts';

/* F7 (аудит C2, high): українські плюрали були неправильні для ≥5 — «5 дні»
 * замість «5 днів», «5 рази» замість «5 разів». Найприкріше, що правило в коді
 * вже було: чотири копії однакової mod10/mod100-логіки для окремих слів, а два
 * місця його просто не застосували.
 *
 * Тепер правило одне (pluralUk), а слова — тонкі обгортки над ним. Тест б'є по
 * тих числах, на яких помилка й вилазить: 5-20 (усі «багато»), 11-14 (пастка:
 * закінчуються на 1-4, але «багато»), 21/22 (знову «один»/«кілька»).
 *
 * Покриття тут кореневим vitest — у web/app немає власного раннера (див.
 * dashboard-schema.test.ts). */

describe('pluralUk — правило одне на всі слова', () => {
  const форми: [number, string][] = [
    [1, 'день'],
    [2, 'дні'],
    [3, 'дні'],
    [4, 'дні'],
    [5, 'днів'],
    [10, 'днів'],
    [11, 'днів'], // ⚠️ пастка: 11 закінчується на 1, але це «багато»
    [12, 'днів'],
    [13, 'днів'],
    [14, 'днів'],
    [21, 'день'],
    [22, 'дні'],
    [25, 'днів'],
    [101, 'день'],
    [111, 'днів'],
  ];

  it.each(форми)('%i -> %s', (n, expected) => {
    expect(pluralUk(n, ['день', 'дні', 'днів'])).toBe(expected);
  });

  it('нуль — форма «багато» (0 днів, не 0 день)', () => {
    expect(pluralUk(0, ['день', 'дні', 'днів'])).toBe('днів');
  });
});

describe('timeAgo — «5 днів», а не «5 дні» (F7)', () => {
  const now = new Date('2026-08-12T12:00:00Z');
  const agoDays = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();

  it('≥5 днів дає «днів»', () => {
    expect(timeAgo(agoDays(5), now)).toBe('5 днів');
    expect(timeAgo(agoDays(11), now)).toBe('11 днів');
  });

  it('2-4 дні лишаються «дні», один день — «вчора»', () => {
    expect(timeAgo(agoDays(3), now)).toBe('3 дні');
    expect(timeAgo(agoDays(1), now)).toBe('вчора');
  });

  it('дрібніші проміжки не змінились', () => {
    // «щойно» — це <30с: діапазон округлюється до хвилин (30с уже дає «1 хв»).
    expect(timeAgo(new Date(now.getTime() - 10_000).toISOString(), now)).toBe('щойно');
    expect(timeAgo(new Date(now.getTime() - 5 * 60_000).toISOString(), now)).toBe('5 хв');
    expect(timeAgo(new Date(now.getTime() - 3 * 3_600_000).toISOString(), now)).toBe('3 год');
    expect(timeAgo(undefined, now)).toBeNull();
    expect(timeAgo('не дата', now)).toBeNull();
  });
});

describe('слова-обгортки лишились сумісними (жодних змін у виводі)', () => {
  it('pluralizeNova', () => {
    expect([1, 2, 5, 11, 21].map(pluralizeNova)).toEqual([
      'нова',
      'нові',
      'нових',
      'нових',
      'нова',
    ]);
  });

  it('pluralizePytannya (2-4 і 1 збігаються — так в українській)', () => {
    expect([1, 2, 5, 11, 21].map(pluralizePytannya)).toEqual([
      'питання',
      'питання',
      'питань',
      'питань',
      'питання',
    ]);
  });
});
