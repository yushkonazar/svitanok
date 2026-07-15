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

/**
 * Стабільний детермінований id для обраного без url (факт/цитата/питання).
 * 1:1 з vanilla textHash (index.html:1488-1492) — щоб id збереженого збігались
 * і React не «загубив» позначки, збережені старим дашбордом (спільний KV до E4).
 */
export function textHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
