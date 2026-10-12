import { describe, it, expect } from 'vitest';
import {
  normalizeLeisureItem,
  selectLeisureEdition,
  DEFAULT_LEISURE_SETTINGS,
} from '../web/core/leisure/model.mjs';
import { leisureFeatures, knownLeisurePlace } from '../web/core/leisure/discovery.mjs';
import {
  executeLeisureCommand,
  upsertLeisureItems,
  readLeisureWorkspace,
  publishLeisureEdition,
} from '../web/core/leisure/store.mjs';
import { handleLeisure } from '../web/api-leisure.mjs';
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
