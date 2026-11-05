import { useMemo, useState } from 'react';
import {
  STATE_FACTORS,
  STATE_WORK_RANGES,
  compareState,
  stateOutcomes,
  stateCompanyOptions,
  stateDistribution,
  type StateComparison,
} from '../../../../core/checkin/state-analysis.mjs';
import type { AdaptiveDay } from '../../../../core/checkin/adaptive-observations.mjs';
import type { CheckinSlot } from '../../api/schema.ts';
import {
  stateCount,
  stateDate,
  stateDays,
  statePoints,
  stateSleep,
  slotNames,
} from './state-format.ts';
import { stateBands, type StateMetricKey } from './state-series.ts';
import { StateBandLegend, StateBands, StateChangeAxis, StateChangeBar } from './StateVisuals.tsx';

export interface StateEvidence {
  metric: StateMetricKey;
  slot: CheckinSlot;
  label: string;
  dates: string[];
}

export function StateDates({ dates, onDay }: { dates: string[]; onDay: (date: string) => void }) {
  const [all, setAll] = useState(false),
    unique = [...new Set(dates)].sort();
  return (
    <div className="state-date-links">
      {(all ? unique : unique.slice(-6)).map((date) => (
        <button type="button" key={date} onClick={() => onDay(date)}>
          {stateDate(date)}
        </button>
      ))}
      {unique.length > 6 && (
        <button type="button" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? 'Менше дат' : `Усі ${unique.length} дат`}
        </button>
      )}
    </div>
  );
}
export function ComparisonResult({
  result,
  onDay,
  onGraph,
  onGroupChange,
}: {
  result: StateComparison;
  onDay: (date: string) => void;
  onGraph?: (group: StateEvidence) => void;
  onGroupChange?: () => void;
}) {
  const change = result.outcome === 'energy_change';
  const metric = change
    ? 'change'
    : result.outcome.endsWith('_mood')
      ? 'mood'
      : result.outcome.endsWith('_energy')
        ? 'energy'
        : 'satisfaction';
  const slot = result.outcome.startsWith('morning_')
    ? 'morning'
    : result.outcome.startsWith('afternoon_')
      ? 'afternoon'
      : 'evening';
  const [group, setGroup] = useState(result.factor === 'work_breaks' ? 1 : 0);
  const evidence = result.groups[group]?.n
    ? result.groups[group]!
    : result.groups.find((item) => item.n);
  const groups = result.groups.map((item, index) => ({ item, index }));
  if (result.factor === 'work_breaks') groups.reverse();
  return (
    <div className="state-comparison-result">
      <h3>{result.outcomeLabel}</h3>
      {result.median != null && (
        <p className="state-caption">
          Межа коротшого й довшого сну в цих записах: {stateSleep(result.median)}.
        </p>
      )}
      {result.from && (
        <p className="state-caption">
          Від першої згадки обраного варіанта: {stateDate(result.from)}.
        </p>
      )}
      {result.ready && (change ? <StateChangeAxis /> : <StateBandLegend metric={metric} />)}
      <div className="state-contrast-groups">
        {groups.map(({ item, index }) => (
          <button
            type="button"
            key={index}
            className="state-contrast-group"
            aria-pressed={evidence === item}
            disabled={!item.n}
            onClick={() => {
              setGroup(index);
              onGroupChange?.();
            }}
          >
            <span>
              <span>{item.label}</span>
              <small>{stateDays(item.n)}</small>
            </span>
            {result.ready &&
              (change ? (
                <StateChangeBar value={item.value!} index={index} />
              ) : (
                <StateBands counts={stateBands(item.values, metric)} metric={metric} />
              ))}
          </button>
        ))}
      </div>
      {!result.ready ? (
        <p className="state-empty">
          Для зіставлення потрібно щонайменше по 3 доречні записи в обох групах.
        </p>
      ) : (
        <p className="state-caption">
          {change ? 'Середня зміна в кожній групі.' : 'Розподіл оцінок у кожній групі.'} На різницю
          могли впливати інші обставини.
        </p>
      )}
      {result.ready && (
        <details className="state-subdetails state-exact">
          <summary>Точні значення</summary>
          {groups.map(({ item, index }) => (
            <p className="state-caption" key={index}>
              {item.label} · середнє {statePoints(item.value!, change)}
            </p>
          ))}
        </details>
      )}
      {evidence && (
        <div className="state-comparison-dates">
          <div>
            <h4>{evidence.label}</h4>
            {onGraph && !result.outcome.endsWith('_comprehension') && (
              <button
                type="button"
                className="state-quiet-link"
                onClick={() =>
                  onGraph({ metric, slot, label: evidence.label, dates: evidence.dates })
                }
              >
                На графіку <span aria-hidden="true">→</span>
              </button>
            )}
          </div>
          <StateDates dates={evidence.dates} onDay={onDay} />
        </div>
      )}
    </div>
  );
}
export function StateDistributionView({
  days,
  slot,
  stem,
  revision,
  title,
  onDay,
  onGraph,
}: {
  days: AdaptiveDay[];
  slot: string;
  stem: string;
  revision?: number;
  title: string;
  onDay: (date: string) => void;
  onGraph?: (label: string, dates: string[]) => void;
}) {
  const distribution = stateDistribution(days, slot, stem, revision);
  if (!distribution.n) return null;
  return (
    <div className="state-distribution">
      <h4>{title}</h4>
      <p className="state-caption">Відповідей на уточнення: {distribution.n}</p>
      {distribution.items.map((item) => (
        <details key={item.id} className="state-frequency">
          <summary>
            <span>{item.label}</span>
            <b>{stateCount(item.count, 'згадка', 'згадки', 'згадок')}</b>
            <span className="state-mention-track" aria-hidden="true">
              <span style={{ width: `${Math.min(100, (item.count / distribution.n) * 100)}%` }} />
            </span>
          </summary>
          <StateDates dates={item.dates} onDay={onDay} />
          {onGraph && (
            <button
              type="button"
              className="state-quiet-link"
              onClick={() => onGraph(item.label, item.dates)}
            >
              На графіку <span aria-hidden="true">→</span>
            </button>
          )}
        </details>
      ))}
    </div>
  );
}
export function StateComparisons({
  days,
  onDay,
  onGraph,
  onContextChange,
}: {
  days: AdaptiveDay[];
  onDay: (date: string) => void;
  onGraph: (group: StateEvidence) => void;
  onContextChange: () => void;
}) {
  const [mode, setMode] = useState('compare'),
    [factor, setFactor] = useState('work_breaks'),
    [outcome, setOutcome] = useState('energy_change'),
    [workRange, setWorkRange] = useState('4_8h'),
    [slot, setSlot] = useState<CheckinSlot>('evening'),
    [company, setCompany] = useState('partner'),
    [mood, setMood] = useState('good');
  const { outcomes, actual, companies, selectedCompany, result } = useMemo(() => {
    const outcomes = stateOutcomes(factor, slot);
    const actual = outcomes.some(([, id]) => id === outcome) ? outcome : outcomes[0]![1];
    const companies = stateCompanyOptions(days, slot);
    const selectedCompany = companies.some((item) => item.id === company)
      ? company
      : (companies[0]?.id ?? 'partner');
    const result = compareState(days, factor, actual, {
      slot,
      company: selectedCompany,
      workRange,
    });
    return { outcomes, actual, companies, selectedCompany, result };
  }, [days, factor, outcome, slot, company, workRange]);
  const reasonDays = days.filter((d) =>
    mood === 'good'
      ? [4, 5].includes(d[slot].mood)
      : mood === 'mixed'
        ? d[slot].mood === 3
        : [1, 2].includes(d[slot].mood),
  );
  return (
    <div className="state-explorer" onChange={onContextChange}>
      <div className="renewal-segments">
        <button
          type="button"
          aria-pressed={mode === 'compare'}
          onClick={() => {
            setMode('compare');
            onContextChange();
          }}
        >
          Зіставлення
        </button>
        <button
          type="button"
          aria-pressed={mode === 'reasons'}
          onClick={() => {
            setMode('reasons');
            onContextChange();
          }}
        >
          Мої пояснення
        </button>
      </div>
      {mode === 'compare' ? (
        <>
          <label className="renewal-field">
            <span>Що порівняти</span>
            <select
              value={factor}
              onChange={(e) => {
                const next = e.target.value;
                setFactor(next);
                setOutcome(
                  next === 'work_breaks'
                    ? 'energy_change'
                    : next === 'personal_time'
                      ? 'satisfaction'
                      : stateOutcomes(next, slot)[0]![1],
                );
              }}
            >
              {STATE_FACTORS.map(([label, id]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {factor === 'work_breaks' && (
            <label className="renewal-field">
              <span>Тривалість роботи</span>
              <select value={workRange} onChange={(e) => setWorkRange(e.target.value)}>
                {STATE_WORK_RANGES.map(([label, id]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
                <option value="">Усі з відповіддю про перерви</option>
              </select>
            </label>
          )}
          {factor === 'company' && (
            <>
              <label className="renewal-field">
                <span>Час запису</span>
                <select value={slot} onChange={(e) => setSlot(e.target.value as CheckinSlot)}>
                  {Object.entries(slotNames).map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="renewal-field">
                <span>Компанія для порівняння з «сам»</span>
                <select value={selectedCompany} onChange={(e) => setCompany(e.target.value)}>
                  {companies.length ? (
                    companies.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.label}
                      </option>
                    ))
                  ) : (
                    <option value="partner">Ще немає відповідей про компанію</option>
                  )}
                </select>
              </label>
            </>
          )}
          <label className="renewal-field">
            <span>Показник</span>
            <select value={actual} onChange={(e) => setOutcome(e.target.value)}>
              {outcomes.map(([label, id]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {factor === 'work_breaks' && !workRange && (
            <p className="state-caption">У групах поєднані різні тривалості роботи.</p>
          )}
          <ComparisonResult
            result={result}
            onDay={onDay}
            onGraph={onGraph}
            onGroupChange={onContextChange}
          />
        </>
      ) : (
        <>
          <label className="renewal-field">
            <span>Час пояснення</span>
            <select value={slot} onChange={(e) => setSlot(e.target.value as CheckinSlot)}>
              {Object.entries(slotNames).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="renewal-field">
            <span>Який настрій пояснюєш</span>
            <select value={mood} onChange={(e) => setMood(e.target.value)}>
              <option value="good">Хороший</option>
              <option value="mixed">Нейтральний або змішаний</option>
              <option value="poor">Складний</option>
            </select>
          </label>
          <StateDistributionView
            days={reasonDays}
            slot={slot}
            stem="moodFactors"
            title="Що ти пов’язував із настроєм"
            onDay={onDay}
            onGraph={(label, dates) => onGraph({ metric: 'mood', slot, label, dates })}
          />
          {!reasonDays.some((d) => d[slot].moodFactorsV4 || d[slot].moodFactorsV3) && (
            <p className="state-empty">
              Пояснення з’являться після відповідного уточнення в чек-іні.
            </p>
          )}
          <p className="state-caption">
            Це твої пояснення. Варіанти залежать від оцінки настрою, тому їхня частота не є доказом
            впливу.
          </p>
        </>
      )}
    </div>
  );
}
