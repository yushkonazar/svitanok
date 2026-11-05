import { useState } from 'react';
import {
  STATE_FACTORS,
  compareState,
  stateOutcomes,
  stateCompanyOptions,
  stateDistribution,
  type StateComparison,
} from '../../../../core/checkin/state-analysis.mjs';
import type { AdaptiveDay } from '../../../../core/checkin/adaptive-observations.mjs';
import type { CheckinSlot } from '../../api/schema.ts';
import { stateDate, stateNumber, stateSleep, slotNames } from './state-format.ts';

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
}: {
  result: StateComparison;
  onDay: (date: string) => void;
}) {
  const change = result.outcome === 'energy_change';
  return (
    <div className="state-comparison-result">
      <p className="state-caption">{result.outcomeLabel}. Попереднє зіставлення власних оцінок.</p>
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
      {result.groups.map((group, i) => (
        <div key={i} className="state-contrast-group">
          <div>
            <span>{group.label}</span>
            <b>
              {group.n
                ? `${change && (group.value ?? 0) > 0 ? '+' : ''}${stateNumber(group.value)}${change ? ' б.' : ' /5'}`
                : '—'}
            </b>
          </div>
          <small>Зіставних записів: {group.n}</small>
          {result.ready && (
            <div className={`state-contrast-bar${change ? ' is-change' : ''}`} aria-hidden="true">
              <span
                style={{
                  width: `${change ? Math.min(50, (Math.abs(group.value ?? 0) / 4) * 50) : Math.max(0, Math.min(100, (((group.value ?? 0) - result.domain[0]!) / (result.domain[1]! - result.domain[0]!)) * 100))}%`,
                  left: change
                    ? `${(group.value ?? 0) < 0 ? 50 - (Math.abs(group.value ?? 0) / 4) * 50 : 50}%`
                    : undefined,
                  background: i ? 'var(--color-a2)' : 'var(--color-info)',
                }}
              />
            </div>
          )}
          <StateDates dates={group.dates} onDay={onDay} />
        </div>
      ))}
      {!result.ready ? (
        <p className="state-empty">
          Для зіставлення потрібно щонайменше по 3 доречні записи в обох групах. Наявні відповіді
          вже видно вище.
        </p>
      ) : (
        <p className="state-caption">
          Це зв’язок у записах. На різницю також могли впливати інші обставини.
        </p>
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
}: {
  days: AdaptiveDay[];
  slot: string;
  stem: string;
  revision?: number;
  title: string;
  onDay: (date: string) => void;
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
            <b>
              {item.count}/{distribution.n}
            </b>
          </summary>
          <StateDates dates={item.dates} onDay={onDay} />
        </details>
      ))}
    </div>
  );
}
export function StateComparisons({
  days,
  onDay,
}: {
  days: AdaptiveDay[];
  onDay: (date: string) => void;
}) {
  const [mode, setMode] = useState('compare'),
    [factor, setFactor] = useState('sleep_duration'),
    [outcome, setOutcome] = useState('morning_energy'),
    [slot, setSlot] = useState<CheckinSlot>('evening'),
    [company, setCompany] = useState('partner'),
    [mood, setMood] = useState('good');
  const outcomes = stateOutcomes(factor, slot),
    actual = outcomes.some(([, id]) => id === outcome) ? outcome : outcomes[0]![1];
  const companies = stateCompanyOptions(days, slot),
    selectedCompany = companies.some((x) => x.id === company)
      ? company
      : (companies[0]?.id ?? 'partner');
  const result = compareState(days, factor, actual, { slot, company: selectedCompany });
  const reasonDays = days.filter((d) =>
    mood === 'good'
      ? [4, 5].includes(d[slot].mood)
      : mood === 'mixed'
        ? d[slot].mood === 3
        : [1, 2].includes(d[slot].mood),
  );
  return (
    <div className="state-explorer">
      <div className="renewal-segments">
        <button type="button" aria-pressed={mode === 'compare'} onClick={() => setMode('compare')}>
          Зіставлення
        </button>
        <button type="button" aria-pressed={mode === 'reasons'} onClick={() => setMode('reasons')}>
          Твої пояснення
        </button>
      </div>
      {mode === 'compare' ? (
        <>
          <label className="renewal-field">
            <span>Що порівняти</span>
            <select value={factor} onChange={(e) => setFactor(e.target.value)}>
              {STATE_FACTORS.map(([label, id]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
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
          <ComparisonResult result={result} onDay={onDay} />
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
              <option value="good">Хороший · 4–5</option>
              <option value="mixed">Нейтральний або змішаний · 3</option>
              <option value="poor">Складний · 1–2</option>
            </select>
          </label>
          <StateDistributionView
            days={reasonDays}
            slot={slot}
            stem="moodFactors"
            title="Що ти пов’язував із настроєм"
            onDay={onDay}
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
