import type { NewsGroup } from '../api/briefing-schema.ts';
import { newsSource } from './newsSource.ts';
import { isReleaseTopic } from './topicKind.ts';
export function newsFeed(groups: NewsGroup[], muted: string[] = [], sources?: string[]) {
  const aliases: Record<string, string> = {
    CS2: 'Кіберспорт',
    'Винаходи й технології': 'Тех/IT',
    Головне: 'Світ',
  };
  const seen = new Set<string>();
  return groups
    .filter(
      (g) =>
        !muted.includes(g.topic) &&
        !muted.includes(aliases[g.topic] ?? g.topic) &&
        !isReleaseTopic(g.topic),
    )
    .flatMap((g) =>
      [...g.items, ...g.more].map((item) => ({
        item,
        topic: g.topic,
        priority: item.priority ?? (g.scope === 'ua' || g.topic === 'Головне' ? 0 : 1),
      })),
    )
    .filter(({ item }) => {
      if (
        sources &&
        !sources.some(
          (name) => newsSource(item.url) === (name === 'The Guardian' ? 'Guardian' : name),
        )
      )
        return false;
      if (seen.has(item.url)) return false;
      seen.add(item.url);
      return true;
    })
    .sort(
      (a, b) =>
        a.priority - b.priority ||
        (a.item.rank ?? 1000) - (b.item.rank ?? 1000) ||
        (Date.parse(b.item.publishedAt ?? '') || 0) - (Date.parse(a.item.publishedAt ?? '') || 0),
    );
}
