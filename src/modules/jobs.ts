// jobs (consumer). Вакансії з DOU + Djinni RSS. Збирає пул найсвіжіших,
// LLM ранжує релевантність ЛИШЕ за заголовком під профіль, сортує, бере
// top-perRun. Це не є оцінкою повного опису вакансії: опис ще не завантажується.
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

type ShownJobs = Record<string, string>; // canonicalUrl -> ISO date

function decodeEntities(s: string): string {
  return s
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
}
interface ScoredJob extends Candidate {
  /** Ранжування за заголовком, не «fit» і не перевірка повної вакансії. */
  score: number; // 0..100; -1 = без ранжування (фолбек)
  why: string;
  evidence: 'title_only';
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
      pool.push({ title: item.title, url: canon });
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

    // LLM-ранжування заголовків; збій -> фолбек на свіжість (порядок пулу).
    // jobPrefs — памʼять із живої воронки (dismiss/applied→interview→offer), §D2.
    const jobPrefs = ctx.state.get<JobPrefs>('jobPrefs');
    let ranked: ScoredJob[];
    try {
      const out = await ctx.llm.complete(buildScorePrompt(cfg.profile, pool, jobPrefs), {
        timeoutMs: ctx.config.llm.timeoutMs,
        tag: 'jobs',
      });
      const scores = parseScores(out);
      if (scores.size === 0) throw new Error('порожній скоринг');
      ranked = pool
        .map((c, i) => ({
          ...c,
          score: scores.get(i + 1)?.score ?? 0,
          why: scores.get(i + 1)?.why ?? '',
          evidence: 'title_only' as const,
        }))
        .sort((a, b) => b.score - a.score);
    } catch (e) {
      ctx.log.warn(
        `jobs: скоринг не вдався (фолбек на свіжість): ${e instanceof Error ? e.message : String(e)}`,
      );
      ranked = pool.map((c) => ({ ...c, score: -1, why: '', evidence: 'title_only' as const }));
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
