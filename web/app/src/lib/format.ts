// Дрібні хелпери форматування/умов (роадмеп v3, E1).

/** Значення присутнє — аналог vanilla has() (порожній рядок теж = відсутнє). */
export function has<T>(v: T | null | undefined): v is T {
  return v !== null && v !== undefined && (v as unknown) !== '';
}

/** Обмежити число в [lo, hi]. */
export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Обрізати рядок до max символів з «…». */
export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
