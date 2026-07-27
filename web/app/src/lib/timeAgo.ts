// Відносний час «5 хв»/«2 год»/«вчора»/«3 дні» (редизайн новин) — dateLabel.ts
// дає лише АБСОЛЮТНУ дату (заголовок), тут потрібен саме відносний відлік на
// кожній картці новини/релізу.

/** ISO -> «щойно»/«5 хв»/«2 год»/«вчора»/«3 дні»; null — відсутня/битка дата. */
export function timeAgo(iso: string | undefined, now: Date = new Date()): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const diffMin = Math.max(0, Math.round((now.getTime() - t) / 60_000));
  if (diffMin < 1) return 'щойно';
  if (diffMin < 60) return `${diffMin} хв`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `${diffH} год`;
  const diffD = Math.round(diffH / 24);
  if (diffD === 1) return 'вчора';
  return `${diffD} дні`;
}
