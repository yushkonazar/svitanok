import { describe, it, expect } from 'vitest';
import {
  normalizeLeisureItem,
  selectLeisureEdition,
  DEFAULT_LEISURE_SETTINGS,
} from '../web/core/leisure/model.mjs';
import {
  leisureFeatures,
  knownLeisurePlace,
  explicitLeisureInterests,
  leisurePreferenceProfile,
  rankLeisureItems,
} from '../web/core/leisure/discovery.mjs';
import {
  executeLeisureCommand,
  upsertLeisureItems,
  readLeisureWorkspace,
  publishLeisureEdition,
  compactLeisureCatalog,
} from '../web/core/leisure/store.mjs';
import { handleLeisure } from '../web/api-leisure.mjs';
import { runLeisureQuery } from '../web/core/tools/leisure.mjs';
import { d1FromSqlite } from './helpers/d1.js';
import { workerEnv } from './helpers/env.js';
import { buildInitData } from './helpers/init-data.js';
const now = Date.parse('2026-10-12T10:00:00Z');
const item = async (index: number, over: Record<string, unknown> = {}) =>
  (await normalizeLeisureItem(
    {
      title: `Фільм ${index}`,
      category: 'cinema',
      sourceUrl: `https://planetakino.ua/movie/${index}/`,
      source: 'Test',
      genre: 'Драма',
      ...over,
    },
    now,
  ))!;
function setup() {
  const d1 = d1FromSqlite(['0039_leisure.sql'], { atomicBatch: true });
  const DB = {
    ...d1.stub,
    prepare: (sql: string) => {
      const s = d1.stub.prepare(sql);
      return { ...s, ...s.bind() };
    },
  };
  return {
    ...d1,
    env: workerEnv({ DB, TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_OWNER_USER_ID: '42' }),
  };
}
const cmd = (
  op: string,
  id: string,
  payload: Record<string, unknown>,
  commandId = crypto.randomUUID(),
) => ({ op, id, payload, commandId });
describe('swipe feedback, durable preferences and review safety', () => {
  it('extracts explicit positive and negative interests without inventing partner preferences', () => {
    expect(explicitLeisureInterests('Обожнюю Марвел! Не люблю DC. Pixar — подобається.')).toEqual([
      { feature: 'interest:marvel', direction: 1 },
      { feature: 'interest:dc', direction: -1 },
      { feature: 'interest:pixar', direction: 1 },
    ]);
    expect(explicitLeisureInterests('Marvel. Не зараз, зайнятий.')).toEqual([]);
    expect(
      explicitLeisureInterests('Обожнюю Marvel, але не люблю DC. Дівчині подобається Pixar.'),
    ).toEqual([
      { feature: 'interest:marvel', direction: 1 },
      { feature: 'interest:dc', direction: -1 },
    ]);
    expect(
      leisureFeatures({ category: 'cinema', title: 'Людина-павук', genre: 'Бойовик, пригоди' }),
    ).toEqual(expect.arrayContaining(['interest:marvel', 'genre:action', 'genre:adventure']));
  });
  it('learns from an old review and deduplicates same-day film evidence', async () => {
    const a = await item(1, { title: 'Людина-павук', genre: 'Бойовик' });
    const visit = {
      kind: 'visit',
      itemId: a.id,
      category: 'cinema',
      rating: 'liked',
      visitedOn: '2026-08-06',
      reason: 'Обожнюю Marvel',
      at: new Date(now).toISOString(),
    };
    const once = leisurePreferenceProfile([a], [visit], now),
      twice = leisurePreferenceProfile([a], [visit, { ...visit, reason: 'Обожнюю Марвел' }], now);
    expect(twice).toEqual(once);
    expect(once.signals).toBe(1);
    expect(once.interests[0]).toMatchObject({ feature: 'interest:marvel', label: 'Marvel' });
    const next = await item(2, { title: 'Месники', genre: 'Бойовик' }),
      other = await item(3);
    expect(rankLeisureItems([other, next], [visit], [], {}, now)[0]?.id).toBe(next.id);
  });
  it('uses a neutral prior, does not generalize time/price dislikes, and decays old signals', async () => {
    const a = await item(1);
    const feedback = {
      kind: 'reaction',
      itemId: a.id,
      verdict: 'uninterested',
      features: leisureFeatures(a),
      reasonCode: 'price',
    };
    expect(leisurePreferenceProfile([a], [feedback], now).weights).toEqual({});
    expect(
      leisurePreferenceProfile([a], [{ ...feedback, verdict: 'later', reasonCode: 'time' }], now)
        .signals,
    ).toBe(0);
    const positive = { ...feedback, verdict: 'interested', at: new Date(now).toISOString() };
    const fresh = leisurePreferenceProfile([a], [positive], now),
      aged = leisurePreferenceProfile([a], [positive], now + 180 * 86400000);
    expect(fresh.interests.every((r) => r.score > 0 && r.score < 8)).toBe(true);
    expect(aged.weights['genre:drama']!.positive).toBeCloseTo(
      fresh.weights['genre:drama']!.positive / 2,
    );
    const archived = leisurePreferenceProfile(
      [],
      [{ kind: 'profile', weights: fresh.weights, signals: 1, at: new Date(now).toISOString() }],
      now + 180 * 86400000,
    );
    expect(archived.weights).toEqual(aged.weights);
  });
  it('explores another category only when it remains close in relevance', async () => {
    const films = await Promise.all(Array.from({ length: 12 }, (_, n) => item(n))),
      cafe = await item(20, { category: 'food', placeType: 'restaurant' });
    const mixed = rankLeisureItems([...films, cafe], [], [], {}, now);
    expect(mixed[5]?.id).toBe(cafe.id);
    expect(mixed[5]?.reasons[0]).toBe('Новий напрямок для знайомства');
    const records = Array.from({ length: 20 }, (_, n) => ({
      kind: 'reaction',
      itemId: String(n),
      verdict: 'uninterested',
      reasonCode: 'format',
      features: ['format:restaurant'],
    }));
    expect(
      rankLeisureItems([...films, cafe], records, [], {}, now)
        .slice(0, 6)
        .every((r) => r.id !== cafe.id),
    ).toBe(true);
  });
  it('retires expired unchosen cards while retaining personal selections, plans and reviews', async () => {
    const { env, db } = setup();
    const [expired, visited, saved, liked, familiar] = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => item(n, { endDate: '2026-10-11', genre: 'Комедія' })),
    );
    await upsertLeisureItems(env, [expired!, visited!, saved!, liked!, familiar!]);
    await executeLeisureCommand(
      env,
      cmd('reaction', expired!.id, { verdict: 'uninterested', reasonCode: 'genre' }),
      now,
    );
    await executeLeisureCommand(
      env,
      cmd('visit', visited!.id, {
        visitedOn: '2026-10-10',
        rating: 'liked',
        reason: 'Обожнюю Marvel',
      }),
      now,
    );
    await executeLeisureCommand(env, cmd('save', saved!.id, { saved: true }), now);
    await executeLeisureCommand(env, cmd('reaction', liked!.id, { verdict: 'interested' }), now);
    await executeLeisureCommand(env, cmd('familiarity', familiar!.id, { mode: 'many' }), now);
    expect(await compactLeisureCatalog(env, now)).toEqual({ removed: 1 });
    const data = await readLeisureWorkspace(env, now, true);
    expect(data.items.map((i) => i.id)).not.toContain(expired!.id);
    expect(data.records.some((r) => r.itemId === expired!.id)).toBe(false);
    expect(data.records.find((r) => r.kind === 'visit')?.reason).toBe('Обожнюю Marvel');
    expect(data.items.map((i) => i.id)).toEqual(
      expect.arrayContaining([visited!.id, saved!.id, liked!.id, familiar!.id]),
    );
    expect(data.preferenceProfile.weights['genre:comedy']?.negative).toBeGreaterThan(0);
    const stored = db
      .prepare("SELECT data_json FROM leisure_records WHERE kind='profile'")
      .get() as { data_json: string };
    expect(stored.data_json).not.toContain('Фільм');
    expect(stored.data_json).not.toContain('topic:');
    expect(await compactLeisureCatalog(env, now)).toEqual({ removed: 0 });
    expect((await readLeisureWorkspace(env, now)).preferenceProfile).toEqual(
      data.preferenceProfile,
    );
    db.close();
  });
  it('aborts compaction when feedback changes after the read, instead of folding stale evidence', async () => {
    const { env, db } = setup(),
      a = await item(1, { endDate: '2026-10-11' });
    await upsertLeisureItems(env, [a]);
    await executeLeisureCommand(
      env,
      cmd('reaction', a.id, { verdict: 'uninterested', reasonCode: 'genre' }),
      now,
    );
    const batch = env.DB!.batch.bind(env.DB);
    env.DB!.batch = async (statements) => {
      db.prepare(
        "UPDATE leisure_records SET revision=revision+1,data_json=json_set(data_json,'$.verdict','interested') WHERE kind='reaction'",
      ).run();
      return batch(statements);
    };
    expect(await compactLeisureCatalog(env, now)).toEqual({ removed: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM leisure_items').get()).toMatchObject({ n: 1 });
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM leisure_records WHERE kind='profile'").get(),
    ).toMatchObject({ n: 0 });
    db.close();
  });
  it('prevents accidental duplicate film reviews, permits explicit repeat viewing and retains edits', async () => {
    const { env, db } = setup(),
      a = await item(1);
    await upsertLeisureItems(env, [a]);
    const command = cmd('visit', a.id, {
      visitedOn: '2026-10-11',
      rating: 'liked',
      reason: 'Обожнюю Marvel',
    });
    const first = await executeLeisureCommand(env, command, now);
    expect(await executeLeisureCommand(env, command, now)).toEqual(first);
    await expect(
      executeLeisureCommand(env, cmd('visit', a.id, command.payload), now),
    ).rejects.toThrow('вже записано');
    await executeLeisureCommand(
      env,
      cmd('visit', a.id, {
        ...command.payload,
        visitId: first.id,
        revision: 1,
        reason: 'Доповнив враження',
      }),
      now,
    );
    await executeLeisureCommand(
      env,
      cmd('visit', a.id, { ...command.payload, allowRepeat: true }),
      now,
    );
    const records = (await readLeisureWorkspace(env, now)).records.filter(
      (r) => r.kind === 'visit',
    );
    expect(records).toHaveLength(2);
    expect(records.find((r) => r.id === first.id)).toMatchObject({
      revision: 2,
      reason: 'Доповнив враження',
    });
    db.close();
  });
  it('does not acknowledge a competing insert as a successful new visit', async () => {
    const { env, db } = setup(),
      a = await item(1);
    await upsertLeisureItems(env, [a]);
    const outcomes = await Promise.allSettled(
      [1, 2].map(() =>
        executeLeisureCommand(env, cmd('visit', a.id, { visitedOn: '2026-10-11' }), now),
      ),
    );
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      (await readLeisureWorkspace(env, now)).records.filter((r) => r.kind === 'visit'),
    ).toHaveLength(1);
    db.close();
  });
  it('accepts concurrent delivery of the same original command only once', async () => {
    const { env, db } = setup(),
      a = await item(1);
    await upsertLeisureItems(env, [a]);
    const command = cmd('visit', a.id, { visitedOn: '2026-10-11', reason: 'Обожнюю Marvel' });
    const [first, second] = await Promise.all([
      executeLeisureCommand(env, command, now),
      executeLeisureCommand(env, command, now),
    ]);
    expect(first.id).toBe(second.id);
    const data = await readLeisureWorkspace(env, now);
    expect(data.records.filter((r) => r.kind === 'visit')).toHaveLength(1);
    await executeLeisureCommand(
      env,
      cmd('visit', a.id, {
        visitId: first.id,
        revision: 1,
        visitedOn: '2026-10-10',
        reason: 'Виправив дату',
      }),
      now,
    );
    await executeLeisureCommand(
      env,
      cmd('visit', a.id, { visitedOn: '2026-10-11', reason: 'Новий перегляд' }),
      now,
    );
    expect(
      (await readLeisureWorkspace(env, now)).records.filter((r) => r.kind === 'visit'),
    ).toHaveLength(2);
    db.close();
  });
  it('shares Interesting and review-text search with the assistant without treating a like as a plan', async () => {
    const { env, db } = setup(),
      a = await item(1);
    await publishLeisureEdition(env, [a], [], now);
    await executeLeisureCommand(env, cmd('reaction', a.id, { verdict: 'interested' }), now);
    const interesting = await runLeisureQuery(env, { view: 'interested' }, now);
    expect(interesting.result).toContain(a.id);
    expect(interesting.result).toContain('"reaction":"interested"');
    expect(interesting.result).toContain('"saved":false');
    await executeLeisureCommand(
      env,
      cmd('visit', a.id, { reason: 'Обожнюю Marvel', rating: 'liked' }),
      now,
    );
    const found = await runLeisureQuery(env, { view: 'visits', query: 'Marvel' }, now);
    expect(found.result).toContain('Обожнюю Marvel');
    expect(found.result).toContain('interest:marvel');
    expect(found.result).not.toContain('lastCommandFingerprint');
    db.close();
  });
});
describe('full discovery and explicit learning', () => {
  it('exposes every verified film and more than three future events, not an editorial quota', async () => {
    const films = await Promise.all(Array.from({ length: 40 }, (_, n) => item(n))),
      future = await Promise.all(
        Array.from({ length: 8 }, (_, n) =>
          item(n + 50, { category: 'show', startDate: '2026-10-25', endDate: '2026-10-25' }),
        ),
      );
    const edition = selectLeisureEdition(
      [...films, ...future],
      [],
      [],
      DEFAULT_LEISURE_SETTINGS,
      now,
    );
    expect(edition.ids).toHaveLength(40);
    expect(edition.futureIds).toHaveLength(8);
  });
  it('learns a rejected genre rather than rejecting every film, and can undo the signal', async () => {
    const comedy = await item(1, { genre: 'Комедія' }),
      otherComedy = await item(2, { genre: 'Комедія' }),
      drama = await item(3);
    const feedback = {
      kind: 'reaction',
      itemId: comedy.id,
      verdict: 'uninterested',
      reasonCode: 'genre',
      features: leisureFeatures(comedy),
    };
    const ranked = selectLeisureEdition(
      [comedy, otherComedy, drama],
      [feedback],
      [],
      DEFAULT_LEISURE_SETTINGS,
      now,
    );
    expect(ranked.ids).not.toContain(comedy.id);
    expect(ranked.ids.indexOf(drama.id)).toBeLessThan(ranked.ids.indexOf(otherComedy.id));
    expect(
      selectLeisureEdition(
        [comedy, otherComedy, drama],
        [{ ...feedback, verdict: 'clear' }],
        [],
        DEFAULT_LEISURE_SETTINGS,
        now,
      ).ids,
    ).toHaveLength(3);
  });
  it('moves an interesting choice upward without saving or planning it', async () => {
    const { env, db } = setup(),
      a = await item(1),
      b = await item(2);
    await publishLeisureEdition(env, [a, b], [], now);
    await executeLeisureCommand(env, cmd('reaction', b.id, { verdict: 'interested' }), now);
    const data = await readLeisureWorkspace(env, now);
    expect(data.edition.ids[0]).toBe(b.id);
    expect(data.saved).toEqual([]);
    expect(data.records.filter((r) => r.kind === 'plan')).toEqual([]);
    db.close();
  });
  it('treats not-now as temporary, and never turns it into a genre dislike', async () => {
    const a = await item(1),
      b = await item(2);
    const r = {
      kind: 'reaction',
      itemId: a.id,
      verdict: 'later',
      reasonCode: 'time',
      features: leisureFeatures(a),
      at: new Date(now).toISOString(),
    };
    expect(selectLeisureEdition([a, b], [r], [], DEFAULT_LEISURE_SETTINGS, now).ids).toEqual([
      b.id,
    ]);
    const next = selectLeisureEdition(
      [a, b],
      [r],
      [],
      DEFAULT_LEISURE_SETTINGS,
      now + 7 * 86400000,
    );
    expect(next.ids).toHaveLength(2);
    expect(new Set(next.rankings.map((r) => r.score)).size).toBe(1);
  });
  it('applies not-this-week in Kyiv time even before UTC Monday starts', async () => {
    const a = await item(1),
      early = Date.parse('2026-10-18T21:30:00Z');
    const r = {
      kind: 'reaction',
      itemId: a.id,
      verdict: 'later',
      at: new Date(early).toISOString(),
    };
    expect(selectLeisureEdition([a], [r], [], DEFAULT_LEISURE_SETTINGS, early).ids).toEqual([]);
    expect(
      selectLeisureEdition(
        [a],
        [r],
        [],
        DEFAULT_LEISURE_SETTINGS,
        Date.parse('2026-10-26T08:00:00Z'),
      ).ids,
    ).toEqual([a.id]);
  });
  it('marks many earlier visits without creating a count and counts new visits independently', async () => {
    const { env, db } = setup(),
      cafe = await item(1, { category: 'food', placeId: 'cafe-1', address: 'Львів, 1' });
    await publishLeisureEdition(env, [cafe], [], now);
    const command = cmd('familiarity', cafe.id, { mode: 'many', revision: 0 });
    await executeLeisureCommand(env, command, now);
    await executeLeisureCommand(env, command, now);
    expect(
      (await readLeisureWorkspace(env, now)).records.filter((r) => r.kind === 'visit'),
    ).toHaveLength(0);
    await executeLeisureCommand(env, cmd('visit', cafe.id, { visitedOn: '2026-10-12' }), now);
    const data = await readLeisureWorkspace(env, now);
    expect(data.knownPlaces[cafe.id]).toMatchObject({
      frequent: true,
      previousCount: null,
      trackedCount: 1,
    });
    expect(data.edition.ids).toContain(cafe.id);
    await expect(
      executeLeisureCommand(
        env,
        cmd('familiarity', cafe.id, { mode: 'count', previousCount: 2, revision: 0 }),
        now,
      ),
    ).rejects.toThrow('змінився');
    db.close();
  });
  it('keeps earlier exact counts separate from tracked visits and supports clearing the baseline', async () => {
    const { env, db } = setup(),
      cafe = await item(1, { category: 'food' });
    await upsertLeisureItems(env, [cafe]);
    await expect(
      executeLeisureCommand(
        env,
        cmd('familiarity', cafe.id, { mode: 'count', previousCount: 1.5 }),
        now,
      ),
    ).rejects.toThrow('цілу');
    await executeLeisureCommand(
      env,
      cmd('familiarity', cafe.id, { mode: 'count', previousCount: 7 }),
      now,
    );
    await executeLeisureCommand(
      env,
      cmd('visit', cafe.id, { visitedOn: '2026-10-11', legacy: true }),
      now,
    );
    let data = await readLeisureWorkspace(env, now);
    expect(data.knownPlaces[cafe.id]).toMatchObject({
      previousCount: 7,
      legacyCount: 1,
      trackedCount: 0,
    });
    await executeLeisureCommand(
      env,
      cmd('familiarity', cafe.id, { mode: 'clear', revision: 1 }),
      now,
    );
    data = await readLeisureWorkspace(env, now);
    expect(data.knownPlaces[cafe.id]).toMatchObject({ previousCount: null, legacyCount: 1 });
    db.close();
  });
  it('keeps primary-owner wire compatibility for an already-open old Mini App', async () => {
    const { env, db } = setup(),
      cafe = await item(1, { category: 'food' });
    await upsertLeisureItems(env, [cafe]);
    await executeLeisureCommand(env, cmd('familiarity', cafe.id, { mode: 'unknown' }), now);
    const init = await buildInitData(42, 'test-token');
    const get = async (extended: boolean) =>
      handleLeisure(
        new Request('https://app.test/api/leisure', {
          headers: {
            'X-Telegram-Init-Data': init,
            ...(extended ? { 'X-Leisure-Format': '2' } : {}),
          },
        }),
        env,
      ).then((r) => r.json()) as Promise<{ workspace: { records: { kind: string }[] } }>;
    expect((await get(false)).workspace.records).toEqual([]);
    expect((await get(true)).workspace.records[0]!.kind).toBe('familiarity');
    db.close();
  });
  it('keeps a Google place identity and saved references across renamed source URLs', async () => {
    const { env, db } = setup(),
      old = await item(1, {
        category: 'food',
        placeId: 'same',
        sourceUrl: 'https://maps.google.com/old',
      }),
      next = await item(2, {
        category: 'food',
        placeId: 'same',
        sourceUrl: 'https://maps.google.com/new',
      });
    expect(old.id).toBe(next.id);
    await upsertLeisureItems(env, [old]);
    await executeLeisureCommand(env, cmd('save', old.id, { saved: true }), now);
    await upsertLeisureItems(env, [next]);
    const data = await readLeisureWorkspace(env, now);
    expect(data.saved).toEqual([old.id]);
    expect(data.items).toHaveLength(1);
    db.close();
  });
  it('never interprets a frequent-visit baseline as a positive rating', async () => {
    const cafe = await item(1, { category: 'food' });
    const records = [{ kind: 'familiarity', itemId: cafe.id, mode: 'many' }];
    expect(knownLeisurePlace(cafe, records)).toMatchObject({ frequent: true, trackedCount: 0 });
    expect(
      selectLeisureEdition([cafe], records, [], DEFAULT_LEISURE_SETTINGS, now).rankings[0]!.score,
    ).toBe(selectLeisureEdition([cafe], [], [], DEFAULT_LEISURE_SETTINGS, now).rankings[0]!.score);
  });
});
