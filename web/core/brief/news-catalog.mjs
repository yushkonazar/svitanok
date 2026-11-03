// One small, shared catalogue for RSS collection and Mini App settings.
export const NEWS_CATALOG_VERSION = 5;
export const NEWS_SOURCE_IDS = [
  'Українська правда',
  'BBC',
  'Sky Sports',
  'HLTV',
  'The Guardian',
  'Суспільне',
  'DOU',
  'NASA',
];
export const LEGACY_NEWS_SOURCES = ['Українська правда', 'BBC', 'Sky Sports', 'HLTV'];
export const DEFAULT_NEWS_SOURCES = [...NEWS_SOURCE_IDS];
export const NEWS_SOURCE_CATALOG = [
  { id: 'Українська правда', hint: 'Україна: головні суспільні події' },
  { id: 'BBC', hint: 'Світ, наука та технології' },
  { id: 'Sky Sports', hint: 'Футбол: збірні, клуби й турніри' },
  { id: 'HLTV', hint: 'Counter-Strike 2 та кіберспорт' },
  { id: 'The Guardian', hint: 'Світ: міжнародні події та ширший контекст' },
  { id: 'Суспільне', hint: 'Україна: друге видання з власною редакцією' },
  { id: 'DOU', hint: 'Українські технології та IT-спільнота' },
  { id: 'NASA', hint: 'Наука й космос: повідомлення першоджерела' },
];
export const NEWS_FEEDS = [
  {
    id: 'bbc-world',
    name: 'BBC',
    source: 'BBC',
    scope: 'world',
    topic: 'Головне',
    url: 'https://feeds.bbci.co.uk/news/world/rss.xml',
  },
  {
    id: 'bbc-tech',
    name: 'BBC Technology',
    source: 'BBC',
    scope: 'world',
    topic: 'Винаходи й технології',
    url: 'https://feeds.bbci.co.uk/news/technology/rss.xml',
  },
  {
    id: 'bbc-science',
    name: 'BBC Science',
    source: 'BBC',
    scope: 'world',
    topic: 'Наука',
    url: 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml',
  },
  {
    id: 'hltv',
    name: 'HLTV',
    source: 'HLTV',
    scope: 'world',
    topic: 'CS2',
    url: 'https://www.hltv.org/rss/news',
  },
  {
    id: 'sky-football',
    name: 'Sky Sports',
    source: 'Sky Sports',
    scope: 'world',
    topic: 'Футбол',
    url: 'https://www.skysports.com/rss/11095',
  },
  {
    id: 'pravda-ua',
    name: 'Українська правда',
    source: 'Українська правда',
    scope: 'ua',
    topic: 'Україна',
    url: 'https://www.pravda.com.ua/rss/',
  },
  {
    id: 'guardian-world',
    name: 'The Guardian',
    source: 'The Guardian',
    scope: 'world',
    topic: 'Головне',
    url: 'https://www.theguardian.com/world/rss',
  },
  {
    id: 'suspilne',
    name: 'Суспільне',
    source: 'Суспільне',
    scope: 'ua',
    topic: 'Україна',
    language: 'uk',
    url: 'https://suspilne.media/rss/all.rss',
  },
  {
    id: 'dou',
    name: 'DOU',
    source: 'DOU',
    scope: 'world',
    topic: 'Винаходи й технології',
    language: 'uk',
    url: 'https://dou.ua/feed/',
  },
  {
    id: 'nasa',
    name: 'NASA',
    source: 'NASA',
    scope: 'world',
    topic: 'Наука',
    url: 'https://www.nasa.gov/feed/',
  },
];

/** Legacy labels refer to the same topic, not independent toggles. */
const TOPIC_ALIASES = { Світ: 'Головне', Кіберспорт: 'CS2', 'Тех/IT': 'Винаходи й технології' };
/** @param {string} topic @returns {string} */
export function canonicalNewsTopic(topic) {
  return /** @type {Record<string,string>} */ (TOPIC_ALIASES)[topic] ?? topic;
}
