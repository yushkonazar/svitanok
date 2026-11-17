import { AccountCollection, accountFreshness } from './AccountPresentation.tsx';
import { financeTime } from './analytics-format.ts';
import type { Finance } from '../../api/finance-schema.ts';
import type { FinanceFormRequest } from './FinanceForm.tsx';
import { moneyLabel } from '../../lib/financeView.ts';

type Account = Finance['accounts'][number];
export type AccountVerification = { accountId: string; message: string; error?: boolean };

const bankTypes = new Map([
  ['black', 'Чорна картка'],
  ['white', 'Біла картка'],
  ['platinum', 'Platinum'],
  ['iron', 'Iron Bank'],
  ['fop', 'Рахунок ФОП'],
  ['yellow', 'Дитяча картка'],
]);

function accountMetadata(account: Account) {
  const type =
    account.kind === 'mono'
      ? (bankTypes.get(account.bankType ?? '') ??
        (account.name.includes('Monobank') ? '' : 'Monobank'))
      : account.kind === 'bank'
        ? 'Ручний облік'
        : '';
  return type ? `${type} · ${account.currency}` : account.currency;
}

export function AccountsPanel({
  finance: f,
  onAction,
  onRefreshBank,
  onVerifyBank,
  checking,
  checkResult,
  bankBusy = false,
}: {
  finance: Finance;
  onAction: (r: FinanceFormRequest) => void;
  onRefreshBank: (accountId: string) => void;
  onVerifyBank: (accountId: string) => void;
  checking: string | null;
  checkResult: AccountVerification | null;
  bankBusy?: boolean;
}) {
  const jars = f.bankJars ?? [];
  const needsReview = f.inactiveAccounts?.filter((a) => !a.archivedAt) ?? [];
  const archived = f.inactiveAccounts?.filter((a) => a.archivedAt) ?? [];
  const lastCheck = f.bankCatalog?.checkedAt;
  const sync = f.bankSync?.balancesOnly ? f.bankSync : null;
  const checkedAll =
    lastCheck &&
    !checking &&
    !checkResult &&
    sync?.phase === 'done' &&
    sync.verificationAccountId === 'all';
  const verification: AccountVerification | null = checking
    ? { accountId: checking, message: 'Запитуємо список рахунків у Monobank…' }
    : (checkResult ??
      (sync
        ? {
            accountId: sync.verificationAccountId ?? 'all',
            message: sync.message ?? 'Запитуємо список рахунків у Monobank…',
            error: sync.phase === 'error',
          }
        : null));
  const feedback = (id: string) =>
    verification?.accountId === id ? (
      <p
        className={verification.error ? 'text-neg text-sm' : 'renewal-muted'}
        role={verification.error ? 'alert' : 'status'}
      >
        {verification.message}
      </p>
    ) : null;
  const verify = (a: { id: string; name: string }) => (
    <button
      type="button"
      className="renewal-link"
      disabled={bankBusy}
      aria-label={`Перевірити ${a.name} в Monobank`}
      onClick={() => onVerifyBank(a.id)}
    >
      Перевірити
    </button>
  );
  const remove = (a: Account) => (
    <button
      type="button"
      className="renewal-link"
      aria-label={`Видалити рахунок ${a.name}`}
      onClick={() => onAction({ kind: 'account-remove', id: a.id })}
    >
      Видалити
    </button>
  );
  const statement = (id: string) => (
    <button
      type="button"
      className="renewal-link"
      disabled={bankBusy}
      onClick={() => onRefreshBank(id)}
    >
      Оновити виписку
    </button>
  );
  const funding = (url?: string) =>
    url && (
      <a className="renewal-link" href={url} target="_blank" rel="noreferrer">
        Поповнити ↗
      </a>
    );

  return (
    <details className="renewal-card renewal-disclosure finance-accounts">
      <summary className="renewal-section-head cursor-pointer">
        <h2 className="text-lg font-bold">Рахунки та інструменти</h2>
        <span className="renewal-pill">{f.accounts.length + jars.length}</span>
      </summary>
      <div className="finance-accounts-actions">
        <button
          type="button"
          className="renewal-secondary"
          onClick={() => onAction({ kind: 'account' })}
        >
          + Додати рахунок
        </button>
        <button
          type="button"
          className="renewal-secondary"
          onClick={() => onAction({ kind: 'transfer' })}
        >
          ⇄ Переказати
        </button>
      </div>
      <div className="finance-accounts-bank">
        <div className="renewal-section-head">
          <div>
            <h3 className="font-semibold">Звірка Monobank</h3>
            <p className="renewal-muted" aria-live="polite">
              {lastCheck ? `Звірено ${financeTime(lastCheck)}` : 'Список ще не звірено'}
            </p>
          </div>
          <button
            type="button"
            className="renewal-link"
            disabled={bankBusy}
            onClick={() => onVerifyBank('all')}
          >
            Перевірити всі
          </button>
        </div>
        {!checkedAll && feedback('all')}
        {verification &&
          verification.accountId !== 'all' &&
          ![...f.accounts, ...jars, ...needsReview].some((a) => a.id === verification.accountId) &&
          feedback(verification.accountId)}
      </div>

      {!!needsReview.length && (
        <section className="finance-accounts-review">
          <h3 className="font-semibold">Потребують уваги · {needsReview.length}</h3>
          {needsReview.map((a) => (
            <article className="finance-account-exception" key={a.id}>
              <div>
                <p className="font-medium break-words">{a.name}</p>
                <p className="renewal-muted">
                  {a.bankStatus === 'duplicate'
                    ? 'Дубль зв’язку з Monobank'
                    : a.bankStatus === 'missing'
                      ? 'Поза списком Monobank'
                      : 'Потрібна звірка з Monobank'}
                </p>
              </div>
              <div className="finance-account-actions">
                {a.monoId && a.bankStatus !== 'duplicate' && verify(a)}
                {remove(a)}
              </div>
              {feedback(a.id)}
            </article>
          ))}
        </section>
      )}

      <div className="finance-accounts-list">
        {!f.accounts.length && <p className="renewal-muted">Активних рахунків поки немає.</p>}
        <AccountCollection accounts={f.accounts}>
          {(a) => (
            <details key={a.id} className="finance-account-row">
              <summary>
                <span className="finance-account-label">
                  <strong>{a.name}</strong>
                  <small>{accountMetadata(a)}</small>
                </span>
                <span
                  className={`finance-account-value ${a.balanceMinor != null && a.balanceMinor < 0 ? 'text-neg' : ''}`}
                >
                  {a.balanceMinor == null
                    ? a.kind === 'mono'
                      ? 'Потрібна звірка'
                      : 'Без залишку'
                    : moneyLabel(a.balanceMinor, a.currency)}
                </span>
              </summary>
              <div className="finance-account-details">
                <p className="renewal-muted">{accountFreshness(a)}</p>
                {a.kind === 'mono' && (
                  <>
                    <dl className="finance-account-breakdown">
                      <div>
                        <dt>Доступно в банку</dt>
                        <dd>
                          {a.availableMinor == null
                            ? '—'
                            : moneyLabel(a.availableMinor, a.currency)}
                        </dd>
                      </div>
                      <div>
                        <dt>Кредитний ліміт</dt>
                        <dd>
                          {a.creditLimitMinor == null
                            ? '—'
                            : moneyLabel(a.creditLimitMinor, a.currency)}
                        </dd>
                      </div>
                    </dl>
                    {a.creditLimitSource === 'manual' &&
                      a.bankCreditLimitMinor != null &&
                      a.bankCreditLimitMinor !== a.creditLimitMinor && (
                        <p className="renewal-muted">
                          Діє ручний ліміт. Ліміт Monobank{' '}
                          {moneyLabel(a.bankCreditLimitMinor, a.currency)}.
                        </p>
                      )}
                  </>
                )}
                <div className="finance-account-actions">
                  {a.kind === 'mono' ? (
                    <>
                      {verify(a)}
                      {statement(a.id)}
                      <button
                        type="button"
                        className="renewal-link"
                        onClick={() => onAction({ kind: 'credit-limit', id: a.id })}
                      >
                        Змінити ліміт
                      </button>
                      {funding(a.fundingUrl)}
                    </>
                  ) : (
                    <button
                      type="button"
                      className="renewal-link"
                      onClick={() => onAction({ kind: 'account-balance', id: a.id })}
                    >
                      Звірити залишок
                    </button>
                  )}
                  {remove(a)}
                </div>
                {feedback(a.id)}
              </div>
            </details>
          )}
        </AccountCollection>
      </div>

      {(jars.length > 0 || f.bankCatalog?.jarListing === 'omitted') && (
        <details className="finance-account-group">
          <summary className="renewal-link">Банки Monobank · {jars.length}</summary>
          {f.bankCatalog?.jarListing === 'omitted' && (
            <p className="renewal-muted">Monobank не передав список банок.</p>
          )}
          {jars.map((jar) => (
            <details key={jar.id} className="finance-account-row">
              <summary>
                <span className="finance-account-label">
                  <strong>{jar.name}</strong>
                  <small>
                    {jar.goalMinor == null
                      ? jar.currency
                      : `Ціль ${moneyLabel(jar.goalMinor, jar.currency)}`}
                  </small>
                </span>
                <span className="finance-account-value">
                  {jar.balanceMinor == null
                    ? 'Без залишку'
                    : moneyLabel(jar.balanceMinor, jar.currency)}
                </span>
              </summary>
              <div className="finance-account-details">
                {jar.asOf && <p className="renewal-muted">Залишок за {financeTime(jar.asOf)}</p>}
                <div className="finance-account-actions">
                  {verify(jar)}
                  {statement(jar.id)}
                  {funding(jar.fundingUrl)}
                </div>
                {feedback(jar.id)}
              </div>
            </details>
          ))}
        </details>
      )}

      {archived.length > 0 && (
        <details className="finance-account-group">
          <summary className="renewal-link">Архів рахунків · {archived.length}</summary>
          {archived.map((a) => (
            <div className="finance-account-exception" key={a.id}>
              <div>
                <p className="font-medium break-words">{a.name}</p>
                <p className="renewal-muted">{accountMetadata(a)}</p>
              </div>
              <button
                type="button"
                className="renewal-link"
                aria-label={`Відновити рахунок ${a.name}`}
                onClick={() => onAction({ kind: 'account-restore', id: a.id })}
              >
                Відновити
              </button>
            </div>
          ))}
        </details>
      )}
    </details>
  );
}
