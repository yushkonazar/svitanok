import { afterEach, describe, expect, it, vi } from 'vitest';
import { readdirSync } from 'node:fs';
import { d1FromSqlite } from './helpers/d1.js';
import { workerEnv } from './helpers/env.js';
import { buildInitData } from './helpers/init-data.js';
import {
  runTripBrief,
  readTripBrief,
  tripBriefContext,
  runTripContext,
} from '../web/core/tools/trip.mjs';
import {
  tripBriefChoices,
  tripBriefCard,
  tripBriefEditCard,
} from '../web/core/tools/trip-card.mjs';
import { resolveTripCity } from '../web/core/trips/geography.mjs';
import {
  runTripOptions,
  tripResearchBasis,
  tripResearchView,
  normalizeTripOption,
  tripOptionsCard,
} from '../web/core/trips/options.mjs';
import { runTripWorkspace } from '../web/core/tools/trip-workspace.mjs';
import {
  runTripExpense,
  tripExpenseSummary,
  undoTripExpense,
} from '../web/core/tools/trip-expenses.mjs';
import { tripOfflinePack, tripDayPlan } from '../web/core/trips/companion.mjs';
import { startTripChain } from '../web/core/chains/trip.mjs';
import { splitTripAmount } from '../web/core/trips/ledger.mjs';
import { tripCompanionTask, renderTripNotice } from '../web/core/trips/notices.mjs';
import { applyPolicy, resolveProposal } from '../web/core/policy/proposals.mjs';
import { decideLevel } from '../web/core/policy/core.mjs';
import { handleTrips, readTravelWorkspace } from '../web/api-trips.mjs';
import { handleBrainCallback } from '../web/core/prerouter.mjs';
import { rememberAssistantQuestion } from '../web/assistant-memory.mjs';
import { routeChatTools } from '../brain/src/tool-routing.js';
import { BRAIN_TOOLS } from '../brain/src/tools/schemas.js';
import { travelResearchBasis, travelWorkerContext, workerCardContext } from '../brain/src/agent.js';

const NOW = Date.parse('2026-10-21T13:00:00Z'),
  DURING = Date.parse('2026-11-13T08:15:00Z');
const CTX = { chatId: 777, threadId: null };
const TRIP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const answer = {
  to: 'Прага',
  from_city: 'Львів',
  date_from: '2026-11-12',
  date_to: '2026-11-16',
  departure_window: 'ввечері',
  mode: 'bus',
  purpose: 'дозвілля',
  participants: 'Двоє. Але в Празі буде чотири людини.',
  lodging_needed: 'yes',
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function setup() {
  const d1 = d1FromSqlite(
    readdirSync(new URL('../web/core/migrations/', import.meta.url))
      .filter((f) => f.endsWith('.sql'))
      .sort(),
    { atomicBatch: true },
  );
  const env = workerEnv({
    DB: d1.stub,
    TELEGRAM_OWNER_USER_ID: '777',
    TELEGRAM_CHAT_ID: '-100123',
    TELEGRAM_BOT_TOKEN: 'test-token',
    ASSISTANT_HOME: 'dm',
    ASSISTANT_V2: 'on',
  });
  const state = {
    trip_id: TRIP,
    to_text: 'Прага',
    from_city: 'Львів',
    date_from: '2026-11-12',
    date_to: '2026-11-16',
    mode: 'bus',
    country: 'Чехія',
    chat_id: 777,
    thread_id: null,
    support_version: 3,
    preferences: {
      timezone: 'Europe/Prague',
      departure_timezone: 'Europe/Kyiv',
      support_level: 'companion',
    },
  };
  const seed = () => {
    d1.db
      .prepare(
        "INSERT INTO chains(id,kind,state_json,status,created_at,updated_at) VALUES (?,'trip',?,'running','x','x')",
      )
      .run(TRIP, JSON.stringify(state));
    d1.db
      .prepare(
        "INSERT INTO trips(id,workflow_id,to_text,from_city,date_from,date_to,mode,status,cost_json) VALUES (?,?,'Прага','Львів','2026-11-12','2026-11-16','bus','active','{}')",
      )
      .run(TRIP, TRIP);
  };
  const costs = () =>
    JSON.parse(
      String(d1.db.prepare('SELECT cost_json FROM trips WHERE id=?').get(TRIP)?.cost_json ?? '{}'),
    );
  const call = (op: string, data: Record<string, unknown> = {}, revision?: number) =>
    runTripWorkspace(env, { trip_id: TRIP, op, data, expected_revision: revision }, DURING, CTX);
  const expense = (data: Record<string, unknown>) =>
    runTripExpense(env, { trip_id: TRIP, amount: 100, currency: 'CZK', ...data }, DURING, CTX);
  return { ...d1, env, state, seed, costs, call, expense };
}
const offer = (over: Record<string, unknown> = {}) => ({
  kind: 'stay',
  title: 'Апартаменти для чотирьох',
  source_url: 'https://example.com/prague/stay',
  checked_at: new Date(NOW).toISOString(),
  availability: 'page_observed',
  price: {
    amount: 400,
    currency: 'EUR',
    unit: 'stay',
    quantity: 1,
    includes: '4 людини, 3 ночі',
    excludes: 'Міський збір не підтверджено',
  },
  dates: '2026-11-13 — 2026-11-16',
  ...over,
});

describe('Prague conversation and durable owner context', () => {
  it('repairs the original saved Prague draft in memory without network access or rewriting owner data', async () => {
    const { env, db } = setup();
    const legacy = JSON.stringify({ ...answer, country: 'Чехія', international: true });
    db.prepare(
      "INSERT INTO trip_briefs(id,scope_key,answers_json,status,created_at,updated_at) VALUES (?,'777:',?,'draft',?,?)",
    ).run(TRIP, legacy, new Date(NOW).toISOString(), new Date(NOW).toISOString());
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const restored = await readTripBrief(env, CTX, NOW + 1);
    expect(restored.answers).toMatchObject({
      mode: 'bus',
      transport_count: 2,
      destination_count: 4,
      lodging_count: 4,
      timezone: 'Europe/Prague',
      departure_timezone: 'Europe/Kyiv',
    });
    expect(restored.ask.map((q: { field: string }) => q.field)).not.toContain('timezone');
    expect(
      db.prepare('SELECT answers_json FROM trip_briefs WHERE id=?').get(TRIP)?.answers_json,
    ).toBe(legacy);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('retains a button-selected bus across a compound answer and resolves both cities without redundant questions', async () => {
    const { env, db } = setup();
    const start = (
      await runTripBrief(
        env,
        {
          answers: {
            to: 'Прага',
            from_city: 'Львів',
            date_from: '2026-11-12',
            date_to: '2026-11-16',
          },
        },
        NOW,
        CTX,
      )
    ).result;
    const bus = tripBriefChoices(start).find((c) => c.value === 'bus')!;
    const edits: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        if (init?.body) edits.push(JSON.parse(String(init.body)));
        return Response.json({ ok: true, result: { message_id: 42 } });
      }),
    );
    expect(
      await handleBrainCallback(
        env,
        { chatId: 777, threadId: null, messageId: 42, data: bus.callback_data },
        NOW + 1,
      ),
    ).toContain('Автобус');
    const after = (
      await runTripBrief(
        env,
        { draft_id: start.draft_id, answers: { participants: answer.participants } },
        NOW + 2,
        { ...CTX, threadId: 'dm' },
      )
    ).result;
    expect(after.answers).toMatchObject({
      mode: 'bus',
      transport_count: 2,
      destination_count: 4,
      country: 'Чехія',
      country_code: 'CZ',
      timezone: 'Europe/Prague',
      departure_timezone: 'Europe/Kyiv',
    });
    expect(after.ask.map((q: { field: string }) => q.field)).not.toContain('mode');
    expect(after.ask.map((q: { field: string }) => q.field)).not.toContain('country');
    expect(after.ask.map((q: { field: string }) => q.field)).not.toContain('timezone');
    expect(edits.some((e) => e.message_id === 42)).toBe(true);
    expect(
      String(
        db.prepare("SELECT transcript_md FROM sessions WHERE thread_id='dm'").get()?.transcript_md,
      ),
    ).toContain('Автобус');
    const restored = await readTripBrief(env, CTX, NOW + 3);
    expect(restored.answers.transport_count).toBe(2);
    expect(
      routeChatTools(
        answer.participants,
        BRAIN_TOOLS.map((t) => t.mcpName),
        true,
        true,
      ),
    ).toEqual(
      expect.arrayContaining([
        'trip_brief',
        'trip_inspect',
        'trip_context',
        'trip_options',
        'trip_research',
      ]),
    );
  });
  it('uses the destination party for lodging and keeps overnight travel distinct from lodging dates', async () => {
    const { env } = setup();
    const brief = (await runTripBrief(env, { answers: answer }, NOW, CTX)).result;
    expect(brief.answers.lodging_count).toBe(4);
    expect(brief.answers.lodging_from).toBeUndefined();
    const edited = (
      await runTripBrief(
        env,
        {
          draft_id: brief.draft_id,
          answers: {
            lodging_from: '2026-11-13',
            lodging_to: '2026-11-16',
            return_count: 2,
            return_meaning: 'home_arrival',
          },
        },
        NOW + 1,
        CTX,
      )
    ).result;
    expect(edited.answers).toMatchObject({
      date_from: '2026-11-12',
      lodging_from: '2026-11-13',
      return_count: 2,
      return_meaning: 'home_arrival',
    });
    expect(tripBriefEditCard(edited).text).not.toContain('transport_count');
    expect(tripBriefEditCard(edited).text).toContain('Для житла: Четверо');
    for (const b of [
      ...tripBriefCard(edited)!.buttons.flat(),
      ...tripBriefEditCard(edited).buttons.flat(),
    ])
      expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
  });
  it('reads and resumes without writes, keeps paused plans, and rejects concurrent lost updates', async () => {
    const { env, db } = setup();
    const first = (await runTripBrief(env, { answers: answer }, NOW, CTX)).result;
    const before = String(
      db.prepare('SELECT answers_json FROM trip_briefs WHERE id=?').get(first.draft_id)
        ?.answers_json,
    );
    await readTripBrief(env, CTX, NOW + 60_000);
    expect(
      String(
        db.prepare('SELECT answers_json FROM trip_briefs WHERE id=?').get(first.draft_id)
          ?.answers_json,
      ),
    ).toBe(before);
    await runTripBrief(
      env,
      {
        draft_id: first.draft_id,
        expected_revision: first.revision,
        answers: { budget_type: 'flexible' },
      },
      NOW + 1,
      CTX,
    );
    await expect(
      runTripBrief(
        env,
        { draft_id: first.draft_id, expected_revision: first.revision, answers: { mode: 'car' } },
        NOW + 2,
        CTX,
      ),
    ).rejects.toThrow('змінився');
    const second = (await runTripBrief(env, { restart: true, to: 'Київ' }, NOW + 3, CTX)).result;
    expect((await readTripBrief(env, CTX, NOW + 4)).draft_id).toBe(second.draft_id);
    expect((await readTripBrief(env, CTX, NOW + 5, first.draft_id)).answers.mode).toBe('bus');
    await expect(readTripBrief(env, { chatId: 888 }, NOW + 5, first.draft_id)).resolves.toBeNull();
  });
  it('changes city and dates without retaining old geography or lodging assumptions', async () => {
    const { env } = setup();
    const first = (
      await runTripBrief(
        env,
        { answers: { ...answer, lodging_from: '2026-11-13', lodging_to: '2026-11-16' } },
        NOW,
        CTX,
      )
    ).result;
    const moved = (
      await runTripBrief(
        env,
        {
          draft_id: first.draft_id,
          answers: { to: 'Відень', date_from: '2026-12-12', date_to: '2026-12-16' },
        },
        NOW + 1,
        CTX,
      )
    ).result;
    expect(moved.answers).toMatchObject({
      to: 'Відень',
      country: 'Австрія',
      timezone: 'Europe/Vienna',
    });
    expect(moved.answers.lodging_from).toBeUndefined();
    expect(moved.answers.lodging_to).toBeUndefined();
    expect(moved.answers._sources.timezone.kind).toBe('resolved_city');
  });
  it('asks for an ambiguous city and never sends personal street addresses to the resolver', async () => {
    const { env } = setup();
    const fetch = vi.fn(async () =>
      Response.json({
        results: [
          {
            id: 1,
            name: 'Springfield',
            country: 'United States',
            country_code: 'US',
            timezone: 'America/Chicago',
            latitude: 39,
            longitude: -89,
          },
          {
            id: 2,
            name: 'Springfield',
            country: 'United States',
            country_code: 'US',
            timezone: 'America/New_York',
            latitude: 42,
            longitude: -72,
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetch);
    const brief = (await runTripBrief(env, { to: 'Springfield' }, NOW, CTX)).result;
    expect(brief.ask[0].field).toBe('destination_choice');
    const selected = (
      await runTripBrief(
        env,
        { draft_id: brief.draft_id, answers: { destination_choice: '2' } },
        NOW + 1,
        CTX,
      )
    ).result;
    expect(selected.answers.timezone).toBe('America/New_York');
    await expect(
      runTripBrief(
        env,
        { draft_id: brief.draft_id, answers: { destination_choice: '999' } },
        NOW + 2,
        CTX,
      ),
    ).rejects.toThrow('застарів');
    fetch.mockClear();
    expect((await resolveTripCity(env, 'вул. Прикладна 15, квартира 7', NOW)).status).toBe(
      'unknown',
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it('restores trusted chat context on approval, and marks a failed execution as failed', async () => {
    const { env, db } = setup();
    const initial = (await runTripBrief(env, { answers: answer }, NOW, CTX)).result;
    const proposed = await applyPolicy(
      env,
      {
        kind: 'trip.brief',
        chatId: 777,
        threadId: 'dm',
        tainted: true,
        payload: { draft_id: initial.draft_id, answers: { budget_type: 'flexible' } },
      },
      NOW + 1,
    );
    expect(proposed.mode).toBe('proposed');
    if (proposed.mode !== 'proposed') throw new Error('expected proposal');
    const result = await resolveProposal(env, { id: proposed.proposal.id, choice: 'ok' }, NOW + 2);
    expect(result).toMatchObject({ ok: true, status: 'approved', executed: true });
    expect((await readTripBrief(env, CTX, NOW + 3)).answers.budget_type).toBe('flexible');
    const bad = await applyPolicy(
      env,
      {
        kind: 'trip.brief',
        ...CTX,
        threadId: 'dm',
        tainted: true,
        payload: { draft_id: initial.draft_id, expected_revision: 0, answers: { mode: 'car' } },
      },
      NOW + 4,
    );
    if (bad.mode !== 'proposed') throw new Error('expected proposal');
    await resolveProposal(env, { id: bad.proposal.id, choice: 'ok' }, NOW + 5);
    expect(db.prepare('SELECT status FROM proposals WHERE id=?').get(bad.proposal.id)?.status).toBe(
      'failed',
    );
  });
  it('writes button-created questions into the canonical transcript without making callback delivery depend on memory', async () => {
    const { env, db } = setup();
    await rememberAssistantQuestion(env, CTX, 'Обрано власником: автобус. Скільки людей їде?');
    expect(
      String(
        db.prepare("SELECT transcript_md FROM sessions WHERE thread_id='dm'").get()?.transcript_md,
      ),
    ).toContain('Скільки людей');
    db.exec('DROP TABLE sessions');
    await expect(rememberAssistantQuestion(env, CTX, 'Наступне питання')).resolves.toBeUndefined();
  });
});

describe('structured research, choices and source boundaries', () => {
  it('stores source references without changing owner answers or starting a trip, and selects by a stable id', async () => {
    const { env, db } = setup();
    const brief = (await runTripBrief(env, { answers: answer }, NOW, CTX)).result;
    const basis = tripResearchBasis(brief.answers);
    expect(travelResearchBasis(brief.answers)).toEqual(basis);
    const saved = await applyPolicy(
      env,
      {
        kind: 'trip.options',
        ...CTX,
        tainted: true,
        payload: { draft_id: brief.draft_id, op: 'save', basis, options: [offer()] },
      },
      NOW,
    );
    expect(saved.mode).toBe('executed');
    const research = (await runTripOptions(env, { draft_id: brief.draft_id, op: 'get' }, NOW, CTX))
      .result;
    const selected = (
      await runTripOptions(
        env,
        {
          draft_id: brief.draft_id,
          op: 'select',
          expected_revision: research.revision,
          option_id: research.options[0].id,
        },
        NOW,
        CTX,
      )
    ).result;
    expect(selected.selections.stay).toBe(research.options[0].id);
    expect(db.prepare('SELECT count(*) AS n FROM trips').get()?.n).toBe(0);
    const restored = await readTripBrief(env, CTX, NOW + 1);
    expect(restored.answers.mode).toBe('bus');
    const context = tripBriefContext(restored);
    expect(context?.research_available).toBe(true);
    expect(JSON.stringify(context)).not.toContain('example.com');
    expect(travelWorkerContext(restored)?.answers).not.toHaveProperty('_research');
    expect(workerCardContext('researcher', 'Перевір ціни житла для поїздки до Праги')).toBe(
      'trip-plan',
    );
    expect(decideLevel('trip.options', true, { op: 'select' })).toEqual({ level: 'T1' });
  });
  it('invalidates stale offers after group changes and requires a fresh matching research basis', async () => {
    const { env } = setup();
    const b = (await runTripBrief(env, { answers: answer }, NOW, CTX)).result;
    await runTripOptions(
      env,
      { draft_id: b.draft_id, op: 'save', basis: tripResearchBasis(b.answers), options: [offer()] },
      NOW,
      CTX,
    );
    const changed = (
      await runTripBrief(env, { draft_id: b.draft_id, answers: { lodging_count: 3 } }, NOW + 1, CTX)
    ).result;
    const stale = tripResearchView(changed.answers, NOW + 2);
    expect(stale.stale).toBe(true);
    await expect(
      runTripOptions(
        env,
        { draft_id: b.draft_id, op: 'select', option_id: stale.options[0].id },
        NOW + 2,
        CTX,
      ),
    ).rejects.toThrow('повторної перевірки');
    await expect(
      runTripOptions(
        env,
        {
          draft_id: b.draft_id,
          op: 'save',
          basis: tripResearchBasis(b.answers),
          options: [offer()],
        },
        NOW + 2,
        CTX,
      ),
    ).rejects.toThrow('Бриф змінився');
  });
  it('keeps original owner terms across external price changes and requires an explicit new choice', async () => {
    const { env } = setup();
    const b = (await runTripBrief(env, { answers: answer }, NOW, CTX)).result,
      basis = tripResearchBasis(b.answers);
    const first = (
      await runTripOptions(
        env,
        { draft_id: b.draft_id, op: 'save', basis, options: [offer()] },
        NOW,
        CTX,
      )
    ).result;
    await runTripOptions(
      env,
      { draft_id: b.draft_id, op: 'select', option_id: first.options[0].id },
      NOW,
      CTX,
    );
    const repeated = (
      await runTripOptions(
        env,
        {
          draft_id: b.draft_id,
          op: 'save',
          basis,
          options: [offer({ checked_at: new Date(NOW + 1).toISOString() })],
        },
        NOW + 1,
        CTX,
      )
    ).result;
    expect(repeated.options[0].id).toBe(first.options[0].id);
    expect(repeated.selections.stay).toBe(first.options[0].id);
    const changed = (
      await runTripOptions(
        env,
        {
          draft_id: b.draft_id,
          op: 'save',
          basis,
          options: [offer({ price: { amount: 600, currency: 'EUR', unit: 'stay', quantity: 1 } })],
        },
        NOW + 2,
        CTX,
      )
    ).result;
    expect(changed.selections.stay).toBeUndefined();
    expect(changed.previous_selections.stay.option.price.amount).toBe(400);
    expect(changed.selection_warnings).toHaveLength(1);
    const restored = await readTripBrief(env, CTX, NOW + 2);
    const persisted = restored.answers._research;
    expect(tripBriefContext(restored)!.previous_selection_ids.stay).toBe(first.options[0].id);
    expect(tripBriefContext(restored)).not.toHaveProperty('selections');
    expect(persisted.selections.stay).toBe(first.options[0].id);
    expect(persisted.selection_snapshots.stay.option.price.amount).toBe(400);
    const reselected = (
      await runTripOptions(
        env,
        {
          draft_id: b.draft_id,
          op: 'select',
          option_id: changed.options[0].id,
          expected_revision: changed.revision,
        },
        NOW + 3,
        CTX,
      )
    ).result;
    expect(reselected.selections.stay).toBe(first.options[0].id);
    expect(reselected.previous_selections.stay.option.price.amount).toBe(600);
    expect(reselected.selection_warnings).toEqual([]);
    expect(() => normalizeTripOption(offer({ source_url: 'javascript:alert(1)' }), NOW)).toThrow(
      'HTTPS',
    );
    expect(() => normalizeTripOption(offer({ checked_at: '2026-01-01T00:00:00Z' }), NOW)).toThrow(
      'свіжої',
    );
  });
});

describe('research collection and Telegram pagination', () => {
  it('retains transport while researching housing and bounds repeated searches without dropping the owner choice', async () => {
    const { env } = setup();
    const b = (await runTripBrief(env, { answers: answer }, NOW, CTX)).result;
    const basis = tripResearchBasis(b.answers);
    const transport = (
      await runTripOptions(
        env,
        {
          draft_id: b.draft_id,
          op: 'save',
          basis,
          options: [
            offer({
              kind: 'transport',
              title: 'Автобус для двох',
              source_url: 'https://example.com/bus',
            }),
          ],
        },
        NOW,
        CTX,
      )
    ).result.options[0];
    await runTripOptions(
      env,
      { draft_id: b.draft_id, op: 'select', option_id: transport.id },
      NOW,
      CTX,
    );
    for (let batch = 0; batch < 4; batch++) {
      await runTripOptions(
        env,
        {
          draft_id: b.draft_id,
          op: 'save',
          basis,
          options: Array.from({ length: 12 }, (_, i) => offer({ title: `Житло ${batch}-${i}` })),
        },
        NOW + batch,
        CTX,
      );
    }
    const result = (await runTripOptions(env, { draft_id: b.draft_id, op: 'get' }, NOW + 4, CTX))
      .result;
    expect(result.options).toHaveLength(36);
    expect(result.options.find((o: { id: string }) => o.id === transport.id)).toBeDefined();
    expect(result.selections.transport).toBe(transport.id);
    const middle = tripOptionsCard(result, 2)!;
    expect(
      middle.buttons.at(-1)!.map((button: { callback_data: string }) => button.callback_data),
    ).toEqual([
      `m:to:${b.draft_id}:p:1:${result.revision}`,
      `m:to:${b.draft_id}:p:3:${result.revision}`,
    ]);
    expect(tripOptionsCard(result, 99)!.text).toContain('31.');
    expect(tripOptionsCard(result, 99)!.buttons.at(-1)).toHaveLength(1);
  });
});

describe('companion lifecycle, finance and delivery', () => {
  it('keeps corrupt saved costs visible as unavailable and uses the current owner-selected timezone', async () => {
    const { env, db, seed, call } = setup();
    seed();
    await call('preferences', { timezone: 'Asia/Tokyo' });
    let result = (await runTripContext(env, { trip_id: TRIP }, DURING, CTX)).result;
    expect(result.trips[0]!.timezone).toBe('Asia/Tokyo');
    db.prepare('UPDATE trips SET cost_json=? WHERE id=?').run('corrupt saved record', TRIP);
    result = (await runTripContext(env, { trip_id: TRIP }, DURING, CTX)).result;
    expect(result.trips[0]!.workspace).toMatchObject({ unavailable: true });
    expect(result.trips[0]!.expense_ledger).toMatchObject({ unavailable: true });
    expect(result.trips[0]!.to).toBe('Прага');
  });
  it('rolls back brief and workflow dates if the trip update cannot commit', async () => {
    const { env, db, seed, state } = setup();
    seed();
    const b = (await runTripBrief(env, { answers: answer }, NOW, CTX)).result;
    db.prepare('UPDATE chains SET state_json=? WHERE id=?').run(
      JSON.stringify({ ...state, brief_id: b.draft_id }),
      TRIP,
    );
    const before = db
      .prepare('SELECT answers_json FROM trip_briefs WHERE id=?')
      .get(b.draft_id)?.answers_json;
    db.exec(
      "CREATE TRIGGER reject_reschedule BEFORE UPDATE ON trips BEGIN SELECT RAISE(ABORT,'reschedule blocked'); END;",
    );
    const sendEvent = vi.fn();
    env.TRIP_CHAIN = { get: async () => ({ sendEvent }) } as unknown as Env['TRIP_CHAIN'];
    await expect(
      startTripChain(
        env,
        { trip_id: TRIP, date_from: '2026-11-14', date_to: '2026-11-19' },
        NOW,
        CTX,
      ),
    ).rejects.toThrow('reschedule blocked');
    expect(
      db.prepare('SELECT answers_json FROM trip_briefs WHERE id=?').get(b.draft_id)?.answers_json,
    ).toBe(before);
    expect(
      JSON.parse(
        String(db.prepare('SELECT state_json FROM chains WHERE id=?').get(TRIP)?.state_json),
      ).date_from,
    ).toBe('2026-11-12');
    expect(sendEvent).not.toHaveBeenCalled();
  });
  it('keeps an unstarted brief available and records a failed workflow without claiming active support', async () => {
    const { env, db } = setup();
    const b = (await runTripBrief(env, { answers: answer }, NOW, CTX)).result;
    env.TRIP_CHAIN = {
      create: async () => {
        throw new Error('test unavailable');
      },
    } as unknown as Env['TRIP_CHAIN'];
    await expect(
      startTripChain(env, { ...answer, brief_id: b.draft_id, country: 'Чехія' }, NOW, CTX),
    ).rejects.toThrow('не стартував');
    expect(db.prepare('SELECT status FROM trips').get()?.status).toBe('failed');
    expect(db.prepare('SELECT status FROM chains').get()?.status).toBe('failed');
    expect(db.prepare('SELECT status FROM trip_briefs WHERE id=?').get(b.draft_id)?.status).toBe(
      'draft',
    );
  });
  it('reschedules an ongoing trip and its brief atomically, preserves tasks and choices, and hides the old daily route until confirmed', async () => {
    const { env, db, seed, state, call, costs } = setup();
    seed();
    const brief = (
      await runTripBrief(
        env,
        {
          answers: {
            ...answer,
            arrival_date: '2026-11-13',
            lodging_from: '2026-11-13',
            lodging_to: '2026-11-16',
          },
        },
        NOW,
        CTX,
      )
    ).result;
    await runTripOptions(
      env,
      {
        draft_id: brief.draft_id,
        op: 'save',
        basis: tripResearchBasis(brief.answers),
        options: [offer()],
      },
      NOW,
      CTX,
    );
    const selected = (await runTripOptions(env, { draft_id: brief.draft_id, op: 'get' }, NOW, CTX))
      .result.options[0].id;
    await runTripOptions(
      env,
      { draft_id: brief.draft_id, op: 'select', option_id: selected },
      NOW,
      CTX,
    );
    db.prepare('UPDATE chains SET state_json=? WHERE id=?').run(
      JSON.stringify({ ...state, brief_id: brief.draft_id, preferences: brief.answers }),
      TRIP,
    );
    await call('task', { id: 'task-keep', title: 'Зберегти квитки' });
    await call('leg', {
      id: 'leg-keep',
      kind: 'activity',
      title: 'Стара прогулянка',
      start: '2026-11-13T12:00',
      end: '2026-11-13T13:00',
      start_zone: 'Europe/Prague',
    });
    const sendEvent = vi.fn(async () => ({}));
    env.TRIP_CHAIN = { get: async () => ({ sendEvent }) } as unknown as Env['TRIP_CHAIN'];
    await expect(
      startTripChain(
        env,
        { trip_id: TRIP, date_from: '2026-11-12', date_to: '2026-11-18' },
        DURING,
        { chatId: 888 },
      ),
    ).rejects.toThrow('іншому чату');
    await startTripChain(
      env,
      { trip_id: TRIP, date_from: '2026-11-12', date_to: '2026-11-18' },
      DURING,
      CTX,
    );
    const updated = await readTripBrief(env, CTX, DURING, brief.draft_id);
    expect(updated.answers.date_to).toBe('2026-11-18');
    expect(updated.answers.lodging_to).toBeUndefined();
    expect(updated.answers._research.selections.stay).toBe(selected);
    expect(tripResearchView(updated.answers, DURING).stale).toBe(true);
    expect(costs().travel.tasks).toHaveLength(1);
    expect(costs().travel.itinerary_stale).toBe(true);
    expect(tripDayPlan(state, costs(), '2026-11-13', DURING)).not.toContain('Стара прогулянка');
    expect(tripOfflinePack(state, costs())).toContain('дати змінено');
    expect(sendEvent).toHaveBeenCalledOnce();
    await expect(call('confirm_itinerary')).rejects.toThrow('Підтвердь');
    await call('confirm_itinerary', { consent: true });
    expect(tripDayPlan(state, costs(), '2026-11-13', DURING)).toContain('Стара прогулянка');
    expect(costs().travel.itinerary_stale).toBe(false);
    const row = db.prepare('SELECT date_to FROM trips WHERE id=?').get(TRIP);
    expect(row?.date_to).toBe('2026-11-18');
  });
  it('maintains actual stages, tasks, bookings and an offline copy with local times', async () => {
    const { seed, call, costs, state, env } = setup();
    seed();
    await call('task', {
      id: 'task-prepare',
      title: 'Зберегти квитки',
      due_at: '2026-11-13T12:00:00+01:00',
    });
    await call('booking', {
      id: 'booking-stay',
      title: 'Апартаменти',
      kind: 'stay',
      status: 'owner_booked',
      source_url: 'https://example.com/booking',
      cancel_by: '2026-11-13T14:00:00+01:00',
    });
    await call('leg', {
      id: 'leg-outbound',
      title: 'Автобус Львів - Прага',
      kind: 'travel',
      mode: 'bus',
      start: '2026-11-12T19:00',
      end: '2026-11-13T11:00',
      start_zone: 'Europe/Kyiv',
      end_zone: 'Europe/Prague',
      source_url: 'https://example.com/bus',
    });
    expect(costs().travel.progress).toBeUndefined();
    await call('progress', { stage: 'arrived' });
    expect(costs().travel.progress).toMatchObject({ stage: 'arrived', confirmed: true });
    const pack = tripOfflinePack(state, costs());
    expect(pack).toContain('2026-11-12T19:00 Europe/Kyiv');
    expect(pack).toContain('2026-11-13T11:00 Europe/Prague');
    expect(pack).toContain('Зберегти квитки');
    await call('progress', { stage: 'home' });
    expect(costs().travel.tasks.some((t: { id: string }) => t.id === 'post-refunds')).toBe(true);
    const context = await runTripContext(env, { trip_id: TRIP }, DURING, CTX);
    expect(context.result.trips[0]?.workspace.progress).toMatchObject({
      stage: 'home',
      confirmed: true,
    });
    expect((await runTripContext(env, {}, DURING, { chatId: 888 })).result.trips).toHaveLength(0);
  });
  it('allocates cents exactly, separates deposits and refunds, and never counts settlement as spending', async () => {
    const { seed, expense, costs } = setup();
    seed();
    await expense({
      entry_id: 'expense-one',
      amount: 10.01,
      paid_by: 'owner',
      split_with: [{ person_id: 'owner' }, { person_id: 'friend' }],
    });
    await expense({ entry_id: 'deposit-one', kind: 'deposit', amount: 100 });
    await expense({ entry_id: 'refund-one', kind: 'refund', refers_to: 'expense-one', amount: 2 });
    await expense({
      entry_id: 'deposit-refund',
      kind: 'refund',
      refers_to: 'deposit-one',
      amount: 100,
    });
    let summary = tripExpenseSummary(JSON.stringify(costs()));
    expect(summary.totals_minor_by_currency).toEqual({ CZK: 801 });
    expect(summary.pending_deposits_minor_by_currency).toEqual({ CZK: 0 });
    const settlement = summary.suggested_settlement[0]!;
    expect(settlement).toMatchObject({ from: 'friend', to: 'owner', currency: 'CZK' });
    await expense({
      entry_id: 'settle-one',
      kind: 'settlement',
      amount: settlement.minor / 100,
      paid_by: settlement.from,
      paid_to: settlement.to,
    });
    summary = tripExpenseSummary(JSON.stringify(costs()));
    expect(summary.suggested_settlement).toHaveLength(0);
    expect(summary.totals_minor_by_currency).toEqual({ CZK: 801 });
    await expect(
      expense({ entry_id: 'refund-over', kind: 'refund', refers_to: 'expense-one', amount: 100 }),
    ).rejects.toThrow('перевищує');
  });
  it('handles full refund retries without duplication and protects referenced expense undo', async () => {
    const { env, seed, expense, costs } = setup();
    seed();
    const out = await expense({ entry_id: 'expense-full', amount: 50, currency: 'EUR' });
    const refund = {
      entry_id: 'refund-full',
      kind: 'refund',
      refers_to: 'expense-full',
      amount: 50,
      currency: 'EUR',
    };
    await expense(refund);
    await expense(refund);
    expect(costs().entries).toHaveLength(2);
    await expect(undoTripExpense(env, out.prev!)).rejects.toThrow('Спочатку');
    expect(tripExpenseSummary(JSON.stringify(costs())).totals_minor_by_currency).toEqual({
      EUR: 0,
    });
    const parts = splitTripAmount(9_999_999_999, [
      { person_id: 'a', weight: 9_999_999_998 },
      { person_id: 'b', weight: 1 },
    ]);
    expect(parts.reduce((n, p) => n + p.minor, 0)).toBe(9_999_999_999);
    expect(parts.find((p) => p.person_id === 'b')?.minor).toBe(1);
  });
  it('queues bounded local notices, deduplicates them, and drops stale reminders after completion or pause', async () => {
    const { env, seed, call, db } = setup();
    seed();
    await call('task', {
      id: 'task-deadline',
      title: 'Зареєструватися',
      due_at: '2026-11-13T12:00:00+01:00',
    });
    expect((await tripCompanionTask(env, DURING)).sent).toBe(1);
    const notice = JSON.parse(
      String(db.prepare('SELECT payload_json FROM outbox LIMIT 1').get()?.payload_json),
    ).trip_notice;
    expect((await renderTripNotice(env, notice, DURING))?.text).toContain('Зареєструватися');
    await call('task', { id: 'task-deadline', status: 'done' });
    expect(await renderTripNotice(env, notice, DURING)).toBeNull();
    await call('preferences', { paused: true });
    expect((await tripCompanionTask(env, DURING + 60_000)).sent).toBe(0);
    await call('preferences', { paused: false });
    expect((await tripCompanionTask(env, DURING + 120_000)).sent).toBe(1);
    expect((await tripCompanionTask(env, DURING + 180_000)).sent).toBe(0);
    db.prepare("UPDATE trips SET status='cancelled' WHERE id=?").run(TRIP);
    expect(
      await renderTripNotice(env, { trip_id: TRIP, kind: 'morning', date: '2026-11-13' }, DURING),
    ).toBeNull();
  });
});

describe('authenticated shared Mini App workspace', () => {
  it('requires the signed owner UI for weather sharing and makes no forecast request without that consent', async () => {
    const { env, seed, call, costs } = setup();
    seed();
    env.WEATHER_API_KEY = 'fixture-only';
    env.WEATHER_QUOTA = { getByName: () => ({ consume: async () => ({ ok: true }) }) } as never;
    const fetch = vi.fn(async (_url: unknown) => Response.json({ daily: [] }));
    vi.stubGlobal('fetch', fetch);
    const notice = { trip_id: TRIP, kind: 'morning', date: '2026-11-13' };
    await renderTripNotice(env, notice, DURING, true);
    expect(fetch).not.toHaveBeenCalled();
    await expect(call('preferences', { weather_share_city: true })).rejects.toThrow(
      'розділі Подорожі',
    );
    const init = await buildInitData(777, 'test-token');
    const consent = (enabled: boolean) =>
      handleTrips(
        new Request('https://svitanok.test/api/trips', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'X-Telegram-Init-Data': init },
          body: JSON.stringify({ op: 'weather-consent', id: TRIP, data: { enabled } }),
        }),
        env,
      );
    expect((await consent(true)).status).toBe(200);
    expect(costs().travel.preferences.weather_consent).toMatchObject({
      provider: 'OpenWeather',
      scope: 'destination_city',
      source: 'owner_ui',
    });
    await renderTripNotice(env, notice, DURING, true);
    expect(fetch).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0]?.[0])).toContain('api.openweathermap.org');
    await consent(false);
    fetch.mockClear();
    await renderTripNotice(env, notice, DURING, true);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('starts one companion and safely acknowledges a retry with the original draft revision', async () => {
    const { env, db } = setup();
    const create = vi.fn(async () => ({}));
    env.TRIP_CHAIN = { create } as never;
    const brief = (await runTripBrief(env, { answers: answer }, Date.now(), CTX)).result;
    const init = await buildInitData(777, 'test-token');
    const start = () =>
      handleTrips(
        new Request('https://svitanok.test/api/trips', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'X-Telegram-Init-Data': init },
          body: JSON.stringify({
            op: 'start',
            id: brief.draft_id,
            revision: brief.revision,
            data: { consent: true, support_level: 'companion' },
          }),
        }),
        env,
      );
    const first = await start();
    expect(first.status).toBe(200);
    const retry = await start();
    expect(retry.status).toBe(200);
    expect(
      ((await retry.json()) as { receipt: { already_started: boolean } }).receipt.already_started,
    ).toBe(true);
    expect(create).toHaveBeenCalledOnce();
    expect(db.prepare('SELECT count(*) AS n FROM trips').get()?.n).toBe(1);
    expect(
      db.prepare('SELECT status FROM trip_briefs WHERE id=?').get(brief.draft_id)?.status,
    ).toBe('started');
  });
  it('rejects unauthenticated and secondary users and scopes all record reads and mutations', async () => {
    const { env, seed } = setup();
    seed();
    expect((await handleTrips(new Request('https://svitanok.test/api/trips'), env)).status).toBe(
      401,
    );
    const init = await buildInitData(777, 'test-token');
    const get = await handleTrips(
      new Request('https://svitanok.test/api/trips', { headers: { 'X-Telegram-Init-Data': init } }),
      env,
    );
    expect(get.status).toBe(200);
    expect(get.headers.get('cache-control')).toContain('no-store');
    expect(((await get.json()) as { current: { id: string } }).current.id).toBe(TRIP);
    const post = (body: unknown) =>
      handleTrips(
        new Request('https://svitanok.test/api/trips', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'X-Telegram-Init-Data': init },
          body: JSON.stringify(body),
        }),
        env,
      );
    const mutation = await post({
      op: 'workspace',
      id: TRIP,
      revision: 0,
      data: { op: 'task', value: { id: 'task-from-app', title: 'Зберегти офлайн-план' } },
    });
    expect(mutation.status).toBe(200);
    const read = (await runTripWorkspace(env, { trip_id: TRIP, op: 'get' }, NOW, CTX)).result;
    expect(
      'tasks' in read && read.tasks.some((t: { id: string }) => t.id === 'task-from-app'),
    ).toBe(true);
    expect(
      (
        await post({
          op: 'workspace',
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          data: { op: 'progress', value: { stage: 'home' } },
        })
      ).status,
    ).toBe(409);
    const other = workerEnv({ ...env, TELEGRAM_ALLOWED_USER_IDS: '888' });
    const secondInit = await buildInitData(888, 'test-token');
    expect(
      (
        await handleTrips(
          new Request('https://svitanok.test/api/trips', {
            headers: { 'X-Telegram-Init-Data': secondInit },
          }),
          other,
        )
      ).status,
    ).toBe(403);
  });
  it('exports a private offline document and leaves source URLs as text', async () => {
    const { env, seed, call } = setup();
    seed();
    await call('booking', {
      id: 'booking-export',
      kind: 'stay',
      status: 'owner_booked',
      title: 'Житло',
      reference: 'DEMO-123',
      source_url: 'https://example.com/booking',
    });
    const init = await buildInitData(777, 'test-token');
    const response = await handleTrips(
      new Request(`https://svitanok.test/api/trips?id=${TRIP}&format=md`, {
        headers: { 'X-Telegram-Init-Data': init },
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/markdown');
    expect(await response.text()).toContain('DEMO-123');
    expect((await readTravelWorkspace(env, TRIP, NOW)).current?.kind).toBe('trip');
  });
});
