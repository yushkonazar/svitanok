import { useId } from 'react';
import { useTick } from '../../lib/useTick.ts';
import { fmtClock, fmtDur } from '../../lib/weather.ts';

// Добово-нічний циферблат погоди (роадмеп v3, E2) — порт 1:1 з index.html
// wxDial (1870-1991). Коло 260×232: верхня півкуля=день, нижня=ніч; маркер їде
// повним колом за поточним часом; стани мають власні палітри. Живий тик — 30с.

interface Palette {
  card: string;
  shadow: string;
  progA: string;
  progB: string;
  bezel: string;
  hairline: string;
  ticks: string;
  horizon: string;
  glossOp: number;
  glow: string;
  marker: string;
  timeText: string;
  subText: string;
  rsVal: string;
  rsLabel: string;
}

const DIAL_DAY: Palette = {
  card: '#F1F2F6',
  shadow: '0 16px 36px -26px rgba(31,36,48,0.28)',
  progA: '#D2D5DE',
  progB: '#FF7A00',
  bezel: '#D8DBE4',
  hairline: '#F2F3F6',
  ticks: '#E3E5EC',
  horizon: '#E8D9BE',
  glossOp: 0.5,
  glow: '#FF9F1C',
  marker: '#FF7A00',
  timeText: '#1F2430',
  subText: '#B87400',
  rsVal: '#1F2430',
  rsLabel: '#8A90A2',
};

const DIAL_NIGHT: Palette = {
  card: '#20222E',
  shadow: '0 16px 36px -26px rgba(10,12,30,0.5)',
  progA: '#3A4380',
  progB: '#8C95C4',
  bezel: '#454E8A',
  hairline: '#242A52',
  ticks: '#333B6E',
  horizon: '#2A3163',
  glossOp: 0.1,
  glow: '#C9D2FF',
  marker: '#5B65A8',
  timeText: '#F2F3FF',
  subText: '#9AA6E8',
  rsVal: '#E7E9F7',
  rsLabel: '#8C95C4',
};

const STARS: [number, number, number, number][] = [
  [100, 150, 1.3, 0.9],
  [160, 145, 1.1, 0.8],
  [130, 185, 1.3, 0.85],
  [85, 175, 1.1, 0.75],
  [175, 170, 1.1, 0.8],
  [65, 140, 1, 0.6],
  [195, 140, 1, 0.6],
  [150, 122, 1, 0.65],
];

export function WxDial({ sr, ss }: { sr: number; ss: number }) {
  useTick(30_000); // ре-рендер що 30с
  const uid = useId();
  const id = (k: string) => `${uid}-${k}`;

  const nowSec = Date.now() / 1000;
  const valid = !!sr && !!ss && ss > sr;

  let isDay = true;
  let f = 0.5;
  let nextEventSec: number | null = null;
  let nextLabel = '';
  if (valid) {
    if (nowSec >= sr && nowSec <= ss) {
      isDay = true;
      f = (nowSec - sr) / (ss - sr);
      nextEventSec = ss;
      nextLabel = 'заходу';
    } else {
      isDay = false;
      if (nowSec < sr) {
        const prevSunset = ss - 86400;
        f = (nowSec - prevSunset) / (sr - prevSunset);
        nextEventSec = sr;
      } else {
        const nextSunrise = sr + 86400;
        f = (nowSec - ss) / (nextSunrise - ss);
        nextEventSec = nextSunrise;
      }
      nextLabel = 'сходу';
    }
  }
  f = Math.max(0, Math.min(1, f));

  const deg = (isDay ? 180 : 0) + 180 * f;
  const rad = (deg * Math.PI) / 180;
  const nowX = 130 + 84 * Math.cos(rad);
  const nowY = 110 + 84 * Math.sin(rad);
  const startX = isDay ? 46 : 214;
  const largeArc = 180 * f > 180 ? 1 : 0;

  const P = isDay ? DIAL_DAY : DIAL_NIGHT;

  const upPt = isDay ? [214, 110] : [46, 110];
  const pastPt = isDay ? [46, 110] : [214, 110];
  const pastCol = isDay ? '#C9CDD8' : '#3A4380';
  const upCol = isDay ? '#FF9F1C' : '#FFD59A';
  const upHalo = isDay ? 0.25 : 0.3;

  const cyTime = isDay ? 72 : 148;
  const sub = valid
    ? `до ${nextLabel} ${fmtDur(Math.max(0, Math.round(((nextEventSec as number) - nowSec) / 60)))}`
    : '';
  const aria = valid
    ? `Зараз ${isDay ? 'день' : 'ніч'}. Схід о ${fmtClock(sr)}, захід о ${fmtClock(ss)}. ${sub}`
    : 'Схід і захід сонця';

  return (
    <div
      className="flex flex-col gap-2 rounded-2xl p-3"
      style={{ background: P.card, boxShadow: P.shadow }}
    >
      <svg viewBox="0 0 260 232" role="img" aria-label={aria} style={{ width: '100%' }}>
        <defs>
          <clipPath id={id('ct')}>
            <rect x="0" y="0" width="260" height="110" />
          </clipPath>
          <clipPath id={id('cb')}>
            <rect x="0" y="110" width="260" height="122" />
          </clipPath>
          <clipPath id={id('cf')}>
            <circle cx="130" cy="110" r="84" />
          </clipPath>
          <linearGradient id={id('domeD')} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#FFFFFF" />
            <stop offset="1" stopColor="#FFE3B8" />
          </linearGradient>
          <linearGradient id={id('domeN')} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#1B2140" />
            <stop offset="1" stopColor="#0D1128" />
          </linearGradient>
          <linearGradient id={id('prog')} x1="0" y1="1" x2="1" y2="0">
            <stop offset="0" stopColor={P.progA} />
            <stop offset="1" stopColor={P.progB} />
          </linearGradient>
          <radialGradient id={id('gloss')} cx="0.32" cy="0.28" r="0.6">
            <stop offset="0" stopColor="#FFFFFF" stopOpacity={P.glossOp} />
            <stop offset="1" stopColor="#FFFFFF" stopOpacity={0} />
          </radialGradient>
          <radialGradient id={id('glow')} cx="0.5" cy="0.5" r="0.5">
            <stop offset="0" stopColor={P.glow} stopOpacity={0.45} />
            <stop offset="1" stopColor={P.glow} stopOpacity={0} />
          </radialGradient>
        </defs>

        <circle cx="130" cy="110" r="84" fill={`url(#${id('domeD')})`} clipPath={`url(#${id('ct')})`} />
        <circle cx="130" cy="110" r="84" fill={`url(#${id('domeN')})`} clipPath={`url(#${id('cb')})`} />
        <g clipPath={`url(#${id('cf')})`} opacity={isDay ? 0.55 : 1}>
          {STARS.map(([x, y, r, o], i) => (
            <circle key={i} cx={x} cy={y} r={r} fill="#B9C2F0" opacity={o} />
          ))}
          <circle cx="115" cy="128" r="10" fill="#B9C2F0" opacity="0.12" />
          <circle cx="115" cy="128" r="1.3" fill="#E4E9FF" opacity="0.95" />
        </g>
        <circle cx="130" cy="110" r="84" fill={`url(#${id('gloss')})`} clipPath={`url(#${id('cf')})`} />
        <circle cx="130" cy="110" r="84" fill="none" stroke={P.bezel} strokeWidth="2" />
        <circle cx="130" cy="110" r="88" fill="none" stroke={P.hairline} strokeWidth="1" />
        <g stroke={P.ticks} strokeWidth="1.5" strokeLinecap="round">
          <line x1="190.81" y1="170.81" x2="195.76" y2="175.76" />
          <line x1="69.19" y1="170.81" x2="64.24" y2="175.76" />
          <line x1="69.19" y1="49.19" x2="64.24" y2="44.24" />
          <line x1="190.81" y1="49.19" x2="195.76" y2="44.24" />
        </g>
        <line x1="46" y1="110" x2="214" y2="110" stroke={P.horizon} strokeWidth="1.5" />
        <path
          d={`M ${startX},110 A 84,84 0 ${largeArc} 1 ${nowX.toFixed(2)},${nowY.toFixed(2)}`}
          fill="none"
          stroke={`url(#${id('prog')})`}
          strokeWidth="3"
          strokeLinecap="round"
        />

        {/* кінцеві крапки */}
        <circle cx={pastPt[0]} cy={pastPt[1]} r="4" fill={pastCol} />
        <circle cx={upPt[0]} cy={upPt[1]} r="8" fill={upCol} opacity={upHalo} />
        <circle cx={upPt[0]} cy={upPt[1]} r="4.5" fill={upCol} />

        {/* сонце в зеніті */}
        {isDay ? (
          <>
            <circle cx="130" cy="26" r="15" fill={`url(#${id('glow')})`} />
            <circle cx="130" cy="26" r="7" fill="#FFB020" />
          </>
        ) : (
          <g opacity="0.35">
            <circle cx="130" cy="26" r="7" fill="#FFB020" />
          </g>
        )}

        {/* місяць-серп у надирі */}
        {!isDay && <circle cx="130" cy="194" r="17" fill={`url(#${id('glow')})`} />}
        <g opacity={isDay ? 0.4 : 1}>
          <circle cx="130" cy="194" r="9" fill="#E4E9FF" />
          <circle cx="134" cy="191" r="7.5" fill="#0D1128" />
        </g>

        {/* маркер «зараз» */}
        <circle cx={nowX.toFixed(2)} cy={nowY.toFixed(2)} r="11" fill={`url(#${id('glow')})`} />
        <circle
          cx={nowX.toFixed(2)}
          cy={nowY.toFixed(2)}
          r="5.5"
          fill="#FFFFFF"
          stroke={P.marker}
          strokeWidth="2.5"
        />

        {/* центральний зчитувач */}
        <text
          x="130"
          y={cyTime}
          textAnchor="middle"
          fontSize="26"
          fontWeight="800"
          fill={P.timeText}
          style={{ letterSpacing: '-0.01em' }}
        >
          {fmtClock(nowSec)}
        </text>
        {sub && (
          <text x="130" y={cyTime + 16} textAnchor="middle" fontSize="11" fontWeight="700" fill={P.subText}>
            {sub}
          </text>
        )}
      </svg>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <span>🌅</span>
          <div>
            <div className="text-sm font-semibold" style={{ color: P.rsVal }}>
              {fmtClock(sr)}
            </div>
            <div className="text-[11px]" style={{ color: P.rsLabel }}>
              схід
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="text-right">
            <div className="text-sm font-semibold" style={{ color: P.rsVal }}>
              {fmtClock(ss)}
            </div>
            <div className="text-[11px]" style={{ color: P.rsLabel }}>
              захід
            </div>
          </div>
          <span>🌇</span>
        </div>
      </div>
    </div>
  );
}
