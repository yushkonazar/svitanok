// news (consumer). NewsData.io: теми scope(world/ua)×category, language=uk (укр-
// контент і для світу; датацентр-дружній API — знімає 403 на .ua). Групи
// {scope,topic,items[{title,url,why?}],more} для дашборда (таб Новини: под-таби
// 🌍/🇺🇦 × теми). Дедуп проти показаних (state.shownNews). Ваги 👍/👎 масштабують
// квоту й порядок тем. `parseRss`/`RssItem` лишаються — їх юзає jobs.

import type { Module, Block, Ctx } from '../core/types.js';
import type { AppConfig } from '../core/config.js';
import { canonicalizeUrl, isHttpUrl } from '../core/url.js';
import { escapeHtml, link } from '../core/telegram.js';
import { optionalSecret } from '../core/secrets.js';

const NEWS_PRIORITY = 50;
const EXTRA_MORE = 5; // запас заголовків на тему для кнопки «Більше» у дашборді
const WHY_MAX = 140;

// Денний ліміт запитів NewsData (SL4) — за зразком weather.ts DAILY_REQUEST_LIMIT.
// Free-тариф = 200 кредитів/добу (1 кредит = 1 запит = 1 тема). Норма ~6/добу;
// навіть максимум форс-ранів (кулдаун /brief 1/год -> ~25 ранів × 6 ≈ 150) під
// цим капом. Тобто це запобіжник від рант-аут-циклів + буфер під 200, а не
// обмежувач нормального використання.
export const DAILY_NEWS_LIMIT = 180;

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

// --- votedUrls: чесний облік голосів per-url (C3) ---
// Раніше кожен клік 👍/👎 безмежно штовхав вагу теми (applyVote на кожен клік без
// дедупу), а клієнтський toggle-off був лише CSS — сервер уже двічі порахував.
// Тепер памʼятаємо голос по url: {dir, category, delta}. Повторний той самий
// голос = зняти (toggle-off), зміна = переставити. Кожен url впливає на вагу
// максимум раз.
//
// `delta` — РЕАЛЬНО застосований зсув ваги (після clamp), а не номінальні ±0.15
// (ревʼю C): біля межі [0.5,2.0] голос міг бути no-op'ом (вага вже на дні), і
// відкат «повного» кроку тягнув би вагу в ПРОТИЛЕЖНИЙ бік (dislike -> boost).
// Відкочуємо саме те, що додали -> голос точно оборотний.
export type VoteDir = 'up' | 'down';
export type VotedUrls = Record<string, { dir: VoteDir; category: string; delta: number }>;

const stepFor = (d: VoteDir): number => (d === 'up' ? WEIGHT_STEP : -WEIGHT_STEP);

export interface UrlVoteResult {
  weights: Weights;
  votedUrls: VotedUrls;
  prevDir: VoteDir | null; // що було на цьому url
  prevCategory: string | null; // під якою темою був попередній голос (для інтересу)
  newDir: VoteDir | null; // що стало (null = знято)
}

/** Застосувати зсув до ваги теми з clamp; повернути {weights, delta(реальний)}. */
function bumpWeight(
  weights: Weights,
  category: string,
  step: number,
): { weights: Weights; delta: number } {
  const before = weights[category] ?? 1.0;
  const after = clampWeight(before + step);
  return { weights: { ...weights, [category]: after }, delta: after - before };
}

/**
 * Застосувати клік по url у напрямку clickedDir:
 *  - відкотити попередній голос цього url на РІВНО стільки, скільки він додав;
 *  - якщо clickedDir збігається з попереднім -> зняти (toggle-off), інакше поставити.
 */
export function applyUrlVote(
  weights: Weights,
  votedUrls: VotedUrls | undefined,
  url: string,
  category: string,
  clickedDir: VoteDir,
): UrlVoteResult {
  const vu: VotedUrls = votedUrls && typeof votedUrls === 'object' ? { ...votedUrls } : {};
  const prev = vu[url];
  let w = weights ?? {};

  // 1) відкотити попередній ефект — саме записаний delta (не номінальний крок).
  if (prev && typeof prev.delta === 'number' && prev.delta !== 0) {
    const cat = prev.category ?? category;
    w = { ...w, [cat]: clampWeight((w[cat] ?? 1.0) - prev.delta) };
  }
  // 2) той самий клік по активному -> зняти; інакше поставити новий.
  const newDir: VoteDir | null = prev && prev.dir === clickedDir ? null : clickedDir;
  if (newDir) {
    const r = bumpWeight(w, category, stepFor(newDir));
    w = r.weights;
    vu[url] = { dir: newDir, category, delta: r.delta };
  } else {
    delete vu[url];
  }
  return {
    weights: w,
    votedUrls: vu,
    prevDir: prev?.dir ?? null,
    prevCategory: prev?.category ?? null,
    newDir,
  };
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
  publishedAt?: string;
}

/** RSS <pubDate> чи Atom <published>/<updated> -> ISO, або undefined на непарсибельне/відсутнє. */
function parseFeedDate(block: string): string | undefined {
  const raw = block.match(/<(pubDate|published|updated)[^>]*>([\s\S]*?)<\/\1>/i)?.[2] ?? '';
  if (!raw) return undefined;
  const ms = Date.parse(decodeXml(stripCdata(raw)).trim());
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
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
    if (title && url && isHttpUrl(url)) out.push({ title, url, publishedAt: parseFeedDate(b) }); // лише http(s) (M2)
  }
  return out;
}

// --- NewsData.io ---
export interface NewsItem {
  title: string;
  url: string;
  why?: string;
  publishedAt?: string;
}

/**
 * NewsData's pubDate — документовано як UTC у форматі "YYYY-MM-DD HH:mm:ss",
 * БЕЗ позначки таймзони. Date.parse на такому рядку читає його як ЛОКАЛЬНИЙ
 * час (V8/Node) — на GitHub Actions runner'і (UTC) сьогодні це no-op, але
 * пастка, якщо середовище колись зміниться. Явно доклеюємо 'Z', якщо позначки
 * зони нема.
 */
function parseNewsDataDate(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const s = raw.trim();
  const iso = /[Zz]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** Розпарсити відповідь NewsData (results[]) у наші айтеми. */
export function parseNewsData(json: unknown): NewsItem[] {
  const results = (json as { results?: unknown[] })?.results;
  if (!Array.isArray(results)) return [];
  const out: NewsItem[] = [];
  for (const r of results) {
    const o = r as { title?: unknown; link?: unknown; description?: unknown; pubDate?: unknown };
    if (
      typeof o.title === 'string' &&
      typeof o.link === 'string' &&
      o.title.trim() &&
      o.link.trim() &&
      isHttpUrl(o.link.trim()) // лише http(s) (M2)
    ) {
      // stripCdata/decodeXml (той самий, що parseRss нижче): NewsData інколи
      // повертає description, лишений НЕОБРОБЛЕНИМ від оригінальної RSS-стрічки
      // видавця — <![CDATA[...]]>/XML-сутності просвічували в why як є.
      const why =
        typeof o.description === 'string' && o.description.trim()
          ? decodeXml(stripCdata(o.description.trim())).trim().slice(0, WHY_MAX)
          : undefined;
      const publishedAt = parseNewsDataDate(o.pubDate);
      out.push({ title: o.title.trim(), url: o.link.trim(), why, publishedAt });
    }
  }
  return out;
}

interface TopicCfg {
  scope: 'world' | 'ua';
  topic: string;
  /** 'rss' — довільна стрічка (HN, GitHub Releases), НЕ витрачає кредит NewsData. */
  source?: 'newsdata' | 'rss';
  url?: string;
  category?: string;
  /** Пошук за словами — для тем, яких немає в переліку категорій NewsData. */
  q?: string;
  country?: string;
  language: string;
  /** Кастомні заголовки фетчу (лише rss) — напр. User-Agent для джерел за
   *  bot-захистом (HLTV: 403 з мінімальним UA, 200 з повним браузерним). */
  headers?: Record<string, string>;
  /** Лишити лише title, що матчить regex — фільтр шуму монорепо-стрічок
   *  релізів (Vite/Cloudflare Workers SDK мішають core-теги з саб-пакетами). */
  includePattern?: string;
  /** Викинути title, що матчить regex — напр. beta/rc-теги PostgreSQL. */
  excludePattern?: string;
}

/**
 * URL теми. `category` і `q` — обидва опційні, але конфіг-схема вимагає хоч одне
 * (тема без обох звелась би до «віддай усе підряд»). Разом вони звужують: q
 * ставимо самотньо там, де категорії просто не існує (оборона/фронт).
 */
export function buildNewsUrl(apiKey: string, t: TopicCfg): string {
  const u = new URL('https://newsdata.io/api/1/latest');
  u.searchParams.set('apikey', apiKey);
  if (t.category) u.searchParams.set('category', t.category);
  if (t.q) u.searchParams.set('q', t.q);
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
      // rss-теми (HN/GitHub) ключа не потребують — без NEWSDATA_API_KEY модуль
      // не мовчить цілком, а віддає те, що дістає зі стрічок.
      const hasRss = cfg.topics.some((t) => (t as TopicCfg).source === 'rss');
      if (cfg.topics.length === 0 || (!apiKey && !hasRss)) {
        ctx.log.warn('news: NEWSDATA_API_KEY або topics відсутні — пропуск');
        return null;
      }
      if (!apiKey) ctx.log.warn('news: без NEWSDATA_API_KEY — лише rss-теми');

      const shown = ctx.state.get<ShownNews>('shownNews') ?? {};
      const dedupCutoff = ctx.clock.now().getTime() - cfg.dedupDays * 86400_000;
      const today = ctx.clock.todayKey();
      const nextShown: ShownNews = { ...shown };

      // Денний лічильник запитів NewsData (SL4, скид на нову добу) — той самий
      // патерн, що weatherRequests. Захищає free-тариф 200/добу від форс-спаму.
      const storedNews = ctx.state.get<{ date: string; count: number }>('newsRequests');
      const newsCounter =
        storedNews && storedNews.date === today ? { ...storedNews } : { date: today, count: 0 };
      let newsLimitHit = false;

      // preferenceWeights: вага теми масштабує квоту й порядок. Недільний decay -> 1.0.
      //
      // ⚠️ Мітка дня обовʼязкова: isSunday() — чиста функція годинника, без жодної
      // памʼяті. Без неї КОЖЕН ран у неділю декаїв наново, а `workflow_dispatch`
      // із force саме для того й існує, щоб ганяти ран повторно (напр. дебажиш,
      // чому не прийшли новини). Три форс-рани -> 0.5 → 0.55 → 0.595 → 0.6355:
      // твої ❤️ розмивались утричі швидше, ніж «раз на тиждень» за задумом.
      let weights = ctx.state.get<Weights>('preferenceWeights') ?? {};
      if (ctx.clock.isSunday() && ctx.state.get<string>('lastDecayDate') !== today) {
        weights = applyWeeklyDecay(weights);
        ctx.state.set('preferenceWeights', weights);
        ctx.state.set('lastDecayDate', today);
      }
      const weightFor = (t: string) => weights[t] ?? 1.0;
      const quotaFor = (t: string) =>
        Math.max(1, Math.min(cfg.perTopic + EXTRA_MORE, Math.round(cfg.perTopic * weightFor(t))));

      // Улюблені теми (вища вага) — вище.
      const topics = [...cfg.topics].sort((a, b) => weightFor(b.topic) - weightFor(a.topic));

      const runSeen = new Set<string>(); // глобальний дедуп прогону: без повторів між темами
      // Map, а не масив: кілька рядків TopicCfg тепер свідомо ділять одну (scope,
      // topic) пару (напр. «Наука» = NewsData + BBC Science + Guardian Science) —
      // без злиття фронтенд намалював би дублікат-плитку на той самий топік.
      // Дедуп (runSeen) і вага/квота (weightFor/quotaFor) уже коректні для
      // мерджу без змін — обидва ключуються лише за іменем теми, не за рядком
      // конфіга. Однойменні рядки декларувати ПОРЯД у config.yml — сортування
      // за вагою стабільне, тож порядок мерджу передбачуваний лише тоді.
      const groupsByKey = new Map<string, Group>();
      for (const t of topics) {
        const cfgT = t as TopicCfg;
        const isRss = cfgT.source === 'rss';
        // Кредит NewsData витрачають ЛИШЕ newsdata-теми. Понад денний ліміт їх
        // пропускаємо (continue, не break) — rss-теми (HN/GitHub) коштують нуль
        // кредитів, тож мають добігти навіть коли ліміт вичерпано.
        let url: string;
        if (isRss) {
          url = cfgT.url as string;
        } else {
          if (!apiKey) continue; // без ключа лишаються тільки стрічки
          if (newsCounter.count >= DAILY_NEWS_LIMIT) {
            newsLimitHit = true;
            continue;
          }
          newsCounter.count++;
          url = buildNewsUrl(apiKey, cfgT);
        }
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        let items: NewsItem[];
        try {
          const res = await fetchImpl(url, {
            signal: ctrl.signal,
            ...(isRss && cfgT.headers ? { headers: cfgT.headers } : {}),
          });
          if (!res.ok) throw new Error(`${isRss ? 'RSS' : 'NewsData'} HTTP ${res.status}`);
          // parseRss дає {title,url} без опису — `why` у стрічок просто немає.
          items = isRss ? parseRss(await res.text()) : parseNewsData(await res.json());
          // Фільтр шуму ДО дедуп/квота-циклу — монорепо-стрічки релізів
          // (Vite/Cloudflare Workers SDK) мішають core-теги з саб-пакетами.
          if (cfgT.includePattern) {
            const re = new RegExp(cfgT.includePattern, 'i');
            items = items.filter((it) => re.test(it.title));
          }
          if (cfgT.excludePattern) {
            const re = new RegExp(cfgT.excludePattern, 'i');
            items = items.filter((it) => !re.test(it.title));
          }
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
          const entry: NewsItem = {
            title: it.title,
            url: canon,
            why: it.why,
            publishedAt: it.publishedAt,
          };
          if (picked.length < quota) {
            picked.push(entry);
            nextShown[canon] = today;
          } else {
            more.push(entry);
          }
        }
        if (picked.length) {
          const key = `${t.scope} ${t.topic}`;
          const existing = groupsByKey.get(key);
          if (existing) {
            existing.items.push(...picked);
            existing.more.push(...more);
          } else {
            groupsByKey.set(key, { scope: t.scope, topic: t.topic, items: picked, more });
          }
        }
      }

      // Персист лічильника ЗАВЖДИ (кредити витрачено навіть коли нічого не взято).
      ctx.state.set('newsRequests', newsCounter);
      if (newsLimitHit) {
        ctx.log.warn(
          `news: денний ліміт NewsData (${DAILY_NEWS_LIMIT}) вичерпано — решту тем пропущено`,
        );
      }

      // Найновіші зверху (фідбек власника: релізи показувались у порядку
      // фетчу конфіга, не за часом — стара новина від одного репо випереджала
      // свіжу від іншого). Без дати -> в кінець; stable sort лишає відносний
      // порядок рівних (у т.ч. усіх без дати) незмінним.
      const byRecency = (a: NewsItem, b: NewsItem) => {
        const ta = a.publishedAt ? Date.parse(a.publishedAt) : -Infinity;
        const tb = b.publishedAt ? Date.parse(b.publishedAt) : -Infinity;
        return tb - ta;
      };
      for (const g of groupsByKey.values()) {
        g.items.sort(byRecency);
        g.more.sort(byRecency);
      }

      const groups = [...groupsByKey.values()];
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
  };
}
