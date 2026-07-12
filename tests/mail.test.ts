import { describe, it, expect, vi } from 'vitest';
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
    const m = parseMailClassification('Ось: [{"i":1,"important":true},{"i":2,"important":false}]');
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
    );
    expect(m.get(1)).toEqual({
      important: true,
      interview: true,
      dateISO: '2026-07-14',
      time: '15:00',
      title: 'Співбесіда — Acme',
    });
  });

  it('малформат -> порожня map', () => {
    expect(parseMailClassification('нема').size).toBe(0);
    expect(parseMailClassification('[зламано').size).toBe(0);
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

function memState(initial: Record<string, unknown> = {}): StateStore {
  const data = { ...initial };
  return {
    get: <T>(k: string) => data[k] as T | undefined,
    set: <T>(k: string, v: T) => void (data[k] = v),
    prune: () => {},
    flush: async () => {},
  };
}

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

const creds = {
  GOOGLE_CLIENT_ID: 'id',
  GOOGLE_CLIENT_SECRET: 'secret',
  GOOGLE_REFRESH_TOKEN: 'refresh',
};

function mkFetch(
  messageIds: string[],
  headersById: Record<string, { subject: string; from: string; snippet: string }>,
) {
  return vi.fn(async (url: string) => {
    if (url.includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'AT' }), { status: 200 });
    }
    if (url.includes('/messages?')) {
      return new Response(JSON.stringify({ messages: messageIds.map((id) => ({ id })) }), {
        status: 200,
      });
    }
    const idMatch = url.match(/\/messages\/([^?]+)/);
    const id = idMatch?.[1] ?? '';
    const h = headersById[id];
    if (!h) return new Response('not found', { status: 404 });
    return new Response(
      JSON.stringify({
        snippet: h.snippet,
        payload: {
          headers: [
            { name: 'Subject', value: h.subject },
            { name: 'From', value: h.from },
          ],
        },
      }),
      { status: 200 },
    );
  });
}

describe('mail module', () => {
  it('без GOOGLE_* секретів -> null', async () => {
    const mod = createMailModule({ fetchImpl: vi.fn() as unknown as typeof fetch, env: {} });
    expect(await mod.run(makeCtx())).toBeNull();
  });

  it('401/invalid_grant на token -> null (не валить)', async () => {
    const fetchImpl = vi.fn(async () => new Response('invalid_grant', { status: 400 }));
    const mod = createMailModule({ fetchImpl: fetchImpl as unknown as typeof fetch, env: creds });
    expect(await mod.run(makeCtx())).toBeNull();
  });

  it('порожня скринька -> null', async () => {
    const fetchImpl = mkFetch([], {});
    const mod = createMailModule({ fetchImpl: fetchImpl as unknown as typeof fetch, env: creds });
    expect(await mod.run(makeCtx())).toBeNull();
  });

  it('малформед LLM-відповідь -> 0 важливих -> null, але дедуп все одно записано', async () => {
    const fetchImpl = mkFetch(['m1'], {
      m1: { subject: 'Тема', from: 'a@b.com', snippet: 's' },
    });
    const state = memState();
    const llm = { complete: vi.fn(async () => 'не json') };
    const mod = createMailModule({ fetchImpl: fetchImpl as unknown as typeof fetch, env: creds });
    const block = await mod.run(makeCtx({ state, llm: llm as Ctx['llm'] }));
    expect(block).toBeNull();
    expect(state.get('shownMail')).toEqual({ m1: '2026-07-01' });
  });

  it('важливі листи -> Block з коректним рахунком, без subject/from/snippet у виводі', async () => {
    const fetchImpl = mkFetch(['m1', 'm2', 'm3'], {
      m1: { subject: 'Запрошення на співбесіду', from: 'hr@acme.com', snippet: 'вітаємо' },
      m2: { subject: 'Знижки -50%', from: 'promo@shop.com', snippet: 'купуй зараз' },
      m3: { subject: 'Ваша заявка отримана', from: 'noreply@corp.com', snippet: 'дякуємо' },
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
    const mod = createMailModule({ fetchImpl: fetchImpl as unknown as typeof fetch, env: creds });
    const block = await mod.run(makeCtx({ llm: llm as Ctx['llm'] }));
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
    const fetchImpl = mkFetch(['m1'], {
      m1: { subject: 'Запрошення на співбесіду', from: 'hr@acme.com', snippet: 'вітаємо' },
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
    const mod = createMailModule({ fetchImpl: fetchImpl as unknown as typeof fetch, env: creds });
    const ctx = makeCtx({ llm: llm as Ctx['llm'] });
    await mod.run(ctx);
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
    const fetchImpl = mkFetch(['m1'], {
      m1: { subject: 'Запрошення', from: 'hr@acme.com', snippet: 'вітаємо' },
    });
    const state = memState();
    const llm = {
      complete: vi.fn(async () => {
        throw new Error('claude -p таймаут');
      }),
    };
    const mod = createMailModule({ fetchImpl: fetchImpl as unknown as typeof fetch, env: creds });
    const block = await mod.run(makeCtx({ state, llm: llm as Ctx['llm'] }));
    expect(block).toBeNull();
    // На відміну від малформед-відповіді: throw -> НЕ позначаємо (ретрай завтра).
    expect(state.get('shownMail')).toBeUndefined();
  });

  it('interview:true але дата поза діапазоном/малий формат -> без bus-запису', async () => {
    const fetchImpl = mkFetch(['m1'], {
      m1: { subject: 'Запрошення', from: 'hr@acme.com', snippet: 'вітаємо' },
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
    const mod = createMailModule({ fetchImpl: fetchImpl as unknown as typeof fetch, env: creds });
    const ctx = makeCtx({ llm: llm as Ctx['llm'] });
    await mod.run(ctx);
    expect(ctx.bus.get(MAIL_PROPOSAL_BUS_KEY)).toBeUndefined();
  });

  it('дедуп: лист у вікні shownMail не потрапляє в кандидатів', async () => {
    const fetchImpl = mkFetch(['m1'], {
      m1: { subject: 'Тема', from: 'a@b.com', snippet: 's' },
    });
    const state = memState({ shownMail: { m1: '2026-06-30' } }); // учора, у вікні dedupDays=3
    const llm = { complete: vi.fn(async () => JSON.stringify([{ i: 1, important: true }])) };
    const mod = createMailModule({ fetchImpl: fetchImpl as unknown as typeof fetch, env: creds });
    expect(await mod.run(makeCtx({ state, llm: llm as Ctx['llm'] }))).toBeNull();
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it('одиничний лист не завантажився -> пропускається, решта тріажу триває', async () => {
    const fetchImpl = mkFetch(['m1', 'm2'], {
      m2: { subject: 'Запрошення', from: 'hr@x.com', snippet: 's' },
    }); // m1 -> 404 у mkFetch (немає в headersById)
    const llm = { complete: vi.fn(async () => JSON.stringify([{ i: 1, important: true }])) };
    const mod = createMailModule({ fetchImpl: fetchImpl as unknown as typeof fetch, env: creds });
    const block = await mod.run(makeCtx({ llm: llm as Ctx['llm'] }));
    expect(block!.summary).toBe('1 лист про вакансії');
  });
});
