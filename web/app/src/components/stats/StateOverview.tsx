import type { StateReport } from '../../../../core/checkin/state-analysis.mjs';
import type { CheckinSlot } from '../../api/schema.ts';
import { stateDate, stateDays, stateDuration } from './state-format.ts';
import {
  stateBand,
  stateBandNames,
  stateBands,
  stateBuckets,
  stateHasSlots,
  stateMetricNames,
  stateRollup,
  stateSeries,
  stateSlots,
  stateSlotColors,
  stateValues,
  type StateMetricKey,
} from './state-series.ts';
import { StateBandLegend, StateBands, StateChangeAxis, StateChangeBar } from './StateVisuals.tsx';

const cardMetrics = ['energy', 'mood', 'sleep', 'satisfaction'] as const;
const slotLabel = { morning: 'зранку', afternoon: 'вдень', evening: 'увечері' };
const headlines = {
  energy: ['Частіше мало сил', 'Переважно помірна', 'Частіше багато сил'],
  mood: ['Частіше складний', 'Частіше змішаний', 'Частіше хороший'],
  satisfaction: ['Частіше важко', 'Частіше змішано', 'Частіше добре'],
};
const mixed = { energy: 'Рівень різнився', mood: 'Мінливий', satisfaction: 'Різні дні' };

export function StateOverview({
  report,
  onMetric,
  onWork,
  explanations,
}: {
  report: StateReport;
  onMetric: (metric: StateMetricKey, slot: CheckinSlot) => void;
  onWork: () => void;
  explanations: boolean;
}) {
  const workInsight = report.insights.find((item) => item.id === 'work_breaks');
  const work = workInsight?.comparison;
  const paired = stateValues(stateSeries(report.current, 'change'));
  const changeCounts = stateBands(paired, 'change');
  const cards = cardMetrics.flatMap((metric) => {
    const slots = stateHasSlots(metric)
      ? (['evening', 'morning', 'afternoon'] as const)
      : ([metric === 'sleep' ? 'morning' : 'evening'] as const);
    const slot = slots.find(
      (slot) => stateValues(stateSeries(report.current, metric, slot)).length,
    );
    if (!slot) return [];
    const series = stateSeries(report.current, metric, slot);
    const prior = stateSeries(report.previous, metric, slot);
    const n = stateValues(series).length,
      previousN = stateValues(prior).length;
    const value = stateRollup(series, metric)!;
    const delta = n >= 3 && previousN >= 3 ? value - stateRollup(prior, metric)! : null;
    const counts = metric === 'sleep' ? null : stateBands(series, metric);
    const dominant = counts?.findIndex((count) => count > n / 2) ?? -1;
    const headline =
      metric === 'sleep'
        ? stateDuration(value, 5)
        : dominant < 0
          ? mixed[metric]
          : headlines[metric][dominant];
    const still = delta != null && Math.abs(delta) < 0.25;
    const trend =
      delta == null
        ? stateDays(n)
        : still
          ? '→ Майже без змін'
          : delta > 0
            ? metric === 'sleep'
              ? '↗ Довше'
              : '↗ Вище'
            : metric === 'sleep'
              ? '↘ Коротше'
              : '↘ Нижче';
    const history = stateBuckets(series, metric, report.days === 90);
    const max = metric === 'sleep' ? Math.max(8, ...stateValues(series), ...stateValues(prior)) : 5;
    return [
      {
        metric,
        slot,
        headline,
        trend,
        n,
        previousN,
        counts,
        history,
        max,
        comparable: delta != null,
      },
    ];
  });
  return (
    <>
      {(work || paired.length > 0) && (
        <article className="state-lead">
          <span className="state-insight-kind">{work ? 'Робота · спостереження' : 'Ритм дня'}</span>
          <h2>{workInsight?.title ?? 'Енергія від ранку до вечора'}</h2>
          {work ? (
            <>
              <div className="state-lead-axis">
                <StateChangeAxis />
              </div>
              {[1, 0].map((index) => {
                const group = work.groups[index]!;
                return (
                  <div key={group.label} className="state-lead-group">
                    <span>{group.label}</span>
                    <StateChangeBar value={group.value!} index={index} />
                    <small>{stateDays(group.n)}</small>
                  </div>
                );
              })}
              <p className="state-caption">Робота 4–менше 8 год · середня зміна сил за день</p>
            </>
          ) : (
            <>
              <StateBands counts={changeCounts} metric="change" />
              <StateBandLegend counts={changeCounts} metric="change" />
              <p className="state-caption">
                {stateDays(paired.length)} з ранковим і вечірнім чек-інами
              </p>
            </>
          )}
          <button
            type="button"
            className="state-quiet-link"
            onClick={work ? onWork : () => onMetric('change', 'evening')}
          >
            {work ? 'Відкрити зіставлення' : 'Подивитися на графіку'}{' '}
            <span aria-hidden="true">→</span>
          </button>
        </article>
      )}
      <div className="state-overview" aria-label="Основні показники">
        {cards.map(({ metric, slot, headline, trend, n, counts, history, max }) => (
          <button
            type="button"
            className={`state-metric state-metric-${metric}`}
            key={metric}
            aria-description={`${stateDays(n)} з оцінкою за період`}
            onClick={() => onMetric(metric, slot)}
          >
            <span>
              {stateMetricNames[metric]}
              {stateHasSlots(metric) ? ` ${slotLabel[slot]}` : ''} <span aria-hidden="true">↗</span>
            </span>
            <b>{headline}</b>
            {metric === 'satisfaction' && counts ? (
              <span className="state-mini-score">
                <StateBands counts={counts} metric={metric} />
                <span className="state-mini-labels" aria-hidden="true">
                  {stateBandNames.satisfaction.map((word) => (
                    <span key={word}>{word}</span>
                  ))}
                </span>
              </span>
            ) : (
              <span
                className="state-mini"
                data-dense={history.length > 18 || undefined}
                aria-hidden="true"
              >
                {history.map(({ value }, i) => (
                  <span key={i}>
                    {value == null ? (
                      <i className="state-mini-gap" />
                    ) : (
                      <i
                        className={
                          metric === 'mood'
                            ? `state-mini-dot state-band-${stateBand(value, metric)}`
                            : 'state-mini-bar'
                        }
                        style={
                          metric === 'mood'
                            ? { bottom: `${6 + (value - 1) * 18}%` }
                            : {
                                height: `${Math.max(5, (100 * value) / max)}%`,
                                background:
                                  metric === 'sleep'
                                    ? 'var(--color-a2)'
                                    : stateSlotColors[stateSlots.indexOf(slot)],
                              }
                        }
                      />
                    )}
                  </span>
                ))}
              </span>
            )}
            <span className="state-delta">{trend}</span>
          </button>
        ))}
      </div>
      {cards.length === 0 && (
        <p className="state-empty">
          Є записи чек-інів. Графіки з’являться після першої оцінки або запису про сон.
        </p>
      )}
      {cards.some((card) => card.comparable) && (
        <p className="state-caption">Стрілки порівнюють із попереднім рівним періодом</p>
      )}
      {cards.length > 0 && (
        <details className="state-subdetails" open={explanations || undefined}>
          <summary>Як читати показники</summary>
          <p className="state-caption">
            У картках енергії й настрою пріоритет має вечір. Якщо вечірніх оцінок немає, беремо
            ранкові, а тоді денні. Порівнюємо однакові частини дня.
          </p>
          <p className="state-caption">
            Попередній період {stateDate(report.previousFrom)} — {stateDate(report.previousTo)}. Для
            стрілки потрібно від трьох записів у кожному періоді. «Майже без змін» означає різницю
            менш як чверть бала або 15 хв сну.
          </p>
          <p className="state-caption">
            Для сну показуємо медіану з округленням до п’яти хвилин. Мініграфіки за 90 днів
            згруповані за тижнями, а розподіл оцінок дня враховує кожну відповідь.
          </p>
          {cards.map(({ metric, n, previousN }) => (
            <p className="state-caption" key={metric}>
              {stateMetricNames[metric]} · {stateDays(n)} зараз і {stateDays(previousN)} у
              попередньому періоді.
            </p>
          ))}
        </details>
      )}
    </>
  );
}
