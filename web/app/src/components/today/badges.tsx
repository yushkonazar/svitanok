import { has } from '../../lib/format.ts';

// Бейджі рівнів та дельти (роадмеп v3, E2) — 1:1 з index.html uvBadge/aqiBadge
// (1684-1711) і deltaBadge (1661-1667).

export type Tone = 'good' | 'mid' | 'warn' | 'bad' | 'muted' | 'fit';

const TONE_CLS: Record<Tone, string> = {
  good: 'bg-up/15 text-up',
  mid: 'bg-accent-2/15 text-accent-2',
  warn: 'bg-accent-2/20 text-accent-2',
  bad: 'bg-down/15 text-down',
  muted: 'bg-surface-2 text-muted',
  // fit% сильної вакансії — суцільна брендова заливка (як vanilla .b-fit).
  fit: 'text-on-accent',
};

export function Badge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  const gradient = tone === 'fit';
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${TONE_CLS[tone]}`}
      style={gradient ? { background: 'linear-gradient(135deg, var(--grad-from), var(--grad-to))' } : undefined}
    >
      {children}
    </span>
  );
}

export function UvBadge({ uv }: { uv?: number }) {
  if (!has(uv)) return null;
  let tone: Tone = 'good';
  let txt = 'низький';
  if (uv >= 8) {
    tone = 'bad';
    txt = 'дуже високий';
  } else if (uv >= 6) {
    tone = 'warn';
    txt = 'високий';
  } else if (uv >= 3) {
    tone = 'mid';
    txt = 'помірний';
  }
  return (
    <Badge tone={tone}>
      UV {uv} · {txt}
    </Badge>
  );
}

const AQI_MAP: Record<number, [Tone, string]> = {
  1: ['good', 'добре'],
  2: ['good', 'прийнятно'],
  3: ['warn', 'помірно'],
  4: ['bad', 'погано'],
  5: ['bad', 'дуже погано'],
};

export function AqiBadge({ aqi }: { aqi?: number }) {
  if (!has(aqi)) return null;
  const [tone, txt] = AQI_MAP[aqi] ?? (['muted', '—'] as [Tone, string]);
  return (
    <Badge tone={tone}>
      AQI {aqi} · {txt}
    </Badge>
  );
}

/** Дельта курсу: ↑/↓/→ + |різниця|.toFixed(digits)+unit. null, якщо даних нема. */
export function DeltaBadge({
  curr,
  prev,
  digits = 2,
  unit = '',
}: {
  curr?: number;
  prev?: number;
  digits?: number;
  unit?: string;
}) {
  if (!has(curr) || !has(prev)) return null;
  const dd = curr - prev;
  const cls = dd > 0 ? 'text-up' : dd < 0 ? 'text-down' : 'text-muted';
  const arr = dd > 0 ? '↑' : dd < 0 ? '↓' : '→';
  return (
    <span className={`text-sm font-semibold ${cls}`}>
      {arr} {Math.abs(dd).toFixed(digits)}
      {unit}
    </span>
  );
}
