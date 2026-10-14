import { useState, useRef, useEffect } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { fetchFinanceMerchants, postFinance, isSessionExpired } from '../../api/client.ts';
import type { AnalyticsRequest } from '../../api/finance-analytics-schema.ts';
import type { Finance, FinanceCommand } from '../../api/finance-schema.ts';
import { FINANCE_QUERY } from '../../api/finance-hooks.ts';
import { Sheet } from '../ui/Sheet.tsx';
import { SessionExpired } from '../ui/SessionExpired.tsx';
import { moneyLabel } from '../../lib/financeView.ts';
export function MerchantCatalog({
  request,
  finance,
  onSelect,
  onClose,
}: {
  request: AnalyticsRequest;
  finance: Finance;
  onSelect: (merchant: string) => void;
  onClose: () => void;
}) {
  const cache = useQueryClient();
  const [search, setSearch] = useState(''),
    [sort, setSort] = useState('amount'),
    [grouping, setGrouping] = useState(false),
    [selected, setSelected] = useState<string[]>([]),
    [name, setName] = useState(''),
    [pending, setPending] = useState(false),
    [error, setError] = useState('');
  const attempt = useRef<{ key: string; command: FinanceCommand } | null>(null);
  const [needle, setNeedle] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setNeedle(search), 300);
    return () => clearTimeout(timer);
  }, [search]);
  const input = grouping ? { ...request, category: '', merchant: '' } : request;
  const query = useInfiniteQuery({
    queryKey: [
      ...FINANCE_QUERY,
      'merchant-catalog',
      input,
      needle,
      sort,
      grouping,
      finance.version,
      finance.bankSync?.completedAt,
    ],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      fetchFinanceMerchants(input, {
        search: needle,
        sort,
        after: pageParam,
        ungrouped: grouping ? '1' : undefined,
      }),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
    staleTime: 60000,
    refetchOnWindowFocus: false,
  });
  const save = async (aliases: Record<string, string>) => {
    if (pending) return;
    setError('');
    setPending(true);
    const key = JSON.stringify([aliases, finance.version]);
    if (attempt.current?.key !== key)
      attempt.current = {
        key,
        command: {
          id: crypto.randomUUID(),
          version: finance.version,
          type: 'merchant-aliases',
          payload: { aliases },
        },
      };
    try {
      const result = await postFinance(attempt.current.command);
      if (result.finance) cache.setQueryData(FINANCE_QUERY, result);
      await cache.invalidateQueries({ queryKey: FINANCE_QUERY });
      setGrouping(false);
      setSelected([]);
      setName('');
      attempt.current = null;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не вдалося зберегти правила');
    } finally {
      setPending(false);
    }
  };
  return (
    <Sheet label="Продавці та групи" onClose={onClose} scrollKey={grouping ? 'groups' : 'catalog'}>
      <div className="renewal-finance">
        <div className="renewal-section-head">
          <h2 className="text-xl font-bold">{grouping ? 'Об’єднання назв' : 'Усі продавці'}</h2>
          <button
            className="renewal-secondary"
            disabled={pending}
            onClick={onClose}
            aria-label="Закрити продавців"
          >
            ×
          </button>
        </div>
        <button
          className="renewal-link mt-3"
          disabled={pending}
          onClick={() => {
            setGrouping(!grouping);
            setSearch('');
            setSelected([]);
            setError('');
          }}
        >
          {grouping ? '← До продавців' : 'Налаштувати об’єднання назв'}
        </button>
        {grouping && (
          <>
            <p className="renewal-inset mt-3">
              Обери оригінальні назви й дай їм спільне ім’я. Зміниться лише групування статистики;
              суми та банківські описи залишаться. Показано назви за вибраний період, з усіх
              категорій.
            </p>
            <label className="renewal-field mt-4">
              Назва групи
              <input
                value={name}
                maxLength={120}
                disabled={pending}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
          </>
        )}
        <label className="renewal-field mt-4">
          Пошук продавця
          <input
            type="search"
            value={search}
            maxLength={200}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <label className="renewal-field mt-3">
          Сортування
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="amount">За сумою</option>
            <option value="count">За кількістю оплат</option>
          </select>
        </label>
        {query.isPending && <p role="status">Завантажую продавців…</p>}
        {isSessionExpired(query.error) ? (
          <SessionExpired />
        ) : (
          query.error && (
            <p role="alert">
              {query.error.message}
              <button className="renewal-link" onClick={() => void query.refetch()}>
                Повторити
              </button>
            </p>
          )
        )}
        {query.data && (
          <p className="renewal-chart-note mt-3">Знайдено {query.data.pages[0]?.total} назв.</p>
        )}
        {query.data?.pages
          .flatMap((p) => p.items)
          .map((m) =>
            grouping ? (
              <label className="analytics-operation" key={m.merchant}>
                <span>
                  <input
                    type="checkbox"
                    checked={selected.includes(m.merchant)}
                    disabled={pending || !m.merchant}
                    onChange={(e) =>
                      setSelected((s) =>
                        e.target.checked ? [...s, m.merchant] : s.filter((n) => n !== m.merchant),
                      )
                    }
                  />
                  {m.merchant || 'Без назви'}
                </span>
                <b>{moneyLabel(m.amountMinor)}</b>
              </label>
            ) : (
              <button
                className="analytics-operation"
                key={m.merchant}
                onClick={() => onSelect(m.merchant)}
              >
                <span>
                  {m.merchant || 'Без назви'}
                  <small>{m.count} оплат</small>
                </span>
                <strong>{moneyLabel(m.amountMinor)}</strong>
              </button>
            ),
          )}
        {query.hasNextPage && (
          <button
            className="renewal-secondary w-full mt-3"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            {query.isFetchingNextPage ? 'Завантажую…' : 'Показати ще продавців'}
          </button>
        )}
        {grouping && (
          <>
            <p className="renewal-chart-note mt-3">Обрано {selected.length} назв.</p>
            <button
              className="renewal-button w-full mt-3"
              disabled={pending || !name.trim() || !selected.length}
              onClick={() =>
                void save({
                  ...finance.merchantAliases,
                  ...Object.fromEntries(selected.map((source) => [source, name.trim()])),
                })
              }
            >
              {pending ? 'Зберігаю…' : 'Підтвердити об’єднання'}
            </button>
            <details className="renewal-inset mt-4">
              <summary>
                Збережені правила ({Object.keys(finance.merchantAliases ?? {}).length})
              </summary>
              {Object.entries(finance.merchantAliases ?? {}).map(([source, group]) => (
                <div className="analytics-row" key={source}>
                  <span>
                    {source} → {group}
                  </span>
                  <button
                    className="renewal-link"
                    disabled={pending}
                    onClick={() => {
                      const aliases = { ...finance.merchantAliases };
                      delete aliases[source];
                      void save(aliases);
                    }}
                  >
                    Скасувати правило
                  </button>
                </div>
              ))}
            </details>
          </>
        )}
        {error && (
          <p className="text-neg mt-3" role="alert">
            {error}
          </p>
        )}
      </div>
    </Sheet>
  );
}
