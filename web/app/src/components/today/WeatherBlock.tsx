import type { WeatherLocation } from '../../api/briefing-schema.ts';
import { has } from '../../lib/format.ts';
import { dayLen, fmtClock, signTemp } from '../../lib/weather.ts';
import type { GeoStatus } from '../../lib/useGeolocation.ts';
import { openLocationSettings } from '../../telegram.ts';
import { SunDial } from '../charts/SunDial.tsx';
import { HourlyChart } from '../charts/HourlyChart.tsx';
import { Ph } from '../ui/primitives.tsx';

// Діагностичний підпис геолокації — 'pending'/'ok' не показуємо: перший ще
// не помилка, другий і так видно з реальної локації. denied/unavailable —
// майже завжди ОС-рівень (Bot API LocationManager: вимкнена геолокація на
// пристрої або немає дозволу в самого Telegram), тому саме для них поруч —
// пряме посилання в системні налаштування (openSettings, Bot API 8.0+).
const GEO_STATUS_LABEL: Partial<Record<GeoStatus, string>> = {
  denied: 'геолокація: немає дозволу',
  unavailable: 'геолокація: не вдалось визначити позицію',
  timeout: 'геолокація: не встигла відповісти',
  unsupported: 'геолокація: не підтримується цим клієнтом',
};
const GEO_SETTINGS_STATUSES: GeoStatus[] = ['denied', 'unavailable'];

// Погода (дизайн v2, Svitanok.dc.html): місто·стан + велика температура зліва,
// метрики справа; добовий циферблат між лініями сходу/заходу; пігулка довжини
// дня; рядок UV/AQI/друге місто; графік по годинах.
// Головне місто — locations[0], друге (якщо є) — у рядку UV.

function uvMeta(uv: number): { label: string; color: string } {
  if (uv >= 8) return { label: 'ДУЖЕ ВИСОКИЙ', color: 'var(--color-neg)' };
  if (uv >= 6) return { label: 'ВИСОКИЙ', color: 'var(--color-a2)' };
  if (uv >= 3) return { label: 'ПОМІРНИЙ', color: 'var(--color-a2)' };
  return { label: 'НИЗЬКИЙ', color: 'var(--color-pos)' };
}

const AQI_META: Record<number, { label: string; color: string }> = {
  1: { label: 'ДОБРЕ', color: 'var(--color-pos)' },
  2: { label: 'ОК', color: 'var(--color-pos)' },
  3: { label: 'ПОМІРНО', color: 'var(--color-a2)' },
  4: { label: 'ПОГАНО', color: 'var(--color-neg)' },
  5: { label: 'ДУЖЕ ПОГАНО', color: 'var(--color-neg)' },
};

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <span>
      <span className="text-tx3">{label} </span>
      {value}
    </span>
  );
}

export function WeatherBlock({
  locations,
  geoStatus,
}: {
  locations: WeatherLocation[];
  geoStatus?: GeoStatus;
}) {
  const l = locations[0];
  if (!l) return <Ph>Дані про погоду з’являться в найближчому брифінгу</Ph>;
  const second = locations[1];
  const geoLabel = geoStatus ? GEO_STATUS_LABEL[geoStatus] : undefined;
  const showGeoSettings = geoStatus && GEO_SETTINGS_STATUSES.includes(geoStatus);

  const dl = dayLen(l.sunrise, l.sunset);
  // «−2ХВ ДО ВЧОРА» читалось як загадка: незрозуміло, що з чим порівняли.
  // Кажемо прямо, що сталось: день довшає чи коротшає і на скільки.
  const delta =
    has(l.dayLenDeltaMin) && l.dayLenDeltaMin !== 0
      ? ` · ${l.dayLenDeltaMin! > 0 ? 'ДОВШИЙ' : 'КОРОТШИЙ'} НА ${Math.abs(l.dayLenDeltaMin!)} ХВ, НІЖ УЧОРА`
      : '';
  const uv = has(l.uv) ? uvMeta(l.uv!) : null;
  const aqi = has(l.aqi) ? AQI_META[l.aqi!] : null;

  return (
    <div className="flex flex-col gap-[18px]">
      {/* герой */}
      <div className="flex items-end gap-3.5">
        <div className="flex flex-col gap-0.5">
          <div className="text-xs font-semibold text-tx2">
            {l.name}
            {l.condition ? ` · ${l.condition}` : ''}
          </div>
          {geoLabel && (
            <div className="font-mono text-[9px] font-medium uppercase tracking-wide text-tx3">
              {geoLabel}
              {showGeoSettings && (
                <>
                  {' · '}
                  <button
                    type="button"
                    onClick={openLocationSettings}
                    className="underline decoration-dotted underline-offset-2"
                  >
                    налаштування
                  </button>
                </>
              )}
            </div>
          )}
          <div
            className="font-mono text-[64px] font-medium leading-[0.95] tracking-[-0.05em]"
            style={{ textShadow: '0 8px 40px rgba(255,110,122,.3)' }}
          >
            {signTemp(l.tempC)}
          </div>
        </div>
        <div className="ml-auto flex flex-col gap-1.5 whitespace-nowrap pb-1 text-right font-mono text-[10px] font-medium text-tx2">
          {has(l.feelsLikeC) && <Metric label="ВІДЧУВАЄТЬСЯ" value={signTemp(l.feelsLikeC!)} />}
          {has(l.minC) && has(l.maxC) && (
            <Metric label="ТЕМПЕРАТУРА" value={`${l.minC}…${l.maxC}°`} />
          )}
          {has(l.windMps) && <Metric label="ВІТЕР" value={`${l.windMps} м/с`} />}
          {has(l.humidity) && <Metric label="ВОЛОГІСТЬ" value={`${l.humidity}%`} />}
        </div>
      </div>

      {/* циферблат між лініями сходу/заходу */}
      <div className="flex items-center gap-3">
        <div className="flex flex-1 translate-y-3 flex-col gap-1.5">
          <div style={{ height: 1.5, background: 'linear-gradient(90deg,transparent,var(--color-a2))' }} />
          <div className="whitespace-nowrap font-mono text-[10px] font-semibold text-tx2">
            <span className="text-a2">↑</span> СХІД {fmtClock(l.sunrise)}
          </div>
        </div>
        <SunDial sunrise={l.sunrise} sunset={l.sunset} />
        <div className="flex flex-1 translate-y-3 flex-col items-end gap-1.5">
          <div className="w-full" style={{ height: 1.5, background: 'linear-gradient(90deg,var(--color-a1),transparent)' }} />
          <div className="whitespace-nowrap font-mono text-[10px] font-semibold text-tx2">
            ЗАХІД {fmtClock(l.sunset)} <span className="text-a1">↓</span>
          </div>
        </div>
      </div>

      {/* пігулка довжини дня */}
      {dl !== '—' && (
        <div className="-mt-1 flex justify-center">
          <div className="flex items-center rounded-full border border-glassb bg-glass px-[13px] py-[5px]">
            <span className="whitespace-nowrap font-mono text-[10px] font-semibold text-a2">
              ДЕНЬ {dl.toUpperCase()}
              {delta}
            </span>
          </div>
        </div>
      )}

      {/* UV · AQI · друге місто */}
      {(uv || aqi || second) && (
        <div className="flex items-center justify-center gap-[13px] font-mono text-[10.5px] font-semibold">
          {uv && (
            <span style={{ color: uv.color }}>
              UV {l.uv}
              <span className="text-tx3"> {uv.label}</span>
            </span>
          )}
          {uv && (aqi || second) && <span className="text-tx3">|</span>}
          {aqi && (
            <span style={{ color: aqi.color }}>
              AQI {l.aqi}
              <span className="text-tx3"> {aqi.label}</span>
            </span>
          )}
          {aqi && second && <span className="text-tx3">|</span>}
          {second && (
            <span className="text-tx2">
              {second.name.toUpperCase()} {signTemp(second.tempC)}
            </span>
          )}
        </div>
      )}

      {/* графік по годинах */}
      {Array.isArray(l.hourly) && l.hourly.length >= 2 && (
        <HourlyChart hourly={l.hourly} rainWindow={l.rainWindow} />
      )}
    </div>
  );
}
