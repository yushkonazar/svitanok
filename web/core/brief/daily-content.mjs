import { z } from 'zod';

import { CONTENT_TOPICS } from './daily-content-display.mjs';
export { CONTENT_TOPICS, contentIdentity, contentHash } from './daily-content-display.mjs';
export const CONTENT_AUTHORS = {
  Епіктет: true,
  'Марк Аврелій': true,
  Сенека: true,
  'Григорій Сковорода': false,
  'Леся Українка': false,
  'Іван Франко': false,
  Арістотель: false,
  'Мішель де Монтень': false,
  'Бенджамін Франклін': false,
  'Ральф Волдо Емерсон': false,
  'Генрі Девід Торо': false,
  'Леонардо да Вінчі': false,
};
export const CONTENT_DOMAINS = [
  'nasa.gov',
  'esa.int',
  'si.edu',
  'ocean.si.edu',
  'noaa.gov',
  'usgs.gov',
  'home.cern',
  'britannica.com',
  'loc.gov',
  'royalsociety.org',
  'nobelprize.org',
  'classics.mit.edu',
  'gutenberg.org',
  'uk.wikisource.org',
  'en.wikisource.org',
];
const excluded =
  /росі[яєюїй]|росій|russia|soviet|радян|срср|ussr|moscow|москв|кремл|kremlin|sputnik|спутник|супутник-1|gagarin|гагарін|толстой|достоєв|dostoev|tolstoy|pushkin|пушкін|chekhov|чехов/iu;
/** Fail closed for sources: exact approved hosts/subdomains, HTTPS, no credentials or ports.
 * @param {string} raw */
export function contentSourceAllowed(raw) {
  try {
    const url = new URL(raw);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      !excluded.test(decodeURIComponent(url.href)) &&
      CONTENT_DOMAINS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))
    );
  } catch {
    return false;
  }
}
/** @param {unknown} item */
export function contentExcluded(item) {
  return excluded.test(JSON.stringify(item));
}

const topic = z.enum(['space', 'nature', 'science', 'technology', 'history', 'culture', 'mind']);
const common = {
  id: z.string().min(3).max(140),
  semanticKey: z.string().min(5).max(140),
  topic,
  title: z.string().min(3).max(100),
  context: z.string().min(15).max(500),
  sourceUrl: z.string().url().refine(contentSourceAllowed),
  sourceName: z.string().min(2).max(80),
  evidence: z
    .string()
    .min(20)
    .max(220)
    .regex(/^[\s\S]{20,220}$/),
};
export const candidateFactSchema = z
  .object({ ...common, fact: z.string().min(40).max(550) })
  .strict();
export const candidateQuoteSchema = z
  .object({
    ...common,
    sourceUrl: z
      .string()
      .url()
      .refine(
        (raw) =>
          contentSourceAllowed(raw) &&
          [
            'classics.mit.edu',
            'www.gutenberg.org',
            'gutenberg.org',
            'uk.wikisource.org',
            'en.wikisource.org',
          ].includes(new URL(raw).hostname),
      ),
    text: z.string().min(20).max(400),
    author: z.enum(Object.keys(CONTENT_AUTHORS)),
    reference: z.string().min(3).max(160),
    translation: z.enum(['Український переклад', 'Власний український переказ']),
  })
  .strict();
export const candidatesSchema = z
  .object({
    facts: z.array(candidateFactSchema).max(42),
    quotes: z.array(candidateQuoteSchema).max(42),
  })
  .strict();
// A generation cannot opt out silently by returning empty arrays. Local item
// validation still rejects incomplete candidates individually afterward.
export const generationSchema = z
  .object({
    facts: z.array(candidateFactSchema).min(42).max(42),
    quotes: z.array(candidateQuoteSchema).min(42).max(42),
  })
  .strict();
export const factSchema = candidateFactSchema.extend({ verifiedAt: z.string() });
export const quoteSchema = candidateQuoteSchema.extend({ verifiedAt: z.string() });
export const batchSchema = z.object({
  version: z.literal(1),
  month: z.string().regex(/^\d{4}-\d{2}$/),
  generatedAt: z.string(),
  facts: z.array(factSchema).min(28).max(42),
  quotes: z.array(quoteSchema).min(28).max(42),
});
export const preferencesSchema = z
  .object({
    topics: z.array(topic).min(1).max(7),
  })
  .strict();
export const DEFAULT_CONTENT_PREFERENCES = { topics: Object.keys(CONTENT_TOPICS) };
/** @param {string} month */
export function monthDays(month) {
  const [year, number] = month.split('-').map(Number);
  return new Date(Date.UTC(year ?? 0, number ?? 0, 0)).getUTCDate();
}
/** @param {string} text */
export function normalizedContent(text) {
  return text
    .toLocaleLowerCase('uk')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
/** Catch renamed IDs, same work passage and near-identical paraphrases before LLM review.
 * @param {Record<string, any>} a @param {Record<string, any>} b */
export function contentRepeats(a, b) {
  if (a.id && a.id === b.id) return true;
  if (
    a.semanticKey &&
    b.semanticKey &&
    normalizedContent(a.semanticKey) === normalizedContent(b.semanticKey)
  )
    return true;
  if (a.author && a.author === b.author && a.reference === b.reference) return true;
  const ta = normalizedContent(a.fact ?? a.text ?? ''),
    tb = normalizedContent(b.fact ?? b.text ?? '');
  if (ta === tb) return true;
  const aa = new Set(ta.split(' ').filter((w) => w.length > 3)),
    bb = new Set(tb.split(' ').filter((w) => w.length > 3));
  const overlap = [...aa].filter((w) => bb.has(w)).length;
  return aa.size > 4 && overlap / (aa.size + bb.size - overlap) > 0.65;
}
/** Deterministic editorial order; preference only influences the NEXT queue.
 * @template {Record<string, any>} T @param {T[]} items @param {Record<string, any>} preferences */
export function diverseContent(items, preferences = DEFAULT_CONTENT_PREFERENCES) {
  const remaining = [...items],
    result = [];
  const counts = new Map();
  let lastTopic = '',
    lastAuthor = '';
  while (remaining.length) {
    const score = (/** @type {T} */ x) =>
      (x.topic === lastTopic ? 8 : 0) +
      (x.author && x.author === lastAuthor ? 6 : 0) +
      (counts.get(x.topic) ?? 0) * 2 +
      (preferences.topics?.includes(x.topic) ? 0 : 4);
    remaining.sort((a, b) => score(a) - score(b) || a.id.localeCompare(b.id));
    const item = remaining.shift();
    if (!item) break;
    result.push(item);
    lastTopic = item.topic;
    lastAuthor = item.author;
    counts.set(item.topic, (counts.get(item.topic) ?? 0) + 1);
  }
  return result;
}
/** Do not expose evidence or unpublished reserve items to the app.
 * @param {Record<string, any>} item @returns {Record<string, any>} */
export function publicContent(item) {
  const result = { ...item };
  delete result.evidence;
  delete result.semanticKey;
  return result;
}
