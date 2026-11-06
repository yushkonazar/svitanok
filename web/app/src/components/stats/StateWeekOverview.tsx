import { useRef, useState, type CSSProperties } from 'react';
import type { AdaptiveDay } from '../../../../core/checkin/adaptive-observations.mjs';
import type { StateWeekKey, WeekSignal } from '../../../../core/checkin/state-week.mjs';
import { StateDates } from './StateComparisons.tsx';
import { StateDayDetail } from './StateDayDetail.tsx';
import { stateDate } from './state-format.ts';
import { useReducedMotion } from '../../lib/useReducedMotion.ts';
import { usePresentation } from '../../lib/presentation.ts';

const topics = {
  sleep: 'Сон',
  mood: 'Настрій',
  energy: 'Енергія',
  plans: 'Справи',
};
type Focus = StateWeekKey | 'auto';
const focusChoices = ['auto', 'sleep', 'mood', 'energy', 'plans'] as const;
const dateLabel = new Intl.DateTimeFormat('uk-UA', { weekday: 'short', timeZone: 'UTC' });
const focusKey = (demo: boolean) => `svitanok.state-week-focus.${demo ? 'demo' : 'private'}`;
const weekday = (date: string) => dateLabel.format(new Date(`${date}T12:00:00Z`));

function savedFocus(key: string): Focus {
  try {
    const saved = localStorage.getItem(key);
    return focusChoices.find((value) => value === saved) ?? 'auto';
  } catch {
    return 'auto';
  }
}

function WeekChart({
  signal,
  selected,
  onDay,
}: {
  signal: WeekSignal;
  selected: string | undefined;
  onDay: (date: string) => void;
}) {
  const sleep = signal.key === 'sleep';
  const plans = signal.key === 'plans';
  const rating = !sleep && !plans;
  const position = (value: number) =>
    sleep ? value / signal.max : 0.12 + (0.76 * (value - 1)) / (signal.max - 1);
  const reference = signal.reference;
  const axisStyle = reference
    ? ({ '--week-reference': `${position(reference) * 100}%` } as CSSProperties)
    : undefined;
  const planSymbols = ['○', '↪', '◐', '✓'];
  return (
    <div className="state-week-chart" data-topic={signal.key} style={axisStyle}>
      {reference && <div className="state-week-reference-label">Орієнтир · 7 год</div>}
      {rating && (
        <div className="state-week-reference-label">
          <span>{signal.key === 'mood' ? '↑ Кращий настрій' : '↑ Більше сил'}</span>
          {signal.max === 3 && <span>Спільні рівні двох шкал</span>}
        </div>
      )}
      <div className="state-week-grid" role="group" aria-label={`${topics[signal.key]} за днями`}>
        {!plans && (
          <div className="state-week-plot" aria-hidden="true">
            {reference && <div className="state-week-reference" />}
            {rating && (
              <svg viewBox={`0 0 ${signal.points.length * 100} 100`} preserveAspectRatio="none">
                {signal.points.map((point, i) => {
                  const next = signal.points[i + 1];
                  return point.value == null || next?.value == null ? null : (
                    <line
                      key={point.date}
                      x1={i * 100 + 50}
                      x2={i * 100 + 150}
                      y1={100 - position(point.value) * 100}
                      y2={100 - position(next.value) * 100}
                      vectorEffect="non-scaling-stroke"
                    />
                  );
                })}
              </svg>
            )}
          </div>
        )}
        {signal.points.map(({ date, value, label }) => (
          <button
            type="button"
            key={date}
            aria-pressed={selected === date}
            aria-label={`${stateDate(date)}, ${label}`}
            onClick={() => onDay(date)}
          >
            <span className="state-week-track" aria-hidden="true">
              {value == null ? (
                <span className="state-week-gap">—</span>
              ) : plans ? (
                <span className="state-week-result" data-result={value}>
                  {planSymbols[value]}
                </span>
              ) : (
                <span
                  className={sleep ? 'state-week-bar' : 'state-week-dot'}
                  data-short={sleep && reference != null && value < reference ? true : undefined}
                  style={{ '--week-position': `${position(value) * 100}%` } as CSSProperties}
                />
              )}
            </span>
            <span className="state-week-date" aria-hidden="true">
              {weekday(date)}
              <b>{Number(date.slice(-2))}</b>
            </span>
          </button>
        ))}
      </div>
      {plans && <p className="state-week-key">✓ Завершив · ◐ Частково · ↪ Змінив · ○ Не почав</p>}
    </div>
  );
}

export function StateWeekOverview({
  signals,
  automatic,
  days,
  demo,
  selected,
  onSelect,
}: {
  signals: Record<StateWeekKey, WeekSignal>;
  automatic: StateWeekKey;
  days: AdaptiveDay[];
  demo: boolean;
  selected: string | undefined;
  onSelect: (date: string) => void;
}) {
  const key = focusKey(demo);
  const [focus, setFocus] = useState<Focus>(() => savedFocus(key));
  const detail = useRef<HTMLHeadingElement>(null);
  const { calm } = usePresentation();
  const reducedMotion = useReducedMotion();
  const signal = signals[focus === 'auto' ? automatic : focus];
  const day = days.find((entry) => entry.date === selected);
  const point = signal.points.find((entry) => entry.date === day?.date);
  const relevant = signal.context[0];
  const choose = (value: Focus) => {
    setFocus(value);
    try {
      localStorage.setItem(key, value);
    } catch {
      // The current selection is still usable.
    }
  };
  return (
    <>
      <section className="state-panel state-week" data-calm={calm} aria-label="Коротко про 7 днів">
        <div className="state-week-lead" aria-live="polite">
          <p className="state-week-eyebrow">
            {topics[signal.key]} <span>· останні 7 днів</span>
          </p>
          <h2>{signal.title}</h2>
          <p>{signal.text}</p>
        </div>
        <div className="state-week-focus" role="group" aria-label="Фокус огляду">
          {focusChoices.map((value) => (
            <button
              type="button"
              key={value}
              aria-pressed={value === focus}
              onClick={() => choose(value)}
            >
              {value === 'auto' ? 'Авто' : topics[value]}
            </button>
          ))}
        </div>
        <WeekChart
          key={`chart-${signal.key}`}
          signal={signal}
          selected={day?.date}
          onDay={onSelect}
        />
        {point && (
          <div className="state-week-day-prompt">
            <span aria-live="polite">
              {stateDate(point.date)} · {point.label}
            </span>
            <button
              type="button"
              className="state-quiet-link"
              onClick={() => {
                detail.current?.scrollIntoView?.({
                  block: 'start',
                  behavior: calm || reducedMotion ? 'instant' : 'smooth',
                });
                detail.current?.focus({ preventScroll: true });
              }}
            >
              Відповіді ↓
            </button>
          </div>
        )}
        {relevant && (
          <details className="state-week-evidence" key={`evidence-${signal.key}`}>
            <summary>
              <small>{relevant.kind === 'reported' ? 'Твоє пояснення' : 'Зв’язок у записах'}</small>
              <span>{relevant.text}</span>
            </summary>
            <div className="state-week-evidence-body">
              {signal.context.map((item, index) => (
                <div key={item.text} className="state-week-context">
                  {index > 0 && (
                    <p>
                      <b>{item.kind === 'reported' ? 'Твоє пояснення' : 'Зв’язок у записах'}</b>{' '}
                      {item.text}
                    </p>
                  )}
                  <StateDates dates={item.dates} onDay={onSelect} />
                  {item.examples?.map((example) => (
                    <p key={example.date} className="state-week-example">
                      <b>{stateDate(example.date)}</b> {example.text}
                    </p>
                  ))}
                  {item.idea && <p className="state-week-idea">{item.idea}</p>}
                </div>
              ))}
            </div>
          </details>
        )}
      </section>
      {day && (
        <section className="state-panel state-day-panel" aria-label="Записи вибраного дня">
          <div className="state-week-day-heading">
            <h2 ref={detail} tabIndex={-1}>
              Відповіді за {stateDate(day.date)}
            </h2>
          </div>
          <StateDayDetail day={day} />
        </section>
      )}
    </>
  );
}
