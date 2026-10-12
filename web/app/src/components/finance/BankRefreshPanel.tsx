import type { Finance } from '../../api/finance-schema.ts';
export function BankRefreshPanel({
  finance,
  accountId,
  onAccountChange,
  onRefresh,
  busy,
  message,
  error,
}: {
  finance: Finance;
  accountId: string;
  onAccountChange: (id: string) => void;
  onRefresh: () => void;
  busy: boolean;
  message?: string;
  error?: string;
}) {
  const status = finance.bankSync;
  return (
    <div className="renewal-inset">
      <label className="renewal-field">
        Картка для оновлення виписки
        <select
          value={accountId}
          onChange={(e) => onAccountChange(e.target.value)}
          disabled={busy || !!status?.active}
        >
          <option value="all">Усі картки Monobank</option>
          {finance.accounts
            .filter((a) => a.kind === 'mono')
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
        </select>
      </label>
      <button
        type="button"
        className="renewal-secondary"
        disabled={busy || !!status?.active || !accountId}
        onClick={onRefresh}
        aria-busy={busy || !!status?.active}
      >
        {busy
          ? 'Запускаю оновлення…'
          : status?.active
            ? 'Виписки оновлюються…'
            : 'Оновити список Monobank ↻'}
      </button>
      {status?.active ? (
        <p className="renewal-muted" role="status">
          Баланс і виписка · {status.done}/{status.total} етапів · нових: {status.imported},
          оновлених: {status.updated}. {status.message ?? 'Список оновиться автоматично.'}
        </p>
      ) : status?.phase === 'done' ? (
        <p className="renewal-muted" role="status">
          {status.balanceUpdatedAt
            ? 'Залишки, ліміти й виписки оновлено.'
            : 'Виписки оновлено; залишки можна звірити кнопкою вище.'}{' '}
          Нових: {status.imported}, оновлених: {status.updated}.
          {status.balanceUpdatedAt && (
            <>
              {' '}
              Залишки звірено{' '}
              {new Date(status.balanceUpdatedAt).toLocaleTimeString('uk-UA', {
                timeZone: 'Europe/Kyiv',
                hour: '2-digit',
                minute: '2-digit',
              })}
              .
            </>
          )}
          Позначка hold може залишитись, якщо її досі передає API банку.
        </p>
      ) : message ? (
        <p className="renewal-muted" role="status">
          {message}
        </p>
      ) : null}
      {(error || status?.phase === 'error') && (
        <p className="text-neg text-sm" role="alert">
          {error || status?.message}
        </p>
      )}
    </div>
  );
}
