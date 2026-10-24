import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Finance } from '../../api/finance-schema.ts';
import { postFinance } from '../../api/client.ts';
import { FINANCE_QUERY } from '../../api/finance-hooks.ts';
import { moneyLabel } from '../../lib/financeView.ts';
import { useFinanceAction } from './useFinanceAction.ts';

export function TransactionDetail({
  transaction: tx,
  version,
  onBack,
  onClassify,
  backLabel = 'До фінансів',
  finance,
}: {
  transaction: Finance['transactions'][number];
  version: number;
  onBack: () => void;
  onClassify: () => void;
  backLabel?: string;
  finance?: Finance;
}) {
  const undo = useFinanceAction({ version });
  const created = finance?.transactions.find(
    (t) => t.id === `bank-transfer:${tx.reference}` && t.reference === tx.reference,
  );
  const manual =
    finance?.transactions.filter(
      (t) =>
        !t.bank &&
        t.kind === 'transfer' &&
        t.reference === tx.reference &&
        t.amountMinor === -tx.amountMinor &&
        t.accountId !== tx.accountId,
    ) ?? [];
  const canUndo =
    !!tx.bank && !!tx.reference && tx.kind === 'transfer' && (!!created || manual.length === 1);
  const query = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState<'reviewing' | 'different' | null>(null);
  const status = saved ?? tx.attention?.status;
  const acknowledge = async (next: 'reviewing' | 'different') => {
    if (pending) return;
    setPending(true);
    setError('');
    try {
      await postFinance({
        id: crypto.randomUUID(),
        version,
        type: 'transaction-attention',
        payload: { transactionId: tx.id, status: next },
      });
      setSaved(next);
      await query.invalidateQueries({ queryKey: FINANCE_QUERY });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не вдалося зберегти відповідь.');
      await query.invalidateQueries({ queryKey: FINANCE_QUERY });
    } finally {
      setPending(false);
    }
  };
  return (
    <section className="renewal-card flex flex-col gap-4">
      <button className="renewal-link" onClick={onBack}>
        ← {backLabel}
      </button>
      <h1 className="text-xl font-bold">{tx.description || 'Операція'}</h1>
      <strong>{moneyLabel(tx.amountMinor, tx.currency)}</strong>
      {tx.currency !== 'UAH' && (
        <p className="renewal-inset">
          {tx.amountUah == null
            ? 'Гривнева сума цієї операції невідома. Поточний курс не підставляється.'
            : `${tx.bank ? 'Фактичне списання з рахунку' : 'Зафіксована гривнева сума'}: ${moneyLabel(tx.amountUah)}. Історичний еквівалент збережено разом з операцією.`}
        </p>
      )}
      <p className="renewal-muted">
        {tx.category} · {new Date(tx.at).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' })}
      </p>
      {tx.bankHold && (
        <p className="renewal-inset">
          {tx.bankVerifiedByOwner
            ? 'Ти підтвердив успішну оплату. API Monobank ще повертає hold; банківська позначка збережена окремо.'
            : 'API Monobank повертає hold. У банківському застосунку оплата вже може бути успішною. Для підв’язування звір її в банку й підтвердь це у відповідній формі.'}
        </p>
      )}
      {tx.bankMissingFromStatement && (
        <p className="renewal-inset">
          Банк не повернув цей запис під час повної звірки його дат. Це не підтвердження списання.
          Перевір історію Monobank перед обліком.
        </p>
      )}
      {tx.bankAmountChanged && (
        <p className="renewal-inset">
          Банк змінив остаточну суму після твого підтвердження. Перевір пов’язаний платіж або
          розрахунок: його суму не переписано автоматично.
        </p>
      )}
      {tx.duplicateSuspected && (
        <div className="renewal-inset">
          {status === 'different'
            ? 'Позначено як різні покупки. Обидві операції залишились в обліку.'
            : status === 'reviewing'
              ? 'Чекає твоєї перевірки. Списання не скасовано.'
              : 'Схожа операція була невдовзі перед цією. Перевір, чи це різні покупки.'}
        </div>
      )}
      {tx.duplicateSuspected && status !== 'different' && (
        <div className="renewal-finance-actions">
          {!status && (
            <button
              disabled={pending}
              className="renewal-secondary"
              onClick={() => void acknowledge('reviewing')}
            >
              Перевірю списання
            </button>
          )}
          <button
            disabled={pending}
            className="renewal-secondary"
            onClick={() => void acknowledge('different')}
          >
            Це різні покупки
          </button>
        </div>
      )}
      {!tx.reference && (tx.bank || ['expense', 'income', 'unclassified'].includes(tx.kind)) && (
        <button disabled={pending} className="renewal-button" onClick={onClassify}>
          Уточнити категорію та тип
        </button>
      )}
      {canUndo && (
        <div className="renewal-inset">
          <p className="renewal-chart-note mb-3">
            {created
              ? 'Скасування власного переказу поверне автоматично списану суму на ручний рахунок і дозволить уточнити банківську операцію.'
              : 'Скасування відв’яже наявний ручний запис. Його суму збережено: повторного зарахування на рахунок не буде.'}
          </p>
          <button
            className="renewal-secondary"
            disabled={undo.pending}
            onClick={() =>
              void (undo.uncertain
                ? undo.retry()
                : undo.run('bank-transfer-undo', { transactionId: tx.id }))
            }
          >
            {undo.pending
              ? 'Перевіряю…'
              : undo.uncertain
                ? 'Перевірити скасування'
                : 'Скасувати зв’язок переказу'}
          </button>
          {undo.error && <p role="alert">{undo.error}</p>}
        </div>
      )}
      {pending && <p role="status">Зберігаю відповідь…</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
