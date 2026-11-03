import { expect, it } from 'vitest';
import { evolveNews } from '../web/core/brief/news-evolution.mjs';
const now = Date.parse('2026-10-07T12:00:00Z');
it('does not advance a read version for formatting or another publisher without new facts', async () => {
  const first = group('Подія', 'Джерело повідомило 12,5% зростання.');
  const history = await evolveNews(first, [], now);
  const punctuation = group('Подія', 'Джерело повідомило: 12.5% зростання!');
  const unchanged = await evolveNews(punctuation, history, now + 60000);
  expect(unchanged[0]?.contentVersion).toBe(history[0]?.contentVersion);
  const coverage = [
    {
      items: [
        {
          title: 'Інше видання про ту саму подію',
          url: 'https://example.test/other',
          historyStoryId: history[0]?.storyId,
          sourceExcerpt: 'Ще один опис тієї самої інформації.',
          development: false,
        },
      ],
    },
  ];
  const linked = await evolveNews(coverage, unchanged, now + 120000);
  expect(linked[0]).toMatchObject({
    storyId: history[0]?.storyId,
    contentVersion: history[0]?.contentVersion,
    changeAt: history[0]?.changeAt,
    changeKind: 'coverage',
  });
});
it('advances a version for new numeric facts but accepts the editor verdict for a cosmetic rewrite', async () => {
  const history = await evolveNews(group('Подія', 'Джерело повідомило про 50 виплат'), [], now);
  const rewritten = [
    {
      items: [
        {
          ...group()[0]!.items[0],
          sourceExcerpt: 'Повідомлено про ті самі 50 виплат',
          development: false,
        },
      ],
    },
  ];
  const cosmetic = await evolveNews(rewritten, history, now + 60000);
  expect(cosmetic[0]?.contentVersion).toBe(history[0]?.contentVersion);
  const actual = await evolveNews(
    group('Подія', 'Джерело повідомило про 60 виплат'),
    cosmetic,
    now + 120000,
  );
  expect(actual[0]?.contentVersion).not.toBe(history[0]?.contentVersion);
  expect(actual[0]?.changeKind).toBe('facts');
});
it('retains followed public history for thirty days while expiring ordinary history after seventy-two hours', async () => {
  const history = await evolveNews(group(), [], now),
    id = history[0]?.storyId;
  expect(await evolveNews([], history, now + 4 * 86400000, { followed: [id] })).toHaveLength(1);
  expect(await evolveNews([], history, now + 31 * 86400000, { followed: [id] })).toEqual([]);
});
it('bounds multibyte history by bytes as well as article count', async () => {
  const history = Array.from({ length: 300 }, (_, i) => ({
    storyId: String(i),
    urls: [`https://example.test/${i}`],
    observedAt: new Date(now).toISOString(),
    summary: 'ї'.repeat(10000),
  }));
  const result = await evolveNews([], history, now);
  expect(result.length).toBeLessThan(300);
  expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThanOrEqual(512 * 1024);
});
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
