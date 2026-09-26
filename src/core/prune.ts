// Pruner-и стану (§6 weekly-review, §8). Тримають state.json і коміти стрункими:
//  - shownNews: за max(dedupDays, retentionDays);
//  - shownMail: за mail.dedupDays;
//  - shownJobs: за jobs.dedupDays;
//  - jobDescriptions: bounded public page excerpts за jobs.descriptions.retentionDays.
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
  const descriptionsCutoff = now - (config.modules.jobs.descriptions?.retentionDays ?? 14) * DAY_MS;

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

  // Повні сторінки вакансій — найважчий запис у state. Тримаємо лише свіжі,
  // валідні та не більше 60 найновіших; це межа навіть коли maxPerRun/доба
  // помножиться на весь retention. Текст не аналізуємо тут — тільки форма й час.
  const pruneJobDescriptions: Pruner = (data) => {
    const cache = data['jobDescriptions'] as
      Record<string, { fetchedAt?: unknown; text?: unknown }> | undefined;
    if (!cache || typeof cache !== 'object') return;
    for (const [url, entry] of Object.entries(cache)) {
      const at = Date.parse(String(entry?.fetchedAt ?? ''));
      if (
        !url ||
        !Number.isFinite(at) ||
        at < descriptionsCutoff ||
        typeof entry?.text !== 'string'
      ) {
        delete cache[url];
      }
    }
    const oldestFirst = Object.entries(cache)
      .map(([url, entry]) => ({ url, at: Date.parse(String(entry?.fetchedAt ?? '')) }))
      .sort((a, b) => a.at - b.at);
    for (const { url } of oldestFirst.slice(0, Math.max(0, oldestFirst.length - 60))) {
      delete cache[url];
    }
  };

  return [pruneShownNews, pruneShownMail, pruneShownJobs, pruneJobDescriptions];
}
