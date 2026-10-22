import { describe, it, expect } from 'vitest';
import { classifiedLeisureItem, classifyLeisureEvent } from '../web/core/leisure/taxonomy.mjs';
import {
  leisureFoodQuality,
  normalizeLeisureSelection,
  selectLeisureHighlights,
  leisureFormatAvailable,
  leisureWorkKey,
} from '../web/core/leisure/selection.mjs';
import { buildLeisureSuggestions } from '../web/core/leisure/planning.mjs';
import { eventCategory } from '../web/core/leisure/publisher-parsers.mjs';
const now = Date.parse('2026-10-22T08:00Z');
const food = (rating: number | null = 4.7, count = 500, extra: Record<string, unknown> = {}) => ({
  id: 'cafe',
  category: 'food',
  title: 'Заклад',
  placeDetails: { rating, userRatingCount: count, businessStatus: 'OPERATIONAL' },
  ...extra,
});
describe('category selection and quality', () => {
  it.each([
    'Серія занять з декоративної кераміки',
    'Заняття з кераміки',
    'Гончарство',
    'Майстер-клас для двох',
  ])('repairs the legacy concert label of %s without replacing its identity', (title) => {
    const old = { id: 'item-legacy', identityKey: 'same-decision', category: 'concert', title };
    expect(classifiedLeisureItem(old)).toMatchObject({
      id: old.id,
      identityKey: old.identityKey,
      category: 'meetup',
      eventFormat: 'workshop',
    });
  });
  it.each([
    ['Балет «Жізель»', 'show', 'ballet'],
    ['Опера «Кармен»', 'show', 'opera'],
    ['Джазовий концерт', 'concert', 'concert'],
    ['Лекція про місто', 'meetup', 'lecture'],
    ['Невідомий вечір', 'event', 'other'],
    ['Виставка живопису', 'exhibition', 'exhibition'],
  ])('classifies %s by its meaning', (title, category, eventFormat) =>
    expect(classifyLeisureEvent({ title })).toMatchObject({ category, eventFormat }),
  );
  it('does not use a venue name to turn a creative workshop into music', () => {
    expect(
      classifyLeisureEvent({
        title: 'Кераміка для двох',
        source: 'Львівська філармонія',
        structuredType: 'MusicEvent',
      }),
    ).toMatchObject({ category: 'meetup', eventFormat: 'workshop' });
    expect(
      classifyLeisureEvent({ title: 'Кармен', publisherCategory: 'Опера', category: 'show' }),
    ).toMatchObject({ eventFormat: 'opera' });
  });
  it('keeps a lecture about cinema separate from an actual screening', () => {
    expect(eventCategory('Лекція про історію кіно')).toBe('meetup');
    expect(eventCategory('Зустріч з режисером фільму')).toBe('meetup');
    expect(eventCategory('Кінопоказ просто неба')).toBe('cinema');
  });
  it('applies an explicit correction while keeping the original item', () => {
    expect(
      classifiedLeisureItem(
        { id: 'old', title: 'Вечір', category: 'event' },
        { category: 'show', eventFormat: 'standup' },
      ),
    ).toMatchObject({
      id: 'old',
      category: 'show',
      eventFormat: 'standup',
      classificationEvidence: 'уточнено власником',
    });
  });
  it('keeps an unknown legacy performance genre unknown and uses an explicit ballet description', () => {
    expect(
      classifyLeisureEvent({ category: 'show', title: 'Фауст', source: 'Львівська опера' }),
    ).toMatchObject({ category: 'show', eventFormat: 'other' });
    expect(
      classifyLeisureEvent({
        category: 'show',
        title: 'Есмеральда',
        summary: 'Витончена балетна історія кохання.',
      }),
    ).toMatchObject({ category: 'show', eventFormat: 'ballet' });
    expect(
      classifyLeisureEvent({
        category: 'concert',
        title: 'Джазовий концерт',
        summary: 'На сцені Львівської національної опери.',
      }),
    ).toMatchObject({ category: 'concert', eventFormat: 'concert' });
  });
  it('accepts 4.4 exactly and excludes 4.3 only for food quality', () => {
    expect(leisureFoodQuality(food(4.4)).eligible).toBe(true);
    expect(leisureFoodQuality(food(4.3)).eligible).toBe(false);
    expect(
      leisureFoodQuality(food(4.3), normalizeLeisureSelection({ minFoodRating: 4.3 })).eligible,
    ).toBe(true);
  });
  it('dampens a tiny perfect rating and gives no universal-cuisine bonus', () => {
    expect(leisureFoodQuality(food(5, 8)).score).toBeLessThan(
      leisureFoodQuality(food(4.7, 2000)).score,
    );
    expect(leisureFoodQuality(food(4.7, 500, { placeType: 'restaurant' })).score).toBe(
      leisureFoodQuality(food(4.7, 500, { placeType: 'japanese_restaurant' })).score,
    );
  });
  it('keeps unknown ratings and incomplete parking separate from a negative fact', () => {
    expect(leisureFoodQuality(food(null))).toMatchObject({
      verified: false,
      rating: null,
      eligible: false,
      hasParking: null,
    });
    expect(
      leisureFoodQuality({
        ...food(),
        placeDetails: { rating: 4.8, parking: { freeParkingLot: false } },
      }).hasParking,
    ).toBe(null);
    expect(
      leisureFoodQuality(
        { ...food(), placeDetails: { rating: 4.8, parking: { paidParkingLot: true } } },
        normalizeLeisureSelection({ parking: 'required' }),
      ).eligible,
    ).toBe(true);
    expect(
      leisureFoodQuality(food(), normalizeLeisureSelection({ parking: 'required' })).eligible,
    ).toBe(false);
    expect(
      leisureFoodQuality(food(), normalizeLeisureSelection({ parking: 'required' }), {}, 'walk')
        .eligible,
    ).toBe(true);
  });
  it('allows a visible priority exception but never a known closed venue', () => {
    const priority = { verdict: 'interested', interestLevel: 'priority' };
    expect(leisureFoodQuality(food(4.2), undefined, priority)).toMatchObject({
      eligible: true,
      priority: true,
    });
    expect(
      leisureFoodQuality(
        { ...food(), placeDetails: { rating: 4.9, businessStatus: 'CLOSED_PERMANENTLY' } },
        undefined,
        priority,
      ).eligible,
    ).toBe(false);
  });
  it('merges owner settings without losing subscriptions or corrections', () => {
    const initial = normalizeLeisureSelection({
      followedPodcastSeries: ['Серія'],
      formatFrequency: { opera: 'manual' },
      categoryOverrides: { a: { category: 'meetup', eventFormat: 'workshop' } },
    });
    expect(normalizeLeisureSelection({ minFoodRating: 4.3 }, initial)).toMatchObject({
      minFoodRating: 4.3,
      followedPodcastSeries: ['Серія'],
      formatFrequency: { opera: 'manual' },
      categoryOverrides: initial.categoryOverrides,
    });
    expect(() => normalizeLeisureSelection({ minFoodRating: 4.35 })).toThrow();
    expect(() => normalizeLeisureSelection({ formatFrequency: { opera: 'never-ever' } })).toThrow();
  });
  it('makes a finite diverse highlight set without requiring every restaurant to be liked', () => {
    const items = Array.from({ length: 80 }, (_, n) => ({
      id: 'event-' + n,
      title: 'Подія ' + n,
      identityKey: 'key-' + n,
      category: n % 2 ? 'concert' : 'show',
      eventFormat: n % 2 ? 'concert' : 'opera',
      source: 'source-' + (n % 8),
    }));
    const highlights = selectLeisureHighlights(
      [food(), ...items],
      [],
      { selection: normalizeLeisureSelection({}) },
      now,
    );
    expect(highlights.length).toBeLessThanOrEqual(12);
    expect(highlights.filter((i) => 'eventFormat' in i && i.eventFormat === 'opera')).toHaveLength(
      1,
    );
    expect(highlights.some((i) => i.category === 'food')).toBe(false);
    expect(
      selectLeisureHighlights(
        items,
        [{ kind: 'reaction', itemId: 'event-1', identityKey: 'key-1', verdict: 'uninterested' }],
        {},
        now,
      ).some((i) => i.id === 'event-1'),
    ).toBe(false);
  });
  it('treats rare visits as cadence and respects an explicit wish', () => {
    const item = { category: 'show', eventFormat: 'opera' };
    const visits = [{ kind: 'visit', eventFormat: 'opera', visitedOn: '2026-10-01' }];
    expect(leisureFormatAvailable(item, visits, {}, now)).toBe(false);
    expect(leisureFormatAvailable(item, visits, {}, now, true)).toBe(true);
    expect(leisureFormatAvailable({ ...item, eventFormat: 'concert' }, visits, {}, now)).toBe(true);
    expect(leisureWorkKey({ category: 'show', sourceUrl: 'https://example.com/show?date=1' })).toBe(
      leisureWorkKey({ category: 'show', sourceUrl: 'https://example.com/show?date=2' }),
    );
    expect(
      leisureWorkKey({
        category: 'show',
        title: 'Кармен',
        sourceUrl: 'https://example.com/calendar',
      }),
    ).not.toBe(
      leisureWorkKey({
        category: 'show',
        title: 'Жізель',
        sourceUrl: 'https://example.com/calendar',
      }),
    );
  });
  it('plans a verified unrated-by-owner restaurant and still honours rejection', () => {
    const cafe = {
      ...food(),
      venueId: 'a',
      sourceUrl: 'https://example.com/cafe',
      address: 'Львів',
      status: 'available',
      price: { min: 100, basis: 'person' },
      sessions: [],
    };
    const workspace = {
      items: [cafe],
      records: [],
      saved: [],
      settings: { selection: normalizeLeisureSelection({}) },
      edition: { rankings: [], sources: [] },
    };
    const options = { date: '2026-10-23', startTime: '17:00', endTime: '21:00', transport: 'walk' };
    expect(
      buildLeisureSuggestions(workspace, options, now, {
        calendarAvailable: true,
        calendarEvents: [],
      }).days[0].plans,
    ).toHaveLength(1);
    const hidden = {
      ...workspace,
      records: [{ kind: 'reaction', itemId: cafe.id, verdict: 'uninterested' }],
    };
    expect(buildLeisureSuggestions(hidden, options, now, {}).days[0].plans).toHaveLength(0);
    expect(
      buildLeisureSuggestions(
        { ...workspace, items: [{ ...cafe, placeDetails: { rating: 4.2, userRatingCount: 300 } }] },
        options,
        now,
        {},
      ).days[0].plans,
    ).toHaveLength(0);
  });
});
