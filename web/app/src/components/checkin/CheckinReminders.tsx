import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { FINANCE_QUERY, useFinance } from '../../api/finance-hooks.ts';
import { postFinance } from '../../api/client.ts';
import { FinanceSaveUncertainError } from '../../api/finance-errors.ts';
import type { FinanceCommand } from '../../api/finance-schema.ts';

export function CheckinReminders() {
  const query = useFinance(),
    cache = useQueryClient();
  const attempt = useRef<FinanceCommand | null>(null),
    busy = useRef(false);
  const [retry, setRetry] = useState(false);
  const [pending, setPending] = useState(false),
    [error, setError] = useState('');
  const finance = query.data?.finance;
  async function toggle() {
    if (!finance || busy.current) return;
    busy.current = true;
    setPending(true);
    setError('');
    setRetry(false);
    attempt.current ??= {
      id: crypto.randomUUID(),
      version: finance.version,
      type: 'settings',
      payload: { checkinReminders: !finance.settings.checkinReminders },
    };
    try {
      const result = await postFinance(attempt.current);
      if (result?.finance) cache.setQueryData(FINANCE_QUERY, result);
      else await cache.invalidateQueries({ queryKey: FINANCE_QUERY });
      attempt.current = null;
    } catch (e) {
      if (!(e instanceof FinanceSaveUncertainError)) attempt.current = null;
      setRetry(Boolean(attempt.current));
      setError(e instanceof Error ? e.message : 'Не вдалося зберегти нагадування.');
      void cache.invalidateQueries({ queryKey: FINANCE_QUERY });
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  return (
    <div className="renewal-inset">
      <h3 className="font-semibold">Нагадування в Telegram</h3>
      {finance ? (
        <button
          type="button"
          role="switch"
          aria-checked={finance.settings.checkinReminders}
          disabled={pending}
          className="renewal-secondary mt-3"
          onClick={() => void toggle()}
        >
          {pending
            ? 'Зберігаю…'
            : error && retry
              ? 'Повторити збереження'
              : finance.settings.checkinReminders
                ? 'Увімкнені ✓'
                : 'Вимкнені'}
        </button>
      ) : (
        <button className="renewal-link mt-3" onClick={() => void query.refetch()}>
          {query.isError ? 'Повторити завантаження' : 'Завантажую…'}
        </button>
      )}
      {error && (
        <p role="alert" className="text-neg text-sm mt-3">
          {error}
        </p>
      )}
    </div>
  );
}
