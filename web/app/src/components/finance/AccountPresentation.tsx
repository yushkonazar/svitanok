import type { ReactNode } from 'react';
import type { Finance } from '../../api/finance-schema.ts';
import { financeTime } from './analytics-format.ts';
type Account = Finance['accounts'][number];
export function accountFreshness(a: Account) {
  if (a.kind === 'mono')
    return a.asOf
      ? `Банківський залишок: ${financeTime(a.asOf)}`
      : 'Час банківського залишку невідомий';
  return a.balanceConfirmedAt
    ? `Звірено: ${financeTime(a.balanceConfirmedAt)}`
    : 'Дата ручної звірки не вказана';
}
export function AccountCollection({
  accounts,
  children,
}: {
  accounts: Account[];
  children: (account: Account) => ReactNode;
}) {
  const inactive = (a: Account) =>
    a.kind === 'mono' && a.balanceMinor === 0 && a.availableMinor === 0 && a.creditLimitMinor === 0;
  const zero = accounts.filter(inactive);
  return (
    <>
      {accounts.filter((a) => !inactive(a)).map(children)}
      {zero.length > 0 && (
        <details className="finance-zero-accounts">
          <summary className="renewal-link">Нульові рахунки · {zero.length}</summary>
          <div className="finance-account-grid mt-3">{zero.map(children)}</div>
        </details>
      )}
    </>
  );
}
