import { describe, it, expect } from 'vitest';
import {
  buildLeisureSuggestions,
  normalizeLeisureWindow,
  leisureLocalInstant,
  leisureOpenDuring,
  leisureLegKey,
} from '../web/core/leisure/planning.mjs';
const now = Date.parse('2026-10-19T08:00:00Z');
const date = '2026-10-22';
const instant = (time: string) => new Date(leisureLocalInstant(date, time)).toISOString();
const options = { date, startTime: '16:00', endTime: '23:00', transport: 'walk' };
const item = (id: string, category = 'food', extra: Record<string, unknown> = {}) => ({
  id,
  category,
  title: id,
  sourceUrl: 'https://example.com/' + id,
  address: 'Львів, ' + id,
  venueId: id,
  status: 'available',
  checkedAt: new Date(now).toISOString(),
  lat: 49.84,
  lon: 24.03,
  price: { min: 100, basis: 'person' },
  sessions: [],
  ...extra,
});
const cafe = item('cafe');
const film = item('film', 'cinema', {
  durationMinutes: 120,
  sessions: [
    { id: 'first', startAt: instant('18:00'), endAt: instant('20:00'), price: 150 },
    { id: 'second', startAt: instant('20:30'), endAt: instant('22:30'), price: 150 },
  ],
});
const concert = item('concert', 'concert', {
  startDate: date,
  endDate: date,
  startAt: instant('18:00'),
  endAt: instant('20:00'),
});
function workspace(items: ReturnType<typeof item>[], records: Record<string, unknown>[] = []) {
  return {
    items,
    records: items
      .map((i) => ({
        kind: 'reaction',
        itemId: i.id,
        verdict: 'interested',
        at: new Date(now).toISOString(),
        interestLevel: 'priority',
      }))
      .concat(records as never),
    saved: [],
    edition: { rankings: [], sources: [] },
  };
}
const facts = { calendarAvailable: true, calendarEvents: [] };
describe('together planning constraints', () => {
  it('replaces food while keeping the exact main session and time', () => {
    const data = workspace([cafe, item('cafe2'), film]);
    const original = buildLeisureSuggestions(data, options, now, facts).days[0].plans.find(
      (p: { anchorId: string }) => p.anchorId === 'film',
    );
    const locked = original.stops.find((s: { itemId: string }) => s.itemId === 'film');
    const result = buildLeisureSuggestions(
      data,
      { ...options, anchorId: 'film', preferredFoodId: 'cafe2', lockedStop: locked },
      now,
      facts,
    ).days[0].plans[0];
    expect(result.stops.find((s: { itemId: string }) => s.itemId === 'film')).toEqual(locked);
    expect(result.stops.some((s: { itemId: string }) => s.itemId === 'cafe2')).toBe(true);
    expect(() =>
      buildLeisureSuggestions(
        data,
        { ...options, anchorId: 'film', lockedStop: { ...locked, itemId: 'wrong' } },
        now,
        facts,
      ),
    ).toThrow();
  });
  it('uses a supported local outdoor forecast and marks dates beyond the forecast horizon', () => {
    const data = workspace([item('park', 'trip')]),
      forecast = {
        at: { lat: 49.84, lon: 24.03 },
        days: [{ date, min: 7, max: 14, desc: 'невеликий дощ' }],
      };
    const result = buildLeisureSuggestions(data, options, now, { ...facts, forecasts: [forecast] })
      .days[0].plans[0];
    expect(result.weather[0]).toContain('7…14');
    expect(result.warnings.join(' ')).toContain('дощ');
    const far = buildLeisureSuggestions(data, { ...options, date: '2026-11-01' }, now, facts)
      .days[0].plans[0];
    expect(far.warnings.join(' ')).toContain('ближче до дати');
  });
  it('keeps film identity separate from its sessions and offers different anchors, not cafe permutations', () => {
    const result = buildLeisureSuggestions(
      workspace([cafe, film, concert, item('cafe2'), item('cafe3')]),
      options,
      now,
      facts,
    );
    const plans = result.days[0].plans;
    expect(plans).toHaveLength(3);
    expect(new Set(plans.map((p: { id: string }) => p.id)).size).toBe(plans.length);
    expect(plans.filter((p: { anchorId: string }) => p.anchorId === 'film')).toHaveLength(1);
    expect(plans.filter((p: { anchorId: string }) => p.anchorId.startsWith('cafe'))).toHaveLength(
      1,
    );
    expect(plans.find((p: { anchorId: string }) => p.anchorId === 'film').stops).toHaveLength(2);
    expect(
      plans.every((p: { stops: { startAt: string; endAt: string }[] }) =>
        p.stops.every((s) => s.startAt >= instant('16:00') && s.endAt <= instant('23:00')),
      ),
    ).toBe(true);
  });
  it('returns one valid quiet option instead of padding a sparse day', () => {
    expect(
      buildLeisureSuggestions(workspace([cafe, item('cafe2')]), options, now, facts).days[0].plans,
    ).toHaveLength(1);
  });
  it('keeps a long festival on its own and permits up to five different plans on a busy day', () => {
    const festival = item('festival', 'festival', {
      startAt: instant('16:00'),
      endAt: instant('22:00'),
      startDate: date,
      endDate: date,
    });
    const result = buildLeisureSuggestions(
      workspace([cafe, film, concert, festival, item('museum', 'place')]),
      options,
      now,
      facts,
    );
    expect(result.days[0].plans).toHaveLength(5);
    expect(
      result.days[0].plans.find((p: { anchorId: string }) => p.anchorId === 'festival').stops,
    ).toHaveLength(1);
  });
  it('rejects overlapping calendar events including travel gaps, but ignores transparent events', () => {
    const calendar = {
      startMs: leisureLocalInstant(date, '16:00'),
      endMs: leisureLocalInstant(date, '23:00'),
    };
    expect(
      buildLeisureSuggestions(workspace([cafe, film]), options, now, {
        calendarAvailable: true,
        calendarEvents: [calendar],
      }).days[0].plans,
    ).toEqual([]);
    expect(
      buildLeisureSuggestions(workspace([cafe, film]), options, now, {
        calendarAvailable: true,
        calendarEvents: [{ ...calendar, transparent: true }],
      }).days[0].plans.length,
    ).toBeGreaterThan(0);
  });
  it('does not invent film sessions or shorten a film to fit', () => {
    const noSessions = item('cinema', 'cinema');
    const result = buildLeisureSuggestions(workspace([noSessions]), options, now, facts);
    expect(result.days[0].plans).toEqual([]);
    expect(result.days[0].notes.join(' ')).toContain('Сеанси кіно');
    expect(
      buildLeisureSuggestions(
        workspace([film]),
        { ...options, startTime: '18:30', endTime: '21:00' },
        now,
        facts,
      ).days[0].plans,
    ).toEqual([]);
  });
  it('uses priorities, skips familiar places without revisit and keeps podcasts outside outing routes', () => {
    const data = workspace(
      [cafe, item('priority'), item('podcast', 'podcast')],
      [{ kind: 'visit', itemId: 'cafe' }],
    );
    data.records[0]!.interestLevel = 'interested';
    const result = buildLeisureSuggestions(data, options, now, facts);
    expect(result.days[0].plans.map((p: { anchorId: string }) => p.anchorId)).toEqual(['priority']);
    data.records[1]!.verdict = 'uninterested';
    expect(buildLeisureSuggestions(data, options, now, facts).days[0].plans).toEqual([]);
  });
  it('enforces a known minimum budget and visibly flags unknown prices and unavailable calendars', () => {
    expect(
      buildLeisureSuggestions(workspace([cafe]), { ...options, budgetMinor: 10000 }, now, facts)
        .days[0].plans,
    ).toEqual([]);
    const result = buildLeisureSuggestions(
      workspace([item('free', 'food', { price: { min: null, basis: 'unknown' } })]),
      { ...options, budgetMinor: 10000 },
      now,
      { calendarAvailable: false },
    );
    expect(result.days[0].plans[0].warnings.join(' ')).toContain('Частина цін невідома');
    expect(result.days[0].plans[0].confidence).toBe('needs-check');
  });
  it('removes closed places, supports overnight opening periods and confirms 24/7 separately', () => {
    const a = leisureLocalInstant(date, '23:30'),
      b = a + 60 * 60000;
    expect(leisureOpenDuring({}, a, b)).toBeNull();
    expect(
      leisureOpenDuring(
        { openingPeriods: [{ open: { day: 4, hour: 20 }, close: { day: 5, hour: 2 } }] },
        a,
        b,
      ),
    ).toBe(true);
    expect(leisureOpenDuring({ openingPeriods: [{ open: { day: 0, hour: 0 } }] }, a, b)).toBe(true);
    const closed = item('closed', 'food', {
      openingPeriods: [{ open: { day: 4, hour: 8 }, close: { day: 4, hour: 12 } }],
    });
    expect(buildLeisureSuggestions(workspace([closed]), options, now, facts).days[0].plans).toEqual(
      [],
    );
  });
  it('rebuilds around verified travel times and reserves time to return to the starting address', () => {
    const data = workspace([cafe, concert]);
    const draft = buildLeisureSuggestions(data, options, now, facts).days[0].plans.find(
      (p: { anchorId: string }) => p.anchorId === 'concert',
    );
    const key = leisureLegKey(draft.stops[0], draft.stops[1]);
    const rebuilt = buildLeisureSuggestions(data, options, now, {
      ...facts,
      routes: { [key]: { available: true, minutes: 45, distanceM: 9000 } },
    });
    expect(rebuilt.days[0].plans.length).toBeGreaterThan(0);
    const withOrigin = buildLeisureSuggestions(
      workspace([cafe]),
      { ...options, startLocation: 'Львів, вокзал' },
      now,
      {
        ...facts,
        boundaryRoutes: {
          [date + '|cafe|outbound']: { available: true, minutes: 50 },
          [date + '|cafe|return']: { available: true, minutes: 60 },
        },
      },
    ).days[0].plans[0];
    expect(withOrigin.stops[0].startAt).toBe(instant('16:50'));
    expect(withOrigin.legs.map((l: { minutes: number }) => l.minutes)).toEqual([50, 60]);
    expect(
      buildLeisureSuggestions(
        workspace([cafe]),
        { ...options, startLocation: 'Львів', endTime: '17:00' },
        now,
        facts,
      ).days[0].plans,
    ).toEqual([]);
  });
  it('returns one day group per date and respects individual hours', () => {
    const result = buildLeisureSuggestions(
      workspace([cafe, film]),
      {
        ...options,
        from: date,
        to: '2026-10-24',
        perDay: { [date]: { startTime: '20:00', endTime: '21:00' } },
      },
      now,
      facts,
    );
    expect(result.days.map((d: { date: string }) => d.date)).toEqual([
      date,
      '2026-10-23',
      '2026-10-24',
    ]);
    expect(result.days[0].plans).toEqual([]);
    expect(result.recommendedDate).toBe('2026-10-23');
  });
  it('does not silently mix fresh candidates into the saved pool, or override an explicit dislike', () => {
    const data = { items: [cafe], records: [], saved: [] };
    expect(buildLeisureSuggestions(data, options, now).days[0].plans).toEqual([]);
    expect(
      buildLeisureSuggestions(data, { ...options, allowNew: true }, now).days[0].plans,
    ).toHaveLength(1);
    expect(() =>
      buildLeisureSuggestions(data, { ...options, preferredFoodId: 'cafe' }, now),
    ).toThrow('доступних');
  });
  it('validates dates, bounded ranges, clocks, budget and Kyiv daylight saving changes', () => {
    expect(leisureLocalInstant('2026-10-26', '18:00')).toBe(Date.parse('2026-10-26T16:00Z'));
    expect(leisureLocalInstant('2026-10-22', '18:00')).toBe(Date.parse('2026-10-22T15:00Z'));
    expect(() => leisureLocalInstant('2026-03-29', '03:30')).toThrow();
    for (const input of [
      { date: '2026-02-30' },
      { date: '2026-10-18' },
      { ...options, endTime: '15:00' },
      { ...options, to: '2026-11-12' },
      { ...options, budgetMinor: -1 },
      { ...options, transport: 'jet' },
      { ...options, startTime: '25:00' },
    ])
      expect(() => normalizeLeisureWindow(input, now)).toThrow();
  });
});
