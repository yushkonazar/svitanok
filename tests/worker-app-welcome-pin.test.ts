import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// @ts-expect-error — JS-модуль Worker'а без типів.
import worker from '../web/worker.js';

/* Інтеграційні тести ensureAppWelcomePin (POST /api/telegram/setup).
 *
 * Замінює колишню щоденну churn-логіку «unpin учорашній брифінг -> pin
 * сьогоднішній» (та не мала сенсу, щойно з брифінгу прибрали inline-кнопку:
 * закріплялось повідомлення БЕЗ кнопки). Тепер — одне вітальне повідомлення з
 * кнопкою Mini App, закріплене ОДИН раз; повторний виклик setup — no-op,
 * якщо воно й досі закріплене (перевірка через getChat.pinned_message), і
 * self-healing (нове повідомлення + новий пін), якщо власник зняв закріплення
 * вручну чи видалив повідомлення.
 *
 * Той самий стиль, що worker-weather.test.ts: справжній worker.fetch, стаб fetch. */

const WEBHOOK_SECRET = 'tg-webhook-secret-abcdef';

let kv: Map<string, string>;
let calls: { method: string; body: Record<string, unknown> }[];
let pinnedMessageId: number | null;
let nextSentMessageId: number;
let getChatFails: boolean;

function env(overrides: Record<string, unknown> = {}) {
  return {
    BRIEFING: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => void kv.set(k, v),
      list: async () => ({ keys: [] }),
    },
    TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    TELEGRAM_BOT_TOKEN: 'bot-token',
    TELEGRAM_CHAT_ID: '-100555',
    ...overrides,
  };
}

async function callSetup(e = env()) {
  return worker.fetch(
    new Request('https://svitanok.example/api/telegram/setup', {
      method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET },
    }),
    e,
    { waitUntil: () => {} },
  );
}

beforeEach(() => {
  kv = new Map();
  calls = [];
  pinnedMessageId = null;
  nextSentMessageId = 900;
  getChatFails = false;
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = url.split('/').pop() ?? '';
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ method, body });

    if (method === 'getChat') {
      if (getChatFails) return new Response('down', { status: 500 });
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            id: body.chat_id,
            pinned_message: pinnedMessageId != null ? { message_id: pinnedMessageId } : undefined,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (method === 'sendMessage') {
      const id = nextSentMessageId++;
      return new Response(JSON.stringify({ ok: true, result: { message_id: id } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (method === 'pinChatMessage') {
      pinnedMessageId = body.message_id;
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    // setWebhook/setMyCommands/setMyDescription/setMyShortDescription/setChatMenuButton
    return new Response(JSON.stringify({ ok: true, result: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const welcomeSends = () => calls.filter((c) => c.method === 'sendMessage');
const pins = () => calls.filter((c) => c.method === 'pinChatMessage');

describe('ensureAppWelcomePin (/api/telegram/setup)', () => {
  it('перший виклик: немає закріпленого -> шле вітальне повідомлення з кнопкою і закріплює', async () => {
    await callSetup();

    expect(welcomeSends()).toHaveLength(1);
    expect(welcomeSends()[0]?.body).toMatchObject({
      chat_id: '-100555',
      parse_mode: 'HTML',
    });
    expect(welcomeSends()[0]?.body.reply_markup).toMatchObject({
      inline_keyboard: [[{ text: '📊 Відкрити Mini App' }]],
    });
    expect(pins()).toHaveLength(1);
    expect(JSON.parse(kv.get('state') ?? '{}').appWelcomePinMsgId).toBe(900);
  });

  it('повторний виклик: наше повідомлення й досі закріплене -> no-op, без дубля', async () => {
    await callSetup();
    await callSetup();

    expect(welcomeSends()).toHaveLength(1);
    expect(pins()).toHaveLength(1);
  });

  it('власник зняв закріплення вручну -> self-healing: нове повідомлення + новий пін', async () => {
    await callSetup();
    pinnedMessageId = null; // власник зняв пін

    await callSetup();

    expect(welcomeSends()).toHaveLength(2);
    expect(pins()).toHaveLength(2);
    expect(JSON.parse(kv.get('state') ?? '{}').appWelcomePinMsgId).toBe(901);
  });

  it('закріплене інше повідомлення (не наше) -> теж вважаємо втраченим, перезакріплюємо', async () => {
    await callSetup();
    pinnedMessageId = 42; // хтось закріпив щось інше поверх

    await callSetup();

    expect(welcomeSends()).toHaveLength(2);
    expect(pins()).toHaveLength(2);
  });

  it('getChat падає (мережа/таймаут) — пропускає цикл, НЕ шле дубль вітального повідомлення', async () => {
    await callSetup();
    getChatFails = true;

    await callSetup();

    // Транзієнтний збій getChat не повинен трактуватись як «пін загублено» —
    // інакше одна флуктуація сіяла б ще один дубль щодня (крон кличе це
    // безумовно раз на добу). Замість цього — тихо пропустити цикл, наступний
    // виклик (коли getChat знову відповість) сам підтвердить чи полагодить.
    expect(welcomeSends()).toHaveLength(1);
    expect(pins()).toHaveLength(1);
  });

  it('без TELEGRAM_CHAT_ID — тихо пропускає, інші кроки setup не ламає', async () => {
    const res = await callSetup(env({ TELEGRAM_CHAT_ID: undefined }));

    expect(res.status).toBe(200);
    expect(welcomeSends()).toHaveLength(0);
    expect(pins()).toHaveLength(0);
  });
});
