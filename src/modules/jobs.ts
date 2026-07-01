// jobs (consumer). Вакансії з DOU + Djinni RSS. Збирає пул найсвіжіших,
// LLM-скоринг релевантності під профіль (fit %), сортує, бере top-perRun.
// Клікабельний заголовок-лінк + бейдж %, «чому» — у detail (expandable).
// Скоринг не вдався -> фолбек на свіжість (без %). Дедуп проти shownJobs.

import type { Module, Block, Ctx } from '../core/types.js';
import type { AppConfig } from '../core/config.js';
import { canonicalizeUrl } from '../core/url.js';
import { link } from '../core/telegram.js';
import { parseRss, type RssItem } from './news.js';

const JOBS_PRIORITY = 55;
const MAX_ITEMS_PER_FEED = 12;
const POOL_SIZE = 14; // кандидатів на скоринг (малий промпт claude -p)
const MESSAGE_ITEMS = 2; // у Telegram — лише топ-збіги; повний список у дашборді

type ShownJobs = Record<string, string>; // canonicalUrl -> ISO date

interface Candidate {
  title: string;
  url: string;
}
interface ScoredJob extends Candidate {
  score: number; // 0..100; -1 = без скорингу (фолбек)
  why: string;
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

export function buildScorePrompt(profile: string, candidates: Candidate[]): string {
  return [
    'Ти — кар’єрний асистент. Профіль кандидата:',
    profile,
    'Оціни релевантність КОЖНОЇ вакансії профілю від 0 до 100',
    '(рівень trainee/junior, збіг стеку, junior-дружність).',
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
    const cutoff = Date.now() - cfg.dedupDays * 86400_000;
    const today = ctx.clock.todayKey();

    const settled = await Promise.allSettled(cfg.sources.map((u) => ctx.fetcher.fetch(u)));
    const lists: RssItem[][] = [];
    for (const r of settled) {
      if (r.status === 'fulfilled') lists.push(parseRss(r.value).slice(0, MAX_ITEMS_PER_FEED));
      else ctx.log.warn('jobs: фід впав');
    }

    const pool = collectPool(lists, shown, cutoff);
    if (pool.length === 0) return null;

    // LLM-скоринг релевантності; збій -> фолбек на свіжість (порядок пулу).
    let ranked: ScoredJob[];
    try {
      const out = await ctx.llm.complete(buildScorePrompt(cfg.profile, pool), {
        timeoutMs: ctx.config.llm.timeoutMs,
      });
      const scores = parseScores(out);
      if (scores.size === 0) throw new Error('порожній скоринг');
      ranked = pool
        .map((c, i) => ({
          ...c,
          score: scores.get(i + 1)?.score ?? 0,
          why: scores.get(i + 1)?.why ?? '',
        }))
        .sort((a, b) => b.score - a.score);
    } catch (e) {
      ctx.log.warn(
        `jobs: скоринг не вдався (фолбек на свіжість): ${e instanceof Error ? e.message : String(e)}`,
      );
      ranked = pool.map((c) => ({ ...c, score: -1, why: '' }));
    }

    const picked = ranked.slice(0, cfg.perRun);
    if (picked.length === 0) return null;

    const nextShown: ShownJobs = { ...shown };
    for (const p of picked) nextShown[p.url] = today;
    ctx.state.set('shownJobs', nextShown);

    // Коротка версія для повідомлення: топ-MESSAGE_ITEMS збігів (бейдж % + лінк).
    // Повний список і «чому» лишаються в дашборді (data.items).
    const shortPicks = picked.slice(0, MESSAGE_ITEMS);
    const summaryHtml = shortPicks
      .map((p) => `• ${p.score >= 0 ? `<b>${p.score}%</b> ` : ''}${link(p.url, p.title)}`)
      .join('\n');
    const summary = shortPicks.map((p) => p.title).join('\n');

    return {
      id: 'jobs',
      title: 'Вакансії',
      icon: '💼',
      summary,
      summaryHtml,
      data: { items: picked },
      priority: JOBS_PRIORITY,
    };
  },
};
