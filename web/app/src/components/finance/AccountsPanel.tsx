import { AccountCollection, accountFreshness } from './AccountPresentation.tsx';
import { financeTime } from './analytics-format.ts';
import type { Finance } from '../../api/finance-schema.ts';
import type { FinanceFormRequest } from './FinanceForm.tsx';
import { moneyLabel } from '../../lib/financeView.ts';
import { usePresentation } from '../../lib/presentation.ts';
export function AccountsPanel({
  finance: f,
  onAction,
  onRefreshBank,
  bankBusy = false,
}: {
  finance: Finance;
  onAction: (r: FinanceFormRequest) => void;
  onRefreshBank?: (accountId: string) => void;
  bankBusy?: boolean;
}) {
  const jars = f.bankJars ?? [];
  const { explanations } = usePresentation();
  return (
    <details className="renewal-card renewal-disclosure">
      <summary className="renewal-section-head cursor-pointer">
        <h2 className="text-lg font-bold">Рахунки та інструменти</h2>
        <span className="renewal-pill">{f.accounts.length + jars.length}</span>
      </summary>
      {explanations && (
        <p className="renewal-muted mb-4">
          Власні залишки, кредитні кошти й способи перенесення грошей.
        </p>
      )}
      <div className="finance-account-grid">
        <AccountCollection accounts={f.accounts}>
          {(a) => (
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
                {a.balancePending
                  ? bankBusy
                    ? 'Оновлюємо баланс'
                    : 'Онови дані Monobank'
                  : a.balanceMinor == null
                    ? 'Потрібен залишок'
                    : moneyLabel(a.balanceMinor, a.currency)}
              </p>
              <small className="renewal-muted">
                {accountFreshness(a)}
                {a.kind !== 'mono' && a.lastMovementAt ? (
                  <span className="block">Останній рух · {financeTime(a.lastMovementAt)}</span>
                ) : null}
              </small>
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
                  {onRefreshBank && (
                    <button
                      className="renewal-link"
                      disabled={bankBusy}
                      aria-busy={bankBusy}
                      onClick={() => onRefreshBank(a.id)}
                    >
                      Оновити виписку ↻
                    </button>
                  )}
                  {a.fundingUrl && (
                    <a
                      className="renewal-link"
                      href={a.fundingUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Поповнити в Monobank ↗
                    </a>
                  )}
                  {a.creditLimitSource === 'manual' &&
                    a.bankCreditLimitMinor != null &&
                    a.bankCreditLimitMinor !== a.creditLimitMinor && (
                      <p className="renewal-chart-note">
                        У Monobank ліміт {moneyLabel(a.bankCreditLimitMinor, a.currency)}; тут
                        використовується твій ручний ліміт. Перевір налаштування.
                      </p>
                    )}
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
            </article>
          )}
        </AccountCollection>
      </div>
      {(f.bankCatalog ||
        f.accounts.some((account) => account.kind === 'mono') ||
        jars.length > 0) && (
        <section className="mt-4 space-y-2">
          <h3 className="font-semibold">Банки Monobank</h3>
          {f.bankCatalog?.jarListing === 'omitted' && (
            <p className="renewal-muted">У відповіді Monobank відсутній список банок.</p>
          )}
          {f.bankCatalog?.jarListing === 'available' && !jars.length && (
            <p className="renewal-muted">Monobank повернув порожній список банок.</p>
          )}
          {explanations && (
            <p className="renewal-muted">
              Банки показані окремо від вільних коштів і цілей Світанку.
            </p>
          )}
          <div className="renewal-finance-actions">
            <a
              className="renewal-link"
              href="https://monobank.ua/banka"
              target="_blank"
              rel="noreferrer"
            >
              Як відкрити банку ↗
            </a>
            {onRefreshBank && (
              <button
                className="renewal-link"
                disabled={bankBusy}
                onClick={() => onRefreshBank('all')}
              >
                Оновити рахунки й банки ↻
              </button>
            )}
          </div>
          <div className="finance-account-grid">
            {jars.map((jar) => (
              <article key={jar.id} className="finance-account">
                <h4 className="font-semibold break-words">{jar.name}</h4>
                <p className="finance-account-balance">
                  {jar.balanceMinor == null
                    ? 'Залишок невідомий'
                    : moneyLabel(jar.balanceMinor, jar.currency)}
                </p>
                {jar.goalMinor != null && (
                  <small className="renewal-muted">
                    Ціль {moneyLabel(jar.goalMinor, jar.currency)}
                  </small>
                )}
                {jar.asOf && (
                  <small className="renewal-muted">Дані за {financeTime(jar.asOf)}</small>
                )}
                {jar.fundingUrl && (
                  <a
                    className="renewal-link"
                    href={jar.fundingUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Поповнити банку в Monobank ↗
                  </a>
                )}
                {onRefreshBank && (
                  <button
                    className="renewal-link"
                    disabled={bankBusy}
                    onClick={() => onRefreshBank(jar.id)}
                  >
                    Оновити виписку ↻
                  </button>
                )}
              </article>
            ))}
          </div>
        </section>
      )}
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
