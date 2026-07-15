import type { Stats } from '../../api/schema.ts';
import { has } from '../../lib/format.ts';
import { Card, StatLine, Ph } from '../ui/primitives.tsx';

// E · Надійність (роадмеп v3, E1) — index.html:2586-2597.

export function ReliabilityBlock({ s }: { s: Stats }) {
  const r = s.reliability;
  const hasData = has(r.total) && r.total > 0;
  return (
    <Card title="🛡 E · Надійність">
      {hasData ? (
        <>
          <StatLine first label="Доставка вчасно" value={`${r.onTime}/${r.total} днів`} />
          {has(r.deadman) && <StatLine label="Dead-man спрацювань" value={r.deadman} />}
        </>
      ) : (
        <Ph>Дані про стабільність доставки з’являться згодом</Ph>
      )}
    </Card>
  );
}
