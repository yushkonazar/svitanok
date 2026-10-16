import { useState } from 'react';
import type { Finance } from '../../api/finance-schema.ts';
import {
  calculateTaxiWeek,
  taxiPeriodStart,
  kyivParts,
  sumMoney,
  share,
} from '../../../../core/finance/planning.mjs';
import { moneyLabel } from '../../lib/financeView.ts';
import { taxiPeriodLabel, taxiVehicleName } from '../../lib/taxiPeriods.ts';
import { Sheet } from '../ui/Sheet.tsx';
import type { FinanceFormRequest } from './FinanceForm.tsx';
export function TaxiHistory({
  finance: f,
  onClose,
  onAction,
  initialKey,
  onSelect,
}: {
  finance: Finance;
  onClose: () => void;
  onAction: (r: FinanceFormRequest) => void;
  initialKey?: string;
  onSelect?: (key: string) => void;
}) {
  const preferred =
    f.taxiWeeks.find((w) => w.closed && !w.settled) ??
    f.taxiWeeks.find((w) => w.closed) ??
    f.taxiWeeks[0];
  const [selectedKey, setKey] = useState(initialKey ?? preferred?.key ?? '');
  const week = f.taxiWeeks.find((w) => w.key === selectedKey) ?? preferred;
  const key = week?.key ?? '';
  const act = (request: FinanceFormRequest) => {
    onSelect?.(key);
    onAction(request);
  };
  const calculated = week
    ? calculateTaxiWeek(f.taxiEntries, f.policies, taxiPeriodStart(key, f.policies))
    : null;
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
            <p className="renewal-chart-note">
              Усі періоди: {f.taxiWeeks.length}. Історія не обмежена датами аналітики.
            </p>
            <label className="renewal-field">
              Робочий період
              <select
                value={key}
                onChange={(e) => {
                  setKey(e.target.value);
                  onSelect?.(e.target.value);
                }}
              >
                {f.taxiWeeks.map((w) => (
                  <option key={w.key} value={w.key}>
                    {taxiVehicleName(taxiPeriodStart(w.key, f.policies), f.policies)} ·{' '}
                    {taxiPeriodLabel(w.key, f.policies)} ·{' '}
                    {w.settled ? 'розраховано' : w.closed ? 'очікує розрахунку' : 'триває'}
                  </option>
                ))}
              </select>
            </label>
            <p className="renewal-chart-note">
              {taxiVehicleName(calculated?.from ?? Date.parse(f.generatedAt), f.policies)} ·{' '}
              {taxiPeriodLabel(key, f.policies)}, Київ. Історія зберігається після переходу на інше
              авто й нової перезмінки.
            </p>
            {!week.complete && (
              <p className="renewal-inset text-neg">
                Розрахунок попередній: у змінах бракує комісії або отриманої готівки.
              </p>
            )}
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
                      onClick={() => act({ kind: 'taxi-settlement-edit', id: key })}
                    >
                      Уточнити фактичну сплату
                    </button>
                  )}
                </>
              ) : week.closed && week.complete ? (
                <button
                  className="renewal-button"
                  onClick={() => act({ kind: 'taxi-settle', id: key })}
                >
                  Розрахуватись
                </button>
              ) : (
                <p className="renewal-muted">
                  {week.closed
                    ? 'Доповни зміни перед розрахунком.'
                    : 'Розрахунок відкриється після закінчення робочого періоду.'}
                </p>
              )}
            </div>
            <div className="renewal-metrics">
              {metrics.map(([label, value]) => (
                <div className="renewal-metric" key={label}>
                  <span className="renewal-muted">{label}</span>
                  <strong>{moneyLabel(value)}</strong>
                </div>
              ))}
            </div>
            <details className="renewal-inset">
              <summary className="renewal-link cursor-pointer">Як пораховано заробіток</summary>
              <div className="flex flex-col gap-3 mt-3">
                {calculated?.groups.map((g) => (
                  <p key={g.policyId} className="renewal-muted">
                    {g.fareBps / 100}% × {moneyLabel(g.grossMinor)} каси −{' '}
                    {moneyLabel(
                      share(
                        g.commissionMinor,
                        f.policies.find((p) => p.id === g.policyId)!.commissionBps,
                      ),
                    )}{' '}
                    частки комісії −{' '}
                    {moneyLabel(
                      share(g.fuelMinor, f.policies.find((p) => p.id === g.policyId)!.fuelBps),
                    )}{' '}
                    частки пального + {moneyLabel(g.extrasMinor)} частки чайових та інших надходжень
                    = {moneyLabel(g.earnedMinor)}.
                  </p>
                ))}
              </div>
            </details>
            <h3 className="font-bold">Записи цього періоду · {calculated?.entries.length}</h3>
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
                {e.periodKey && calculated && Date.parse(e.at) >= calculated.to && (
                  <p className="renewal-chart-note">
                    Внесено після переходу; явно враховано в цьому періоді.
                  </p>
                )}
                {!week.settled && (
                  <button
                    className="renewal-link text-left"
                    onClick={() => act({ kind: 'taxi', id: e.id })}
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
