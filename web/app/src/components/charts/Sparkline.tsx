import { useId } from 'react';
import { useInView } from '../../lib/useInView.ts';

// Спарклайн (дизайн v2, Svitanok.dc.html): лінія з градієнтом a2→a1 + м'яка
// заливка донизу + крапка на останній точці. Використовує блок «Подачі · 8 тижнів».

export function Sparkline({ values, w = 330, h = 52 }: { values: number[]; w?: number; h?: number }) {
  const uid = useId();
  // Хук ДО раннього return («недостатньо даних») — порядок хуків сталий.
  const [ref, inView] = useInView<SVGSVGElement>();
  const lineId = `${uid}-l`;
  const fillId = `${uid}-f`;

  const pts = values.filter((v) => Number.isFinite(v));
  if (pts.length < 2) {
    return <div className="py-1 font-mono text-[9.5px] text-tx3">НЕДОСТАТНЬО ДАНИХ</div>;
  }

  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = max - min || 1;
  const pad = 10;
  const step = w / (pts.length - 1);
  const coords = pts.map((v, i) => ({
    x: i * step,
    y: pad + (h - pad * 2) * (1 - (v - min) / span),
  }));

  const line = coords.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(0)} ${p.y.toFixed(0)}`).join(' ');
  const last = coords[coords.length - 1];
  const area = `${line} L${w} ${h} L0 ${h} Z`;

  return (
    <svg
      ref={ref}
      width="100%"
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="динаміка подач"
    >
      <defs>
        <linearGradient id={lineId} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#FFA45C" />
          <stop offset="1" stopColor="#FF6E7A" />
        </linearGradient>
        <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="rgba(255,138,110,.24)" />
          <stop offset="1" stopColor="rgba(255,138,110,0)" />
        </linearGradient>
      </defs>
      {/* Заливка проявляється, поки лінія малюється — інакше вона стояла б
          готовою під олівцем, що ще їде. */}
      <path d={area} fill={`url(#${fillId})`} style={{ animation: 'fadeInSoft .9s ease-out backwards', animationPlayState: inView ? 'running' : 'paused' }} />
      {/* pathLength="1" нормалізує довжину шляху в одиницю — без цього CSS не
          знає, скільки там пікселів, і намалювати лінію «від початку до кінця»
          нічим. dashoffset у DOM = 0, тобто лінія намальована; кадр лише каже,
          звідки приїхати. */}
      <path
        d={line}
        pathLength="1"
        fill="none"
        stroke={`url(#${lineId})`}
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray="1"
        strokeDashoffset="0"
        style={{
          animation: 'lineDraw .9s cubic-bezier(.4,0,.2,1) backwards',
          animationPlayState: inView ? 'running' : 'paused',
        }}
      />
      {/* Крапка «сьогодні» зʼявляється, коли лінія до неї доїхала. */}
      <circle
        cx={last.x.toFixed(0)}
        cy={last.y.toFixed(0)}
        r="3.5"
        fill="#FF6E7A"
        stroke="var(--color-bg)"
        strokeWidth="2"
        style={{
          animation:
            'pop .3s cubic-bezier(.22,1,.36,1) .8s backwards, fadeInSoft .3s ease-out .8s backwards',
          animationPlayState: inView ? 'running' : 'paused',
        }}
      />
    </svg>
  );
}
