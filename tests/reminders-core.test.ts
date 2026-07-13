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
  cancelReminder,
  listActive,
  REMINDER_CANCEL_CB_PREFIX,
  buildReminderCancelCallbackData,
  parseReminderCancelCallbackData,
  formatRemindersListMessage,
  buildRemindersKeyboard,
  formatReminderConfirm,
  formatReminderFired,
  LLM_REWRITE_SCHEMA,
  buildLlmRewriteSystemPrompt,
  extractLlmRewrite,
  isAmbiguousRewrite,
  addDaysToDateKey,
} = rem;

// Літо (EEST, UTC+3): 2026-07-10 11:00 Київ.
const SUMMER_NOW = Date.parse('2026-07-10T08:00:00Z');
// Зима (EET, UTC+2): 2026-01-10 11:00 Київ.
const WINTER_NOW = Date.parse('2026-01-10T09:00:00Z');

describe('addDaysToDateKey — чиста Y-M-D арифметика (Блок P2b, worker.js:runAssistantAgent)', () => {
  it('звичайний зсув і зсув через межу місяця', () => {
    expect(addDaysToDateKey('2026-07-10', 1)).toBe('2026-07-11');
    expect(addDaysToDateKey('2026-07-31', 1)).toBe('2026-08-01');
  });

  it('через весняний DST-перехід (2026-03-29) — усе одно точна календарна дата', () => {
    // Раніше worker.js рахував "завтра" через +86_400_000мс на інстант — це
    // ламалось саме тут (запит пізно ввечері 28.03 стрибав одразу на 30.03,
    // бо +1год DST-переходу комбінувалась зі зсувом доби). addDaysToDateKey
    // рахує лише Y-M-D, тому інстант/офсет тут узагалі не задіяні.
    expect(addDaysToDateKey('2026-03-28', 1)).toBe('2026-03-29');
    expect(addDaysToDateKey('2026-03-29', 1)).toBe('2026-03-30');
  });
});

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

describe('reminders-core — cancelReminder/listActive (§C4: /reminders список+скасувати)', () => {
  it('cancelReminder видаляє назавжди (не лишає сліду, на відміну від markFired)', () => {
    let reminders = addReminder([], { id: 'r1', text: 'X', whenMs: SUMMER_NOW, nowMs: SUMMER_NOW });
    reminders = addReminder(reminders, {
      id: 'r2',
      text: 'Y',
      whenMs: SUMMER_NOW + 1000,
      nowMs: SUMMER_NOW,
    });
    reminders = cancelReminder(reminders, 'r1');
    expect(reminders).toHaveLength(1);
    expect(reminders[0].id).toBe('r2');
  });

  it('cancelReminder: невідомий id — no-op', () => {
    const reminders = addReminder([], {
      id: 'r1',
      text: 'X',
      whenMs: SUMMER_NOW,
      nowMs: SUMMER_NOW,
    });
    expect(cancelReminder(reminders, 'ghost')).toEqual(reminders);
  });

  it('listActive: лише !firedTs, за зростанням whenMs; fired виключено', () => {
    let reminders = addReminder([], {
      id: 'later',
      text: 'B',
      whenMs: SUMMER_NOW + 2000,
      nowMs: SUMMER_NOW,
    });
    reminders = addReminder(reminders, {
      id: 'sooner',
      text: 'A',
      whenMs: SUMMER_NOW + 1000,
      nowMs: SUMMER_NOW,
    });
    reminders = addReminder(reminders, {
      id: 'gone',
      text: 'C',
      whenMs: SUMMER_NOW,
      nowMs: SUMMER_NOW,
    });
    reminders = markFired(reminders, 'gone', SUMMER_NOW);
    const active = listActive(reminders);
    expect(active.map((r: { id: string }) => r.id)).toEqual(['sooner', 'later']);
  });

  it('listActive: порожній стор -> []', () => {
    expect(listActive([])).toEqual([]);
    expect(listActive(undefined)).toEqual([]);
  });
});

describe('reminders-core — rc: callback_data (скасувати нагадування, §C4)', () => {
  it('build+parse round-trip', () => {
    const cb = buildReminderCancelCallbackData('abc-123');
    expect(cb).toBe('rc:abc-123');
    expect(parseReminderCancelCallbackData(cb)).toBe('abc-123');
  });

  it('не той префікс/порожній id/не-рядок -> null', () => {
    expect(parseReminderCancelCallbackData('rm:abc-123')).toBeNull();
    expect(parseReminderCancelCallbackData('rc:')).toBeNull();
    expect(parseReminderCancelCallbackData(undefined)).toBeNull();
  });

  it('64-байтовий ліміт (кирилиця=2 байти) — надто довгий id -> null', () => {
    expect(buildReminderCancelCallbackData('я'.repeat(35))).toBeNull(); // rc: + 70 байт > 64
    expect(buildReminderCancelCallbackData('a'.repeat(61))).toBe(
      `${REMINDER_CANCEL_CB_PREFIX}${'a'.repeat(61)}`,
    ); // рівно 64
    expect(buildReminderCancelCallbackData('a'.repeat(62))).toBeNull(); // 65 > 64
  });
});

describe('reminders-core — formatRemindersListMessage/buildRemindersKeyboard (§C4)', () => {
  it('порожньо -> заглушка, без кнопок', () => {
    expect(formatRemindersListMessage([])).toContain('Активних нагадувань немає');
    expect(buildRemindersKeyboard([]).inline_keyboard).toEqual([]);
  });

  it('нумерація списку відповідає нумерації кнопок скасування (той самий порядок — найближче спершу)', () => {
    let reminders = addReminder([], {
      id: 'later',
      text: 'Друге',
      whenMs: SUMMER_NOW + 2000,
      nowMs: SUMMER_NOW,
    });
    reminders = addReminder(reminders, {
      id: 'sooner',
      text: 'Перше',
      whenMs: SUMMER_NOW + 1000,
      nowMs: SUMMER_NOW,
    });
    const msg = formatRemindersListMessage(reminders);
    expect(msg.indexOf('Перше')).toBeLessThan(msg.indexOf('Друге'));
    expect(msg).toContain('1. ');
    expect(msg).toContain('2. ');

    const kb = buildRemindersKeyboard(reminders);
    expect(kb.inline_keyboard).toHaveLength(2);
    expect(kb.inline_keyboard[0][0].text).toBe('❌ Скасувати 1');
    expect(kb.inline_keyboard[0][0].callback_data).toBe(buildReminderCancelCallbackData('sooner'));
    expect(kb.inline_keyboard[1][0].text).toBe('❌ Скасувати 2');
  });

  it('HTML-екранує текст нагадування', () => {
    const reminders = addReminder([], {
      id: 'r1',
      text: '<b>зле</b>',
      whenMs: SUMMER_NOW,
      nowMs: SUMMER_NOW,
    });
    expect(formatRemindersListMessage(reminders)).toContain('&lt;b&gt;зле&lt;/b&gt;');
  });

  it('спрацьовані (fired) не показуються ні в списку, ні в клавіатурі', () => {
    let reminders = addReminder([], { id: 'r1', text: 'X', whenMs: SUMMER_NOW, nowMs: SUMMER_NOW });
    reminders = markFired(reminders, 'r1', SUMMER_NOW);
    expect(formatRemindersListMessage(reminders)).toContain('Активних нагадувань немає');
    expect(buildRemindersKeyboard(reminders).inline_keyboard).toEqual([]);
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

describe('reminders-core — LLM-фолбек: buildLlmRewriteSystemPrompt/extractLlmRewrite', () => {
  it('buildLlmRewriteSystemPrompt — містить поточний київський час і канонічні приклади', () => {
    const prompt = buildLlmRewriteSystemPrompt(SUMMER_NOW);
    expect(prompt).toContain('через 20 хвилин');
    expect(prompt).toContain('завтра о 9:30');
    expect(prompt).toContain('2026');
    expect(prompt).toContain('unclear');
  });

  it('extractLlmRewrite — валідний рядок проходить, порожній/відсутній/чужий тип -> null', () => {
    expect(extractLlmRewrite({ rewritten: 'о 15:00 подзвонити' })).toBe('о 15:00 подзвонити');
    expect(extractLlmRewrite({ rewritten: '  о 15:00 подзвонити  ' })).toBe('о 15:00 подзвонити');
    expect(extractLlmRewrite({ rewritten: '' })).toBeNull();
    expect(extractLlmRewrite({ rewritten: '   ' })).toBeNull();
    expect(extractLlmRewrite({ error: 'unclear' })).toBeNull();
    expect(extractLlmRewrite({ rewritten: 42 })).toBeNull();
    expect(extractLlmRewrite(null)).toBeNull();
    expect(extractLlmRewrite(undefined)).toBeNull();
  });

  it('LLM_REWRITE_SCHEMA — валідна JSON Schema форма', () => {
    expect(LLM_REWRITE_SCHEMA.type).toBe('object');
    expect(LLM_REWRITE_SCHEMA.properties).toHaveProperty('rewritten');
    expect(LLM_REWRITE_SCHEMA.properties).toHaveProperty('error');
  });

  it('інтеграційний контракт: rewritten із канонічного прикладу -> parseReminderTime його розуміє', () => {
    // Симулює повний ланцюг: LLM переписує "в обід" -> канонічний патерн ->
    // parseReminderTime (вже перевірений іншими тестами) парсить БЕЗ змін.
    const rewritten = extractLlmRewrite({ rewritten: 'о 13:00 забрати посилку' });
    expect(parseReminderTime(rewritten!, SUMMER_NOW)).toEqual({
      whenMs: Date.parse('2026-07-10T10:00:00Z'), // 13:00-3 (літо)
      remainder: 'забрати посилку',
    });
  });
});

describe('reminders-core — isAmbiguousRewrite (захист від ненадійного LLM-rewrite)', () => {
  it('РЕГРЕС: живий збій — модель лишила "ввечері" не конвертованим у 24-год формат', () => {
    // Реальний інцидент: rewritten="о 8:00 ввечері полити квіти" (мало бути
    // "о 20:00 полити квіти") -> без guard'а parseReminderTime тихо ставив
    // нагадування на 08:00 замість 20:00. isAmbiguousRewrite мусить це впіймати.
    expect(isAmbiguousRewrite('о 8:00 ввечері полити квіти')).toBe(true);
  });

  it('усі слова частини доби, які rewrite мав усунути', () => {
    for (const word of [
      'вранці',
      'зранку',
      'вдень',
      'ввечері',
      'вночі',
      'опівдні',
      'опівночі',
      'в обід',
    ]) {
      expect(isAmbiguousRewrite(`о 10:00 ${word} щось зробити`)).toBe(true);
    }
  });

  it('коректний rewrite (частина доби вже конвертована в годину) -> не спрацьовує', () => {
    expect(isAmbiguousRewrite('завтра о 20:00 полити квіти')).toBe(false);
    expect(isAmbiguousRewrite('через 20 хвилин зробити паузу')).toBe(false);
    expect(isAmbiguousRewrite('о 13:00 забрати посилку')).toBe(false);
  });

  it('інтеграція: tryLlmReminderRewrite-подібний потік — ambiguous rewrite відхиляється до parseReminderTime', () => {
    const badRewrite = 'о 8:00 ввечері полити квіти';
    // Симулює логіку worker.js: перевірка ambiguous ПЕРЕД parseReminderTime.
    const accepted = isAmbiguousRewrite(badRewrite)
      ? null
      : parseReminderTime(badRewrite, SUMMER_NOW);
    expect(accepted).toBeNull();
  });
});
