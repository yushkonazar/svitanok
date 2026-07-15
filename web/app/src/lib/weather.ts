// Утиліти погоди/часу (роадмеп v3, E2) — 1:1 з index.html (1503-1523).

const KYIV = 'Europe/Kyiv';

/** unix-секунди → «HH:MM» за київським часом; '—' якщо 0/невідомо. */
export function fmtClock(unix: number): string {
  return unix
    ? new Date(unix * 1000).toLocaleTimeString('uk-UA', {
        timeZone: KYIV,
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';
}

/** Хвилини → «Nг Mхв» / «Mхв» (напр. «до заходу»). */
export function fmtDur(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h} год ${m} хв` : `${m} хв`;
}

/** Довжина дня між сходом і заходом → «Nг Mхв»; '' якщо невідомо. */
export function dayLen(a: number, b: number): string {
  if (!a || !b || b <= a) return '';
  const m = Math.round((b - a) / 60);
  return `${Math.floor(m / 60)}г ${m % 60}хв`;
}

/** Температура зі знаком: «+24°» / «-5°» / «0°». */
export function signTemp(t: number): string {
  return (t > 0 ? '+' : '') + t + '°';
}
