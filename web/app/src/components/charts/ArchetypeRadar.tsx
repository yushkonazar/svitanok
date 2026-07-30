import type { Stats } from '../../api/schema.ts';
import { INDEX_COLOR, INDEX_LABEL, INDEX_ORDER } from '../../lib/checkinIndex.ts';

// Архетипи днів — k-means (checkin-model.mjs) на 5 композитних індексах, БЕЗ
// PRNG (детермінований maxmin-init), тож ідентичний результат при кожному
// перерахунку. Замість «середнього дня» (якого не існує) — 3-4 ТИПИ днів із
// частотою: мала мозаїка радарів, одна форма на тип, а не таблиця чисел.

const SIZE = 92;
const R = 34;
const CX = SIZE / 2;
const CY = SIZE / 2 - 2;

function point(i: number, value: number): [number, number] {
  const angle = -Math.PI / 2 + (i / INDEX_ORDER.length) * 2 * Math.PI;
  const r = R * Math.max(0, Math.min(1, value));
  return [CX + r * Math.cos(angle), CY + r * Math.sin(angle)];
}

function ringPath(scale: number): string {
  return (
    INDEX_ORDER.map((_, i) => point(i, scale).join(',')).join(' L ').replace(/^/, 'M ') + ' Z'
  );
}

type Group = Stats['checkinModel']['archetypes']['groups'][number];

function RadarCard({ g }: { g: Group }) {
  const path = INDEX_ORDER.map((idx, k) => point(k, g.profile[idx] ?? 0).join(',')).join(' L ');
  return (
    <div className="flex flex-col items-center gap-1">
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} width={SIZE} height={SIZE}>
        <path d={ringPath(1)} fill="none" stroke="var(--color-hair)" strokeWidth="1" />
        <path d={ringPath(0.5)} fill="none" stroke="var(--color-hair)" strokeWidth="1" />
        <path
          d={`M ${path} Z`}
          fill="var(--color-a2)"
          fillOpacity="0.22"
          stroke="var(--color-a2)"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
        {INDEX_ORDER.map((idx, k) => {
          const [x, y] = point(k, g.profile[idx] ?? 0);
          return <circle key={idx} cx={x} cy={y} r={2.2} fill={INDEX_COLOR[idx]} />;
        })}
      </svg>
      <span className="font-mono text-[13px] font-semibold text-tx">
        {Math.round(g.share * 100)}%
      </span>
      <span className="text-center text-[9.5px] leading-tight text-tx3">
        {INDEX_LABEL[g.top]}
        <br />
        <span className="opacity-70">слабке: {INDEX_LABEL[g.low]}</span>
      </span>
    </div>
  );
}

export function ArchetypeRadar({ archetypes }: { archetypes: Stats['checkinModel']['archetypes'] }) {
  if (!archetypes.ready || !archetypes.groups.length) return null;
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap justify-around gap-2">
        {archetypes.groups.map((g, i) => (
          <RadarCard key={i} g={g} />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[9.5px] text-tx3">
        {INDEX_ORDER.map((idx) => (
          <span key={idx} className="flex items-center gap-1">
            <span
              className="inline-block h-[6px] w-[6px] rounded-full"
              style={{ background: INDEX_COLOR[idx] }}
            />
            {INDEX_LABEL[idx]}
          </span>
        ))}
      </div>
    </div>
  );
}
