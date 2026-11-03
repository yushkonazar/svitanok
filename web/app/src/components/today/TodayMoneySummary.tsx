import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Finance } from '../../api/finance-schema.ts';
import { financeView, moneyLabel } from '../../lib/financeView.ts';
import { sumMoney } from '../../../../core/finance/planning.mjs';
import { Sheet } from '../ui/Sheet.tsx';
import { UpdatedValue } from '../ui/UpdatedValue.tsx';

type View = ReturnType<typeof financeView>;
export function TodayMoneySummary({
  finance,
  view,
  complete,
  failed = false,
}: {
  finance: Finance;
  view: View;
  complete: boolean;
  failed?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const enabled = finance.display?.animations !== false;
  const foreign = [
    ...new Set(finance.accounts.filter((a) => a.currency !== 'UAH').map((a) => a.currency)),
  ];
  const goals = finance.goals
    .map((goal) => ({
      ...goal,
      saved: sumMoney(
        finance.goalMoves.filter((move) => move.goalId === goal.id).map((move) => move.amountMinor),
      ),
    }))
    .filter((goal) => goal.saved !== 0);
  const otherGoals = sumMoney([view.savings, -sumMoney(goals.map((goal) => goal.saved))]);
  return (
    <>
      <button
        type="button"
        className="today-money-summary"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        aria-label={
          'У цілях ' +
          moneyLabel(view.savings) +
          '. Разом у гривні ' +
          (complete ? moneyLabel(view.totalWithSavings) : 'потрібно уточнити залишки') +
          '. Відкрити підсумок'
        }
      >
        <span>
          <span>У цілях</span>
          <b>
            <UpdatedValue identity="savings" value={view.savings} enabled={enabled}>
              {moneyLabel(view.savings).replace(/\s/g, ' ')}
            </UpdatedValue>
          </b>
        </span>
        <span>
          <span>
            {foreign.length ? 'Разом у ₴' : 'Разом'} <i aria-hidden="true">↗</i>
          </span>
          <b>
            <UpdatedValue
              identity="total-with-savings"
              value={complete ? view.totalWithSavings : null}
              enabled={enabled}
            >
              {complete ? moneyLabel(view.totalWithSavings).replace(/\s/g, ' ') : '—'}
            </UpdatedValue>
          </b>
        </span>
      </button>
      {open && (
        <Sheet label="Мої кошти" onClose={() => setOpen(false)}>
          <div className="today-money-detail">
            <div className="renewal-section-head">
              <h2 className="text-xl font-bold">Мої кошти</h2>
              <button
                type="button"
                className="renewal-secondary"
                aria-label="Закрити підсумок"
                onClick={() => setOpen(false)}
              >
                ×
              </button>
            </div>
            <p className="renewal-chart-note mt-3">
              Разом у гривні — вільні кошти та всі заощадження в цілях.
            </p>
            <dl className="today-money-formula">
              <div>
                <dt>Вільні кошти</dt>
                <dd>{complete ? moneyLabel(view.available) : 'Потрібні залишки'}</dd>
              </div>
              <div>
                <dt>У цілях</dt>
                <dd>{moneyLabel(view.savings)}</dd>
              </div>
              <div className="today-money-total">
                <dt>Разом у гривні</dt>
                <dd>{complete ? moneyLabel(view.totalWithSavings) : '—'}</dd>
              </div>
            </dl>
            {!complete && (
              <p className="renewal-inset mt-3">
                {(!finance.accounts.some((account) => account.currency === 'UAH') ||
                  finance.accounts.some(
                    (account) => account.currency === 'UAH' && account.balanceMinor == null,
                  )) &&
                  'Для загальної суми потрібно підтвердити гривневі залишки. '}
                {finance.taxiWeeks.some((week) => !week.settled && !week.complete) &&
                  'Заверши облік нерозрахованих змін таксі, щоб уточнити підсумок.'}
              </p>
            )}
            {goals.length > 0 || otherGoals !== 0 ? (
              <div className="mt-5">
                <h3 className="text-sm font-semibold mb-2">Заощадження за цілями</h3>
                {goals.map((goal) => (
                  <div className="today-goal-saving" key={goal.id}>
                    <span>{goal.name}</span>
                    <b>{moneyLabel(goal.saved)}</b>
                  </div>
                ))}
                {otherGoals !== 0 && (
                  <div className="today-goal-saving">
                    <span>Інші цілі</span>
                    <b>{moneyLabel(otherGoals)}</b>
                  </div>
                )}
              </div>
            ) : (
              <p className="renewal-chart-note mt-4">Внесків у цілі ще немає.</p>
            )}
            <p className="renewal-chart-note mt-4">
              У цілях: {moneyLabel(view.allocated)} зарезервовано на рахунках і{' '}
              {moneyLabel(view.externalSavings)} переказано окремо. Резерви вже входять до залишків
              рахунків; у підсумку кожна сума врахована один раз.
            </p>
            {finance.reserveMinor > 0 && (
              <p className="renewal-chart-note mt-2">
                Для розрахунку з парком виділено {moneyLabel(finance.reserveMinor)}.
              </p>
            )}
            {foreign.length > 0 && (
              <div className="mt-5">
                <h3 className="text-sm font-semibold">Інші валюти окремо</h3>
                {foreign.map((currency) => {
                  const accounts = finance.accounts.filter(
                    (account) => account.currency === currency,
                  );
                  const known = accounts.every((account) => account.balanceMinor != null);
                  return (
                    <div key={currency} className="today-goal-saving">
                      <span>{currency}</span>
                      <b>
                        {known
                          ? moneyLabel(
                              sumMoney(accounts.map((account) => account.balanceMinor!)),
                              currency,
                            )
                          : 'Потрібні залишки'}
                      </b>
                    </div>
                  );
                })}
              </div>
            )}
            {failed && (
              <p role="status" className="renewal-chart-note mt-4">
                Не вдалося оновити. Показані збережені залишки.
              </p>
            )}
            <Link className="renewal-link inline-block mt-5" to="/finance?analytics=goals">
              Мої цілі →
            </Link>
          </div>
        </Sheet>
      )}
    </>
  );
}
