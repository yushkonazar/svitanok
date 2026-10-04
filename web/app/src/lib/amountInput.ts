/** Keep the input string while editing; parse only a complete, finite amount. */
export function amountInput(raw: string): number | null {
  const text = raw
    .trim()
    .replace(/[\s\u00a0\u202f]/g, '')
    .replace(',', '.');
  if (!/^\d+(?:\.\d{0,6})?$/.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) && value <= 1_000_000_000_000 ? value : null;
}
