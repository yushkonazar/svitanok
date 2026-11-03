import { Link } from 'react-router-dom';
import { useStats } from '../../api/hooks.ts';
import { useFinance } from '../../api/finance-hooks.ts';
import { useTick } from '../../lib/useTick.ts';
import { kyivParts } from '../../../../core/finance/planning.mjs';
import { financeView, moneyLabel } from '../../lib/financeView.ts';
import { PageHeading } from '../ui/PageHeading.tsx';
import { TransactionAmount } from '../finance/TransactionAmount.tsx';
import { UpdatedValue } from '../ui/UpdatedValue.tsx';
import { TodaySpendingPulse } from './TodaySpendingPulse.tsx';
import { TodayPayment } from './TodayPayment.tsx';
import { TodayMoneySummary } from './TodayMoneySummary.tsx';
import { isSessionExpired } from '../../api/client.ts';

export function TodayAttention() {
  const nowMs = useTick(30_000);
  const { data: stats } = useStats();
  const finance = useFinance();
  const money = isSessionExpired(finance.error) ? undefined : finance.data;
  const now = kyivParts(nowMs);
  const slot = stats?.stats.checkinSlot;
  const confirmed = slot ? stats?.stats.checkinToday?.[slot]?.confirmed : false;
  const greeting =
    now.hour < 6
      ? 'Тиха ніч.'
      : now.hour < 12
        ? 'Доброго ранку.'
        : now.hour < 18
          ? 'День триває.'
          : 'Час сповільнитися.';
  const view = money ? financeView(money.finance, 7, nowMs) : null;
  const complete =
    !!view &&
    !view.unknownBalances &&
    !!money?.finance.accounts.some((account) => account.currency === 'UAH');
  const slotLabel = slot
    ? {
        morning: 'Ранковий чек-ін',
        afternoon: 'Денний чек-ін',
        evening: 'Вечірній чек-ін',
      }[slot]
    : 'Чек-ін';
  const latest = money?.finance.transactions
    .filter(
      (t) =>
        ['expense', 'income'].includes(t.kind) &&
        !t.bankMissingFromStatement &&
        Date.parse(t.at) <= nowMs,
    )
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  return (
    <div className="renewal-hero today-hero" data-night={now.hour < 6 || now.hour >= 20}>
      <PageHeading eyebrow={greeting} title="Твій день," accent="у фокусі." />
      <div className="renewal-actions today-overview">
        <div className="today-finance-card">
          <Link to="/finance" className="today-finance-main">
            <span className="renewal-eyebrow">
              Вільні кошти <span aria-hidden="true">↗</span>
            </span>
            <strong>
              <UpdatedValue
                identity="available"
                value={view && complete ? view.available : null}
                enabled={money?.finance.display?.animations !== false}
              >
                {view && complete ? moneyLabel(view.available).replace(/\s/g, ' ') : 'Мої рахунки'}
              </UpdatedValue>
            </strong>
          </Link>
          {money && view && (
            <TodayMoneySummary
              finance={money.finance}
              view={view}
              complete={complete}
              failed={finance.isError}
            />
          )}
          {money && <TodaySpendingPulse finance={money.finance} nowMs={nowMs} demo={money.demo} />}
          {latest ? (
            <Link
              className="today-last-operation"
              to={`/finance?transaction=${encodeURIComponent(latest.id)}`}
            >
              <small>
                {latest.kind === 'income' ? 'Останнє надходження' : 'Остання витрата'}
                {latest.bankHold ? ' · очікує' : ''}
              </small>
              <div>
                <span className="today-operation-description">
                  {latest.description || latest.category}
                </span>
                <TransactionAmount transaction={latest} display={money?.finance.display} />
              </div>
            </Link>
          ) : (
            <small className="text-tx3 text-xs">Рахунки та останні операції →</small>
          )}
        </div>
        <div className="today-side-stack">
          <Link
            to="/checkin"
            className="today-side-card today-checkin-card"
            aria-label={slotLabel + (confirmed ? ': підтверджено' : ': відкрити')}
          >
            <span>{confirmed ? '✓ Готово' : 'Як ти зараз?'}</span>
            <small>{slotLabel}</small>
          </Link>
          <TodayPayment
            finance={money?.finance}
            today={now.date}
            loading={finance.isLoading}
            failed={finance.isError}
          />
        </div>
      </div>
      <div className="renewal-form-grid mb-4">
        <Link className="renewal-button today-quick-action" to="/finance?action=expense">
          ＋ Записати витрату
        </Link>
        <Link className="renewal-secondary today-quick-action" to="/finance?action=personal">
          ＋ Особистий дохід
        </Link>
      </div>
      {money && money.finance.reserveMinor > 0 && (
        <Link to="/finance" className="mt-3 block text-xs text-tx2">
          Для розрахунку з парком залишити {moneyLabel(money.finance.reserveMinor)}
          {money.demo ? ' · демо' : ''} ↗
        </Link>
      )}
    </div>
  );
}
