import { expect, it } from 'vitest';
import {
  applyNewsReaderAction,
  emptyNewsReader,
  normalizeNewsReader,
} from '../web/core/brief/news-reader.mjs';
const now = Date.parse('2026-11-03T12:00:00Z');
const story = (id = 'story-a') => ({
  topic: 'Україна',
  scope: 'ua',
  item: {
    storyId: id,
    contentVersion: 'v1',
    title: 'Підтверджена подія',
    url: `https://example.test/${id}`,
    why: 'Додаткові подробиці джерела.',
  },
});
it('keeps explicit following independent from reading and retries preserve the original follow time', () => {
  const read = applyNewsReaderAction(emptyNewsReader(), story(), 'read', 'v1', now).reader;
  expect(read.following).toEqual({});
  const first = applyNewsReaderAction(read, story(), 'follow', undefined, now).reader;
  const retried = applyNewsReaderAction(first, story(), 'follow', undefined, now + 60000).reader;
  expect(retried.following['story-a']?.followedAt).toBe(new Date(now).toISOString());
  expect(retried.readVersions['story-a']).toEqual(['v1']);
  expect(
    applyNewsReaderAction(retried, story(), 'unfollow', undefined, now).reader.following,
  ).toEqual({});
});
it('retains a newer read version when a stale open article is marked read later', () => {
  let reader = emptyNewsReader();
  for (const version of ['v2', 'v1', 'v2'])
    reader = applyNewsReaderAction(reader, story(), 'read', version, now).reader;
  expect(reader.readVersions['story-a']).toEqual(['v1', 'v2']);
  expect(
    applyNewsReaderAction(reader, story(), 'unread', 'v1', now).reader.readVersions['story-a'],
  ).toEqual(['v2']);
});
it('expires a mute after exactly 24 hours and supports explicit undo', () => {
  const reader = applyNewsReaderAction({}, story(), 'mute', undefined, now).reader;
  expect(normalizeNewsReader(reader, now + 86400000 - 1).mutedUntil['story-a']).toBeDefined();
  expect(normalizeNewsReader(reader, now + 86400000).mutedUntil).toEqual({});
  expect(
    applyNewsReaderAction(reader, story(), 'unmute', undefined, now).reader.mutedUntil,
  ).toEqual({});
});
it('limits followed stories and lets the reader remove one before following another', () => {
  let reader = emptyNewsReader();
  for (let i = 0; i < 20; i++)
    reader = applyNewsReaderAction(reader, story(`s${i}`), 'follow', undefined, now).reader;
  expect(applyNewsReaderAction(reader, story('overflow'), 'follow', undefined, now)).toMatchObject({
    ok: false,
  });
  reader = applyNewsReaderAction(reader, story('s0'), 'unfollow', undefined, now).reader;
  expect(applyNewsReaderAction(reader, story('overflow'), 'follow', undefined, now)).toMatchObject({
    ok: true,
  });
});
it('bounds multibyte read state by bytes and preserves the most recent versions', () => {
  const readVersions = Object.fromEntries(
    Array.from({ length: 350 }, (_, i) => [
      `https://example.test/${i}${'ї'.repeat(900)}`,
      ['ї'.repeat(1900)],
    ]),
  );
  const reader = normalizeNewsReader({ readVersions }, now);
  expect(new TextEncoder().encode(JSON.stringify(reader)).length).toBeLessThanOrEqual(96 * 1024);
  expect(Object.keys(reader.readVersions).length).toBeLessThan(300);
  expect(Object.keys(reader.readVersions).at(-1)).toContain('/349');
});
