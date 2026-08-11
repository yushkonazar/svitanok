import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// @ts-expect-error — JS-модуль Worker'а без типів.
import worker from '../web/worker.js';

/* B23 (аудит 11.08.2026, підтверджено власником НАЖИВО — T4/T6/T7).
 *
 * `if (/нагад/i.test(text)) createReminderFromText(...)` перехоплював будь-яке
 * повідомлення зі словом «нагад» ДО того, як його побачить агент. Парсер уміє
 * рівно одне — зрізати час і покласти решту тексту в тіло, тож:
 *   «Скасуй нагадування про молоко і постав натомість на четвер» -> створене ЩЕ
 *     ОДНЕ нагадування з дослівним текстом, старе живе далі;
 *   «Заплануй зустріч о 15:00 і нагадай за годину до неї» -> нагадування на
 *     15:00 (не 14:00), події немає.
 * Тобто агентські cancelReminder/updateReminder були недосяжні природною мовою.
 *
 * Тести тримають ОБИДВІ гілки: складний намір іде до агента, а звичайне
 * «нагадай ‹що› ‹коли›» лишається на швидкому детермінованому парсері. */

const WEBHOOK_SECRET = 'tg-webhook-secret-abcdef';
const OWNER = 4242;
const HOST = 'https://llm.example/llm';

let kv: Map<string, string>;
let tg: { method: string; body: Record<string, unknown> }[];
let agentCalls: { url: string; body: Record<string, unknown> }[];
let llmCalls: number;

function env(overrides: Record<string, unknown> = {}) {
  return {
    BRIEFING: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => void kv.set(k, v),
      list: async () => ({ keys: [] }),
    },
    TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    TELEGRAM_BOT_TOKEN: 'bot-token',
    TELEGRAM_CHAT_ID: String(OWNER),
    TELEGRAM_OWNER_USER_ID: String(OWNER),
    LLM_HOST_URL: HOST,
    LLM_HOST_SECRET: 'host-secret',
    ...overrides,
  };
}

function ctx() {
  const promises: Promise<unknown>[] = [];
  return {
    waitUntil: (p: Promise<unknown>) => void promises.push(p),
    settle: () => Promise.all(promises),
  };
}

async function send(text: string, e = env(), updateId = 1) {
  const c = ctx();
  await worker.fetch(
    new Request('https://svitanok.example/api/telegram', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET,
      },
      body: JSON.stringify({
        update_id: updateId,
        message: { message_id: 1, chat: { id: OWNER }, from: { id: OWNER }, text },
      }),
    }),
    e,
    c,
  );
  await c.settle();
}

const remindersInKv = () => JSON.parse(kv.get('state') ?? '{}').reminders ?? [];
const sentTexts = () =>
  tg.filter((c) => c.method === 'sendMessage').map((c) => String(c.body.text ?? ''));

beforeEach(() => {
  kv = new Map();
  tg = [];
  agentCalls = [];
  llmCalls = 0;
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (url.includes('api.telegram.org')) {
      tg.push({ method: url.split('/').pop() ?? '', body });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/agent')) {
      agentCalls.push({ url, body });
      return new Response(JSON.stringify({ ok: true }), { status: 202 });
    }
    if (url.endsWith('/llm')) {
      // LLM-рерайт нечіткої фрази в канонічний патерн. Тут він НАВМИСНО
      // «успішний»: інакше стара (бажана до фіксу) гілка тихо впала б у
      // agentFallback, і тест не побачив би різниці між «фікс працює» і
      // «парсер просто не впорався».
      llmCalls++;
      return new Response(
        JSON.stringify({ ok: true, structured: { rewritten: 'завтра о 10:00' } }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('роутинг «нагад» — складний намір доходить до агента', () => {
  it('«Скасуй нагадування … і постав натомість …» -> агент, а не дубль нагадування', async () => {
    await send('Скасуй нагадування про молоко і постав натомість на четвер');

    expect(agentCalls).toHaveLength(1);
    expect(remindersInKv()).toHaveLength(0); // головне: НЕ створили ще одне
    expect(sentTexts().some((t) => t.includes('Працюю'))).toBe(true);
  });

  it('«Перенеси нагадування … на 20:00» -> агент (updateReminder досяжний)', async () => {
    await send('Перенеси нагадування про молоко на 20:00');

    expect(agentCalls).toHaveLength(1);
    expect(remindersInKv()).toHaveLength(0);
  });

  it('«Заплануй зустріч о 15:00 і нагадай за годину до неї» -> агент (T4)', async () => {
    await send('Заплануй зустріч о 15:00 і нагадай за годину до неї');

    expect(agentCalls).toHaveLength(1);
    expect(remindersInKv()).toHaveLength(0);
    expect(llmCalls).toBe(0); // рерайт нагадування тут узагалі не потрібен
  });
});

describe('роутинг «нагад» — звичайне нагадування лишається на парсері', () => {
  it('«нагадай купити молоко о 18:00» -> нагадування в KV, БЕЗ агента й БЕЗ LLM', async () => {
    await send('нагадай купити молоко о 18:00');

    expect(agentCalls).toHaveLength(0);
    expect(llmCalls).toBe(0); // детермінований парсер упорався сам
    const rem = remindersInKv();
    expect(rem).toHaveLength(1);
    expect(rem[0].text).toBe('купити молоко');
  });

  it('дієслово-мутація в ТІЛІ нагадування не тягне до агента', async () => {
    await send('нагадай оновити резюме о 18:00');

    expect(agentCalls).toHaveLength(0);
    expect(remindersInKv()[0].text).toBe('оновити резюме');
  });
});

describe('роутинг «нагад» — аварійний вимикач', () => {
  it('REMINDER_INTENT_ROUTING=0 повертає стару (жадібну) поведінку', async () => {
    // Поведінкова зміна в щоденному інструменті власника: якщо класифікатор
    // почне заважати, відкат — одна змінна оточення, без релізу.
    await send(
      'Скасуй нагадування про молоко і постав натомість на четвер',
      env({ REMINDER_INTENT_ROUTING: '0' }),
    );

    expect(agentCalls).toHaveLength(0);
    expect(llmCalls).toBe(1); // пішло старим шляхом: парсер -> LLM-рерайт
    expect(remindersInKv()).toHaveLength(1);
  });
});
