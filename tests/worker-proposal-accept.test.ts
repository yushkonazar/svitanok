import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// @ts-expect-error — JS-модуль Worker'а без типів.
import worker from '../web/worker.js';

/* Регресія на прод-баг 19.07: пропозиція асистента (✅/❌) жила в блобі 'state',
   і наївні писарі 'state' (lastUpdateId у вебхуку, крон, дашборд) БЕЗ
   read-your-writes затирали її — кожен ✅ падав у «Застаріла пропозиція».
   Фікс: пропозиція у ВЛАСНОМУ KV-ключі 'assistantPending'. Тут перевіряємо, що
   вона переживає затирання блоба 'state', і що legacy-фолбек (брифінг ще пише
   в блоб) працює. */

const WEBHOOK_SECRET = 'tg-webhook-secret-abcdef';
const OWNER = 4242;

let kv: Map<string, string>;
let tg: { method: string; body: Record<string, unknown> }[];
let cal: Record<string, unknown>[]; // захоплені тіла events.insert/patch/delete
let googleEvents: Map<
  string,
  { summary: string; start: { dateTime: string }; end: { dateTime: string } }
>;

function env() {
  return {
    BRIEFING: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => void kv.set(k, v),
      list: async () => ({ keys: [] }),
    },
    TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    TELEGRAM_BOT_TOKEN: 'bot-token',
    TELEGRAM_OWNER_USER_ID: String(OWNER),
    GOOGLE_CLIENT_ID: 'gid',
    GOOGLE_CLIENT_SECRET: 'gsecret',
    GOOGLE_REFRESH_TOKEN: 'grefresh',
  };
}

/** CTX, чий waitUntil РЕАЛЬНО тримає проміси — вебхук обробляє апдейт у фоні. */
function ctx() {
  const promises: Promise<unknown>[] = [];
  return {
    waitUntil: (p: Promise<unknown>) => void promises.push(p),
    settle: () => Promise.all(promises),
  };
}

const acceptUpdate = (id: string, action = 'a', updateId = 1000) => ({
  update_id: updateId,
  callback_query: {
    id: 'cbq1',
    from: { id: OWNER },
    data: `pd:${action}:${id}`,
    message: {
      message_id: 555,
      chat: { id: OWNER },
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Прийняти', callback_data: `pd:a:${id}` },
            { text: '❌ Скасувати', callback_data: `pd:c:${id}` },
          ],
        ],
      },
    },
  },
});

const pending = (id: string) => ({
  id,
  createdMs: Date.now(),
  items: [{ kind: 'reminder', title: 'купити квитки', whenMs: Date.now() + 3_600_000 }],
});

const eventPending = (id: string, cfg: { durMin: number | null; leadMin: number | null }) => ({
  id,
  createdMs: Date.now(),
  cfg,
  items: [
    { kind: 'event', title: 'обід', whenMs: Date.parse('2026-07-24T12:00:00Z'), durationMin: 60 },
  ],
});

const EV_BASE = { title: 'Стендап', whenMs: Date.parse('2026-07-24T12:00:00Z'), durationMin: 60 };

const updateEventPending = (
  id: string,
  overrides: { whenMs?: number; title?: string; shiftMin?: number } = {},
) => ({
  id,
  createdMs: Date.now(),
  items: [{ kind: 'updateEvent', eventId: 'ev1', base: EV_BASE, ...overrides }],
});

const deleteEventPending = (id: string) => ({
  id,
  createdMs: Date.now(),
  items: [{ kind: 'deleteEvent', eventId: 'ev1', base: EV_BASE }],
});

async function postCb(id: string, action = 'a', e = env()) {
  const c = ctx();
  await worker.fetch(
    new Request('https://svitanok.example/api/telegram', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET,
      },
      body: JSON.stringify(acceptUpdate(id, action)),
    }),
    e,
    c,
  );
  await c.settle(); // дочекатись фонової обробки (resolveProposalCallback)
}

const postAccept = (id: string, e = env()) => postCb(id, 'a', e);

const toast = () =>
  tg.find((c) => c.method === 'answerCallbackQuery')?.body.text as string | undefined;

beforeEach(() => {
  kv = new Map();
  tg = [];
  cal = [];
  googleEvents = new Map([
    [
      'ev1',
      {
        summary: EV_BASE.title,
        start: { dateTime: new Date(EV_BASE.whenMs).toISOString() },
        end: { dateTime: new Date(EV_BASE.whenMs + EV_BASE.durationMin * 60_000).toISOString() },
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
    // Одна подія за id (getCalendarEvent/updateCalendarEvent/deleteCalendarEvent).
    const single = url.match(/googleapis\.com\/calendar\/v3\/calendars\/primary\/events\/([^/?]+)/);
    if (single) {
      const id = single[1]!;
      const method = init.method ?? 'GET';
      if (method === 'GET') {
        const ev = googleEvents.get(id);
        return ev
          ? new Response(JSON.stringify({ id, ...ev }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          : new Response('{}', { status: 404 });
      }
      if (method === 'PATCH') {
        const ev = googleEvents.get(id);
        if (!ev) return new Response('{}', { status: 404 }); // реалістично: Google 404 на видалену подію
        const patch = JSON.parse(String(init.body ?? '{}'));
        cal.push({ _method: 'PATCH', _id: id, ...patch });
        googleEvents.set(id, { ...ev, ...patch });
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (method === 'DELETE') {
        const existed = googleEvents.has(id);
        cal.push({ _method: 'DELETE', _id: id });
        googleEvents.delete(id);
        return new Response('{}', { status: existed ? 200 : 404 });
      }
    }
    if (url.includes('googleapis.com/calendar') && init.method === 'POST') {
      const body = JSON.parse(String(init.body ?? '{}'));
      cal.push(body);
      const id = `evt${googleEvents.size + 1}`;
      googleEvents.set(id, body);
      return new Response(JSON.stringify({ id }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', { status: 200 });
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('accept пропозиції — власний KV-ключ переживає затирання блоба state', () => {
  it('пропозиція у власному ключі -> ✅ приймається, НЕ «Застаріла»', async () => {
    kv.set('assistantPending', JSON.stringify(pending('abc12345')));
    await postAccept('abc12345');
    expect(toast()).toContain('Додано');
    expect(toast()).not.toContain('Застаріла');
    // Списано (тумбстоун), тож повторний тап уже стане «Застаріла».
    expect(kv.get('assistantPending')).toBe('null');
  });

  it('РЕГРЕСІЯ: наївний писар затер блоб state, але пропозиція вціліла у власному ключі', async () => {
    kv.set('assistantPending', JSON.stringify(pending('abc12345')));
    // Симулюємо клобер: писар 'state' (напр. lastUpdateId) записав блоб БЕЗ
    // assistantPending. До фіксу це «з'їдало» пропозицію -> «Застаріла».
    kv.set('state', JSON.stringify({ lastUpdateId: 5, reminders: [] }));
    await postAccept('abc12345');
    expect(toast()).toContain('Додано');
    expect(toast()).not.toContain('Застаріла');
  });

  it('legacy-фолбек: пропозиція лише в блобі state (брифінг) -> теж приймається', async () => {
    kv.set('state', JSON.stringify({ reminders: [], assistantPending: pending('legacy99') }));
    await postAccept('legacy99');
    expect(toast()).toContain('Додано');
    // Legacy-слот прибрано з блоба.
    const st = JSON.parse(kv.get('state')!);
    expect(st.assistantPending).toBeUndefined();
  });

  it('чужий/відсутній id -> «Застаріла пропозиція»', async () => {
    kv.set('assistantPending', JSON.stringify(pending('realid00')));
    await postAccept('WRONGid0');
    expect(toast()).toContain('Застаріла');
  });
});

describe('доналаштування пропозиції — циклери', () => {
  it('циклер тривалості (pd:d) міняє cfg і перемальовує клавіатуру, НЕ споживає', async () => {
    kv.set(
      'assistantPending',
      JSON.stringify(eventPending('evt00001', { durMin: null, leadMin: null })),
    );
    await postCb('evt00001', 'd');

    const stored = JSON.parse(kv.get('assistantPending')!);
    expect(stored.cfg.durMin).toBe(30); // null(«як є») -> 30
    expect(stored.id).toBe('evt00001'); // слот лишився (не спожито)
    expect(tg.find((c) => c.method === 'editMessageReplyMarkup')).toBeTruthy();
    expect(toast()).toContain('30 хв');
  });

  it('accept події з cfg -> тривалість і lead-нагадування у тілі календаря', async () => {
    kv.set(
      'assistantPending',
      JSON.stringify(eventPending('evt00002', { durMin: 90, leadMin: 30 })),
    );
    await postCb('evt00002', 'a');

    expect(toast()).toContain('Додано');
    expect(cal).toHaveLength(1);
    const body = cal[0] as {
      start: { dateTime: string };
      end: { dateTime: string };
      reminders?: unknown;
    };
    expect((Date.parse(body.end.dateTime) - Date.parse(body.start.dateTime)) / 60_000).toBe(90);
    expect(body.reminders).toEqual({
      useDefault: false,
      overrides: [{ method: 'popup', minutes: 30 }],
    });
  });

  it('accept без доналаштування (cfg null) -> тривалість від моделі, без reminders', async () => {
    kv.set(
      'assistantPending',
      JSON.stringify(eventPending('evt00003', { durMin: null, leadMin: null })),
    );
    await postCb('evt00003', 'a');

    const body = cal[0] as {
      start: { dateTime: string };
      end: { dateTime: string };
      reminders?: unknown;
    };
    expect((Date.parse(body.end.dateTime) - Date.parse(body.start.dateTime)) / 60_000).toBe(60); // durationMin моделі
    expect(body.reminders).toBeUndefined(); // дефолт календаря
  });
});

describe('CRUD: перепис повідомлення ПІСЛЯ accept (goal — не лише тік кнопки)', () => {
  const editText = () =>
    tg.find((c) => c.method === 'editMessageText')?.body as
      | {
          text: string;
          reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] };
        }
      | undefined;

  it('create: reminder + event -> editMessageText з ✅/⚠️ на пункт і ✏️/🗑 кнопками', async () => {
    kv.set(
      'assistantPending',
      JSON.stringify({
        id: 'multi0001',
        createdMs: Date.now(),
        cfg: { durMin: null, leadMin: null },
        items: [
          { kind: 'reminder', title: 'Квитки', whenMs: Date.now() + 3_600_000 },
          {
            kind: 'event',
            title: 'Обід',
            whenMs: Date.parse('2026-07-24T12:00:00Z'),
            durationMin: 60,
          },
        ],
      }),
    );
    await postCb('multi0001', 'a');

    const edited = editText();
    expect(edited?.text).toContain('1. ✅');
    expect(edited?.text).toContain('2. ✅');
    const flat = edited?.reply_markup?.inline_keyboard.flat() ?? [];
    expect(flat.some((b) => b.text.includes('✏️'))).toBe(true);
    expect(flat.some((b) => b.text.includes('🗑'))).toBe(true);
    // reminder-delete кнопка реюзає ІСНУЮЧИЙ rc: (не новий простір)
    expect(flat.some((b) => b.callback_data.startsWith('rc:'))).toBe(true);
    // event-кнопки — ev: (agenda-простір)
    expect(flat.some((b) => b.callback_data.startsWith('ev:'))).toBe(true);
  });

  it('cancel: теж переписує текст (не лише тік), без кнопок', async () => {
    kv.set('assistantPending', JSON.stringify(pending('cnl00001')));
    await postCb('cnl00001', 'c');
    const edited = editText();
    expect(edited?.text).toContain('Скасовано');
    expect(edited?.reply_markup).toBeUndefined();
  });

  it('edit (updateEvent) accept -> PATCH з фінальними title/start/end, «Оновлено» + 🗑', async () => {
    kv.set(
      'assistantPending',
      JSON.stringify(updateEventPending('edt00001', { whenMs: EV_BASE.whenMs + 3_600_000 })),
    );
    await postCb('edt00001', 'a');

    const patch = cal.find((c) => c._method === 'PATCH');
    expect(patch).toBeTruthy();
    expect(patch!.summary).toBe(EV_BASE.title); // title не мінявся -> з base
    expect(Date.parse(String((patch as { start: { dateTime: string } }).start.dateTime))).toBe(
      EV_BASE.whenMs + 3_600_000,
    );

    expect(toast()).toContain('Оновлено');
    const edited = editText();
    expect(edited?.text).toContain('Оновлено');
    const flat = edited?.reply_markup?.inline_keyboard.flat() ?? [];
    expect(flat).toHaveLength(1);
    expect(flat[0]!.text).toContain('Видалити');
    expect(flat[0]!.callback_data).toBe('ev:d:ev1');
  });

  it('delete (deleteEvent) accept -> DELETE, «Видалено», без кнопок', async () => {
    kv.set('assistantPending', JSON.stringify(deleteEventPending('del00001')));
    await postCb('del00001', 'a');

    expect(cal.find((c) => c._method === 'DELETE' && c._id === 'ev1')).toBeTruthy();
    expect(toast()).toContain('Видалено');
    const edited = editText();
    expect(edited?.text).toContain('Видалено');
    expect(edited?.text).toContain(EV_BASE.title);
    expect(edited?.reply_markup).toBeUndefined();
  });

  it('edit accept, коли подію вже видалено (PATCH 404) -> чесний провал, без крашу', async () => {
    googleEvents.delete('ev1'); // вже видалено іншим шляхом між стейджингом і accept
    kv.set('assistantPending', JSON.stringify(updateEventPending('edt00002')));
    await postCb('edt00002', 'a');
    expect(toast()).toContain('Не вдалось');
  });
});

describe('CRUD: edit-режим — цикл зсуву часу (pd:s) і «✏️ Інше» (pd:o)', () => {
  it('pd:s циклить зсув, ПЕРЕМАЛЬОВУЄ ТЕКСТ (не лише клавіатуру) — діф залежить від whenMs', async () => {
    kv.set('assistantPending', JSON.stringify(updateEventPending('shf00001')));
    await postCb('shf00001', 's');

    const stored = JSON.parse(kv.get('assistantPending')!);
    expect(stored.items[0].shiftMin).toBe(15);
    expect(stored.items[0].whenMs).toBe(EV_BASE.whenMs + 15 * 60_000);
    expect(stored.id).toBe('shf00001'); // не спожито

    const edited = tg.find((c) => c.method === 'editMessageText')?.body as
      { text: string } | undefined;
    expect(edited?.text).toContain('→'); // діф «було -> стане» тепер видно
    expect(toast()).toContain('+15 хв');
  });

  it('pd:s удруге циклить ДАЛІ (від поточного shiftMin, не з нуля)', async () => {
    kv.set('assistantPending', JSON.stringify(updateEventPending('shf00002', { shiftMin: 15 })));
    await postCb('shf00002', 's');
    const stored = JSON.parse(kv.get('assistantPending')!);
    expect(stored.items[0].shiftMin).toBe(30);
  });

  it('pd:o: списує пропозицію, шле питання БЕЗ id, пише синтетичну репліку З id НА ПОЧАТКУ', async () => {
    kv.set('assistantPending', JSON.stringify(updateEventPending('oth00001')));
    await postCb('oth00001', 'o');

    // Списано — повторний ✅ дасть «Застаріла».
    expect(kv.get('assistantPending')).toBe('null');

    const sent = tg.find((c) => c.method === 'sendMessage')?.body.text as string;
    expect(sent).toBeTruthy();
    expect(sent).not.toContain('[id:'); // маркер НЕ бачить власник
    expect(sent).not.toContain('ev1');

    const history = JSON.parse(kv.get('assistantHistory') ?? '{}');
    const turns =
      history[`${OWNER}:`] ?? history[`${OWNER}:undefined`] ?? Object.values(history)[0];
    const last = (turns as { role: string; text: string }[]).at(-1)!;
    expect(last.role).toBe('assistant');
    expect(last.text.startsWith('[id:ev1]')).toBe(true); // маркер НА ПОЧАТКУ (clipTurn ріже хвіст)

    expect(toast()).toContain('що змінити');
  });

  it('pd:s/pd:o недоступні у create-режимі (лише edit) -> «Застаріла»', async () => {
    kv.set(
      'assistantPending',
      JSON.stringify(eventPending('cre00001', { durMin: null, leadMin: null })),
    );
    await postCb('cre00001', 's');
    expect(toast()).toContain('Застаріла');
  });
});

describe('CRUD: ru:<id> — «✏️ Редагувати» на нагадуванні (БЕЗ assistantPending)', () => {
  async function tapCallback(data: string) {
    const c = ctx();
    await worker.fetch(
      new Request('https://svitanok.example/api/telegram', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET,
        },
        body: JSON.stringify({
          update_id: 3000,
          callback_query: {
            id: 'cbq1',
            from: { id: OWNER },
            data,
            message: {
              message_id: 555,
              chat: { id: OWNER },
              reply_markup: { inline_keyboard: [[{ text: '✏️', callback_data: data }]] },
            },
          },
        }),
      }),
      env(),
      c,
    );
    await c.settle();
  }

  it('шле питання з поточним текстом/часом, пише синтетичну репліку (БЕЗ id-маркера — reminderText сам ключ)', async () => {
    kv.set(
      'state',
      JSON.stringify({
        reminders: [
          {
            id: 'rem1',
            text: 'Купити квитки',
            whenMs: Date.parse('2026-07-24T12:00:00Z'),
            firedTs: null,
          },
        ],
      }),
    );
    await tapCallback('ru:rem1');

    const sent = tg.find((c) => c.method === 'sendMessage')?.body.text as string;
    expect(sent).toContain('Купити квитки');
    expect(toast()).toContain('що змінити');

    const history = JSON.parse(kv.get('assistantHistory') ?? '{}');
    const turns = Object.values(history)[0] as { role: string; text: string }[];
    expect(turns.at(-1)).toMatchObject({ role: 'assistant' });
    expect(turns.at(-1)!.text).toContain('Купити квитки'); // reminderText — природний ключ пошуку, без [id:]
  });

  it('невідомий/спрацьований id -> чесний toast, нічого не шле', async () => {
    kv.set('state', JSON.stringify({ reminders: [] }));
    await tapCallback('ru:nope');
    expect(toast()).toContain('неактуальне');
    expect(tg.find((c) => c.method === 'sendMessage')).toBeUndefined();
  });
});
