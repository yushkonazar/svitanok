import { useState } from 'react';
import { TAXI_COMMISSION_BPS } from '../../../../core/finance/planning.mjs';
import { moneyLabel } from '../../lib/financeView.ts';
import type { TaxiCashPlan } from '../../lib/taxiCashPlan.ts';
import type { TaxiWork } from '../../lib/taxiWork.ts';
import { taxiDayLabel } from '../../lib/taxiPeriods.ts';
import { UpdatedValue } from '../ui/UpdatedValue.tsx';
import { amountNumber, counted, financeDay } from './analytics-format.ts';

type CalendarDay = TaxiCashPlan['calendar'][number];
const weekday = new Intl.DateTimeFormat('uk-UA', { weekday: 'short', timeZone: 'Europe/Kyiv' });

function dayState(day: CalendarDay, now: number, confirmed: boolean) {
  if (day.worked || day.earnedMinor !== null) {
    if (!day.planned) return 'Позапланова робота';
    if (day.worked && day.complete && !day.commissionKnown) return 'Уточнити комісію';
    if (day.worked && day.complete && day.commissionKnown) return 'Завершено';
    return day.to > now ? 'У роботі' : 'За записами';
  }
  if (!day.planned) return confirmed ? 'Вихідний' : 'Поза планом';
  if (day.to <= now) return 'Без запису';
  return day.from <= now ? 'Робочий день' : 'Заплановано';
}

export function TaxiTodayPlan({
  work,
  plan,
  animations,
}: {
  work: TaxiWork;
  plan: TaxiCashPlan;
  animations: boolean;
}) {
  const { today, daily } = plan;
  if (!today || work.targetMinor === null) return null;
  const next = plan.slots.find((day) => day.date !== today.date);
  const confirmed = Boolean(work.planSettings.taxiSchedules?.[work.current.key]);
  return (
    <section className="taxi-day-focus" aria-label="План на сьогодні">
      <div className="taxi-work-row">
        <span className="renewal-eyebrow">СЬОГОДНІ · {taxiDayLabel(today)}</span>
        <span className="taxi-day-state">{dayState(today, work.now, confirmed)}</span>
      </div>
      {daily ? (
        <>
          <div className="taxi-work-row taxi-day-amount">
            <span>{daily.remainingMinor > 0 ? 'Ще сьогодні' : 'Денний план виконано'}</span>
            {daily.remainingMinor > 0 && (
              <strong>
                <UpdatedValue
                  value={daily.remainingMinor}
                  identity={today.date}
                  enabled={animations}
                >
                  {moneyLabel(daily.remainingMinor)}
                </UpdatedValue>
              </strong>
            )}
          </div>
          {daily.cash && daily.cash.grossMinor > 0 && (
            <div className="taxi-day-cash">
              <span>
                Чиста каса <b>{moneyLabel(daily.cash.netMinor)}</b>
              </span>
              <span>
                До комісії <b>{moneyLabel(daily.cash.grossMinor)}</b>
              </span>
            </div>
          )}
          {daily.remainingMinor > 0 && (!work.hasCommission || !plan.fuelKnown) && (
            <p className="renewal-chart-note">Орієнтир за доступними записами.</p>
          )}
        </>
      ) : (
        today.earnedMinor !== null && (
          <div className="taxi-work-row taxi-day-amount">
            <span>Заробіток сьогодні</span>
            <strong>{moneyLabel(today.earnedMinor)}</strong>
          </div>
        )
      )}
      {next ? (
        <p className="renewal-chart-note">Далі в роботі · {taxiDayLabel(next)}</p>
      ) : !daily && work.remainingMinor !== null && work.remainingMinor > 0 ? (
        <p className="renewal-chart-note">Робочі дати цього плану вичерпано.</p>
      ) : null}
    </section>
  );
}

export function TaxiPlanDetails({
  work,
  plan,
  onEdit,
}: {
  work: TaxiWork;
  plan: TaxiCashPlan;
  onEdit: (date?: string) => void;
}) {
  const [date, setDate] = useState<string | null>(null);
  const selected = plan.calendar.find((day) => day.date === date) ?? plan.today;
  const schedule = work.planSettings.taxiSchedules?.[work.current.key];
  const confirmed = Boolean(schedule);
  const rows = [
    { label: 'Уся перезмінка', cash: plan.projectedCash },
    { label: 'Ще потрібно за період', cash: work.current.grossMinor > 0 ? plan.plannedCash : null },
    { label: 'День перезмінки', cash: plan.today?.handover ? null : plan.handoverCash },
  ];
  return (
    <details className="taxi-work-fold">
      <summary>Календар і план каси</summary>
      <div className="taxi-work-fold-body taxi-cash-plan">
        <div className="taxi-calendar" role="group" aria-label="Дати перезмінки">
          {plan.calendar.map((day) => (
            <button
              key={day.date}
              type="button"
              aria-pressed={selected?.date === day.date}
              aria-current={plan.today?.date === day.date ? 'date' : undefined}
              aria-label={`${taxiDayLabel(day)} · ${dayState(day, work.now, confirmed)}`}
              data-planned={day.planned}
              data-worked={day.worked}
              onClick={() => setDate(day.date)}
            >
              <small>{weekday.format(day.from)}</small>
              <b>{financeDay(day.date)}</b>
              <span className="taxi-calendar-mark" aria-hidden="true">
                {day.worked
                  ? day.complete
                    ? '✓'
                    : '◐'
                  : day.planned
                    ? day.locked
                      ? '!'
                      : '•'
                    : '–'}
              </span>
            </button>
          ))}
        </div>
        {selected && (
          <div className="taxi-work-row taxi-calendar-detail" aria-live="polite">
            <span>
              {taxiDayLabel(selected)} · {dayState(selected, work.now, confirmed)}
            </span>
            {selected.earnedMinor !== null && <b>{moneyLabel(selected.earnedMinor)}</b>}
            {schedule && schedule.originalDates.includes(selected.date) !== selected.planned && (
              <small>Дату змінено після старту</small>
            )}
          </div>
        )}
        <button
          type="button"
          className="renewal-link"
          onClick={() => onEdit(selected && !selected.locked ? selected.date : undefined)}
        >
          {confirmed ? 'Змінити робочі дати ↗' : 'Підтвердити робочі дати ↗'}
        </button>
        {plan.plannedCash && (
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
              Комісія сервісу {TAXI_COMMISSION_BPS / 100}% ·{' '}
              {plan.fuelKnown
                ? `пальне за період ≈ ${moneyLabel(plan.fuelMinor)}`
                : 'пальне потребує оцінки'}
            </p>
          </>
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
          {taxiDayLabel(next)} ·{' '}
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
        {!plan.daily && plan.firstTargetMinor !== null && plan.firstTargetMinor > 0 && (
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
