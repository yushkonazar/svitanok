import { useId } from 'react';
import { useTick } from '../../lib/useTick.ts';
import { kyivMinutes, kyivMinutesFromUnix, kyivClockNow } from '../../lib/weather.ts';
import { CX, CY, R, SIZE, sunGeom, segPath, readout, subLabel } from './sundial-geom.ts';

// Добовий циферблат — вигляд «Небо» (фідбек власника, п.1).
//
// Геометрія (чому верх кола = сонячний полудень, а не 12:00) — у sundial-geom.ts,
// там же тести. Тут лише малювання.
//
// Що змінилось проти макета Svitanok.dc.html: небо більше НЕ вшитий градієнт із
// хардкодним стопом на 55% — воно рахується. Колір тече за висотою сонця: у
// зеніті бліде тепле, на золотій годині весь денний сегмент іде в корал, щойно
// за обрієм — фіолетова заграва, глибокої ночі — майже чорне. Статичне сонце в
// зеніті, хмари й декоративний місяць прибрано: був абсурд, коли о 3-й ночі в
// небі висіло намальоване сонце. Тепер один обʼєкт, який кружляє (сонце вдень,
// місяць уночі) — і він же підсвічує небо довкола себе.
//
// Живий тик — 30с. За 30с обʼєкт проходить 0.125° (≈0.17px), тобто сам по собі
// рух непомітний; transition потрібен для іншого — коли апку розгорнули через
// кілька годин, useTick смикає ререндер, і без переходу обʼєкт би стрибнув.

const TICK_MS = 30_000;

/** Зорі: [x, y, r] у координатах viewBox + [тривалість, затримка] мерехтіння
    (різні — щоб не блимали в такт). Живуть у нижній половині кола. */
const STARS: Array<[number, number, number, string, string]> = [
  [30, 118, 1.5, '3s', '0s'],
  [58, 142, 1, '2.4s', '.4s'],
  [78, 124, 1.25, '3.4s', '.8s'],
  [124, 108, 1, '2.8s', '.2s'],
  [104, 150, 0.9, '3.1s', '1.1s'],
  [142, 134, 1.1, '2.6s', '.6s'],
  [46, 96, 0.8, '3.6s', '1.4s'],
  [136, 92, 0.85, '2.2s', '.9s'],
];

const hex = (h: string): [number, number, number] => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];
const rgb = (a: number[]) => `#${a.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
const mix = (a: string, b: string, t: number) => {
  const k = Math.min(1, Math.max(0, t));
  const [ar, ag, ab] = hex(a);
  const [br, bg, bb] = hex(b);
  return rgb([ar + (br - ar) * k, ag + (bg - ag) * k, ab + (bb - ab) * k]);
};

/**
 * Денне небо: у зеніті глибше, до обрію світліше (серпанок); що нижче сонце —
 * то більше корала.
 *
 * ⚠️ Напрямок градієнта саме такий, і це не смак. Спершу я зробив навпаки —
 * найсвітліше вгорі — і воно (а) виглядало вигорілим, (б) не лишало сонцю на
 * чому читатись: білий диск на небі #FFEFDC дав контраст 1.15, тобто його просто
 * не було видно. Справжнє небо теж темніше в зеніті, ніж біля обрію.
 */
function dayRamp(alt: number) {
  const t = Math.pow(Math.min(1, Math.max(0, alt)), 0.7);
  return {
    top: mix('#C97A82', '#E09A6A', t),
    mid: mix('#FF8A6B', '#FFC28C', t),
    // На золотій годині обрій іде рівно в акцент проєкту (--color-a1).
    low: mix('#FF6E7A', '#FFE8CC', t),
  };
}

/** Нічне небо: щойно за обрієм -> фіолетова заграва; глибока ніч -> майже чорне. */
function nightRamp(alt: number) {
  const t = Math.pow(Math.min(1, Math.max(0, alt)), 0.55);
  return {
    hi: mix('#5A3670', '#2A2050', t),
    mid: mix('#33204F', '#1A1338', t),
    low: mix('#1B1236', '#0D0920', t),
  };
}

export function SunDial({ sunrise, sunset }: { sunrise: number; sunset: number }) {
  useTick(TICK_MS);
  // useId — бо id градієнтів глобальні в документі: два циферблати на сторінці
  // підмінили б одне одному небо.
  const uid = useId().replace(/:/g, '');
  const id = (n: string) => `${uid}${n}`;

  const now = new Date();
  const mins = kyivMinutes(now);
  const g = sunGeom(kyivMinutesFromUnix(sunrise), kyivMinutesFromUnix(sunset), mins);
  const t = readout(g);
  const day = dayRamp(g.alt);
  const night = nightRamp(g.alt);

  // Зорі гаснуть, щойно сонце піднялось над обрієм: тримаємо їх лише в сутінках
  // (alt < 0.12 удень) — інакше вдень у небі мерехтять крапки.
  const starOp = g.isDay ? Math.max(0, 1 - g.alt / 0.12) : Math.min(1, 0.35 + g.alt);
  const glow = g.isDay ? '255,186,96' : '168,150,255';
  const halo = g.isDay ? '255,248,214' : '226,220,255';

  return (
    <div className="relative h-[170px] w-[170px] flex-none">
      <svg
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        role="img"
        aria-label={`${g.isDay ? 'День' : 'Ніч'}, ${kyivClockNow(now)}${
          g.valid ? `, ${subLabel(g, mins).toLowerCase()}` : ''
        }`}
        style={{ filter: 'drop-shadow(0 20px 56px rgba(255,110,122,.24))' }}
      >
        <defs>
          <linearGradient id={id('d')} x1="0" y1={CY - R} x2="0" y2={g.horizonY} gradientUnits="userSpaceOnUse">
            <stop className="dial-stop" offset="0" stopColor={day.top} />
            <stop className="dial-stop" offset=".55" stopColor={day.mid} />
            <stop className="dial-stop" offset="1" stopColor={day.low} />
          </linearGradient>
          <linearGradient id={id('n')} x1="0" y1={g.horizonY} x2="0" y2={CY + R} gradientUnits="userSpaceOnUse">
            <stop className="dial-stop" offset="0" stopColor={night.hi} />
            <stop className="dial-stop" offset=".5" stopColor={night.mid} />
            <stop className="dial-stop" offset="1" stopColor={night.low} />
          </linearGradient>
          <clipPath id={id('c')}>
            <circle cx={CX} cy={CY} r={R} />
          </clipPath>
          {/* Обʼєкт світить довкола себе — це і є «жива» частина неба. */}
          <radialGradient id={id('g')} cx={g.x} cy={g.y} r={46} gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor={`rgba(${glow},${g.isDay ? 0.5 : 0.32})`} />
            <stop offset="1" stopColor={`rgba(${glow},0)`} />
          </radialGradient>
          {/* Тісний ореол — щоб СОНЦЕ читалось на світлому небі. Без нього воно
              зникає: диск #FFE3AE на небі #FFEFDC — це майже той самий колір,
              і обʼєкт, який мав бути героєм, розчинявся у фоні. Уночі місяць
              контрастний сам собою, тож ореол там слабший. */}
          <radialGradient id={id('h')} cx={g.x} cy={g.y} r={15} gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor={`rgba(${halo},${g.isDay ? 0.95 : 0.5})`} />
            <stop offset="1" stopColor={`rgba(${halo},0)`} />
          </radialGradient>
        </defs>

        <g clipPath={`url(#${id('c')})`}>
          <path d={segPath(g.half, false)} fill={`url(#${id('d')})`} />
          <path d={segPath(g.half, true)} fill={`url(#${id('n')})`} />

          {STARS.map(([sx, sy, r, dur, delay], i) => (
            <circle key={i} cx={sx} cy={sy} r={r} fill="#F2F1EC" opacity={starOp}>
              <animate
                attributeName="opacity"
                values={`${(0.25 * starOp).toFixed(2)};${(0.95 * starOp).toFixed(2)};${(0.25 * starOp).toFixed(2)}`}
                dur={dur}
                begin={delay}
                repeatCount="indefinite"
              />
            </circle>
          ))}

          <rect x="0" y="0" width={SIZE} height={SIZE} fill={`url(#${id('g')})`} />
          <rect x="0" y="0" width={SIZE} height={SIZE} fill={`url(#${id('h')})`} />

          {/* Обрій — тонка межа; уся драма з градієнтів, не з лінії. */}
          <line
            x1={CX - g.horizonHalfW}
            y1={g.horizonY}
            x2={CX + g.horizonHalfW}
            y2={g.horizonY}
            stroke="rgba(255,255,255,.24)"
            strokeWidth="0.8"
          />

          <g style={{ transition: 'transform 1s linear' }} transform={`translate(${g.x} ${g.y})`}>
            {g.isDay ? (
              // Розжарене ядро, а не «тепле»: на блідому денному небі диск
              // мусить бути СВІТЛІШИЙ за фон, інакше його просто не видно.
              <circle r="6" fill="#FFFDF4" />
            ) : (
              <>
                <circle r="6.5" fill="#ECE8F8" />
                {/* Серп — «відкушений» кружок кольору неба на цій висоті. */}
                <circle cx="3" cy="-2.5" r="6" fill={g.alt > 0.5 ? night.mid : night.hi} />
              </>
            )}
          </g>
        </g>

        <circle cx={CX} cy={CY} r={R} fill="none" stroke="rgba(255,255,255,.16)" strokeWidth="1" />

        <text
          className="dial-clock"
          x={CX}
          y={t.clockY}
          textAnchor="middle"
          dominantBaseline="middle"
          style={{ fontSize: 25 * t.scale }}
        >
          {kyivClockNow(now)}
        </text>
        {g.valid && (
          <text
            className="dial-sub"
            x={CX}
            y={t.subY}
            textAnchor="middle"
            dominantBaseline="middle"
            style={{ fontSize: 8.5 * t.scale }}
          >
            {subLabel(g, mins)}
          </text>
        )}
      </svg>
    </div>
  );
}
