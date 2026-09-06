// Інструменти places.search / places.details / routes.eta (етап 5 PR-1):
// текст закладів - <external source="places">, реєстр позначає tainting;
// routes.eta без taint; точки маршруту «lat,lon» / place: / home / here /
// адреса; квота 100 % - формулювання S-1-14 у помилці.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  runPlacesSearch,
  runPlacesDetails,
  runRoutesEta,
  resolveWaypoint,
} from '../web/core/tools/places.mjs';
import { TOOLS } from '../web/core/tools/index.mjs';
import { validateAgainst } from '../web/core/internal/schemas.mjs';
import { runFactsSet } from '../web/core/tools/facts.mjs';
import { QUOTA_LIMITS } from '../web/core/quota/quota.mjs';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';
import { d1FromSqlite } from './helpers/d1.js';

const NOW = Date.parse('2026-09-07T10:00:00.000Z');
const MIGRATIONS = [
  '0001_base.sql',
  '0002_assistant.sql',
  '0003_telemetry.sql',
  '0004_ideas_travel.sql',
];

function setup(kv: Record<string, string> = {}) {
  const d1 = d1FromSqlite(MIGRATIONS);
  const env = workerEnv({
    DB: d1.stub,
    MAPS_API_KEY: 'k',
    BRIEFING: memoryKv(new Map(Object.entries(kv))),
    OWNER_LOCATIONS: JSON.stringify([{ lat: 49.8, lon: 24.0, name: 'Львів' }]),
  });
  return { env, db: d1.db };
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('реєстр', () => {
  it('places.* tainting, routes.eta ні; схеми: query обовʼязковий, near - обʼєкт lat/lon, limit ≤ 8', () => {
    expect(TOOLS['places.search']!.tainting).toBe(true);
    expect(TOOLS['places.details']!.tainting).toBe(true);
    expect(TOOLS['routes.eta']!.tainting).toBeFalsy();
    const s = TOOLS['places.search']!.args;
    expect(validateAgainst(s, {}).ok).toBe(false);
    expect(validateAgainst(s, { query: 'x', near: { lat: 1 } }).ok).toBe(false);
    expect(validateAgainst(s, { query: 'x', near: { lat: 1, lon: 2 }, limit: 8 }).ok).toBe(true);
    expect(validateAgainst(s, { query: 'x', limit: 9 }).ok).toBe(false);
    const r = TOOLS['routes.eta']!.args;
    expect(validateAgainst(r, { from: 'a', to: 'b' }).ok).toBe(false);
    expect(validateAgainst(r, { from: 'a', to: 'b', mode: 'walk' }).ok).toBe(true);
  });
});

describe('places.search', () => {
  it('кандидати як зовнішній текст із place_id; порожньо - note S-1-4', async () => {
    const { env } = setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        ok({
          places: [
            { id: 'A1', displayName: { text: 'Креденс' }, formattedAddress: 'вул. Вірменська 6' },
          ],
        }),
      ),
    );
    const { result } = /** @type {any} */ await runPlacesSearch(env, { query: 'Креденс' }, NOW);
    expect(result.found).toBe(1);
    expect(result.places).toContain('<external source="places">');
    expect(result.places).toContain('1. Креденс · вул. Вірменська 6 (place_id: A1)');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ places: [] })),
    );
    const empty = /** @type {any} */ await runPlacesSearch(env, { query: 'Немає' }, NOW);
    expect(empty.result.found).toBe(0);
    expect(empty.result.note).toMatch(/назву точніше/);
  });

  it('порожній query - found:0 без походу в API', async () => {
    const { env } = setup();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { result } = /** @type {any} */ await runPlacesSearch(env, { query: '   ' }, NOW);
    expect(result.found).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('квота 100 % без кешу - «Довідник закладів тимчасово недоступний»', async () => {
    const { env, db } = setup();
    db.prepare(
      `INSERT INTO quota_counters (key, period, value, limit_value, updated_at) VALUES ('places_text', '2026-09', ?, ?, 'x')`,
    ).run(QUOTA_LIMITS.places_text ?? 0, QUOTA_LIMITS.places_text ?? 0);
    await expect(runPlacesSearch(env, { query: 'Креденс' }, NOW)).rejects.toThrow(
      /Довідник закладів тимчасово недоступний/,
    );
  });
});

describe('places.details', () => {
  it('телефон/сайт/години рядками у <external>; has_phone', async () => {
    const { env } = setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        ok({
          id: 'A1',
          displayName: { text: 'Креденс' },
          nationalPhoneNumber: '032 235',
          regularOpeningHours: { weekdayDescriptions: ['пн: 09–22'] },
        }),
      ),
    );
    const { result } = /** @type {any} */ await runPlacesDetails(env, { place_id: 'A1' }, NOW);
    expect(result).toMatchObject({ place_id: 'A1', has_phone: true, is_favorite: false });
    expect(result.details).toContain('Телефон: 032 235');
    expect(result.details).toContain('Години: пн: 09–22');
    expect(result.details).toContain('id="A1"');
  });
});

describe('routes.eta', () => {
  it('resolveWaypoint: lat,lon / place: / home (facts → OWNER_LOCATIONS) / here (geo.last) / адреса', async () => {
    const { env } = setup({
      ownerGeoManual: JSON.stringify({ lat: 50.4, lon: 30.5, name: 'Київ' }),
    });
    expect(await resolveWaypoint(env, '49.84, 24.03', NOW)).toEqual({ lat: 49.84, lon: 24.03 });
    expect(await resolveWaypoint(env, 'place:ChIJ1', NOW)).toEqual({ place_id: 'ChIJ1' });
    expect(await resolveWaypoint(env, 'home', NOW)).toEqual({ lat: 49.8, lon: 24.0 });
    await runFactsSet(
      env,
      { kind: 'place', key: 'home', value: { address: 'вул. Шевченка 1' }, source: 'owner' },
      NOW,
    );
    expect(await resolveWaypoint(env, 'дім', NOW)).toEqual({ address: 'вул. Шевченка 1' });
    expect(await resolveWaypoint(env, 'here', NOW)).toEqual({ lat: 50.4, lon: 30.5 });
    expect(await resolveWaypoint(env, 'пл. Ринок, Львів', NOW)).toEqual({
      address: 'пл. Ринок, Львів',
    });
    await expect(resolveWaypoint(env, '', NOW)).rejects.toThrow(/порожня/);
  });

  it('here без локації, here старша за 6 год, home без нічого - чесні відмови', async () => {
    const { env } = setup();
    (env as { OWNER_LOCATIONS?: string }).OWNER_LOCATIONS = undefined;
    await expect(resolveWaypoint(env, 'here', NOW)).rejects.toThrow(/локація невідома/);
    await expect(resolveWaypoint(env, 'home', NOW)).rejects.toThrow(/дім невідомий/);
    const stale = setup({
      ownerGeoManual: JSON.stringify({ lat: 50.4, lon: 30.5, setAtMs: NOW - 7 * 3_600_000 }),
    });
    await expect(resolveWaypoint(stale.env, 'here', NOW)).rejects.toThrow(/старша за 7 год/);
    const fresh = setup({
      ownerGeoManual: JSON.stringify({ lat: 50.4, lon: 30.5, setAtMs: NOW - 5 * 3_600_000 }),
    });
    expect(await resolveWaypoint(fresh.env, 'here', NOW)).toEqual({ lat: 50.4, lon: 30.5 });
  });

  it('результат: хвилини, км, текст «32 хв пішки»; кривий mode/depart_at - помилка до fetch', async () => {
    const { env } = setup();
    const fetchMock = vi.fn(async () =>
      ok({ routes: [{ duration: '1920s', distanceMeters: 2340 }] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = /** @type {any} */ await runRoutesEta(
      env,
      { from: 'home', to: 'place:A1', mode: 'walk' },
      NOW,
    );
    expect(result).toMatchObject({
      duration_min: 32,
      distance_km: 2.3,
      text: '32 хв пішки (2.3 км)',
      traffic: false,
    });
    await expect(runRoutesEta(env, { from: 'a', to: 'b', mode: 'plane' }, NOW)).rejects.toThrow(
      /mode/,
    );
    await expect(runRoutesEta(env, { from: 'a', to: 'b', mode: 'bike' }, NOW)).rejects.toThrow(
      /mode/,
    );
    await expect(
      runRoutesEta(env, { from: 'a', to: 'b', mode: 'car', depart_at: 'завтра' }, NOW),
    ).rejects.toThrow(/ISO-8601/);
    // Без зони - теж відмова: Workers читає такий час як UTC, а власник у Києві.
    await expect(
      runRoutesEta(env, { from: 'a', to: 'b', mode: 'car', depart_at: '2026-09-07T18:00:00' }, NOW),
    ).rejects.toThrow(/зі зсувом/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('авто з майбутнім виїздом зі зсувом: «з трафіком», години через formatDurationLabel', async () => {
    const { env } = setup();
    const fetchMock = vi.fn(async () =>
      ok({ routes: [{ duration: '5400s', distanceMeters: 92000 }] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = /** @type {any} */ await runRoutesEta(
      env,
      { from: 'home', to: 'Буковель', mode: 'car', depart_at: '2026-09-07T18:00:00+03:00' },
      NOW,
    );
    expect(result).toMatchObject({
      duration_min: 90,
      traffic: true,
      text: '1.5 год авто (92.0 км), з трафіком',
    });
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    const body = JSON.parse(String(init.body));
    expect(body.departureTime).toBe('2026-09-07T15:00:00.000Z');
    expect(body.routingPreference).toBe('TRAFFIC_AWARE');
  });

  it('квота routes 100 % - «Маршрути тимчасово недоступні» (текст із quota.mjs)', async () => {
    const { env, db } = setup();
    db.prepare(
      `INSERT INTO quota_counters (key, period, value, limit_value, updated_at) VALUES ('routes', '2026-09', ?, ?, 'x')`,
    ).run(QUOTA_LIMITS.routes ?? 0, QUOTA_LIMITS.routes ?? 0);
    await expect(runRoutesEta(env, { from: 'a', to: 'b', mode: 'walk' }, NOW)).rejects.toThrow(
      /Маршрути тимчасово недоступні/,
    );
  });
});
