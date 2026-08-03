import { describe, it, expect, beforeEach, vi } from 'vitest';
// @ts-expect-error — JS-модуль Worker'а без типів.
import worker from '../web/worker.js';

/* TELEGRAM_ALLOWED_USER_IDS (кілька учасників супергрупи можуть користуватись
 * тим самим ботом/Mini App) — перевіряємо ОБИДВА шляхи авторизації, які
 * читають цей список: вебхук (isOwner, tg-core.mjs) і Mini App (checkOwner,
 * worker.js). Той самий стиль харнесу, що worker-agent-command.test.ts
 * (вебхук) + worker-weather.test.ts (initData). */

const WEBHOOK_SECRET = 'tg-webhook-secret-abcdef';
const OWNER = 4242;
const FRIEND = 5151;
const STRANGER = 9999;
const BOT_TOKEN = 'bot-token-abc';

let kv: Map<string, string>;
let tg: { method: string; body: Record<string, unknown> }[];

function env(overrides: Record<string, unknown> = {}) {
  return {
    BRIEFING: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => void kv.set(k, v),
      list: async () => ({ keys: [] }),
    },
    TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    TELEGRAM_OWNER_USER_ID: String(OWNER),
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

async function sendCommand(fromId: number, text: string, e = env(), updateId = 1) {
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
        message: { message_id: 1, chat: { id: fromId }, from: { id: fromId }, text },
      }),
    }),
    e,
    c,
  );
  await c.settle();
}

/** Той самий HMAC-алгоритм Telegram WebApp initData, що worker.js validateInitData. */
async function buildInitData(userId: number, botToken: string) {
  const user = JSON.stringify({ id: userId, first_name: 'U' });
  const authDate = Math.floor(Date.now() / 1000);
  const params = new URLSearchParams({ user, auth_date: String(authDate) });
  const dataCheck = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode('WebAppData'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const secretBytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(botToken)));
  const secretKey = await crypto.subtle.importKey(
    'raw',
    secretBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', secretKey, enc.encode(dataCheck)));
  const hash = [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
  params.set('hash', hash);
  return params.toString();
}

async function getStats(initData: string, e: Record<string, unknown>) {
  return worker.fetch(
    new Request('https://svitanok.example/api/stats', {
      headers: { 'X-Telegram-Init-Data': initData },
    }),
    e,
    { waitUntil: () => {} },
  );
}

beforeEach(() => {
  kv = new Map();
  tg = [];
  vi.stubGlobal('fetch', async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    if (url.includes('api.telegram.org')) {
      tg.push({ method: url.split('/').pop()!, body: JSON.parse(String(init.body ?? '{}')) });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', { status: 200 });
  });
});

describe('вебхук — TELEGRAM_ALLOWED_USER_IDS', () => {
  it('без TELEGRAM_ALLOWED_USER_IDS — інший учасник тихо ігнорується (як і зараз)', async () => {
    await sendCommand(FRIEND, '/help');
    expect(tg).toHaveLength(0);
  });

  it('з TELEGRAM_ALLOWED_USER_IDS — учасник зі списку отримує відповідь', async () => {
    await sendCommand(FRIEND, '/help', env({ TELEGRAM_ALLOWED_USER_IDS: String(FRIEND) }));
    expect(tg.length).toBeGreaterThan(0);
  });

  it('з TELEGRAM_ALLOWED_USER_IDS — сторонній (не в списку) і далі тихо ігнорується', async () => {
    await sendCommand(
      STRANGER,
      '/help',
      env({ TELEGRAM_ALLOWED_USER_IDS: `${FRIEND},${STRANGER + 1}` }),
    );
    expect(tg).toHaveLength(0);
  });

  it('власник лишається дозволеним НАВІТЬ коли TELEGRAM_ALLOWED_USER_IDS заданий', async () => {
    await sendCommand(OWNER, '/help', env({ TELEGRAM_ALLOWED_USER_IDS: String(FRIEND) }));
    expect(tg.length).toBeGreaterThan(0);
  });

  it('декілька id через кому (з пробілами) — усі розпізнаються', async () => {
    await sendCommand(FRIEND, '/help', env({ TELEGRAM_ALLOWED_USER_IDS: ` ${FRIEND} , 777 ` }));
    expect(tg.length).toBeGreaterThan(0);
  });
});

describe('Mini App (/api/stats) — TELEGRAM_ALLOWED_USER_IDS', () => {
  it('без TELEGRAM_ALLOWED_USER_IDS — 403 для не-власника', async () => {
    const initData = await buildInitData(FRIEND, BOT_TOKEN);
    const res = await getStats(initData, env());
    expect(res.status).toBe(403);
  });

  it('з TELEGRAM_ALLOWED_USER_IDS — 200 для учасника зі списку', async () => {
    const initData = await buildInitData(FRIEND, BOT_TOKEN);
    const res = await getStats(initData, env({ TELEGRAM_ALLOWED_USER_IDS: String(FRIEND) }));
    expect(res.status).toBe(200);
  });

  it('з TELEGRAM_ALLOWED_USER_IDS — 403 для стороннього поза списком', async () => {
    const initData = await buildInitData(STRANGER, BOT_TOKEN);
    const res = await getStats(initData, env({ TELEGRAM_ALLOWED_USER_IDS: String(FRIEND) }));
    expect(res.status).toBe(403);
  });
});
