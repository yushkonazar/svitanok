import { useState } from 'react';
import type { Finance } from '../../api/finance-schema.ts';
import type { FinanceAnalytics } from '../../api/finance-analytics-schema.ts';
import {
  calculateTaxiWeek,
  kyivParts,
  kyivInstant,
  sumMoney,
  taxiEntryWeek,
  shiftDate,
} from '../../../../core/finance/planning.mjs';
import { quantile } from '../../../../core/finance/adaptive-model.mjs';
import { moneyLabel } from '../../lib/financeView.ts';
import { taxiPeriodLabel } from '../../lib/taxiPeriods.ts';
import { AnalyticsBars } from './AnalyticsCharts.tsx';
export function TaxiInsights({
  finance: f,
  data,
  onWeek,
}: {
  finance: Finance;
  data: FinanceAnalytics;
  onWeek: (key?: string) => void;
}) {
  const [policy, setPolicy] = useState('all'),
    [view, setView] = useState('weeks');
  const start = kyivInstant(data.selection.from, 0),
    end = kyivInstant(shiftDate(data.selection.to, 1), 0);
  const entries = f.taxiEntries.filter(
    (e) =>
      Date.parse(e.at) >= start &&
      Date.parse(e.at) < end &&
      (policy === 'all' || e.policyId === policy),
  );
  const days = new Map<string, typeof entries>();
  entries.forEach((e) => {
    const d = kyivParts(Date.parse(e.at)).date;
    days.set(d, [...(days.get(d) ?? []), e]);
  });
  const periods = f.taxiWeeks
    .filter((w) => w.from != null && w.to != null && w.from < end && w.to > start)
    .map((w) => {
      const calculated = calculateTaxiWeek(f.taxiEntries, f.policies, w.from!);
      const groups = calculated.groups.filter((g) => policy === 'all' || g.policyId === policy);
      return { week: w, groups, earned: sumMoney(groups.map((g) => g.earnedMinor)) };
    })
    .filter((w) => policy === 'all' || w.groups.length);
  const gross = sumMoney(entries.map((e) => e.netCashMinor + e.commissionMinor)),
    commission = sumMoney(entries.map((e) => e.commissionMinor)),
    fuel = sumMoney(entries.map((e) => e.fuelMinor));
  const own = sumMoney(
    f.transactions
      .filter(
        (t) =>
          t.kind === 'income' &&
          t.personalTaxiType &&
          (policy === 'all' ||
            f.policies.filter((p) => Date.parse(p.effectiveAt) <= Date.parse(t.at)).at(-1)?.id ===
              policy) &&
          Date.parse(t.at) >= start &&
          Date.parse(t.at) < end,
      )
      .map((t) => t.amountUah ?? 0),
  );
  const points = Array.from({ length: 7 }, (_, day) => {
    const amounts = [...days]
      .filter(([d]) => (new Date(d + 'T12:00Z').getUTCDay() + 6) % 7 === day)
      .map(([, rows]) => sumMoney(rows.map((e) => e.netCashMinor)));
    return {
      day,
      amounts,
      median: Math.round(quantile(amounts)),
      low: amounts.length ? Math.min(...amounts) : 0,
      high: Math.max(0, ...amounts),
    };
  });
  return (
    <>
      <section className="renewal-card">
        <h2 className="text-lg font-bold">Таксі · аналіз роботи</h2>
        <p className="renewal-chart-note mt-2">
          Календарні записи {data.selection.from} — {data.selection.to}. Отримана готівка, каса й
          заробіток мають різне значення.
        </p>
        <label className="renewal-field mt-3">
          Авто й умови
          <select value={policy} onChange={(e) => setPolicy(e.target.value)}>
            <option value="all">Усі історичні режими</option>
            {f.policies.map((p) => (
              <option key={p.id} value={p.id}>
                {p.vehicleName ?? 'Умови таксі'} · {p.effectiveAt.slice(0, 10)}
              </option>
            ))}
          </select>
        </label>
        <div className="renewal-metrics">
          <div className="renewal-metric">
            <span className="renewal-muted">Чиста каса за календарні дати</span>
            <strong>{moneyLabel(sumMoney(entries.map((e) => e.netCashMinor)))}</strong>
          </div>
          <div className="renewal-metric">
            <span className="renewal-muted">Окремі особисті надходження</span>
            <strong>{moneyLabel(own)}</strong>
          </div>
          <div className="renewal-metric">
            <span className="renewal-muted">Записані робочі дні / записи</span>
            <strong>
              {days.size} / {entries.length}
            </strong>
          </div>
          <div className="renewal-metric">
            <span className="renewal-muted">Комісія / оборот</span>
            <strong>{gross ? `${((commission / gross) * 100).toFixed(1)}%` : 'Немає бази'}</strong>
          </div>
          <div className="renewal-metric">
            <span className="renewal-muted">Пальне парку / оборот</span>
            <strong>{gross ? `${((fuel / gross) * 100).toFixed(1)}%` : 'Немає бази'}</strong>
          </div>
        </div>
        <p className="renewal-chart-note mt-3">
          Особисті витрати на мийку не змінюють ці показники. Дохід за годину й витрату на кілометр
          не обчислюємо без годин і пробігу.
        </p>
        <button className="renewal-secondary mt-3" onClick={() => onWeek()}>
          Усі перезмінки й записи змін ↗
        </button>
      </section>
      <section className="renewal-card">
        <div className="renewal-segments">
          {[
            ['weeks', 'Робочі періоди'],
            ['weekdays', 'Дні тижня'],
            ['formula', 'Формула та розрахунки'],
          ].map(([k, label]) => (
            <button key={k} aria-pressed={view === k} onClick={() => setView(k!)}>
              {label}
            </button>
          ))}
        </div>
        {view === 'weeks' && (
          <>
            <h3 className="font-bold mt-4">Заробіток у повних робочих періодах</h3>
            <AnalyticsBars
              label="Заробіток за повні робочі періоди"
              points={[...periods].reverse().map(({ week, earned }) => ({
                key: week.key,
                label: week.key.slice(8, 10) + '.' + week.key.slice(5, 7),
                amountMinor: earned,
              }))}
              onSelect={(key) => onWeek(key || undefined)}
            />
            <p className="finance-context-note mt-3">
              Нижче повні періоди, що перетинають календарний фільтр. Короткі періоди та зміни авто
              підписані; більше днів не означає кращу ефективність.
            </p>
            {periods.map(({ week: w, earned }) => {
              const dayCount = new Set(
                f.taxiEntries
                  .filter(
                    (e) =>
                      taxiEntryWeek(e, f.policies).key === w.key &&
                      (policy === 'all' || e.policyId === policy),
                  )
                  .map((e) => kyivParts(Date.parse(e.at)).date),
              ).size;
              return (
                <button key={w.key} className="analytics-operation" onClick={() => onWeek(w.key)}>
                  <span>
                    {taxiPeriodLabel(w.key, f.policies)}
                    <small>
                      {dayCount} записаних днів · {w.closed ? 'завершений період' : 'ще триває'}
                      {w.from != null && w.to != null && w.to - w.from < 6 * 86400000
                        ? ' · короткий період'
                        : ''}
                    </small>
                    <small>
                      За записаний день{' '}
                      {dayCount ? moneyLabel(Math.round(earned / dayCount)) : 'немає даних'}
                    </small>
                  </span>
                  <b>{moneyLabel(earned)} ↗</b>
                </button>
              );
            })}
          </>
        )}
        {view === 'weekdays' && (
          <>
            <h3 className="font-bold mt-4">Каса у записані робочі дні</h3>
            <AnalyticsBars
              label="Медіанна чиста каса за робочий день тижня"
              points={points
                .filter((p) => p.amounts.length)
                .map((p) => ({
                  key: String(p.day),
                  label: ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'][p.day]!,
                  amountMinor: p.median,
                }))}
            />
            {points.map((p) => (
              <div className="analytics-row" key={p.day}>
                <span>
                  {
                    ['Понеділок', 'Вівторок', 'Середа', 'Четвер', 'П’ятниця', 'Субота', 'Неділя'][
                      p.day
                    ]
                  }
                  <small>{p.amounts.length} записаних днів</small>
                </span>
                <span>
                  {p.amounts.length ? `Медіана ${moneyLabel(p.median)}` : 'Немає спостережень'}
                  <small>
                    {p.amounts.length
                      ? `${moneyLabel(Math.min(...p.amounts))} — ${moneyLabel(p.high)}`
                      : ''}
                  </small>
                </span>
              </div>
            ))}
            <p className="renewal-chart-note mt-3">
              Це каса, не особистий заробіток. Дні без записів не оголошуються вихідними. За малих
              вибірок показані значення не доводять стабільної закономірності.
            </p>
          </>
        )}
        {view === 'formula' && (
          <>
            <h3 className="font-bold mt-4">Від обороту до заробітку</h3>
            <p className="renewal-chart-note mt-2">
              Чинні історичні частки застосовані до повних робочих періодів, що перетинають вибрані
              дати.
            </p>
            {periods.map(({ week: w, groups, earned }) => (
              <details className="renewal-inset mt-3" key={w.key}>
                <summary className="renewal-link">
                  {taxiPeriodLabel(w.key, f.policies)} · {moneyLabel(earned)}
                </summary>
                {groups.map((g) => (
                  <p className="renewal-chart-note mt-3" key={g.policyId}>
                    {g.fareBps / 100}% від {moneyLabel(g.grossMinor)} обороту; комісія{' '}
                    {moneyLabel(g.commissionMinor)}, пальне {moneyLabel(g.fuelMinor)}, частка
                    додаткових надходжень {moneyLabel(g.extrasMinor)} → заробіток{' '}
                    {moneyLabel(g.earnedMinor)}.
                  </p>
                ))}
                <div className="analytics-row">
                  <span>Очікуваний розрахунок із парком</span>
                  <b>{moneyLabel(w.expectedSettlementMinor ?? w.settlementMinor)}</b>
                </div>
                <div className="analytics-row">
                  <span>Фактичний розрахунок</span>
                  <b>
                    {w.actualSettlementMinor == null
                      ? 'Ще не підтверджено'
                      : moneyLabel(w.actualSettlementMinor)}
                  </b>
                </div>
                {w.settlementDifferenceMinor != null && (
                  <p
                    className={`finance-context-note mt-2 ${w.settlementDifferenceMinor < 0 ? 'text-neg' : ''}`}
                  >
                    Різниця: {moneyLabel(w.settlementDifferenceMinor)}. Мінус означає, що отримано
                    менше або сплачено більше.
                  </p>
                )}
                <button className="renewal-link mt-3" onClick={() => onWeek(w.key)}>
                  Записи й пояснення ↗
                </button>
              </details>
            ))}
          </>
        )}
        {!entries.length && !periods.length && (
          <p className="renewal-muted mt-4">У цьому періоді й режимі записів немає.</p>
        )}
      </section>
    </>
  );
}
