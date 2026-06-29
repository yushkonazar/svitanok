// jobs (consumer). Вакансії з DOU RSS (Full Stack / Front / Back, junior).
// Топ-N найсвіжіших round-robin по фідах (різноманіття стеку), клікабельний
// заголовок-лінк, дедуп проти shownJobs (вікно dedupDays). Без LLM.
// Work.ua/LinkedIn — без відкритого RSS, відкладено (скрапінг проти ToS/блок IP).

import type { Module, Block, Ctx } from '../core/types.js';
import type { AppConfig } from '../core/config.js';
import { canonicalizeUrl } from '../core/url.js';
import { link } from '../core/telegram.js';
import { parseRss, type RssItem } from './news.js';

const JOBS_PRIORITY = 55; // після новин (50), перед next-step
const MAX_ITEMS_PER_FEED = 15;

type ShownJobs = Record<string, string>; // canonicalUrl -> ISO date

interface PickedJob {
  title: string;
  url: string;
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
    const nextShown: ShownJobs = { ...shown };

    const settled = await Promise.allSettled(cfg.sources.map((u) => ctx.fetcher.fetch(u)));
    const lists: RssItem[][] = [];
    for (const r of settled) {
      if (r.status === 'fulfilled') lists.push(parseRss(r.value).slice(0, MAX_ITEMS_PER_FEED));
      else ctx.log.warn('jobs: фід впав');
    }

    const seen = new Set<string>();
    const picked: PickedJob[] = [];
    // Round-robin: по одній свіжій із кожного фіда по черзі (різні категорії).
    for (let i = 0; i < MAX_ITEMS_PER_FEED && picked.length < cfg.perRun; i++) {
      for (const list of lists) {
        if (picked.length >= cfg.perRun) break;
        const item = list[i];
        if (!item) continue;
        const canon = canonicalizeUrl(item.url);
        if (seen.has(canon)) continue;
        const at = shown[canon] ? Date.parse(shown[canon]!) : 0;
        if (at && at >= cutoff) continue; // показували в вікні
        seen.add(canon);
        picked.push({ title: item.title, url: canon });
        nextShown[canon] = today;
      }
    }

    if (picked.length === 0) return null;
    ctx.state.set('shownJobs', nextShown);

    const summaryHtml = picked.map((it) => `• ${link(it.url, it.title)}`).join('\n');
    const summary = picked.map((it) => it.title).join('\n');
    return {
      id: 'jobs',
      title: 'Вакансії',
      icon: '💼',
      summary,
      summaryHtml,
      priority: JOBS_PRIORITY,
    };
  },
};
