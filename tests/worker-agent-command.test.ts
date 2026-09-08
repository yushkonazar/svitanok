import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../web/worker.js';
import { COMMANDS } from '../web/tg-core.mjs';
import { memoryKv } from './helpers/kv.js';
import { workerEnv } from './helpers/env.js';

/* /agent (PR-11) — статичний перелік можливостей АСИСТЕНТА (вільний текст),
   окремо від /help (slash-команди бота). Не чіпає промпт/схема-бюджет хоста —
   звичайна sendText-команда, той самий мінімальний стиль, що інші легкі
   command-тести (без Google-секретів — вони тут не потрібні). */

const WEBHOOK_SECRET = 'tg-webhook-secret-abcdef';
const OWNER = 4242;

let kv: Map<string, string>;
let tg: { method: string; body: Record<string, unknown> }[];

function env() {
  return workerEnv({
    BRIEFING: memoryKv(kv),
    TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    TELEGRAM_BOT_TOKEN: 'bot-token',
    TELEGRAM_OWNER_USER_ID: String(OWNER),
  });
}

function ctx() {
  const promises: Promise<unknown>[] = [];
  return {
    waitUntil: (p: Promise<unknown>) => void promises.push(p),
    settle: () => Promise.all(promises),
  };
}

async function sendCommand(text: string, updateId = 1) {
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
    env(),
    c,
  );
  await c.settle();
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

afterEach(() => vi.unstubAllGlobals());

const sentText = () => tg.find((c) => c.method === 'sendMessage')?.body.text as string | undefined;

describe('/agent — перелік можливостей асистента (PR-11)', () => {
  it('відповідає HTML-текстом, що згадує ключові можливості (календар/нагадування/чек-ін/налаштування)', async () => {
    await sendCommand('/agent');
    const text = sentText();
    expect(text).toContain('Що вміє асистент');
    expect(text).toContain('Календар');
    expect(text).toContain('Нагадування');
    expect(text).toContain('Чек-ін');
    expect(text).toContain('Налаштування');
    expect(tg[0]?.body.parse_mode).toBe('HTML');
  });

  // ⚠️ Від 08.09 /agent у меню немає (реліз, скарга 2): «що вміє асистент» -
  // це /help, а обробник /agent лишився для тих, хто набере руками.
  it('COMMANDS реєструє рівно вісім команд плюс /start', () => {
    expect(COMMANDS.map((c: { command: string }) => c.command)).toEqual([
      'start',
      'help',
      'plan',
      'remind',
      'brief',
      'status',
      'clear',
      'new',
      'forget',
    ]);
  });
});

describe('/help не дрейфує від COMMANDS (регресія, знайдена дослідженням)', () => {
  it('текст /help перелічує рівно те, що в меню', async () => {
    await sendCommand('/help');
    const text = sentText();
    for (const c of COMMANDS as { command: string }[]) {
      if (c.command === 'start') continue;
      expect(text, c.command).toContain(`/${c.command}`);
    }
  });
});
