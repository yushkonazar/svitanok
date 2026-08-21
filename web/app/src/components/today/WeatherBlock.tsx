import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { WeatherLocation, Settlement } from '../../api/briefing-schema.ts';
import { has } from '../../lib/format.ts';
import { dayLen, fmtClock, signTemp } from '../../lib/weather.ts';
import { SunDial } from '../charts/SunDial.tsx';
import { HourlyChart } from '../charts/HourlyChart.tsx';
import { Ph } from '../ui/primitives.tsx';
import {
  useSetWeatherLocation,
  useSetWeatherLocationExact,
  useClearWeatherLocation,
  useRequestLocatePrompt,
  useSettlements,
} from '../../api/hooks.ts';
import { haptic, closeApp } from '../../telegram.ts';

// Скільки варіантів показуємо в списку — досить, щоб знайти потрібне місто
// серед однойменних, не захаращуючи невеликий інлайн-редактор.
const MAX_SUGGESTIONS = 8;

// Тайминги «вильоту» редактора локації (ui-ux-pro-max, --domain ux):
// duration-timing 150-300мс для мікровзаємодій; exit-faster-than-enter —
// вихід ~60-70% від входу; spring-physics — пружна крива замість лінійної/
// пласкої cubic-bezier; stagger-sequence — 30-50мс на елемент.
const ENTER_MS = 260;
const EXIT_MS = 170;
const SPRING_EASE = 'cubic-bezier(.34,1.56,.64,1)'; // back-out — легкий перельот і осідання
const EXIT_EASE = 'cubic-bezier(.4,0,1,1)'; // ease-in — «easing» правило скіла: вхід ease-out, вихід ease-in
const STAGGER_MS = 40;

// Погода (дизайн v2, Svitanok.dc.html): місто·стан + велика температура зліва,
// метрики справа; добовий циферблат між лініями сходу/заходу; пігулка довжини
// дня; рядок UV/AQI/друге місто; графік по годинах.
// Головне місто — locations[0], друге (якщо є) — у рядку UV.
//
// Ручне перевизначення локації (фідбек власника): IP-геолокація (MaxMind
// через Cloudflare) не встигає за реальним рухом на мобільній мережі —
// оператор мапить IP на місто приблизно й не в реальному часі, тож «жива»
// (не протухла кешем) погода може лишатись географічно неправильною години
// після переїзду. Шпилька біля назви міста — вхід у крихітний інлайн-редактор
// (той самий tap-to-expand патерн, що конвертер у CurrencyBlock): заповнена —
// перевизначення активне, порожня — авто-детекція по IP.

function PinIcon({ active }: { active: boolean }) {
  // Форма відрізняється, не лише колір (a11y-правило дизайн-скіла): заповнена
  // крапля — активне перевизначення, контурна — авто-детекція.
  return active ? (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="var(--color-a2)" className="flex-none">
      <path d="M12 2C7.58 2 4 5.58 4 10c0 5.25 6.72 11.34 7.01 11.6a1.5 1.5 0 0 0 1.98 0C13.28 21.34 20 15.25 20 10c0-4.42-3.58-8-8-8Zm0 11a3 3 0 1 1 0-6 3 3 0 0 1 0 6Z" />
    </svg>
  ) : (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--color-tx3)"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="flex-none"
    >
      <path d="M12 2C7.58 2 4 5.58 4 10c0 5.25 6.72 11.34 7.01 11.6a1.5 1.5 0 0 0 1.98 0C13.28 21.34 20 15.25 20 10c0-4.42-3.58-8-8-8Z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

/**
 * Стиль «вильоту» зі шпильки для одного елемента редактора (фідбек
 * власника). Вхід і вихід — АСИМЕТРИЧНІ (exit-faster-than-enter): вхід
 * пружний і трохи повільніший, вихід — швидкий ease-in, без stagger (усе
 * ховається одразу, затримка лише прикрашає ПОЯВУ, не зникнення).
 * transform-origin — верхній лівий кут: елемент росте ЗВІДТИ, де сидить
 * іконка вище, а не з власного центру.
 */
function flyStyle(visible: boolean, leaving: boolean, delayMs: number): CSSProperties {
  return {
    transformOrigin: '0% 0%',
    opacity: visible ? 1 : 0,
    transform: visible ? 'translate(0,0) scale(1)' : 'translate(-6px,-28px) scale(.3)',
    transition: leaving
      ? `opacity ${EXIT_MS}ms ${EXIT_EASE}, transform ${EXIT_MS}ms ${EXIT_EASE}`
      : `opacity ${ENTER_MS}ms ${SPRING_EASE} ${delayMs}ms, transform ${ENTER_MS}ms ${SPRING_EASE} ${delayMs}ms`,
  };
}

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
  manualGeo = null,
}: {
  locations: WeatherLocation[];
  manualGeo?: { name: string } | null;
}) {
  const setLoc = useSetWeatherLocation();
  const setLocExact = useSetWeatherLocationExact();
  const clearLoc = useClearWeatherLocation();
  const locatePrompt = useRequestLocatePrompt();
  const [city, setCity] = useState('');
  const [err, setErr] = useState<string | null>(null);

  // Життєвий цикл редактора з анімацією виходу (фідбек власника — той самий
  // shown/leaving патерн, що StageCelebration.tsx): formOpen тримає <form>
  // у DOM, поки не дограє вихід; shown вмикає видимий стан на наступний
  // кадр після монтування (щоб було звідки анімувати вхід); leaving —
  // прапорець «зараз їде геть», перемикає flyStyle на швидшу exit-криву.
  const [formOpen, setFormOpen] = useState(false);
  const [shown, setShown] = useState(false);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (!formOpen) return;
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, [formOpen]);

  const closeEditor = () => setLeaving(true);

  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(() => {
      setFormOpen(false);
      setShown(false);
      setLeaving(false);
    }, EXIT_MS);
    return () => clearTimeout(t);
  }, [leaving]);

  const visible = shown && !leaving;

  // Автозаповнення (фідбек власника: «звичайна пошукова логіка», список
  // звужується щосимволу) — ЦІЛКОМ на клієнті, без мережевого запиту на
  // кожен keystroke: settlements.json завантажується один раз (лише коли
  // редактор реально відкрито), далі — префікс-фільтр у памʼяті. Дані вже
  // відсортовані за population (gen-settlements.mjs), тож перші N збігів —
  // найбільші міста, без окремого сортування тут.
  const { data: settlements } = useSettlements(formOpen);
  const suggestions = useMemo(() => {
    const q = city.trim().toLowerCase();
    if (!q || !settlements) return [];
    const out: Settlement[] = [];
    for (const s of settlements) {
      if (s.name.toLowerCase().startsWith(q)) {
        out.push(s);
        if (out.length >= MAX_SUGGESTIONS) break;
      }
    }
    return out;
  }, [settlements, city]);

  const pickSuggestion = (s: Settlement) => {
    setErr(null);
    setLocExact.mutate(
      { lat: s.lat, lon: s.lon, name: s.name },
      {
        onSuccess: () => {
          haptic('success');
          closeEditor();
        },
        onError: (e) => setErr(e instanceof Error ? e.message : 'Не вдалося встановити локацію'),
      },
    );
  };

  const openEditor = () => {
    if (formOpen) {
      closeEditor();
      return;
    }
    setCity(manualGeo?.name ?? '');
    setErr(null);
    setFormOpen(true);
  };

  const l = locations[0];
  if (!l) return <Ph>Дані про погоду з’являться в найближчому брифінгу</Ph>;
  const second = locations[1];

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
          <div className="flex items-center gap-1 text-xs font-semibold text-tx2">
            <span>
              {l.name}
              {l.condition ? ` · ${l.condition}` : ''}
            </span>
            <button
              type="button"
              onClick={openEditor}
              aria-label={
                manualGeo ? `Локація вручну: ${manualGeo.name}. Змінити` : 'Вказати локацію вручну'
              }
              aria-expanded={formOpen}
              className="relative grid h-4 w-4 flex-none place-items-center rounded-full transition-all duration-150 active:scale-90 active:opacity-70"
              style={
                {
                  // Постійний «пінг»-пульс — тихий натяк «тапни мене», доки
                  // редактор закритий (фідбек власника: динамічна анімація
                  // кнопки; ui-ux-pro-max --domain gsap, «loop attention»
                  // патерн: розширення+згасання box-shadow, БЕЗ transform —
                  // не компонується зі scale press-фідбеку в сусідньому
                  // правилі, тож коло лишається рівним, не «кривим»).
                  // Гаситься, щойно відкрито — форма вже привертає увагу.
                  '--pulse-c': manualGeo ? 'rgba(255,164,92,.55)' : 'rgba(200,203,214,.4)',
                  animation: formOpen ? 'none' : 'pinPulse 2.4s ease-out infinite',
                } as CSSProperties
              }
            >
              <PinIcon active={!!manualGeo} />
            </button>
          </div>
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

      {/* редактор ручної локації — той самий tap-to-expand патерн, що
          конвертер CurrencyBlock, тепер із симетричним входом/виходом
          (flyStyle) замість миттєвого розмонтування. */}
      {formOpen && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = city.trim();
            if (!trimmed) return;
            setErr(null);
            setLoc.mutate(trimmed, {
              onSuccess: () => {
                haptic('success');
                closeEditor();
              },
              onError: (e) =>
                setErr(e instanceof Error ? e.message : 'Не вдалося встановити локацію'),
            });
          }}
          className="-mt-2 flex flex-wrap items-center gap-1.5"
        >
          <input
            type="text"
            autoFocus
            value={city}
            onChange={(e) => {
              setCity(e.target.value);
              setErr(null);
            }}
            placeholder="Місто вручну…"
            className="w-32 rounded-lg border border-glassb bg-glass px-2 py-1 font-mono text-[11px]"
            aria-label="Назва міста для ручної локації"
            style={flyStyle(visible, leaving, 0)}
          />
          <button
            type="submit"
            disabled={setLoc.isPending || !city.trim()}
            className="rounded-full px-3 py-1 text-[10.5px] font-semibold disabled:opacity-50"
            style={{
              background: 'var(--grad)',
              color: 'var(--color-onacc)',
              ...flyStyle(visible, leaving, STAGGER_MS),
            }}
          >
            {setLoc.isPending ? '…' : manualGeo ? 'Оновити' : 'Встановити'}
          </button>
          {manualGeo && (
            <button
              type="button"
              disabled={clearLoc.isPending}
              onClick={() =>
                clearLoc.mutate(undefined, {
                  onSuccess: () => {
                    haptic('light');
                    closeEditor();
                  },
                })
              }
              className="text-[10.5px] font-medium text-tx3 disabled:opacity-50"
              style={flyStyle(visible, leaving, STAGGER_MS * 2)}
            >
              Прибрати
            </button>
          )}
          {/* Тригер /locate З АПКИ (фідбек власника: «можна зробити цю кнопку
              тригер у самій апці?»). Mini App не вміє показати нативну
              кнопку геолокації сама (request_location — виключно
              KeyboardButton у ЧАТІ, Bot API), тож просить бота надіслати
              той самий промпт і одразу перекидає власника туди —
              closeApp() замість «шукай сам». */}
          <button
            type="button"
            disabled={locatePrompt.isPending}
            onClick={() => {
              setErr(null);
              locatePrompt.mutate(undefined, {
                onSuccess: () => {
                  haptic('success');
                  setTimeout(closeApp, 450); // час відчути тап (press-анімація), перш ніж апка згорнеться
                },
                onError: (e) =>
                  setErr(e instanceof Error ? e.message : 'Не вдалося надіслати запит'),
              });
            }}
            className="basis-full rounded-lg border border-glassb px-3 py-1.5 text-[11px] font-medium text-tx2 disabled:opacity-50"
            style={flyStyle(visible, leaving, STAGGER_MS * 3)}
          >
            {locatePrompt.isPending ? '…' : '📍 Точна GPS-позиція через чат'}
          </button>
          {/* Автозаповнення (фідбек власника) — обраний кандидат несе готові
              lat/lon, повторне геокодування на сервері пропускається. */}
          {suggestions.length > 0 && (
            <div
              className="flex basis-full flex-col gap-0.5 rounded-lg border border-glassb bg-glass p-1"
              style={{ animation: 'fadeUp .2s ease' }}
            >
              {suggestions.map((s, i) => (
                <button
                  key={`${s.lat},${s.lon},${i}`}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pickSuggestion(s)}
                  className="rounded-md px-1.5 py-1 text-left text-[11px] font-medium text-tx2"
                >
                  {s.name}
                  {(s.region ?? s.country) && (
                    <span className="text-tx3"> · {s.region ?? s.country}</span>
                  )}
                </button>
              ))}
            </div>
          )}
          {err && <div className="basis-full text-[10px] text-neg">{err}</div>}
        </form>
      )}

      {/* циферблат між лініями сходу/заходу */}
      <div className="flex items-center gap-3">
        <div className="flex flex-1 translate-y-3 flex-col gap-1.5">
          <div
            style={{
              height: 1.5,
              background: 'linear-gradient(90deg,transparent,var(--color-a2))',
            }}
          />
          <div className="whitespace-nowrap font-mono text-[10px] font-semibold text-tx2">
            <span className="text-a2">↑</span> СХІД {fmtClock(l.sunrise)}
          </div>
        </div>
        <SunDial sunrise={l.sunrise} sunset={l.sunset} />
        <div className="flex flex-1 translate-y-3 flex-col items-end gap-1.5">
          <div
            className="w-full"
            style={{
              height: 1.5,
              background: 'linear-gradient(90deg,var(--color-a1),transparent)',
            }}
          />
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
