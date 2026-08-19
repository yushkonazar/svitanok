import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
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
  updateReminder,
  listActive,
  REMINDER_CANCEL_CB_PREFIX,
  buildReminderCancelCallbackData,
  parseReminderCancelCallbackData,
  REMINDER_EDIT_CB_PREFIX,
  buildReminderEditCallbackData,
  parseReminderEditCallbackData,
  REMINDER_DONE_CB_PREFIX,
  buildReminderDoneCallbackData,
  parseReminderDoneCallbackData,
  formatReminderDone,
  SNOOZE_PRESETS,
  snoozeReminderPreset,
  REMINDER_SNOOZE_CB_PREFIX,
  buildReminderSnoozeCallbackData,
  parseReminderSnoozeCallbackData,
  buildSnoozeRow,
  formatRemindersListMessage,
  buildRemindersKeyboard,
  formatReminderConfirm,
  formatReminderFired,
  LLM_REWRITE_SCHEMA,
  buildLlmRewriteSystemPrompt,
  extractLlmRewrite,
  isAmbiguousRewrite,
  addDaysToDateKey,
  classifyReminderIntent,
  DEFAULT_DATE_HOUR,
  CANONICAL_EXAMPLES,
  DAY_PART_RANGES,
  matchDayPartRange,
  findFreeHourInRange,
  pickDayPartSlot,
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

describe('reminders-core — parseReminderTime: календарна дата (B1)', () => {
  // Сценарій із fix.md: «Нагадай 24 липня скасувати підписку на канал webDev» ->
  // раніше глухе «🤔 Не зрозумів час» (патерну не було ні в парсері, ні серед
  // канонічних прикладів для LLM-рерайту).
  it('«24 липня» без часу -> 10:00 Київ того дня, залишок = текст нагадування', () => {
    const r = parseReminderTime('нагадай 24 липня скасувати підписку на канал webDev', SUMMER_NOW);
    expect(r.remainder).toBe('скасувати підписку на канал webDev');
    expect(new Date(r.whenMs).toISOString()).toBe('2026-07-24T07:00:00.000Z'); // 10:00 EEST
    expect(DEFAULT_DATE_HOUR).toBe(10);
  });

  it('«24 липня о 18:30» -> саме той час (а не «о 18:30» на сьогодні)', () => {
    const r = parseReminderTime('24 липня о 18:30 зустріч', SUMMER_NOW);
    expect(new Date(r.whenMs).toISOString()).toBe('2026-07-24T15:30:00.000Z');
    expect(r.remainder).toBe('зустріч');
  });

  it('числова форма «24.07» і «24.07.2027»', () => {
    expect(new Date(parseReminderTime('24.07 подзвонити', SUMMER_NOW).whenMs).toISOString()).toBe(
      '2026-07-24T07:00:00.000Z',
    );
    expect(new Date(parseReminderTime('24.07.2027 о 9:00', SUMMER_NOW).whenMs).toISOString()).toBe(
      '2027-07-24T06:00:00.000Z',
    );
  });

  it('зимова дата з літа -> DST-коректно (EET, UTC+2)', () => {
    // 3 січня вже минуло цього року -> котиться на наступний, і о 10:00 за EET.
    expect(new Date(parseReminderTime('3 січня подарунки', SUMMER_NOW).whenMs).toISOString()).toBe(
      '2027-01-03T08:00:00.000Z',
    );
  });

  it('дата без року, що вже минула -> наступний рік (і це видно в підтвердженні)', () => {
    const r = parseReminderTime('1 січня вітання', SUMMER_NOW); // SUMMER_NOW = липень
    expect(new Date(r.whenMs).getUTCFullYear()).toBe(2027);
    // formatReminderConfirm показує рік, коли він не поточний — інакше «01.01»
    // виглядало б як щось за пів року, а не за пів року НАСТУПНОГО.
    expect(formatReminderConfirm(r.whenMs, r.remainder, SUMMER_NOW)).toContain('2027');
    expect(
      formatReminderConfirm(parseReminderTime('24 липня x', SUMMER_NOW).whenMs, 'x', SUMMER_NOW),
    ).not.toContain('2026');
  });

  it('«через 1.5 години» НЕ читається як дата 1 травня (одноцифровий місяць не беремо)', () => {
    // Регресія-охоронець: NUM_DATE_RE вимагає двоцифровий місяць саме через це.
    expect(parseReminderTime('через 1.5 години кава', SUMMER_NOW)).toBeNull();
  });

  it('безглузда дата (31.02) -> null, не вгадуємо', () => {
    expect(parseReminderTime('31.02 щось', SUMMER_NOW)).toBeNull();
  });

  it('канонічні приклади для LLM містять календарну дату (інакше рерайт нікуди переписувати)', () => {
    expect(CANONICAL_EXAMPLES).toContain('24 липня');
  });

  // ── Регресії, знайдені змагальним ревʼю групи B ──────────────────────────
  it('«о 11.05» — це ЧАС 11:05, а не дата 11 травня (ревʼю B)', () => {
    // Європейський запис часу з крапкою не має ставати датою в майбутньому.
    const r = parseReminderTime('дзвінок о 11.05', SUMMER_NOW); // now = 11:00 -> 11:05 сьогодні
    expect(new Date(r.whenMs).toISOString()).toBe('2026-07-10T08:05:00.000Z'); // 11:05 EEST
    expect(r.remainder).toBe('дзвінок');
    expect(parseReminderTime('зустріч о 9.12', SUMMER_NOW).whenMs).toBe(
      Date.parse('2026-07-11T06:12:00Z'), // 9:12 вже минуло -> завтра
    );
  });

  it('звичайні іменники зі стемом місяця НЕ стають датою (ревʼю B: квітів/трав)', () => {
    // «купити 5 квітів» не має ставати 5 квітня. Немає ні дати, ні часу -> null.
    expect(parseReminderTime('нагадай купити 5 квітів', SUMMER_NOW)).toBeNull();
    expect(parseReminderTime('скосити 5 трав', SUMMER_NOW)).toBeNull();
    expect(parseReminderTime('полити 3 квітки', SUMMER_NOW)).toBeNull();
    // А справжній місяць — усе ще працює.
    expect(parseReminderTime('5 квітня посадка', SUMMER_NOW)).not.toBeNull();
  });

  it('час не впритул до дати — усе одно застосовується (ревʼю B)', () => {
    // «24 липня подзвонити мамі о 15» -> 24.07 о 15:00, а не о 10:00 з «о 15» у тексті.
    const r = parseReminderTime('24 липня подзвонити мамі о 15', SUMMER_NOW);
    expect(new Date(r.whenMs).toISOString()).toBe('2026-07-24T12:00:00.000Z'); // 15:00 EEST
    expect(r.remainder).toBe('подзвонити мамі');
  });

  it('«завтра» не впритул до часу — день усе одно завтра (ревʼю B)', () => {
    // «завтра підписати договір о 14» раніше ставало СЬОГОДНІ 14:00.
    const r = parseReminderTime('завтра підписати договір о 14', SUMMER_NOW);
    expect(new Date(r.whenMs).toISOString()).toBe('2026-07-11T11:00:00.000Z'); // завтра 14:00 EEST
    expect(r.remainder).toBe('підписати договір');
  });

  it('«29 лютого» знаходить найближчий високосний рік, а не null (ревʼю B)', () => {
    // З липня 2026: 2026 і 2027 невисокосні -> найближчий 29.02 це 2028.
    const r = parseReminderTime('29 лютого річниця', SUMMER_NOW);
    expect(new Date(r.whenMs).getUTCFullYear()).toBe(2028);
    expect(new Date(r.whenMs).toISOString().slice(5, 10)).toBe('02-29');
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

describe('reminders-core — matchDayPartRange (частини доби без явної години)', () => {
  it('розпізнає базові фрази -> правильний діапазон і remainder', () => {
    expect(matchDayPartRange('нагадай вранці зробити зарядку')).toEqual({
      label: 'вранці',
      startHour: 7,
      endHour: 10,
      matched: 'вранці',
      forcedDay: null,
      remainder: 'зробити зарядку',
    });
    expect(matchDayPartRange('нагадай в обід подзвонити мамі')).toMatchObject({
      label: 'в обід',
      startHour: 12,
      endHour: 14,
      remainder: 'подзвонити мамі',
    });
    expect(matchDayPartRange('нагадай ввечері полити квіти')).toMatchObject({
      label: 'ввечері',
      startHour: 18,
      endHour: 21,
    });
  });

  it('«після обіду» — ОКРЕМИЙ, пізніший діапазон від голого «в обід»', () => {
    const r = matchDayPartRange('нагадай після обіду зробити х');
    expect(r).toMatchObject({ label: 'після обіду', startHour: 14, endHour: 17 });
    expect(r.remainder).toBe('зробити х');
  });

  it('«обіду» (генітив, тільки в "після обіду") НЕ хибно ловиться голим "в обід"', () => {
    // Якби регекс "в обід" збігався тут, діапазон був би 12-14, не 14-17.
    expect(matchDayPartRange('нагадай після обіду щось')?.startHour).toBe(14);
  });

  it('явна година в тексті -> null (це вже шлях LLM-рерайту, не діапазон)', () => {
    expect(matchDayPartRange('нагадай ввечері о 20:00 щось')).toBeNull();
    expect(matchDayPartRange('нагадай о 8')).toBeNull();
  });

  it('"завтра"/"сьогодні" поруч -> forcedDay, знятий з remainder', () => {
    expect(matchDayPartRange('нагадай завтра вранці зробити зарядку')).toEqual({
      label: 'вранці',
      startHour: 7,
      endHour: 10,
      matched: 'вранці',
      forcedDay: 'tomorrow',
      remainder: 'зробити зарядку',
    });
    expect(matchDayPartRange('нагадай сьогодні в обід щось')?.forcedDay).toBe('today');
  });

  it('немає фрази частини доби -> null', () => {
    expect(matchDayPartRange('нагадай купити молоко')).toBeNull();
    expect(matchDayPartRange('')).toBeNull();
    expect(matchDayPartRange(undefined)).toBeNull();
  });

  it('DAY_PART_RANGES — усі діапазони валідні (start < end, 0-23)', () => {
    for (const part of DAY_PART_RANGES) {
      expect(part.startHour).toBeGreaterThanOrEqual(0);
      expect(part.endHour).toBeLessThanOrEqual(23);
      expect(part.startHour).toBeLessThan(part.endHour);
    }
  });
});

describe('reminders-core — findFreeHourInRange', () => {
  const DATE = '2026-07-10';

  it('немає подій -> перша година діапазону', () => {
    expect(findFreeHourInRange([], DATE, 12, 14, 0)).toBe(12);
  });

  it('перша година зайнята -> наступна вільна', () => {
    const busyAt12 = Date.parse('2026-07-10T09:00:00Z'); // 12:00 Київ (літо, +3)
    const events = [{ startMs: busyAt12, endMs: busyAt12 + 30 * 60_000 }];
    expect(findFreeHourInRange(events, DATE, 12, 14, 0)).toBe(13);
  });

  it('увесь діапазон зайнятий -> null', () => {
    const start = Date.parse('2026-07-10T09:00:00Z'); // 12:00 Київ
    const events = [{ startMs: start, endMs: start + 2 * 60 * 60_000 }]; // 12:00-14:00
    expect(findFreeHourInRange(events, DATE, 12, 14, 0)).toBeNull();
  });

  it('nowMs відсікає вже минулі години', () => {
    // Зараз 12:30 Київ -> година 12:00 уже минула, лишається 13.
    const now = Date.parse('2026-07-10T09:30:00Z');
    expect(findFreeHourInRange([], DATE, 12, 14, now)).toBe(13);
  });

  it('події без валідних startMs/endMs ігноруються (не валять перевірку)', () => {
    expect(findFreeHourInRange([{ startMs: NaN, endMs: NaN }, null, {}], DATE, 12, 13, 0)).toBe(12);
  });
});

describe('reminders-core — pickDayPartSlot', () => {
  it('сьогодні вільно -> обирає сьогодні', () => {
    const slot = pickDayPartSlot(
      [
        { dateKey: '2026-07-10', events: [], nowMs: 0, isToday: true },
        { dateKey: '2026-07-11', events: [], nowMs: 0, isToday: false },
      ],
      12,
      14,
    );
    expect(slot).toEqual({ dateKey: '2026-07-10', hour: 12, isToday: true });
  });

  it('сьогодні все зайнято -> перепадає на завтра', () => {
    const busyStart = Date.parse('2026-07-10T09:00:00Z'); // 12:00 Київ
    const todayEvents = [{ startMs: busyStart, endMs: busyStart + 2 * 60 * 60_000 }]; // 12-14 зайнято
    const slot = pickDayPartSlot(
      [
        { dateKey: '2026-07-10', events: todayEvents, nowMs: 0, isToday: true },
        { dateKey: '2026-07-11', events: [], nowMs: 0, isToday: false },
      ],
      12,
      14,
    );
    expect(slot).toEqual({ dateKey: '2026-07-11', hour: 12, isToday: false });
  });

  it('усі дні зайняті -> запасний варіант: startHour першого дня, де діапазон ще не минув', () => {
    const busyToday = Date.parse('2026-07-10T09:00:00Z');
    const todayEvents = [{ startMs: busyToday, endMs: busyToday + 2 * 60 * 60_000 }];
    const busyTomorrow = Date.parse('2026-07-11T09:00:00Z');
    const tomorrowEvents = [{ startMs: busyTomorrow, endMs: busyTomorrow + 2 * 60 * 60_000 }];
    const slot = pickDayPartSlot(
      [
        { dateKey: '2026-07-10', events: todayEvents, nowMs: 0, isToday: true },
        { dateKey: '2026-07-11', events: tomorrowEvents, nowMs: 0, isToday: false },
      ],
      12,
      14,
    );
    // Обидва дні "зайняті", але жоден technically не "минув" (nowMs=0) -> перший у списку.
    expect(slot).toEqual({ dateKey: '2026-07-10', hour: 12, isToday: true });
  });

  it('сьогоднішній діапазон уже минув (пізній вечір) -> фолбек одразу на завтра, не сьогодні', () => {
    // Зараз 22:00 Київ (10.07); діапазон 12-14 давно позаду, попри "вільні" (без подій) години.
    const now = Date.parse('2026-07-10T19:00:00Z');
    const busyTomorrowStart = Date.parse('2026-07-11T09:00:00Z'); // 12:00 Київ 11.07 — теж зайнято
    const tomorrowEvents = [
      { startMs: busyTomorrowStart, endMs: busyTomorrowStart + 2 * 60 * 60_000 },
    ];
    const slot = pickDayPartSlot(
      [
        { dateKey: '2026-07-10', events: [], nowMs: now, isToday: true },
        { dateKey: '2026-07-11', events: tomorrowEvents, nowMs: 0, isToday: false },
      ],
      12,
      14,
    );
    expect(slot.dateKey).toBe('2026-07-11');
  });

  it('один день у списку (forcedDay звузив вибір) — і той зайнятий -> все одно startHour цього дня', () => {
    const busyStart = Date.parse('2026-07-11T09:00:00Z');
    const events = [{ startMs: busyStart, endMs: busyStart + 2 * 60 * 60_000 }];
    const slot = pickDayPartSlot(
      [{ dateKey: '2026-07-11', events, nowMs: 0, isToday: false }],
      12,
      14,
    );
    expect(slot).toEqual({ dateKey: '2026-07-11', hour: 12, isToday: false });
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
    // ⚠️ ЛІТЕРАЛ, а не SNOOZE_MINUTES. Доти обидві сторони рівності брали ТУ
    // САМУ константу, тобто асерція трималась істинною за будь-якого її
    // значення: мутація 10 -> 11 лишала весь сюїт (1961 тест) зеленим, поки
    // callbacks.mjs жорстко обіцяв користувачеві «10 хв». Тепер зміна
    // константи ГАСИТЬ цей тест — і це навмисно: інтервал у тості й у
    // пресеті мусить переглянути людина, а не дізнатись про це користувач.
    expect(reminders[0].whenMs).toBe(SUMMER_NOW + 10 * 60_000);
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

describe('reminders-core — ru: callback_data (CRUD: «✏️ Редагувати» -> розмова)', () => {
  it('build+parse round-trip, окремий простір від rc:/rm:', () => {
    const cb = buildReminderEditCallbackData('abc-123');
    expect(cb).toBe('ru:abc-123');
    expect(parseReminderEditCallbackData(cb)).toBe('abc-123');
    expect(parseReminderEditCallbackData('rc:abc-123')).toBeNull();
  });

  it('не той префікс/порожній id -> null', () => {
    expect(parseReminderEditCallbackData(`${REMINDER_EDIT_CB_PREFIX}`)).toBeNull();
    expect(parseReminderEditCallbackData(undefined)).toBeNull();
  });
});

describe('reminders-core — rk: callback_data («✅ Виконано» на спрацьованому нагадуванні)', () => {
  it('build+parse round-trip, окремий простір від rc:/ru:/rs:/rm: (і від rd: — roadmap-core.mjs)', () => {
    const cb = buildReminderDoneCallbackData('abc-123');
    expect(cb).toBe('rk:abc-123');
    expect(parseReminderDoneCallbackData(cb)).toBe('abc-123');
    expect(parseReminderDoneCallbackData('rc:abc-123')).toBeNull();
    expect(parseReminderDoneCallbackData('rd:abc-123')).toBeNull(); // roadmap, не reminder
  });

  it('не той префікс/порожній id/не-рядок -> null', () => {
    expect(parseReminderDoneCallbackData(`${REMINDER_DONE_CB_PREFIX}`)).toBeNull();
    expect(parseReminderDoneCallbackData(undefined)).toBeNull();
  });

  it('64-байтовий ліміт — надто довгий id -> null', () => {
    expect(buildReminderDoneCallbackData('я'.repeat(35))).toBeNull(); // rk: + 70 байт > 64
    expect(buildReminderDoneCallbackData('a'.repeat(61))).toBe(
      `${REMINDER_DONE_CB_PREFIX}${'a'.repeat(61)}`,
    ); // рівно 64
  });

  it('formatReminderDone — статус-текст, HTML-екрановано', () => {
    expect(formatReminderDone('Купити квитки')).toBe('✅ <b>Виконано</b>\nКупити квитки');
    expect(formatReminderDone('<script>')).toContain('&lt;script&gt;');
  });
});

describe('updateReminder — CRUD: змінити текст і/або час активного нагадування', () => {
  const base = [{ id: 'r1', text: 'Купити квитки', whenMs: 1000, createdMs: 500, firedTs: null }];

  it('лише текст -> час не чіпає', () => {
    const out = updateReminder(base, 'r1', { text: 'Купити квитки на концерт' });
    expect(out[0]).toEqual({
      id: 'r1',
      text: 'Купити квитки на концерт',
      whenMs: 1000,
      createdMs: 500,
      firedTs: null,
    });
  });

  it('лише час -> текст не чіпає, firedTs скидається (як snooze)', () => {
    const fired = [{ ...base[0], firedTs: 999 }];
    const out = updateReminder(fired, 'r1', { whenMs: 2000 });
    expect(out[0]).toMatchObject({ text: 'Купити квитки', whenMs: 2000, firedTs: null });
  });

  it('текст і час разом', () => {
    const out = updateReminder(base, 'r1', { text: 'Нове', whenMs: 3000 });
    expect(out[0]).toMatchObject({ text: 'Нове', whenMs: 3000 });
  });

  it('невідомий id -> no-op (та сама поведінка, що markFired/cancelReminder)', () => {
    expect(updateReminder(base, 'nope', { text: 'X' })).toEqual(base);
  });

  it('порожній патч -> без змін', () => {
    expect(updateReminder(base, 'r1', {})).toEqual(base);
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
    // +1 рядок «Скасувати всі» (extra c) — 2+ активних.
    expect(kb.inline_keyboard).toHaveLength(3);
    expect(kb.inline_keyboard[0][0].text).toBe('❌ Скасувати 1');
    expect(kb.inline_keyboard[0][0].callback_data).toBe(buildReminderCancelCallbackData('sooner'));
    expect(kb.inline_keyboard[1][0].text).toBe('❌ Скасувати 2');
  });

  describe('«Скасувати всі» (extra c) — лише коли є сенс (2+ активних)', () => {
    it('0 чи 1 активне -> рядка немає', () => {
      expect(buildRemindersKeyboard([]).inline_keyboard).toEqual([]);
      const one = addReminder([], {
        id: 'r1',
        text: 'X',
        whenMs: SUMMER_NOW + 1000,
        nowMs: SUMMER_NOW,
      });
      expect(buildRemindersKeyboard(one).inline_keyboard).toHaveLength(1); // лише «Скасувати 1»
    });

    it('2+ активних -> трейлінг-рядок з кількістю, callback_data = rc:all', () => {
      let reminders = addReminder([], {
        id: 'r1',
        text: 'X',
        whenMs: SUMMER_NOW + 1000,
        nowMs: SUMMER_NOW,
      });
      reminders = addReminder(reminders, {
        id: 'r2',
        text: 'Y',
        whenMs: SUMMER_NOW + 2000,
        nowMs: SUMMER_NOW,
      });
      const kb = buildRemindersKeyboard(reminders);
      const last = kb.inline_keyboard.at(-1)!;
      expect(last[0].text).toBe('🗑 Скасувати всі (2)');
      expect(last[0].callback_data).toBe('rc:all');
      expect(parseReminderCancelCallbackData(last[0].callback_data)).toBe('all');
    });

    it('спрацьовані (не активні) не рахуються в поріг 2+', () => {
      let reminders = addReminder([], {
        id: 'r1',
        text: 'X',
        whenMs: SUMMER_NOW + 1000,
        nowMs: SUMMER_NOW,
      });
      reminders = markFired(reminders, 'r1', SUMMER_NOW);
      reminders = addReminder(reminders, {
        id: 'r2',
        text: 'Y',
        whenMs: SUMMER_NOW + 2000,
        nowMs: SUMMER_NOW,
      });
      // лише 1 АКТИВНЕ (r1 спрацювало) -> без трейлінг-рядка.
      expect(buildRemindersKeyboard(reminders).inline_keyboard).toHaveLength(1);
    });
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

describe('SNOOZE_PRESETS / snoozeReminderPreset — розширений snooze (extra b)', () => {
  const base = [{ id: 'r1', text: 'X', whenMs: 1000, createdMs: 0, firedTs: 999 }];

  it('рівно 3 пресети: 10хв/1год/завтра', () => {
    expect(SNOOZE_PRESETS.map((p: { minutes: number }) => p.minutes)).toEqual([10, 60, 1440]);
  });

  it('застосовує пресет за індексом, скидає firedTs (як snoozeReminder)', () => {
    const out = snoozeReminderPreset(base, 'r1', 1, 5000); // idx 1 = 60 хв
    expect(out[0]).toMatchObject({ whenMs: 5000 + 60 * 60_000, firedTs: null });
  });

  it('невідомий індекс -> без змін', () => {
    expect(snoozeReminderPreset(base, 'r1', 99, 5000)).toEqual(base);
  });

  it('невідомий id -> no-op', () => {
    expect(snoozeReminderPreset(base, 'nope', 0, 5000)).toEqual(base);
  });
});

describe('reminders-core — rs: callback_data (пресет snooze, extra b)', () => {
  it('build+parse round-trip для кожного пресету', () => {
    for (let i = 0; i < SNOOZE_PRESETS.length; i++) {
      const cb = buildReminderSnoozeCallbackData(i, 'abc-123');
      expect(cb).toBe(`${REMINDER_SNOOZE_CB_PREFIX}${i}:abc-123`);
      expect(parseReminderSnoozeCallbackData(cb)).toEqual({ presetIdx: i, id: 'abc-123' });
    }
  });

  it('невалідний presetIdx при побудові -> null', () => {
    expect(buildReminderSnoozeCallbackData(-1, 'id')).toBeNull();
    expect(buildReminderSnoozeCallbackData(99, 'id')).toBeNull();
    expect(buildReminderSnoozeCallbackData(1.5, 'id')).toBeNull();
  });

  it('малформат/чужий префікс/поза межами при розборі -> null', () => {
    expect(parseReminderSnoozeCallbackData('rm:0:id')).toBeNull();
    expect(parseReminderSnoozeCallbackData('rs:99:id')).toBeNull();
    expect(parseReminderSnoozeCallbackData('rs::id')).toBeNull();
    expect(parseReminderSnoozeCallbackData('rs:0:')).toBeNull();
    expect(parseReminderSnoozeCallbackData(null)).toBeNull();
  });

  /* ── Три «десятки», що доти жили нарізно ──────────────────────────────
     SNOOZE_MINUTES, число в першому пресеті й текст тоста в callbacks.mjs були
     трьома незалежними літералами. Тепер два останні виводяться з константи, і
     ці тести стережуть саме звʼязок, а не значення. */

  it('перший пресет виводиться з SNOOZE_MINUTES — і числом, і підписом', () => {
    expect(SNOOZE_PRESETS[0].minutes).toBe(SNOOZE_MINUTES);
    expect(SNOOZE_PRESETS[0].label).toContain(String(SNOOZE_MINUTES));
  });

  /* Читання сирцю — той самий прийом, що вже застосований у
     tests/wrangler-config.test.ts: поведінку тоста інакше не дістати без
     повного мока Telegram, а зловити повернення жорсткого числа треба. */
  it('тост snooze інтерполює константу, а не жорстке число', () => {
    const src = readFileSync('web/callbacks.mjs', 'utf8');
    expect(src).toContain('Відкладено на ${SNOOZE_MINUTES} хв');
    expect(src).not.toMatch(/Відкладено на \d+ хв/);
  });

  it('buildSnoozeRow — по кнопці на пресет + «✅ Виконано» останньою', () => {
    const row = buildSnoozeRow('rem1');
    expect(row).toHaveLength(4); // 3 snooze-пресети + Виконано
    expect(row[0].text).toBe('😴 10 хв');
    expect(row[2].text).toBe('😴 завтра');
    expect(
      row.slice(0, 3).every((b: { callback_data: string }) => b.callback_data.startsWith('rs:')),
    ).toBe(true);
    expect(row[3]).toEqual({ text: '✅ Виконано', callback_data: 'rk:rem1' });
  });
});

/* B23: роутинг «нагад» жадібно перехоплював БУДЬ-ЯКЕ повідомлення зі словом
 * «нагад» у парсер нагадувань. Живий прогін власника (T4/T6/T7) показав, у що
 * це виливається: подія не створюється, старе нагадування не скасовується,
 * перенос стає дублем. Класифікатор свідомо вузький — хибний «агент» дорожчий
 * за хибний «парсер», тож тестуємо ОБИДВІ гілки, і особливо ті фрази, які
 * НАІВНИЙ пошук ключових слів відправив би до агента помилково. */
describe('classifyReminderIntent (B23)', () => {
  it('чисте нагадування -> парсер (наявний швидкий шлях)', () => {
    for (const t of [
      'нагадай купити молоко о 18:00',
      'нагадай через 20 хвилин подзвонити мамі',
      'Нагадай завтра о 10 про стоматолога',
      'нагадай ввечері полити квіти',
    ]) {
      expect(classifyReminderIntent(t), t).toBe('reminder');
    }
  });

  it('мутація ІСНУЮЧОГО нагадування -> агент (T6/T7 наживо)', () => {
    for (const t of [
      'Скасуй нагадування про молоко і постав натомість на четвер',
      'Перенеси нагадування про молоко на 20:00',
      'онови нагадування про стоматолога — тепер о 15:00',
      'видали нагадування про звіт',
    ]) {
      expect(classifyReminderIntent(t), t).toBe('agent');
    }
  });

  it('«заплануй … і нагадай …» -> агент (T4 наживо: подію парсер не створює)', () => {
    for (const t of [
      'Заплануй зустріч о 15:00 і нагадай за годину до неї',
      'Додай подію на завтра о 12 і нагадай мені зранку',
      'запиши в календар обід о 13 і нагадай за 15 хв',
    ]) {
      expect(classifyReminderIntent(t), t).toBe('agent');
    }
  });

  it('дієслово-мутація в ТІЛІ нагадування -> усе одно парсер (не хапаємо зайвого)', () => {
    // Найдорожчий клас хибних спрацювань: звичайні нагадування, у тексті яких
    // випадково є «онови»/«перенеси»/«видали». Без вимоги іменника
    // «нагадуванн» кожне з них поїхало б до агента — повільніше, залежить від
    // VPS-хоста і легко провалюється.
    for (const t of [
      'нагадай оновити резюме о 18:00',
      'нагадай видалити старі фото завтра',
      'нагадай перенести гроші на картку в понеділок',
      'нагадай скасувати підписку 20.08',
    ]) {
      expect(classifyReminderIntent(t), t).toBe('reminder');
    }
  });

  it('інфінітив планування — це ЗМІСТ нагадування, не команда боту', () => {
    expect(classifyReminderIntent('нагадай запланувати відпустку')).toBe('reminder');
    expect(classifyReminderIntent('нагадай записати показники лічильника')).toBe('reminder');
    expect(classifyReminderIntent('нагадай додати витрати в таблицю')).toBe('reminder');
  });

  it('порожнє/не рядок -> reminder (жодних сюрпризів на вході)', () => {
    expect(classifyReminderIntent('')).toBe('reminder');
    expect(classifyReminderIntent('   ')).toBe('reminder');
    expect(classifyReminderIntent(undefined)).toBe('reminder');
  });
});
