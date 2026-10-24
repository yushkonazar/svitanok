import { BudgetHistoryAnalytics } from './BudgetHistoryAnalytics.tsx';
import { PaymentInsights } from './PaymentInsights.tsx';
import { GoalInsights } from './GoalInsights.tsx';
import { TaxiInsights } from './TaxiInsights.tsx';
import type { Finance } from '../../api/finance-schema.ts';
import type { FinanceFormRequest } from './FinanceForm.tsx';
import type { FinanceAnalytics } from '../../api/finance-analytics-schema.ts';
import { moneyLabel, financeView } from '../../lib/financeView.ts';
import { sumMoney } from '../../../../core/finance/planning.mjs';
import { financeCategoryLabel } from '../../../../core/finance/categories.mjs';
import { AnalyticsBars } from './AnalyticsCharts.tsx';
import { financeRange } from './analytics-format.ts';
export function Metric({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="renewal-metric">
      <span className="renewal-muted">{label}</span>
      <strong>{value == null ? 'Немає даних' : moneyLabel(value)}</strong>
    </div>
  );
}
export function OverviewAnalytics({
  data,
  onCategory,
}: {
  data: FinanceAnalytics;
  onCategory: (category: string) => void;
}) {
  const r = data.report;
  const changes = [...data.categories]
    .filter((c) => c.deltaMinor !== 0)
    .sort((a, b) => Math.abs(b.deltaMinor) - Math.abs(a.deltaMinor));
  const shown = changes.slice(0, 6),
    remainder = sumMoney(changes.slice(6).map((c) => c.deltaMinor));
  return (
    <>
      <section className="renewal-card analytics-hero">
        <p className="renewal-muted">Особисті витрати · вибраний облік</p>
        <div className="renewal-big">{moneyLabel(data.summary.expenseMinor)}</div>
        <p className="renewal-chart-note mt-2">
          {data.selection.from} — {data.selection.to}. Ті самі фільтри застосовано до поточних
          витрат і порівняння.
        </p>
        <div className="renewal-metrics">
          <Metric label="Зміна до попереднього періоду" value={data.summary.changeMinor} />
          <Metric label="Типовий платіж · медіана" value={data.summary.medianMinor} />
          <Metric label="Інші особисті надходження" value={data.summary.otherIncomeMinor} />
          <div className="renewal-metric">
            <span className="renewal-muted">Днів із записаними витратами</span>
            <strong>
              {data.summary.activeDays} / {data.selection.days}
            </strong>
          </div>
        </div>
        <AnalyticsBars
          label="Витрати за днями вибраного періоду"
          points={data.daily.map((d) => ({
            key: d.date,
            label: d.date.slice(8),
            amountMinor: d.expenseMinor,
          }))}
        />
        <p className="renewal-chart-note">
          Власні перекази й цілі не є витратами. Надходження тут не включають нарахований заробіток
          таксі.
        </p>
      </section>
      <section className="renewal-card">
        <h2 className="font-bold">Результат роботи таксі · усі рахунки</h2>
        <div className="renewal-metrics">
          <Metric label="Зароблено за формулою" value={r.taxiEarnedMinor} />
          <Metric label="Різниця розрахунків із парком" value={r.settlementDifferenceMinor} />
        </div>
        <p className="renewal-chart-note mt-3">
          Нарахований заробіток за календарні дати. Він не дорівнює надходженню на рахунки й не
          змінюється від фільтра картки.
        </p>
      </section>
      <section className="renewal-card">
        <h2 className="text-lg font-bold">Де витрати змінилися найбільше</h2>
        <p className="renewal-chart-note mt-2">
          {financeRange(data.selection.previousFrom, data.selection.previousTo)} →{' '}
          {financeRange(data.selection.from, data.selection.to)}. Зміна записаних сум, без припущень
          про причини.
        </p>
        {data.coverage.previousBeforeFirstRecord && (
          <p className="renewal-inset mt-3">
            Початок порівняння раніше найдавнішого запису. Повнота попереднього періоду не
            підтверджена.
          </p>
        )}
        {shown.map((c) => (
          <button
            className="analytics-operation"
            key={c.category}
            onClick={() => onCategory(c.category)}
          >
            <span>
              <b>{financeCategoryLabel(c.category)}</b>
              <small>
                {moneyLabel(c.previousMinor)} → {moneyLabel(c.amountMinor)}
              </small>
              <small>
                Оплат: {c.previousCount} → {c.count}; середня сума:{' '}
                {c.previousCount
                  ? moneyLabel(Math.round(c.previousMinor / c.previousCount))
                  : 'немає'}{' '}
                → {c.count ? moneyLabel(Math.round(c.amountMinor / c.count)) : 'немає'}
              </small>
            </span>
            <b>
              {c.deltaMinor > 0 ? '+' : ''}
              {moneyLabel(c.deltaMinor)}
            </b>
          </button>
        ))}
        {changes.length > 6 && (
          <div className="analytics-row">
            <span>Решта {changes.length - 6} категорій</span>
            <b>
              {remainder > 0 ? '+' : ''}
              {moneyLabel(remainder)}
            </b>
          </div>
        )}
        <div className="analytics-row">
          <b>Загальна зміна</b>
          <b>
            {data.summary.changeMinor > 0 ? '+' : ''}
            {moneyLabel(data.summary.changeMinor)}
          </b>
        </div>
        {!changes.length && (
          <p className="renewal-muted mt-3">Записані суми за категоріями не змінилися.</p>
        )}
      </section>
    </>
  );
}
export const BudgetAnalytics = BudgetHistoryAnalytics;
export const PaymentAnalytics = PaymentInsights;
export function GoalsAnalytics({
  finance,
  onHistory,
}: {
  finance: Finance;
  data?: FinanceAnalytics;
  onHistory: (goalId: string, date?: string) => void;
}) {
  return <GoalInsights finance={finance} onHistory={onHistory} />;
}
export function TaxiAnalytics({
  finance,
  data,
  onWeek,
}: {
  finance: Finance;
  data: FinanceAnalytics;
  onWeek: (key?: string) => void;
}) {
  return <TaxiInsights finance={finance} data={data} onWeek={onWeek} />;
}
export function AccountAnalytics({
  finance,
  nowMs,
  onAction,
  onRefresh,
  busy = false,
}: {
  finance: Finance;
  nowMs: number;
  onAction: (action: FinanceFormRequest) => void;
  onRefresh?: (id: string) => void;
  busy?: boolean;
}) {
  const view = financeView(finance, 7, nowMs),
    unknown = finance.accounts.some((a) => a.currency === 'UAH' && a.balanceMinor == null);
  return (
    <>
      <section className="renewal-card analytics-hero">
        <p className="renewal-muted">Власні гривневі кошти · поточні дані</p>
        <div className="renewal-big">{unknown ? 'Потрібне уточнення' : moneyLabel(view.owned)}</div>
        <div className="renewal-metrics">
          <Metric label="Залишити для парку" value={finance.reserveMinor} />
          <Metric label="Внутрішній резерв на цілі" value={view.allocated} />
          <Metric label="Вільні кошти" value={view.unknownBalances ? null : view.available} />
        </div>
      </section>
      {finance.accounts.map((a) => (
        <section className="renewal-card" key={a.id}>
          <h2 className="font-bold">{a.name}</h2>
          <div className="analytics-row">
            <span>Власні кошти</span>
            <b>
              {a.balanceMinor == null ? 'Не підтверджено' : moneyLabel(a.balanceMinor, a.currency)}
            </b>
          </div>
          {a.kind === 'mono' && (
            <>
              <div className="analytics-row">
                <span>Доступно з лімітом</span>
                <b>
                  {a.availableMinor == null ? 'Невідомо' : moneyLabel(a.availableMinor, a.currency)}
                </b>
              </div>
              {a.creditLimitSource === 'manual' &&
                a.bankCreditLimitMinor != null &&
                a.bankCreditLimitMinor !== a.creditLimitMinor && (
                  <p className="renewal-inset mt-3">
                    Ручний ліміт відрізняється від Monobank: у банку{' '}
                    {moneyLabel(a.bankCreditLimitMinor, a.currency)}. Перевір налаштування.
                  </p>
                )}
              <div className="analytics-row">
                <span>Кредитний ліміт</span>
                <b>
                  {a.creditLimitMinor == null
                    ? 'Невідомо'
                    : moneyLabel(a.creditLimitMinor, a.currency)}
                </b>
              </div>
              <div className="analytics-row">
                <span>Використано кредиту</span>
                <b>
                  {a.balanceMinor == null
                    ? 'Невідомо'
                    : moneyLabel(Math.max(0, -a.balanceMinor), a.currency)}
                </b>
              </div>
            </>
          )}
          <p className="renewal-chart-note mt-3">
            {a.asOf
              ? `Оновлено ${new Date(a.asOf).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' })}`
              : 'Початковий або ручний залишок'}
          </p>
          {a.currency === 'UAH' && a.balanceMinor != null && (
            <>
              <div className="renewal-progress mt-3">
                <span
                  style={{
                    width: `${
                      (Math.max(0, a.balanceMinor) /
                        Math.max(
                          1,
                          finance.accounts
                            .filter((x) => x.currency === 'UAH')
                            .reduce((n, x) => n + Math.max(0, x.balanceMinor ?? 0), 0),
                        )) *
                      100
                    }%`,
                  }}
                />
              </div>
              <p className="renewal-chart-note">
                Частка позитивних гривневих залишків. Кредитні ліміти сюди не входять.
              </p>
            </>
          )}
          <div className="finance-tool-grid mt-3">
            <button
              className="renewal-secondary"
              onClick={() =>
                onAction({ kind: a.kind === 'mono' ? 'credit-limit' : 'account-balance', id: a.id })
              }
            >
              {a.kind === 'mono' ? 'Налаштувати ліміт' : 'Уточнити залишок'}
            </button>
            {a.kind === 'mono' && onRefresh && (
              <button
                className="renewal-secondary"
                disabled={busy || !!finance.bankSync?.active}
                onClick={() => onRefresh(a.id)}
              >
                {busy || finance.bankSync?.active ? 'Оновлюю…' : 'Оновити Monobank'}
              </button>
            )}
          </div>
        </section>
      ))}
      <p className="renewal-chart-note">
        Історичний графік загальних залишків з’явиться після погодження збереження їхніх знімків.
        Поточні ліміти не застосовуються заднім числом до старих балансів.
      </p>
    </>
  );
}
