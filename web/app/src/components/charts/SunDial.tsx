import { useTick } from '../../lib/useTick.ts';
import { kyivMinutes, kyivMinutesFromUnix, kyivClockNow } from '../../lib/weather.ts';

// Добовий циферблат (дизайн v2, Svitanok.dc.html). Коло 170px: небо-градієнт
// день (верх) → ніч (низ); маркер їде повним колом за часом доби — полудень
// угорі, північ унизу, схід ліворуч, захід праворуч. Декор (сонце/хмари/зорі/
// місяць) статичний, як у макеті. Живий тик — 30с.
//
// Геометрія 1:1 з макета: cx=cy=85, R=79; ang = (хв/1440)*2π;
// mx = cx − R·sin(ang), my = cy + R·cos(ang) — при 00:00 маркер унизу, о 12:00
// угорі. Час беремо КИЇВСЬКИЙ (як і схід/захід), не локаль пристрою.

const CX = 85;
const CY = 85;
const R = 79;

const STARS: [number, number, number, number, string][] = [
  // left, bottom, size, duration(s), delay(s) — координати з макета
  [30, 50, 3, 3, '0s'],
  [58, 26, 2, 2.4, '.4s'],
  [78, 44, 2.5, 3.4, '.8s'],
];

function pad(n: number) {
  return String(n).padStart(2, '0');
}

export function SunDial({ sunrise, sunset }: { sunrise: number; sunset: number }) {
  useTick(30_000);

  const now = new Date();
  const mins = kyivMinutes(now);
  const ang = (mins / 1440) * 2 * Math.PI;
  const mx = CX - R * Math.sin(ang);
  const my = CY + R * Math.cos(ang);

  const sr = kyivMinutesFromUnix(sunrise);
  const ss = kyivMinutesFromUnix(sunset);
  const valid = !!sr && !!ss && ss > sr;
  const isDay = valid ? mins >= sr && mins <= ss : true;

  let sub = '';
  if (valid) {
    if (isDay) {
      const dl = ss - sr;
      sub = `ДЕНЬ ${Math.floor(dl / 60)}Г${pad(dl % 60)}`;
    } else {
      const d = (sr - mins + 1440) % 1440;
      sub = `ДО СХОДУ ${Math.floor(d / 60)}Г ${pad(d % 60)}ХВ`;
    }
  }

  return (
    <div className="relative h-[170px] w-[170px] flex-none">
      {/* небо */}
      <div
        className="absolute inset-0 overflow-hidden rounded-full"
        style={{
          background:
            'linear-gradient(180deg,#FFF6E6 0%,#FFDFAE 42%,#FFD09A 55%,#2A2050 55.4%,#1A1338 74%,#120D28 100%)',
          boxShadow:
            '0 0 0 1px rgba(255,255,255,.16),0 20px 56px rgba(255,110,122,.24),inset 0 -20px 40px rgba(8,6,20,.5)',
        }}
      >
        {/* сонце в зеніті */}
        <div
          className="absolute left-1/2 top-[34px] h-[26px] w-[26px] -translate-x-1/2 rounded-full"
          style={{ background: '#FFE3AE', boxShadow: '0 0 24px 14px rgba(255,196,120,.6)' }}
        />
        {/* хмари */}
        <div
          className="absolute left-5 top-[56px] h-[9px] w-11 rounded-full"
          style={{ background: 'rgba(255,255,255,.75)', boxShadow: '12px 5px 0 -2px rgba(255,255,255,.5)' }}
        />
        <div
          className="absolute right-[22px] top-[30px] h-2 w-8 rounded-full"
          style={{ background: 'rgba(255,255,255,.6)' }}
        />
        {/* нічне сяйво */}
        <div
          className="absolute inset-x-0 top-[96px] h-[74px]"
          style={{ background: 'radial-gradient(60% 80% at 62% 60%,rgba(130,100,255,.22),transparent 70%)' }}
        />
        {/* зорі */}
        {STARS.map(([left, bottom, size, dur, delay], i) => (
          <div
            key={i}
            className="absolute rounded-full"
            style={{
              left,
              bottom,
              width: size,
              height: size,
              background: i === 0 ? '#F2F1EC' : `rgba(242,241,236,${i === 1 ? 0.6 : 0.8})`,
              animation: `twinkle ${dur}s ease-in-out ${delay} infinite`,
            }}
          />
        ))}
        <div
          className="absolute right-[52px] bottom-[58px] h-[3px] w-[3px] rounded-full"
          style={{
            background: '#F2F1EC',
            boxShadow: '0 0 6px rgba(242,241,236,.9)',
            animation: 'twinkle 2.8s ease-in-out .2s infinite',
          }}
        />
        {/* зоря-«хрестик» */}
        <div
          className="absolute right-[38px] bottom-[38px] h-[1.5px] w-[9px]"
          style={{ background: 'rgba(242,241,236,.85)' }}
        />
        <div
          className="absolute right-[41.5px] bottom-[34px] h-[9px] w-[1.5px]"
          style={{ background: 'rgba(242,241,236,.85)' }}
        />
        {/* місяць-серп */}
        <div className="absolute right-6 bottom-[52px] h-[18px] w-[18px]">
          <div
            className="absolute inset-0 rounded-full"
            style={{ background: 'rgba(236,232,248,.95)', boxShadow: '0 0 14px rgba(200,190,255,.5)' }}
          />
          <div
            className="absolute left-[5px] top-[-2.5px] h-[17px] w-[17px] rounded-full"
            style={{ background: '#1D1540' }}
          />
        </div>
      </div>

      {/* маркер «зараз» */}
      <div
        className="absolute h-3 w-3 rounded-full"
        style={{
          left: (mx - 6).toFixed(1),
          top: (my - 6).toFixed(1),
          background: isDay ? '#FFE3AE' : '#EDEAF8',
          boxShadow: `0 0 14px 3px ${isDay ? 'rgba(255,196,120,.85)' : 'rgba(200,190,255,.7)'}`,
          transition: 'left 1s linear, top 1s linear',
        }}
      />

      {/* центральний зчитувач */}
      <div className="absolute inset-x-0 top-[96px] flex flex-col items-center gap-px">
        <div
          className="font-mono text-[25px] font-bold tracking-[-0.02em]"
          style={{ color: '#F7F4FF', textShadow: '0 2px 12px rgba(8,6,20,.8)' }}
        >
          {kyivClockNow(now)}
        </div>
        {sub && (
          <div className="font-mono text-[8.5px] font-medium" style={{ color: 'rgba(242,241,236,.7)' }}>
            {sub}
          </div>
        )}
      </div>
    </div>
  );
}
