// Gemini: зображення (T1) і відео (T2) - ADR-012, ADR-034, S-8-5/S-8-6,
// етап 7 PR-3.
//
// ТРИ РЕЧІ, ЗАРАДИ ЯКИХ ЦЕЙ ФАЙЛ ІСНУЄ.
//   1. У чужий сервіс їде РІВНО prompt власника: білий список полів і повна
//      відмова в заплямованій сесії.
//   2. Ціну власник бачить ДО витрати, і пише її ЯДРО - модель, яка просить
//      схвалення, не має права називати ціну.
//   3. Free tier заборонений у коді: без ключа й без GEMINI_TIER=paid жодного
//      запиту не відбувається.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  sanitizeGeminiPayload,
  proposalNotice,
  ACTION_LEVELS,
  GEMINI_PROMPT_MAX,
} from '../web/core/policy/core.mjs';
import {
  requirePaidGemini,
  generateImage,
  videoUsd,
  IMAGE_USD,
  VIDEO_DEFAULT_SECONDS,
} from '../web/core/adapters/gemini.mjs';
import { applyPolicy, resolveProposal } from '../web/core/policy/proposals.mjs';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';
import { d1FromSqlite } from './helpers/d1.js';

const NOW = Date.parse('2026-09-08T09:00:00.000Z');

function makeEnv(over: Record<string, unknown> = {}) {
  const d1 = d1FromSqlite([
    '0001_base.sql',
    '0002_assistant.sql',
    '0003_telemetry.sql',
    '0004_ideas_travel.sql',
  ]);
  const env = workerEnv({
    ASSISTANT_V2: 'on',
    TELEGRAM_BOT_TOKEN: 'bot',
    TELEGRAM_CHAT_ID: '555',
    GEMINI_API_KEY: 'gkey',
    GEMINI_TIER: 'paid',
    BRIEFING: memoryKv(new Map()),
    DB: d1.stub,
    ...over,
  });
  return { env, d1 };
}

/** Пропозиція → ✅ (T2 - зі словом) → результат виконавця. */
async function approve(env: Env, kind: string, payload: Record<string, unknown>) {
  const decided = await applyPolicy(
    env,
    { kind, payload, tainted: false, chatId: 555, threadId: 7 },
    NOW,
  );
  if (decided.mode !== 'proposed') throw new Error(`очікувалась пропозиція, а не ${decided.mode}`);
  return {
    proposal: decided.proposal,
    result: await resolveProposal(
      env,
      { id: decided.proposal.id, choice: 'ok', word: decided.proposal.word ?? undefined },
      NOW,
    ),
  };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('рівні (ADR-012)', () => {
  it('зображення - T1, відео - T2', () => {
    expect(ACTION_LEVELS['gemini.image']).toBe('T1');
    expect(ACTION_LEVELS['gemini.video']).toBe('T2');
  });
});

describe('sanitizeGeminiPayload (ADR-034)', () => {
  it('лишає prompt і дозволені параметри формату', () => {
    expect(
      sanitizeGeminiPayload('gemini.video', { prompt: 'кіт', seconds: 4, model: 'lite' }),
    ).toEqual({ payload: { prompt: 'кіт', seconds: 4, model: 'lite' } });
  });

  it('id транзакції в payload - ПОМИЛКА, не тихе відкидання', () => {
    const out = sanitizeGeminiPayload('gemini.image', {
      prompt: 'намалюй чек',
      transaction_id: 'tx-1',
    });
    expect(out).toEqual({ error: expect.stringContaining('transaction_id') });
  });

  it.each(['inbox_id', 'mail_id', 'facts', 'chat_id', 'context'])(
    'поле %s не проходить (білий список, не чорний)',
    (field) => {
      const out = sanitizeGeminiPayload('gemini.image', { prompt: 'кіт', [field]: 'x' });
      expect('error' in out).toBe(true);
    },
  );

  it('без prompt - відмова; задовгий prompt - теж', () => {
    expect(sanitizeGeminiPayload('gemini.image', {})).toEqual({
      error: expect.stringContaining('потрібен prompt'),
    });
    expect(
      sanitizeGeminiPayload('gemini.image', { prompt: 'я'.repeat(GEMINI_PROMPT_MAX + 1) }),
    ).toEqual({ error: expect.stringContaining('довший') });
  });

  it('kind поза gemini.* не звужується', () => {
    expect(sanitizeGeminiPayload('calendar.event', { title: 'x', startIso: 'y' })).toEqual({
      payload: { title: 'x', startIso: 'y' },
    });
  });
});

describe('ціна в пропозиції (S-8-5/S-8-6)', () => {
  const prices = { imageUsd: IMAGE_USD, videoUsd, defaultSeconds: VIDEO_DEFAULT_SECONDS };

  it('зображення - $0.04', () => {
    expect(proposalNotice('gemini.image', {}, prices)).toContain('$0.04');
  });

  it('відео 8 с - $3.20 і згадка про дешевшу Lite', () => {
    const text = proposalNotice('gemini.video', {}, prices);
    expect(text).toContain('8 с');
    expect(text).toContain('$3.20');
    expect(text).toContain('$0.60');
  });

  it('коротше відео - менша ціна, порахована, а не переписана', () => {
    expect(proposalNotice('gemini.video', { seconds: 4 }, prices)).toContain('$1.60');
    expect(proposalNotice('gemini.video', { seconds: 4, model: 'lite' }, prices)).toContain(
      '$0.30',
    );
  });

  it('для решти kind-ів рядка немає', () => {
    expect(proposalNotice('calendar.event', { title: 'x' }, prices)).toBe('');
  });
});

describe('барʼєр платного рівня (free tier заборонений у коді)', () => {
  it('без ключа - відмова', () => {
    const { env } = makeEnv({ GEMINI_API_KEY: undefined });
    expect(() => requirePaidGemini(env)).toThrow(/GEMINI_API_KEY не задано/);
  });

  it('GEMINI_TIER != paid - відмова з поясненням, жодного запиту', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { env } = makeEnv({ GEMINI_TIER: 'free' });
    await expect(generateImage(env, { prompt: 'кіт' })).rejects.toThrow(/Free tier навчається/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('policy: заплямована сесія', () => {
  it('після читання пошти генерація ВІДМОВЛЯЄ, а не просить ✅', async () => {
    const { env } = makeEnv();
    const out = await applyPolicy(
      env,
      { kind: 'gemini.image', payload: { prompt: 'кіт' }, tainted: true },
      NOW,
    );
    expect(out).toEqual({ mode: 'error', error: expect.stringContaining('/new') });
  });
});

describe('квота gemini_usd', () => {
  it('стеля місяця перевіряється ДО пропозиції', async () => {
    const { env, d1 } = makeEnv();
    d1.db.exec(
      `INSERT INTO quota_counters (key, period, value, limit_value, updated_at)
       VALUES ('gemini_usd', '2026-09', 9.9, 10, '2026-09-01T00:00:00.000Z')`,
    );
    const out = await applyPolicy(
      env,
      { kind: 'gemini.video', payload: { prompt: 'кіт' }, tainted: false },
      NOW,
    );
    expect(out).toEqual({ mode: 'error', error: expect.stringContaining('Стеля витрат Gemini') });
  });

  it('витрата рахується ПІСЛЯ генерації, навіть якщо доставка впала', async () => {
    const { env, d1 } = makeEnv();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
      String(url).includes('api.telegram.org')
        ? new Response('too big', { status: 400 })
        : new Response(
            JSON.stringify({
              candidates: [
                { content: { parts: [{ inlineData: { data: 'AAAA', mimeType: 'image/png' } }] } },
              ],
            }),
            { status: 200 },
          ),
    );
    const { result } = await approve(env, 'gemini.image', { prompt: 'кіт' });
    // Доставка впала - власник бачить помилку…
    expect(result).toMatchObject({ ok: false });
    // …але гроші списані, і стеля про це знає.
    const row = d1.db
      .prepare(`SELECT value FROM quota_counters WHERE key = 'gemini_usd'`)
      .get() as { value: number };
    expect(row.value).toBeCloseTo(IMAGE_USD, 5);
  });
});

describe('виконавці', () => {
  it('зображення: T1 → ✅ → фото в тред, витрата в лічильнику', async () => {
    const { env, d1 } = makeEnv();
    const sent: { method: string; hasPhoto: boolean }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.includes('api.telegram.org')) {
        const form = (init as RequestInit).body as FormData;
        sent.push({ method: u.split('/').pop() ?? '', hasPhoto: form.get('photo') != null });
        return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({
          candidates: [
            { content: { parts: [{ inlineData: { data: 'AAAA', mimeType: 'image/png' } }] } },
          ],
        }),
        { status: 200 },
      );
    });
    const { proposal, result } = await approve(env, 'gemini.image', { prompt: 'кіт у скафандрі' });
    expect(proposal.level).toBe('T1');
    expect(result).toMatchObject({ ok: true, result: { generated: 'image', usd: IMAGE_USD } });
    expect(sent).toEqual([{ method: 'sendPhoto', hasPhoto: true }]);
    const row = d1.db
      .prepare(`SELECT value FROM quota_counters WHERE key = 'gemini_usd'`)
      .get() as { value: number };
    expect(row.value).toBeCloseTo(IMAGE_USD, 5);
  });

  it('відео: T2 зі словом; довжина понад стелю зрізається до 8 с', async () => {
    const { env } = makeEnv();
    const bodies: unknown[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.includes('api.telegram.org')) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }), {
          status: 200,
        });
      }
      if (u.includes('predictLongRunning')) {
        bodies.push(JSON.parse(String((init as RequestInit).body)));
        return new Response(
          JSON.stringify({
            name: 'operations/x',
            done: true,
            response: {
              generateVideoResponse: {
                generatedSamples: [{ video: { uri: 'https://files/x.mp4' } }],
              },
            },
          }),
          { status: 200 },
        );
      }
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    });
    const { proposal, result } = await approve(env, 'gemini.video', {
      prompt: 'море',
      seconds: 60,
    });
    expect(proposal.level).toBe('T2');
    expect(proposal.word).toBeTruthy();
    expect(result).toMatchObject({ ok: true, result: { seconds: 8, usd: 3.2 } });
    expect(bodies[0]).toMatchObject({ parameters: { durationSeconds: 8 } });
  });

  it('Gemini відповів текстом замість картинки - причина видима', async () => {
    const { env } = makeEnv();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: 'політика забороняє' }] } }] }),
        { status: 200 },
      ),
    );
    const { result } = await approve(env, 'gemini.image', { prompt: 'x' });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('політика') });
  });

  it('у запит до Gemini їде РІВНО prompt і нічого більше', async () => {
    const { env } = makeEnv();
    let body: unknown = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).includes('api.telegram.org')) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
          status: 200,
        });
      }
      body = JSON.parse(String((init as RequestInit).body));
      return new Response(
        JSON.stringify({
          candidates: [
            { content: { parts: [{ inlineData: { data: 'AAAA', mimeType: 'image/png' } }] } },
          ],
        }),
        { status: 200 },
      );
    });
    await approve(env, 'gemini.image', { prompt: 'кіт' });
    expect(body).toEqual({ contents: [{ parts: [{ text: 'кіт' }] }] });
  });
});
