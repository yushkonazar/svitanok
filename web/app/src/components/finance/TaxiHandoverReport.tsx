import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { sumMoney } from '../../../../core/finance/planning.mjs';
import { moneyLabel } from '../../lib/financeView.ts';
import type { TaxiHandover } from '../../lib/taxiHandover.ts';
import { taxiDayLabel, taxiRangeLabel } from '../../lib/taxiPeriods.ts';
import { counted, percentLabel } from './analytics-format.ts';

const signed = (minor: number) => (minor > 0 ? '+' : '') + moneyLabel(minor);
const dayValue = (report: TaxiHandover, day: TaxiHandover['days'][number]) =>
  day.earnedMinor === null
    ? day.planned || report.plannedDays === null
      ? 'Без запису'
      : 'Поза планом'
    : moneyLabel(day.earnedMinor);

export function TaxiHandoverReport({
  report,
  reveal = false,
  onResolve,
}: {
  report: TaxiHandover;
  reveal?: boolean;
  onResolve?: () => void;
}) {
  const root = useRef<HTMLElement>(null);
  const [date, select] = useState<string | null>(null);
  const active = report.days.find((day) => day.date === date) ?? report.bestDay ?? report.days[0];
  const hasPlan = report.days.some((day) => day.planMinor !== null);
  const max = Math.max(
    1,
    ...report.days.flatMap((day) => [Math.abs(day.earnedMinor ?? 0), day.planMinor ?? 0]),
  );
  const goal = report.targetMinor;
  const percent = goal === null ? null : (100 * report.earnedMinor) / goal;
  const achieved = !report.provisional && goal !== null && report.earnedMinor >= goal;
  useEffect(() => {
    const element = root.current;
    if (!reveal || !element) return;
    const key = `svitanok.finance.handover.${report.key}`;
    const show = () => {
      try {
        if (sessionStorage.getItem(key)) return;
        sessionStorage.setItem(key, 'shown');
      } catch {
        // The report works with unavailable browser storage.
      }
      element.dataset.reveal = 'true';
    };
    if (typeof IntersectionObserver === 'undefined') {
      show();
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        show();
        observer.disconnect();
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [report.key, reveal]);

  return (
    <section
      ref={root}
      className="taxi-handover"
      data-achieved={achieved}
      aria-label="Підсумок перезмінки"
    >
      <header className="taxi-handover-heading">
        <div>
          <p className="renewal-eyebrow">ПЕРЕЗМІНКУ ЗАВЕРШЕНО</p>
          <h3>Підсумок · {report.vehicle}</h3>
          <p className="renewal-chart-note">{taxiRangeLabel(report.from, report.to)}</p>
        </div>
        <span className="taxi-handover-icon" aria-hidden="true">
          {achieved ? '✓' : '↗'}
        </span>
      </header>
      <div className="taxi-handover-result">
        <div className="taxi-work-row" aria-live="polite">
          <span>{report.provisional ? 'Заробіток за записами' : 'Твій заробіток'}</span>
          <strong>{moneyLabel(report.earnedMinor)}</strong>
        </div>
        {percent !== null && (
          <>
            <div
              className="renewal-progress"
              role="progressbar"
              aria-label="Підсумок цілі"
              aria-valuenow={Math.round(Math.max(0, Math.min(100, percent)))}
              aria-valuetext={`${percentLabel(percent)} від цілі`}
            >
              <span style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
            </div>
            <p className="taxi-handover-verdict">
              {achieved ? 'Ціль досягнуто' : `${percentLabel(percent)} від цілі`}
              {' · '}
              {goal !== null && moneyLabel(goal)}
              {achieved && goal !== null && report.earnedMinor > goal && (
                <> · {signed(report.earnedMinor - goal)} понад ціль</>
              )}
              {goal !== null && report.earnedMinor < goal && (
                <> · бракує {moneyLabel(goal - report.earnedMinor)}</>
              )}
            </p>
          </>
        )}
        {report.provisional && (
          <p className="renewal-chart-note">
            {report.entries.length
              ? 'Підсумок попередній · перевір відкриті зміни й комісію.'
              : 'За період ще немає записаних змін.'}
          </p>
        )}
      </div>
      <div className="taxi-handover-trend">
        <div className="taxi-work-row">
          <span>По днях · заробіток</span>
          <small>{counted(report.workedDays, 'робочий день', 'робочі дні', 'робочих днів')}</small>
        </div>
        <div
          className="taxi-handover-bars"
          role="group"
          aria-label="Заробіток за датами"
          style={{ '--taxi-days': report.days.length } as CSSProperties}
        >
          {report.days.map((day) => (
            <button
              type="button"
              key={day.date}
              aria-pressed={day.date === active?.date}
              aria-label={`${taxiDayLabel(day)} · ${dayValue(report, day)}`}
              onClick={() => select(day.date)}
            >
              <span className="taxi-handover-column" aria-hidden="true">
                {day.planMinor !== null && (
                  <i
                    className="taxi-handover-plan-bar"
                    style={{ height: `${(100 * day.planMinor) / max}%` }}
                  />
                )}
                <i
                  className="taxi-handover-actual-bar"
                  data-negative={(day.earnedMinor ?? 0) < 0}
                  style={{
                    height: `${Math.max(4, (100 * Math.abs(day.earnedMinor ?? 0)) / max)}%`,
                  }}
                  data-empty={day.earnedMinor === null}
                />
              </span>
              <small>{day.date.slice(8)}</small>
            </button>
          ))}
        </div>
        {active && (
          <div className="taxi-work-row taxi-handover-day" aria-live="polite">
            <span>{taxiDayLabel(active)}</span>
            <b>{dayValue(report, active)}</b>
            {active.planMinor !== null && (
              <small>Початковий план · {moneyLabel(active.planMinor)}</small>
            )}
          </div>
        )}
        {hasPlan && (
          <p className="renewal-chart-note">Контур · початковий план. Колір · факт за записами.</p>
        )}
        {report.previousDayDelta !== null && (
          <p className="taxi-handover-delta" data-direction={Math.sign(report.previousDayDelta)}>
            {signed(report.previousDayDelta)} за робочий день до минулої
            {report.previousVehicle !== report.vehicle && ' · інше авто'}
          </p>
        )}
      </div>
      <details className="taxi-work-fold">
        <summary>Деталі звіту</summary>
        <div className="taxi-work-fold-body">
          <dl className="taxi-work-ledger">
            <dt>Чиста каса</dt>
            <dd className="taxi-net-cash">{moneyLabel(report.netCashMinor)}</dd>
            <dt>Каса до комісії</dt>
            <dd>{moneyLabel(report.grossMinor)}</dd>
            <dt>Повна комісія</dt>
            <dd>{moneyLabel(sumMoney(report.entries.map((entry) => entry.commissionMinor)))}</dd>
            <dt>Пальне</dt>
            <dd>{moneyLabel(sumMoney(report.entries.map((entry) => entry.fuelMinor)))}</dd>
            <dt>Чайові до поділу</dt>
            <dd>{moneyLabel(sumMoney(report.entries.map((entry) => entry.tipsMinor)))}</dd>
            {report.canSettle && (
              <>
                <dt>Готівка після робочих оплат</dt>
                <dd>{moneyLabel(report.heldMinor)}</dd>
              </>
            )}
            {report.plannedDays !== null && (
              <>
                <dt>Заплановано / відпрацьовано</dt>
                <dd>
                  {report.plannedDays} / {report.workedDays}
                </dd>
              </>
            )}
          </dl>
          {report.previousNetDelta !== null && (
            <p>Чиста каса за день · {signed(report.previousNetDelta)} до минулої</p>
          )}
          {report.originalDays !== null && report.originalDays !== report.plannedDays && (
            <p>Робочих дат на старті · {report.originalDays}</p>
          )}
          {report.bestDay && report.bestDay.earnedMinor !== null && (
            <p>
              Найбільший внесок · {taxiDayLabel(report.bestDay)} ·{' '}
              {moneyLabel(report.bestDay.earnedMinor)}
            </p>
          )}
          {report.missingDays > 0 && (
            <p>
              {counted(
                report.missingDays,
                'запланований день',
                'заплановані дні',
                'запланованих днів',
              )}{' '}
              без запису.
            </p>
          )}
          {report.originalTarget !== null && report.originalTarget !== goal && (
            <p>Початкова ціль · {moneyLabel(report.originalTarget)}</p>
          )}
          {report.lateMinor !== 0 && (
            <p>Записи після межі перезмінки · {signed(report.lateMinor)}</p>
          )}
        </div>
      </details>
      {onResolve && report.entries.length > 0 && (
        <div className="taxi-handover-settlement">
          {report.settlement ? (
            <span className="text-pos">✓ Розрахунок із парком підтверджено</span>
          ) : (
            <>
              <div className="taxi-work-row">
                <span>
                  {report.canSettle ? 'Розрахунок із парком' : 'Уточнити дані для розрахунку'}
                </span>
                {report.canSettle && (
                  <b>
                    {report.settlementMinor === 0
                      ? 'Збалансовано'
                      : `${report.settlementMinor < 0 ? 'Повернути' : 'Отримати'} ${moneyLabel(Math.abs(report.settlementMinor))}`}
                  </b>
                )}
              </div>
              <button type="button" className="renewal-secondary w-full" onClick={onResolve}>
                {report.canSettle ? 'Підтвердити оплату перезмінки' : 'Доповнити записи періоду'}
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}
