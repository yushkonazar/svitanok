import { useId, useState } from 'react';
import type { CurrencyData } from '../../api/briefing-schema.ts';
import { has, pctChange, windowMinMax } from '../../lib/format.ts';
import { useInView } from '../../lib/useInView.ts';
import { SectionLabel, Ph } from '../ui/primitives.tsx';

// Курс НБУ (дизайн v2, Svitanok.dc.html + PR-8): рядок на валюту — кружечок-
// символ, код, міні-спарклайн, дельта (з % — не лайв-стан, а зручність
// відстеження зміни, фідбек власника), велике значення. Перша валюта
// акцентована (кораловий бейдж + градієнтний спарклайн), решта — приглушені.
// Тап на рядок розкриває міні-конвертер + тижневий мін/макс — фідбек
// власника: діапазон за 7д раніше показувався ЛИШЕ для акцентної (USD) над
// списком; тепер це те саме tap-to-expand, що конвертер, і працює для
// БУДЬ-ЯКОЇ валюти, не лише першої.

const DEFS = [
  { key: 'usd', hk: 'usdHistory', sym: '$', label: 'USD' },
  { key: 'eur', hk: 'eurHistory', sym: '€', label: 'EUR' },
  { key: 'pln', hk: 'plnHistory', sym: 'zł', label: 'PLN' },
  { key: 'gbp', hk: 'gbpHistory', sym: '£', label: 'GBP' },
] as const;

// Поріг «стрічка» (⚡) — денна зміна, що впадає в очі. 1% на курсі валют за
// добу — реально помітний рух, не шум округлення НБУ.
const SPIKE_PCT = 1;
const WEEK_DAYS = 7;
const DEFAULT_AMOUNT = 100;

const SW = 58;
const SH = 18;
const PAD = 2;

function Spark({
  hist,
  accent,
  gradId,
  play,
  delay,
}: {
  hist: number[];
  accent: boolean;
  gradId: string;
  play: boolean;
  delay: number;
}) {
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
      {/* Той самий прийом, що в charts/Sparkline: pathLength=1 + dashoffset 0 у
          DOM (лінія намальована), кадр lineDraw лише каже, звідки приїхати. */}
      <path
        d={d}
        pathLength="1"
        fill="none"
        stroke={accent ? `url(#${gradId})` : 'var(--color-tx3)'}
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeDasharray="1"
        strokeDashoffset="0"
        style={{
          animation: `lineDraw .7s cubic-bezier(.4,0,.2,1) ${delay}ms backwards`,
          animationPlayState: play ? 'running' : 'paused',
        }}
      />
    </svg>
  );
}

export function CurrencyBlock({ d, date }: { d: CurrencyData | null; date: string | null }) {
  const gradId = useId();
  // Спарклайни малюються, коли блок доїхав до екрана (він живе під високим
  // блоком погоди, тобто на малих екранах — за згином). Сходинка 90мс на рядок:
  // валюти «проростають» одна за одною.
  const [ref, inView] = useInView<HTMLDivElement>();
  const rows = d ? DEFS.filter((def) => has(d[def.key])) : [];

  // Конвертер (PR-8, п.6.3) — розкритий рядок + сума. ОДИН спільний amount:
  // перемикаючись між валютами, власник порівнює ту саму суму, не вводить
  // наново. Скидання при закритті свідомо НЕ робимо — тап назад на той самий
  // рядок має пам'ятати, що вже вводив.
  //
  // Рядок, не число (фідбек власника — баг): controlled type="number" зі
  // `setAmount(Number(e.target.value) || 0)` перетворював порожній інпут на
  // ЧИСЛО 0, DOM одразу показував назад "0" (React не дає стерти поле), і
  // наступний натиснутий digit вставлявся ПЕРЕД тим "0" (курсор скидається
  // на початок при кожному контрольованому ре-рендері) — "70" ставало "070".
  // type="number" до того ж не пускає кому як десятковий роздільник залежно
  // від локалі браузера. Тримаємо сирий рядок як є (що надрукував — те й
  // видно, включно з проміжними станами "7", "7.", "7,5"), парсимо в число
  // лише для обчислення конвертації.
  const [expanded, setExpanded] = useState<string | null>(null);
  const [amountStr, setAmountStr] = useState(String(DEFAULT_AMOUNT));
  const amount = Number(amountStr.replace(',', '.')) || 0;

  return (
    <div ref={ref} className="flex flex-col gap-1.5">
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
            const pct = prev != null ? pctChange(value, prev) : null;
            const spike = pct != null && Math.abs(pct) >= SPIKE_PCT;
            const accent = i === 0;
            const isOpen = expanded === def.key;
            // Тижневий мін/макс (п.6.2) — рахуємо лише для розкритої валюти,
            // не для всіх чотирьох одразу (дешево, але без потреби).
            const minMax = isOpen ? windowMinMax(hist, WEEK_DAYS) : null;
            const deltaColor =
              dd == null || dd === 0
                ? 'var(--color-tx3)'
                : dd > 0
                  ? 'var(--color-pos)'
                  : 'var(--color-neg)';
            return (
              <div key={def.key} className="flex flex-col">
                <button
                  type="button"
                  onClick={() => setExpanded(isOpen ? null : def.key)}
                  aria-expanded={isOpen}
                  className="flex w-full items-center gap-2.5 border-0 bg-transparent p-0 py-1.5 text-left"
                >
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
                  <Spark hist={hist} accent={accent} gradId={gradId} play={inView} delay={i * 90} />
                  {dd != null && (
                    <span
                      className="flex items-center gap-0.5 font-mono text-[10.5px] font-medium"
                      style={{ color: deltaColor }}
                    >
                      {/* Бейдж «стрибок» (п.6.4) — денна зміна ≥1%, впадає в очі. */}
                      {spike && <span title="Помітна зміна за добу">⚡</span>}
                      {dd > 0 ? '↑' : dd < 0 ? '↓' : '→'}
                      {Math.abs(dd).toFixed(2)}
                      {/* % зміни поруч з абсолютною (п.6.1) — «+0.32» саме по
                          собі не каже, це багато чи мало для ЦІЄЇ валюти. */}
                      {pct != null && (
                        <span className="text-tx3">
                          {' '}
                          ({pct > 0 ? '+' : pct < 0 ? '−' : ''}
                          {Math.abs(pct).toFixed(1)}%)
                        </span>
                      )}
                    </span>
                  )}
                  {/* toFixed(2) — як у макеті: без нього 59.4 губить хвостовий
                      нуль і колонка значень «стрибає» в моно-шрифті */}
                  <span className="ml-auto font-mono text-base font-semibold">{value.toFixed(2)}</span>
                </button>

                {/* Тап-to-expand розкриває ОБИДВА: тижневий діапазон (п.6.2,
                    фідбек власника — раніше лише для акцентної USD над
                    списком, тепер для будь-якої обраної валюти) над
                    конвертером «скільки в грн» (п.6.3, той самий
                    інтеракційний патерн, що «Відповідь ↓» у QuestionBlock). */}
                {isOpen && (
                  <div className="flex flex-col gap-1 py-1 pl-9" style={{ animation: 'fadeUp .2s ease' }}>
                    {minMax && (
                      <div className="font-mono text-[10px] text-tx3">
                        {def.label} за {WEEK_DAYS}Д: {minMax.min.toFixed(2)}–{minMax.max.toFixed(2)}
                      </div>
                    )}
                    <div className="flex items-center gap-2 text-[11.5px] text-tx2">
                      <input
                        type="text"
                        inputMode="decimal"
                        value={amountStr}
                        onChange={(e) => {
                          const v = e.target.value;
                          // цифри + щонайбільше один роздільник (кома чи крапка) —
                          // пускає й проміжні стани набору ("", "7", "7.", "7,5")
                          if (/^\d*[.,]?\d*$/.test(v)) setAmountStr(v);
                        }}
                        className="w-16 rounded-lg border border-glassb bg-glass px-2 py-1 font-mono text-[11.5px]"
                        aria-label={`Сума в ${def.label}`}
                      />
                      <span className="font-mono">{def.sym}</span>
                      <span className="text-tx3">=</span>
                      <span className="font-mono font-semibold text-tx">
                        {(amount * value).toFixed(2)} ₴
                      </span>
                    </div>
                  </div>
                )}
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
