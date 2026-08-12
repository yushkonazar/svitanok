// Pruner-и стану (§6 weekly-review, §8). Тримають state.json і коміти стрункими:
//  - shownNews: за max(dedupDays, retentionDays);
//  - shownMail: за mail.dedupDays;
//  - shownJobs: за jobs.dedupDays.
// Передаються у createStateStore; orchestrator викликає state.prune() перед flush.
//
// ⚠️ Інваріант: КОЖНА dedup-мапа має мати тут свій прунер. shownJobs його не мала
// (аудит B20/F4) — по запису на кожну колись показану вакансію, 7 на добу,
// назавжди: ~2500 записів і ~220 КБ сміття на рік усередині блоба `state`, який
// читається й переписується КОЖНИМ прогоном. Дедуп при цьому дивиться лише на
// останні dedupDays — усе старше було мертвою вагою.

import type { Pruner } from './state.js';
import type { AppConfig } from './config.js';

const DAY_MS = 86400_000;

export function buildPruners(config: AppConfig, now: number): Pruner[] {
  const newsCutoff =
    now - Math.max(config.modules.news.dedupDays, config.modules.news.retentionDays) * DAY_MS;
  const mailCutoff = now - config.modules.mail.dedupDays * DAY_MS;
  const jobsCutoff = now - config.modules.jobs.dedupDays * DAY_MS;

  const pruneShownNews: Pruner = (data) => {
    const shown = data['shownNews'] as Record<string, string> | undefined;
    if (!shown) return;
    for (const [url, d] of Object.entries(shown)) {
      const t = Date.parse(d);
      if (!Number.isFinite(t) || t < newsCutoff) delete shown[url];
    }
  };

  // shownMail (Блок P2c) — той самий патерн, що shownNews: без прунінгу зростав
  // би необмежено (по запису на кожен колись розглянутий лист).
  const pruneShownMail: Pruner = (data) => {
    const shown = data['shownMail'] as Record<string, string> | undefined;
    if (!shown) return;
    for (const [id, d] of Object.entries(shown)) {
      const t = Date.parse(d);
      if (!Number.isFinite(t) || t < mailCutoff) delete shown[id];
    }
  };

  // shownJobs (B20/F4) — дослівно той самий патерн, що shownMail: ключ -> дата
  // показу, все старше за dedupDays на дедуп уже не впливає.
  const pruneShownJobs: Pruner = (data) => {
    const shown = data['shownJobs'] as Record<string, string> | undefined;
    if (!shown) return;
    for (const [url, d] of Object.entries(shown)) {
      const t = Date.parse(d);
      if (!Number.isFinite(t) || t < jobsCutoff) delete shown[url];
    }
  };

  return [pruneShownNews, pruneShownMail, pruneShownJobs];
}
