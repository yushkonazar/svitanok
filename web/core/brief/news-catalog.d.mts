export const NEWS_SOURCE_IDS: readonly [
  'Українська правда',
  'BBC',
  'Sky Sports',
  'HLTV',
  'The Guardian',
  'Суспільне',
  'DOU',
  'NASA',
];
export const NEWS_CATALOG_VERSION: number;
export const DEFAULT_NEWS_SOURCES: readonly (typeof NEWS_SOURCE_IDS)[number][];
export const LEGACY_NEWS_SOURCES: readonly string[];
export const NEWS_SOURCE_CATALOG: readonly { id: (typeof NEWS_SOURCE_IDS)[number]; hint: string }[];
export const NEWS_FEEDS: readonly {
  id: string;
  name: string;
  source: (typeof NEWS_SOURCE_IDS)[number];
  scope: 'ua' | 'world';
  topic: string;
  url: string;
  language?: string;
}[];

export function canonicalNewsTopic(topic: string): string;
