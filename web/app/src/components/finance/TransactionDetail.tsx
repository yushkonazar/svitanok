import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Finance } from '../../api/finance-schema.ts';
import { postFinance, refreshFinanceBank } from '../../api/client.ts';
import { FINANCE_QUERY } from '../../api/finance-hooks.ts';
import { moneyLabel } from '../../lib/financeView.ts';
import { useFinanceAction } from './useFinanceAction.ts';
import { financeTime } from './analytics-format.ts';
import { needsBankHoldConfirmation } from '../../../../core/finance/payment-link.mjs';

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
  const review = useFinanceAction({ version });
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
  const [reviewTarget, setReviewTarget] = useState<string | null>(null);
  const reviewKey = JSON.stringify([tx.id, tx.amountMinor, tx.amountUah, tx.currency]);
  const reviewOpen = reviewTarget === reviewKey;
  const [bankBusy, setBankBusy] = useState(false);
  const [bankError, setBankError] = useState('');
  const bankAccountId = tx.bankAccountId ?? tx.accountId;
  const needsConfirmation = needsBankHoldConfirmation(tx);
  const canConfirm =
    needsConfirmation && !tx.bankMissingFromStatement && !(tx.reference && tx.bankAmountChanged);
  const reviewHold = async (confirmed: boolean) => {
    const ok = await review.run('bank-hold-review', {
      transactionId: tx.id,
      confirmed,
      ...(confirmed
        ? { amountMinor: tx.amountMinor, amountUah: tx.amountUah, currency: tx.currency }
        : {}),
    });
    if (ok) setReviewTarget(null);
  };
  const recheckBank = async () => {
    if (!bankAccountId || bankBusy || finance?.bankSync?.active) return;
    setBankBusy(true);
    setBankError('');
    try {
      query.setQueryData(FINANCE_QUERY, await refreshFinanceBank(bankAccountId, tx.id));
    } catch (e) {
      setBankError(e instanceof Error ? e.message : 'Не вдалося запустити звірку.');
    } finally {
      setBankBusy(false);
    }
  };
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
      {(tx.balanceCoveredBy || created?.balanceCoveredBy) && (
        <p className="renewal-inset">
          Історичний переказ уже враховано під час пізнішої звірки залишку. Поточна готівка не
          списується повторно.
        </p>
      )}
      {tx.bankHold && !tx.bankMissingFromStatement && (
        <p className="renewal-inset">
          {needsConfirmation
            ? 'Очікую остаточного статусу від Monobank. Свіжі операції Світанок звіряє автоматично.'
            : 'Ти підтвердив оплату. Очікую остаточного статусу від Monobank.'}
        </p>
      )}
      {tx.bankMissingFromStatement && (
        <p className="renewal-inset">
          {!needsConfirmation ? 'Ти підтвердив оплату. ' : ''}У звіреній виписці операція відсутня.
          Перевір її в Monobank перед обліком.
        </p>
      )}
      {tx.bankCheckedAt && (
        <p className="renewal-muted">
          {tx.bankCheckSource === 'statement' ? 'Звірено за випискою' : 'Дані від Monobank'} ·{' '}
          {financeTime(tx.bankCheckedAt)}
        </p>
      )}
      {tx.bankHold &&
        tx.bankRecheckedAt &&
        (!tx.bankCheckedAt || Date.parse(tx.bankRecheckedAt) > Date.parse(tx.bankCheckedAt)) && (
          <p className="renewal-muted">
            Остання перевірка виписки · {financeTime(tx.bankRecheckedAt)}
          </p>
        )}
      {tx.bankVerifiedAt && (
        <p className="renewal-muted">
          {tx.bankAmountChanged ? 'Підтвердження попередньої суми' : 'Твоє підтвердження'} ·{' '}
          {financeTime(tx.bankVerifiedAt)}
        </p>
      )}
      {tx.bank && tx.bankHold && (
        <div className="flex flex-col gap-2">
          {bankAccountId && (
            <button
              className="renewal-secondary"
              disabled={bankBusy || !!finance?.bankSync?.active}
              onClick={() => void recheckBank()}
            >
              {bankBusy || finance?.bankSync?.active
                ? 'Звіряємо виписку…'
                : 'Звірити у виписці Monobank'}
            </button>
          )}
          {bankError && (
            <p className="text-neg text-sm" role="alert">
              {bankError}
            </p>
          )}
          {canConfirm && !reviewOpen && (
            <button
              className="renewal-link"
              onClick={() => setReviewTarget(reviewKey)}
              disabled={review.pending || review.uncertain}
            >
              У Monobank операцію виконано
            </button>
          )}
          {reviewOpen && canConfirm && (
            <div className="renewal-inset">
              <p>
                Підтверди, якщо в Monobank виконано саме цю операцію на{' '}
                {moneyLabel(Math.abs(tx.amountMinor), tx.currency)}.
              </p>
              <div className="renewal-finance-actions">
                <button
                  className="renewal-secondary"
                  onClick={() => void reviewHold(true)}
                  disabled={review.pending || review.uncertain}
                >
                  Підтвердити за застосунком
                </button>
                <button
                  className="renewal-link"
                  onClick={() => setReviewTarget(null)}
                  disabled={review.pending || review.uncertain}
                >
                  Скасувати
                </button>
              </div>
            </div>
          )}
          {tx.bankVerifiedByOwner && !tx.reference && !reviewOpen && (
            <button
              className="renewal-link"
              onClick={() => void reviewHold(false)}
              disabled={review.pending || review.uncertain}
            >
              Скасувати моє підтвердження
            </button>
          )}
          {review.error && (
            <p className="text-neg text-sm" role="alert">
              {review.error}
            </p>
          )}
          {review.uncertain && (
            <button
              className="renewal-link"
              disabled={review.pending}
              onClick={() => void review.retry()}
            >
              Перевірити збереження
            </button>
          )}
        </div>
      )}
      {tx.bankAmountChanged && (
        <p className="renewal-inset">
          Monobank змінив суму після твого підтвердження.{' '}
          {tx.reference ? 'Звір пов’язаний запис із новою сумою.' : 'Звір оновлену суму.'}
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
