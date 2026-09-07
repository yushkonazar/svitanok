// TableChain (етап 5 PR-2, S-1-1…S-1-15): старт з чату (кандидати з кешу
// або пошук, час у минулому - S-1-15, «↩» = скасування), машина станів на
// фейкових step/io (кнопки закладів → контакт → «Подзвонив» → час → точка →
// маршрут/вихід/запрошення/улюблене → «Як було?»), шляхи без телефону, з
// текстовою назвою/номером, «Інший», «Знайшов кілька», скасування в
// очікуванні і без доставленої події, тиша власника, стан nudge; імена
// кроків детерміновані (повторний прогін дає ті самі імена).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  runTableChain,
  startTableChain,
  cancelTableChain,
  findActiveTableChain,
  resolveAt,
  resolveBookingAt,
  resolveCandidates,
  phoneOf,
  streetOf,
  productionIo,
  CHAIN_KIND,
  WAIT_VENUE_MS,
  QUIET_MAX_MS,
  NUDGE_FIRST_MS,
  LEAVE_BUFFER_MIN,
} from '../web/core/chains/table.mjs';
import { chainTarget } from '../web/core/chains/state.mjs';
import { readChainState, patchChainState } from '../web/core/chains/state.mjs';
import { applyPolicy, resolveUndo } from '../web/core/policy/proposals.mjs';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';
import { d1FromSqlite } from './helpers/d1.js';

const MIGRATIONS = [
  '0001_base.sql',
  '0002_assistant.sql',
  '0003_telemetry.sql',
  '0004_ideas_travel.sql',
];
// Понеділок 07.09.2026 10:00 Києва.
const NOW = Date.parse('2026-09-07T07:00:00.000Z');
const AT = Date.parse('2026-09-07T11:00:00.000Z'); // 14:00 Києва
const BOOKING = Date.parse('2026-09-07T16:00:00.000Z'); // 19:00 Києва

type Step = Parameters<typeof runTableChain>[2];
type Io = Parameters<typeof runTableChain>[3];
type Sent = {
  kind: string;
  text: string;
  buttons: string[];
  awaiting: string | null;
  status: string | null;
};

function fakeWorkflow() {
  const created: { id: string; params: unknown }[] = [];
  const events: { id: string; ev: unknown }[] = [];
  return {
    created,
    events,
    binding: {
      create: async (o: { id: string; params: unknown }) => void created.push(o),
      get: async (id: string) => ({
        sendEvent: async (ev: unknown) => void events.push({ id, ev }),
      }),
    } as unknown as Env['TABLE_CHAIN'],
  };
}

function setup(kv: Record<string, string> = {}) {
  const d1 = d1FromSqlite(MIGRATIONS);
  const wf = fakeWorkflow();
  const env = workerEnv({
    DB: d1.stub,
    BRIEFING: memoryKv(new Map(Object.entries(kv))),
    TELEGRAM_CHAT_ID: '555',
    TELEGRAM_OWNER_USER_ID: '777',
    TOPIC_ASSISTANT: '99',
    MAPS_API_KEY: 'k',
    TABLE_CHAIN: wf.binding,
  });
  return { d1, db: d1.db, env, wf };
}

function seedPlace(
  db: ReturnType<typeof setup>['db'],
  id: string,
  over: Record<string, unknown> = {},
) {
  const rowv = {
    place_id: id,
    name: 'Креденс Кафе',
    address: 'вул. Вірменська 6, Львів',
    lat: 49.84,
    lon: 24.03,
    phone: '+380322355555',
    site: 'https://kredens.ua',
    hours_json: JSON.stringify({ weekday: ['пн: 09–22'] }),
    maps_uri: 'https://maps.google.com/?cid=1',
    fetched_at: new Date(NOW).toISOString(),
    ...over,
  };
  db.prepare(
    `INSERT INTO places (place_id, name, address, lat, lon, phone, site, hours_json, maps_uri, fetched_at)
     VALUES (@place_id, @name, @address, @lat, @lon, @phone, @site, @hours_json, @maps_uri, @fetched_at)`,
  ).run(rowv as never);
}

/** Рядок ланцюга + стан, як його лишає startTableChain. */
function seedChain(db: ReturnType<typeof setup>['db'], id: string, state: Record<string, unknown>) {
  db.prepare(
    `INSERT INTO chains (id, kind, workflow_id, state_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'running', 'x', 'x')`,
  ).run(
    id,
    CHAIN_KIND,
    id,
    JSON.stringify({
      venue: 'Креденс',
      at: new Date(AT).toISOString(),
      booking_at: null,
      city: 'Львів',
      candidates: ['P1', 'P2'],
      participants: [],
      chat_id: 555,
      thread_id: '99',
      awaiting: null,
      ...state,
    }),
  );
}

/** Кроки Workflow: do одразу, sleepUntil лише лог, події `table` - з черги (null = тиша). */
function fakeStep(queue: (Record<string, unknown> | null)[], clock: { now: number }) {
  const log: string[] = [];
  const names = new Set<string>();
  const step: Step = {
    do: async (name, fn) => {
      if (names.has(name)) throw new Error(`крок «${name}» повторюється`);
      names.add(name);
      log.push(`do:${name}`);
      return fn();
    },
    sleepUntil: async (name, ms) => {
      if (names.has(name)) throw new Error(`крок «${name}» повторюється`);
      names.add(name);
      log.push(`sleep:${name}`);
      clock.now = Math.max(clock.now, ms);
    },
    waitForEvent: async (name, { type, timeout }) => {
      if (names.has(name)) throw new Error(`крок «${name}» повторюється`);
      names.add(name);
      log.push(`wait:${name}:${type}:${timeout}`);
      const next = queue.shift();
      if (next == null) {
        // Тиша = таймаут: час іде вперед на весь таймаут.
        clock.now += Number(String(timeout).replace(' seconds', '')) * 1000;
        throw new Error('timeout');
      }
      return { payload: next };
    },
  };
  return { step, log };
}

function fakeIo(
  db: ReturnType<typeof setup>['db'],
  chainId: string,
  clock: { now: number },
  over: Partial<Io> = {},
) {
  const sent: Sent[] = [];
  const proposals: { kind: string; payload: Record<string, unknown> }[] = [];
  const detailsCalls: string[] = [];
  const record = (
    kind: string,
    text: string,
    buttons?: { text: string; callback_data?: string; url?: string }[][],
  ) => {
    const st = db
      .prepare(
        `SELECT status, json_extract(state_json, '$.awaiting') AS a FROM chains WHERE id = ?`,
      )
      .get(chainId) as { status: string; a: string | null } | undefined;
    sent.push({
      kind,
      text,
      buttons: (buttons ?? []).flat().map((b) => b.callback_data ?? `url:${b.url}`),
      awaiting: st?.a ?? null,
      status: st?.status ?? null,
    });
  };
  const fromDb = (placeId: string) => {
    const r = db.prepare('SELECT * FROM places WHERE place_id = ?').get(placeId) as
      Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      place_id: String(r.place_id),
      name: String(r.name),
      address: (r.address as string | null) ?? null,
      lat: (r.lat as number | null) ?? null,
      lon: (r.lon as number | null) ?? null,
      maps_uri: (r.maps_uri as string | null) ?? null,
      phone: (r.phone as string | null) ?? null,
      site: (r.site as string | null) ?? null,
      hours: r.hours_json ? (JSON.parse(String(r.hours_json)).weekday as string[]) : [],
      rating_owner: null,
      is_favorite: false,
      visits: 0,
      fetched_at: null,
    };
  };
  const io: Io = {
    now: () => clock.now,
    send: async (text, buttons) => record('send', text, buttons),
    sendContact: async (phone, name, buttons) => record('contact', `${name} ${phone}`, buttons),
    sendVenue: async (lat, lon, title, address, buttons) =>
      record('venue', `${title} @${lat},${lon} ${address}`, buttons),
    search: async (query) =>
      query.includes('Ринок')
        ? [
            {
              place_id: 'P3',
              name: 'Ринок Кафе',
              address: 'пл. Ринок 1',
              lat: 49.8,
              lon: 24.0,
              maps_uri: null,
            },
          ]
        : query.includes('кілька')
          ? [
              {
                place_id: 'P1',
                name: 'Креденс Кафе',
                address: 'вул. Вірменська 6',
                lat: null,
                lon: null,
                maps_uri: null,
              },
              {
                place_id: 'P2',
                name: 'Креденс Дім',
                address: 'пл. Ринок 10',
                lat: null,
                lon: null,
                maps_uri: null,
              },
            ]
          : [],
    cached: async (placeId) => fromDb(placeId),
    details: async (placeId) => {
      detailsCalls.push(placeId);
      return fromDb(placeId);
    },
    eta: async (_to, mode) => ({ duration_min: mode === 'walk' ? 32 : 12, distance_m: 2300 }),
    propose: async (kind, payload) => {
      proposals.push({ kind, payload });
      return {
        id: `prop-${proposals.length}`,
        buttons: [[{ text: '✅', callback_data: `p:prop-${proposals.length}:ok` }]],
      };
    },
    attendees: async (names) => ({
      emails: names.filter((n) => n !== 'Невідомий').map((n) => `${n.toLowerCase()}@x.ua`),
      notes: names.includes('Невідомий') ? ['«Невідомий» не знайдено'] : [],
    }),
    defaultMode: async () => null,
    ...over,
  };
  return { io, sent, proposals, detailsCalls };
}

const stateOf = (db: ReturnType<typeof setup>['db'], id: string) =>
  JSON.parse(
    (db.prepare('SELECT state_json FROM chains WHERE id = ?').get(id) as { state_json: string })
      .state_json,
  );

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('помічники', () => {
  it('resolveAt: природний, голий і ISO час; минуле - S-1-15 з підказкою «завтра о HH:MM»', () => {
    expect(resolveAt('о 14:00', NOW)).toBe(AT);
    expect(resolveAt('14:00', NOW)).toBe(AT);
    expect(resolveAt('на 14', NOW)).toBe(AT);
    expect(resolveAt('2026-09-07T14:00:00+03:00', NOW)).toBe(AT);
    // Парсер переніс би «о 9:00» на завтра мовчки; тут це S-1-15.
    for (const past of ['о 9:00', '9:00', 'о 9 ранку', 'о 9.30']) {
      expect(() => resolveAt(past, NOW)).toThrow(
        /уже минуло - спитай власника: «завтра о 09:[03]0\?»/,
      );
    }
    expect(() => resolveAt('2026-09-07T09:00:00+03:00', NOW)).toThrow(/уже минуло/);
    // Слово про день або відносний час - переносу немає.
    expect(resolveAt('завтра о 9:00', NOW)).toBe(Date.parse('2026-09-08T06:00:00.000Z'));
    expect(resolveAt('через 30 хвилин', NOW)).toBe(NOW + 30 * 60_000);
    expect(resolveAt('о 23:00', NOW)).toBe(Date.parse('2026-09-07T20:00:00.000Z'));
    // «через годину» о 23:30 - не помилка, хоч і завтра.
    const late = Date.parse('2026-09-07T20:30:00.000Z');
    expect(resolveAt('через 60 хвилин', late)).toBe(late + 3_600_000);
    expect(() => resolveAt('', NOW)).toThrow(/обовʼязковий/);
    expect(() => resolveAt('колись', NOW)).toThrow(/не розібрав час/);
  });

  it('resolveBookingAt: «19:00» / «о 19» / «на 19.30» того ж дня, що нагадування; раніше за нього → наступний день', () => {
    expect(resolveBookingAt('на 19:00', AT)).toBe(BOOKING);
    expect(resolveBookingAt('о 19', AT)).toBe(BOOKING);
    expect(resolveBookingAt('19.30', AT)).toBe(Date.parse('2026-09-07T16:30:00.000Z'));
    expect(resolveBookingAt('о 12', AT)).toBe(Date.parse('2026-09-08T09:00:00.000Z'));
    // Нагадування завтра о 12, бронь «на 19» - завтра о 19, не сьогодні.
    const tomorrowNoon = Date.parse('2026-09-08T09:00:00.000Z');
    expect(resolveBookingAt('на 19', tomorrowNoon)).toBe(Date.parse('2026-09-08T16:00:00.000Z'));
    // Бронь раніше за нагадування - наступного дня після ДНЯ нагадування, не «сьогодні».
    expect(resolveBookingAt('на 10', tomorrowNoon)).toBe(Date.parse('2026-09-09T07:00:00.000Z'));
    expect(resolveBookingAt('2026-09-07T19:00:00+03:00', AT)).toBe(BOOKING);
    expect(resolveBookingAt('не знаю', AT)).toBeNull();
    expect(resolveBookingAt('25:00', AT)).toBeNull();
  });

  it('phoneOf і streetOf', () => {
    expect(phoneOf('+380 32 235-55-55')).toBe('+380322355555');
    expect(phoneOf('номер 032 235 55 55')).toBe('0322355555');
    expect(phoneOf('Креденс')).toBeNull();
    expect(phoneOf('12345')).toBeNull();
    expect(phoneOf('столик на 7 8 9 10 11 12')).toBeNull();
    expect(streetOf('вул. Вірменська 6, Львів')).toBe(' · вул. Вірменська 6');
    expect(streetOf(null)).toBe('');
  });

  it('chainTarget: чат/тред старту; dm → особистий чат власника; без адреси - помилка', () => {
    const { env } = setup();
    expect(chainTarget(env, { chat_id: 555, thread_id: '99' })).toEqual({
      chatId: '555',
      threadId: '99',
    });
    expect(chainTarget(env, { chat_id: null, thread_id: 'dm' })).toEqual({
      chatId: '777',
      threadId: null,
    });
    expect(chainTarget(env, { chat_id: null, thread_id: null })).toEqual({
      chatId: '555',
      threadId: '99',
    });
    expect(() => chainTarget(workerEnv({}), { chat_id: null, thread_id: '99' })).toThrow(
      /немає чату/,
    );
  });
});

describe('startTableChain (виконавець chain.start kind=table)', () => {
  it('кандидати з кешу (лише відомі place_id) → рядок chains + інстанс; текст для власника', async () => {
    const { env, db, wf } = setup();
    seedPlace(db, 'P1');
    seedPlace(db, 'P2', { name: 'Креденс Дім' });
    const out = await startTableChain(
      env,
      { venue: 'Креденс', at: 'о 14:00', city: 'Львів', candidates: ['P1', 'вигаданий', 'P2'] },
      NOW,
      { chatId: 555, threadId: '99' },
    );
    expect(out.result).toMatchObject({
      at: '14:00',
      candidates: 2,
      text: 'Нагадаю о 14:00 і дам список закладів (знайшов 2, Львів).',
    });
    expect(wf.created).toEqual([
      { id: out.result.chain_id, params: { chainId: out.result.chain_id } },
    ]);
    const rowc = await readChainState(env, out.result.chain_id);
    expect(rowc).toMatchObject({
      status: 'running',
      state: {
        venue: 'Креденс',
        candidates: ['P1', 'P2'],
        city: 'Львів',
        chat_id: 555,
        thread_id: '99',
      },
    });
    expect(rowc?.state.at).toBe(new Date(AT).toISOString());
  });

  it('booking_at - відносно дня нагадування; кривий - помилка', async () => {
    const { env, db } = setup();
    seedPlace(db, 'P1');
    const out = await startTableChain(
      env,
      { venue: 'Креденс', at: 'завтра о 12', booking_at: 'на 19', candidates: ['P1'] },
      NOW,
      { chatId: 555, threadId: '99' },
    );
    expect((await readChainState(env, out.result.chain_id))?.state.booking_at).toBe(
      '2026-09-08T16:00:00.000Z',
    );
    await expect(
      startTableChain(env, { venue: 'X', at: 'о 14:00', booking_at: 'колись' }, NOW, {}),
    ).rejects.toThrow(/не розібрав час броні/);
  });

  it('без кандидатів - власний пошук (near з geo.last ≤ 6 год, city - без near); порожньо - «спитаю назву»', async () => {
    const { env, db } = setup({
      ownerGeoManual: JSON.stringify({ lat: 49.84, lon: 24.03, setAtMs: NOW - 3_600_000 }),
    });
    db.prepare(
      `INSERT INTO quota_counters (key, period, value, limit_value, updated_at) VALUES ('places_text', '2026-09', 0, 5000, 'x')`,
    ).run();
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        calls.push(String(init?.body));
        return new Response(
          JSON.stringify({
            places: [{ id: 'N1', displayName: { text: 'Креденс' }, formattedAddress: 'вул. X' }],
          }),
          { status: 200 },
        );
      }),
    );
    const found = await resolveCandidates(
      env,
      { venue: 'Креденс', city: null, candidates: [] },
      NOW,
    );
    expect(found).toEqual({ ids: ['N1'], searched: true });
    expect(JSON.parse(calls[0]!).locationBias.circle.center).toEqual({
      latitude: 49.84,
      longitude: 24.03,
    });
    // Місто в тексті - без near (S-1-3).
    await resolveCandidates(env, { venue: 'Креденс', city: 'Київ', candidates: [] }, NOW);
    expect(JSON.parse(calls[1]!)).toMatchObject({ textQuery: 'Креденс, Київ' });
    expect(JSON.parse(calls[1]!).locationBias).toBeUndefined();

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ places: [] }), { status: 200 })),
    );
    const out = await startTableChain(env, { venue: 'Нема', at: 'о 14:00' }, NOW, {
      chatId: 555,
      threadId: '99',
    });
    expect(out.result.text).toContain('не знайшов - спитаю назву точніше або номер');
    expect(out.result.candidates).toBe(0);
  });

  it('квота 100 % / збій API - ланцюг без списку, «довідник недоступний» лише при квоті', async () => {
    const { env, db } = setup();
    db.prepare(
      `INSERT INTO quota_counters (key, period, value, limit_value, updated_at) VALUES ('places_text', '2026-09', 5000, 5000, 'x')`,
    ).run();
    const out = await startTableChain(env, { venue: 'Креденс', at: 'о 14:00' }, NOW, {
      chatId: 555,
      threadId: '99',
    });
    expect(out.result.text).toContain('довідник закладів зараз недоступний');
  });

  it('через policy: T0 з «↩»; «↩» скасовує ланцюг (подія cancel), другий «↩» - чесна відмова', async () => {
    const { env, db, wf } = setup();
    seedPlace(db, 'P1');
    const out = await applyPolicy(
      env,
      {
        kind: 'chain.start',
        payload: {
          kind: 'table',
          payload: { venue: 'Креденс', at: 'о 14:00', candidates: ['P1'] },
        },
        threadId: '99',
        chatId: 555,
        tainted: false,
      },
      NOW,
    );
    if (out.mode !== 'executed') throw new Error(`mode ${out.mode}`);
    expect(out.undo).toBeTruthy();
    const chainId = (out.result as { chain_id: string }).chain_id;
    expect(await findActiveTableChain(env, null)).toEqual({ id: chainId, venue: 'Креденс' });
    expect(await resolveUndo(env, out.undo!.id, NOW + 1000)).toEqual({
      ok: true,
      status: 'undone',
    });
    expect((await readChainState(env, chainId))?.status).toBe('cancelled');
    expect(wf.events).toEqual([
      { id: chainId, ev: { type: 'table', payload: { action: 'cancel' } } },
    ]);
    expect(await findActiveTableChain(env, null)).toBeNull();
    expect(await cancelTableChain(env, chainId)).toBe(false);
  });

  it('chain.cancel через policy: найсвіжіший активний або за id; kind не table - відмова; без активного - помилка', async () => {
    const { env, db } = setup();
    seedChain(db, 'c1', {});
    await expect(
      applyPolicy(
        env,
        { kind: 'chain.cancel', payload: { kind: 'day-plan' }, tainted: false },
        NOW,
      ),
    ).rejects.toThrow(/скасувати можна table, price або trip/);
    const out = await applyPolicy(env, { kind: 'chain.cancel', payload: {}, tainted: false }, NOW);
    expect(out).toMatchObject({
      mode: 'executed',
      result: { cancelled: true, chain_id: 'c1', venue: 'Креденс' },
    });
    await expect(
      applyPolicy(env, { kind: 'chain.cancel', payload: {}, tainted: false }, NOW),
    ).rejects.toThrow(/активного ланцюга столика немає/);
  });

  it('без привʼязки TABLE_CHAIN або без venue/at - явна відмова, рядка немає', async () => {
    const { env, db } = setup();
    (env as { TABLE_CHAIN?: unknown }).TABLE_CHAIN = undefined;
    await expect(startTableChain(env, { venue: 'X', at: 'о 14:00' }, NOW, {})).rejects.toThrow(
      /TABLE_CHAIN/,
    );
    const { env: env2 } = setup();
    await expect(startTableChain(env2, { at: 'о 14:00' }, NOW, {})).rejects.toThrow(/venue/);
    expect(db.prepare('SELECT count(*) AS n FROM chains').get()).toEqual({ n: 0 });
  });
});

describe('runTableChain - машина станів', () => {
  it('щасливий шлях: кнопки → деталі ОДНОГО закладу → контакт+години → Подзвонив → час → точка → маршрут/вихід/запрошення/улюблене → Як було', async () => {
    const { env, db } = setup();
    seedPlace(db, 'P1');
    seedPlace(db, 'P2', { name: 'Креденс Дім', address: 'пл. Ринок 10' });
    seedChain(db, 'c1', {});
    const clock = { now: AT };
    const { step, log } = fakeStep(
      [
        { action: 'venue', index: 0 },
        { action: 'called' },
        { action: 'text', text: 'на 19:00' },
        { action: 'next', choice: 'route' },
        { action: 'mode', mode: 'walk' },
        { action: 'next', choice: 'leave' },
        { action: 'next', choice: 'invite' },
        { action: 'text', text: 'Оля, Марко' },
        { action: 'next', choice: 'fav' },
        { action: 'next', choice: 'done' },
        { action: 'rating', stars: 5 },
      ],
      clock,
    );
    const { io, sent, proposals, detailsCalls } = fakeIo(db, 'c1', clock);
    const out = await runTableChain(env, { chainId: 'c1' }, step, io);
    expect(out).toEqual({ outcome: 'done', place_id: 'P1' });

    expect(log[0]).toBe('do:state');
    expect(log.some((l) => l.includes('until-at'))).toBe(false); // уже 14:00
    // Кнопки закладів з кешу (без Place Details): назва · вулиця + «Інший» + «✖».
    const venueMsg = sent.find((s) => s.text.startsWith('Столик у Креденс'))!;
    expect(venueMsg.buttons).toEqual(['c:c1:v0', 'c:c1:v1', 'c:c1:vother', 'c:c1:cancel']);
    expect(venueMsg.awaiting).toBeNull();
    // Details - рівно один раз, для обраного (SKU Enterprise).
    expect(detailsCalls).toEqual(['P1']);
    // Контакт із телефоном, кнопками й сайтом; години окремим рядком.
    const contact = sent.find((s) => s.kind === 'contact')!;
    expect(contact.text).toBe('Креденс Кафе +380322355555');
    expect(contact.buttons).toEqual(['c:c1:called', 'c:c1:later', 'url:https://kredens.ua']);
    expect(contact.awaiting).toBeNull(); // між станами - running
    expect(sent.some((s) => s.text === 'Години: пн: 09–22')).toBe(true);
    // «На котру?» → 19:00 → точка на карті з діями.
    expect(sent.some((s) => s.text === 'На котру годину бронь?')).toBe(true);
    const venue = sent.find((s) => s.kind === 'venue')!;
    expect(venue.text).toBe('Креденс Кафе о 19:00 @49.84,24.03 вул. Вірменська 6, Львів');
    expect(venue.buttons).toEqual([
      'c:c1:route',
      'c:c1:leave',
      'c:c1:invite',
      'c:c1:fav',
      'c:c1:done',
    ]);
    // Маршрут: карта + питання способу + «32 хв пішки».
    expect(sent.some((s) => s.text === 'Карта: https://maps.google.com/?cid=1')).toBe(true);
    expect(sent.find((s) => s.text === 'Як добираєшся?')!.buttons).toEqual([
      'c:c1:mwalk',
      'c:c1:mtransit',
      'c:c1:mcar',
    ]);
    expect(sent.some((s) => s.text === '32 хв пішки.')).toBe(true);
    // Вихід: спосіб уже відомий (walk), пропозиція T1 на 19:00 - 32 - 3 = 18:25.
    const leave = proposals.find((p) => p.kind === 'calendar.event')!;
    expect(leave.payload).toMatchObject({
      title: 'Вийти до «Креденс Кафе»',
      startIso: new Date(BOOKING - (32 + LEAVE_BUFFER_MIN) * 60_000).toISOString(),
      endIso: '2026-09-07T16:00:00.000Z',
      reminderMinutes: 5,
      location: 'вул. Вірменська 6, Львів',
    });
    const leaveMsg = sent.find((s) => s.text.startsWith('Вийти о 18:25'))!;
    expect(leaveMsg.text).toBe('Вийти о 18:25 (пішки 32 хв + 3 хв) - у календар?');
    expect(leaveMsg.buttons).toEqual(['p:prop-1:ok']);
    // Запрошення: «Кого?» → імена → email-и (видно власнику) → пропозиція invite.
    expect(sent.some((s) => s.text === 'Кого запросити? Імена через кому.')).toBe(true);
    const invite = proposals.find((p) => p.kind === 'invite')!;
    expect(invite.payload).toMatchObject({
      title: 'Креденс Кафе',
      startIso: '2026-09-07T16:00:00.000Z',
      endIso: '2026-09-07T18:00:00.000Z',
      attendees: ['оля@x.ua', 'марко@x.ua'],
    });
    expect(
      sent.some((s) =>
        s.text.startsWith('Запросити Оля, Марко (оля@x.ua, марко@x.ua) на 19:00 у Креденс Кафе'),
      ),
    ).toBe(true);
    // Улюблене - T0 у places; «Як було?» після кінця + 2 год; оцінка й visits.
    expect(sent.some((s) => s.text === 'Креденс Кафе - в улюблених ⭐')).toBe(true);
    expect(log).toContain('sleep:after-end');
    expect(sent.find((s) => s.text === 'Як було у Креденс Кафе?')!.buttons).toEqual([
      'c:c1:r1',
      'c:c1:r2',
      'c:c1:r3',
      'c:c1:r4',
      'c:c1:r5',
      'c:c1:rskip',
    ]);
    expect(
      db
        .prepare(`SELECT is_favorite, rating_owner, visits FROM places WHERE place_id = 'P1'`)
        .get(),
    ).toEqual({ is_favorite: 1, rating_owner: 5, visits: 1 });
    expect(
      db
        .prepare(
          `SELECT status, json_extract(state_json, '$.booking_at') AS b, json_extract(state_json, '$.mode') AS m FROM chains WHERE id = 'c1'`,
        )
        .get(),
    ).toEqual({ status: 'done', b: '2026-09-07T16:00:00.000Z', m: 'walk' });
  });

  it('стан venue несе nudge (+5 хв) і awaiting_since; після кнопки nudge стирається; повторне очікування того ж стану не зсуває awaiting_since', async () => {
    const { env, db } = setup();
    seedPlace(db, 'P1');
    seedChain(db, 'c1', { candidates: ['P1'] });
    const clock = { now: AT };
    const seen: Record<string, unknown>[] = [];
    const { step } = fakeStep([null, { action: 'cancel' }], clock);
    const origWait = step.waitForEvent;
    step.waitForEvent = async (name, opts) => {
      seen.push(
        db.prepare(`SELECT status, state_json FROM chains WHERE id = 'c1'`).get() as Record<
          string,
          unknown
        >,
      );
      return origWait(name, opts);
    };
    const { io } = fakeIo(db, 'c1', clock);
    expect(await runTableChain(env, { chainId: 'c1' }, step, io)).toEqual({ outcome: 'cancelled' });
    const first = JSON.parse(String(seen[0]!.state_json));
    expect(seen[0]!.status).toBe('waiting');
    expect(first.awaiting).toBe('venue');
    expect(first.awaiting_since).toBe(new Date(AT).toISOString());
    expect(first.nudge).toEqual({ at: new Date(AT + NUDGE_FIRST_MS).toISOString(), n: 0 });
    // Друге очікування (тиша) - той самий стан: since лишається, nudge знято.
    const second = JSON.parse(String(seen[1]!.state_json));
    expect(second.awaiting_since).toBe(new Date(AT).toISOString());
    expect(second.nudge).toBeUndefined();
    const after = stateOf(db, 'c1');
    expect(after.nudge).toBeUndefined();
    expect(after.awaiting).toBeUndefined();
  });

  it('без телефону: «Ввести номер» → кривий номер → підказка → номер → контакт; «Пізніше» повторює; чужа кнопка в контакті ігнорується', async () => {
    const { env, db } = setup();
    seedPlace(db, 'P1', { phone: null, hours_json: JSON.stringify({ weekday: [] }) });
    seedChain(db, 'c1', { candidates: ['P1'], booking_at: '2026-09-07T16:00:00.000Z' });
    const clock = { now: AT };
    const { step, log } = fakeStep(
      [
        { action: 'venue', index: 0 },
        { action: 'phone' },
        { action: 'text', text: 'не памʼятаю' },
        { action: 'text', text: 'номер 032 235 55 55' },
        { action: 'venue', index: 0 }, // застаріла кнопка списку - ігнор
        { action: 'later' },
        { action: 'called' },
        { action: 'next', choice: 'done' },
        { action: 'rating', stars: null },
      ],
      clock,
    );
    const { io, sent } = fakeIo(db, 'c1', clock);
    expect(await runTableChain(env, { chainId: 'c1' }, step, io)).toEqual({
      outcome: 'done',
      place_id: 'P1',
    });
    const noPhone = sent.find((s) => s.text.includes('телефону в довіднику немає'))!;
    expect(noPhone.buttons).toEqual(['url:https://kredens.ua', 'c:c1:phone', 'c:c1:called']);
    expect(sent.some((s) => s.text === 'Напиши номер телефону закладу.')).toBe(true);
    expect(sent.some((s) => s.text === 'Номер не розпізнав - напиши цифрами.')).toBe(true);
    const contacts = sent.filter((s) => s.kind === 'contact');
    expect(contacts).toHaveLength(2); // після номера + після «Пізніше»
    expect(contacts[0]!.text).toBe('Креденс Кафе 0322355555');
    expect(log.some((l) => l.startsWith('sleep:contact-') && l.endsWith('later-sleep'))).toBe(true);
    // Час броні відомий - «На котру?» не питає.
    expect(sent.some((s) => s.text === 'На котру годину бронь?')).toBe(false);
    expect(
      db.prepare(`SELECT rating_owner, visits FROM places WHERE place_id = 'P1'`).get(),
    ).toEqual({
      rating_owner: null,
      visits: 1,
    });
    expect(stateOf(db, 'c1').rating).toBeUndefined();
  });

  it('«Інший» → назва → 1 збіг у довіднику → далі як із кешу; «Знайшов кілька» → кнопки → вибір', async () => {
    const { env, db } = setup();
    seedPlace(db, 'P1');
    seedPlace(db, 'P2', { name: 'Креденс Дім' });
    seedPlace(db, 'P3', {
      name: 'Ринок Кафе',
      address: 'пл. Ринок 1',
      phone: '+380111111111',
      site: null,
    });
    seedChain(db, 'c1', { candidates: ['P1'] });
    const clock = { now: AT };
    const { step } = fakeStep(
      [
        { action: 'venue', other: true },
        { action: 'text', text: 'Ринок Кафе' },
        { action: 'cancel' },
      ],
      clock,
    );
    const { io, sent, detailsCalls } = fakeIo(db, 'c1', clock);
    expect(await runTableChain(env, { chainId: 'c1' }, step, io)).toEqual({ outcome: 'cancelled' });
    expect(sent.some((s) => s.text === 'Напиши назву закладу або номер телефону.')).toBe(true);
    const contact = sent.find((s) => s.kind === 'contact')!;
    expect(contact.text).toBe('Ринок Кафе +380111111111');
    expect(contact.buttons).toEqual(['c:c1:called', 'c:c1:later']);
    expect(detailsCalls).toEqual(['P3']);
    expect(sent.at(-1)!.text).toBe('Скасував ланцюг «столик у Креденс».');
    expect((await readChainState(env, 'c1'))?.status).toBe('cancelled');

    // Кілька збігів - новий список кнопок, вибір другого.
    seedChain(db, 'c2', { candidates: [] });
    const clock2 = { now: AT };
    const { step: step2 } = fakeStep(
      [{ action: 'text', text: 'кілька' }, { action: 'venue', index: 1 }, { action: 'cancel' }],
      clock2,
    );
    const { io: io2, sent: sent2, detailsCalls: dc2 } = fakeIo(db, 'c2', clock2);
    expect(await runTableChain(env, { chainId: 'c2' }, step2, io2)).toEqual({
      outcome: 'cancelled',
    });
    const again = sent2.find((s) => s.text === 'Знайшов кілька:')!;
    expect(again.buttons).toEqual(['c:c2:v0', 'c:c2:v1', 'c:c2:vother', 'c:c2:cancel']);
    expect(dc2).toEqual(['P2']);
    expect(sent2.find((s) => s.kind === 'contact')!.text).toBe('Креденс Дім +380322355555');
  });

  it('без списку: текст-номер → контакт із назвою ланцюга; текст без збігів - назва без довідника (send, не venue); годинник у стані next уточнює бронь', async () => {
    const { env, db } = setup();
    seedChain(db, 'c1', { candidates: [] });
    const clock = { now: AT };
    const { step } = fakeStep(
      [
        { action: 'text', text: '+380 67 000 00 00' },
        { action: 'called' },
        { action: 'text', text: 'не знаю' },
        { action: 'text', text: 'на 20:00' },
        { action: 'next', choice: 'done' },
        null,
      ],
      clock,
    );
    const { io, sent } = fakeIo(db, 'c1', clock);
    expect(await runTableChain(env, { chainId: 'c1' }, step, io)).toEqual({
      outcome: 'done',
      place_id: null,
    });
    expect(sent.find((s) => s.kind === 'contact')!.text).toBe('Креденс +380670000000');
    expect(sent.some((s) => s.kind === 'venue')).toBe(false);
    expect(sent.some((s) => s.text === 'Креденс - записав.')).toBe(true);
    expect(sent.some((s) => s.text === 'Бронь о 20:00 - записав.')).toBe(true);
    expect(stateOf(db, 'c1').booking_at).toBe('2026-09-07T17:00:00.000Z');
    // Тиша на «Як було?» - done без оцінки (ключа rating немає).
    expect(stateOf(db, 'c1').rating).toBeUndefined();
  });

  it('тиша 24 год + тиждень без вибору → done (abandoned), стан без nudge; 4 раунди без вибору → giveup', async () => {
    const { env, db } = setup();
    seedPlace(db, 'P1');
    seedChain(db, 'c1', { candidates: ['P1'] });
    const clock = { now: AT };
    const { step, log } = fakeStep([null, null], clock);
    const { io } = fakeIo(db, 'c1', clock);
    expect(await runTableChain(env, { chainId: 'c1' }, step, io)).toEqual({ outcome: 'abandoned' });
    expect(log.filter((l) => l.startsWith('wait:venue')).map((l) => l.split(':')[3])).toEqual([
      `${WAIT_VENUE_MS / 1000} seconds`,
      `${QUIET_MAX_MS / 1000} seconds`,
    ]);
    expect((await readChainState(env, 'c1'))?.status).toBe('done');

    seedChain(db, 'c2', { candidates: [] });
    const clock2 = { now: AT };
    const { step: step2 } = fakeStep(
      Array.from({ length: 5 }, () => ({ action: 'text', text: 'кілька' })),
      clock2,
    );
    const { io: io2, sent: sent2 } = fakeIo(db, 'c2', clock2);
    expect(await runTableChain(env, { chainId: 'c2' }, step2, io2)).toEqual({
      outcome: 'abandoned',
    });
    expect(sent2.at(-1)!.text).toContain('Заклад так і не обрано');
  });

  it('сон до 14:00: чужа подія ігнорується (сон триває), cancel - кінець; скасування ззовні без події - зупинка на першому записі стану', async () => {
    const { env, db } = setup();
    seedPlace(db, 'P1');
    seedChain(db, 'c1', { candidates: ['P1'] });
    const clock = { now: NOW };
    const { step, log } = fakeStep([{ action: 'called' }, { action: 'cancel' }], clock);
    const { io, sent } = fakeIo(db, 'c1', clock);
    expect(await runTableChain(env, { chainId: 'c1' }, step, io)).toEqual({ outcome: 'cancelled' });
    expect(log.filter((l) => l.includes('until-at'))).toEqual([
      'wait:until-at-0:table:14400 seconds',
      'wait:until-at-1:table:14400 seconds',
    ]);
    expect(sent).toHaveLength(1);

    // chain.cancel поставив cancelled, подія не дійшла; далі прийшла стара кнопка.
    seedChain(db, 'c2', { candidates: ['P1'] });
    const clock2 = { now: AT };
    const { step: step2 } = fakeStep([{ action: 'venue', index: 0 }], clock2);
    const orig = step2.waitForEvent;
    step2.waitForEvent = async (name, opts) => {
      db.prepare(`UPDATE chains SET status = 'cancelled' WHERE id = 'c2'`).run();
      return orig(name, opts);
    };
    const { io: io2, sent: sent2, detailsCalls } = fakeIo(db, 'c2', clock2);
    expect(await runTableChain(env, { chainId: 'c2' }, step2, io2)).toEqual({
      outcome: 'cancelled',
    });
    expect(detailsCalls).toEqual(['P1']);
    expect(sent2.filter((s) => s.kind === 'contact')).toHaveLength(0);
    expect((await readChainState(env, 'c2'))?.status).toBe('cancelled');
  });

  it('вихід без часу броні - підказка; запрошення без email - нотатки; default_mode - без питання', async () => {
    const { env, db } = setup();
    seedPlace(db, 'P1');
    seedChain(db, 'c1', { candidates: ['P1'] });
    const clock = { now: AT };
    const { step } = fakeStep(
      [
        { action: 'venue', index: 0 },
        { action: 'called' },
        { action: 'text', text: 'не знаю' },
        { action: 'next', choice: 'leave' },
        { action: 'next', choice: 'invite' },
        { action: 'cancel' },
      ],
      clock,
    );
    const { io, sent, proposals } = fakeIo(db, 'c1', clock, { defaultMode: async () => 'car' });
    expect(await runTableChain(env, { chainId: 'c1' }, step, io)).toEqual({ outcome: 'cancelled' });
    expect(sent.some((s) => s.text === 'Як добираєшся?')).toBe(false);
    expect(sent.filter((s) => s.text.startsWith('Не знаю часу броні'))).toHaveLength(2);
    expect(proposals).toHaveLength(0);
    expect(stateOf(db, 'c1').mode).toBe('car');

    seedPlace(db, 'P5', { name: 'Інше' });
    seedChain(db, 'c2', { candidates: ['P5'], booking_at: '2026-09-07T16:00:00.000Z' });
    const clock2 = { now: AT };
    const { step: step2 } = fakeStep(
      [
        { action: 'venue', index: 0 },
        { action: 'called' },
        { action: 'next', choice: 'invite' },
        { action: 'text', text: 'Невідомий' },
        { action: 'cancel' },
      ],
      clock2,
    );
    const { io: io2, sent: sent2, proposals: p2 } = fakeIo(db, 'c2', clock2);
    await runTableChain(env, { chainId: 'c2' }, step2, io2);
    expect(sent2.some((s) => s.text.startsWith('Email не знайшов: «Невідомий» не знайдено'))).toBe(
      true,
    );
    expect(p2).toHaveLength(0);
  });

  it('збій routes.eta - «порахувати не вдалось» з причиною, без пропозиції; збій деталей - контакт без телефону, ланцюг живе', async () => {
    const { env, db } = setup();
    seedPlace(db, 'P1');
    seedChain(db, 'c1', { candidates: ['P1'], booking_at: '2026-09-07T16:00:00.000Z' });
    const clock = { now: AT };
    const { step } = fakeStep(
      [
        { action: 'venue', index: 0 },
        { action: 'called' },
        { action: 'next', choice: 'leave' },
        { action: 'mode', mode: 'walk' },
        { action: 'cancel' },
      ],
      clock,
    );
    const { io, sent, proposals } = fakeIo(db, 'c1', clock, {
      eta: async () => {
        throw new Error('routes.eta: остання локація старша за 9 год');
      },
      details: async () => {
        throw new Error('Place details: HTTP 500');
      },
    });
    await runTableChain(env, { chainId: 'c1' }, step, io);
    expect(sent.some((s) => s.text.includes('телефону в довіднику немає'))).toBe(true);
    expect(
      sent.some(
        (s) =>
          s.text === 'Маршрут порахувати не вдалось (routes.eta: остання локація старша за 9 год).',
      ),
    ).toBe(true);
    expect(proposals).toHaveLength(0);
  });
});

describe('productionIo і стан', () => {
  it('адреса з state (chat/thread), контакт і точка йдуть в outbox видами contact/venue', async () => {
    const { env, db } = setup();
    seedChain(db, 'c1', {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"ok":true,"result":{"message_id":1}}', { status: 200 })),
    );
    (env as { TELEGRAM_BOT_TOKEN?: string }).TELEGRAM_BOT_TOKEN = 't';
    const io = productionIo(env, 'c1', stateOf(db, 'c1'));
    await io.sendContact('+380', 'Креденс', [[{ text: 'x', callback_data: 'c:c1:called' }]]);
    await io.sendVenue(49.8, 24.0, 'Креденс', 'адреса');
    await io.send('привіт');
    const rows = db
      .prepare('SELECT kind, chat_id, thread_id, payload_json FROM outbox ORDER BY id')
      .all() as { kind: string; chat_id: string; thread_id: string; payload_json: string }[];
    expect(rows.map((r) => [r.kind, r.chat_id, r.thread_id])).toEqual([
      ['contact', '555', '99'],
      ['venue', '555', '99'],
      ['send', '555', '99'],
    ]);
    expect(JSON.parse(rows[0]!.payload_json)).toMatchObject({
      phone_number: '+380',
      first_name: 'Креденс',
    });
    expect(JSON.parse(rows[1]!.payload_json)).toMatchObject({
      latitude: 49.8,
      longitude: 24.0,
      title: 'Креденс',
    });
    expect(await io.defaultMode()).toBeNull();
    expect(await io.cached('nope')).toBeNull();
  });

  it('patchChainState: json_patch зливає стан, null стирає ключ; unlessCancelled не чіпає скасований', async () => {
    const { env, db } = setup();
    seedChain(db, 'c1', { nudge: { at: 'x', n: 0 } });
    expect(await patchChainState(env, 'c1', 'waiting', { awaiting: 'venue', nudge: null })).toBe(
      true,
    );
    const st = await readChainState(env, 'c1');
    expect(st).toMatchObject({ status: 'waiting', state: { awaiting: 'venue', venue: 'Креденс' } });
    expect(st?.state.nudge).toBeUndefined();
    db.prepare(`UPDATE chains SET status = 'cancelled' WHERE id = 'c1'`).run();
    expect(
      await patchChainState(env, 'c1', 'running', { awaiting: null }, { unlessCancelled: true }),
    ).toBe(false);
    expect((await readChainState(env, 'c1'))?.status).toBe('cancelled');
  });
});
