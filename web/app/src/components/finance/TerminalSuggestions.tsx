import { useState } from 'react';
import type { Finance } from '../../api/finance-schema.ts';
import { isTerminalTopup } from '../../../../core/finance/display.mjs';
import { moneyLabel } from '../../lib/financeView.ts';
import { useFinanceAction } from './useFinanceAction.ts';
export function TerminalSuggestions({
  finance,
  onOpen,
}: {
  finance: Finance;
  onOpen: (id: string) => void;
}) {
  const action = useFinanceAction(finance),
    [confirmed, setConfirmed] = useState<string[]>([]),
    [separate, setSeparate] = useState<string[]>([]),
    [cashId, setCashId] = useState(finance.accounts.find((a) => a.kind === 'cash')?.id ?? '');
  const candidates = finance.transactions.filter(isTerminalTopup).slice(0, 3),
    cash = finance.accounts.find((a) => a.id === cashId);
  if (!candidates.length) return null;
  return (
    <section className="renewal-card finance-terminal">
      <h2 className="font-bold">Уточнити поповнення</h2>
      <p className="renewal-chart-note mt-2">
        Термінал розпізнано за описом. Джерело грошей обираєте ви; власне поповнення не створює
        доходу.
      </p>
      {finance.accounts.filter((a) => a.kind === 'cash').length > 1 && (
        <label className="renewal-field mt-3">
          Рахунок готівки
          <select
            disabled={action.pending || action.uncertain}
            value={cashId}
            onChange={(e) => setCashId(e.target.value)}
          >
            {finance.accounts
              .filter((a) => a.kind === 'cash')
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </select>
        </label>
      )}
      {candidates.map((t) => {
        const hold = t.bankHold && !t.bankVerifiedByOwner,
          verified = confirmed.includes(t.id);
        const existing = finance.transactions.filter(
          (x) =>
            !x.bank &&
            !x.reference &&
            x.kind === 'transfer' &&
            x.accountId === cashId &&
            x.amountMinor === -t.amountMinor &&
            Math.abs(Date.parse(x.at) - Date.parse(t.at)) < 86400000,
        );
        return (
          <div key={t.id} className="renewal-inset mt-3">
            <div className="renewal-section-head">
              <button className="renewal-link" onClick={() => onOpen(t.id)}>
                {t.description} ↗
              </button>
              <b>{moneyLabel(t.amountUah!)}</b>
            </div>
            <p className="renewal-muted mt-2">Це поповнення з вашої готівки?</p>
            {hold && (
              <label className="flex gap-2 mt-2">
                <input
                  type="checkbox"
                  checked={verified}
                  disabled={action.pending || action.uncertain}
                  onChange={(e) =>
                    setConfirmed(
                      e.target.checked
                        ? [...confirmed, t.id]
                        : confirmed.filter((id) => id !== t.id),
                    )
                  }
                />
                У Monobank операція вже успішна
              </label>
            )}
            {cash?.balanceMinor != null && cash.balanceMinor < t.amountMinor && (
              <p className="renewal-chart-note mt-2">
                Записано готівки менше за поповнення. Звірте залишок; система не створюватиме
                прихованого доходу.
              </p>
            )}
            {existing.length === 1 && (
              <label className="renewal-chart-note flex gap-2 mt-2">
                <input
                  type="checkbox"
                  checked={!separate.includes(t.id)}
                  disabled={action.pending || action.uncertain}
                  onChange={(e) =>
                    setSeparate(
                      e.target.checked ? separate.filter((id) => id !== t.id) : [...separate, t.id],
                    )
                  }
                />
                <span>
                  Використати знайдену готівкову сторону від {existing[0]!.at.slice(0, 10)} без
                  другого списання. Зніміть позначку, якщо це інший переказ.
                </span>
              </label>
            )}
            <div className="flex flex-wrap gap-2 mt-3">
              <button
                className="renewal-button"
                disabled={action.pending || action.uncertain || !cashId || (hold && !verified)}
                onClick={() =>
                  void action.run('bank-transfer', {
                    transactionId: t.id,
                    accountId: cashId,
                    bankHoldConfirmed: verified,
                    ...(existing.length === 1 && !separate.includes(t.id)
                      ? { manualTransactionId: existing[0]!.id }
                      : {}),
                  })
                }
              >
                Моя готівка
              </button>
              <button
                className="renewal-secondary"
                disabled={action.pending || action.uncertain}
                onClick={() =>
                  void action.run('classify', {
                    transactionId: t.id,
                    kind: 'income',
                    category: 'інші надходження',
                  })
                }
              >
                Інше надходження
              </button>
            </div>
          </div>
        );
      })}
      {action.error && (
        <p role="alert" className="text-neg mt-3">
          {action.error}
        </p>
      )}
      {action.uncertain && (
        <button
          className="renewal-secondary mt-3"
          disabled={action.pending}
          onClick={() => void action.retry()}
        >
          Перевірити попереднє підтвердження
        </button>
      )}
    </section>
  );
}
