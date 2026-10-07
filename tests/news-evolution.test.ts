import { expect, it } from 'vitest';
import { evolveNews } from '../web/core/brief/news-evolution.mjs';
const now = Date.parse('2026-10-07T12:00:00Z');
const group = (title = 'Подія', excerpt = 'Перше повідомлення') => [
  {
    items: [
      { url: 'https://www.bbc.com/news/a', title, originalTitle: 'Event', excerpt, why: excerpt },
    ],
  },
];
it('retains a stable story and timestamps across identical cycles and changed translations', async () => {
  const first = group();
  const history = await evolveNews(first, [], now);
  const next = group('Новий переклад');
  await evolveNews(next, history, now + 3600000);
  expect(next[0]?.items[0]).toMatchObject({
    storyId: history[0]?.storyId,
    firstSeenAt: history[0]?.firstSeenAt,
    updated: false,
  });
});
it('records source changes and preserves the comparison through the next unchanged refresh', async () => {
  const history = await evolveNews(group(), [], now);
  const next = group('Подія', 'Джерело повідомило нові подробиці');
  const updated = await evolveNews(next, history, now + 3600000);
  expect(next[0]?.items[0]).toMatchObject({
    updated: true,
    previousSummary: 'Перше повідомлення',
    changeLabel: 'Джерело оновило матеріал',
  });
  const unchanged = group('Подія', 'Джерело повідомило нові подробиці');
  await evolveNews(unchanged, updated, now + 7200000);
  expect(unchanged[0]?.items[0]).toMatchObject({
    previousSummary: 'Перше повідомлення',
    changeAt: new Date(now + 3600000).toISOString(),
  });
});
it('joins only previously established links and expires old history', async () => {
  const history = await evolveNews(group(), [], now);
  const related = [
    {
      items: [
        {
          title: 'Ще повідомлення',
          url: 'https://www.pravda.com.ua/a',
          related: [{ url: 'https://www.bbc.com/news/a' }],
        },
      ],
    },
  ];
  await evolveNews(related, history, now + 3600000);
  expect(related[0]?.items[0]).toMatchObject({
    storyId: history[0]?.storyId,
    changeLabel: 'Ще матеріал про цю подію',
  });
  const expired = await evolveNews([], history, now + 73 * 3600000);
  expect(expired).toEqual([]);
});
