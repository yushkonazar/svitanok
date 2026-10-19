import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { suggestLeisure } from '../web/core/leisure/planning-service.mjs';
import { workerEnv } from './helpers/env.js';
const calls = vi.hoisted(() => ({
  workspace: vi.fn(),
  calendar: vi.fn(),
  details: vi.fn(),
  route: vi.fn(),
}));
vi.mock('../web/core/leisure/store.mjs', () => ({ readLeisureWorkspace: calls.workspace }));
vi.mock('../web/google.mjs', () => ({ readCalendarRange: calls.calendar }));
vi.mock('../web/core/adapters/maps.mjs', () => ({
  placeDetails: calls.details,
  routesEta: calls.route,
}));
const now = Date.parse('2026-10-19T08:00:00Z');
const options = {
  from: '2026-10-20',
  to: '2026-10-22',
  startTime: '16:00',
  endTime: '23:00',
  transport: 'walk',
  startLocation: 'Львів, площа Ринок',
};
function data() {
  const items = Array.from({ length: 20 }, (_, n) => ({
    id: 'item-' + n,
    title: 'Місце ' + n,
    category: n === 0 ? 'food' : 'place',
    placeId: 'google-' + n,
    venueId: 'google:' + n,
    address: 'Львів, ' + n,
    checkedAt: new Date(now).toISOString(),
    status: 'available',
    sourceUrl: 'https://maps.google.com/?q=' + n,
    lat: 49.84,
    lon: 24.03,
    price: { min: null, basis: 'unknown' },
  }));
  return {
    items,
    saved: [],
    records: items.map((i) => ({
      id: 'reaction-' + i.id,
      kind: 'reaction',
      itemId: i.id,
      verdict: 'interested',
      interestLevel: 'priority',
      revision: 1,
    })),
    edition: { rankings: [], sources: [] },
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.clearAllMocks();
  calls.workspace.mockResolvedValue(data());
  calls.calendar.mockResolvedValue([]);
  calls.details.mockResolvedValue({ place: { periods: [{ open: { day: 0 } }] }, source: 'cache' });
  calls.route.mockResolvedValue({ duration_min: 10, distance_m: 800 });
});
afterEach(() => vi.useRealTimers());
describe('bounded leisure suggestion service', () => {
  it('reuses a five minute result and invalidates it after a changed decision', async () => {
    const stored = new Map<string, string>();
    const env = workerEnv({
      BRIEFING: {
        get: async (key: string) => (stored.has(key) ? JSON.parse(stored.get(key)!) : null),
        put: async (key: string, value: string) => void stored.set(key, value),
      },
    });
    const first = await suggestLeisure(env, options, now);
    expect(first.days).toHaveLength(3);
    expect(calls.details.mock.calls.length).toBeLessThanOrEqual(8);
    expect(calls.route.mock.calls.length).toBeLessThanOrEqual(10);
    expect(await suggestLeisure(env, options, now)).toEqual(first);
    expect(calls.calendar).toHaveBeenCalledTimes(1);
    const changed = data();
    changed.records[0]!.revision = 2;
    calls.workspace.mockResolvedValue(changed);
    await suggestLeisure(env, options, now);
    expect(calls.calendar).toHaveBeenCalledTimes(2);
  });
  it('retains visible estimates when calendar, hours or route providers fail', async () => {
    calls.calendar.mockRejectedValue(new Error('Unavailable'));
    calls.details.mockRejectedValue(new Error('Quota'));
    calls.route.mockRejectedValue(new Error('Unavailable'));
    const result = await suggestLeisure(workerEnv(), options, now);
    expect(result.days[0].plans.length).toBeGreaterThan(0);
    expect(result.days[0].plans[0].warnings.join(' ')).toContain('Календар');
    expect(result.days[0].plans[0].confidence).toBe('needs-check');
  });
  it('stops enriching after the wall clock budget instead of consuming every possible request', async () => {
    calls.details.mockImplementation(async () => {
      vi.setSystemTime(now + 25000);
      throw new Error('Timeout');
    });
    const result = await suggestLeisure(workerEnv(), options, now);
    expect(calls.details).toHaveBeenCalledTimes(1);
    expect(calls.route).not.toHaveBeenCalled();
    expect(result.days[0].plans[0].confidence).toBe('needs-check');
  });
  it('rejects invalid windows before I/O and reports invalid replacements as client errors', async () => {
    await expect(
      suggestLeisure(workerEnv(), { ...options, to: '2026-11-20' }, now),
    ).rejects.toMatchObject({ status: 400 });
    expect(calls.workspace).not.toHaveBeenCalled();
    await expect(
      suggestLeisure(workerEnv(), { ...options, preferredFoodId: 'missing' }, now),
    ).rejects.toMatchObject({ status: 400 });
  });
});
