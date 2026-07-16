import type { Stats } from '../../api/schema.ts';
import { has } from '../../lib/format.ts';
import { SectionHead, StatRow, Ph } from '../ui/primitives.tsx';

// E · Надійність (дизайн v2, Svitanok.dc.html): доставка вчасно (зелена) +
// спрацювання dead-man.

export function ReliabilityBlock({ s }: { s: Stats }) {
  const r = s.reliability;
  const hasData = has(r.total) && r.total > 0;
  return (
    <div className="flex flex-col gap-2.5">
      <SectionHead>Надійність</SectionHead>
      {hasData ? (
        <>
          <StatRow
            label="Доставка брифінгу вчасно"
            value={`${r.onTime} / ${r.total} днів`}
            valueClass="text-pos"
          />
          {has(r.deadman) && <StatRow label="Dead-man спрацювань" value={r.deadman} />}
        </>
      ) : (
        <Ph>Дані про стабільність доставки з’являться згодом</Ph>
      )}
    </div>
  );
}
