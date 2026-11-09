import { useState } from 'react';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  fetchFinanceAnalytics,
  fetchAnalyticsOperations,
  isSessionExpired,
} from '../../api/client.ts';
import { FINANCE_QUERY } from '../../api/finance-hooks.ts';
import type { Finance } from '../../api/finance-schema.ts';
import type { AnalyticsRequest } from '../../api/finance-analytics-schema.ts';
import { financeCategoryLabel } from '../../../../core/finance/categories.mjs';
import { needsBankHoldConfirmation } from '../../../../core/finance/payment-link.mjs';
import { financeRange, financeDate, paymentsCount } from './analytics-format.ts';
import { moneyLabel } from '../../lib/financeView.ts';
import { Sheet } from './FinanceSheet.tsx';
import { SessionExpired } from '../ui/SessionExpired.tsx';
import { FinanceForm } from './FinanceForm.tsx';
import { TransactionDetail } from './TransactionDetail.tsx';
import { TransactionAmount } from './TransactionAmount.tsx';
export type ExplorerOptions = {
  day?: string;
  kind?: string;
  issue?: string;
  weekday?: string;
  transactionId?: string;
  categories?: string;
  budgetId?: string;
  initialPrevious?: boolean;
  detail?: boolean;
  comparison?: boolean;
  title?: string;
  returnLabel?: string;
};
export function AnalyticsOperations({
  request,
  finance,
  onClose,
  ...options
}: { request: AnalyticsRequest; finance: Finance; onClose: () => void } & ExplorerOptions) {
  const [selected, setSelected] = useState<Finance['transactions'][number] | null>(null),
    [editing, setEditing] = useState(false),
    [merchant, setMerchant] = useState<string | null>(null),
    [previous, setPrevious] = useState(options.initialPrevious ?? false);
  const base = { ...request, merchant: merchant ?? request.merchant };
  const summary = useQuery({
    queryKey: [
      ...FINANCE_QUERY,
      'explorer-summary',
      base,
      finance.version,
      finance.bankSync?.completedAt,
    ],
    queryFn: () => fetchFinanceAnalytics(base),
    enabled: !!options.detail,
    staleTime: 60000,
    refetchOnWindowFocus: false,
  });
  const effective =
    previous && summary.data
      ? {
          ...base,
          from: summary.data.selection.previousFrom,
          to: summary.data.selection.previousTo,
        }
      : base;
  const query = useInfiniteQuery({
    enabled: !previous || !options.detail || !!summary.data,
    queryKey: [
      ...FINANCE_QUERY,
      'analytics-operations',
      effective,
      options.day,
      options.kind,
      options.issue,
      options.weekday,
      options.transactionId,
      options.categories,
      options.budgetId,
      finance.version,
      finance.bankSync?.completedAt,
    ],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      fetchAnalyticsOperations(base, {
        cursor: pageParam,
        day: options.day,
        kind: options.kind ?? 'expense',
        issue: options.issue,
        weekday: options.weekday,
        transactionId: options.transactionId,
        categories: options.categories,
        budgetId: options.budgetId,
        series: previous ? 'previous' : undefined,
      }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    staleTime: 60000,
    refetchOnWindowFocus: false,
    placeholderData: keepPreviousData,
  });
  const exact = options.transactionId
    ? query.data?.pages[0]?.items.find((tx) => tx.id === options.transactionId)
    : null;
  const activeId = selected?.id ?? exact?.id;
  const active = activeId
    ? (finance.transactions.find((tx) => tx.id === activeId) ??
      query.data?.pages.flatMap((page) => page.items).find((tx) => tx.id === activeId) ??
      selected ??
      exact)
    : null;
  if (editing && active)
    return (
      <FinanceForm
        request={{ kind: active.bank ? 'classify' : 'edit-transaction', id: active.id }}
        finance={{
          ...finance,
          transactions: [active, ...finance.transactions.filter((t) => t.id !== active.id)],
        }}
        onClose={() => {
          setEditing(false);
          setSelected(null);
          void query.refetch();
          void summary.refetch();
        }}
      />
    );
  const title =
    merchant ??
    options.title ??
    (request.merchant ||
      (request.category ? financeCategoryLabel(request.category) : 'Операції у звіті'));
  return (
    <Sheet
      label="Операції у звіті"
      onClose={onClose}
      scrollKey={active ? `tx:${active.id}` : `list:${merchant ?? ''}:${previous}`}
    >
      <div className="renewal-finance analytics-operations">
        <div className="renewal-section-head">
          <h2 className="text-xl font-bold">{title}</h2>
          <button className="renewal-secondary" aria-label="Закрити операції" onClick={onClose}>
            ×
          </button>
        </div>
        {active ? (
          <TransactionDetail
            transaction={active}
            finance={finance}
            version={finance.version}
            backLabel={
              options.transactionId ? (options.returnLabel ?? 'До аналітики') : 'До операцій'
            }
            onBack={() => (options.transactionId ? onClose() : setSelected(null))}
            onClassify={() => setEditing(true)}
          />
        ) : (
          <>
            {merchant && (
              <button
                className="renewal-link mt-3"
                onClick={() => {
                  setMerchant(null);
                  setPrevious(false);
                }}
              >
                ← До категорії
              </button>
            )}
            <p className="renewal-chart-note mt-3">
              {options.day ? financeDate(options.day) : financeRange(effective.from, effective.to)}
              {' · '}
              {effective.account && effective.account !== 'all'
                ? (finance.accounts.find((a) => a.id === effective.account)?.name ??
                  effective.account)
                : 'Усі рахунки'}
              {effective.source && effective.source !== 'all'
                ? effective.source === 'mono'
                  ? ' · Monobank'
                  : ' · Ручні записи'
                : ''}
              {effective.status && effective.status !== 'all'
                ? effective.status === 'confirmed'
                  ? ' · Підтверджені'
                  : ' · Очікують підтвердження'
                : ''}
              {effective.merchant ? ` · ${effective.merchant}` : ''}
            </p>
            {options.detail && summary.data && (
              <>
                <div className="renewal-metrics">
                  <div className="renewal-metric">
                    <span>Поточний період</span>
                    <strong>{moneyLabel(summary.data.summary.expenseMinor)}</strong>
                    <small>{paymentsCount(summary.data.summary.count)}</small>
                  </div>
                  <div className="renewal-metric">
                    <span>Попередній період</span>
                    <strong>{moneyLabel(summary.data.summary.previousExpenseMinor)}</strong>
                    <small>
                      {financeRange(
                        summary.data.selection.previousFrom,
                        summary.data.selection.previousTo,
                      )}
                    </small>
                  </div>
                </div>
                {summary.data.coverage.previousBeforeFirstRecord && (
                  <p className="renewal-inset mt-3">
                    Попередній період починається раніше збережених записів. Порівняння може бути
                    неповним.
                  </p>
                )}
                <div className="renewal-segments mt-4">
                  <button aria-pressed={!previous} onClick={() => setPrevious(false)}>
                    Цей період
                  </button>
                  <button aria-pressed={previous} onClick={() => setPrevious(true)}>
                    Попередній
                  </button>
                </div>
                {!merchant && !request.merchant && summary.data.merchants.length > 0 && (
                  <details className="renewal-inset mt-3">
                    <summary>Продавці в цій категорії</summary>
                    {summary.data.merchants.slice(0, 12).map((m) => (
                      <button
                        className="analytics-operation"
                        key={m.merchant}
                        onClick={() => {
                          setMerchant(m.merchant);
                          setPrevious(false);
                        }}
                      >
                        <span>{m.merchant || 'Без назви'}</span>
                        <strong>{moneyLabel(m.amountMinor)}</strong>
                      </button>
                    ))}
                  </details>
                )}
              </>
            )}
            {isSessionExpired(query.error) || isSessionExpired(summary.error) ? (
              <SessionExpired />
            ) : query.error || summary.error ? (
              <div role="alert">
                <p>
                  {(query.error ?? summary.error) instanceof Error
                    ? (query.error ?? summary.error)?.message
                    : 'Операції недоступні'}
                </p>
                <button
                  className="renewal-secondary"
                  onClick={() => {
                    void query.refetch();
                    if (options.detail) void summary.refetch();
                  }}
                >
                  Повторити
                </button>
              </div>
            ) : null}
            {query.isPending && <p role="status">Завантажую операції…</p>}
            {query.isPlaceholderData && <p role="status">Оновлюю список…</p>}
            {query.data?.pages
              .flatMap((p) => p.items)
              .map((tx) => (
                <button
                  disabled={query.isPlaceholderData}
                  className="analytics-operation finance-operation-row"
                  key={tx.id}
                  onClick={() => setSelected(tx)}
                >
                  <b className="finance-operation-title">{tx.description || 'Без назви'}</b>
                  <TransactionAmount transaction={tx} display={finance.display} />
                  <small className="finance-operation-meta">
                    {new Date(tx.at).toLocaleString('uk-UA', {
                      timeZone: 'Europe/Kyiv',
                      day: 'numeric',
                      month: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}{' '}
                    · {financeCategoryLabel(tx.category)}
                    {needsBankHoldConfirmation(tx) ? ' · очікує звірки' : ''}
                  </small>
                </button>
              ))}
            {query.data && !query.data.pages[0]?.items.length && (
              <p className="renewal-muted mt-3">Операцій за цим вибором немає.</p>
            )}
            {query.hasNextPage && (
              <button
                className="renewal-secondary w-full"
                disabled={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                {query.isFetchingNextPage ? 'Завантажую…' : 'Показати ще 50'}
              </button>
            )}
          </>
        )}
      </div>
    </Sheet>
  );
}
