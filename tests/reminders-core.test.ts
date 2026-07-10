import { describe, it, expect } from 'vitest';
// @ts-expect-error — JS-модуль Worker'а без типів (namespace-імпорт).
import * as rem from '../web/reminders-core.mjs';
const {
  SNOOZE_MINUTES,
  parseReminderTime,
  addReminder,
  dueReminders,
  markFired,
  snoozeReminder,
  formatReminderConfirm,
  formatReminderFired,
} = rem;

// Літо (EEST, UTC+3): 2026-07-10 11:00 Київ.
const SUMMER_NOW = Date.parse('2026-07-10T08:00:00Z');
// Зима (EET, UTC+2): 2026-01-10 11:00 Київ.
const WINTER_NOW = Date.parse('2026-01-10T09:00:00Z');

describe('reminders-core — parseReminderTime: відносний час', () => {
  it('"через N хв/хвилин/хвилину" — усі відмінки', () => {
    expect(parseReminderTime('через 20 хвилин зробити паузу', SUMMER_NOW)).toEqual({
      whenMs: SUMMER_NOW + 20 * 60_000,
      remainder: 'зробити паузу',
    });
    expect(parseReminderTime('через 1 хвилину', SUMMER_NOW).whenMs).toBe(SUMMER_NOW + 60_000);
    expect(parseReminderTime('через 5 хв', SUMMER_NOW).whenMs).toBe(SUMMER_NOW + 5 * 60_000);
  });

  it('"через N год/годин/години" — DST-незалежно (відносний зсув)', () => {
    expect(parseReminderTime('через 2 години подзвонити', SUMMER_NOW)).toEqual({
      whenMs: SUMMER_NOW + 2 * 3_600_000,
      remainder: 'подзвонити',
    });
    expect(parseReminderTime('через 1 год', WINTER_NOW).whenMs).toBe(WINTER_NOW + 3_600_000);
  });

  it('через 0 хвилин -> невалідно (не запланувати в минуле/зараз)', () => {
    expect(parseReminderTime('через 0 хвилин щось', SUMMER_NOW)).toBeNull();
  });
});

describe('reminders-core — parseReminderTime: завтра/сьогодні о HH[:MM]', () => {
  it('"завтра о HH:MM" — DST літо і зима дають правильний UTC', () => {
    // Літо: завтра (2026-07-11) 09:30 Київ (UTC+3) -> 06:30 UTC.
    expect(parseReminderTime('завтра о 9:30 подати резюме', SUMMER_NOW)).toEqual({
      whenMs: Date.parse('2026-07-11T06:30:00Z'),
      remainder: 'подати резюме',
    });
    // Зима: завтра (2026-01-11) 09:30 Київ (UTC+2) -> 07:30 UTC.
    expect(parseReminderTime('завтра о 9:30', WINTER_NOW).whenMs).toBe(
      Date.parse('2026-01-11T07:30:00Z'),
    );
  });

  it('"сьогодні о HH" у майбутньому — сьогодні; у минулому — null', () => {
    // SUMMER_NOW = 11:00 Київ.
    expect(parseReminderTime('сьогодні о 15:00 зустріч', SUMMER_NOW)).toEqual({
      whenMs: Date.parse('2026-07-10T12:00:00Z'), // 15:00-3
      remainder: 'зустріч',
    });
    expect(parseReminderTime('сьогодні о 9:00', SUMMER_NOW)).toBeNull(); // вже минуло
  });

  it('невалідна година/хвилина ("завтра о 25:99") -> null', () => {
    expect(parseReminderTime('завтра о 25:99', SUMMER_NOW)).toBeNull();
  });
});

describe('reminders-core — parseReminderTime: голе "о HH[:MM]"', () => {
  it('у майбутньому сьогодні -> сьогодні; у минулому -> завтра', () => {
    // SUMMER_NOW = 11:00 Київ.
    expect(parseReminderTime('нагадай подзвонити о 18', SUMMER_NOW)).toEqual({
      whenMs: Date.parse('2026-07-10T15:00:00Z'), // 18:00-3
      remainder: 'подзвонити',
    });
    expect(parseReminderTime('о 8 ранкова кава', SUMMER_NOW)).toEqual({
      whenMs: Date.parse('2026-07-11T05:00:00Z'), // завтра 8:00-3
      remainder: 'ранкова кава',
    });
  });

  it('тригер-фраза "нагадай(ти/уй) [мені] [про]" знімається з початку', () => {
    expect(parseReminderTime('нагадай мені про через 10 хв випити води', SUMMER_NOW)).toEqual({
      whenMs: SUMMER_NOW + 10 * 60_000,
      remainder: 'випити води',
    });
    expect(parseReminderTime('нагадати через 10 хв', SUMMER_NOW).remainder).toBe('Нагадування');
  });

  it('без розпізнаного часу -> null', () => {
    expect(parseReminderTime('привіт, як справи?', SUMMER_NOW)).toBeNull();
    expect(parseReminderTime('', SUMMER_NOW)).toBeNull();
    expect(parseReminderTime(undefined, SUMMER_NOW)).toBeNull();
  });
});

describe('reminders-core — стор: addReminder/dueReminders/markFired/snoozeReminder', () => {
  it('повний цикл: додати -> ще не на видачу -> настав час -> видача -> fired -> не дублюється', () => {
    let reminders = addReminder([], {
      id: 'r1',
      text: 'X',
      whenMs: SUMMER_NOW + 60_000,
      nowMs: SUMMER_NOW,
    });
    expect(dueReminders(reminders, SUMMER_NOW)).toHaveLength(0);
    expect(dueReminders(reminders, SUMMER_NOW + 60_000)).toHaveLength(1);

    reminders = markFired(reminders, 'r1', SUMMER_NOW + 60_000);
    expect(dueReminders(reminders, SUMMER_NOW + 120_000)).toHaveLength(0); // вже fired

    // повторний markFired — ідемпотентно (firedTs не змінюється в null/undefined)
    const twice = markFired(reminders, 'r1', SUMMER_NOW + 999_000);
    expect(twice[0].firedTs).toBe(SUMMER_NOW + 60_000);
  });

  it('snoozeReminder — новий whenMs (+SNOOZE_MINUTES), firedTs скидається -> знову на видачу', () => {
    let reminders = addReminder([], { id: 'r2', text: 'Y', whenMs: SUMMER_NOW, nowMs: SUMMER_NOW });
    reminders = markFired(reminders, 'r2', SUMMER_NOW);
    reminders = snoozeReminder(reminders, 'r2', SUMMER_NOW);
    expect(reminders[0].firedTs).toBeNull();
    expect(reminders[0].whenMs).toBe(SUMMER_NOW + SNOOZE_MINUTES * 60_000);
    expect(dueReminders(reminders, SUMMER_NOW)).toHaveLength(0); // ще не настав новий час
    expect(dueReminders(reminders, reminders[0].whenMs)).toHaveLength(1);
  });

  it('невідомий id — no-op (не падає, не чіпає інші записи)', () => {
    const reminders = addReminder([], {
      id: 'r3',
      text: 'Z',
      whenMs: SUMMER_NOW,
      nowMs: SUMMER_NOW,
    });
    expect(markFired(reminders, 'ghost', SUMMER_NOW)).toEqual(reminders);
    expect(snoozeReminder(reminders, 'ghost', SUMMER_NOW)).toEqual(reminders);
  });
});

describe('reminders-core — форматери', () => {
  it('formatReminderConfirm — включає час і екранований текст', () => {
    const msg = formatReminderConfirm(Date.parse('2026-07-10T12:00:00Z'), '<script>x</script>');
    expect(msg).toContain('✅ Нагадаю');
    expect(msg).toContain('&lt;script&gt;');
  });

  it('formatReminderFired — HTML-екранує динамічний текст', () => {
    expect(formatReminderFired('<b>тест</b>')).toContain('&lt;b&gt;тест&lt;/b&gt;');
    expect(formatReminderFired('звичайний текст')).toContain('⏰ <b>Нагадування</b>');
  });
});
