import { useState } from 'react';
import type { Stats } from '../../api/schema.ts';
import { shiftDate } from '../../../../core/finance/planning.mjs';
import { dayIndices, flattenCheckinDay } from '../../../../checkin-model.mjs';
import { INDEX_COLOR, INDEX_LABEL, INDEX_ORDER } from '../../lib/checkinIndex.ts';
import { CATEGORY_LABEL } from '../../lib/checkinLabels.ts';
import { SelectedDay } from './SelectedDay.tsx';
import { StateTrendCharts, trendValue as values } from './StateTrendCharts.tsx';

const average = (values: (number | null | undefined)[]) => {
  const v = values.filter((n): n is number => n != null && Number.isFinite(n));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
const labels = { energy: 'Енергія', mood: 'Настрій', sleep: 'Сон' };
const colors = { energy: 'var(--color-a2)', mood: '#b7a1d2', sleep: '#91cfb3' };
type Line = keyof typeof labels;
export function StateStory({ s, days }: { s: Stats; days: number }) {
  const [enabled, setEnabled] = useState<Line[]>(['energy', 'mood', 'sleep']);
  const [chosen, setChosen] = useState<string | null>(null);
  const end = s.checkinRaw.to || s.checkinSeries.at(-1)?.d;
  if (!end) return null;
  const dates = Array.from({ length: days }, (_, i) => shiftDate(end, i - days + 1));
  const rows = dates.map((d) => ({ d, p: s.checkinSeries.find((p) => p.d === d) }));
  const selected = dates.includes(chosen ?? '') ? chosen! : end,
    index = dates.indexOf(selected),
    point = rows[index]?.p;
  const profiles = Object.entries(s.checkinRaw.records)
    .filter(([d]) => d >= dates[0] && d <= end)
    .map(([, r]) =>
      dayIndices(
        flattenCheckinDay(
          r,
          (v) => (Array.isArray(v) ? v : v == null ? [] : [v]),
          Object.keys(CATEGORY_LABEL),
        ),
      ),
    );
  const long = rows.filter((r) => (r.p?.sleepH ?? -1) >= 7 && r.p?.energy != null),
    short = rows.filter((r) => r.p?.sleepH != null && r.p.sleepH < 7 && r.p.energy != null);
  return (
    <>
      <section className="renewal-card">
        <h2 className="text-lg font-semibold">Стан протягом періоду</h2>
        <div className="renewal-chart-legend">
          {(Object.keys(labels) as Line[]).map((k) => (
            <button
              key={k}
              aria-pressed={enabled.includes(k)}
              onClick={() =>
                setEnabled(enabled.includes(k) ? enabled.filter((v) => v !== k) : [...enabled, k])
              }
            >
              <i style={{ background: colors[k] }} />
              {labels[k]}
            </button>
          ))}
        </div>
        <StateTrendCharts rows={rows} enabled={enabled} selected={selected} onSelect={setChosen} />
        <input
          className="w-full accent-[var(--color-a2)]"
          type="range"
          min={0}
          max={days - 1}
          value={index}
          onChange={(e) => setChosen(dates[Number(e.target.value)])}
          aria-label="День на графіку стану"
          aria-valuetext={selected}
        />
        <div className="renewal-inset mt-3" aria-live="polite">
          <strong>
            {new Date(selected + 'T12:00:00Z').toLocaleDateString('uk-UA', {
              day: 'numeric',
              month: 'long',
            })}
          </strong>
          <div className="renewal-metrics mt-3">
            {(Object.keys(labels) as Line[]).map((k) => (
              <div className="renewal-metric" key={k}>
                <span className="renewal-muted">{labels[k]}</span>
                <strong style={{ color: colors[k] }}>
                  {values(point, k) == null
                    ? 'Не вказано'
                    : `${values(point, k)!.toLocaleString('uk-UA', { maximumFractionDigits: 1 })} ${k === 'sleep' ? 'год' : '/5'}`}
                </strong>
              </div>
            ))}
            <div className="renewal-metric">
              <span className="renewal-muted">Слоти з відповідями</span>
              <strong>{point?.slots ?? 0}/3</strong>
            </div>
          </div>
        </div>
        <p className="renewal-chart-note mt-3">
          Енергія й настрій — оцінки від 1 до 5. Сон показано окремо в годинах. Порожня позначка
          означає день без відповіді, а не нульове значення.
        </p>
      </section>
      <section className="renewal-card">
        <h2 className="text-lg font-semibold">Профіль періоду</h2>
        <p className="renewal-muted mt-2">Складові стану з відповідей чек-іну.</p>
        {INDEX_ORDER.map((k) => {
          const v = average(profiles.map((p) => p[k])),
            n = profiles.filter((p) => p[k] != null).length;
          return (
            <details key={k} className="mt-4">
              <summary className="cursor-pointer">
                <span className="renewal-plan-lane">
                  <span>{INDEX_LABEL[k]}</span>
                  <strong>{v == null ? '—' : `${Math.round(v * 100)} /100`}</strong>
                </span>
                <div className="renewal-progress">
                  <span
                    style={{ width: v == null ? '0%' : `${v * 100}%`, background: INDEX_COLOR[k] }}
                  />
                </div>
              </summary>
              <p className="renewal-chart-note mt-2">
                {
                  {
                    recovery: 'Сон, якість ночі та можливість відключитися від справ.',
                    resource: 'Енергія, настрій, тривога та навантаження.',
                    work: 'Зусилля, результат і якість зосередження.',
                    agency: 'Контроль над днем і відповідність плану.',
                    body: 'Тілесний стан, рух і час надворі.',
                  }[k]
                }{' '}
                Є дані за {n} із {days} днів. Індекс обчислює наявна модель Світанку; це не медична
                оцінка.
              </p>
            </details>
          );
        })}
      </section>
      <section className="renewal-card">
        <span className="renewal-pill">Спостереження</span>
        <h2 className="text-lg font-semibold mt-3">Сон та енергія разом</h2>
        {long.length >= 4 && short.length >= 4 ? (
          <>
            <p className="renewal-muted mt-3">
              За сну від 7 годин енергія була {average(long.map((r) => r.p!.energy))!.toFixed(1)}/5
              ({long.length} дн.); за коротшого —{' '}
              {average(short.map((r) => r.p!.energy))!.toFixed(1)}/5 ({short.length} дн.).
            </p>
            <p className="renewal-chart-note mt-3">
              Це зв’язок у твоїх відповідях, а не доказ причини.
            </p>
          </>
        ) : (
          <p className="renewal-muted mt-3">
            Для порівняння потрібно хоча б по 4 дні з довшим і коротшим сном та оцінкою енергії.
            Зараз: {long.length} і {short.length}.
          </p>
        )}
      </section>
      <section className="renewal-card">
        <div className="renewal-section-head">
          <h2 className="text-lg font-semibold">Календар стану</h2>
          <small className="renewal-chart-note">За енергією</small>
        </div>
        <div className="renewal-calendar mb-2" aria-hidden="true">
          {['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'].map((d) => (
            <span className="text-center text-xs text-tx3" key={d}>
              {d}
            </span>
          ))}
        </div>
        <div className="renewal-calendar">
          {Array.from(
            { length: (new Date(dates[0] + 'T12:00:00Z').getUTCDay() + 6) % 7 },
            (_, i) => (
              <span key={`empty-${i}`} />
            ),
          )}
          {rows.map(({ d, p }) => (
            <button
              key={d}
              aria-label={`${d}, енергія ${p?.energy?.toFixed(1) ?? 'немає даних'}`}
              aria-pressed={selected === d}
              onClick={() => setChosen(d)}
              style={{
                background:
                  p?.energy == null
                    ? 'var(--color-glass)'
                    : `color-mix(in srgb,var(--color-a2) ${Math.round(p.energy * 14)}%,var(--color-bg2))`,
              }}
            >
              {d.slice(8)}
            </button>
          ))}
        </div>
        <p className="renewal-muted mt-3">
          Обрано {selected} ·{' '}
          {point?.energy == null ? 'Немає оцінки енергії' : `Енергія ${point.energy.toFixed(1)}/5`}.
          Деталі синхронізовані з графіком вище.
        </p>
        <SelectedDay raw={s.checkinRaw.records[selected]} point={point} />
      </section>
    </>
  );
}
