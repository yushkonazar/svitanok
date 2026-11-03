export function emptyNewsReader(): {
  following: Record<string, unknown>;
  mutedUntil: Record<string, string>;
  readVersions: Record<string, string[]>;
};
export interface NewsReaderItem {
  url: string;
  title: string;
  storyId?: string;
  contentVersion?: string;
  why?: string;
  publishedAt?: string;
  firstSeenAt?: string;
  changeAt?: string;
  priority?: number;
}
export interface NewsReaderState {
  following: Record<
    string,
    { followedAt: string; topic: string; scope: 'ua' | 'world'; item: NewsReaderItem }
  >;
  mutedUntil: Record<string, string>;
  readVersions: Record<string, string[]>;
}
export function normalizeNewsReader(value: unknown, nowMs?: number): NewsReaderState;
export function compactNewsItem(item: Record<string, unknown>): NewsReaderItem;
export function newsStoryId(item: { storyId?: string; url: string }): string;
export function newsStoryVersion(item: {
  contentVersion?: string;
  changeAt?: string;
  publishedAt?: string;
  url: string;
}): string;
export function applyNewsReaderAction(
  current: unknown,
  story: unknown,
  action: string,
  version: string | undefined,
  nowMs?: number,
): { ok: boolean; reader: NewsReaderState; error?: string };
