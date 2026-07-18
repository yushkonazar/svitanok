import { describe, it, expect } from 'vitest';
import { statsSchema } from '../web/app/src/api/schema.ts';
import { settingsSchema, settingsResponseSchema } from '../web/app/src/api/settings-schema.ts';

// Контракти Mini App (/api/stats, /api/settings) — покриття кореневим vitest.
//
// НАВІЩО тут, а не в web/app: у web/app немає ні тест-раннера, ні лінтера (гейт —
// лише `tsc -b && vite build`), а ці схеми ЗАГАТНІ: якщо safeParse провалиться,
// вкладка падає в «Формат змінився». І перевірити їх смоуком неможливо — у демо
// client.ts віддає SAMPLE НЕ парсячи, тобто схема працює тільки в реальному
// Telegram. Тобто без цих тестів дефект видно лише в проді.
//
// Приводом став апгрейд zod 3->4: `z.record(x)` з ОДНИМ аргументом у v4 означає
// схему КЛЮЧА (у v3 — значення). Тобто `z.record(z.enum(['up','down']))` мовчки
// перетворився з «url -> голос» на «ключі мусять бути up/down», і кожен реальний
// votes завалював би валідацію.
//
// ⚠️ Застереження: корінь і web/app мають ОКРЕМІ інстали zod. Тест бере
// кореневий. Поки мажор той самий (обидва 4.x) — сигнал чесний; якщо версії
// розійдуться, тест перевірятиме не той zod, що в бандлі.

const baseStats = {
  streaks: { openDays: 3, mockDays: 1 },
  timeToOpenMin: 42,
  weekly: [],
  funnel: { saved: 1, applied: 2, interview: 0, offer: 0 },
  goal: { weeklyTarget: 5, weeklyApplied: 2 },
  conversion: { appliedToInterview: 0, interviewToOffer: 0 },
  mock: {},
  reliability: {},
};

describe('контракт /api/stats — statsSchema', () => {
  it('мінімальна відповідь сервера проходить, дефолти підставляються', () => {
    const r = statsSchema.safeParse(baseStats);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.savedList).toEqual([]);
    expect(r.data.funnelList).toEqual([]);
    expect(r.data.interestsTrend).toEqual({ weeks: [], topics: [] });
    expect(r.data.timeToOpenMin).toBe(42);
  });

  it('votes — це МАПА url -> напрямок (ключ довільний рядок, не enum)', () => {
    const votes = { 'https://example.com/a': 'up', 'https://example.com/b': 'down' };
    const r = statsSchema.safeParse({ ...baseStats, votes });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.votes).toEqual(votes);
  });

  it('невалідний напрямок голосу відхиляється', () => {
    expect(statsSchema.safeParse({ ...baseStats, votes: { 'https://x': 'вгору' } }).success).toBe(
      false,
    );
  });

  it('votes опційні (сервер не шле їх без жодного голосу)', () => {
    const r = statsSchema.safeParse(baseStats);
    expect(r.success && r.data.votes).toBeUndefined();
  });

  it('зайві поля сервера не ламають клієнт (схема стійка до нових полів)', () => {
    const r = statsSchema.safeParse({ ...baseStats, щосьНове: { x: 1 } });
    expect(r.success).toBe(true);
    if (r.success) expect('щосьНове' in r.data).toBe(false);
  });

  it('битий тип падає, а не проповзає', () => {
    expect(statsSchema.safeParse({ ...baseStats, funnel: { saved: 'багато' } }).success).toBe(
      false,
    );
    expect(statsSchema.safeParse(null).success).toBe(false);
  });

  // ⚠️ Регресія чек-ін v2: звузили enum plan/ate (прибрали apply/interview/
  // procrast). Але checkinToday — hydration стору, який міг записати СТАРІШИЙ
  // сервер тими значеннями. Без толерантності одне старе поле завалило б
  // safeParse УСЬОГО /api/stats -> Статистика+Вакансії чорні до півночі.
  it('старе значення plan/ate у checkinToday деградує в поле, а не чорнить усе', () => {
    const r = statsSchema.safeParse({
      ...baseStats,
      checkinToday: {
        morning: { plan: 'apply', sleepH: 6.5 }, // 'apply' — з v1, більше не в переліку
        afternoon: { ate: 'procrast' }, // так само легасі
      },
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    // Невідоме значення стало undefined; валідне поле поруч уціліло.
    expect(r.data.checkinToday?.morning?.plan).toBeUndefined();
    expect(r.data.checkinToday?.morning?.sleepH).toBe(6.5);
    expect(r.data.checkinToday?.afternoon?.ate).toBeUndefined();
  });
});

describe('контракт /api/settings — settingsSchema', () => {
  it('modules — це МАПА id -> boolean (ключ довільний рядок)', () => {
    const r = settingsSchema.safeParse({
      quiet: { enabled: true, from: '22:00', to: '08:00' },
      modules: { news: false, jobs: true },
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.modules).toEqual({ news: false, jobs: true });
  });

  it('порожній обʼєкт -> дефолти (тихі години ВИМКНЕНІ)', () => {
    const r = settingsSchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.quiet).toEqual({ enabled: false, from: '22:00', to: '08:00' });
      expect(r.data.modules).toEqual({});
    }
  });

  it('час не у форматі HH:MM відхиляється', () => {
    expect(
      settingsSchema.safeParse({ quiet: { enabled: true, from: '9:00', to: '08:00' } }).success,
    ).toBe(false);
  });

  it('не-boolean у modules відхиляється', () => {
    expect(settingsSchema.safeParse({ modules: { news: 'off' } }).success).toBe(false);
  });

  it('повна відповідь із конекторами', () => {
    const r = settingsResponseSchema.safeParse({
      settings: { quiet: { enabled: false, from: '22:00', to: '08:00' }, modules: {} },
      connectors: { google: true, calendar: true, gmail: false },
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.connectors.gmail).toBe(false);
  });
});
