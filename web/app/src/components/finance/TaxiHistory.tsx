import { financeDay, financeTime, percentLabel } from './analytics-format.ts';
import { useState } from 'react';
import type { Finance } from '../../api/finance-schema.ts';
import {
  calculateTaxiWeek,
  taxiPeriodStart,
  kyivParts,
  sumMoney,
  share,
  taxiWeek,
} from '../../../../core/finance/planning.mjs';
import { moneyLabel } from '../../lib/financeView.ts';
import { taxiPeriodLabel, taxiVehicleName } from '../../lib/taxiPeriods.ts';
import { taxiHandover } from '../../lib/taxiHandover.ts';
import { useTick } from '../../lib/useTick.ts';
import { Sheet } from './FinanceSheet.tsx';
import { TaxiHandoverReport } from './TaxiHandoverReport.tsx';
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
  const now = Math.max(useTick(30_000), Date.parse(f.generatedAt) || 0);
  const known = new Set(f.taxiWeeks.map((week) => week.key));
  const plans = new Set([
    ...Object.keys(f.forecast.taxiTargets ?? {}),
    ...Object.keys(f.forecast.taxiSchedules ?? {}),
  ]);
  const planOnly = [...plans].flatMap((key) => {
    if (known.has(key)) return [];
    try {
      const period = taxiWeek(taxiPeriodStart(key, f.policies), f.policies);
      return period.to <= now
        ? [
            {
              ...period,
              closed: true,
              complete: false,
              settled: false,
              grossMinor: 0,
              earnedMinor: 0,
              heldMinor: 0,
              settlementMinor: 0,
            },
          ]
        : [];
    } catch {
      // A schedule change can remove a future period that had been planned.
      return [];
    }
  });
  const weeks = [...f.taxiWeeks, ...planOnly].sort(
    (a, b) => taxiPeriodStart(b.key, f.policies) - taxiPeriodStart(a.key, f.policies),
  );
  const closed = (week: Finance['taxiWeeks'][number]) =>
    week.closed || (week.to !== undefined && week.to <= now);
  const preferred =
    weeks.find((w) => known.has(w.key) && closed(w) && !w.settled) ??
    weeks.find(closed) ??
    weeks[0];
  const [selectedKey, setKey] = useState(initialKey ?? preferred?.key ?? '');
  const week = weeks.find((w) => w.key === selectedKey) ?? preferred;
  const key = week?.key ?? '';
  const act = (request: FinanceFormRequest) => {
    onSelect?.(key);
    onAction(request);
  };
  const calculated = week
    ? calculateTaxiWeek(f.taxiEntries, f.policies, taxiPeriodStart(key, f.policies))
    : null;
  const settlement = f.settlements.find((s) => s.weekKey === key);
  const report = week && closed(week) ? taxiHandover(f, key, now) : null;
  const hasEntries = Boolean(calculated?.entries.length);
  const expected = settlement?.expectedMinor ?? week?.settlementMinor ?? 0;
  const target = f.forecast.taxiTargets?.[key];
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
      resetKey={weeks.findIndex((w) => w.key === key)}
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
            <p className="renewal-chart-note">Періодів в історії · {weeks.length}</p>
            <label className="renewal-field">
              Робочий період
              <select
                value={key}
                onChange={(e) => {
                  setKey(e.target.value);
                  onSelect?.(e.target.value);
                }}
              >
                {weeks.map((w) => (
                  <option key={w.key} value={w.key}>
                    {financeDay(kyivParts(taxiPeriodStart(w.key, f.policies)).date)}{' '}
                    {new Date(taxiPeriodStart(w.key, f.policies)).toLocaleTimeString('uk-UA', {
                      timeZone: 'Europe/Kyiv',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                    {w.to ? ` → ${financeDay(kyivParts(w.to).date)}` : ''} ·{' '}
                    {w.settled
                      ? 'розраховано'
                      : closed(w)
                        ? known.has(w.key)
                          ? 'завершено'
                          : 'план'
                        : 'триває'}
                  </option>
                ))}
              </select>
            </label>
            {report ? (
              <TaxiHandoverReport key={`history-${key}`} report={report} />
            ) : (
              <p className="renewal-chart-note">
                {taxiVehicleName(calculated?.from ?? Date.parse(f.generatedAt), f.policies)} ·{' '}
                {taxiPeriodLabel(key, f.policies)}, Київ.
              </p>
            )}
            {hasEntries && !week.complete && (
              <p className="renewal-inset text-neg">
                Розрахунок попередній: у змінах бракує комісії або отриманої готівки.
              </p>
            )}
            {hasEntries && (
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
                    <span
                      className={
                        settlement.amountMinor - expected < 0
                          ? 'finance-context-note text-neg'
                          : 'finance-context-note text-pos'
                      }
                    >
                      Різниця для твоїх коштів: {moneyLabel(settlement.amountMinor - expected)}.
                      Мінус — сплатив більше або отримав менше.
                    </span>
                    <span className="renewal-chart-note">
                      Розраховано {financeTime(settlement.at)}
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
                ) : closed(week) && week.complete ? (
                  <button
                    className="renewal-button"
                    onClick={() => act({ kind: 'taxi-settle', id: key })}
                  >
                    Розрахуватись
                  </button>
                ) : (
                  <p className="renewal-muted">
                    {closed(week)
                      ? 'Доповни зміни перед розрахунком.'
                      : 'Розрахунок відкриється після закінчення робочого періоду.'}
                  </p>
                )}
              </div>
            )}
            {!report && (
              <div className="renewal-metrics">
                {metrics.map(([label, value]) => (
                  <div className="renewal-metric" key={label}>
                    <span className="renewal-muted">{label}</span>
                    <strong>{moneyLabel(value)}</strong>
                  </div>
                ))}
              </div>
            )}
            {!report && target && (
              <p className="renewal-inset">
                Ціль перезмінки · <b>{moneyLabel(target)}</b>
                {calculated?.entries.every((entry) => entry.commissionReported !== false) && (
                  <> · {percentLabel(((calculated?.earnedMinor ?? 0) / target) * 100)} виконано</>
                )}
              </p>
            )}
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
