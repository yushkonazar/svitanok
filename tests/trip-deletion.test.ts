import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync } from 'node:fs';
import { d1FromSqlite } from './helpers/d1.js';
import { workerEnv } from './helpers/env.js';
import { buildInitData } from './helpers/init-data.js';
import { handleTrips, readTravelWorkspace } from '../web/api-trips.mjs';
import { tripScopeKey, runTripBrief } from '../web/core/tools/trip.mjs';
import { startTripChain, productionIo } from '../web/core/chains/trip.mjs';
import { finishPlanningSearch } from '../web/core/trips/planning.mjs';
import { enqueueOutbox, drainOutbox } from '../web/core/tg/outbox.mjs';

const NOW = Date.parse('2026-10-22T13:00:00Z');
const CTX = { chatId: 777, threadId: null };
const TRIP = 'trip-delete-1111',
  CHAIN = 'chain-delete-1111',
  BRIEF = 'brief-delete-1111';
const WISH = 'wish-delete-1111';
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function setup() {
  const d = d1FromSqlite(
    readdirSync(new URL('../web/core/migrations/', import.meta.url))
      .filter((f) => f.endsWith('.sql'))
      .sort(),
    { atomicBatch: true },
  );
  const terminate = vi.fn(async () => {});
  const create = vi.fn(async () => ({}));
  const env = workerEnv({
    DB: d.stub,
    TELEGRAM_OWNER_USER_ID: '777',
    TELEGRAM_CHAT_ID: '-100123',
    TELEGRAM_BOT_TOKEN: 'test-token',
    ASSISTANT_HOME: 'dm',
    TRIP_CHAIN: { create, get: vi.fn(async () => ({ sendEvent: vi.fn(), terminate })) },
  });
  const init = await buildInitData(777, 'test-token');
  const post = (body: unknown, auth = init) =>
    handleTrips(
      new Request('https://svitanok.test/api/trips', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Telegram-Init-Data': auth },
        body: JSON.stringify(body),
      }),
      env,
    );
  const seedBrief = (status = 'draft', chatId = 777) =>
    d.db
      .prepare(
        'INSERT INTO trip_briefs(id,scope_key,answers_json,status,created_at,updated_at) VALUES (?,?,?,?,?,?)',
      )
      .run(
        BRIEF,
        tripScopeKey({ chatId, threadId: null }),
        JSON.stringify({
          to: 'Прага',
          from_city: 'Львів',
          date_from: '2026-11-12',
          date_to: '2026-11-16',
          mode: 'bus',
          _meta: { revision: 3 },
          _planning: { active: { run_id: 'research-delete-1111' } },
        }),
        status,
        new Date(NOW).toISOString(),
        new Date(NOW).toISOString(),
      );
  const state = {
    trip_id: TRIP,
    to_text: 'Прага',
    from_city: 'Львів',
    date_from: '2026-11-12',
    date_to: '2026-11-16',
    mode: 'bus',
    country: 'Чехія',
    vehicle_key: null,
    checklist_key: 'abroad-plane-bus',
    depart_at: null,
    awaiting: null,
    purpose: null,
    participants: null,
    chat_id: 777,
    thread_id: null,
    brief_id: BRIEF,
    support_version: 3,
    preferences: {},
  };
  const seedTrip = (status = 'active', chatId = 777) => {
    seedBrief('started', chatId);
    d.db
      .prepare(
        "INSERT INTO chains(id,kind,workflow_id,state_json,status,created_at,updated_at) VALUES (?,'trip',?,?,'running','x','x')",
      )
      .run(CHAIN, 'workflow-delete-1111', JSON.stringify({ ...state, chat_id: chatId }));
    d.db
      .prepare(
        "INSERT INTO wishes(id,type,title,payload_json,status,created_at) VALUES (?,'trip','Прага',?,'active','x')",
      )
      .run(WISH, JSON.stringify({ trip_id: TRIP }));
    d.db
      .prepare(
        "INSERT INTO trips(id,workflow_id,wish_id,to_text,date_from,date_to,mode,cost_json,status) VALUES (?,?,?,'Прага','2026-11-12','2026-11-16','bus',?,?)",
      )
      .run(
        TRIP,
        CHAIN,
        WISH,
        JSON.stringify({
          travel: {
            revision: 2,
            tasks: [{ id: 'packing-item', title: 'Паспорт', status: 'open' }],
          },
        }),
        status,
      );
  };
  const remove = (id = TRIP, kind = 'trip', revision = 2) =>
    post({ op: 'delete', id, revision, data: { confirm: true, kind } });
  const count = (table: string) =>
    Number(d.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n);
  return { ...d, env, post, seedBrief, seedTrip, remove, terminate, create, count, state };
}

describe('owner trip deletion', () => {
  it.each(['draft', 'paused', 'started'])(
    'deletes a %s planning draft and returns an empty workspace',
    async (status) => {
      const f = await setup();
      f.seedBrief(status);
      const response = await f.remove(BRIEF, 'draft', 3);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        acknowledged: true,
        items: [],
        current: null,
        receipt: { deleted_id: BRIEF },
      });
      expect(f.count('trip_briefs')).toBe(0);
      expect(f.terminate).not.toHaveBeenCalled();
    },
  );
  it.each(['active', 'done', 'cancelled', 'failed'])(
    'deletes a %s trip, its brief, wish, reminders and queued notices',
    async (status) => {
      const f = await setup();
      f.seedTrip(status);
      f.db
        .prepare(
          "INSERT INTO reminders(id,due_at,text,chain_id,status) VALUES ('reminder-one','x','Подорож',?,'pending')",
        )
        .run(CHAIN);
      for (const [id, payload] of [
        ['morning', { trip_notice: { trip_id: TRIP } }],
        ['monitor', { trip_monitor_notice: { trip_id: TRIP } }],
        ['chain', { trip_chain_notice: { trip_id: TRIP, chain_id: CHAIN } }],
        [
          'legacy',
          {
            reply_markup: {
              inline_keyboard: [[{ text: 'Далі', callback_data: `c:${CHAIN}:next` }]],
            },
          },
        ],
      ] as const)
        f.db
          .prepare(
            "INSERT INTO outbox(id,chat_id,kind,payload_json,status) VALUES (?,'777','send',?,'pending')",
          )
          .run(id, JSON.stringify(payload));
      f.db
        .prepare(
          "INSERT INTO outbox(id,chat_id,kind,payload_json,status) VALUES ('unrelated','777','send','invalid-json','failed')",
        )
        .run();
      f.db
        .prepare(
          "INSERT INTO reminders(id,due_at,text,chain_id,status) VALUES ('other-reminder','x','Інше','other-chain','pending')",
        )
        .run();
      f.db
        .prepare(
          "INSERT INTO wishes(id,type,title,status,created_at) VALUES ('other-wish','purchase','Моє','active','x')",
        )
        .run();
      expect((await f.remove()).status).toBe(200);
      for (const table of ['trips', 'chains', 'trip_briefs']) expect(f.count(table)).toBe(0);
      expect(f.db.prepare('SELECT id FROM wishes').all()).toEqual([{ id: 'other-wish' }]);
      expect(f.db.prepare('SELECT id FROM reminders').all()).toEqual([{ id: 'other-reminder' }]);
      expect(f.db.prepare('SELECT id FROM outbox').all()).toEqual([{ id: 'unrelated' }]);
      expect(f.env.TRIP_CHAIN!.get).toHaveBeenCalledWith('workflow-delete-1111');
      expect(f.terminate).toHaveBeenCalledOnce();
      const retry = await f.remove();
      expect(await retry.json()).toMatchObject({
        acknowledged: true,
        receipt: { already_deleted: true },
        items: [],
      });
      expect(f.terminate).toHaveBeenCalledOnce();
    },
  );
  it('never deletes a linked active trip through an outdated planning-draft id', async () => {
    const f = await setup();
    f.seedTrip();
    const response = await f.remove(BRIEF, 'draft', 3);
    expect(response.status).toBe(409);
    expect(f.count('trip_briefs')).toBe(1);
    expect(f.count('trips')).toBe(1);
  });
  it('requires explicit confirmation and the displayed revision', async () => {
    const f = await setup();
    f.seedTrip();
    for (const body of [
      { op: 'delete', id: TRIP, revision: 2 },
      { op: 'delete', id: TRIP, revision: 2, data: { kind: 'trip', confirm: false } },
      { op: 'delete', id: TRIP, revision: 2, data: { kind: 'draft', confirm: true } },
      { op: 'delete', id: TRIP, revision: 1, data: { kind: 'trip', confirm: true } },
      { op: 'delete', id: TRIP, data: { kind: 'trip', confirm: true } },
    ])
      expect((await f.post(body)).status).toBe(409);
    expect(f.count('trips')).toBe(1);
    expect(f.terminate).not.toHaveBeenCalled();
  });
  it('rejects stale draft revisions and foreign chat scopes', async () => {
    const f = await setup();
    f.seedBrief();
    expect((await f.remove(BRIEF, 'draft', 2)).status).toBe(409);
    f.db
      .prepare('UPDATE trip_briefs SET scope_key=?')
      .run(tripScopeKey({ chatId: 888, threadId: null }));
    expect((await f.remove(BRIEF, 'draft', 3)).status).toBe(409);
    expect(f.count('trip_briefs')).toBe(1);
  });
  it('rejects absent authentication, secondary users and foreign trip targets', async () => {
    const f = await setup();
    f.seedTrip('active', 888);
    const body = { op: 'delete', id: TRIP, revision: 2, data: { confirm: true, kind: 'trip' } };
    expect((await f.post(body, '')).status).toBe(401);
    expect((await f.post(body, await buildInitData(888, 'test-token'))).status).toBe(403);
    expect((await f.post(body)).status).toBe(409);
    expect(f.count('trips')).toBe(1);
    expect(f.terminate).not.toHaveBeenCalled();
  });
  it('preserves a concurrently edited trip and every linked record', async () => {
    const f = await setup();
    f.seedTrip();
    const original = f.stub.batch;
    vi.spyOn(f.stub, 'batch').mockImplementationOnce(async (statements) => {
      f.db.prepare("UPDATE trips SET cost_json=json_set(cost_json,'$.travel.revision',3)").run();
      return original(statements);
    });
    expect((await f.remove()).status).toBe(409);
    for (const table of ['trips', 'chains', 'trip_briefs', 'wishes'])
      expect(f.count(table)).toBe(1);
    expect(f.terminate).not.toHaveBeenCalled();
  });
  it('rolls back all records if a linked deletion fails', async () => {
    const f = await setup();
    f.seedTrip();
    f.db.exec(
      "CREATE TRIGGER block_chain_delete BEFORE DELETE ON chains BEGIN SELECT RAISE(ABORT,'blocked'); END",
    );
    expect((await f.remove()).status).toBe(409);
    for (const table of ['trips', 'chains', 'trip_briefs', 'wishes'])
      expect(f.count(table)).toBe(1);
    expect(f.terminate).not.toHaveBeenCalled();
  });
  it('keeps deletion durable if terminating a completed Workflow fails', async () => {
    const f = await setup();
    f.seedTrip('done');
    f.terminate.mockRejectedValueOnce(new Error('already completed'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await f.remove()).status).toBe(200);
    expect((await readTravelWorkspace(f.env, null, NOW)).items).toEqual([]);
  });
  it('drops late research and brief updates instead of recreating a deleted draft', async () => {
    const f = await setup();
    f.seedBrief();
    await f.remove(BRIEF, 'draft', 3);
    expect(await finishPlanningSearch(f.env, 'research-delete-1111', {}, false, NOW)).toEqual({
      ignored: true,
    });
    await expect(
      runTripBrief(f.env, { draft_id: BRIEF, answers: { to: 'Прага' } }, NOW, CTX),
    ).rejects.toThrow('не знайдено');
    expect(f.count('trip_briefs')).toBe(0);
  });
  it('blocks cached Workflow sends, writes and late queued deliveries after deletion', async () => {
    const f = await setup();
    f.seedTrip();
    await f.remove();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const io = productionIo(f.env, CHAIN, f.state);
    await io.send('Нагадування');
    await io.saveCost({ actual: 500 });
    await io.finish('done');
    expect(f.count('outbox')).toBe(0);
    expect(f.count('trips')).toBe(0);
    await enqueueOutbox(
      f.env,
      {
        chatId: 777,
        kind: 'send',
        payload: {
          text: 'Старе нагадування',
          trip_chain_notice: { trip_id: TRIP, chain_id: CHAIN },
        },
      },
      NOW,
    );
    await drainOutbox(f.env, { nowMs: NOW, sleep: async () => {} });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(['active', 'cancelled'])(
    'delivers a current %s chain notice and strips its internal metadata',
    async (status) => {
      const f = await setup();
      f.seedTrip(status);
      const fetchMock = vi.fn<typeof fetch>(
        async () =>
          new Response(JSON.stringify({ ok: true, result: { message_id: 12 } }), { status: 200 }),
      );
      vi.stubGlobal('fetch', fetchMock);
      await enqueueOutbox(
        f.env,
        {
          chatId: 777,
          kind: 'send',
          payload: { text: 'Нагадування', trip_chain_notice: { trip_id: TRIP, chain_id: CHAIN } },
        },
        NOW,
      );
      await drainOutbox(f.env, { nowMs: NOW, sleep: async () => {} });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).not.toHaveProperty(
        'trip_chain_notice',
      );
    },
  );
});

describe('starting a draft while it is edited or deleted', () => {
  it.each(['delete', 'edit'])(
    'does not create an orphan when a concurrent %s wins',
    async (action) => {
      const f = await setup();
      f.seedBrief();
      const original = f.stub.batch;
      vi.spyOn(f.stub, 'batch').mockImplementationOnce(async (statements) => {
        if (action === 'delete') f.db.prepare('DELETE FROM trip_briefs WHERE id=?').run(BRIEF);
        else
          f.db
            .prepare(
              "UPDATE trip_briefs SET answers_json=json_set(answers_json,'$._meta.revision',4)",
            )
            .run();
        return original(statements);
      });
      await expect(
        startTripChain(
          f.env,
          {
            to: 'Прага',
            date_from: '2026-11-12',
            date_to: '2026-11-16',
            mode: 'bus',
            brief_id: BRIEF,
          },
          NOW,
          CTX,
        ),
      ).rejects.toThrow('Бриф змінився або видалений');
      for (const table of ['trips', 'chains', 'wishes']) expect(f.count(table)).toBe(0);
      expect(f.create).not.toHaveBeenCalled();
    },
  );
  it('does not restore a trip deleted while its Workflow creation is in flight', async () => {
    const f = await setup();
    f.seedBrief();
    f.create.mockImplementationOnce(async () => {
      const id = String(f.db.prepare('SELECT id FROM trips').get()?.id);
      expect((await f.remove(id, 'trip', 0)).status).toBe(200);
      return {};
    });
    await expect(
      startTripChain(
        f.env,
        {
          to: 'Прага',
          date_from: '2026-11-12',
          date_to: '2026-11-16',
          mode: 'bus',
          brief_id: BRIEF,
        },
        NOW,
        CTX,
      ),
    ).rejects.toThrow('вже видалено');
    for (const table of ['trips', 'chains', 'trip_briefs', 'wishes'])
      expect(f.count(table)).toBe(0);
  });
});
