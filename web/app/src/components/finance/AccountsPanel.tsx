import type { Finance } from '../../api/finance-schema.ts';
import type { FinanceFormRequest } from './FinanceForm.tsx';
import { moneyLabel } from '../../lib/financeView.ts';
export function AccountsPanel({
  finance: f,
  onAction,
}: {
  finance: Finance;
  onAction: (r: FinanceFormRequest) => void;
}) {
  return (
    <details className="renewal-card renewal-disclosure">
      <summary className="renewal-section-head cursor-pointer">
        <h2 className="text-lg font-bold">Рахунки та інструменти</h2>
        <span className="renewal-pill">{f.accounts.length}</span>
      </summary>
      <p className="renewal-muted mb-4">
        Власні залишки, кредитні кошти й способи перенесення грошей.
      </p>
      <div className="finance-account-grid">
        {f.accounts.map((a) => (
          <article key={a.id} className="finance-account">
            <div className="renewal-section-head">
              <span className="finance-account-icon" aria-hidden="true">
                {a.kind === 'cash' ? '₴' : '▤'}
              </span>
              <span className="renewal-pill">
                {a.kind === 'mono' ? 'Monobank' : a.kind === 'cash' ? 'Готівка' : 'Ручний облік'}
              </span>
            </div>
            <h3 className="font-semibold break-words">{a.name}</h3>
            <p
              className={`finance-account-balance ${a.balanceMinor != null && a.balanceMinor < 0 ? 'text-neg' : ''}`}
            >
              {a.balanceMinor == null ? 'Потрібен залишок' : moneyLabel(a.balanceMinor, a.currency)}
            </p>
            {a.kind === 'mono' && (
              <>
                <p className="renewal-chart-note">
                  Доступно в банку:{' '}
                  {a.availableMinor == null ? '—' : moneyLabel(a.availableMinor, a.currency)}
                  <br />
                  Кредитний ліміт:{' '}
                  {a.creditLimitMinor == null
                    ? 'невідомий'
                    : moneyLabel(a.creditLimitMinor, a.currency)}
                </p>
                <button
                  className="renewal-link"
                  onClick={() => onAction({ kind: 'credit-limit', id: a.id })}
                >
                  Налаштувати ліміт
                </button>
              </>
            )}
            {a.kind !== 'mono' && (
              <button
                className="renewal-link"
                onClick={() => onAction({ kind: 'account-balance', id: a.id })}
              >
                Уточнити залишок
              </button>
            )}
            <small className="renewal-muted">
              {a.asOf
                ? `Оновлено ${new Date(a.asOf).toLocaleDateString('uk-UA')}`
                : 'Початковий залишок'}
            </small>
          </article>
        ))}
      </div>
      <div className="finance-tool-grid mt-4">
        <button className="renewal-secondary" onClick={() => onAction({ kind: 'transfer' })}>
          ⇄ Переказ між рахунками
        </button>
        <button className="renewal-secondary" onClick={() => onAction({ kind: 'account-balance' })}>
          Вказати поточний залишок
        </button>
        <button className="renewal-secondary" onClick={() => onAction({ kind: 'account' })}>
          Додати рахунок +
        </button>
      </div>
    </details>
  );
}
