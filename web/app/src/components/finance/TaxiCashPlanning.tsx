import { useState } from 'react';
import { TAXI_COMMISSION_BPS } from '../../../../core/finance/planning.mjs';
import { moneyLabel } from '../../lib/financeView.ts';
import type { TaxiCashPlan } from '../../lib/taxiCashPlan.ts';
import type { TaxiWork } from '../../lib/taxiWork.ts';
import { amountNumber, counted } from './analytics-format.ts';

const dayLabel = new Intl.DateTimeFormat('uk-UA', {
  weekday: 'short',
  day: 'numeric',
  month: 'numeric',
  timeZone: 'Europe/Kyiv',
});
const timeLabel = new Intl.DateTimeFormat('uk-UA', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'Europe/Kyiv',
});
const plannedDate = (slot: TaxiCashPlan['slots'][number]) =>
  dayLabel.format(slot.from) + (slot.handover ? ` до ${timeLabel.format(slot.to)}` : '');

export function TaxiPlanDetails({
  work,
  plan,
  workdays,
  onWorkdays,
  onSave,
}: {
  work: TaxiWork;
  plan: TaxiCashPlan;
  workdays: 5 | 6 | 7;
  onWorkdays: (days: 5 | 6 | 7) => void;
  onSave: () => void;
}) {
  const rows = [
    { label: 'Уся перезмінка', cash: plan.projectedCash },
    {
      label: 'Ще потрібно',
      cash: work.current.grossMinor > 0 ? plan.plannedCash : null,
    },
    {
      label: 'Повний день',
      cash: plan.slots.some((slot) => !slot.handover) ? plan.fullDay : null,
    },
    {
      label: `До ${timeLabel.format(work.current.to)} у день перезмінки`,
      cash: plan.handoverCash,
    },
  ];
  return (
    <details className="taxi-work-fold">
      <summary>План каси до цілі</summary>
      <div className="taxi-work-fold-body taxi-cash-plan">
        <p>Робочі дні до дня перезмінки</p>
        <div
          className="renewal-segments taxi-plan-options"
          role="group"
          aria-label="Робочі дні до дня перезмінки"
        >
          {([5, 6, 7] as const).map((days) => (
            <button
              type="button"
              key={days}
              aria-pressed={workdays === days}
              onClick={() => onWorkdays(days)}
            >
              {days} днів
            </button>
          ))}
        </div>
        <p className="renewal-chart-note">
          Комісія сервісу {TAXI_COMMISSION_BPS / 100}% · час у день перезмінки враховано окремо
        </p>
        {plan.slots.length > 0 && (
          <div className="taxi-plan-dates" aria-label="Доступні дні в плані">
            {plan.slots.map((slot) => (
              <span key={slot.date}>{plannedDate(slot)}</span>
            ))}
          </div>
        )}
        {work.targetMinor === null ? (
          <p>Задай бажаний чистий заробіток, щоб побачити план каси.</p>
        ) : plan.plannedCash ? (
          <>
            <table className="taxi-data-table" aria-label="Потрібна каса до цілі">
              <thead>
                <tr>
                  <th scope="col">Орієнтир, ₴</th>
                  <th scope="col">Чиста</th>
                  <th scope="col">До комісії</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(
                  ({ label, cash }) =>
                    cash && (
                      <tr key={label}>
                        <th scope="row">{label}</th>
                        <td>{amountNumber(cash.netMinor)}</td>
                        <td>{amountNumber(cash.grossMinor)}</td>
                      </tr>
                    ),
                )}
              </tbody>
            </table>
            <p className="renewal-chart-note">
              {plan.fuelKnown
                ? `Пальне за період · ≈ ${moneyLabel(plan.fuelMinor)}${plan.fuelLeftMinor > 0 ? ` · ще ${moneyLabel(plan.fuelLeftMinor)}` : ''}`
                : 'Мінімальна каса до уточнення прогнозу пального.'}
            </p>
            {!work.hasCommission && (
              <p className="renewal-chart-note">
                Каса за період попередня · у записах бракує комісії.
              </p>
            )}
          </>
        ) : (
          <p>
            {plan.slots.length
              ? 'За чинними ставками потрібну касу для цієї цілі розрахувати не вдалося.'
              : 'Доступні робочі дні за цим планом вичерпано.'}
          </p>
        )}
        {(workdays !== work.workdays || work.targetMinor === null) && (
          <button type="button" className="renewal-link" onClick={onSave}>
            {work.targetMinor === null ? 'Задати ціль і дні' : 'Застосувати робочі дні'}
          </button>
        )}
      </div>
    </details>
  );
}

export function TaxiNextShift({ work, plan }: { work: TaxiWork; plan: TaxiCashPlan }) {
  const [strong, setStrong] = useState(false);
  const { forecast } = plan;
  const next = plan.slots[0];
  if (!next) return null;
  if (!forecast)
    return (
      <p className="renewal-chart-note taxi-forecast-empty">
        Прогноз з’явиться після 4 завершених днів з відомою комісією на цьому авто
        {plan.samples > 0 && ` · ${plan.samples}/4`}.
      </p>
    );
  const hasStrong = forecast.strong.nextMinor > forecast.normal.nextMinor;
  const useStrong = strong && hasStrong;
  const result = useStrong ? forecast.strong : forecast.normal;
  const gap = work.targetMinor === null ? null : work.targetMinor - result.closingMinor;
  return (
    <details className="taxi-work-fold taxi-work-forecast">
      <summary>
        <span>
          {next.worked ? 'До кінця зміни' : 'Наступна зміна'} ·{' '}
          {useStrong ? 'посилений темп' : 'прогноз'}
        </span>
        <b>≈ {moneyLabel(result.nextMinor)}</b>
      </summary>
      <div className="taxi-work-fold-body">
        <p className="renewal-chart-note">
          {plannedDate(next)} ·{' '}
          {counted(plan.slots.length, 'дата в плані', 'дати в плані', 'дат у плані')}
        </p>
        {hasStrong && (
          <div
            className="renewal-segments taxi-plan-options"
            role="group"
            aria-label="Темп наступної зміни"
          >
            <button type="button" aria-pressed={!strong} onClick={() => setStrong(false)}>
              Звичний темп
            </button>
            <button type="button" aria-pressed={strong} onClick={() => setStrong(true)}>
              Посилений
            </button>
          </div>
        )}
        {plan.firstTargetMinor !== null && plan.firstTargetMinor > 0 && (
          <div className="taxi-work-row">
            <span>Потрібно за цю зміну для цілі</span>
            <b>{moneyLabel(plan.firstTargetMinor)}</b>
          </div>
        )}
        <div className="taxi-work-row">
          <span>Очікувано до перезмінки</span>
          <b>≈ {moneyLabel(result.closingMinor)}</b>
        </div>
        {gap !== null && work.hasCommission && plan.fuelKnown && (
          <p className={gap > 0 ? 'text-a2' : 'text-pos'}>
            {gap > 0
              ? `За цього темпу бракуватиме ${moneyLabel(gap)} до цілі`
              : 'Ціль у межах цього сценарію'}
          </p>
        )}
        <p className="renewal-chart-note">
          {counted(forecast.samples, 'день у вибірці', 'дні у вибірці', 'днів у вибірці')}
          {forecast.currentSamples > 0 && ` · поточна перезмінка ${forecast.currentSamples}`}
          {!plan.fuelKnown && ' · пальне ще потребує оцінки'}
        </p>
      </div>
    </details>
  );
}
