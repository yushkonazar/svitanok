import { useId } from 'react';
import type { CurrencyData } from '../../api/briefing-schema.ts';
import { has } from '../../lib/format.ts';
import { SectionLabel, Ph } from '../ui/primitives.tsx';

// Курс НБУ (дизайн v2, Svitanok.dc.html): рядок на валюту — кружечок-символ,
// код, міні-спарклайн, дельта, велике значення. Перша валюта акцентована
// (кораловий бейдж + градієнтний спарклайн), решта — приглушені.

const DEFS = [
  { key: 'usd', hk: 'usdHistory', sym: '$', label: 'USD' },
  { key: 'eur', hk: 'eurHistory', sym: '€', label: 'EUR' },
  { key: 'pln', hk: 'plnHistory', sym: 'zł', label: 'PLN' },
  { key: 'gbp', hk: 'gbpHistory', sym: '£', label: 'GBP' },
] as const;

const SW = 58;
const SH = 18;
const PAD = 2;

function Spark({ hist, accent, gradId }: { hist: number[]; accent: boolean; gradId: string }) {
  const pts = hist.filter((v) => Number.isFinite(v));
  if (pts.length < 2) return <div style={{ width: SW, height: SH }} />;
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = max - min || 1;
  const step = (SW - PAD * 2) / (pts.length - 1);
  const d = pts
    .map((v, i) => {
      const x = PAD + i * step;
      const y = PAD + (SH - PAD * 2) * (1 - (v - min) / span);
      return `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg width={SW} height={SH} viewBox={`0 0 ${SW} ${SH}`} className="flex-none">
      <path
        d={d}
        fill="none"
        stroke={accent ? `url(#${gradId})` : 'var(--color-tx3)'}
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function CurrencyBlock({ d, date }: { d: CurrencyData | null; date: string | null }) {
  const gradId = useId();
  const rows = d ? DEFS.filter((def) => has(d[def.key])) : [];

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <SectionLabel>КУРС НБУ</SectionLabel>
        {/* дата — з брифінгу, не з годинника пристрою: інакше вчорашні курси
            підписувались би сьогоднішнім числом */}
        {date && <span className="ml-auto font-mono text-[10px] font-medium text-tx3">{date}</span>}
      </div>

      {rows.length && d ? (
        <>
          <svg width="0" height="0" className="absolute">
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="0">
                <stop offset="0" stopColor="#FFA45C" />
                <stop offset="1" stopColor="#FF6E7A" />
              </linearGradient>
            </defs>
          </svg>
          {rows.map((def, i) => {
            const value = d[def.key] as number;
            const hist = (d[def.hk] as number[] | undefined) ?? [];
            const prev = hist.length >= 2 ? hist[hist.length - 2] : null;
            const dd = prev != null ? value - prev : null;
            const accent = i === 0;
            return (
              <div key={def.key} className="flex items-center gap-2.5 py-1.5">
                <div
                  className="grid h-7 w-7 flex-none place-items-center rounded-full border font-mono text-xs font-bold"
                  style={
                    accent
                      ? {
                          background: 'rgba(255,164,92,.12)',
                          borderColor: 'rgba(255,164,92,.28)',
                          color: 'var(--color-a2)',
                        }
                      : {
                          background: 'var(--color-glass)',
                          borderColor: 'var(--color-glassb)',
                          color: 'var(--color-tx2)',
                        }
                  }
                >
                  {def.sym}
                </div>
                <span className="w-[34px] font-mono text-xs font-semibold">{def.label}</span>
                <Spark hist={hist} accent={accent} gradId={gradId} />
                {dd != null && (
                  <span
                    className="font-mono text-[10.5px] font-medium"
                    style={{ color: dd > 0 ? 'var(--color-pos)' : dd < 0 ? 'var(--color-neg)' : 'var(--color-tx3)' }}
                  >
                    {dd > 0 ? '↑' : dd < 0 ? '↓' : '→'}
                    {Math.abs(dd).toFixed(2)}
                  </span>
                )}
                {/* toFixed(2) — як у макеті: без нього 59.4 губить хвостовий
                    нуль і колонка значень «стрибає» в моно-шрифті */}
                <span className="ml-auto font-mono text-base font-semibold">{value.toFixed(2)}</span>
              </div>
            );
          })}
        </>
      ) : (
        <Ph>Курс валют недоступний</Ph>
      )}
    </div>
  );
}
