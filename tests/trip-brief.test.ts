import { describe, it, expect } from 'vitest';
import { runTripBrief, runTripContext, normalizeTripAnswers } from '../web/core/tools/trip.mjs';
import { tripBriefCard, tripBriefChoices } from '../web/core/tools/trip-card.mjs';
import { runFactsSet } from '../web/core/tools/facts.mjs';
import { TOOLS } from '../web/core/tools/index.mjs';
import { ACTION_LEVELS } from '../web/core/policy/core.mjs';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';
import { d1FromSqlite } from './helpers/d1.js';

const NOW = Date.parse('2026-10-03T07:00:00.000Z');
const MIGRATIONS = [
  '0001_base.sql',
  '0002_assistant.sql',
  '0004_ideas_travel.sql',
  '0014_fact_provenance.sql',
  '0027_trip_briefs.sql',
];

function setup() {
  const d1 = d1FromSqlite(MIGRATIONS);
  const env = workerEnv({ DB: d1.stub, BRIEFING: memoryKv(new Map()) });
  return { env, db: d1.db };
}

const fields = (r: { ask: { field: string }[] }) => r.ask.map((a) => a.field);
const ctx = { chatId: 806352792, threadId: null };

describe('trip.brief', () => {
  it('invalid corrections do not silently reuse an old valid date', async () => {
    const { env, db } = setup();
    const initial = (await runTripBrief(env, { to: 'Київ', date_from: '2026-11-14' }, NOW, ctx))
      .result;
    await expect(
      runTripBrief(
        env,
        { draft_id: initial.draft_id!, answers: { date_from: '2026-02-31' } },
        NOW + 1,
        ctx,
      ),
    ).rejects.toThrow('попередні дані');
    const row = db
      .prepare('SELECT answers_json FROM trip_briefs WHERE id=?')
      .get(initial.draft_id) as { answers_json: string };
    expect(JSON.parse(row.answers_json).date_from).toBe('2026-11-14');
  });
  it('unifies private chat registry dm and callback null scopes', async () => {
    const { env } = setup();
    const first = (await runTripBrief(env, { to: 'Київ' }, NOW, { ...ctx, threadId: 'dm' })).result;
    const next = (
      await runTripBrief(
        env,
        { draft_id: first.draft_id!, answers: { date_from: '2026-11-14' } },
        NOW + 1,
        ctx,
      )
    ).result;
    expect(next.draft_id).toBe(first.draft_id);
  });
  it('invalidates a displayed vehicle index when its choices change and respects 64-byte callbacks', () => {
    const result = {
      draft_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      ask: [{ field: 'vehicle_key', question: 'Яким авто?', options: ['car1', 'car2'] }],
      known: {
        vehicles: [
          { key: 'car1', name: 'Авто 1' },
          { key: 'car2', name: 'Авто 2' },
        ],
      },
    };
    const old = tripBriefCard(result)!.buttons[0]![0]!.callback_data;
    result.known.vehicles[0]!.name = 'Інше авто';
    expect(tripBriefCard(result)!.buttons[0]![0]!.callback_data).not.toBe(old);
    result.ask = [
      { field: 'lodging_needed', question: 'Житло?', options: ['yes', 'no', 'undecided'] },
    ];
    expect(
      tripBriefCard(result)!
        .buttons.flat()
        .every((b) => Buffer.byteLength(b.callback_data) <= 64),
    ).toBe(true);
  });
  it('stays text-only on pre-migration schema without pretending persistence', async () => {
    const { env, db } = setup();
    db.exec('DROP TABLE trip_briefs');
    const result = (await runTripBrief(env, { to: 'Київ' }, NOW, ctx)).result;
    expect(result.persisted).toBe(false);
    expect(result.draft_id).toBeNull();
    expect(result.question_card).toBeNull();
    expect(result.then).toContain('не збережена');
  });
  it('починає з найближчих базових питань і не питає про авто завчасно', async () => {
    const { env } = setup();
    const { result } = await runTripBrief(env, { to: 'Київ' }, NOW, ctx);
    expect(result.phase).toBe('scope');
    expect(result.ask.length).toBeLessThanOrEqual(4);
    expect(fields(result)).toContain('date_from');
    expect(fields(result)).not.toContain('vehicle_key');
    expect(fields(result)).not.toContain('vehicle_description');
    expect(result.draft_id).toBeTruthy();
    expect(result.ready_for_research).toBe(false);
  });

  it('переживає інші повідомлення і зберігає відповіді в межах чату', async () => {
    const { env } = setup();
    const first = (await runTripBrief(env, { to: 'Київ' }, NOW, ctx)).result;
    const next = (
      await runTripBrief(
        env,
        {
          draft_id: first.draft_id ?? undefined,
          answers: { date_from: '2026-11-14', date_to: '2026-11-16', mode: 'train' },
        },
        NOW + 60_000,
        ctx,
      )
    ).result;
    expect(next.draft_id).toBe(first.draft_id);
    expect(next.answers).toMatchObject({
      to: 'Київ',
      date_from: '2026-11-14',
      date_to: '2026-11-16',
      return_type: 'round_trip',
      mode: 'train',
    });
    expect(fields(next)).not.toContain('vehicle_key');
    await expect(
      runTripBrief(env, { draft_id: first.draft_id ?? undefined }, NOW + 60_000, { chatId: 2 }),
    ).rejects.toThrow(/не знайдено/);
  });

  it('інша ціль створює іншу чернетку, а restart починає заново', async () => {
    const { env } = setup();
    const kyiv = (await runTripBrief(env, { to: 'Київ' }, NOW, ctx)).result;
    const lviv = (await runTripBrief(env, { to: 'Львів' }, NOW + 1, ctx)).result;
    expect(lviv.draft_id).not.toBe(kyiv.draft_id);
    const fresh = (await runTripBrief(env, { to: 'Львів', restart: true }, NOW + 2, ctx)).result;
    expect(fresh.draft_id).not.toBe(lviv.draft_id);
    const resumed = (await runTripBrief(env, { to: 'Київ' }, NOW + 3, ctx)).result;
    expect(resumed.draft_id).toBe(kyiv.draft_id);
  });

  it('зміна способу, країни та повернення прибирає застарілі гілки', async () => {
    const { env } = setup();
    const first = (
      await runTripBrief(
        env,
        {
          answers: {
            to: 'Прага',
            mode: 'car',
            vehicle_key: 'jetta',
            depart_at: '08:00',
            date_from: '2026-11-14',
            date_to: '2026-11-16',
            international: true,
            country: 'Чехія',
            budget_type: 'limit',
            budget_total: 8000,
          },
        },
        NOW,
        ctx,
      )
    ).result;
    const changed = (
      await runTripBrief(
        env,
        {
          draft_id: first.draft_id ?? undefined,
          answers: {
            mode: 'train',
            return_type: 'one_way',
            international: false,
            budget_type: 'no_limit',
          },
        },
        NOW + 1000,
        ctx,
      )
    ).result;
    expect(changed.answers).toMatchObject({
      mode: 'train',
      return_type: 'one_way',
      international: false,
    });
    for (const field of ['vehicle_key', 'depart_at', 'date_to', 'country', 'budget_total']) {
      expect(changed.answers).not.toHaveProperty(field);
    }
  });

  it('факти про дім та авто використовує лише в доречній гілці', async () => {
    const { env } = setup();
    await runFactsSet(
      env,
      { kind: 'vehicle', key: 'octavia', value: { name: 'Octavia', per100: 8, fuel: 'A95' } },
      NOW,
    );
    await runFactsSet(env, { kind: 'place', key: 'home', value: { city: 'Львів' } }, NOW);
    const scope = {
      to: 'Київ',
      date_from: '2026-11-14',
      date_to: '2026-11-16',
      mode: 'car',
      purpose: 'дозвілля',
      participants: 'удвох',
      international: false,
    };
    const { result } = await runTripBrief(env, { answers: scope }, NOW, ctx);
    expect(result.phase).toBe('logistics');
    expect(result.known.from_city).toBe('Львів');
    expect(fields(result)).not.toContain('from_city');
    expect(result.ask.find((a: { field: string }) => a.field === 'vehicle_key')).toMatchObject({
      options: ['octavia', 'other'],
      default: 'octavia',
    });
    expect(fields(result)).toContain('depart_at');
    expect(result.ready_for_research).toBe(true);
  });

  it('координати дому без назви міста не видає за відомий пункт виїзду', async () => {
    const { env } = setup();
    await runFactsSet(env, { kind: 'place', key: 'home', value: { lat: 49.84, lon: 24.03 } }, NOW);
    const { result } = await runTripBrief(env, { to: 'Київ' }, NOW, ctx);
    expect(fields(result)).toContain('from_city');
  });

  it('потяг, літак, похід і порівняння мають різні питання', async () => {
    const { env } = setup();
    const base = {
      to: 'Прага',
      date_from: '2026-11-14',
      return_type: 'one_way',
      from_city: 'Львів',
      purpose: 'відпочинок',
      participants: 'сам',
      international: true,
      country: 'Чехія',
    };
    const askFor = async (mode: string) =>
      fields(
        (await runTripBrief(env, { restart: true, answers: { ...base, mode } }, NOW, ctx)).result,
      );
    expect(await askFor('train')).toContain('ticket_status');
    expect(await askFor('plane')).toContain('baggage');
    expect(await askFor('hike')).toContain('route_profile');
    expect(await askFor('compare')).toContain('trip_priorities');
    expect(await askFor('mixed')).toContain('legs');
    expect(await askFor('plane')).toContain('citizenship');
  });

  it('не маскує хибні дати і не зберігає довільні технічні поля', async () => {
    const { env } = setup();
    expect(normalizeTripAnswers({ date_from: '2026-02-31', chat_id: 1, budget_total: -5 })).toEqual(
      {},
    );
    const { result } = await runTripBrief(
      env,
      { answers: { to: 'Київ', date_from: '2026-09-01' } },
      NOW,
      ctx,
    );
    expect(result.warnings).toContain('Дата виїзду вже минула — уточни дату.');
    expect(result.ready_for_research).toBe(false);
  });

  it('сам бриф є T0 без taint; маршрути поза чотирма modes не стартують автоматично', () => {
    expect(TOOLS['trip.brief']!.tainting).toBeFalsy();
    expect(TOOLS['trip.brief']!.write).toMatchObject({ kind: 'trip.brief' });
    expect(ACTION_LEVELS['trip.brief']).toBe('T0');
  });

  it('кнопки відповідають лише поточному питанню і не несуть вільного тексту', async () => {
    const { env } = setup();
    const { result } = await runTripBrief(
      env,
      {
        answers: {
          to: 'Прага',
          date_from: '2026-11-14',
          from_city: 'Львів',
          return_type: 'one_way',
          participants: 'дві людини',
          purpose: 'відпочинок',
          international: true,
          country: 'Чехія',
        },
      },
      NOW,
      ctx,
    );
    expect(result.ask[0]?.field).toBe('mode');
    const card = tripBriefCard(result);
    expect(card?.text).toContain('Чим плануєш їхати?');
    expect(tripBriefChoices(result)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'mode', value: 'car', label: '🚗 Авто' }),
        expect.objectContaining({ field: 'mode', value: 'hike', label: '🥾 Похід' }),
      ]),
    );
    expect(
      card?.buttons
        .flat()
        .every(
          (button: { callback_data: string }) =>
            button.callback_data.length <= 64 &&
            button.callback_data.startsWith(`m:tb:${result.draft_id}:mode:`),
        ),
    ).toBe(true);
  });

  it('пропуск необовʼязкових деталей зберігається в чернетці', async () => {
    const { env } = setup();
    const base = {
      to: 'Київ',
      date_from: '2026-11-14',
      return_type: 'one_way',
      from_city: 'Львів',
      mode: 'walk',
      participants: 'сам',
      purpose: 'транзит',
      international: false,
      route_profile: '10 км',
      budget_type: 'no_limit',
      lodging_needed: 'no',
    };
    const first = (await runTripBrief(env, { answers: base }, NOW, ctx)).result;
    expect(first.phase).toBe('preferences');
    expect(tripBriefCard(first)?.buttons.flat()).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: '⏭ Досить уточнень' })]),
    );
    const skipped = (
      await runTripBrief(
        env,
        { draft_id: first.draft_id ?? undefined, skip_optional: true },
        NOW + 1,
        ctx,
      )
    ).result;
    expect(skipped.phase).toBe('ready');
    const resumed = (
      await runTripBrief(env, { draft_id: first.draft_id ?? undefined }, NOW + 2, ctx)
    ).result;
    expect(resumed.phase).toBe('ready');
  });
});

describe('trip.context', () => {
  it('показує активний день і названі факти, але не вдає живу геолокацію', async () => {
    const { env, db } = setup();
    db.prepare(
      `INSERT INTO trips
      (id, wish_id, from_city, to_text, country, date_from, date_to, mode, vehicle_key,
       checklist_key, cost_json, checklist_state_json, workflow_id, status)
      VALUES ('trip-1', NULL, 'Львів', 'Київ', 'Україна', '2026-10-02', '2026-10-05',
              'car', NULL, 'ua-car', NULL, '{"done":[]}', 'chain-1', 'active')`,
    ).run();
    db.prepare(
      `INSERT INTO chains
      (id, kind, workflow_id, state_json, status, created_at, updated_at)
      VALUES ('chain-1', 'trip', 'chain-1', ?, 'running', 'x', 'x')`,
    ).run(JSON.stringify({ depart_at: '08:00', purpose: 'дозвілля', participants: 'удвох' }));
    const { result } = await runTripContext(env, {}, NOW);
    expect(result.trips[0]).toMatchObject({
      to: 'Київ',
      phase: 'travel_day',
      day_number: 2,
      depart_at: '08:00',
      purpose: 'дозвілля',
    });
    expect(result.location_known).toBe(false);
    expect(result.note).toContain('не жива геолокація');
  });
});
