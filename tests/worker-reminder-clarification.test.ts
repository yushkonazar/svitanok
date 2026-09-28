import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../web/worker.js';
import { d1FromSqlite } from './helpers/d1.js';
import { memoryKv } from './helpers/kv.js';
import { workerEnv } from './helpers/env.js';

/* Коротке уточнення нагадування має бути кодовим, а не надією на пам'ять
   моделі. Це точна жива регресія: «Нагадай про тест» → «Завтра вранці» раніше
   закінчувалась питанням «Що саме зробити завтра вранці?». */

const OWNER = 4242;
const SECRET = 'telegram-webhook-secret-for-reminder-flow';
const NOW = Date.parse('2026-09-28T21:16:00.000Z'); // 00:16 Київ, 29 вересня; «завтра» = 30-те
const MIGRATIONS = [
  '0001_base.sql',
  '0002_assistant.sql',
  '0010_reminders_address.sql',
  '0012_reminders_recurrence.sql',
];

type TelegramCall = { method: string; body: Record<string, unknown> };

let state: Map<string, string>;
let d1: ReturnType<typeof d1FromSqlite>;
let telegram: TelegramCall[];

function env() {
  return workerEnv({
    ASSISTANT_V2: 'on',
    BRIEFING: memoryKv(state),
    DB: d1.stub,
    TELEGRAM_WEBHOOK_SECRET: SECRET,
    TELEGRAM_BOT_TOKEN: 'bot-token',
    TELEGRAM_CHAT_ID: String(OWNER),
    TELEGRAM_OWNER_USER_ID: String(OWNER),
  });
}

function ctx() {
  const tasks: Promise<unknown>[] = [];
  return {
    waitUntil: (task: Promise<unknown>) => void tasks.push(task),
    passThroughOnException: () => {},
    settle: () => Promise.all(tasks),
  };
}

async function message(text: string, updateId: number) {
  const c = ctx();
  await worker.fetch(
    new Request('https://svitanok.example/api/telegram', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': SECRET },
      body: JSON.stringify({
        update_id: updateId,
        message: { message_id: updateId, chat: { id: OWNER }, from: { id: OWNER }, text },
      }),
    }),
    env(),
    c,
  );
  await c.settle();
}

async function tapReminderTime(data: string, updateId: number, messageId = 100) {
  const c = ctx();
  await worker.fetch(
    new Request('https://svitanok.example/api/telegram', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': SECRET },
      body: JSON.stringify({
        update_id: updateId,
        callback_query: {
          id: `callback-${updateId}`,
          from: { id: OWNER },
          data,
          message: {
            message_id: messageId,
            chat: { id: OWNER },
            text: '⏰ Коли нагадати про «тест»?',
            reply_markup: {
              inline_keyboard: [[{ text: '🕘 Завтра о 09:00', callback_data: data }]],
            },
          },
        },
      }),
    }),
    env(),
    c,
  );
  await c.settle();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  state = new Map();
  d1 = d1FromSqlite(MIGRATIONS);
  telegram = [];
  let messageId = 100;
  vi.stubGlobal('fetch', async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    if (url.includes('api.telegram.org')) {
      const method = url.split('/').at(-1) ?? '';
      const body = init.body ? JSON.parse(String(init.body)) : {};
      telegram.push({ method, body });
      return new Response(JSON.stringify({ ok: true, result: { message_id: messageId++ } }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', { status: 404 });
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  d1.db.close();
});

const sentTexts = () =>
  telegram
    .filter((call) => call.method === 'sendMessage')
    .map((call) => String(call.body.text ?? ''));

describe('V2 уточнення нагадування', () => {
  it('зберігає предмет і створює нагадування після відповіді з точною годиною', async () => {
    await message('Нагадай про тест', 1);
    expect(sentTexts().at(-1)).toContain('⏰ Коли нагадати про «тест»?');
    expect(telegram.at(-1)?.body.reply_markup).toMatchObject({
      inline_keyboard: [[{ text: '🌅 Завтра вранці' }, { text: '🕘 Завтра о 09:00' }]],
    });
    const button = String(
      (telegram.at(-1)?.body.reply_markup as { inline_keyboard: { callback_data: string }[][] })
        .inline_keyboard[0]?.[1]?.callback_data,
    );
    expect(button).toMatch(/^m:rt:[a-f0-9]{10}:nine$/);

    await message('Завтра о 09:00', 2);

    const reminders = d1.db
      .prepare('SELECT text, due_at, status FROM reminders ORDER BY due_at')
      .all() as { text: string; due_at: string; status: string }[];
    expect(reminders).toEqual([
      expect.objectContaining({
        text: 'тест',
        due_at: '2026-09-30T06:00:00.000Z',
        status: 'pending',
      }),
    ]);
    expect(sentTexts().at(-1)).toBe('⏰ Нагадаю завтра о 09:00: тест.');
    expect(telegram.at(-1)?.body.reply_markup).toMatchObject({
      inline_keyboard: [[{ text: '↩ Скасувати' }]],
    });
  });

  it('для «завтра вранці» обирає вільну годину, але не губить предмет', async () => {
    await message('Нагадай про тест', 1);
    await message('Завтра вранці', 2);

    const reminder = d1.db.prepare('SELECT text, due_at FROM reminders').get() as {
      text: string;
      due_at: string;
    };
    expect(reminder).toEqual({ text: 'тест', due_at: '2026-09-30T04:00:00.000Z' });
    expect(sentTexts().at(-1)).toBe('⏰ Нагадаю завтра о 07:00: тест.');
  });

  it('натискання швидкого часу оновлює саме питання на результат із кнопкою відкату', async () => {
    await message('Нагадай про тест', 1);
    const data = String(
      (telegram.at(-1)?.body.reply_markup as { inline_keyboard: { callback_data: string }[][] })
        .inline_keyboard[0]?.[1]?.callback_data,
    );
    await tapReminderTime(data, 2);

    const edited = telegram.find((call) => call.method === 'editMessageText');
    expect(edited?.body).toMatchObject({
      message_id: 100,
      text: '⏰ Нагадаю завтра о 09:00: тест.',
      reply_markup: { inline_keyboard: [[{ text: '↩ Скасувати' }]] },
    });
    expect(telegram.find((call) => call.method === 'answerCallbackQuery')?.body.text).toBe(
      'Ставлю нагадування…',
    );
  });

  it('стара кнопка не застосовує відповідь до нового питання в тому самому чаті', async () => {
    await message('Нагадай про перший тест', 1);
    const staleData = String(
      (telegram.at(-1)?.body.reply_markup as { inline_keyboard: { callback_data: string }[][] })
        .inline_keyboard[0]?.[1]?.callback_data,
    );
    await message('Нагадай про другий тест', 2);
    const currentData = String(
      (telegram.at(-1)?.body.reply_markup as { inline_keyboard: { callback_data: string }[][] })
        .inline_keyboard[0]?.[1]?.callback_data,
    );

    await tapReminderTime(staleData, 3, 100);
    expect(d1.db.prepare('SELECT count(*) AS count FROM reminders').get()).toEqual({ count: 0 });
    expect(telegram.find((call) => call.method === 'editMessageText')?.body.text).toContain(
      'вже неактуальне',
    );

    await tapReminderTime(currentData, 4, 101);
    expect(d1.db.prepare('SELECT text FROM reminders').get()).toEqual({ text: 'другий тест' });
  });
});
