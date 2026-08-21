import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../web/worker.js';
import { memoryKv } from './helpers/kv.js';

/* Інтеграційні тести «нагадування з фрази частини доби» (вранці/в обід/після
 * обіду/ввечері тощо, БЕЗ явної години) — createReminderFromText мусить не
 * створювати нагадування напряму (час невідомий, доки не глянемо календар), а
 * стейджити його як звичайну пропозицію (kind:'reminder', staged confirm) із
 * годиною, обраною через читання календаря (pickDayPartSlot, reminders-core.mjs).
 * Той самий стиль, що worker-agenda.test.ts: справжній worker.fetch, стаб fetch
 * для Telegram/Google, календар — per-day мапа (щоб розрізняти сьогодні/завтра). */

const WEBHOOK_SECRET = 'tg-webhook-secret-abcdef';
const OWNER = 4242;

let kv: Map<string, string>;
let tg: { method: string; body: Record<string, unknown> }[];
// dateKey ("YYYY-MM-DD", Київ) -> події того дня.
let googleEventsByDate: Map<string, { summary: string; start: string; end: string }[]>;

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

const kyivDateKeyFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Kyiv',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

async function sendMessage(text: string, updateId = 1) {
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

const lastSendText = () =>
  [...tg].reverse().find((c) => c.method === 'sendMessage')?.body.text as string | undefined;
const lastSendKeyboard = () =>
  [...tg].reverse().find((c) => c.method === 'sendMessage')?.body.reply_markup as
    { inline_keyboard: { text: string; callback_data: string }[][] } | undefined;

beforeEach(() => {
  kv = new Map();
  tg = [];
  googleEventsByDate = new Map();

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
    if (url.includes('googleapis.com/calendar/v3/calendars/primary/events?')) {
      const timeMin = new URL(url).searchParams.get('timeMin')!;
      const dateKey = kyivDateKeyFmt.format(new Date(timeMin));
      const events = googleEventsByDate.get(dateKey) ?? [];
      return new Response(
        JSON.stringify({
          items: events.map((e, i) => ({
            id: `ev-${dateKey}-${i}`,
            summary: e.summary,
            start: { dateTime: e.start },
            end: { dateTime: e.end },
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

describe('createReminder — фраза частини доби (день-частина) БЕЗ явної години', () => {
  it('порожній календар -> стейджить пропозицію на startHour діапазону, НЕ створює напряму', async () => {
    // 10:00 Київ (літо, +3) -> "в обід" (12-14) ще попереду сьогодні.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T07:00:00Z'));
    try {
      await sendMessage('нагадай в обід купити квитки');
    } finally {
      vi.useRealTimers();
    }

    // Пряме створення НЕ спрацювало (не "✅ Нагадаю") — це пропозиція.
    const text = lastSendText();
    expect(text).toContain('🤔');
    expect(text).toContain('купити квитки');
    expect(text).toContain('12:00'); // перша вільна година діапазону (порожній календар)

    const pending = JSON.parse(kv.get('assistantPending')!);
    expect(pending.items).toHaveLength(1);
    expect(pending.items[0]).toMatchObject({ kind: 'reminder', title: 'купити квитки' });
    expect(new Date(pending.items[0].whenMs).toISOString()).toBe('2026-07-10T09:00:00.000Z'); // 12:00 Київ

    // Клавіатура несе циклер часу 🕐 (adjust-before-confirm) + ✅/❌.
    const kb = lastSendKeyboard()!;
    expect(kb.inline_keyboard.flat().some((b) => b.callback_data.startsWith('pd:s:'))).toBe(true);
    expect(kb.inline_keyboard.flat().some((b) => b.text.includes('Прийняти'))).toBe(true);
  });

  it('перша година діапазону зайнята -> пропонує наступну вільну', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T07:00:00Z')); // 10:00 Київ
    const todayKey = '2026-07-10';
    googleEventsByDate.set(todayKey, [
      { summary: 'Мітинг', start: '2026-07-10T09:00:00Z', end: '2026-07-10T09:30:00Z' }, // 12:00-12:30 Київ
    ]);
    try {
      await sendMessage('нагадай в обід купити квитки');
    } finally {
      vi.useRealTimers();
    }
    const pending = JSON.parse(kv.get('assistantPending')!);
    expect(new Date(pending.items[0].whenMs).toISOString()).toBe('2026-07-10T10:00:00.000Z'); // 13:00 Київ
  });

  it('увесь сьогоднішній діапазон зайнятий -> перепадає на завтра', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T07:00:00Z')); // 10:00 Київ
    googleEventsByDate.set('2026-07-10', [
      { summary: 'Довгий мітинг', start: '2026-07-10T09:00:00Z', end: '2026-07-10T11:00:00Z' }, // 12:00-14:00 Київ
    ]);
    try {
      await sendMessage('нагадай в обід купити квитки');
    } finally {
      vi.useRealTimers();
    }
    const pending = JSON.parse(kv.get('assistantPending')!);
    expect(new Date(pending.items[0].whenMs).toISOString()).toBe('2026-07-11T09:00:00.000Z'); // завтра 12:00 Київ
  });

  it('явне "завтра" поруч із фразою частини доби -> ЗАВЖДИ завтра (навіть як сьогодні вільно)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T07:00:00Z')); // сьогодні порожньо/вільно
    try {
      await sendMessage('нагадай завтра в обід купити квитки');
    } finally {
      vi.useRealTimers();
    }
    const pending = JSON.parse(kv.get('assistantPending')!);
    expect(new Date(pending.items[0].whenMs).toISOString()).toBe('2026-07-11T09:00:00.000Z'); // завтра 12:00
  });

  it('фраза частини доби З явною годиною ("ввечері о 20:00") — інший, наявний шлях: пряме створення', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T07:00:00Z'));
    try {
      await sendMessage('нагадай ввечері о 20:00 подзвонити');
    } finally {
      vi.useRealTimers();
    }
    const text = lastSendText();
    expect(text).toContain('✅ Нагадаю'); // пряме створення, НЕ пропозиція
    expect(kv.get('assistantPending')).toBeUndefined();
  });
});

/* B12: нагадування летіло в захардкоджені TELEGRAM_CHAT_ID + TOPIC_ASSISTANT
 * незалежно від того, ДЕ його створили — попросив у приватному чаті, а
 * відповідь прийшла в тему супергрупи. Тепер адреса зберігається на самому
 * нагадуванні; для записів, створених ДО цієї зміни, лишається старий фолбек. */
describe('доставка нагадування за адресою створення (B12)', () => {
  const OWNER_CHAT = 777;
  const GROUP_CHAT = '-100999';

  const cronEnv = (kv: Map<string, string>) => ({
    BRIEFING: {
      ...memoryKv(kv),
    },
    TELEGRAM_BOT_TOKEN: 'bot-token',
    TELEGRAM_CHAT_ID: GROUP_CHAT,
    TOPIC_ASSISTANT: '42',
  });

  const runCron = async (kv: Map<string, string>) => {
    const promises: Promise<unknown>[] = [];
    await worker.scheduled({}, cronEnv(kv), {
      waitUntil: (p: Promise<unknown>) => void promises.push(p),
    });
    await Promise.all(promises);
  };

  it('нагадування зі збереженим chatId приходить САМЕ туди', async () => {
    const kv = new Map<string, string>();
    kv.set(
      'state',
      JSON.stringify({
        reminders: [
          {
            id: 'r1',
            text: 'молоко',
            whenMs: Date.now() - 1000,
            chatId: OWNER_CHAT,
            firedTs: null,
          },
        ],
      }),
    );
    await runCron(kv);

    const sent = tg.find(
      (c) => c.method === 'sendMessage' && String(c.body.text).includes('молоко'),
    );
    expect(sent?.body.chat_id).toBe(OWNER_CHAT);
    // Тема належить ІНШОМУ чату — тягнути її сюди не можна.
    expect(sent?.body.message_thread_id).toBeUndefined();
  });

  it('legacy-нагадування (без адреси) — старий фолбек на env', async () => {
    const kv = new Map<string, string>();
    kv.set(
      'state',
      JSON.stringify({
        reminders: [{ id: 'r2', text: 'легасі', whenMs: Date.now() - 1000, firedTs: null }],
      }),
    );
    await runCron(kv);

    const sent = tg.find(
      (c) => c.method === 'sendMessage' && String(c.body.text).includes('легасі'),
    );
    expect(String(sent?.body.chat_id)).toBe(GROUP_CHAT);
    expect(String(sent?.body.message_thread_id)).toBe('42');
  });
});
