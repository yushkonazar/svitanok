import type { Settings, SettingsPatch } from './settings-schema.ts';
import { DEFAULT_NEWS_SOURCES, canonicalNewsTopic } from '../../../core/brief/news-catalog.mjs';

export function mergeSettingsPatch(current: Settings, patch: SettingsPatch): Settings {
  const news: NonNullable<Settings['news']> = {
    sources: [...DEFAULT_NEWS_SOURCES] as NonNullable<Settings['news']>['sources'],
    intervalHours: 3 as const,
    ...current.news,
    ...patch.news,
  };
  if (patch.newsSource) {
    const { id, enabled } = patch.newsSource;
    news.sources = enabled
      ? ([...new Set([...news.sources, id])] as typeof news.sources)
      : news.sources.filter((source) => source !== id);
  }
  let mutedTopics = patch.mutedTopics ?? current.mutedTopics;
  if (patch.topic) {
    const { enabled } = patch.topic;
    const name = canonicalNewsTopic(patch.topic.name);
    const otherTopics = mutedTopics.filter((topic) => canonicalNewsTopic(topic) !== name);
    mutedTopics = enabled ? otherTopics : [...otherTopics, name];
  }
  return {
    ...current,
    quiet: { ...current.quiet, ...patch.quiet },
    modules: { ...current.modules, ...patch.modules },
    mutedTopics,
    ...(patch.checkin ? { checkin: patch.checkin } : {}),
    ...(current.news || patch.news || patch.newsSource ? { news } : {}),
  };
}
