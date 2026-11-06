import { stateDays } from './state-format.ts';
import { stateBand, stateBandNames, type RatedMetric } from './state-series.ts';

export function StateBandLegend({
  metric,
  counts,
}: {
  metric: RatedMetric;
  counts?: readonly number[];
}) {
  return (
    <div className="state-band-legend">
      {stateBandNames[metric].map((name, index) => (
        <span key={name}>
          <i className={`state-band-${index}`} aria-hidden="true" />
          {name}
          {counts ? ` · ${counts[index]}` : ''}
        </span>
      ))}
    </div>
  );
}

export function StateBands({ counts, metric }: { counts: readonly number[]; metric: RatedMetric }) {
  return (
    <span
      className="state-bands"
      role="img"
      aria-label={stateBandNames[metric]
        .map((name, index) => `${name} · ${stateDays(counts[index] ?? 0)}`)
        .join('. ')}
    >
      {counts.map((count, index) => (
        <span key={index} className={`state-band-${index}`} style={{ flexGrow: count }} />
      ))}
    </span>
  );
}

export function StateChangeAxis() {
  return (
    <div className="state-change-axis" aria-hidden="true">
      {stateBandNames.change.map((name) => (
        <span key={name}>{name}</span>
      ))}
    </div>
  );
}

export function StateChangeBar({ value, index }: { value: number; index: number }) {
  const percent = Math.min(50, (Math.abs(value) / 4) * 50);
  return (
    <span
      className="state-change-track"
      role="img"
      aria-label={stateBandNames.change[stateBand(value, 'change')]}
    >
      <span
        className={value === 0 ? 'is-zero' : undefined}
        style={{
          left: `${value < 0 ? 50 - percent : 50}%`,
          width: `${percent}%`,
          background: index ? 'var(--color-a2)' : 'var(--color-info)',
        }}
      />
    </span>
  );
}

export function StateLevel({
  value,
  color,
  scale = 5,
}: {
  value: number;
  color: string;
  scale?: number;
}) {
  return (
    <span className="state-level" aria-hidden="true">
      {Array.from({ length: scale }, (_, index) => (
        <i key={index} style={index < value ? { background: color } : undefined} />
      ))}
    </span>
  );
}
