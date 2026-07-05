// news (consumer, §6). БЕЗ LLM: топ-N найсвіжіших із топ-фідів на категорію,
// клікабельний заголовок (лінк у слові, не «простирадло» URL). Дедуп проти
// показаних (state.shownNews, вікно dedupDays). Зберігаємо ПУБЛІЧНІ канонізовані
// URL без ключа (§19.4). Без квоти/латентності LLM — «звичний топ новин».

import type { Module, Block, Ctx } from '../core/types.js';
import type { AppConfig } from '../core/config.js';
import { canonicalizeUrl } from '../core/url.js';
import { escapeHtml, link } from '../core/telegram.js';

const NEWS_PRIORITY = 50;
const MAX_ITEMS_PER_FEED = 12; // свіжі кандидати; з них беремо perCategory не показаних
const EXTRA_MORE = 5; // запас заголовків на категорію для кнопки «Більше» у дашборді

// --- preferenceWeights (Phase B 👍/👎; кнопки оживуть із вебхуком) ---
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

// --- RSS/Atom парсинг (без залежностей) ---
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

type ShownNews = Record<string, string>; // canonicalUrl -> ISO date

interface PickedItem {
  title: string;
  url: string;
}

export const newsModule: Module<AppConfig> = {
  id: 'news',
  kind: 'consumer',
  enabled: (config) => config.modules.news.enabled,

  async run(ctx: Ctx<AppConfig>): Promise<Block | null> {
    const cfg = ctx.config.modules.news;
    const sources = cfg.sources;
    if (!sources || Object.keys(sources).length === 0) return null;

    const shown = ctx.state.get<ShownNews>('shownNews') ?? {};
    // Час — з інжектованого годинника (детерміновано в тестах, консистентно з todayKey).
    const dedupCutoff = ctx.clock.now().getTime() - cfg.dedupDays * 86400_000;
    const today = ctx.clock.todayKey();
    const nextShown: ShownNews = { ...shown };

    // preferenceWeights (👍/👎 з дашборда): вага категорії масштабує к-сть заголовків
    // і порядок. Недільний decay тягне ваги назад до 1.0 (§6.1).
    let weights = ctx.state.get<Weights>('preferenceWeights') ?? {};
    if (ctx.clock.isSunday()) {
      weights = applyWeeklyDecay(weights);
      ctx.state.set('preferenceWeights', weights);
    }
    const weightFor = (cat: string) => weights[cat] ?? 1.0;
    const countFor = (cat: string) =>
      Math.max(1, Math.min(MAX_ITEMS_PER_FEED, Math.round(cfg.perCategory * weightFor(cat))));

    // Улюблені категорії (вища вага) — вище й із більшою квотою.
    const categories = Object.entries(sources).sort((a, b) => weightFor(b[0]) - weightFor(a[0]));

    const groups: { category: string; items: PickedItem[]; more: PickedItem[] }[] = [];

    for (const [category, urls] of categories) {
      const quota = countFor(category);
      const settled = await Promise.allSettled(urls.map((u) => ctx.fetcher.fetch(u)));
      const seen = new Set<string>();
      const picked: PickedItem[] = [];
      const more: PickedItem[] = []; // запас для «Більше» у дашборді

      for (const r of settled) {
        if (picked.length >= quota && more.length >= EXTRA_MORE) break;
        if (r.status !== 'fulfilled') {
          ctx.log.warn(`news: фід впав (${category})`);
          continue;
        }
        for (const item of parseRss(r.value).slice(0, MAX_ITEMS_PER_FEED)) {
          if (picked.length >= quota && more.length >= EXTRA_MORE) break;
          const canon = canonicalizeUrl(item.url);
          if (seen.has(canon)) continue;
          const shownAt = shown[canon] ? Date.parse(shown[canon]!) : 0;
          if (shownAt && shownAt >= dedupCutoff) continue; // показували в вікні
          seen.add(canon);
          if (picked.length < quota) {
            picked.push({ title: item.title, url: canon });
            nextShown[canon] = today; // дедупимо лише показані в добірці
          } else {
            more.push({ title: item.title, url: canon }); // запас без дедупу
          }
        }
      }
      if (picked.length) groups.push({ category, items: picked, more });
    }

    if (groups.length === 0) return null;
    ctx.state.set('shownNews', nextShown);

    // summaryHtml: заголовок-лінк у слові; категорія — bold-підзаголовок.
    const summaryHtml = groups
      .map((g) => {
        const head = `<b>${escapeHtml(g.category)}</b>`;
        const lines = g.items.map((it) => `• ${link(it.url, it.title)}`).join('\n');
        return `${head}\n${lines}`;
      })
      .join('\n\n');

    // Плейн-фолбек (failNotify / без HTML): заголовки.
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

  // Phase B: 👍/👎 змінює preferenceWeights (оживе з вебхуком).
  async handleCallback(action: string, ctx: Ctx<AppConfig>): Promise<void> {
    const m = action.match(/^news:(up|down):(.+)$/);
    if (!m) return;
    const weights = ctx.state.get<Weights>('preferenceWeights') ?? {};
    ctx.state.set('preferenceWeights', applyVote(weights, m[2]!, m[1] as 'up' | 'down'));
  },
};
