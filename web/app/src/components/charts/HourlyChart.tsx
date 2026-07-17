import { useId } from 'react';
import { useInView } from '../../lib/useInView.ts';
import { has } from '../../lib/format.ts';
import { kyivMinutes } from '../../lib/weather.ts';

// Температура по годинах (дизайн v2, Svitanok.dc.html). viewBox 330×88:
// xL=26 — поле під підписи осі Y; сітка на y=14/42/70 (макс/серед/мін); крива —
// згладжений безьє з градієнтом #FFA45C→#FF6E7A, заливка донизу; вікно опадів —
// пунктирний прямокутник; маркер — поточна година.

const W = 330;
const H = 88;
const XL = 26;
const XR = 330;
const Y_TOP = 14;
const Y_BOT = 70;

export function HourlyChart({
  hourly,
  rainWindow,
}: {
  hourly: { h: number; t: number }[];
  rainWindow?: string;
}) {
  const uid = useId();
  // Хук ДО раннього return («недостатньо даних») — порядок хуків сталий.
  const [ref, inView] = useInView<SVGSVGElement>();
  const play = inView ? 'running' : 'paused';
  const lineId = `${uid}-l`;
  const fillId = `${uid}-f`;

  const pts = (hourly || []).filter((p) => p && typeof p.t === 'number' && isFinite(p.t));
  if (pts.length < 2) {
    return <div className="py-2 text-center font-mono text-[9.5px] text-tx3">НЕДОСТАТНЬО ДАНИХ</div>;
  }

  const temps = pts.map((p) => p.t);
  const min = Math.min(...temps);
  const max = Math.max(...temps);
  const span = max - min || 1;
  const hs = pts.map((p) => p.h);
  const hMin = Math.min(...hs);
  const hMax = Math.max(...hs);
  const hSpan = hMax - hMin || 1;

  const X = (h: number) => XL + ((Math.max(hMin, Math.min(hMax, h)) - hMin) / hSpan) * (XR - XL);
  const Y = (t: number) => Y_TOP + (1 - (t - min) / span) * (Y_BOT - Y_TOP);
  const P = pts.map((p) => [X(p.h), Y(p.t)] as [number, number]);

  // Згладжування через середини відрізків (control = попередня точка).
  let d = `M${P[0][0].toFixed(1)} ${P[0][1].toFixed(1)}`;
  for (let i = 1; i < P.length; i++) {
    const mx = (P[i - 1][0] + P[i][0]) / 2;
    const my = (P[i - 1][1] + P[i][1]) / 2;
    d += ` Q${P[i - 1][0].toFixed(1)} ${P[i - 1][1].toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`;
  }
  d += ` L${P[P.length - 1][0].toFixed(1)} ${P[P.length - 1][1].toFixed(1)}`;
  const area = `${d} L${P[P.length - 1][0].toFixed(1)} ${H} L${P[0][0].toFixed(1)} ${H} Z`;

  // Вісь Y: макс / середина / мін — рівно на лініях сітки макета.
  const mid = Math.round((min + max) / 2);
  const marks: [number, number][] = [
    [max, Y_TOP],
    [mid, (Y_TOP + Y_BOT) / 2],
    [min, Y_BOT],
  ];

  // Вікно опадів «15:00–17:00».
  const m = has(rainWindow) ? String(rainWindow).match(/(\d{1,2}):\d{2}\D+(\d{1,2}):\d{2}/) : null;
  const rain = m ? { x0: X(+m[1]), x1: X(+m[2]), label: `ОПАДИ ${m[1]}:00–${m[2]}:00` } : null;

  // До 5 міток, рівномірно по РЯДУ (не по годинах): гарантує підписи за
  // будь-якого діапазону — і 8…23 зранку, і 20…23 увечері.
  const LABELS = Math.min(5, pts.length);
  const labelPts =
    LABELS <= 1
      ? pts.slice(0, 1)
      : Array.from({ length: LABELS }, (_, i) => pts[Math.round((i * (pts.length - 1)) / (LABELS - 1))]);

  // Маркер — поточна година (притиснута до діапазону даних).
  const nowH = kyivMinutes(new Date()) / 60;
  const nowX = X(nowH);
  // Інтерполяція t для поточної години (лінійна між сусідніми точками).
  const clampedH = Math.max(hMin, Math.min(hMax, nowH));
  let nowY = P[P.length - 1][1];
  for (let i = 1; i < pts.length; i++) {
    if (clampedH <= pts[i].h) {
      const a = pts[i - 1];
      const b = pts[i];
      const k = b.h === a.h ? 0 : (clampedH - a.h) / (b.h - a.h);
      nowY = Y(a.t + (b.t - a.t) * k);
      break;
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-between font-mono text-[9.5px] font-medium text-tx3">
        <span>ТЕМПЕРАТУРА ПО ГОДИНАХ</span>
        {rain && <span className="text-info">{rain.label}</span>}
      </div>
      <svg
        ref={ref}
        width="100%"
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="температура по годинах"
      >
        <defs>
          <linearGradient id={lineId} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#FFA45C" />
            <stop offset="1" stopColor="#FF6E7A" />
          </linearGradient>
          <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="rgba(255,138,110,.26)" />
            <stop offset="1" stopColor="rgba(255,138,110,0)" />
          </linearGradient>
        </defs>

        {rain && (
          <rect
            x={rain.x0.toFixed(1)}
            y="6"
            width={Math.max(0, rain.x1 - rain.x0).toFixed(1)}
            height="72"
            rx="7"
            fill="rgba(155,166,255,.13)"
            stroke="rgba(155,166,255,.28)"
            strokeDasharray="2 3"
          />
        )}

        {marks.map(([v, y], i) => (
          <g key={i}>
            <line x1={XL} y1={y} x2={XR} y2={y} stroke="var(--color-hair)" />
            <text x="0" y={y + 3} fill="var(--color-tx3)" fontFamily="JetBrains Mono Variable" fontSize="9">
              {v}°
            </text>
          </g>
        ))}

        {/* Заливка проявляється, поки крива малюється — інакше стояла б готовою
            під олівцем, що ще їде. */}
        <path
          d={area}
          fill={`url(#${fillId})`}
          style={{ animation: 'fadeInSoft .9s ease-out backwards', animationPlayState: play }}
        />
        {/* Крива йде зліва направо — так само, як читається час на осі.
            pathLength="1" нормалізує довжину: CSS не знає її в пікселях. */}
        <path
          d={d}
          pathLength="1"
          fill="none"
          stroke={`url(#${lineId})`}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray="1"
          strokeDashoffset="0"
          style={{
            animation: 'lineDraw .9s cubic-bezier(.4,0,.2,1) backwards',
            animationPlayState: play,
          }}
        />
        {/* Крапка «зараз» спливає, коли крива до неї доїхала. */}
        <circle
          cx={nowX.toFixed(1)}
          cy={nowY.toFixed(1)}
          r="3.5"
          fill="#FFA45C"
          stroke="var(--color-bg)"
          strokeWidth="2"
          style={{
            animation:
              'pop .3s cubic-bezier(.22,1,.36,1) .8s backwards, fadeInSoft .3s ease-out .8s backwards',
            animationPlayState: play,
          }}
        />
      </svg>
      {/* Підписи годин позиціонуємо за РЕАЛЬНИМ X(h), а не justify-between:
          ряд hourly починається з поточної години (напр. 8…23), тож рівномірний
          розподіл ставив би мітки не над їхніми точками, а ввечері (19…23) не
          лишав би жодної. SVG розтягується (preserveAspectRatio="none"), тож
          X(h)/W*100% дає точний збіг із кривою за будь-якої ширини. */}
      <div className="relative h-3 font-mono text-[9.5px] font-medium text-tx3">
        {labelPts.map((p) => (
          <span
            key={p.h}
            className="absolute -translate-x-1/2 whitespace-nowrap"
            style={{ left: `${((X(p.h) / W) * 100).toFixed(2)}%` }}
          >
            {String(p.h).padStart(2, '0')}
          </span>
        ))}
      </div>
    </div>
  );
}
