import { beforeEach, expect, it } from 'vitest';
import {
  EMPTY_NEWS_READER,
  newsChange,
  newsSnapshotKey,
  newsStories,
  newsWasRead,
  readNewsView,
  saveNewsView,
} from './newsStories.ts';
const item = {
  storyId: 'event',
  contentVersion: 'v1',
  title: 'Подія',
  url: 'https://www.bbc.com/news/a',
  firstSeenAt: '2026-11-03T09:00:00Z',
  changeAt: '2026-11-03T11:00:00Z',
};
beforeEach(() => sessionStorage.clear());
it('keeps a read story read across publishers but exposes a new substantive version', () => {
  const reader = { ...EMPTY_NEWS_READER, readVersions: { event: ['v1'] } };
  expect(newsWasRead({ ...item, url: 'https://suspilne.media/a' }, reader, [])).toBe(true);
  expect(newsWasRead({ ...item, contentVersion: 'v2' }, reader, [])).toBe(false);
  expect(newsChange(item, '2026-11-03T10:00:00Z', false)).toBe('updated');
  expect(newsChange(item, '2026-11-03T10:00:00Z', true)).toBeNull();
});
it('deduplicates canonical stories and retains real related report metadata', () => {
  const entries = newsStories([
    {
      scope: 'world',
      topic: 'Головне',
      items: [item, { ...item, url: 'https://suspilne.media/a', title: 'Інший матеріал' }],
      more: [],
    },
  ]);
  expect(entries).toHaveLength(1);
  expect(entries[0]?.item.related).toEqual([
    { title: 'Інший матеріал', url: 'https://suspilne.media/a', publishedAt: undefined },
  ]);
});
it('announces coverage or translation changes without changing the read version', () => {
  const groups = [{ scope: 'world' as const, topic: 'Головне', items: [item], more: [] }];
  expect(newsSnapshotKey(groups)).not.toBe(
    newsSnapshotKey([{ ...groups[0]!, items: [{ ...item, displayVersion: 'coverage-v2' }] }]),
  );
  expect(newsSnapshotKey(groups)).not.toBe(
    newsSnapshotKey([{ ...groups[0]!, items: [{ ...item, translationStatus: 'ready' }] }]),
  );
});
it('restores bounded reading controls and rejects malformed session preferences', () => {
  saveNewsView({
    mode: 'following',
    filter: 'new',
    topic: 'Наука',
    search: 'місія',
    scroll: 250,
    snapshot: 'v1',
    limit: 12,
  });
  expect(readNewsView()).toMatchObject({ mode: 'following', scroll: 250, search: 'місія' });
  sessionStorage.setItem(
    'svitanok:news-view:v2',
    JSON.stringify({ mode: 'bogus', scroll: -100, search: 3 }),
  );
  expect(readNewsView()).toMatchObject({ mode: 'main', scroll: 0, search: '' });
});
