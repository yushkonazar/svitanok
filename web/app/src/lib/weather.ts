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

const KYIV_HM = new Intl.DateTimeFormat('uk-UA', {
  timeZone: KYIV,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/**
 * Хвилини від півночі за КИЇВСЬКИМ часом (дизайн v2, циферблат). Беремо саме
 * Київ, а не локаль пристрою, щоб позиція маркера збігалася з підписами сходу/
 * заходу (їх теж рендеримо в Києві через fmtClock).
 */
export function kyivMinutes(d: Date): number {
  const parts = KYIV_HM.formatToParts(d);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return h * 60 + m;
}

/** unix-секунди → хвилини від півночі (Київ); 0 якщо невідомо. */
export function kyivMinutesFromUnix(unix: number): number {
  return unix ? kyivMinutes(new Date(unix * 1000)) : 0;
}

/** «HH:MM» поточного київського часу (центр циферблата). */
export function kyivClockNow(d: Date): string {
  const mins = kyivMinutes(d);
  return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}`;
}

/** Хвилини → «Nг Mхв» / «Mхв» (напр. «до заходу»). */
export function fmtDur(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h} год ${m} хв` : `${m} хв`;
}

/** Довжина дня між сходом і заходом → «Nг Mхв»; '—' якщо невідомо (як vanilla —
    пігулка «☀️ День —» усе одно рендериться). */
export function dayLen(a: number, b: number): string {
  if (!a || !b || b <= a) return '—';
  const m = Math.round((b - a) / 60);
  return `${Math.floor(m / 60)}г ${m % 60}хв`;
}

/** Температура зі знаком: «+24°» / «-5°» / «0°». */
export function signTemp(t: number): string {
  return (t > 0 ? '+' : '') + t + '°';
}
