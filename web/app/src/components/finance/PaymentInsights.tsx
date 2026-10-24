import { useState } from 'react';
import type { Finance } from '../../api/finance-schema.ts';
import {
  paymentSchedule,
  PAYMENT_KIND_LABELS,
  isDebtKind,
} from '../../../../core/finance/payments.mjs';
import { kyivParts, shiftDate, sumMoney } from '../../../../core/finance/planning.mjs';
import { periodWindow } from '../../lib/budgetPlanning.ts';
import { moneyLabel } from '../../lib/financeView.ts';
import { AnalyticsBars } from './AnalyticsCharts.tsx';
function endDate(p: Finance['payments'][number]) {
  const last = paymentSchedule(p, 1200).at(-1);
  return last &&
    ((last.remaining === 0 && (last.extraRemaining ?? 0) === 0) ||
      p.installmentsLeft != null ||
      p.recurrence === 'once')
    ? last.date
    : null;
}
export function PaymentInsights({
  finance: f,
  nowMs,
  onPayment,
}: {
  finance: Finance;
  nowMs: number;
  onPayment: (id: string) => void;
}) {
  const today = kyivParts(nowMs).date;
  const [horizon, setHorizon] = useState('month'),
    [kind, setKind] = useState('all'),
    [day, setDay] = useState<string | null>(null),
    [grid, setGrid] = useState(false),
    [monthChoice, setMonth] = useState(''),
    [sort, setSort] = useState('end'),
    [limit, setLimit] = useState(60);
  const [custom, setCustom] = useState({ from: today, to: periodWindow('month', today).end });
  const next = shiftDate(periodWindow('month', today).end, 1);
  const from = horizon === 'nextMonth' ? next : horizon === 'custom' ? custom.from : today;
  const to =
    horizon === 'nextMonth'
      ? periodWindow('month', next).end
      : horizon === 'week'
        ? periodWindow('week', today).end
        : horizon === 'month'
          ? periodWindow('month', today).end
          : horizon === 'custom'
            ? custom.to
            : shiftDate(today, Number(horizon) - 1);
  const active = f.payments.filter((p) => p.status === 'active');
  const schedules = active.flatMap((p) =>
    paymentSchedule(p, 1200).map((row) => ({ ...row, id: p.id, name: p.name, kind: p.kind })),
  );
  const planned = schedules
    .filter((p) => p.date >= from && p.date <= to && (kind === 'all' || p.kind === kind))
    .sort((a, b) => a.date.localeCompare(b.date));
  const byDate = new Map<string, typeof planned>();
  for (const row of planned) byDate.set(row.date, [...(byDate.get(row.date) ?? []), row]);
  const months = [...new Set(planned.map((p) => p.date.slice(0, 7)))],
    month = months.includes(monthChoice) ? monthChoice : (months[0] ?? from.slice(0, 7));
  const debts = active.filter((p) => isDebtKind(p.kind));
  const sorted = [...debts].sort((a, b) =>
    sort === 'small'
      ? (a.remainingMinor ?? Infinity) - (b.remainingMinor ?? Infinity)
      : sort === 'large'
        ? (b.remainingMinor ?? -1) - (a.remainingMinor ?? -1)
        : sort === 'payment'
          ? b.amountMinor - a.amountMinor
          : (endDate(a) ?? '9999').localeCompare(endDate(b) ?? '9999'),
  );
  const maxDebt = Math.max(
    1,
    ...debts.map((p) => (p.remainingMinor ?? 0) + (p.overpaymentRemainingMinor ?? 0)),
  );
  const visible = [...byDate].filter(([date]) => !day || date === day),
    count = visible.reduce((n, [, items]) => n + items.length, 0);
  let shown = 0;
  const monthly = Array.from({ length: 6 }, (_, i) => {
    const date = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1 + i, 1))
      .toISOString()
      .slice(0, 10);
    const end = periodWindow('month', date).end;
    return {
      key: date.slice(0, 7),
      label: date.slice(5, 7) + '.' + date.slice(2, 4),
      amountMinor: sumMoney(
        schedules
          .filter((p) => p.date >= date && p.date <= end && (kind === 'all' || p.kind === kind))
          .map((p) => p.payment),
      ),
    };
  });
  return (
    <>
      <section className="renewal-card analytics-hero">
        <p className="renewal-muted">Майбутні платежі за збереженими графіками</p>
        <div className="renewal-segments mt-3">
          {[
            ['week', 'До неділі'],
            ['month', 'До кінця місяця'],
            ['nextMonth', 'Наступний місяць'],
          ].map(([key, label]) => (
            <button
              key={key}
              aria-pressed={horizon === key}
              onClick={() => {
                setHorizon(key!);
                setDay(null);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <details className="mt-3">
          <summary className="renewal-link">Інший горизонт</summary>
          <div className="flex gap-2 flex-wrap mt-3">
            {['7', '30', '90'].map((n) => (
              <button
                key={n}
                className="renewal-secondary"
                onClick={() => {
                  setHorizon(n);
                  setDay(null);
                }}
              >
                {n} днів
              </button>
            ))}
            <button
              className="renewal-secondary"
              onClick={() => {
                setHorizon('custom');
                setDay(null);
              }}
            >
              Власні дати
            </button>
          </div>
        </details>
        {horizon === 'custom' && (
          <div className="renewal-form-grid mt-3">
            {(['from', 'to'] as const).map((key) => (
              <label className="renewal-field" key={key}>
                {key === 'from' ? 'Від' : 'До включно'}
                <input
                  type="date"
                  min={today}
                  value={custom[key]}
                  onChange={(e) => {
                    if (e.target.value) setCustom({ ...custom, [key]: e.target.value });
                    setDay(null);
                  }}
                />
              </label>
            ))}
          </div>
        )}
        <label className="renewal-field mt-3">
          Тип платежу
          <select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value);
              setDay(null);
            }}
          >
            <option value="all">Усі типи</option>
            {Object.entries(PAYMENT_KIND_LABELS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <div className="renewal-big mt-3">
          {moneyLabel(sumMoney(planned.map((p) => p.payment)))}
        </div>
        <p className="renewal-chart-note">
          {from} — {to} · {planned.length} оплат. Фільтр типу застосовано до суми й календаря.
        </p>
        {from > to && (
          <p role="alert" className="text-neg">
            Початок періоду має бути не пізніше завершення.
          </p>
        )}
        <div className="renewal-metrics">
          <div className="renewal-metric">
            <span className="renewal-muted">Підписки в горизонті</span>
            <strong>
              {moneyLabel(
                sumMoney(planned.filter((p) => p.kind === 'subscription').map((p) => p.payment)),
              )}
            </strong>
          </div>
          <div className="renewal-metric">
            <span className="renewal-muted">Відоме тіло активних боргів</span>
            <strong>{moneyLabel(sumMoney(debts.map((p) => p.remainingMinor ?? 0)))}</strong>
          </div>
        </div>
        {debts.some((p) => p.remainingMinor == null) && (
          <p className="finance-context-note mt-3">
            Для {debts.filter((p) => p.remainingMinor == null).length} договорів залишок невідомий;
            це не нуль.
          </p>
        )}
      </section>
      {active.some((p) => p.nextDate < today) && (
        <section className="renewal-card">
          <h2 className="font-bold">Оплати з минулими датами для звірки</h2>
          {active
            .filter((p) => p.nextDate < today)
            .map((p) => (
              <button key={p.id} className="analytics-operation" onClick={() => onPayment(p.id)}>
                <span>
                  {p.name}
                  <small>{p.nextDate} · у Світанку ще не підтверджено</small>
                </span>
                <b>{moneyLabel(p.amountMinor)}</b>
              </button>
            ))}
          <p className="renewal-chart-note">
            Дата в обліку не доводить прострочення в банку. Ці записи показано окремо від
            майбутнього горизонту.
          </p>
        </section>
      )}
      <section className="renewal-card">
        <h2 className="text-lg font-bold">Календар майбутніх списань</h2>
        <div className="renewal-segments mt-3">
          <button aria-pressed={!grid} onClick={() => setGrid(false)}>
            За датами
          </button>
          <button aria-pressed={grid} onClick={() => setGrid(true)}>
            Місячна сітка
          </button>
        </div>
        {grid && (
          <>
            <label className="renewal-field mt-3">
              Місяць
              <select
                value={month}
                onChange={(e) => {
                  setMonth(e.target.value);
                  setDay(null);
                }}
              >
                {(months.length ? months : [month]).map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
            <div className="finance-month-grid" aria-label="Дати планових оплат">
              {['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'].map((d) => (
                <span className="analytics-calendar-weekday" key={d}>
                  {d}
                </span>
              ))}
              {Array.from(
                { length: (new Date(month + '-01T12:00Z').getUTCDay() + 6) % 7 },
                (_, i) => (
                  <span key={`blank:${i}`} />
                ),
              )}
              {Array.from(
                { length: Number(periodWindow('month', month + '-01').end.slice(8)) },
                (_, i) => {
                  const date = `${month}-${String(i + 1).padStart(2, '0')}`,
                    items = byDate.get(date) ?? [];
                  return (
                    <button
                      key={date}
                      disabled={!items.length}
                      aria-pressed={day === date}
                      onClick={() => setDay(date)}
                      title={`${date}: ${moneyLabel(sumMoney(items.map((p) => p.payment)))}`}
                    >
                      <b>{i + 1}</b>
                      <small>
                        {items.length ? moneyLabel(sumMoney(items.map((p) => p.payment))) : '—'}
                      </small>
                    </button>
                  );
                },
              )}
            </div>
          </>
        )}
        {day && (
          <button className="renewal-link mt-3" onClick={() => setDay(null)}>
            ← Усі дати горизонту
          </button>
        )}
        <div className="finance-calendar-agenda">
          {visible.map(([date, items]) => {
            const remaining = Math.max(0, limit - shown);
            shown += items.length;
            if (!remaining) return null;
            return (
              <div key={date}>
                <div className="finance-calendar-date">
                  <span>{date}</span>
                  <span>{moneyLabel(sumMoney(items.map((p) => p.payment)))}</span>
                </div>
                {items.slice(0, remaining).map((p) => (
                  <button
                    className="finance-calendar-item"
                    key={`${p.id}:${p.date}`}
                    onClick={() => onPayment(p.id)}
                  >
                    <span>
                      {p.name}
                      <small>{PAYMENT_KIND_LABELS[p.kind]}</small>
                    </span>
                    <b>{moneyLabel(p.payment)} ↗</b>
                  </button>
                ))}
              </div>
            );
          })}
        </div>
        {!planned.length && (
          <p className="renewal-muted mt-4">У вибраному горизонті немає запланованих оплат.</p>
        )}
        {count > limit && (
          <button className="renewal-secondary mt-3" onClick={() => setLimit((n) => n + 60)}>
            Показати ще · {count - limit}
          </button>
        )}
      </section>
      <section className="renewal-card">
        <h2 className="font-bold">Навантаження за місяцями</h2>
        <AnalyticsBars
          points={monthly}
          label="Майбутні платежі за місяцями"
          onSelect={(key) => {
            if (key) {
              setCustom({ from: key + '-01', to: periodWindow('month', key + '-01').end });
              setHorizon('custom');
              setDay(null);
            }
          }}
        />
        <p className="renewal-chart-note">
          Для поточного місяця — решта введених оплат; для наступних — повні збережені графіки.
          Непідтверджені попередні дати поточного місяця включені. Валютна переоцінка й невідомі
          нові договори можуть змінити суми.
        </p>
      </section>
      <section className="renewal-card">
        <h2 className="font-bold">Структура боргів і договори</h2>
        <label className="renewal-field mt-3">
          Сортувати
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="end">Завершаться найшвидше</option>
            <option value="small">Від меншого залишку</option>
            <option value="large">Від більшого залишку</option>
            <option value="payment">За найбільшим платежем</option>
          </select>
        </label>
        <p className="renewal-chart-note mt-2">
          Синій — тіло, теплий акцент — введена невиплачена переплата. Оцінені майбутні відсотки
          підписані окремо.
        </p>
        <div className="finance-debt-rows">
          {sorted.map((p) => {
            const rows = paymentSchedule(p, 1200),
              extra = p.overpaymentRemainingMinor ?? 0,
              principal = p.remainingMinor ?? 0,
              estimated = rows.reduce((n, r) => n + (r.overpayment ?? 0), 0);
            return (
              <div key={p.id} className="renewal-inset">
                <button className="analytics-operation" onClick={() => onPayment(p.id)}>
                  <span>
                    <b>{p.name}</b>
                    <small>
                      {PAYMENT_KIND_LABELS[p.kind]} · наступна оплата {p.nextDate}
                    </small>
                  </span>
                  <b>
                    {p.remainingMinor == null ? 'Залишок невідомий' : moneyLabel(principal + extra)}{' '}
                    ↗
                  </b>
                </button>
                <div className="finance-debt-split">
                  <span
                    className="principal"
                    style={{ width: `${(principal / maxDebt) * 100}%` }}
                  />
                  <span className="interest" style={{ width: `${(extra / maxDebt) * 100}%` }} />
                </div>
                <p className="renewal-chart-note mt-2">
                  Тіло {p.remainingMinor == null ? 'невідоме' : moneyLabel(principal)} · введена
                  переплата {p.overpaymentRemainingMinor == null ? 'не задана' : moneyLabel(extra)}.
                  {p.interestMethod
                    ? ` Оцінка майбутніх відсотків і комісій: ${moneyLabel(estimated)}.`
                    : ''}
                </p>
                <p className="renewal-chart-note">
                  {p.installmentsLeft == null
                    ? 'Кількість оплат не задана'
                    : `Залишилось ${p.installmentsLeft} оплат`}
                  {endDate(p)
                    ? ` · кінець збереженого графіка ${endDate(p)}`
                    : ' · дата завершення ще невідома'}
                  {p.recurrence === 'month'
                    ? ` · після закриття регулярні оплати менші приблизно на ${moneyLabel(p.amountMinor)}/міс.`
                    : ''}
                </p>
              </div>
            );
          })}
        </div>
        {!debts.length && <p className="renewal-muted mt-3">Активних боргів немає.</p>}
      </section>
    </>
  );
}
