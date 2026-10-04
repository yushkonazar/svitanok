import type { CheckinPoint } from '../../api/schema.ts';

type Metric = 'energy' | 'mood' | 'sleep';
type Row = { d: string; p: CheckinPoint | undefined };
const colors: Record<Metric, string> = {
  energy: 'var(--color-a2)',
  mood: '#b7a1d2',
  sleep: '#91cfb3',
};
const labels: Record<Metric, string> = { energy: 'Енергія', mood: 'Настрій', sleep: 'Сон' };
export function trendValue(p: CheckinPoint | undefined, key: Metric): number | null {
  const observed = p?.moodCurve.filter((v): v is number => v != null && Number.isFinite(v)) ?? [];
  const value =
    key === 'sleep'
      ? p?.sleepH
      : key === 'energy'
        ? p?.energy
        : observed.length
          ? observed.reduce((a, b) => a + b, 0) / observed.length
          : null;
  return value != null &&
    Number.isFinite(value) &&
    value >= (key === 'sleep' ? 0 : 1) &&
    value <= (key === 'sleep' ? 24 : 5)
    ? value
    : null;
}
export function StateTrendCharts({
  rows,
  enabled,
  selected,
  onSelect,
}: {
  rows: Row[];
  enabled: Metric[];
  selected: string;
  onSelect: (date: string) => void;
}) {
  function plot(keys: Metric[], title: string, min: number, max: number, ticks: number[]) {
    if (!keys.length) return null;
    const x = (i: number) => 32 + (i / Math.max(1, rows.length - 1)) * 298;
    const y = (v: number) => 18 + ((max - v) / (max - min)) * 112;
    const index = rows.findIndex((r) => r.d === selected);
    const available = rows.some((r) => keys.some((k) => trendValue(r.p, k) != null));
    const pick = (clientX: number, svg: SVGSVGElement) => {
      const box = svg.getBoundingClientRect();
      const i = Math.round(
        ((((clientX - box.left) / box.width) * 360 - 32) / 298) * (rows.length - 1),
      );
      onSelect(rows[Math.max(0, Math.min(rows.length - 1, i))].d);
    };
    return (
      <figure className="renewal-trend" key={title}>
        <figcaption className="renewal-section-head">
          <b>{title}</b>
          <span className="renewal-muted">
            {min}–{max}
            {keys[0] === 'sleep' ? ' год' : ' балів'}
          </span>
        </figcaption>
        {!available ? (
          <p className="renewal-inset renewal-muted">
            За цей період ще немає відповідей для цього графіка.
          </p>
        ) : (
          <svg
            viewBox="0 0 360 169"
            role="img"
            aria-label={`${title}. ${rows.length} днів. Пропуски не з’єднані.`}
            className="block w-full"
          >
            {ticks.map((t) => (
              <g key={t}>
                <line x1="32" x2="330" y1={y(t)} y2={y(t)} stroke="var(--color-glassb)" />
                <text x="22" y={y(t) + 4} textAnchor="end" className="renewal-svg-label">
                  {t}
                </text>
              </g>
            ))}
            {keys.map((k) => {
              let open = false;
              const path = rows
                .map((r, i) => {
                  const value = trendValue(r.p, k);
                  if (value == null) {
                    open = false;
                    return '';
                  }
                  const part = `${open ? 'L' : 'M'}${x(i)},${y(value)}`;
                  open = true;
                  return part;
                })
                .join(' ');
              return (
                <g key={k}>
                  <path
                    d={path}
                    fill="none"
                    stroke={colors[k]}
                    strokeWidth="2.5"
                    strokeLinecap="round"
                  />
                  {rows.map((r, i) => {
                    const v = trendValue(r.p, k);
                    return v == null ? null : (
                      <circle
                        key={r.d}
                        cx={x(i)}
                        cy={y(v)}
                        r={r.d === selected ? 4.5 : 2.5}
                        fill={colors[k]}
                        stroke="var(--color-bg2)"
                        strokeWidth="1"
                      >
                        <title>{`${r.d}: ${labels[k]} ${v.toLocaleString('uk-UA', { maximumFractionDigits: 1 })}`}</title>
                      </circle>
                    );
                  })}
                </g>
              );
            })}
            {rows.map((r, i) =>
              keys.every((k) => trendValue(r.p, k) == null) ? (
                <circle key={r.d} cx={x(i)} cy="140" r="2.5" fill="none" stroke="var(--color-tx3)">
                  <title>{r.d}: немає відповідей</title>
                </circle>
              ) : null,
            )}
            <line
              x1={x(index)}
              x2={x(index)}
              y1="15"
              y2="141"
              stroke="var(--color-tx3)"
              strokeDasharray="3 4"
            />
            {[
              ...new Set(
                Array.from({ length: Math.min(5, rows.length) }, (_, i) =>
                  Math.round((i / Math.max(1, Math.min(5, rows.length) - 1)) * (rows.length - 1)),
                ),
              ),
            ].map((i) => (
              <text
                key={i}
                x={x(i)}
                y="163"
                textAnchor={i === 0 ? 'start' : i === rows.length - 1 ? 'end' : 'middle'}
                className="renewal-svg-label"
              >
                {rows[i].d.slice(8)}.{rows[i].d.slice(5, 7)}
              </text>
            ))}
            <rect
              x="28"
              y="12"
              width="306"
              height="134"
              fill="transparent"
              onClick={(e) => pick(e.clientX, e.currentTarget.ownerSVGElement!)}
              onPointerMove={(e) => {
                if (e.buttons || e.pointerType === 'mouse')
                  pick(e.clientX, e.currentTarget.ownerSVGElement!);
              }}
            />
          </svg>
        )}
        <p className="renewal-chart-note">
          {keys
            .map(
              (k) =>
                `${labels[k]}: ${rows.filter((r) => trendValue(r.p, k) != null).length}/${rows.length} днів`,
            )
            .join(' · ')}
        </p>
      </figure>
    );
  }
  const sleepMax = Math.max(
    12,
    Math.ceil(Math.max(0, ...rows.map((r) => trendValue(r.p, 'sleep') ?? 0)) / 3) * 3,
  );
  return (
    <div className="renewal-trends">
      {!enabled.length && (
        <p className="renewal-inset renewal-muted">Увімкни хоча б один показник над графіком.</p>
      )}
      {plot(
        enabled.filter((k) => k !== 'sleep'),
        'Енергія та настрій',
        1,
        5,
        [1, 2, 3, 4, 5],
      )}
      {plot(
        enabled.filter((k) => k === 'sleep'),
        'Тривалість сну',
        0,
        sleepMax,
        Array.from({ length: sleepMax / 3 + 1 }, (_, i) => i * 3),
      )}
    </div>
  );
}
