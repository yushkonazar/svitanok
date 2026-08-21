import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// @ts-expect-error — JS-модуль Worker'а без типів.
import worker from '../web/worker.js';
import { memoryKv } from './helpers/kv.js';

/* Інтеграційні тести /agenda + ev:<action>:<id> — інтерактивний список
   найближчих подій (CRUD, покращення "покращити вивід активних подій").
   Той самий стиль, що worker-proposal-accept.test.ts: справжній worker.fetch,
   стаб fetch для Telegram/Google. */

const WEBHOOK_SECRET = 'tg-webhook-secret-abcdef';
const OWNER = 4242;

let kv: Map<string, string>;
let tg: { method: string; body: Record<string, unknown> }[];
let cal: Record<string, unknown>[];
let googleEvents: Map<
  string,
  { summary: string; start: { dateTime: string }; end: { dateTime: string }; location?: string }
>;

function env() {
  return {
    BRIEFING: {
      ...memoryKv(kv),
    },
    TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    TELEGRAM_BOT_TOKEN: 'bot-token',
    TELEGRAM_OWNER_USER_ID: String(OWNER),
    GOOGLE_CLIENT_ID: 'gid',
    GOOGLE_CLIENT_SECRET: 'gsecret',
    GOOGLE_REFRESH_TOKEN: 'grefresh',
  };
}

function ctx() {
  const promises: Promise<unknown>[] = [];
  return {
    waitUntil: (p: Promise<unknown>) => void promises.push(p),
    settle: () => Promise.all(promises),
  };
}

async function post(update: Record<string, unknown>) {
  const c = ctx();
  await worker.fetch(
    new Request('https://svitanok.example/api/telegram', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET,
      },
      body: JSON.stringify(update),
    }),
    env(),
    c,
  );
  await c.settle();
}

const sendCommand = (text: string, updateId = 1) =>
  post({
    update_id: updateId,
    message: { message_id: 1, chat: { id: OWNER }, from: { id: OWNER }, text },
  });

const tapAgenda = (data: string, updateId = 2000) =>
  post({
    update_id: updateId,
    callback_query: {
      id: 'cbq1',
      from: { id: OWNER },
      data,
      message: {
        message_id: 700,
        chat: { id: OWNER },
        reply_markup: { inline_keyboard: [[{ text: 'x', callback_data: data }]] },
      },
    },
  });

const toast = () =>
  tg.find((c) => c.method === 'answerCallbackQuery')?.body.text as string | undefined;
const lastSendText = () =>
  [...tg].reverse().find((c) => c.method === 'sendMessage')?.body.text as string | undefined;
const lastEditText = () =>
  [...tg].reverse().find((c) => c.method === 'editMessageText')?.body as
    | {
        text: string;
        reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] };
      }
    | undefined;

beforeEach(() => {
  // Фікстури нижче хардкодять '2026-07-24' як "майбутню" подію відносно
  // якогось ранішого "зараз" — без пінінгу годинника цей файл був тіканням
  // бомби: тест ламався сам собою, щойно реальний UTC-час переступав 12:00
  // того самого дня (now-фільтр /agenda рахує за startMs, не endMs). Пінимо
  // "зараз" ДО 12:00 UTC, як і решта файлів цього проєкту (worker-agent-step.test.ts).
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-24T09:00:00Z'));

  kv = new Map();
  tg = [];
  cal = [];
  googleEvents = new Map([
    [
      'ev1',
      {
        summary: 'Стендап',
        start: { dateTime: '2026-07-24T12:00:00Z' },
        end: { dateTime: '2026-07-24T13:00:00Z' },
      },
    ],
    [
      'evPast',
      {
        summary: 'Вчорашнє',
        start: { dateTime: '2026-01-01T09:00:00Z' },
        end: { dateTime: '2026-01-01T10:00:00Z' },
      },
    ],
  ]);
  vi.stubGlobal('fetch', async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    if (url.includes('api.telegram.org')) {
      tg.push({ method: url.split('/').pop()!, body: JSON.parse(String(init.body ?? '{}')) });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    const single = url.match(/googleapis\.com\/calendar\/v3\/calendars\/primary\/events\/([^/?]+)/);
    if (single) {
      const id = single[1]!;
      const method = init.method ?? 'GET';
      const ev = googleEvents.get(id);
      if (method === 'GET') {
        return ev
          ? new Response(JSON.stringify({ id, ...ev }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          : new Response('{}', { status: 404 });
      }
      if (method === 'PATCH') {
        if (!ev) return new Response('{}', { status: 404 });
        const patch = JSON.parse(String(init.body ?? '{}'));
        cal.push({ _method: 'PATCH', _id: id, ...patch });
        googleEvents.set(id, { ...ev, ...patch });
        return new Response('{}', { status: 200 });
      }
      if (method === 'DELETE') {
        cal.push({ _method: 'DELETE', _id: id });
        googleEvents.delete(id);
        return new Response('{}', { status: ev ? 200 : 404 });
      }
    }
    // events.list (/agenda, readUpcomingWeek) -> усі відомі події (тест не фільтрує за timeMin/timeMax —
    // now-фільтр перевіряється у formatAgendaMessage самим worker-кодом, тут лише постачаємо дані).
    if (url.includes('googleapis.com/calendar/v3/calendars/primary/events?')) {
      return new Response(
        JSON.stringify({
          items: [...googleEvents.entries()].map(([id, e]) => ({
            id,
            summary: e.summary,
            start: e.start,
            end: e.end,
          })),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('{}', { status: 200 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('/agenda — список найближчих подій', () => {
  it('показує майбутню подію, ховає минулу (now-фільтр)', async () => {
    await sendCommand('/agenda');
    const text = lastSendText();
    expect(text).toContain('Стендап');
    expect(text).not.toContain('Вчорашнє');
  });

  it('клавіатура має кнопку на майбутню подію (ev:v:<id>)', async () => {
    await sendCommand('/agenda');
    const call = [...tg].reverse().find((c) => c.method === 'sendMessage');
    const kb = (call?.body.reply_markup as { inline_keyboard: { callback_data: string }[][] })
      .inline_keyboard;
    expect(kb.flat().some((b) => b.callback_data === 'ev:v:ev1')).toBe(true);
  });
});

describe('ev:v — деталі пункту', () => {
  it('рендерить назву/час + Редагувати/Видалити/Назад', async () => {
    await tapAgenda('ev:v:ev1');
    const edited = lastEditText();
    expect(edited?.text).toContain('Стендап');
    const flat = edited?.reply_markup?.inline_keyboard.flat() ?? [];
    expect(flat.some((b) => b.text.includes('Редагувати'))).toBe(true);
    expect(flat.some((b) => b.text.includes('Видалити'))).toBe(true);
    expect(flat.some((b) => b.text.includes('Назад'))).toBe(true);
  });

  it('невідомий id (подія зникла) -> чесний toast, не падає', async () => {
    await tapAgenda('ev:v:noSuchEvent');
    expect(toast()).toContain('вже не знайти');
  });

  it('location (PR-12) -> клікабельне Maps-посилання під назвою; без location -> без рядка', async () => {
    googleEvents.set('evLoc', {
      summary: 'Кава',
      location: 'Кав’ярня на розі',
      start: { dateTime: '2026-07-24T12:00:00Z' },
      end: { dateTime: '2026-07-24T13:00:00Z' },
    });
    await tapAgenda('ev:v:evLoc', 2001);
    const withLoc = lastEditText();
    expect(withLoc?.text).toContain('📍 <a href="https://www.google.com/maps/search/?api=1&query=');
    expect(withLoc?.text).toContain('Кав’ярня на розі</a>');

    await tapAgenda('ev:v:ev1', 2002); // без location у фікстурі
    expect(lastEditText()?.text).not.toContain('📍');
  });
});

describe('ev:e / ev:d — стейджити редагування/видалення з /agenda', () => {
  it('ev:e стейджить updateEvent-пропозицію (shiftMin=0, «як заплановано»)', async () => {
    await tapAgenda('ev:e:ev1');
    const sent = lastSendText();
    expect(sent).toContain('без змін'); // щойно застейджено, ще нічого не циклили
    expect(toast()).toContain('змінити');

    const pending = JSON.parse(kv.get('assistantPending')!);
    expect(pending.items[0]).toMatchObject({ kind: 'updateEvent', eventId: 'ev1', shiftMin: 0 });
    expect(pending.items[0].base.title).toBe('Стендап');
  });

  it('ev:d стейджить deleteEvent-пропозицію (Так/Ні)', async () => {
    await tapAgenda('ev:d:ev1');
    const sent = lastSendText();
    expect(sent).toContain('Стендап');
    const call = [...tg].reverse().find((c) => c.method === 'sendMessage');
    const kb = (call?.body.reply_markup as { inline_keyboard: { text: string }[][] })
      .inline_keyboard;
    expect(kb.flat().map((b) => b.text)).toEqual(['✅ Так, видалити', '❌ Ні']);
  });

  it('невалідний id (path traversal) -> відхилено ДО будь-якого мережевого виклику', async () => {
    cal = [];
    await tapAgenda('ev:e:../../etc/passwd');
    expect(toast()).toContain('Некоректний id');
    expect(cal).toHaveLength(0);
  });
});

describe('ev:b — назад до списку', () => {
  it('перемальовує СПИСОК на місці (editMessageText)', async () => {
    await tapAgenda('ev:b:ev1');
    const edited = lastEditText();
    expect(edited?.text).toContain('Стендап');
    expect(edited?.text).not.toContain('Вчорашнє');
  });
});
