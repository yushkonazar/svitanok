// jobs (consumer). Вакансії з DOU + Djinni RSS. Збирає пул найсвіжіших,
// LLM ранжує релевантність ЛИШЕ за заголовком під профіль, сортує, бере
// top-perRun. Дозволені public-сторінки вакансій можуть дати ДЕТЕРМІНОВАНІ
// сигнали (стек/мова/формат), але ніколи не потрапляють у prompt скорингу.
// Заголовок, бейдж % і «чому» — у data.items для дашборда; у короткий рядок
// дня йдуть лише топ-MESSAGE_ITEMS заголовків.
// Скоринг не вдався -> фолбек на свіжість (score=-1). Дедуп проти shownJobs.

import type { Module, Block, Ctx } from '../core/types.js';
import type { AppConfig } from '../core/config.js';
import { canonicalizeUrl } from '../core/url.js';
import { parseRss, type RssItem } from './news.js';

const JOBS_PRIORITY = 55;
const MAX_ITEMS_PER_FEED = 12;
const POOL_SIZE = 20; // кандидатів на скоринг (перRun 3->7 підняв потребу в ширшому пулі)
const MESSAGE_ITEMS = 2; // у Telegram — лише топ-збіги; повний список у дашборді
const WORKUA_BASE = 'https://www.work.ua';
const DESCRIPTION_TEXT_MAX = 6000;
const DESCRIPTION_CACHE_CAP = 60;

type ShownJobs = Record<string, string>; // canonicalUrl -> ISO date

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);?/gi, (_all, hex: string) => {
      const point = Number.parseInt(hex, 16);
      return Number.isFinite(point) && point <= 0x10ffff ? String.fromCodePoint(point) : '';
    })
    .replace(/&#(\d+);?/g, (_all, decimal: string) => {
      const point = Number.parseInt(decimal, 10);
      return Number.isFinite(point) && point <= 0x10ffff ? String.fromCodePoint(point) : '';
    })
    .replace(/&#0?39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&mdash;/g, '—')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** Best-effort парсер пошуку Work.ua (RSS немає): `<a href="/jobs/ID/">Заголовок</a>`.
 *  Крихко до змін розмітки; порожні/дублі відкидаємо; помилка -> [] -> фолбек. */
export function parseWorkUa(html: string): RssItem[] {
  const out: RssItem[] = [];
  const seen = new Set<string>();
  const re = /<a[^>]+href="(\/jobs\/\d+\/?)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const path = m[1]!;
    const title = decodeEntities(
      m[2]!
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
    );
    if (title.length < 5) continue; // порожні/іконкові лінки
    if (seen.has(path)) continue;
    seen.add(path);
    out.push({ title, url: WORKUA_BASE + path });
  }
  return out;
}

/** Обрати парсер за джерелом: Work.ua — HTML, решта — RSS/Atom. */
function parseSource(url: string, body: string): RssItem[] {
  return url.includes('work.ua') ? parseWorkUa(body) : parseRss(body);
}

interface Candidate {
  title: string;
  url: string;
  /** Короткий опис з already-allowed RSS, лише для детермінованих фактів. */
  description?: string;
  /** Санітизований public text з вузько дозволеної сторінки; ніколи не LLM input. */
  pageDescription?: string;
  publishedAt?: string;
}
interface ScoredJob extends Candidate {
  /** Ранжування за заголовком, не «fit» і не перевірка повної вакансії. */
  score: number; // 0..100; -1 = без ранжування (фолбек)
  why: string;
  evidence: 'title_only' | 'listing_excerpt';
  signals?: JobSignals;
}

/** Спостережувані сигнали з title/RSS-excerpt; це НЕ вимоги, fit або висновок
 * про кандидата. Відсутнє поле означає «джерело цього не підтвердило». */
export interface JobSignals {
  stack?: string[];
  level?: 'trainee' | 'junior' | 'middle' | 'senior';
  workMode?: 'remote' | 'hybrid' | 'onsite';
  languages?: string[];
  salary?: string;
}

type JobDescriptionRule = AppConfig['modules']['jobs']['descriptions']['sources'][number];

/** Лише санітизований, обмежений уривок public-вакансії. HTML не зберігаємо. */
export interface JobDescriptionCacheEntry {
  source: { host: string; pathPrefix: string };
  fetchedAt: string;
  text: string;
}
type JobDescriptionCache = Record<string, JobDescriptionCacheEntry>;

function cleanRule(rule: JobDescriptionRule): { host: string; pathPrefix: string } {
  return { host: rule.host.toLowerCase(), pathPrefix: rule.pathPrefix };
}

/** URL приходить лише з RSS. Перед page-fetch ще раз звіряємо точний route. */
export function descriptionSourceFor(
  url: string,
  rules: readonly JobDescriptionRule[],
): { host: string; pathPrefix: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port)
    return null;
  const host = parsed.hostname.toLowerCase();
  for (const rawRule of rules) {
    const rule = cleanRule(rawRule);
    if (host === rule.host && parsed.pathname.startsWith(rule.pathPrefix)) return rule;
  }
  return null;
}

/**
 * Витягти рівно текст: без script/style/noscript/comments/тегів, без HTML у
 * state та без неконтрольованого росту. Це не HTML sanitizer для рендерингу —
 * текст ніколи не віддається клієнту, лише проходить через signal extractor.
 */
export function normalizeJobDescription(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\p{Cc}/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  ).slice(0, DESCRIPTION_TEXT_MAX);
}

function freshCachedDescription(
  value: unknown,
  rule: { host: string; pathPrefix: string },
  cutoff: number,
): string | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Partial<JobDescriptionCacheEntry>;
  const fetchedAt = Date.parse(String(entry.fetchedAt ?? ''));
  if (!Number.isFinite(fetchedAt) || fetchedAt < cutoff) return null;
  if (!entry.source || typeof entry.source !== 'object') return null;
  const source = entry.source as Partial<JobDescriptionCacheEntry['source']>;
  if (source.host?.toLowerCase() !== rule.host || source.pathPrefix !== rule.pathPrefix)
    return null;
  if (
    typeof entry.text !== 'string' ||
    entry.text.length === 0 ||
    entry.text.length > DESCRIPTION_TEXT_MAX
  ) {
    return null;
  }
  return entry.text;
}

/** Під час `state.update` ще раз звужуємо довільний старий blob до контракту. */
function boundedDescriptionCache(value: unknown, cutoff: number): JobDescriptionCache {
  if (!value || typeof value !== 'object') return {};
  const valid: Array<[string, JobDescriptionCacheEntry]> = [];
  for (const [url, item] of Object.entries(value as Record<string, unknown>)) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Partial<JobDescriptionCacheEntry>;
    const fetchedAt = Date.parse(String(entry.fetchedAt ?? ''));
    const source = entry.source;
    if (
      !url ||
      !Number.isFinite(fetchedAt) ||
      fetchedAt < cutoff ||
      typeof entry.text !== 'string' ||
      entry.text.length === 0 ||
      entry.text.length > DESCRIPTION_TEXT_MAX ||
      !source ||
      typeof source !== 'object' ||
      typeof source.host !== 'string' ||
      typeof source.pathPrefix !== 'string'
    ) {
      continue;
    }
    valid.push([
      url,
      {
        source: { host: source.host.toLowerCase(), pathPrefix: source.pathPrefix },
        fetchedAt: new Date(fetchedAt).toISOString(),
        text: entry.text,
      },
    ]);
  }
  valid.sort(([, a], [, b]) => Date.parse(b.fetchedAt) - Date.parse(a.fetchedAt));
  return Object.fromEntries(valid.slice(0, DESCRIPTION_CACHE_CAP));
}

/**
 * Page-fetch не є загальним crawler-ом: беруться лише URLs already отримані з
 * configured RSS, максимум N за run. Кожен виклик несе рівно один route, тому
 * навіть redirect не може «перестрибнути» на іншу вакансійну зону.
 */
async function loadJobDescriptions(
  ctx: Ctx<AppConfig>,
  candidates: Candidate[],
): Promise<Map<string, string>> {
  const cfg = ctx.config.modules.jobs.descriptions;
  if (!cfg?.enabled || cfg.sources.length === 0) return new Map();

  const now = ctx.clock.now().getTime();
  const cutoff = now - cfg.retentionDays * 86400_000;
  const current = ctx.state.get<JobDescriptionCache>('jobDescriptions') ?? {};
  const descriptions = new Map<string, string>();
  const fetchedEntries: JobDescriptionCache = {};
  const toFetch: Array<{ candidate: Candidate; rule: { host: string; pathPrefix: string } }> = [];

  for (const candidate of candidates) {
    const rule = descriptionSourceFor(candidate.url, cfg.sources);
    if (!rule) continue;
    const cached = freshCachedDescription(current[candidate.url], rule, cutoff);
    if (cached) {
      descriptions.set(candidate.url, cached);
      continue;
    }
    if (toFetch.length < cfg.maxPerRun) toFetch.push({ candidate, rule });
  }

  const fetched = await Promise.allSettled(
    toFetch.map(async ({ candidate, rule }) => {
      const html = await ctx.fetcher.fetch(candidate.url, { allowedRoutes: [rule] });
      const text = normalizeJobDescription(html);
      if (!text) throw new Error('порожній опис після нормалізації');
      return { url: candidate.url, rule, text };
    }),
  );

  let changed = false;
  for (const result of fetched) {
    if (result.status === 'rejected') {
      ctx.log.warn(
        `jobs: опис вакансії не завантажено: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
      );
      continue;
    }
    const { url, rule, text } = result.value;
    descriptions.set(url, text);
    fetchedEntries[url] = { source: rule, fetchedAt: new Date(now).toISOString(), text };
    changed = true;
  }

  const boundedCurrent = boundedDescriptionCache(current, cutoff);
  const needsCompaction =
    Object.keys(boundedCurrent).length !== Object.keys(current).length ||
    Object.entries(boundedCurrent).some(([url, entry]) => {
      const old = current[url];
      return (
        old?.fetchedAt !== entry.fetchedAt ||
        old?.text !== entry.text ||
        old?.source?.host !== entry.source.host ||
        old?.source?.pathPrefix !== entry.source.pathPrefix
      );
    });
  if (changed || needsCompaction) {
    // `set` із snapshot раннього run-а міг би знищити опис, який записав інший
    // run. `update` перераховує merge на свіжому StateStoreDO/KV blob під час
    // flush: додає лише щойно fetched entries, бере новіший запис при колізії.
    ctx.state.update<JobDescriptionCache>('jobDescriptions', (latest) => {
      const merged = { ...(latest ?? {}) };
      for (const [url, entry] of Object.entries(fetchedEntries)) {
        const oldAt = Date.parse(String(merged[url]?.fetchedAt ?? ''));
        if (!Number.isFinite(oldAt) || oldAt <= Date.parse(entry.fetchedAt)) merged[url] = entry;
      }
      return boundedDescriptionCache(merged, cutoff);
    });
  }
  return descriptions;
}

const STACK_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['TypeScript', /\btypescript\b|\bts\b/i],
  ['JavaScript', /\bjavascript\b|\becmascript\b/i],
  ['React', /\breact(?:\.js)?\b/i],
  ['Next.js', /\bnext(?:\.js)?\b/i],
  ['Node.js', /\bnode(?:\.js)?\b/i],
  ['NestJS', /\bnest(?:js)?\b/i],
  ['Express', /\bexpress(?:\.js)?\b/i],
  ['Vue', /\bvue(?:\.js)?\b/i],
  ['Angular', /\bangular\b/i],
  ['Python', /\bpython\b/i],
  ['Java', /\bjava\b/i],
  ['PHP', /\bphp\b/i],
  ['Laravel', /\blaravel\b/i],
  ['Symfony', /\bsymfony\b/i],
  ['C#/.NET', /\bc#\b|\b\.net\b|\bdotnet\b/i],
  ['SQL', /\bsql\b|\bpostgres(?:ql)?\b|\bmysql\b/i],
  ['MongoDB', /\bmongodb\b/i],
  ['Redis', /\bredis\b/i],
  ['Docker', /\bdocker\b/i],
  ['Kubernetes', /\bkubernetes\b|\bk8s\b/i],
  ['AWS', /\baws\b|\bamazon web services\b/i],
  ['GraphQL', /\bgraphql\b/i],
];

/** Витягнути лише явно названі факти з заголовка та RSS-excerpt. */
export function extractJobSignals(candidate: Candidate): JobSignals | undefined {
  const text = [candidate.title, candidate.description, candidate.pageDescription]
    .filter((part): part is string => Boolean(part))
    .join('\n');
  const stack = STACK_PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => name);
  const level = /\btrainee\b|\bintern(?:ship)?\b|\bстаж(?:ерування|ер)?\b/i.test(text)
    ? 'trainee'
    : /\bjunior\b|\bджун(?:іор)?\b/i.test(text)
      ? 'junior'
      : /\bmiddle\b|\bmid[- ]?level\b/i.test(text)
        ? 'middle'
        : /\bsenior\b|\blead\b|\bсеньйор\b/i.test(text)
          ? 'senior'
          : undefined;
  const workMode = /\bremote\b|\bвіддален(?:о|а|ий)\b/i.test(text)
    ? 'remote'
    : /\bhybrid\b|\bгібридн(?:о|а|ий)\b/i.test(text)
      ? 'hybrid'
      : /\bon[- ]?site\b|\bофіс(?:на|ний|і)?\b/i.test(text)
        ? 'onsite'
        : undefined;
  const languages = [
    ...(/\benglish\b|\bанглійськ/i.test(text) ? ['English'] : []),
    ...(/\bukrainian\b|\bукраїнськ/i.test(text) ? ['Ukrainian'] : []),
  ];
  const salaryMatch = text.match(
    /(?:\$|€|₴|usd\b|eur\b|uah\b)\s?\d[\d\s,.]*(?:\s?(?:-|–|—|to)\s?(?:\$|€|₴|usd\b|eur\b|uah\b)?\s?\d[\d\s,.]*)?/i,
  );
  const signals: JobSignals = {
    ...(stack.length ? { stack } : {}),
    ...(level ? { level } : {}),
    ...(workMode ? { workMode } : {}),
    ...(languages.length ? { languages } : {}),
    ...(salaryMatch?.[0]
      ? {
          salary: salaryMatch[0]
            .replace(/\s+/g, ' ')
            .replace(/[.,;:]+$/, '')
            .trim(),
        }
      : {}),
  };
  return Object.keys(signals).length ? signals : undefined;
}

// --- jobPrefs (памʼять скорера з живої воронки: dismiss/applied→interview→offer) ---
export interface JobPrefs {
  liked: string[];
  disliked: string[];
}
export const JOB_PREFS_CAP = 20;

const JOB_STOP_WORDS = new Set([
  'job',
  'jobs',
  'vacancy',
  'вакансія',
  'вакансии',
  'developer',
  'розробник',
  'engineer',
  'інженер',
  'junior',
  'trainee',
  'intern',
  'стажист',
  'джуніор',
  'full',
  'part',
  'time',
  'remote',
  'hybrid',
  'офіс',
  'дистанційно',
  'stack',
]);

function titleTokens(title: string): string[] {
  return (title.toLowerCase().match(/[a-zа-яїієґ0-9+#.]{3,}/gi) ?? []).filter(
    (t) => !JOB_STOP_WORDS.has(t),
  );
}

/** Оновити памʼять скорера за сигналом з живої воронки (чиста функція, cap+decay найстаріших). */
export function updateJobPrefs(
  prefs: JobPrefs,
  signal: 'dismiss' | 'applied' | 'interview' | 'offer',
  title: string,
): JobPrefs {
  const tokens = titleTokens(title);
  if (tokens.length === 0) return prefs;
  const toAdd = signal === 'dismiss' ? 'disliked' : 'liked';
  const toRemove = toAdd === 'liked' ? 'disliked' : 'liked';
  const merged = [...tokens, ...prefs[toAdd].filter((t) => !tokens.includes(t))].slice(
    0,
    JOB_PREFS_CAP,
  );
  const filtered = prefs[toRemove].filter((t) => !tokens.includes(t));
  return { ...prefs, [toAdd]: merged, [toRemove]: filtered };
}

/** Пул round-robin по фідах (різноманіття), дедуп проти показаних, cap POOL_SIZE. */
function collectPool(lists: RssItem[][], shown: ShownJobs, cutoff: number): Candidate[] {
  const seen = new Set<string>();
  const pool: Candidate[] = [];
  for (let i = 0; i < MAX_ITEMS_PER_FEED && pool.length < POOL_SIZE; i++) {
    for (const list of lists) {
      if (pool.length >= POOL_SIZE) break;
      const item = list[i];
      if (!item) continue;
      const canon = canonicalizeUrl(item.url);
      if (seen.has(canon)) continue;
      const at = shown[canon] ? Date.parse(shown[canon]!) : 0;
      if (at && at >= cutoff) continue; // показували в вікні
      seen.add(canon);
      pool.push({
        title: item.title,
        url: canon,
        ...(item.description ? { description: item.description } : {}),
        ...(item.publishedAt ? { publishedAt: item.publishedAt } : {}),
      });
    }
  }
  return pool;
}

export function buildScorePrompt(
  profile: string,
  candidates: Candidate[],
  prefs?: JobPrefs,
): string {
  const prefLines: string[] = [];
  if (prefs?.liked?.length)
    prefLines.push(`Із попереднього фідбоку цінує: ${prefs.liked.join(', ')}.`);
  if (prefs?.disliked?.length)
    prefLines.push(`Із попереднього фідбоку зазвичай ігнорує: ${prefs.disliked.join(', ')}.`);
  return [
    'Ти — кар’єрний асистент. Профіль кандидата:',
    profile,
    ...prefLines,
    'Оціни лише релевантність ЗАГОЛОВКА кожної вакансії профілю від 0 до 100.',
    'Не роби висновків про вимоги, зарплату, локацію чи опис: їх тут немає.',
    'Вакансії:',
    ...candidates.map((c, i) => `${i + 1}. ${c.title}`),
    'Поверни ЛИШЕ JSON-масив без прози:',
    '[{"i":1,"score":92,"why":"коротко українською"}]',
  ].join('\n');
}

/** Розпарсити скоринг у map index(1-based) -> {score,why}; малформат -> порожньо. */
export function parseScores(text: string): Map<number, { score: number; why: string }> {
  const out = new Map<number, { score: number; why: string }>();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) return out;
  try {
    const arr: unknown = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(arr)) return out;
    for (const x of arr) {
      if (x && typeof x === 'object') {
        const o = x as Record<string, unknown>;
        const i = typeof o.i === 'number' ? o.i : NaN;
        const score = typeof o.score === 'number' ? o.score : NaN;
        if (Number.isInteger(i) && Number.isFinite(score)) {
          out.set(i, {
            score: Math.max(0, Math.min(100, Math.round(score))),
            why: typeof o.why === 'string' ? o.why.trim() : '',
          });
        }
      }
    }
  } catch {
    /* малформат -> порожня map -> фолбек */
  }
  return out;
}

export const jobsModule: Module<AppConfig> = {
  id: 'jobs',
  kind: 'consumer',
  enabled: (config) => config.modules.jobs.enabled,

  async run(ctx: Ctx<AppConfig>): Promise<Block | null> {
    const cfg = ctx.config.modules.jobs;
    if (!cfg.sources || cfg.sources.length === 0) return null;

    const shown = ctx.state.get<ShownJobs>('shownJobs') ?? {};
    // Час — з інжектованого годинника (детерміновано в тестах, консистентно з todayKey).
    const cutoff = ctx.clock.now().getTime() - cfg.dedupDays * 86400_000;
    const today = ctx.clock.todayKey();

    const settled = await Promise.allSettled(cfg.sources.map((u) => ctx.fetcher.fetch(u)));
    const lists: RssItem[][] = [];
    settled.forEach((r, i) => {
      const src = cfg.sources[i]!;
      const host = URL.canParse(src) ? new URL(src).host : src;
      if (r.status !== 'fulfilled') {
        ctx.log.warn(`jobs: фід впав (${host})`);
        return;
      }
      const items = parseSource(src, r.value).slice(0, MAX_ITEMS_PER_FEED);
      ctx.log.info(`jobs: ${items.length} з ${host}`);
      lists.push(items);
    });

    const pool = collectPool(lists, shown, cutoff);
    if (pool.length === 0) return null;

    // Сигнали з page description суто детерміновані. В LLM і публічний payload
    // текст не потрапляє; buildScorePrompt нижче бере тільки title.
    const pageDescriptions = await loadJobDescriptions(ctx, pool);
    const observedPool = pool.map((candidate) => ({
      ...candidate,
      ...(pageDescriptions.has(candidate.url)
        ? { pageDescription: pageDescriptions.get(candidate.url)! }
        : {}),
    }));

    // LLM-ранжування заголовків; збій -> фолбек на свіжість (порядок пулу).
    // jobPrefs — памʼять із живої воронки (dismiss/applied→interview→offer), §D2.
    const jobPrefs = ctx.state.get<JobPrefs>('jobPrefs');
    let ranked: ScoredJob[];
    try {
      const out = await ctx.llm.complete(buildScorePrompt(cfg.profile, observedPool, jobPrefs), {
        timeoutMs: ctx.config.llm.timeoutMs,
        tag: 'jobs',
      });
      const scores = parseScores(out);
      if (scores.size === 0) throw new Error('порожній скоринг');
      ranked = observedPool
        .map((c, i) => {
          const signals = extractJobSignals(c);
          const { description: _description, pageDescription: _pageDescription, ...visible } = c;
          return {
            ...visible,
            score: scores.get(i + 1)?.score ?? 0,
            why: scores.get(i + 1)?.why ?? '',
            // Сумісний з Mini App enum: observed non-title source може бути
            // RSS excerpt або bounded page excerpt. Сам score лишається title-only.
            evidence:
              c.description || c.pageDescription
                ? ('listing_excerpt' as const)
                : ('title_only' as const),
            ...(signals ? { signals } : {}),
          };
        })
        .sort((a, b) => b.score - a.score);
    } catch (e) {
      ctx.log.warn(
        `jobs: скоринг не вдався (фолбек на свіжість): ${e instanceof Error ? e.message : String(e)}`,
      );
      ranked = observedPool.map((c) => {
        const signals = extractJobSignals(c);
        const { description: _description, pageDescription: _pageDescription, ...visible } = c;
        return {
          ...visible,
          score: -1,
          why: '',
          evidence:
            c.description || c.pageDescription
              ? ('listing_excerpt' as const)
              : ('title_only' as const),
          ...(signals ? { signals } : {}),
        };
      });
    }

    const picked = ranked.slice(0, cfg.perRun);
    if (picked.length === 0) return null;

    const nextShown: ShownJobs = { ...shown };
    for (const p of picked) nextShown[p.url] = today;
    ctx.state.set('shownJobs', nextShown);

    // Коротка версія для короткого рядка дня: топ-MESSAGE_ITEMS збігів. Повний
    // список і «чому» лишаються в дашборді (data.items). HTML-версія з лінками
    // й кнопки 💾/✅ тут колись були — їх читав ЛИШЕ мертвий рендерер (аудит
    // B20/F5), у чат вони не доїжджали жодного разу; збереження й «Подав»
    // живуть у Mini App.
    const summary = picked
      .slice(0, MESSAGE_ITEMS)
      .map((p) => p.title)
      .join('\n');

    return {
      id: 'jobs',
      title: 'Вакансії',
      icon: '💼',
      summary,
      data: { items: picked },
      priority: JOBS_PRIORITY,
    };
  },
};
