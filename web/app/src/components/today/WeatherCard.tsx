import type { Brief, WeatherLocation } from '../../api/briefing-schema.ts';
import { readBlock, weatherDataSchema } from '../../api/briefing-schema.ts';
import { has } from '../../lib/format.ts';
import { dayLen, signTemp } from '../../lib/weather.ts';
import { Card, Ph } from '../ui/primitives.tsx';
import { Expandable } from '../ui/Expandable.tsx';
import { WxDial } from '../charts/WxDial.tsx';
import { WxChart } from '../charts/WxChart.tsx';
import { UvBadge, AqiBadge } from './badges.tsx';

// Погода (роадмеп v3, E2) — 1:1 з index.html weatherTile (2117-2182). Згорнуто:
// temp+місто+стан; розгорнуто (swap): циферблат, метрики 2×2, графік годин, порада.

const feels = (t?: number) => (has(t) ? `відч. ${signTemp(t)}` : '');

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-surface-2 p-2">
      <div className="text-[11px] text-muted">{label}</div>
      <div className="text-sm font-medium">{value}</div>
    </div>
  );
}

function WeatherTile({ l }: { l: WeatherLocation }) {
  const base = (
    <div className="flex items-center gap-3 py-1">
      <span className="text-3xl font-bold">{signTemp(l.tempC)}</span>
      <div className="min-w-0">
        <div className="font-semibold">
          {l.emoji} {l.name}
        </div>
        <div className="text-sm text-muted">
          {l.condition}
          <br />
          {feels(l.feelsLikeC)}
          {l.willRain ? ` · ☔ ${l.popPercent}%` : ''}
        </div>
      </div>
    </div>
  );

  const dl = dayLen(l.sunrise, l.sunset);
  const delta =
    has(l.dayLenDeltaMin) && l.dayLenDeltaMin !== 0
      ? `${l.dayLenDeltaMin! > 0 ? '+' : '−'}${Math.abs(l.dayLenDeltaMin!)} хв`
      : '';
  const gust = has(l.gustMps) ? ` · пориви ${l.gustMps}` : '';
  const rainVal = has(l.rainWindow)
    ? l.rainWindow!
    : l.willRain
      ? `${l.popPercent}%`
      : 'без опадів';

  const more = (
    <div className="rounded-2xl border border-border bg-surface-2/40 p-3">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-2xl">{l.emoji || '⛅'}</span>
          <div>
            <div className="font-semibold">{l.name}</div>
            <div className="text-sm text-muted">{l.condition}</div>
          </div>
        </div>
        {dl && (
          <div className="rounded-full bg-surface-2 px-2.5 py-1 text-xs text-muted">
            ☀️ День {dl} {delta}
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 items-center gap-3">
        <div>
          <div className="text-2xl font-bold">
            {signTemp(l.tempC)}{' '}
            <span className="text-sm font-normal text-muted">{feels(l.feelsLikeC)}</span>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-1.5">
            <Metric label="🌡 Мін / Макс" value={`${l.minC ?? '—'}° … ${l.maxC ?? '—'}°`} />
            <Metric label="💨 Вітер" value={`${l.windMps ?? '—'} м/с${gust}`} />
            <Metric label="💧 Вологість" value={has(l.humidity) ? `${l.humidity}%` : '—'} />
            <Metric label="🌧 Опади" value={rainVal} />
          </div>
        </div>
        <WxDial sr={l.sunrise} ss={l.sunset} />
      </div>

      {(has(l.uv) || has(l.aqi)) && (
        <div className="mt-3 flex flex-wrap gap-2">
          <UvBadge uv={l.uv} />
          <AqiBadge aqi={l.aqi} />
        </div>
      )}

      {Array.isArray(l.hourly) && l.hourly.length >= 2 && (
        <div className="mt-3">
          <div className="mb-1 text-xs text-muted">Температура по годинах</div>
          <WxChart hourly={l.hourly} rainWindow={l.rainWindow} />
        </div>
      )}

      {has(l.advice) && (
        <div className="mt-3 rounded-xl bg-surface-2/60 p-2 text-sm">
          <span className="mr-1">🧥</span>
          <b>Порада:</b> {l.advice}
        </div>
      )}
    </div>
  );

  return <Expandable base={base} more={more} swap />;
}

export function WeatherCard({ brief }: { brief: Brief }) {
  const data = readBlock(brief.blocks, 'weather', weatherDataSchema);
  if (!data || !data.locations.length) {
    return (
      <Card title="Погода">
        <Ph>Дані про погоду з’являться в найближчому брифінгу</Ph>
      </Card>
    );
  }
  return (
    <Card title="Погода">
      <div className="flex flex-col gap-3">
        {data.locations.map((l) => (
          <WeatherTile key={l.name} l={l} />
        ))}
      </div>
    </Card>
  );
}
