export const NEWS_SOURCE_IDS: readonly [
  'Українська правда',
  'BBC',
  'Sky Sports',
  'HLTV',
  'The Guardian',
];
export const DEFAULT_NEWS_SOURCES: readonly ['Українська правда', 'BBC', 'Sky Sports', 'HLTV'];
export const NEWS_SOURCE_CATALOG: readonly { id: (typeof NEWS_SOURCE_IDS)[number]; hint: string }[];
export const NEWS_FEEDS: readonly {
  id: string;
  name: string;
  source: (typeof NEWS_SOURCE_IDS)[number];
  scope: 'ua' | 'world';
  topic: string;
  url: string;
}[];
