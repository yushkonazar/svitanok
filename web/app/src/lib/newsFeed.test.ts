import { expect, it } from 'vitest';
import { newsFeed } from './newsFeed.ts';
it('keeps world and Ukraine ahead of newer football in legacy and editorial snapshots', () => {
  const groups = [
    {
      scope: 'world' as const,
      topic: 'Футбол',
      items: [
        {
          title: 'Футбол',
          url: 'https://www.skysports.com/a',
          publishedAt: '2026-10-06T12:00:00Z',
        },
      ],
      more: [],
    },
    {
      scope: 'world' as const,
      topic: 'Головне',
      items: [
        { title: 'Світ', url: 'https://www.bbc.com/news/a', publishedAt: '2026-10-06T10:00:00Z' },
      ],
      more: [],
    },
    {
      scope: 'ua' as const,
      topic: 'Україна',
      items: [
        {
          title: 'Україна',
          url: 'https://www.pravda.com.ua/news/a',
          publishedAt: '2026-10-06T11:00:00Z',
        },
      ],
      more: [],
    },
  ];
  expect(newsFeed(groups).map((n) => n.item.title)).toEqual(['Україна', 'Світ', 'Футбол']);
  expect(newsFeed(groups, ['Світ']).map((n) => n.item.title)).toEqual(['Україна', 'Футбол']);
});
