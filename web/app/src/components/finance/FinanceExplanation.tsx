import type { Finance } from '../../api/finance-schema.ts';
import { financeView, moneyLabel } from '../../lib/financeView.ts';
import { Sheet } from '../ui/Sheet.tsx';
import { calculateTaxiWeek, kyivInstant, share } from '../../../../core/finance/planning.mjs';
function TaxiFormula({ finance: f, weekKey }: { finance: Finance; weekKey: string }) {
  const taxi = calculateTaxiWeek(f.taxiEntries, f.policies, kyivInstant(weekKey));
  return (
    <details className="mt-3">
      <summary className="renewal-link cursor-pointer">Формула заробітку</summary>
      {taxi.groups.map((g) => {
        const p = f.policies.find((n) => n.id === g.policyId)!;
        return (
          <div key={g.policyId} className="renewal-chart-note mt-3">
            <p>
              Каса {moneyLabel(g.grossMinor)} × {g.fareBps / 100}% ={' '}
              {moneyLabel(share(g.grossMinor, g.fareBps))}
              {g.boosted ? ' · поріг тижня перевищено' : ''}
            </p>
            <p>
              − комісія {moneyLabel(g.commissionMinor)} × {p.commissionBps / 100}% ={' '}
              {moneyLabel(share(g.commissionMinor, p.commissionBps))}
            </p>
            <p>
              − пальне {moneyLabel(g.fuelMinor)} × {p.fuelBps / 100}% ={' '}
              {moneyLabel(share(g.fuelMinor, p.fuelBps))}
            </p>
            <p>
              + твоя частина чайових та особисті надходження зі зміни: {moneyLabel(g.extrasMinor)}
            </p>
            <p className="font-semibold mt-2">За цими умовами: {moneyLabel(g.earnedMinor)}</p>
          </div>
        );
      })}
      <p className="renewal-chart-note mt-3">
        Частки округлюються до копійки за умовами всього тижня. Швидкі особисті надходження
        обліковуються окремо й не змінюють касу парку.
      </p>
    </details>
  );
}
export function FinanceExplanation({
  finance: f,
  onClose,
}: {
  finance: Finance;
  onClose: () => void;
}) {
  const view = financeView(f, 7);
  return (
    <Sheet label="Як пораховані вільні кошти" onClose={onClose}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">Звідки ця сума?</h2>
        <button className="renewal-secondary" aria-label="Закрити пояснення" onClick={onClose}>
          ×
        </button>
      </div>
      <p className="renewal-muted mt-3">Фактичні власні залишки − резерв парку − резерви цілей.</p>
      <div className="flex flex-col gap-4 mt-5">
        {f.accounts
          .filter((a) => a.currency === 'UAH')
          .map((a) => (
            <div key={a.id} className="renewal-inset">
              <div className="flex justify-between gap-3">
                <span>{a.name}</span>
                <strong>{a.balanceMinor === null ? '—' : moneyLabel(a.balanceMinor)}</strong>
              </div>
              {a.kind === 'mono' && (
                <p className="renewal-chart-note mt-2">
                  Доступно в банку: {a.availableMinor == null ? '—' : moneyLabel(a.availableMinor)}.
                  Кредитний ліміт:{' '}
                  {a.creditLimitMinor == null ? 'не визначений' : moneyLabel(a.creditLimitMinor)}.
                  Позичені кошти виключені з власного залишку.
                </p>
              )}
            </div>
          ))}
        <div className="renewal-inset">
          <p>
            {view.unknownBalances ? 'Відомі власні залишки' : 'Разом власних коштів'}:{' '}
            <b>{moneyLabel(view.owned)}</b>
          </p>
          <p className="mt-2">
            Резерв для парку: <b>− {moneyLabel(f.reserveMinor)}</b>
          </p>
          <p className="mt-2">
            Резерви цілей: <b>− {moneyLabel(view.allocated)}</b>
          </p>
          <p className="text-lg font-semibold mt-4">
            Вільні кошти: {view.unknownBalances ? 'ще не визначені' : moneyLabel(view.available)}
          </p>
        </div>
        {view.unknownBalances && (
          <p role="status" className="renewal-chart-note">
            Розрахунок неповний: перевір кредитний ліміт, залишки рахунків і незавершені записи
            змін. Невідомі гроші не приймаються за нуль.
          </p>
        )}
        <details className="renewal-inset">
          <summary className="font-semibold cursor-pointer">Чому потрібен резерв парку?</summary>
          <p className="renewal-chart-note mt-3">
            Готівка від клієнтів уже на рахунку, але не вся є твоїм заробітком. Резерв — сума до
            повернення за ще не закритими розрахунками. Очікувана доплата не збільшує баланс до
            отримання.
          </p>
          {f.taxiWeeks
            .filter((w) => !w.settled)
            .map((w) => (
              <div key={w.key} className="renewal-inset mt-3">
                <p>
                  {w.key}: готівка {moneyLabel(w.heldMinor)}, заробіток {moneyLabel(w.earnedMinor)}
                </p>
                <p className="renewal-chart-note mt-2">
                  {w.settlementMinor < 0
                    ? `До повернення ${moneyLabel(-w.settlementMinor)}`
                    : `Очікувана доплата ${moneyLabel(w.settlementMinor)}`}
                  {w.complete ? '' : ' · попередній розрахунок'}
                </p>
                <TaxiFormula finance={f} weekKey={w.key} />
              </div>
            ))}
        </details>
        <p className="renewal-chart-note">
          Фактичні внески на цілі вже змінили залишки рахунків. Тут повторно віднімаються тільки
          резерви. Майбутні платежі показані окремим прогнозом у календарі.
        </p>
      </div>
    </Sheet>
  );
}
