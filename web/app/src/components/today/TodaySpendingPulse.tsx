import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchFinanceAnalytics, isSessionExpired } from '../../api/client.ts';
import { FINANCE_QUERY } from '../../api/finance-hooks.ts';
import type { Finance } from '../../api/finance-schema.ts';
import { todaySpendingRequest, todaySpendingInsight } from '../../lib/todaySpending.ts';
import { moneyLabel } from '../../lib/financeView.ts';
import { financeCategoryLabel } from '../../../../core/finance/categories.mjs';
import { financeRange } from '../finance/analytics-format.ts';
import { Sheet } from '../ui/Sheet.tsx';

export function TodaySpendingPulse({
  finance,
  nowMs,
  demo,
}: {
  finance: Finance;
  nowMs: number;
  demo?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const request = todaySpendingRequest(nowMs);
  const query = useQuery({
    queryKey: [
      ...FINANCE_QUERY,
      'today-spending',
      request,
      finance.version,
      finance.bankSync?.completedAt,
    ],
    queryFn: () => fetchFinanceAnalytics(request),
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: (attempt, error) => !isSessionExpired(error) && attempt < 1,
  });
  const sessionExpired = isSessionExpired(query.error);
  const data = sessionExpired ? undefined : query.data;
  const insight = data ? todaySpendingInsight(data) : null;
  const change = insight?.change;
  const percent =
    change == null
      ? null
      : (Math.abs(change) / 100).toLocaleString('uk-UA', { maximumFractionDigits: 1 });
  const label =
    percent == null
      ? data
        ? moneyLabel(data.summary.expenseMinor)
        : query.isPending
          ? '…'
          : 'Переглянути'
      : change === 0
        ? '≈ без змін'
        : (change! < 0 ? '↘ −' : '↗ +') + percent + '%';
  const params = new URLSearchParams({ ...request, analytics: 'expenses' });
  return (
    <>
      <button
        type="button"
        className="today-spending-pulse"
        onClick={() => setOpen(true)}
        aria-label={'Витрати цього тижня: ' + label + '. Відкрити порівняння'}
        aria-haspopup="dialog"
      >
        <span>Витрати тижня</span>
        <b>{label}</b>
        <span aria-hidden="true">›</span>
      </button>
      {open && (
        <Sheet label="Витрати цього тижня" onClose={() => setOpen(false)}>
          <div className="today-pulse-detail">
            <div className="renewal-section-head">
              <h2 className="text-xl font-bold">Витрати цього тижня{demo ? ' · демо' : ''}</h2>
              <button
                type="button"
                className="renewal-secondary"
                aria-label="Закрити порівняння"
                onClick={() => setOpen(false)}
              >
                ×
              </button>
            </div>
            {data && insight ? (
              <>
                <p className="renewal-chart-note mt-3">
                  Підтверджені витрати з понеділка до цього часу — і ті самі дні та час минулого
                  тижня.
                </p>
                <div className="today-pulse-totals">
                  <div>
                    <span>Цього тижня</span>
                    <strong>{moneyLabel(data.summary.expenseMinor)}</strong>
                    <small>{financeRange(data.selection.from, data.selection.to)}</small>
                  </div>
                  <div>
                    <span>Минулого тижня</span>
                    <strong>{moneyLabel(data.summary.previousExpenseMinor)}</strong>
                    <small>
                      {financeRange(data.selection.previousFrom, data.selection.previousTo)}
                    </small>
                  </div>
                </div>
                {!insight.covered ? (
                  <p className="renewal-inset">
                    Ще недостатньо збереженої історії для надійного порівняння.
                  </p>
                ) : !insight.comparable ? (
                  <p className="renewal-inset">
                    Є записи з невизначеною сумою або класифікацією чи позначкою для перевірки.
                    Відсоток поки прихований; суми враховують відомі підтверджені витрати.
                  </p>
                ) : (
                  <p className="today-pulse-conclusion">
                    {change == null
                      ? 'У відповідному періоді минулого тижня витрат не зафіксовано — відсоток не розраховуємо.'
                      : change === 0
                        ? 'Підтверджені витрати майже не змінилися.'
                        : 'Витрати ' + (change < 0 ? 'менші' : 'більші') + ' на ' + percent + '%.'}
                  </p>
                )}
                {insight.driver && (
                  <div className="renewal-inset">
                    <span className="renewal-eyebrow">Найбільший внесок у зміну</span>
                    <p className="mt-2">
                      {financeCategoryLabel(insight.driver.category)} ·{' '}
                      {insight.driver.deltaMinor > 0 ? '+' : '−'}
                      {moneyLabel(Math.abs(insight.driver.deltaMinor))}
                    </p>
                    <Link
                      className="renewal-link mt-3 inline-block"
                      to={
                        '/finance?' +
                        new URLSearchParams({
                          ...request,
                          analytics: 'expenses',
                          category: insight.driver.category,
                        })
                      }
                    >
                      Переглянути категорію →
                    </Link>
                  </div>
                )}
                <Link className="renewal-link mt-4 inline-block" to={'/finance?' + params}>
                  До аналізу витрат →
                </Link>
              </>
            ) : query.isPending ? (
              <p role="status" className="renewal-muted mt-4">
                Завантажую порівняння…
              </p>
            ) : null}
            {query.isError && (
              <div className="mt-4" role="status">
                <p className="renewal-muted">
                  {sessionExpired
                    ? 'Сесію завершено. Відкрий «Svitanok» ще раз із чату Telegram.'
                    : data
                      ? 'Не вдалося оновити. Показані останні завантажені суми.'
                      : 'Порівняння тимчасово недоступне.'}
                </p>
                {!sessionExpired && (
                  <button
                    type="button"
                    className="renewal-link mt-2"
                    onClick={() => void query.refetch()}
                  >
                    Спробувати ще раз
                  </button>
                )}
              </div>
            )}
          </div>
        </Sheet>
      )}
    </>
  );
}
