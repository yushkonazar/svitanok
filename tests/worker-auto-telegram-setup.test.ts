import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// @ts-expect-error — JS-модуль Worker'а без типів.
import worker from '../web/worker.js';

/* Інтеграційні тести autoTelegramSetup (щоденний самозапуск /api/telegram/setup
 * з крону) — власник більше не мусить руками виконувати curl після зміни
 * команд/опису/кнопки-меню чи якщо вебхук/пін загубився.
 *
 * Гейт на env.MINI_APP_URL (Worker-секрет, той самий origin, що вже є в
 * оркестраторі) — поза HTTP-запитом (тут — крон) немає request.url, звідки
 * інакше береться origin. Усі кроки runTelegramSetup ідемпотентні, тож
 * щоденний повтор безпечний (self-healing) — перевіряємо саме це: перший тік
 * дня реєструє, другий тік того самого дня — no-op, наступний день — знову.
 *
 * Той самий стиль, що worker-agenda.test.ts: справжній worker.scheduled,
 * стаб fetch, ФІКСОВАНИЙ годинник (vi.useFakeTimers) — інакше тест сам стане
 * тікаючою бомбою від дато-математики kyivDateKey(). */

let kv: Map<string, string>;
let calls: string[];

function env(overrides: Record<string, unknown> = {}) {
  return {
    BRIEFING: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => void kv.set(k, v),
      list: async () => ({ keys: [] }),
    },
    TELEGRAM_WEBHOOK_SECRET: 'tg-webhook-secret',
    TELEGRAM_BOT_TOKEN: 'bot-token',
    MINI_APP_URL: 'https://svitanok.example.workers.dev',
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

async function tick(e = env()) {
  const c = ctx();
  await worker.scheduled({}, e, c);
  await c.settle();
  return e;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-27T09:00:00Z'));
  kv = new Map();
  calls = [];
  vi.stubGlobal('fetch', async (input: unknown) => {
    const method = String(input).split('/').pop() ?? '';
    calls.push(method);
    if (method === 'getChat') {
      return new Response(JSON.stringify({ ok: true, result: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (method === 'sendMessage') {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ok: true, result: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const setupCalls = () =>
  calls.filter((m) =>
    [
      'setWebhook',
      'setMyCommands',
      'setMyDescription',
      'setMyShortDescription',
      'setChatMenuButton',
    ].includes(m),
  );

describe('autoTelegramSetup (крон, раз на добу)', () => {
  it('без MINI_APP_URL — жодного Telegram-виклику setup, крон не ламається', async () => {
    await tick(env({ MINI_APP_URL: undefined }));
    expect(setupCalls()).toHaveLength(0);
  });

  it('перший тік дня — реєструє вебхук/меню/профіль/кнопку і ставить дату', async () => {
    const e = await tick();
    expect(setupCalls()).toEqual([
      'setWebhook',
      'setMyCommands',
      'setMyDescription',
      'setMyShortDescription',
      'setChatMenuButton',
    ]);
    expect(JSON.parse(kv.get('state') ?? '{}').telegramSetupDate).toBe('2026-07-27');
    void e;
  });

  it('другий тік того самого дня — no-op (дата вже сьогоднішня)', async () => {
    await tick();
    calls.length = 0;
    await tick();
    expect(setupCalls()).toHaveLength(0);
  });

  it('наступний день — реєструє знову (щоденний self-healing)', async () => {
    await tick();
    vi.setSystemTime(new Date('2026-07-28T09:00:00Z'));
    calls.length = 0;
    await tick();
    expect(setupCalls()).toHaveLength(5);
    expect(JSON.parse(kv.get('state') ?? '{}').telegramSetupDate).toBe('2026-07-28');
  });
});
