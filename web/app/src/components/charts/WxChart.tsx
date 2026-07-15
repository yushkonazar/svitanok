import { useId, type ReactNode } from 'react';
import { has } from '../../lib/format.ts';

// Температура по годинах (роадмеп v3, E2) — порт 1:1 з index.html wxChart
// (2012-2114). Вісь X за реальним діапазоном годин; згладжування через середини
// відрізків; вікно дощу — пунктирні межі + плаваюча пігулка.

const W = 620;
const H = 150;
const xL = 34;
const xR = 614;
const yTop = 18;
const yBot = 116;

export function WxChart({ hourly, rainWindow }: { hourly: { h: number; t: number }[]; rainWindow?: string }) {
  const uid = useId();
  const gid = `${uid}-a`;
  const lid = `${uid}-l`;

  const pts = (hourly || []).filter((p) => p && typeof p.t === 'number' && isFinite(p.t));
  if (pts.length < 2) {
    return <div className="py-2 text-center text-xs text-muted">Недостатньо даних для графіка</div>;
  }

  const temps = pts.map((p) => p.t);
  const min = Math.min(...temps);
  const max = Math.max(...temps);
  const span = max - min || 1;
  const hs = pts.map((p) => p.h);
  const hMin = Math.min(...hs);
  const hMax = Math.max(...hs);
  const hSpan = hMax - hMin || 1;
  const X = (h: number) => xL + ((Math.max(hMin, Math.min(hMax, h)) - hMin) / hSpan) * (xR - xL);
  const Y = (t: number) => yTop + (1 - (t - min) / span) * (yBot - yTop);
  const Pt = pts.map((p) => [X(p.h), Y(p.t)] as [number, number]);

  const mid = Math.round((min + max) / 2);
  const marks = [...new Set([max, mid, min])];

  let d = `M ${Pt[0][0].toFixed(1)} ${Pt[0][1].toFixed(1)}`;
  for (let i = 1; i < Pt.length; i++) {
    const mx = (Pt[i - 1][0] + Pt[i][0]) / 2;
    const my = (Pt[i - 1][1] + Pt[i][1]) / 2;
    d += ` Q ${Pt[i - 1][0].toFixed(1)} ${Pt[i - 1][1].toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`;
  }
  d += ` L ${Pt[Pt.length - 1][0].toFixed(1)} ${Pt[Pt.length - 1][1].toFixed(1)}`;
  const area = `${d} L ${Pt[Pt.length - 1][0].toFixed(1)} ${yBot} L ${Pt[0][0].toFixed(1)} ${yBot} Z`;

  const m = has(rainWindow) ? String(rainWindow).match(/(\d{1,2}):\d{2}\D+(\d{1,2}):\d{2}/) : null;
  let band: ReactNode = null;
  if (m) {
    const rx0 = X(+m[1]);
    const rx1 = X(+m[2]);
    const label = `☔ ${+m[1]}–${+m[2]}`;
    const pillW = Math.max(46, label.length * 6.6 + 16);
    const rcx = Math.max(xL + pillW / 2, Math.min(xR - pillW / 2, (rx0 + rx1) / 2));
    band = (
      <>
        <line x1={rx0.toFixed(1)} y1={yTop} x2={rx0.toFixed(1)} y2={yBot} stroke="#4c9bff" strokeWidth="1.5" strokeDasharray="3 3" opacity="0.65" />
        <line x1={rx1.toFixed(1)} y1={yTop} x2={rx1.toFixed(1)} y2={yBot} stroke="#4c9bff" strokeWidth="1.5" strokeDasharray="3 3" opacity="0.65" />
        <rect x={(rcx - pillW / 2).toFixed(1)} y="119" width={pillW.toFixed(1)} height="18" rx="9" fill="#4c9bff" opacity="0.18" />
        <text x={rcx.toFixed(1)} y="131.5" fill="#4c9bff" fontSize="11" fontWeight="700" textAnchor="middle">
          {label}
        </text>
      </>
    );
  }

  const dotHours = new Set(pts.filter((p) => p.h % 3 === 0).map((p) => p.h));
  dotHours.add(pts[0].h);
  dotHours.add(pts[pts.length - 1].h);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="температура по годинах" style={{ width: '100%' }}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ff8a3d" stopOpacity="0.32" />
          <stop offset="1" stopColor="#ff8a3d" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={lid} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#ffb03a" />
          <stop offset="0.55" stopColor="#ff7a59" />
          <stop offset="1" stopColor="#ff6b86" />
        </linearGradient>
      </defs>
      {marks.map((v, i) => {
        const y = Y(v);
        return (
          <g key={i}>
            <line x1={xL} y1={y.toFixed(1)} x2={xR} y2={y.toFixed(1)} stroke="var(--color-border)" strokeWidth="1" />
            <text x={xL - 7} y={(y + 3.6).toFixed(1)} fill="var(--color-muted)" fontSize="11" fontWeight="600" textAnchor="end">
              {v}°
            </text>
          </g>
        );
      })}
      <path d={area} fill={`url(#${gid})`} />
      <path d={d} fill="none" stroke={`url(#${lid})`} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      {band}
      {pts.map((p, i) =>
        dotHours.has(p.h) ? (
          <circle key={`d${i}`} cx={Pt[i][0].toFixed(1)} cy={Pt[i][1].toFixed(1)} r="3" fill="var(--color-bg)" stroke="var(--color-accent)" strokeWidth="2" />
        ) : null,
      )}
      {pts
        .filter((p) => p.h % 3 === 0)
        .map((p, i) => (
          <text key={`t${i}`} x={X(p.h).toFixed(1)} y={H - 4} fill="var(--color-muted)" fontSize="11" fontWeight="600" textAnchor="middle">
            {String(p.h).padStart(2, '0')}
          </text>
        ))}
    </svg>
  );
}
