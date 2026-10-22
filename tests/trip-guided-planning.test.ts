import { readdirSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { d1FromSqlite } from './helpers/d1.js';
import { workerEnv } from './helpers/env.js';
import { buildInitData } from './helpers/init-data.js';
import { runTripBrief, readTripBrief } from '../web/core/tools/trip.mjs';
import {
  changePlanning,
  finishPlanningSearch,
  planningQuestions,
  planningStageKey,
  tripPlanningView,
  TRIP_SEARCH_TIMEOUT,
} from '../web/core/trips/planning.mjs';
import { dispatchPlanningSearch } from '../web/core/trips/search.mjs';
import { instructionHash } from '../web/core/instructions.mjs';
import { handleTrips } from '../web/api-trips.mjs';
import { handleInternal } from '../web/core/internal/router.mjs';
import { signInternal } from '../web/core/internal/auth.mjs';
import { companionChange, suggestedPreparation } from '../web/core/trips/companion.mjs';
import { normalizeTripSearchResult } from '../web/core/trips/providers.mjs';
import { tripResearchView } from '../web/core/trips/options.mjs';
import { tripOfflinePack } from '../web/core/trips/companion.mjs';

const NOW = Date.parse('2026-10-22T10:00:00Z'),
  CTX = { chatId: 777, threadId: null };
const FULL = {
  to: 'Прага',
  from_city: 'Львів',
  date_from: '2026-11-12',
  date_to: '2026-11-16',
  return_type: 'round_trip',
  return_meaning: 'home_arrival',
  mode: 'bus',
  transport_count: 2,
  destination_count: 4,
  children_count: 0,
  purpose: 'дозвілля',
  citizenship: 'Україна',
  departure_window: 'Ввечері',
  ticket_status: 'not_booked',
  baggage: 'Валізи',
  return_count: 2,
  return_window: 'Вдень',
  lodging_needed: 'yes',
  lodging_count: 4,
  lodging_layout: 'apartment',
  lodging_from: '2026-11-13',
  lodging_to: '2026-11-16',
  lodging_preference: 'Ближче до центру',
  budget_type: 'flexible',
  interests: 'Архітектура і кав’ярні',
  travel_pace: 'relaxed',
  food_preference: 'Без обмежень',
  accessibility: 'Без особливих потреб',
  constraints: 'Без обмежень',
  support_level: 'plan',
};
const databases: ReturnType<typeof d1FromSqlite>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const d of databases.splice(0)) d.db.close();
});
async function fixture(patch: Record<string, unknown> = {}) {
  const d = d1FromSqlite(
    readdirSync(new URL('../web/core/migrations/', import.meta.url))
      .filter((f) => f.endsWith('.sql'))
      .sort(),
    { atomicBatch: true },
  );
  databases.push(d);
  const env = workerEnv({
    DB: d.stub,
    TELEGRAM_OWNER_USER_ID: '777',
    TELEGRAM_CHAT_ID: '-100123',
    TELEGRAM_BOT_TOKEN: 'test-token',
    ASSISTANT_HOME: 'dm',
    ASSISTANT_V2: 'on',
  });
  const b = (await runTripBrief(env, { answers: { ...FULL, ...patch } }, NOW, CTX)).result;
  const id = b.draft_id;
  const row = () => d.db.prepare('SELECT * FROM trip_briefs WHERE id=?').get(id)!;
  const answers = () => JSON.parse(String(row().answers_json));
  const brief = () => readTripBrief(env, CTX, NOW, id);
  const view = async () => tripPlanningView(await brief(), NOW);
  const change = async (data: Record<string, unknown>, revision?: number) =>
    changePlanning(env, row(), await brief(), data, revision ?? (await view()).revision, NOW);
  const result = (kind = 'transport', title = 'Перевірений варіант') => ({
    options: [
      {
        kind,
        title,
        provider: 'Provider',
        source_url: `https://example.com/${kind}/${encodeURIComponent(title)}`,
        checked_at: new Date(NOW).toISOString(),
        price: null,
        schedule: '13 листопада, прибуття вранці',
        availability: 'unverified',
      },
    ],
    summary: 'Актуальну ціну потрібно уточнити.',
  });
  const search = async (kind: string) => {
    const receipt = await change({ action: 'search', kind });
    await finishPlanningSearch(env, receipt.run_id, result(kind), false, NOW + 1000);
    return (await view()).stages.find((s: { kind: string }) => s.kind === kind)!;
  };
  return { ...d, env, id, row, answers, brief, view, change, search, result };
}

describe('guided trip brief', () => {
  it('confirms a repaired legacy Prague draft using the same inferred geography shown in the guide', async () => {
    const f = await fixture();
    const raw = { ...FULL };
    f.db.prepare('UPDATE trip_briefs SET answers_json=? WHERE id=?').run(JSON.stringify(raw), f.id);
    expect((await f.view()).remaining).toBe(0);
    await f.change({ action: 'confirm', start_search: true });
    expect(f.answers()).toMatchObject({
      country: 'Чехія',
      international: true,
      timezone: 'Europe/Prague',
      departure_timezone: 'Europe/Kyiv',
    });
    expect((await f.view()).confirmed).toBe(true);
    expect((await f.view()).stages[0]!.status).toBe('running');
  });
  it('starts with a destination and never asks known country, timezone or transport again', async () => {
    const f = await fixture();
    const full = await f.brief();
    expect(planningQuestions(full)).toEqual([]);
    const small = {
      ...full,
      answers: {
        to: 'Прага',
        mode: 'bus',
        country: 'Чехія',
        international: true,
        timezone: 'Europe/Prague',
      },
    };
    expect(planningQuestions(small)[0].field).toBe('from_city');
    expect(planningQuestions(small).map((q: { field: string }) => q.field)).not.toEqual(
      expect.arrayContaining(['mode', 'country', 'timezone', 'international']),
    );
    expect((await f.view()).step).toBe('review');
  });
  it('keeps 2 travelers, 4 people at destination and explicit lodging confirmation separate', async () => {
    const f = await fixture({
      participants: 'Двоє. Але в Празі буде чотири людини.',
      transport_count: null,
      destination_count: null,
      lodging_count: null,
    });
    const b = await f.brief();
    expect(b.answers).toMatchObject({ transport_count: 2, destination_count: 4, lodging_count: 4 });
    expect(planningQuestions(b)[0]).toMatchObject({ field: 'lodging_count', type: 'number' });
    await runTripBrief(f.env, { draft_id: f.id, answers: { lodging_count: 4 } }, NOW, CTX);
    expect(planningQuestions(await f.brief())).toEqual([]);
  });
  it('provides typed buttons, optional skips, multi-room and child details without one-way return questions', async () => {
    const f = await fixture();
    const base = await f.brief();
    const q = planningQuestions({
      ...base,
      answers: {
        ...base.answers,
        return_type: 'one_way',
        international: null,
        children_count: 2,
        children_ages: null,
        lodging_layout: 'separate_rooms',
        lodging_rooms: null,
        constraints: null,
        _skipped: ['constraints'],
      },
    });
    expect(q.find((x: { field: string }) => x.field === 'international').choices).toEqual([
      { value: true, label: 'Так' },
      { value: false, label: 'Ні' },
    ]);
    expect(q.find((x: { field: string }) => x.field === 'lodging_rooms').choices[0].value).toBe(1);
    expect(q.some((x: { field: string }) => x.field === 'children_ages')).toBe(true);
    expect(q.map((x: { field: string }) => x.field)).not.toContain('date_to');
    expect(q.map((x: { field: string }) => x.field)).not.toContain('constraints');
    expect(
      planningQuestions(
        { ...base, answers: { ...base.answers, constraints: null, _skipped: ['constraints'] } },
        true,
      ).some((x: { field: string }) => x.field === 'constraints'),
    ).toBe(true);
  });
  it('asks about ambiguous geography and invalid dates instead of letting review continue', async () => {
    const f = await fixture(),
      b = await f.brief();
    expect(
      planningQuestions({
        ...b,
        ask: [
          {
            field: 'destination_choice',
            question: 'Яке місто?',
            options: ['a'],
            labels: ['Місто A'],
          },
        ],
      })[0],
    ).toMatchObject({ custom: false, choices: [{ value: 'a', label: 'Місто A' }] });
    expect(
      planningQuestions({
        ...b,
        warnings: ['Повернення раніше виїзду'],
        answers: { ...b.answers, date_to: '2026-11-10' },
      })[0].field,
    ).toBe('date_to');
    expect(planningQuestions({ ...b, warnings: ['Дата вже минула'] })[0].field).toBe('date_from');
    expect(
      planningQuestions({ ...b, warnings: ['Дата вже минула'], already_started: true }),
    ).toEqual([]);
    expect(
      planningQuestions({ ...b, answers: { ...b.answers, lodging_to: '2026-11-12' } })[0].field,
    ).toBe('lodging_to');
  });
  it.each(['car', 'plane', 'hike'])('keeps relevant questions for %s', async (mode) => {
    const f = await fixture(),
      b = await f.brief();
    const q = planningQuestions({ ...b, answers: { to: 'Прага', mode } });
    expect(q.some((x: { field: string }) => x.field === 'vehicle_description')).toBe(
      mode === 'car',
    );
    expect(q.some((x: { field: string }) => x.field === 'departure_airport')).toBe(
      mode === 'plane',
    );
  });
  it('requires a complete reviewed brief and rejects stale concurrent decisions', async () => {
    const f = await fixture({ from_city: null });
    await expect(f.change({ action: 'confirm' })).rejects.toThrow('заверши');
    await expect(f.change({ action: 'search', kind: 'transport' })).rejects.toThrow('підтвердь');
    await expect(f.change({ action: 'confirm' }, 15)).rejects.toThrow('змінився');
  });
});

describe('sequential search and owner decisions', () => {
  it('completes transport → stay → several places, preserving choices and all categories', async () => {
    const f = await fixture();
    await f.change({ action: 'confirm' });
    await expect(f.change({ action: 'search', kind: 'stay' })).rejects.toThrow('попередній');
    const transport = await f.search('transport');
    await f.change({
      action: 'decision',
      kind: 'transport',
      mode: 'selected',
      ids: [transport.options[0].id],
    });
    expect((await f.view()).step).toBe('stay');
    const stay = await f.search('stay');
    await f.change({
      action: 'decision',
      kind: 'stay',
      mode: 'selected',
      ids: [stay.options[0].id],
    });
    const job = await f.change({ action: 'search', kind: 'activity' });
    const one = f.result('activity', 'Музей'),
      two = f.result('activity', 'Кав’ярня');
    await finishPlanningSearch(
      f.env,
      job.run_id,
      { options: [...one.options, ...two.options] },
      false,
      NOW + 1000,
    );
    const activities = (await f.view()).stages[2]!.options;
    await f.change({
      action: 'decision',
      kind: 'activity',
      mode: 'selected',
      ids: activities.map((o: { id: string }) => o.id),
    });
    expect((await f.view()).step).toBe('ready');
    expect(f.answers()._planning.decisions.activity.options).toHaveLength(2);
    expect(f.answers()._research.options).toHaveLength(4);
    expect(f.answers()._research.selections.transport).toBe(transport.options[0].id);
  });
  it('makes explicit review+search atomic and repeated taps reuse a running request', async () => {
    const f = await fixture();
    const first = await f.change({ action: 'confirm', start_search: true });
    const twice = await f.change({ action: 'confirm', start_search: true }, 0);
    expect(first).toMatchObject({ queued: true });
    expect(twice).toEqual({ run_id: first.run_id, already_running: true });
    expect((await f.view()).stages[0]!.status).toBe('running');
    await expect(f.change({ action: 'search', kind: 'stay' })).rejects.toThrow('попередній');
  });
  it('supports bought tickets / existing lodging / deferred places without making a booking', async () => {
    const f = await fixture();
    await f.change({ action: 'confirm' });
    await f.change({
      action: 'decision',
      kind: 'transport',
      mode: 'manual',
      note: 'Куплені квитки, 12.11 19:00 → 13.11 11:00',
    });
    await f.change({
      action: 'decision',
      kind: 'stay',
      mode: 'manual',
      note: 'Живемо у друзів у центрі',
    });
    await f.change({ action: 'decision', kind: 'activity', mode: 'later' });
    expect((await f.view()).step).toBe('ready');
    expect(f.answers()._research).toBeUndefined();
  });
  it('invalidates downstream results after transport changes and ignores old jobs', async () => {
    const f = await fixture();
    await f.change({ action: 'confirm' });
    await f.change({
      action: 'decision',
      kind: 'transport',
      mode: 'manual',
      note: 'Прибуття о 10:00',
    });
    const pending = await f.change({ action: 'search', kind: 'stay' });
    await f.change({
      action: 'decision',
      kind: 'transport',
      mode: 'manual',
      note: 'Тепер прибуття о 22:00',
    });
    expect((await f.view()).stages[1]!.status).toBe('stale');
    expect(
      await finishPlanningSearch(f.env, pending.run_id, f.result('stay'), false, NOW + 1000),
    ).toEqual({ ignored: true });
    expect(f.answers()._research).toBeUndefined();
    const second = await f.change({ action: 'search', kind: 'stay' });
    expect(second.run_id).not.toBe(pending.run_id);
  });
  it('keeps basis bounded instead of nesting earlier planning keys inside each stage', async () => {
    const f = await fixture();
    await f.change({ action: 'confirm' });
    const transport = await f.search('transport');
    await f.change({
      action: 'decision',
      kind: 'transport',
      mode: 'selected',
      ids: [transport.options[0].id],
    });
    const stay = await f.search('stay');
    await f.change({
      action: 'decision',
      kind: 'stay',
      mode: 'selected',
      ids: [stay.options[0].id],
    });
    const basis = planningStageKey(f.answers(), 'activity');
    expect(basis.length).toBeLessThan(6000);
    expect(basis).not.toContain('planning_basis');
  });
  it('does not silently keep an old owner selection when switching to a manual choice', async () => {
    const f = await fixture();
    await f.change({ action: 'confirm' });
    const t = await f.search('transport');
    await f.change({
      action: 'decision',
      kind: 'transport',
      mode: 'selected',
      ids: [t.options[0].id],
    });
    await f.change({ action: 'decision', kind: 'transport', mode: 'manual', note: 'Інші квитки' });
    expect(f.answers()._research.selections.transport).toBeUndefined();
  });
  it.each([
    { action: 'decision', kind: 'transport', mode: 'selected', ids: [] },
    { action: 'decision', kind: 'transport', mode: 'selected', ids: ['missing-id'] },
    { action: 'decision', kind: 'transport', mode: 'selected', ids: ['same-id', 'same-id'] },
    { action: 'decision', kind: 'transport', mode: 'manual', note: '' },
    { action: 'decision', kind: 'transport', mode: 'booked' },
    { action: 'search', kind: 'unknown' },
    { action: 'unknown', kind: 'transport' },
  ])('rejects invalid control data: %j', async (data) => {
    const f = await fixture();
    await f.change({ action: 'confirm' });
    await expect(f.change(data)).rejects.toThrow();
  });
  it('exposes timeout, permits retry, and treats completion retries as idempotent', async () => {
    const f = await fixture();
    const job = await f.change({ action: 'confirm', start_search: true });
    expect(tripPlanningView(await f.brief(), NOW + TRIP_SEARCH_TIMEOUT + 1).stages[0]!.status).toBe(
      'timed_out',
    );
    expect(
      await finishPlanningSearch(
        f.env,
        job.run_id,
        f.result(),
        false,
        NOW + TRIP_SEARCH_TIMEOUT + 1,
      ),
    ).toEqual({ ignored: true });
    await finishPlanningSearch(f.env, job.run_id, f.result(), false, NOW + 1000);
    const before = f.row().answers_json;
    expect(await finishPlanningSearch(f.env, job.run_id, f.result(), false, NOW + 2000)).toEqual({
      ignored: true,
    });
    expect(f.row().answers_json).toBe(before);
  });
  it.each([
    null,
    { options: [{}] },
    { options: [{ kind: 'stay' }] },
    { options: Array(9).fill({}) },
  ])('reports invalid output as failed without offers: %j', async (output) => {
    const f = await fixture();
    const job = await f.change({ action: 'confirm', start_search: true });
    expect(await finishPlanningSearch(f.env, job.run_id, output, false, NOW + 1000)).toEqual({
      status: 'failed',
    });
    expect((await f.view()).stages[0]!.status).toBe('failed');
    expect(f.answers()._research).toBeUndefined();
  });
  it('distinguishes no results from technical failure and invalidates review when owner facts change', async () => {
    const f = await fixture();
    const job = await f.change({ action: 'confirm', start_search: true });
    await finishPlanningSearch(
      f.env,
      job.run_id,
      { options: [], summary: 'Немає перевірених рейсів.' },
      false,
      NOW + 1000,
    );
    expect((await f.view()).stages[0]).toMatchObject({
      status: 'no_results',
      summary: 'Немає перевірених рейсів.',
    });
    await runTripBrief(
      f.env,
      { draft_id: f.id, answers: { departure_window: 'Вранці' } },
      NOW,
      CTX,
    );
    expect((await f.view()).confirmed).toBe(false);
    expect((await f.view()).stages[0]!.status).toBe('stale');
  });
});

describe('search dispatch and authenticated completion', () => {
  async function providerFixture() {
    const f = await fixture();
    const body = '# Дослідник\nПошук із джерелами.';
    f.db
      .prepare(
        "INSERT INTO instructions(name,kind,version_hash,body_md,max_chars,deployed_at) VALUES ('researcher','agent',?,?,7000,'x')",
      )
      .run(await instructionHash(body), body);
    const begin = vi.fn(async (run: { id: string; profile: string }) => {
      f.db
        .prepare("INSERT INTO runs(id,trigger,profile,started_at) VALUES (?,'mini-app',?,'x')")
        .run(run.id, run.profile);
    });
    const finish = vi.fn(async () => ({
      newlyFinished: false,
      threadId: 'trip-scope',
      chatId: 777,
    }));
    Object.assign(f.env, {
      INTERNAL_HMAC_KEY: 'local-test-key',
      BRAIN_URL: 'https://brain.example.com',
      RUN_REGISTRY: {
        getByName: () => ({ begin, finish, has: async () => true, consumeNonce: async () => true }),
      },
    });
    return { ...f, begin, finish };
  }
  it('sends a fresh read-only stage-scoped worker and does not start it twice', async () => {
    const f = await providerFixture();
    const job = await f.change({ action: 'confirm', start_search: true });
    const fetch = vi.fn(
      async (_url: unknown, _init?: RequestInit) => new Response('{}', { status: 202 }),
    );
    vi.stubGlobal('fetch', fetch);
    await dispatchPlanningSearch(f.env, f.row(), CTX, job.run_id, NOW);
    const sent = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(sent).toMatchObject({
      profile: 'trip-research',
      tainted: true,
      thread_id: `trip-${f.id}`,
    });
    expect(JSON.parse(sent.input.text)).toMatchObject({
      kind: 'transport',
      owner_answers: { transport_count: 2, lodging_count: 4, lodging_from: '2026-11-13' },
    });
    expect(sent.session).toBeUndefined();
    expect(f.begin).toHaveBeenCalledTimes(1);
    await expect(dispatchPlanningSearch(f.env, f.row(), CTX, 'foreign-run', NOW)).rejects.toThrow(
      'змінився',
    );
  });
  it.each([500, 0])(
    'handles a refused or uncertain worker start (%s) truthfully',
    async (status) => {
      const f = await providerFixture();
      const job = await f.change({ action: 'confirm', start_search: true });
      vi.stubGlobal(
        'fetch',
        status
          ? vi.fn(async () => new Response('{}', { status }))
          : vi.fn(async () => {
              throw new Error('network');
            }),
      );
      const result = await dispatchPlanningSearch(f.env, f.row(), CTX, job.run_id, NOW);
      expect(result.queued).toBe(status === 0);
      expect((await f.view()).stages[0]!.status).toBe(status === 0 ? 'running' : 'failed');
    },
  );
  it('records missing instruction and registry failure as recoverable search failures', async () => {
    const f = await fixture(),
      job = await f.change({ action: 'confirm', start_search: true });
    expect(await dispatchPlanningSearch(f.env, f.row(), CTX, job.run_id, NOW)).toMatchObject({
      failed: true,
    });
    const p = await providerFixture(),
      another = await p.change({ action: 'confirm', start_search: true });
    p.begin.mockRejectedValueOnce(new Error('unavailable'));
    expect(await dispatchPlanningSearch(p.env, p.row(), CTX, another.run_id, NOW)).toMatchObject({
      failed: true,
    });
  });
  it('accepts signed completion once, even on a retried report, without kicking a Telegram thread', async () => {
    const f = await providerFixture(),
      job = await f.change({ action: 'confirm', start_search: true });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 202 })),
    );
    await dispatchPlanningSearch(f.env, f.row(), CTX, job.run_id, NOW);
    const raw = JSON.stringify({
      steps: [],
      outcome: { trip_research: { request_id: job.run_id, output: f.result() } },
    });
    const request = async (nonce: string) =>
      new Request('https://svitanok.test/internal/runs', {
        method: 'POST',
        headers: {
          'X-Internal-Timestamp': String(NOW),
          'X-Internal-Run': job.run_id,
          'X-Internal-Nonce': nonce,
          'X-Internal-Signature': await signInternal('local-test-key', {
            method: 'POST',
            path: '/internal/runs',
            timestampMs: NOW,
            runId: job.run_id,
            nonce,
            rawBody: raw,
          }),
        },
        body: raw,
      });
    expect((await handleInternal(await request('first'), f.env, NOW)).status).toBe(200);
    expect((await f.view()).stages[0]!.status).toBe('completed');
    const before = f.row().answers_json;
    expect((await handleInternal(await request('retry'), f.env, NOW)).status).toBe(200);
    expect(f.row().answers_json).toBe(before);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('requires owner auth, returns guide state, and edits active preferences without reopening a draft', async () => {
    const f = await fixture();
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const init = await buildInitData(777, 'test-token');
    const post = async (body: unknown, signed = true) =>
      handleTrips(
        new Request('https://svitanok.test/api/trips', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(signed ? { 'X-Telegram-Init-Data': init } : {}),
          },
          body: JSON.stringify(body),
        }),
        f.env,
      );
    expect(
      (await post({ op: 'planning', id: f.id, revision: 0, data: { action: 'confirm' } }, false))
        .status,
    ).toBe(401);
    const response = await post({
      op: 'planning',
      id: f.id,
      revision: 0,
      data: { action: 'confirm' },
    });
    expect(await response.json()).toMatchObject({
      acknowledged: true,
      current: { planning: { confirmed: true, step: 'transport' } },
    });
    const trip = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    f.db
      .prepare(
        "INSERT INTO chains(id,kind,state_json,status,created_at,updated_at) VALUES (?,'trip',?,'running','x','x')",
      )
      .run(trip, JSON.stringify({ brief_id: f.id, chat_id: 777, to_text: 'Прага' }));
    f.db
      .prepare(
        "INSERT INTO trips(id,workflow_id,to_text,date_from,date_to,mode,status,cost_json) VALUES (?,?,'Прага','2026-11-12','2026-11-16','bus','active','{}')",
      )
      .run(trip, trip);
    f.db.prepare("UPDATE trip_briefs SET status='started' WHERE id=?").run(f.id);
    const edited = await post({ op: 'brief', id: trip, data: { interests: 'Музеї' } });
    expect(await edited.json()).toMatchObject({
      current: { id: trip, kind: 'trip', planning: { confirmed: false } },
    });
    expect(f.row().status).toBe('started');
    expect((await post({ op: 'brief', id: trip, data: { date_from: '2026-11-14' } })).status).toBe(
      409,
    );
  });
});

describe('preparation lists', () => {
  it('never treats a web result as a live partner quote and rejects malformed provider results', async () => {
    const f = await fixture();
    const output = f.result();
    output.options[0]!.availability = 'provider_quote';
    expect(normalizeTripSearchResult(output, 'transport', NOW).options[0].availability).toBe(
      'unverified',
    );
    expect(normalizeTripSearchResult(output, 'transport', NOW, true).options[0].availability).toBe(
      'provider_quote',
    );
    expect(() => normalizeTripSearchResult({ options: [null] }, 'transport', NOW)).toThrow();
    expect(() =>
      normalizeTripSearchResult(
        { options: [...output.options, ...output.options] },
        'transport',
        NOW,
      ),
    ).toThrow('duplicate');
  });
  it('shares downstream stale warnings with Telegram and includes owner choices in offline copies', async () => {
    const f = await fixture();
    await f.change({ action: 'confirm' });
    await f.change({
      action: 'decision',
      kind: 'transport',
      mode: 'manual',
      note: 'Автобус, прибуття вранці',
    });
    const stay = await f.search('stay');
    await f.change({
      action: 'decision',
      kind: 'stay',
      mode: 'selected',
      ids: [stay.options[0].id],
    });
    const offline = tripOfflinePack(
      { to: 'Прага', date_from: FULL.date_from },
      {},
      (await f.view()).stages,
    );
    expect(offline).toContain('Автобус, прибуття вранці');
    expect(offline).toContain('Перевірений варіант');
    await f.change({
      action: 'decision',
      kind: 'transport',
      mode: 'manual',
      note: 'Інший автобус, прибуття вночі',
    });
    expect(tripResearchView(f.answers(), NOW).selections.stay).toBeUndefined();
    expect(tripResearchView(f.answers(), NOW).selection_warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('Житло')]),
    );
    expect(
      tripOfflinePack({ to: 'Прага', date_from: FULL.date_from }, {}, (await f.view()).stages),
    ).toContain('потребує повторної перевірки');
  });
  it('includes individual packing items and conditional international, flight and child tasks', () => {
    const tasks = suggestedPreparation({
      mode: 'plane',
      preferences: { international: true, children_count: 1, lodging_needed: 'yes' },
    });
    expect(new Set(tasks.map((t) => t.group))).toEqual(
      new Set(['documents', 'bookings', 'packing', 'home', 'return']),
    );
    expect(tasks.map((t: { id: string }) => t.id)).toEqual(
      expect.arrayContaining([
        'suggest-pack-charger',
        'suggest-passport',
        'suggest-flight',
        'suggest-pack-children',
      ]),
    );
  });
  it('supplements existing checklists without duplicating or resetting owner check-offs', () => {
    const old = { id: 'suggest-documents', title: 'Мій текст', status: 'done', group: 'documents' };
    const tasks = companionChange('prepare', {}, { tasks: [old] }, NOW, { mode: 'bus' })!.value;
    expect(tasks.filter((t: { id: string }) => t.id === old.id)).toEqual([old]);
    expect(companionChange('prepare', {}, { tasks }, NOW, { mode: 'bus' })!.value).toEqual(tasks);
    expect(
      companionChange('task', { id: 'custom-pack', title: 'Навушники', group: 'packing' }, {}, NOW)!
        .value[0],
    ).toMatchObject({ group: 'packing', title: 'Навушники' });
    expect(() =>
      companionChange('task', { id: 'custom-pack', title: 'Річ', group: 'invalid' }, {}, NOW),
    ).toThrow('розділ');
  });
});
