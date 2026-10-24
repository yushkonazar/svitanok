import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Finance, FinanceCommand } from '../../api/finance-schema.ts';
import { postFinance } from '../../api/client.ts';
import {
  FinanceSaveUncertainError,
  FinanceCommandRejectedError,
} from '../../api/finance-errors.ts';
import { FINANCE_QUERY } from '../../api/finance-hooks.ts';
export function useFinanceAction(finance: Pick<Finance, 'version'>) {
  const query = useQueryClient(),
    attempt = useRef<{ key: string; command: FinanceCommand } | null>(null),
    lock = useRef(false);
  const [pending, setPending] = useState(false),
    [error, setError] = useState(''),
    [uncertain, setUncertain] = useState(false);
  const run = async (type: string, payload: Record<string, unknown>) => {
    if (lock.current) return false;
    const key = JSON.stringify([type, payload, finance.version]);
    if (!uncertain && attempt.current?.key !== key)
      attempt.current = {
        key,
        command: { id: crypto.randomUUID(), version: finance.version, type, payload },
      };
    if (!attempt.current) return false;
    lock.current = true;
    setPending(true);
    setError('');
    try {
      const result = await postFinance(attempt.current.command);
      if (result?.finance) query.setQueryData(FINANCE_QUERY, result);
      else await query.invalidateQueries({ queryKey: FINANCE_QUERY });
      setUncertain(false);
      attempt.current = null;
      return true;
    } catch (e) {
      setUncertain(e instanceof FinanceSaveUncertainError);
      setError(e instanceof Error ? e.message : 'Не вдалося зберегти');
      if (!(e instanceof FinanceSaveUncertainError)) attempt.current = null;
      if (e instanceof FinanceCommandRejectedError && e.status === 409)
        await query.invalidateQueries({ queryKey: FINANCE_QUERY });
      return false;
    } finally {
      lock.current = false;
      setPending(false);
    }
  };
  const retry = () =>
    attempt.current
      ? run(attempt.current.command.type, attempt.current.command.payload)
      : Promise.resolve(false);
  return { run, retry, pending, error, uncertain };
}
