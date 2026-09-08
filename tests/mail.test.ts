import { describe, it, expect, vi } from 'vitest';
import { USAGE_LIMIT_TEXTS } from './usage-limit-fixtures.js';
import {
  createMailModule,
  buildMailPrompt,
  parseMailClassification,
  pluralizeLysty,
  sanitizeInterviewWhen,
  MAIL_PROPOSAL_BUS_KEY,
} from '../src/modules/mail.js';
import { createRunBus } from '../src/core/bus.js';
import type { Ctx, StateStore } from '../src/core/types.js';
import type { AppConfig } from '../src/core/config.js';
import { memState } from './helpers/state.js';

describe('pluralizeLysty — укр відмінювання', () => {
  it('1/21/31 -> лист; 2-4/22-24 -> листи; 5-20/11-14/25 -> листів', () => {
    expect(pluralizeLysty(1)).toBe('лист');
    expect(pluralizeLysty(21)).toBe('лист');
    expect(pluralizeLysty(2)).toBe('листи');
    expect(pluralizeLysty(3)).toBe('листи');
    expect(pluralizeLysty(24)).toBe('листи');
    expect(pluralizeLysty(5)).toBe('листів');
    expect(pluralizeLysty(11)).toBe('листів');
    expect(pluralizeLysty(12)).toBe('листів');
    expect(pluralizeLysty(14)).toBe('листів');
    expect(pluralizeLysty(25)).toBe('листів');
    expect(pluralizeLysty(0)).toBe('листів');
  });
});

describe('buildMailPrompt', () => {
  it('містить профіль і нумеровані листи (from+subject+snippet)', () => {
    const p = buildMailPrompt('Junior Full Stack', [
      { id: '1', from: 'hr@acme.com', subject: 'Ваша заявка', snippet: 'дякуємо за...' },
    ]);
    expect(p).toContain('Junior Full Stack');
    expect(p).toContain('1. Від: hr@acme.com');
    expect(p).toContain('Тема: Ваша заявка');
  });
});

describe('parseMailClassification', () => {
  it('парсить масив із прози (important-only -> interview:false, решта undefined)', () => {
    const m = parseMailClassification('Ось: [{"i":1,"important":true},{"i":2,"important":false}]')!;
    expect(m.get(1)).toEqual({
      important: true,
      interview: false,
      dateISO: undefined,
      time: undefined,
      title: undefined,
    });
    expect(m.get(2)?.important).toBe(false);
  });

  it('парсить interview+dateISO+time+title', () => {
    const m = parseMailClassification(
      '[{"i":1,"important":true,"interview":true,"dateISO":"2026-07-14","time":"15:00","title":"Співбесіда — Acme"}]',
    )!;
    expect(m.get(1)).toEqual({
      important: true,
      interview: true,
      dateISO: '2026-07-14',
      time: '15:00',
      title: 'Співбесіда — Acme',
    });
  });

  it('малформат -> null (це ЗБІЙ), а валідний [] -> порожня map (це ВІДПОВІДЬ)', () => {
    // Різниця несуча, а не косметична: null веде в catch (лист не позначається
    // прочитаним і повернеться завтра), порожня map — це «переглянув, важливого
    // немає» (позначаємо, бо повторний розгляд лише палив би виклик). Доти обидва
    // випадки давали порожню map — і збій мовчки ставав відповіддю.
    expect(parseMailClassification('нема')).toBeNull();
    expect(parseMailClassification('[зламано')).toBeNull();
    expect(parseMailClassification('{"i":1}')).toBeNull(); // обʼєкт, не масив
    expect(parseMailClassification("You've hit your session limit")).toBeNull();
    expect(parseMailClassification('[]')?.size).toBe(0);
  });
});

describe('sanitizeInterviewWhen', () => {
  const NOW = Date.parse('2026-07-10T08:00:00Z'); // 2026-07-10 11:00 Київ (EEST)

  it('валідні dateISO+time -> whenMs (Kyiv EEST, +3)', () => {
    const whenMs = sanitizeInterviewWhen('2026-07-14', '15:00', NOW);
    expect(whenMs).toBe(Date.parse('2026-07-14T12:00:00Z'));
  });

  it('відсутні/малий формат -> null', () => {
    expect(sanitizeInterviewWhen(undefined, '15:00', NOW)).toBeNull();
    expect(sanitizeInterviewWhen('2026-07-14', undefined, NOW)).toBeNull();
    expect(sanitizeInterviewWhen('14-07-2026', '15:00', NOW)).toBeNull();
    expect(sanitizeInterviewWhen('2026-07-14', '3pm', NOW)).toBeNull();
  });

  it('невалідна година/хвилина -> null', () => {
    expect(sanitizeInterviewWhen('2026-07-14', '25:00', NOW)).toBeNull();
    expect(sanitizeInterviewWhen('2026-07-14', '10:70', NOW)).toBeNull();
  });

  it('поза розумним діапазоном (>60 днів наперед чи в минулому) -> null', () => {
    expect(sanitizeInterviewWhen('2026-10-01', '10:00', NOW)).toBeNull(); // >60 днів
    expect(sanitizeInterviewWhen('2026-01-01', '10:00', NOW)).toBeNull(); // в минулому
  });

  it('неіснуюча календарна дата -> null (Date.parse мовчки "перекочує", а не відхиляє)', () => {
    // Регресія: Date.parse('2026-02-30') не кидає — тихо стає 2026-03-02.
    // isValidCalendarDate у mail.ts має ловити це ДО kyivLocalToUtcMs.
    expect(sanitizeInterviewWhen('2026-02-30', '10:00', NOW)).toBeNull();
    expect(sanitizeInterviewWhen('2026-04-31', '10:00', NOW)).toBeNull();
    expect(sanitizeInterviewWhen('2026-13-01', '10:00', NOW)).toBeNull();
  });
});

function makeCtx(over: { state?: StateStore; llm?: Ctx['llm'] } = {}): Ctx<AppConfig> {
  const noop = () => {};
  return {
    bus: createRunBus(),
    clock: {
      todayKey: () => '2026-07-01',
      kyivHour: () => 8,
      now: () => new Date('2026-07-01T08:00:00+03:00'),
      isSunday: () => false,
    },
    log: { debug: noop, info: noop, warn: noop, error: noop },
    config: {
      llm: { timeoutMs: 1000 },
      modules: {
        mail: {
          enabled: true,
          dedupDays: 3,
          maxCandidates: 15,
          query: 'in:inbox newer_than:3d',
        },
        jobs: { profile: 'Junior Full Stack' },
      },
    } as unknown as AppConfig,
    state: over.state ?? memState(),
    llm: over.llm ?? ({ complete: vi.fn(async () => '[]') } as Ctx['llm']),
    fetcher: {} as Ctx['fetcher'],
  } as Ctx<AppConfig>;
}

/** Кандидати з KV `state.mailTriage` - те, що поклало ядро (задача mail-triage). */
function triage(
  items: { id: string; subject: string; from: string; snippet: string }[],
  atMs = Date.parse('2026-07-01T06:00:00Z'),
) {
  return {
    historyId: '100',
    lastRunMs: atMs,
    fails: 0,
    alerted: false,
    candidates: items.map((i) => ({ ...i, atMs })),
  };
}

describe('mail module', () => {
  it('ключа mailTriage немає -> null із попередженням (тріаж у ядрі ще не ходив)', async () => {
    const warns: string[] = [];
    const ctx = makeCtx({ state: memState() });
    ctx.log.warn = (m: string) => void warns.push(m);
    expect(await createMailModule().run(ctx)).toBeNull();
    expect(warns.join(' ')).toContain('mailTriage');
  });

  it('порожній список кандидатів -> null, LLM не викликається', async () => {
    const llm = { complete: vi.fn(async () => '[]') };
    const state = memState({ mailTriage: triage([]) });
    expect(await createMailModule().run(makeCtx({ state, llm: llm as Ctx['llm'] }))).toBeNull();
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it('малформед LLM-відповідь -> дедуп НЕ записано (лист повернеться завтра)', async () => {
    // ⚠️ Цей тест раніше стверджував ПРОТИЛЕЖНЕ: «дедуп все одно записано».
    // Тобто він пінив баг як норму. Міркування було «раз LLM відповіла, повторний
    // розгляд не допоможе» — але воно хибне рівно в найімовірнішому випадку:
    // вичерпаний ліміт підписки повертає людський текст з exit 0, не throw.
    // Лист позначався прочитаним, випадав із вікна newer_than:3d і зникав
    // назавжди — мовчки. Завтра ліміт відпускає, і розгляд ЩЕ ЯК допоміг би.
    const state = memState({
      mailTriage: triage([{ id: 'm1', subject: 'Тема', from: 'a@b.com', snippet: 's' }]),
    });
    const llm = { complete: vi.fn(async () => 'не json') };
    const block = await createMailModule().run(makeCtx({ state, llm: llm as Ctx['llm'] }));
    expect(block).toBeNull();
    expect(state.get('shownMail')).toBeUndefined();
  });

  it('БУДЬ-ЯКИЙ текст ліміту підписки -> дедуп НЕ записано (найгірший реальний сценарій)', async () => {
    // Так виглядає вичерпаний ліміт Pro: claude -p друкує це в stdout і виходить
    // з КОДОМ 0. Раніше цей текст ішов у mail як звичайна відповідь -> «0
    // важливих» -> усі листи позначені прочитаними -> запрошення на співбесіду
    // втрачене без сліду.
    //
    // Ганяємо ВЕСЬ спільний фікстур-набір, а не один рядок: інакше новий текст
    // ліміту від Anthropic обійшов би захист мовчки, як і раніше.
    for (const text of USAGE_LIMIT_TEXTS) {
      const state = memState({
        mailTriage: triage([
          {
            id: 'm1',
            subject: 'Запрошення на співбесіду',
            from: 'hr@acme.com',
            snippet: 'вітаємо',
          },
        ]),
      });
      const llm = { complete: vi.fn(async () => text) };
      expect(
        await createMailModule().run(makeCtx({ state, llm: llm as Ctx['llm'] })),
        text,
      ).toBeNull();
      expect(state.get('shownMail'), text).toBeUndefined();
    }
  });

  it('ВАЛІДНИЙ порожній [] -> дедуп ЗАПИСАНО (це відповідь, а не збій)', async () => {
    // Межа, заради якої parseMailClassification розрізняє null і порожню Map:
    // «переглянув, важливого немає» — це повноцінна відповідь, і повторно палити
    // виклик на ті самі листи не треба.
    const state = memState({
      mailTriage: triage([
        { id: 'm1', subject: 'Розсилка', from: 'news@shop.com', snippet: 'знижки' },
      ]),
    });
    const llm = { complete: vi.fn(async () => '[]') };
    expect(await createMailModule().run(makeCtx({ state, llm: llm as Ctx['llm'] }))).toBeNull();
    expect(state.get('shownMail')).toEqual({ m1: '2026-07-01' });
  });

  it('важливі листи -> Block з коректним рахунком, без subject/from/snippet у виводі', async () => {
    const state = memState({
      mailTriage: triage([
        { id: 'm1', subject: 'Запрошення на співбесіду', from: 'hr@acme.com', snippet: 'вітаємо' },
        { id: 'm2', subject: 'Знижки -50%', from: 'promo@shop.com', snippet: 'купуй зараз' },
        { id: 'm3', subject: 'Ваша заявка отримана', from: 'noreply@corp.com', snippet: 'дякуємо' },
      ]),
    });
    const llm = {
      complete: vi.fn(async () =>
        JSON.stringify([
          { i: 1, important: true },
          { i: 2, important: false },
          { i: 3, important: true },
        ]),
      ),
    };
    const block = await createMailModule().run(makeCtx({ state, llm: llm as Ctx['llm'] }));
    expect(block).toMatchObject({ id: 'mail', icon: '📧', summary: '2 листи про вакансії' });
    // data несе ЛИШЕ агрегований лічильник (Фаза B3, короткий рядок дня) —
    // жодних subject/from/snippet ні тут, ні деінде в блоці.
    expect(block?.data).toEqual({ count: 2 });
    const serialized = JSON.stringify(block);
    expect(serialized).not.toContain('acme.com');
    expect(serialized).not.toContain('Запрошення');
    expect(serialized).not.toContain('вітаємо');
  });

  it('запрошення на співбесіду з валідною датою -> MAIL_PROPOSAL_BUS_KEY', async () => {
    const state = memState({
      mailTriage: triage([
        { id: 'm1', subject: 'Запрошення на співбесіду', from: 'hr@acme.com', snippet: 'вітаємо' },
      ]),
    });
    const llm = {
      complete: vi.fn(async () =>
        JSON.stringify([
          {
            i: 1,
            important: true,
            interview: true,
            dateISO: '2026-07-14',
            time: '15:00',
            title: 'Співбесіда — Acme',
          },
        ]),
      ),
    };
    const ctx = makeCtx({ state, llm: llm as Ctx['llm'] });
    await createMailModule().run(ctx);
    const proposal = ctx.bus.get<{ items: unknown[] }>(MAIL_PROPOSAL_BUS_KEY);
    expect(proposal?.items).toEqual([
      {
        kind: 'event',
        title: 'Співбесіда — Acme',
        whenMs: Date.parse('2026-07-14T12:00:00Z'),
        durationMin: 60,
        from: 'hr@acme.com', // M4: відправник у пропозиції
      },
    ]);
  });

  it('збій LLM (throw) -> null і shownMail НЕ позначено (лист не втрачається)', async () => {
    const state = memState({
      mailTriage: triage([
        { id: 'm1', subject: 'Запрошення', from: 'hr@acme.com', snippet: 'вітаємо' },
      ]),
    });
    const llm = {
      complete: vi.fn(async () => {
        throw new Error('claude -p таймаут');
      }),
    };
    const block = await createMailModule().run(makeCtx({ state, llm: llm as Ctx['llm'] }));
    expect(block).toBeNull();
    // На відміну від малформед-відповіді: throw -> НЕ позначаємо (ретрай завтра).
    expect(state.get('shownMail')).toBeUndefined();
  });

  it('interview:true але дата поза діапазоном/малий формат -> без bus-запису', async () => {
    const state = memState({
      mailTriage: triage([
        { id: 'm1', subject: 'Запрошення', from: 'hr@acme.com', snippet: 'вітаємо' },
      ]),
    });
    const llm = {
      complete: vi.fn(async () =>
        JSON.stringify([
          {
            i: 1,
            important: true,
            interview: true,
            dateISO: '2030-01-01',
            time: '15:00',
            title: 'X',
          },
        ]),
      ),
    };
    const ctx = makeCtx({ state, llm: llm as Ctx['llm'] });
    await createMailModule().run(ctx);
    expect(ctx.bus.get(MAIL_PROPOSAL_BUS_KEY)).toBeUndefined();
  });

  it('дедуп: лист у вікні shownMail не потрапляє в кандидатів', async () => {
    const state = memState({
      shownMail: { m1: '2026-06-30' }, // учора, у вікні dedupDays=3
      mailTriage: triage([{ id: 'm1', subject: 'Тема', from: 'a@b.com', snippet: 's' }]),
    });
    const llm = { complete: vi.fn(async () => JSON.stringify([{ i: 1, important: true }])) };
    expect(await createMailModule().run(makeCtx({ state, llm: llm as Ctx['llm'] }))).toBeNull();
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it('кандидатів більше за maxCandidates -> у промпт іде рівно стеля', async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      id: `m${i}`,
      subject: `Тема ${i}`,
      from: 'a@b.com',
      snippet: 's',
    }));
    const state = memState({ mailTriage: triage(many) });
    const seen: string[] = [];
    const llm = {
      complete: vi.fn(async (prompt: string) => {
        seen.push(prompt);
        return '[]';
      }),
    };
    await createMailModule().run(makeCtx({ state, llm: llm as unknown as Ctx['llm'] }));
    const prompt = seen[0] ?? '';
    expect(prompt).toContain('Тема 14');
    expect(prompt).not.toContain('Тема 15');
  });
});
