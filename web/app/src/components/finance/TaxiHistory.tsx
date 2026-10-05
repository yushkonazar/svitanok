import { useState } from 'react';
import type { Finance } from '../../api/finance-schema.ts';
import {
  calculateTaxiWeek,
  kyivInstant,
  kyivParts,
  sumMoney,
} from '../../../../core/finance/planning.mjs';
import { moneyLabel } from '../../lib/financeView.ts';
import { Sheet } from '../ui/Sheet.tsx';
import type { FinanceFormRequest } from './FinanceForm.tsx';
export function TaxiHistory({
  finance: f,
  onClose,
  onAction,
}: {
  finance: Finance;
  onClose: () => void;
  onAction: (r: FinanceFormRequest) => void;
}) {
  const [key, setKey] = useState(
    f.taxiWeeks.find((w) => w.closed)?.key ?? f.taxiWeeks[0]?.key ?? '',
  );
  const week = f.taxiWeeks.find((w) => w.key === key);
  const calculated = week ? calculateTaxiWeek(f.taxiEntries, f.policies, kyivInstant(key)) : null;
  const settlement = f.settlements.find((s) => s.weekKey === key);
  const expected = settlement?.expectedMinor ?? week?.settlementMinor ?? 0;
  const total = (field: 'commissionMinor' | 'fuelMinor' | 'tipsMinor') =>
    sumMoney(calculated?.entries.map((e) => e[field]) ?? []);
  const metrics: [string, number][] =
    calculated && week
      ? [
          ['Чиста каса · після комісії', calculated.netCashMinor],
          ['Брудна каса · до комісії', calculated.grossMinor],
          ['Комісія · повна сума', total('commissionMinor')],
          ['Пальне · повна сума', total('fuelMinor')],
          ['Чайові в застосунку · до поділу', total('tipsMinor')],
          ['Твій заробіток за формулою', calculated.earnedMinor],
          ['Отримана готівка мінус власні робочі оплати', week.heldMinor],
        ]
      : [];
  return (
    <Sheet
      label="Історія перезмінок"
      onClose={onClose}
      resetKey={f.taxiWeeks.findIndex((w) => w.key === key)}
    >
      <div className="renewal-finance flex flex-col gap-4">
        <div className="renewal-section-head">
          <h2 className="text-xl font-bold">Історія перезмінок</h2>
          <button className="renewal-secondary" onClick={onClose} aria-label="Закрити">
            ×
          </button>
        </div>
        {!week ? (
          <p className="renewal-muted">Історія з’явиться після першої записаної зміни.</p>
        ) : (
          <>
            <label className="renewal-field">
              Робочий тиждень
              <select value={key} onChange={(e) => setKey(e.target.value)}>
                {f.taxiWeeks.map((w) => (
                  <option key={w.key} value={w.key}>
                    {w.key} ·{' '}
                    {w.settled ? 'розраховано' : w.closed ? 'очікує розрахунку' : 'триває'}
                  </option>
                ))}
              </select>
            </label>
            <p className="renewal-chart-note">
              Від понеділка о 13:00 до наступного понеділка о 13:00, Київ. Історія зберігається
              після початку нового тижня.
            </p>
            {!week.complete && (
              <p className="renewal-inset text-neg">
                Розрахунок попередній: у змінах бракує комісії або отриманої готівки.
              </p>
            )}
            <div className="renewal-metrics">
              {metrics.map(([label, value]) => (
                <div className="renewal-metric" key={label}>
                  <span className="renewal-muted">{label}</span>
                  <strong>{moneyLabel(value)}</strong>
                </div>
              ))}
            </div>
            <div className="renewal-inset flex flex-col gap-3">
              <b>
                {expected < 0 ? 'За формулою повернути парку' : 'За формулою отримати від парку'}:{' '}
                {moneyLabel(Math.abs(expected))}
              </b>
              {settlement ? (
                <>
                  <b>
                    Фактично {settlement.amountMinor < 0 ? 'віддав' : 'отримав'}:{' '}
                    {moneyLabel(Math.abs(settlement.amountMinor))}
                  </b>
                  <span className="renewal-muted">
                    Різниця для твоїх коштів: {moneyLabel(settlement.amountMinor - expected)}. Мінус
                    — сплатив більше або отримав менше.
                  </span>
                  <span className="renewal-chart-note">
                    Розраховано {kyivParts(Date.parse(settlement.at)).date}
                    {settlement.note ? ` · ${settlement.note}` : ''}
                  </span>
                  {!settlement.transactionId && (
                    <button
                      className="renewal-secondary"
                      onClick={() => onAction({ kind: 'taxi-settlement-edit', id: key })}
                    >
                      Уточнити фактичну сплату
                    </button>
                  )}
                </>
              ) : week.closed && week.complete ? (
                <button
                  className="renewal-button"
                  onClick={() => onAction({ kind: 'taxi-settle', id: key })}
                >
                  Розрахуватись
                </button>
              ) : (
                <p className="renewal-muted">
                  {week.closed
                    ? 'Доповни зміни перед розрахунком.'
                    : 'Розрахунок відкриється після закінчення робочого тижня.'}
                </p>
              )}
            </div>
            <details className="renewal-inset">
              <summary className="renewal-link cursor-pointer">Як пораховано заробіток</summary>
              <div className="flex flex-col gap-3 mt-3">
                {calculated?.groups.map((g) => (
                  <p key={g.policyId} className="renewal-muted">
                    {g.fareBps / 100}% × {moneyLabel(g.grossMinor)} каси −{' '}
                    {moneyLabel(g.commissionMinor)} частки комісії − {moneyLabel(g.fuelMinor)}{' '}
                    частки пального + {moneyLabel(g.extrasMinor)} частки чайових та інших надходжень
                    = {moneyLabel(g.earnedMinor)}.
                  </p>
                ))}
              </div>
            </details>
            <h3 className="font-bold">Записи цього тижня · {calculated?.entries.length}</h3>
            {calculated?.entries.map((e) => (
              <div className="renewal-inset flex flex-col gap-2" key={e.id}>
                <b>
                  {new Date(e.at).toLocaleString('uk-UA', {
                    timeZone: 'Europe/Kyiv',
                    day: 'numeric',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </b>
                <p className="renewal-muted">
                  Чиста каса {moneyLabel(e.netCashMinor)} · комісія{' '}
                  {e.commissionReported ? moneyLabel(e.commissionMinor) : 'не вказана'} · пальне{' '}
                  {moneyLabel(e.fuelMinor)} · готівка{' '}
                  {e.cashReported ? moneyLabel(e.receivedCashMinor ?? 0) : 'не вказана'}.
                </p>
                {e.note && <p className="renewal-chart-note">{e.note}</p>}
                {!week.settled && (
                  <button
                    className="renewal-link text-left"
                    onClick={() => onAction({ kind: 'taxi', id: e.id })}
                  >
                    Уточнити запис
                  </button>
                )}
              </div>
            ))}
          </>
        )}
      </div>
    </Sheet>
  );
}
