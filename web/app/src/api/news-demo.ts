import { SAMPLE_NEWS } from './news-preview.ts';
import { newsReaderSchema, type NewsSnapshot } from './briefing-schema.ts';
import { emptyNewsReader, applyNewsReaderAction } from '../../../core/brief/news-reader.mjs';
const key = 'svitanok:news-reader:demo:v1';
function reader() {
  try {
    return newsReaderSchema.parse(JSON.parse(localStorage.getItem(key) ?? '{}'));
  } catch {
    return newsReaderSchema.parse(emptyNewsReader());
  }
}
export function newsDemoSnapshot(): NewsSnapshot {
  return {
    groups: structuredClone(SAMPLE_NEWS),
    generatedAt: '2026-10-04T08:00:00Z',
    attemptedAt: '2026-10-04T08:00:00Z',
    sources: [{ name: 'Демо', ok: true }],
    reader: reader(),
  };
}
export function newsDemoStory(storyId: string, action: string, version?: string) {
  const state = reader(),
    story =
      SAMPLE_NEWS.flatMap((g) =>
        g.items.map((item) => ({ scope: g.scope, topic: g.topic, item })),
      ).find((n) => (n.item.storyId ?? n.item.url) === storyId) ?? state.following[storyId];
  if (!story) throw new Error('Демо-подію не знайдено');
  const result = applyNewsReaderAction(state, story, action, version);
  if (!result.ok) throw new Error(result.error);
  const next = newsReaderSchema.parse(result.reader);
  try {
    localStorage.setItem(key, JSON.stringify(next));
  } catch {
    /* Session data remains usable. */
  }
  return { ok: true, demo: true, reader: next };
}
