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
        <select value={accountId} onChange={(e) => onAccountChange(e.target.value)} disabled={busy}>
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
      >
        {busy
          ? 'Запускаю оновлення…'
          : status?.active
            ? 'Виписки оновлюються…'
            : 'Оновити список Monobank ↻'}
      </button>
      {status?.active ? (
        <p className="renewal-muted" role="status">
          Оновлення у фоні · {status.done}/{status.total} відрізків виписки · нових:{' '}
          {status.imported}, оновлених: {status.updated}.{' '}
          {status.message ?? 'Список оновиться автоматично.'}
        </p>
      ) : status?.phase === 'done' ? (
        <p className="renewal-muted" role="status">
          Виписки звірено з Monobank. Нових: {status.imported}, оновлених: {status.updated}.
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
