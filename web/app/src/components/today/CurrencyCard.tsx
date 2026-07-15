import type { Brief, CurrencyData } from '../../api/briefing-schema.ts';
import { readBlock, currencyDataSchema } from '../../api/briefing-schema.ts';
import { has } from '../../lib/format.ts';
import { Card, Ph } from '../ui/primitives.tsx';
import { Expandable } from '../ui/Expandable.tsx';
import { Sparkline } from '../charts/Sparkline.tsx';
import { DeltaBadge } from './badges.tsx';

// Курс НБУ (роадмеп v3, E2) — 1:1 з index.html currencyCard (2186-2221). Одна
// валюта в рядок; тап розкриває дельту+спарклайн лише цього рядка.

const DEFS = [
  { key: 'usd', hk: 'usdHistory', flag: '🇺🇸', label: 'USD' },
  { key: 'eur', hk: 'eurHistory', flag: '🇪🇺', label: 'EUR' },
  { key: 'pln', hk: 'plnHistory', flag: '🇵🇱', label: 'PLN' },
  { key: 'gbp', hk: 'gbpHistory', flag: '🇬🇧', label: 'GBP' },
] as const;

function CurrencyRow({ d, def }: { d: CurrencyData; def: (typeof DEFS)[number] }) {
  const value = d[def.key] as number;
  const hist = d[def.hk] as number[] | undefined;

  const base = (
    <div className="flex items-center justify-between py-2">
      <span className="text-sm font-medium">
        {def.flag} {def.label}
      </span>
      <span className="text-lg font-bold">{value}</span>
    </div>
  );

  const more =
    hist && hist.length >= 2 ? (
      <div className="pb-2">
        <div className="mb-1 flex items-center gap-2 text-sm">
          <DeltaBadge curr={value} prev={hist[hist.length - 2]} digits={2} unit=" грн" />
          <span className="text-muted">за {hist.length} дн.</span>
        </div>
        <Sparkline values={hist} w={480} h={48} />
      </div>
    ) : (
      <Ph>Історія з’явиться згодом</Ph>
    );

  return <Expandable base={base} more={more} />;
}

export function CurrencyCard({ brief }: { brief: Brief }) {
  const d = readBlock(brief.blocks, 'currency', currencyDataSchema);
  const rows = d ? DEFS.filter((def) => has(d[def.key])) : [];
  return (
    <Card title="Курс НБУ">
      {rows.length && d ? (
        <div className="divide-y divide-border/50">
          {rows.map((def) => (
            <CurrencyRow key={def.key} d={d} def={def} />
          ))}
        </div>
      ) : (
        <Ph>Курс валют недоступний</Ph>
      )}
    </Card>
  );
}
