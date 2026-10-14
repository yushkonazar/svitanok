import { useState } from 'react';
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import { fetchAnalyticsOperations, isSessionExpired } from '../../api/client.ts';
import { FINANCE_QUERY } from '../../api/finance-hooks.ts';
import type { AnalyticsRequest } from '../../api/finance-analytics-schema.ts';
import type { Finance } from '../../api/finance-schema.ts';
import { Sheet } from '../ui/Sheet.tsx';
import { TransactionDetail } from './TransactionDetail.tsx';
import { FinanceForm } from './FinanceForm.tsx';
import { moneyLabel } from '../../lib/financeView.ts';
import { financeCategoryLabel } from '../../../../core/finance/categories.mjs';
import { SessionExpired } from '../ui/SessionExpired.tsx';
export function AnalyticsOperations({
  request,
  finance,
  day,
  kind = 'expense',
  onClose,
}: {
  request: AnalyticsRequest;
  finance: Finance;
  day?: string;
  kind?: string;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<Finance['transactions'][number] | null>(null),
    [editing, setEditing] = useState(false);
  const query = useInfiniteQuery({
    queryKey: [
      ...FINANCE_QUERY,
      'analytics-operations',
      request,
      day,
      kind,
      finance.version,
      finance.bankSync?.completedAt,
    ],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => fetchAnalyticsOperations(request, { cursor: pageParam, day, kind }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    staleTime: 60000,
    refetchOnWindowFocus: false,
    placeholderData: keepPreviousData,
  });
  if (editing && selected)
    return (
      <FinanceForm
        request={{ kind: selected.bank ? 'classify' : 'edit-transaction', id: selected.id }}
        finance={{
          ...finance,
          transactions: [selected, ...finance.transactions.filter((t) => t.id !== selected.id)],
        }}
        onClose={() => {
          setEditing(false);
          setSelected(null);
          void query.refetch();
        }}
      />
    );
  return (
    <Sheet label="Операції у звіті" onClose={onClose}>
      <div className="renewal-finance analytics-operations">
        <div className="renewal-section-head">
          <h2 className="text-xl font-bold">Операції у звіті</h2>
          <button className="renewal-secondary" aria-label="Закрити операції" onClick={onClose}>
            ×
          </button>
        </div>
        {selected ? (
          <TransactionDetail
            transaction={selected}
            version={finance.version}
            onBack={() => setSelected(null)}
            onClassify={() => setEditing(true)}
          />
        ) : (
          <>
            <p className="renewal-chart-note">
              {day ?? `${request.from} — ${request.to}`} · ті самі фільтри, що й у діаграмі
            </p>
            {isSessionExpired(query.error) ? (
              <SessionExpired />
            ) : query.error ? (
              <div role="alert">
                <p>{query.error instanceof Error ? query.error.message : 'Операції недоступні'}</p>
                <button className="renewal-secondary" onClick={() => void query.refetch()}>
                  Повторити
                </button>
              </div>
            ) : null}
            {query.isPending && <p role="status">Завантажую операції…</p>}
            {query.data?.pages
              .flatMap((page) => page.items)
              .map((tx) => (
                <button className="analytics-operation" key={tx.id} onClick={() => setSelected(tx)}>
                  <span>
                    <b>{tx.description || 'Без назви'}</b>
                    <small>
                      {new Date(tx.at).toLocaleString('uk-UA', {
                        timeZone: 'Europe/Kyiv',
                        day: 'numeric',
                        month: 'short',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}{' '}
                      · {financeCategoryLabel(tx.category)}
                      {tx.bankHold && !tx.bankVerifiedByOwner ? ' · hold у API' : ''}
                    </small>
                  </span>
                  <strong>
                    {tx.amountUah == null
                      ? moneyLabel(tx.amountMinor, tx.currency)
                      : moneyLabel(tx.amountUah)}
                  </strong>
                </button>
              ))}
            {query.data && !query.data.pages[0]?.items.length && (
              <p className="renewal-muted">Операцій за цим вибором немає.</p>
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
