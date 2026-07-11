// Pruner-и стану (§6 weekly-review, §8). Тримають state.json і коміти стрункими:
//  - shownNews: за max(dedupDays, retentionDays);
//  - nextStepLog: за 7 днів.
// Передаються у createStateStore; orchestrator викликає state.prune() перед flush.

import type { Pruner } from './state.js';
import type { AppConfig } from './config.js';
import type { NextStepLogEntry } from '../modules/next-step.js';

const DAY_MS = 86400_000;

export function buildPruners(config: AppConfig, now: number): Pruner[] {
  const newsCutoff =
    now - Math.max(config.modules.news.dedupDays, config.modules.news.retentionDays) * DAY_MS;
  const logCutoff = now - 7 * DAY_MS;
  const mailCutoff = now - config.modules.mail.dedupDays * DAY_MS;

  const pruneShownNews: Pruner = (data) => {
    const shown = data['shownNews'] as Record<string, string> | undefined;
    if (!shown) return;
    for (const [url, d] of Object.entries(shown)) {
      const t = Date.parse(d);
      if (!Number.isFinite(t) || t < newsCutoff) delete shown[url];
    }
  };

  const pruneNextStepLog: Pruner = (data) => {
    const log = data['nextStepLog'] as NextStepLogEntry[] | undefined;
    if (!Array.isArray(log)) return;
    data['nextStepLog'] = log.filter((e) => {
      const t = Date.parse(e.date);
      return Number.isFinite(t) && t >= logCutoff;
    });
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

  return [pruneShownNews, pruneNextStepLog, pruneShownMail];
}
