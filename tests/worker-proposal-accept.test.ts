import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../web/worker.js';
import { PendingProposalsDO } from '../web/core/pending-proposals/do.mjs';
import { memoryKv } from './helpers/kv.js';
import { workerEnv } from './helpers/env.js';

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
  return workerEnv({
    BRIEFING: memoryKv(kv),
    TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    TELEGRAM_BOT_TOKEN: 'bot-token',
    TELEGRAM_OWNER_USER_ID: String(OWNER),
    GOOGLE_CLIENT_ID: 'gid',
    GOOGLE_CLIENT_SECRET: 'gsecret',
    GOOGLE_REFRESH_TOKEN: 'grefresh',
  });
}

/** Один справжній singleton DO на тестовий Env: callback-и заходять через
 * Worker паралельно, тож Map-KV не може випадково підмінити atomic claim. */
function pendingNamespace(e: Env) {
  const storage = new Map<string, unknown>();
  const pending = new PendingProposalsDO(
    {
      storage: {
        get: async (key: string) => storage.get(key),
        put: async (key: string, value: unknown) => void storage.set(key, value),
        deleteAll: async () => void storage.clear(),
        setAlarm: async () => {},
      },
    },
    e,
  );
  return { getByName: () => pending };
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
  overrides: {
    whenMs?: number;
    title?: string;
    shiftMin?: number;
    location?: string;
    resolvedAttendees?: string[];
  } = {},
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

async function postCb(id: string, action = 'a', e = env(), updateId = 1000) {
  const c = ctx();
  await worker.fetch(
    new Request('https://svitanok.example/api/telegram', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET,
      },
      body: JSON.stringify(acceptUpdate(id, action, updateId)),
    }),
    e,
    c,
  );
  await c.settle(); // дочекатись фонової обробки (resolveProposalCallback)
}

const postAccept = (id: string, e = env(), updateId?: number) => postCb(id, 'a', e, updateId);

/** Довільний raw callback_data (для просторів поза pd:, напр. ru:/rs:). */
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
            reply_markup: { inline_keyboard: [[{ text: 'x', callback_data: data }]] },
          },
        },
      }),
    }),
    env(),
    c,
  );
  await c.settle();
}

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
        cal.push({ _method: 'PATCH', _id: id, _url: url, ...patch });
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
      cal.push({ _url: url, ...body });
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

  it('РЕГРЕСІЯ (пост-міграція оркестратора): legacy `state.assistantPending` БЕЗ власного ключа -> «Застаріла», не читається', async () => {
    // Оркестратор (src/orchestrator.ts) тепер пише assistantPending НАПРЯМУ у
    // власний KV-ключ (writeKvJson), не в блоб `state` — фолбек прибрано.
    // Запис лише в блобі (стара форма) більше НЕ має підхоплюватись.
    kv.set('state', JSON.stringify({ reminders: [], assistantPending: pending('legacy99') }));
    await postAccept('legacy99');
    expect(toast()).toContain('Застаріла');
  });

  /* ── Подвійний тап ✅ ──────────────────────────────────────────────────
     Два різні Telegram update_id справді доходять до callback-а одночасно;
     atomic claim у PendingProposalsDO має пропустити лише один до Calendar. */
  it('паралельний подвійний тап -> подія створюється РІВНО ОДИН раз', async () => {
    kv.set(
      'assistantPending',
      JSON.stringify(eventPending('dbl00001', { durMin: null, leadMin: null })),
    );
    const e = env();
    Object.assign(e, { PENDING_PROPOSALS: pendingNamespace(e) });
    const creates = () => cal.filter((c) => !c._method).length;

    await Promise.all([postAccept('dbl00001', e, 1000), postAccept('dbl00001', e, 1001)]);

    expect(creates()).toBe(1);
    const toasts = tg.filter((c) => c.method === 'answerCallbackQuery');
    expect(toasts.some((toast) => String(toast.body.text).includes('Застаріла'))).toBe(true);
  });

  /* Друга половина фіксу: кнопки знімаються ОДРАЗУ після claim, а не разом із
     результатом наприкінці. Доти вони лишались живими весь час раундтріпів до
     Google — тобто вікно для другого тапу дорівнювало тривалості всієї роботи,
     а не мілісекундам. */
  it('клавіатура знімається ПЕРШИМ викликом у Telegram, ще до роботи', async () => {
    kv.set(
      'assistantPending',
      JSON.stringify(eventPending('kbd00001', { durMin: null, leadMin: null })),
    );
    await postAccept('kbd00001');
    expect(tg[0]!.method).toBe('editMessageReplyMarkup');
    expect(tg.some((c) => c.method === 'editMessageText')).toBe(true);
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

describe('CRUD: settings-пропозиція (PR-9) — accept пише ПОВНИЙ нормалізований блоб у KV', () => {
  const editText = () =>
    tg.find((c) => c.method === 'editMessageText')?.body as
      { text: string; reply_markup?: { inline_keyboard: unknown[][] } } | undefined;

  const settingsPending = (id: string, settings: Record<string, unknown>) => ({
    id,
    createdMs: Date.now(),
    items: [{ kind: 'settings', settings, base: {} }],
  });

  it('accept -> KV `settings` перезаписано нормалізованим блобом, «Застосовано»', async () => {
    kv.set(
      'assistantPending',
      JSON.stringify(
        settingsPending('set00001', {
          quiet: { enabled: true, from: '23:00', to: '07:30' },
          modules: { news: false },
        }),
      ),
    );
    await postCb('set00001', 'a');

    expect(toast()).toContain('Застосовано');
    const settings = JSON.parse(kv.get('settings')!);
    expect(settings).toEqual({
      quiet: { enabled: true, from: '23:00', to: '07:30' },
      modules: { news: false },
      mutedTopics: [],
    });
    const edited = editText();
    expect(edited?.text).toContain('застосовано');
    expect(edited?.reply_markup).toBeUndefined(); // нічого редагувати/видаляти далі
  });

  it('cancel -> KV `settings` НЕ чіпається', async () => {
    kv.set(
      'assistantPending',
      JSON.stringify(settingsPending('set00002', { modules: { jobs: false } })),
    );
    await postCb('set00002', 'c');
    expect(kv.get('settings')).toBeUndefined();
  });
});

describe('CRUD: гості/локація на подіях (PR-10) — sendUpdates=all, тіло з attendees/location', () => {
  it('create з гостями -> POST несе location+attendees, URL з sendUpdates=all', async () => {
    kv.set(
      'assistantPending',
      JSON.stringify({
        id: 'gst00001',
        createdMs: Date.now(),
        cfg: { durMin: null, leadMin: null },
        items: [
          {
            kind: 'event',
            title: 'Кава',
            whenMs: Date.parse('2026-07-24T12:00:00Z'),
            durationMin: 60,
            location: 'Кав’ярня',
            resolvedAttendees: ['a@x.com', 'b@x.com'],
          },
        ],
      }),
    );
    await postCb('gst00001', 'a');

    expect(toast()).toContain('Додано');
    expect(cal).toHaveLength(1);
    const body = cal[0] as {
      _url: string;
      location?: string;
      attendees?: { email: string }[];
    };
    expect(body._url).toContain('sendUpdates=all');
    expect(body.location).toBe('Кав’ярня');
    expect(body.attendees).toEqual([{ email: 'a@x.com' }, { email: 'b@x.com' }]);
  });

  it('create БЕЗ гостей -> URL без sendUpdates (старий тихий шлях, ніхто не сповіщається)', async () => {
    kv.set(
      'assistantPending',
      JSON.stringify(eventPending('gst00002', { durMin: null, leadMin: null })),
    );
    await postCb('gst00002', 'a');
    const body = cal[0] as { _url: string };
    expect(body._url).not.toContain('sendUpdates');
  });

  it('updateEvent з гостями -> PATCH несе attendees, URL з sendUpdates=all', async () => {
    kv.set(
      'assistantPending',
      JSON.stringify(updateEventPending('gst00003', { resolvedAttendees: ['guest@x.com'] })),
    );
    await postCb('gst00003', 'a');

    const patch = cal.find((c) => c._method === 'PATCH') as {
      _url: string;
      attendees?: { email: string }[];
    };
    expect(patch._url).toContain('sendUpdates=all');
    expect(patch.attendees).toEqual([{ email: 'guest@x.com' }]);
  });

  it('updateEvent БЕЗ гостей -> PATCH без sendUpdates', async () => {
    kv.set('assistantPending', JSON.stringify(updateEventPending('gst00004')));
    await postCb('gst00004', 'a');
    const patch = cal.find((c) => c._method === 'PATCH') as { _url: string };
    expect(patch._url).not.toContain('sendUpdates');
  });
});

describe('CRUD: контакт на запис (PR-13) — accept пише через People API createContact', () => {
  const contactPending = (id: string, name: string, email: string) => ({
    id,
    createdMs: Date.now(),
    items: [{ kind: 'contact', title: name, email }],
  });

  let peopleWrites: { name: string; email: string }[];

  beforeEach(() => {
    peopleWrites = [];
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
      if (url.includes('people.googleapis.com/v1/people:createContact')) {
        const body = JSON.parse(String(init.body ?? '{}'));
        peopleWrites.push({
          name: body.names?.[0]?.givenName,
          email: body.emailAddresses?.[0]?.value,
        });
        return new Response('{}', { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
  });

  it('accept -> People API createContact викликано з правильними name/email, «Збережено»', async () => {
    kv.set(
      'assistantPending',
      JSON.stringify(contactPending('con00001', 'Олексій', 'oleksiy@x.com')),
    );
    await postCb('con00001', 'a');

    expect(toast()).toContain('Збережено');
    expect(peopleWrites).toEqual([{ name: 'Олексій', email: 'oleksiy@x.com' }]);
  });

  it('cancel -> People API НЕ викликається', async () => {
    kv.set('assistantPending', JSON.stringify(contactPending('con00002', 'Ірина', 'irina@x.com')));
    await postCb('con00002', 'c');
    expect(peopleWrites).toEqual([]);
  });

  it('провал People API (403, без скоупу) -> чесний toast, не крашить', async () => {
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
      if (url.includes('people.googleapis.com')) return new Response('{}', { status: 403 });
      return new Response('{}', { status: 200 });
    });
    kv.set('assistantPending', JSON.stringify(contactPending('con00003', 'X', 'x@y.com')));
    await postCb('con00003', 'a');
    expect(toast()).toContain('Не вдалось зберегти');
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

  it('pd:s/pd:o недоступні у create-режимі ПОДІЇ (лише edit) -> «Застаріла»', async () => {
    kv.set(
      'assistantPending',
      JSON.stringify(eventPending('cre00001', { durMin: null, leadMin: null })),
    );
    await postCb('cre00001', 's');
    expect(toast()).toContain('Застаріла');
  });
});

describe('CRUD: create-режим з ОДНИМ reminder — цикл зсуву часу (pd:s), фіча «частина доби»', () => {
  const reminderPending = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    createdMs: Date.now(),
    items: [
      {
        kind: 'reminder',
        title: 'купити квитки',
        whenMs: Date.now() + 3_600_000,
        baseWhenMs: Date.now() + 3_600_000,
        shiftMin: 0,
        ...overrides,
      },
    ],
  });

  it('pd:s циклить від baseWhenMs (НЕ від base.whenMs — нова сутність, «було» нема)', async () => {
    const anchor = Date.now() + 3_600_000;
    kv.set(
      'assistantPending',
      JSON.stringify(reminderPending('rmt00001', { whenMs: anchor, baseWhenMs: anchor })),
    );
    await postCb('rmt00001', 's');

    const stored = JSON.parse(kv.get('assistantPending')!);
    expect(stored.items[0].shiftMin).toBe(15);
    expect(stored.items[0].whenMs).toBe(anchor + 15 * 60_000);
    expect(stored.id).toBe('rmt00001'); // не спожито — циклер, не термінал

    const edited = tg.find((c) => c.method === 'editMessageText')?.body as
      { text: string; reply_markup: { inline_keyboard: unknown[][] } } | undefined;
    expect(edited?.text).toContain('купити квитки');
    expect(edited?.reply_markup.inline_keyboard[0]?.[0]).toMatchObject({
      callback_data: 'pd:s:rmt00001',
    });
    expect(toast()).toContain('+15 хв');
  });

  it('pd:s удруге циклить ДАЛІ від baseWhenMs (не компаундиться від проміжного whenMs)', async () => {
    const anchor = Date.now() + 3_600_000;
    kv.set(
      'assistantPending',
      JSON.stringify(
        reminderPending('rmt00002', {
          whenMs: anchor + 15 * 60_000,
          baseWhenMs: anchor,
          shiftMin: 15,
        }),
      ),
    );
    await postCb('rmt00002', 's');
    const stored = JSON.parse(kv.get('assistantPending')!);
    expect(stored.items[0].shiftMin).toBe(30);
    expect(stored.items[0].whenMs).toBe(anchor + 30 * 60_000); // від anchor, не від anchor+15
  });

  it('легасі-пункт БЕЗ baseWhenMs (до цього фіксу) -> фолбек на whenMs як анкер', async () => {
    const anchor = Date.now() + 3_600_000;
    kv.set(
      'assistantPending',
      JSON.stringify({
        id: 'rmt00003',
        createdMs: Date.now(),
        items: [{ kind: 'reminder', title: 'X', whenMs: anchor }], // без baseWhenMs/shiftMin
      }),
    );
    await postCb('rmt00003', 's');
    const stored = JSON.parse(kv.get('assistantPending')!);
    expect(stored.items[0].whenMs).toBe(anchor + 15 * 60_000);
  });

  it('reminder НЕ єдиний пункт (мультипропозиція) -> pd:s «Застаріла», не циклить', async () => {
    kv.set(
      'assistantPending',
      JSON.stringify({
        id: 'rmt00004',
        createdMs: Date.now(),
        items: [
          {
            kind: 'reminder',
            title: 'X',
            whenMs: Date.now() + 3_600_000,
            baseWhenMs: Date.now(),
            shiftMin: 0,
          },
          { kind: 'contact', title: 'Y', email: 'y@x.com' },
        ],
      }),
    );
    await postCb('rmt00004', 's');
    expect(toast()).toContain('Застаріла');
  });
});

describe('CRUD: ru:<id> — «✏️ Редагувати» на нагадуванні (БЕЗ assistantPending)', () => {
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

describe('CRUD: rk:<id> — «✅ Виконано» на спрацьованому нагадуванні', () => {
  it('переписує ВСЕ повідомлення статусом + прибирає клавіатуру ПОВНІСТЮ (не лише тік кнопки)', async () => {
    kv.set(
      'state',
      JSON.stringify({
        reminders: [
          { id: 'rem1', text: 'Купити квитки', whenMs: Date.now() - 1000, firedTs: Date.now() },
        ],
      }),
    );
    await tapCallback('rk:rem1');

    expect(toast()).toBe('✅ Виконано');
    const edited = tg.find((c) => c.method === 'editMessageText')?.body as
      { text: string; reply_markup?: { inline_keyboard: unknown[][] } } | undefined;
    expect(edited?.text).toBe('✅ <b>Виконано</b>\nКупити квитки');
    expect(edited?.reply_markup).toEqual({ inline_keyboard: [] }); // усі кнопки прибрано

    // Справжнє видалення (той самий інваріант, що rc: — нема окремого поля done).
    const state = JSON.parse(kv.get('state')!);
    expect(state.reminders).toEqual([]);
  });

  it('невідомий id -> чесний toast, нічого не переписує', async () => {
    kv.set('state', JSON.stringify({ reminders: [] }));
    await tapCallback('rk:nope');
    expect(toast()).toContain('неактуальне');
    expect(tg.find((c) => c.method === 'editMessageText')).toBeUndefined();
  });
});

describe('CRUD: rs:<presetIdx>:<id> — розширений snooze (extra b)', () => {
  it('пресет 1 (1 год) відкладає, тікає кнопку, RM: (старий) лишається живим окремо', async () => {
    kv.set(
      'state',
      JSON.stringify({
        reminders: [{ id: 'rem1', text: 'Полити квіти', whenMs: 1000, firedTs: 999 }],
      }),
    );
    await tapCallback('rs:1:rem1');

    expect(toast()).toContain('Відкладено');
    const state = JSON.parse(kv.get('state')!);
    expect(state.reminders[0].firedTs).toBeNull();
    expect(state.reminders[0].whenMs).toBeGreaterThan(Date.now() + 59 * 60_000); // ~1 год наперед
  });

  it('невідомий id -> «вже неактуальне», без крашу', async () => {
    kv.set('state', JSON.stringify({ reminders: [] }));
    await tapCallback('rs:0:nope');
    expect(toast()).toContain('неактуальне');
  });
});

describe('CRUD: rc:all — пакетне скасування (extra c)', () => {
  it('скасовує ВСІ активні, переписує список (editMessageText), без кнопок опісля', async () => {
    kv.set(
      'state',
      JSON.stringify({
        reminders: [
          { id: 'r1', text: 'X', whenMs: Date.now() + 1000, firedTs: null },
          { id: 'r2', text: 'Y', whenMs: Date.now() + 2000, firedTs: null },
        ],
      }),
    );
    await tapCallback('rc:all');

    expect(toast()).toContain('Скасовано 2');
    const state = JSON.parse(kv.get('state')!);
    expect(state.reminders).toEqual([]);

    const edited = tg.find((c) => c.method === 'editMessageText')?.body as {
      text: string;
      reply_markup?: unknown;
    };
    expect(edited?.text).toContain('немає');
    expect(edited?.reply_markup).toBeUndefined();
  });

  it('спрацьовані НЕ чіпає (вони й так вже поза списком активних)', async () => {
    kv.set(
      'state',
      JSON.stringify({
        reminders: [
          { id: 'r1', text: 'X', whenMs: 1, firedTs: 999 },
          { id: 'r2', text: 'Y', whenMs: Date.now() + 1000, firedTs: null },
        ],
      }),
    );
    await tapCallback('rc:all');
    const state = JSON.parse(kv.get('state')!);
    expect(state.reminders).toHaveLength(1);
    expect(state.reminders[0].id).toBe('r1'); // спрацьоване лишилось
  });

  it('понад стелю за тап - решта лишається, і про це сказано', async () => {
    // ⚠️ Кожне скасування - запит у D1, а їх на виклик Worker'а ~50. Без межі
    // 45 активних упирались би в стелю ПОСЕРЕД циклу: частина скасована,
    // тост не пішов (другий прохід ревʼю).
    kv.set(
      'state',
      JSON.stringify({
        reminders: Array.from({ length: 25 }, (_, i) => ({
          id: `r${i}`,
          text: 'X',
          whenMs: Date.now() + 1000,
          firedTs: null,
        })),
      }),
    );
    await tapCallback('rc:all');
    expect(toast()).toContain('ще 5');
    const left = JSON.parse(kv.get('state')!).reminders as { id: string }[];
    expect(left).toHaveLength(5);
  });

  it('нема активних -> чесний toast, KV не чіпається', async () => {
    kv.set('state', JSON.stringify({ reminders: [] }));
    await tapCallback('rc:all');
    expect(toast()).toContain('Нема що скасовувати');
  });
});

/* S2 (залишок): мутації НАГАДУВАНЬ проходять той самий accept-цикл, що подієві
   updateEvent/deleteEvent. Стейджить їх Worker (агент лише просить дією
   cancelReminder/updateReminder), тож перевіряємо саме другу половину — що ✅
   справді застосовує зміну до KV, а ❌ лишає стан недоторканим. */
describe('CRUD: мутація нагадування під ✅ (S2)', () => {
  const WHEN = Date.now() + 86_400_000;
  const NEW_WHEN = Date.now() + 90_000_000;
  const withReminder = () =>
    kv.set(
      'state',
      JSON.stringify({ reminders: [{ id: 'r1', text: 'стоматолог', whenMs: WHEN }] }),
    );

  const deletePending = (id: string) => ({
    id,
    createdMs: Date.now(),
    items: [
      { kind: 'deleteReminder', reminderId: 'r1', base: { title: 'стоматолог', whenMs: WHEN } },
    ],
  });
  const updatePending = (id: string) => ({
    id,
    createdMs: Date.now(),
    items: [
      {
        kind: 'updateReminder',
        reminderId: 'r1',
        base: { title: 'стоматолог', whenMs: WHEN },
        title: 'стоматолог (перенесено)',
        whenMs: NEW_WHEN,
      },
    ],
  });

  it('✅ на скасуванні — нагадування зникає зі стану', async () => {
    withReminder();
    kv.set('assistantPending', JSON.stringify(deletePending('rd123456')));
    await postAccept('rd123456');
    expect(toast()).toContain('Скасовано нагадування');
    expect(JSON.parse(kv.get('state')!).reminders).toHaveLength(0);
  });

  it('✅ на переносі — застосовано і текст, і час', async () => {
    withReminder();
    kv.set('assistantPending', JSON.stringify(updatePending('ru123456')));
    await postAccept('ru123456');
    expect(toast()).toContain('Оновлено');
    const r = JSON.parse(kv.get('state')!).reminders[0];
    expect(r.text).toBe('стоматолог (перенесено)');
    expect(r.whenMs).toBe(NEW_WHEN);
  });

  it('❌ — стан недоторканий (це і є сенс гейта)', async () => {
    withReminder();
    kv.set('assistantPending', JSON.stringify(deletePending('rd123456')));
    await postCb('rd123456', 'c');
    expect(JSON.parse(kv.get('state')!).reminders).toHaveLength(1);
    expect(JSON.parse(kv.get('state')!).reminders[0].text).toBe('стоматолог');
  });

  it('нагадування зникло між пропозицією і ✅ -> чесна відмова, не тиша', async () => {
    kv.set('state', JSON.stringify({ reminders: [] }));
    kv.set('assistantPending', JSON.stringify(deletePending('rd123456')));
    await postAccept('rd123456');
    expect(toast()).toMatch(/не вдалось/i);
  });
});
