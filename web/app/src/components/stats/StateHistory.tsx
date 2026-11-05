import { useMemo, useState } from 'react';
import { useArchive } from '../../api/hooks.ts';
import { stateHistoryMonths, stateHistorySeries } from '../../../../core/checkin/state-history.mjs';
import { ObservationChart } from '../charts/ObservationChart.tsx';
import { HistoryBlock } from './HistoryBlock.tsx';
import { stateCount, stateMonth, statePoints, stateSleep, slotNames } from './state-format.ts';
import { stateBand, stateBandNames } from './state-series.ts';

const metrics = [
  ['energy', 'Енергія'],
  ['mood', 'Настрій'],
  ['sleep', 'Сон'],
  ['satisfaction', 'Оцінка дня'],
] as const;
type HistoryMetric = (typeof metrics)[number][0];
const qualitative = (metric: Exclude<HistoryMetric, 'sleep'>, value: number) =>
  stateBandNames[metric][stateBand(value, metric)];
function historyValue(metric: HistoryMetric, value: number | null) {
  if (value == null) return '—';
  return metric === 'sleep' ? stateSleep(value) : qualitative(metric, value);
}
export function StateHistory({
  records,
  from,
  to,
}: {
  records: Record<string, Record<string, unknown>>;
  from: string;
  to: string;
}) {
  const [open, setOpen] = useState(false),
    [range, setRange] = useState<'all' | 'year'>('all'),
    [metric, setMetric] = useState<HistoryMetric>('energy');
  const archive = useArchive(open);
  const months = useMemo(
    () => (open ? stateHistoryMonths(archive.data ?? [], records, from, to) : []),
    [open, archive.data, records, from, to],
  );
  const history = useMemo(
    () => stateHistorySeries(months, metric, to, range),
    [months, metric, to, range],
  );
  const visible = history.series.filter((item) => item.n > 0);
  const label = metrics.find(([id]) => id === metric)![1];
  return (
    <details className="state-panel" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <span>Історія за місяцями</span>
        <small>Увесь доступний час</small>
      </summary>
      {open && (
        <div className="state-panel-body">
          <div className="renewal-segments">
            <button type="button" aria-pressed={range === 'all'} onClick={() => setRange('all')}>
              Увесь час
            </button>
            <button type="button" aria-pressed={range === 'year'} onClick={() => setRange('year')}>
              {to.slice(0, 4)} рік
            </button>
          </div>
          <label className="renewal-field">
            <span>Показник історії</span>
            <select value={metric} onChange={(e) => setMetric(e.target.value as HistoryMetric)}>
              {metrics.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          {archive.isLoading && (
            <p role="status" className="state-caption">
              Завантажую давні підсумки…
            </p>
          )}
          {archive.isError && (
            <div className="state-empty">
              <p>Давні підсумки не завантажилися. Наявні записи залишаються доступними.</p>
              <button
                type="button"
                className="renewal-secondary"
                onClick={() => void archive.refetch()}
              >
                Спробувати ще раз
              </button>
            </div>
          )}
          {!!history.n && (
            <div className="state-history-total">
              <span>
                {label} · {history.from && stateMonth(history.from)} —{' '}
                {history.to && stateMonth(history.to)}
              </span>
              <b>{historyValue(metric, history.value)}</b>
              <small>{history.n} відповідей</small>
              {metric !== 'sleep' && history.value != null && (
                <details className="state-subdetails state-exact">
                  <summary>Точне середнє за період</summary>
                  <p className="state-caption">{statePoints(history.value)}</p>
                </details>
              )}
            </div>
          )}
          {visible.length >= 4 && (
            <ObservationChart
              key={`${metric}-${range}`}
              points={visible.map((item) => ({ date: item.date, value: item.value! }))}
              label={`${label} за місяцями`}
              unit={metric === 'sleep' ? 'год' : undefined}
              formatValue={metric === 'sleep' ? undefined : (value) => qualitative(metric, value)}
              domain={metric === 'sleep' ? undefined : [1, 5]}
              maxGapDays={40}
              formatDate={stateMonth}
            />
          )}
          {!visible.length && !archive.isLoading && (
            <p className="state-empty">Для цього показника ще немає сумісних місячних підсумків.</p>
          )}
          {history.series
            .filter(
              (item) =>
                item.n > 0 || months.find((m) => m.month === item.month)?.observationsV3?.days,
            )
            .map((item) => {
              const month = months.find((m) => m.month === item.month)!;
              const named = Object.entries(month.observationsV3?.metrics ?? {}).filter(
                ([, value]) => Object.keys(value.counts).some((id) => id.startsWith('user_')),
              );
              return (
                <details className="state-month" key={item.month}>
                  <summary>
                    <span>
                      {stateMonth(item.month)}
                      {item.month === to.slice(0, 7) ? ' · триває' : ''}
                    </span>
                    <b>{historyValue(metric, item.value)}</b>
                    <small>{item.n} відп.</small>
                  </summary>
                  <div className="state-month-body">
                    <p className="state-caption">
                      Місячний підсумок. Окремі відповіді й зв’язки між ними доступні лише там, де
                      збережені конкретні дні.
                    </p>
                    {metrics.map(([id, name]) => {
                      const row = stateHistorySeries([month], id, to);
                      return row.n ? (
                        <div className="state-month-metric" key={id}>
                          <span>{name}</span>
                          <b>{historyValue(id, row.value)}</b>
                          <small>{row.n} відп.</small>
                        </div>
                      ) : null;
                    })}
                    <details className="state-subdetails state-exact">
                      <summary>Точні середні за місяць</summary>
                      {metrics
                        .filter(([id]) => id !== 'sleep')
                        .map(([id, name]) => {
                          const row = stateHistorySeries([month], id, to);
                          return row.value == null ? null : (
                            <p className="state-caption" key={id}>
                              {name} · {statePoints(row.value)}
                            </p>
                          );
                        })}
                    </details>
                    {named.length > 0 && (
                      <details className="state-subdetails">
                        <summary>Власні варіанти в цьому місяці</summary>
                        {named.map(([key, value]) => (
                          <div className="state-distribution" key={key}>
                            <h4>
                              {slotNames[key.split('.')[0] as keyof typeof slotNames]} ·{' '}
                              {value.label ?? 'Власні відповіді'}
                            </h4>
                            {Object.entries(value.counts)
                              .filter(([id]) => id.startsWith('user_'))
                              .map(([id, count]) => (
                                <div key={id}>
                                  <p>
                                    {value.labels?.[id] ?? 'Власний варіант'} ·{' '}
                                    {stateCount(count, 'згадка', 'згадки', 'згадок')} з {value.n}{' '}
                                    відповідей
                                  </p>
                                  {Object.keys(value.labelCounts?.[id] ?? {}).length > 1 && (
                                    <p className="state-caption">
                                      Назви в записах:{' '}
                                      {Object.entries(value.labelCounts![id])
                                        .map(([name, n]) => `${name} (${n})`)
                                        .join('; ')}
                                    </p>
                                  )}
                                </div>
                              ))}
                          </div>
                        ))}
                      </details>
                    )}
                  </div>
                </details>
              );
            })}
          <p className="state-caption">
            Середні враховують кількість відповідей. Давні формулювання з іншими шкалами показуються
            окремо.
          </p>
          {!!archive.data?.some(
            (m) => m.observationsV2 || m.dayScoreAvg != null || m.sleepAvg != null,
          ) && (
            <details className="state-subdetails">
              <summary>Попередні формулювання й активність</summary>
              <HistoryBlock />
            </details>
          )}
        </div>
      )}
    </details>
  );
}
