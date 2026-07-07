// news (consumer). NewsData.io: теми scope(world/ua)×category, language=uk (укр-
// контент і для світу; датацентр-дружній API — знімає 403 на .ua). Групи
// {scope,topic,items[{title,url,why?}],more} для дашборда (таб Новини: под-таби
// 🌍/🇺🇦 × теми). Дедуп проти показаних (state.shownNews). Ваги 👍/👎 масштабують
// квоту й порядок тем. `parseRss`/`RssItem` лишаються — їх юзає jobs.

import type { Module, Block, Ctx } from '../core/types.js';
import type { AppConfig } from '../core/config.js';
import { canonicalizeUrl } from '../core/url.js';
import { escapeHtml, link } from '../core/telegram.js';
import { optionalSecret } from '../core/secrets.js';

const NEWS_PRIORITY = 50;
const EXTRA_MORE = 5; // запас заголовків на тему для кнопки «Більше» у дашборді
const WHY_MAX = 140;

// --- preferenceWeights (👍/👎 з дашборда) ---
export const WEIGHT_MIN = 0.5;
export const WEIGHT_MAX = 2.0;
const WEIGHT_STEP = 0.15;

export type Weights = Record<string, number>;

const clampWeight = (w: number) => Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, w));

export function applyVote(weights: Weights, category: string, dir: 'up' | 'down'): Weights {
  const cur = weights[category] ?? 1.0;
  const next = clampWeight(cur + (dir === 'up' ? WEIGHT_STEP : -WEIGHT_STEP));
  return { ...weights, [category]: next };
}

/** Тижневий decay до 1.0 (§6.1): w += (1.0 - w) * 0.1. */
export function applyWeeklyDecay(weights: Weights): Weights {
  const out: Weights = {};
  for (const [k, w] of Object.entries(weights)) out[k] = clampWeight(w + (1.0 - w) * 0.1);
  return out;
}

// --- RSS/Atom парсинг (без залежностей) — використовує jobs ---
const stripCdata = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export interface RssItem {
  title: string;
  url: string;
}

export function parseRss(xml: string): RssItem[] {
  const out: RssItem[] = [];
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) ?? [];
  for (const b of blocks) {
    const rawTitle = b.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '';
    let url = (b.match(/<link[^>]*>([\s\S]*?)<\/link>/i)?.[1] ?? '').trim();
    if (!url) url = b.match(/<link[^>]*href=["']([^"']+)["']/i)?.[1] ?? ''; // Atom
    const title = decodeXml(stripCdata(rawTitle)).trim();
    url = decodeXml(stripCdata(url)).trim();
    if (title && url) out.push({ title, url });
  }
  return out;
}

// --- NewsData.io ---
export interface NewsItem {
  title: string;
  url: string;
  why?: string;
}

/** Розпарсити відповідь NewsData (results[]) у наші айтеми. */
export function parseNewsData(json: unknown): NewsItem[] {
  const results = (json as { results?: unknown[] })?.results;
  if (!Array.isArray(results)) return [];
  const out: NewsItem[] = [];
  for (const r of results) {
    const o = r as { title?: unknown; link?: unknown; description?: unknown };
    if (
      typeof o.title === 'string' &&
      typeof o.link === 'string' &&
      o.title.trim() &&
      o.link.trim()
    ) {
      const why =
        typeof o.description === 'string' && o.description.trim()
          ? o.description.trim().slice(0, WHY_MAX)
          : undefined;
      out.push({ title: o.title.trim(), url: o.link.trim(), why });
    }
  }
  return out;
}

interface TopicCfg {
  scope: 'world' | 'ua';
  topic: string;
  category: string;
  country?: string;
  language: string;
}

function buildNewsUrl(apiKey: string, t: TopicCfg): string {
  const u = new URL('https://newsdata.io/api/1/latest');
  u.searchParams.set('apikey', apiKey);
  u.searchParams.set('category', t.category);
  u.searchParams.set('language', t.language);
  if (t.country) u.searchParams.set('country', t.country);
  return u.toString();
}

type ShownNews = Record<string, string>; // canonicalUrl -> ISO date
interface Group {
  scope: 'world' | 'ua';
  topic: string;
  items: NewsItem[];
  more: NewsItem[];
}

export interface NewsModuleOptions {
  fetchImpl?: typeof fetch;
  apiKey?: string;
  timeoutMs?: number;
}

export function createNewsModule(opts: NewsModuleOptions = {}): Module<AppConfig> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30000;

  return {
    id: 'news',
    kind: 'consumer',
    enabled: (config) => config.modules.news.enabled,

    async run(ctx: Ctx<AppConfig>): Promise<Block | null> {
      const cfg = ctx.config.modules.news;
      const apiKey = opts.apiKey ?? optionalSecret('NEWSDATA_API_KEY');
      if (!apiKey || cfg.topics.length === 0) {
        ctx.log.warn('news: NEWSDATA_API_KEY або topics відсутні — пропуск');
        return null;
      }

      const shown = ctx.state.get<ShownNews>('shownNews') ?? {};
      const dedupCutoff = ctx.clock.now().getTime() - cfg.dedupDays * 86400_000;
      const today = ctx.clock.todayKey();
      const nextShown: ShownNews = { ...shown };

      // preferenceWeights: вага теми масштабує квоту й порядок. Недільний decay -> 1.0.
      let weights = ctx.state.get<Weights>('preferenceWeights') ?? {};
      if (ctx.clock.isSunday()) {
        weights = applyWeeklyDecay(weights);
        ctx.state.set('preferenceWeights', weights);
      }
      const weightFor = (t: string) => weights[t] ?? 1.0;
      const quotaFor = (t: string) =>
        Math.max(1, Math.min(cfg.perTopic + EXTRA_MORE, Math.round(cfg.perTopic * weightFor(t))));

      // Улюблені теми (вища вага) — вище.
      const topics = [...cfg.topics].sort((a, b) => weightFor(b.topic) - weightFor(a.topic));

      const runSeen = new Set<string>(); // глобальний дедуп прогону: без повторів між темами
      const groups: Group[] = [];
      for (const t of topics) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        let items: NewsItem[];
        try {
          const res = await fetchImpl(buildNewsUrl(apiKey, t as TopicCfg), { signal: ctrl.signal });
          if (!res.ok) throw new Error(`NewsData HTTP ${res.status}`);
          items = parseNewsData(await res.json());
        } catch (e) {
          ctx.log.warn(`news: тема «${t.topic}» — ${e instanceof Error ? e.message : String(e)}`);
          continue;
        } finally {
          clearTimeout(timer);
        }

        const quota = quotaFor(t.topic);
        const picked: NewsItem[] = [];
        const more: NewsItem[] = [];
        for (const it of items) {
          if (picked.length >= quota && more.length >= EXTRA_MORE) break;
          const canon = canonicalizeUrl(it.url);
          if (runSeen.has(canon)) continue; // уже взято в іншій темі цього прогону
          const shownAt = shown[canon] ? Date.parse(shown[canon]!) : 0;
          if (shownAt && shownAt >= dedupCutoff) continue; // показували в вікні
          runSeen.add(canon);
          const entry: NewsItem = { title: it.title, url: canon, why: it.why };
          if (picked.length < quota) {
            picked.push(entry);
            nextShown[canon] = today;
          } else {
            more.push(entry);
          }
        }
        if (picked.length) groups.push({ scope: t.scope, topic: t.topic, items: picked, more });
      }

      if (groups.length === 0) return null;
      ctx.state.set('shownNews', nextShown);

      const summaryHtml = groups
        .map((g) => {
          const head = `<b>${escapeHtml(g.topic)}</b>`;
          const lines = g.items.map((it) => `• ${link(it.url, it.title)}`).join('\n');
          return `${head}\n${lines}`;
        })
        .join('\n\n');
      const summary = groups.flatMap((g) => g.items.map((it) => it.title)).join('\n');

      return {
        id: 'news',
        title: 'Новини',
        icon: '🗞',
        summary,
        summaryHtml,
        data: { groups },
        inMessage: false, // глибина — в дашборді; повідомлення лаконічне
        priority: NEWS_PRIORITY,
      };
    },

    // 👍/👎 змінює preferenceWeights теми (через дашборд /api/vote або in-chat callback).
    async handleCallback(action: string, ctx: Ctx<AppConfig>): Promise<void> {
      const m = action.match(/^news:(up|down):(.+)$/);
      if (!m) return;
      const weights = ctx.state.get<Weights>('preferenceWeights') ?? {};
      ctx.state.set('preferenceWeights', applyVote(weights, m[2]!, m[1] as 'up' | 'down'));
    },
  };
}
