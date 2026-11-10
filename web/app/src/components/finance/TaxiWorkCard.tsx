import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Finance } from '../../api/finance-schema.ts';
import { FINANCE_QUERY } from '../../api/finance-hooks.ts';
import { sumMoney } from '../../../../core/finance/planning.mjs';
import { moneyLabel } from '../../lib/financeView.ts';
import { taxiPeriodLabel, taxiRangeLabel, taxiScheduleLabel } from '../../lib/taxiPeriods.ts';
import { taxiWork } from '../../lib/taxiWork.ts';
import { taxiCashPlan } from '../../lib/taxiCashPlan.ts';
import { taxiHandover } from '../../lib/taxiHandover.ts';
import { UpdatedValue } from '../ui/UpdatedValue.tsx';
import { amountNumber, percentLabel } from './analytics-format.ts';
import type { FinanceFormRequest } from './FinanceForm.tsx';
import { TaxiWorkChart } from './TaxiWorkChart.tsx';
import { TaxiNextShift, TaxiPlanDetails, TaxiTodayPlan } from './TaxiCashPlanning.tsx';
import { TaxiHandoverReport } from './TaxiHandoverReport.tsx';
import './taxi-work.css';

export function TaxiWorkCard({
  finance,
  now,
  explanations,
  onAction,
  onHistory,
}: {
  finance: Finance;
  now: number;
  explanations: boolean;
  onAction: (request: FinanceFormRequest) => void;
  onHistory: (key: string) => void;
}) {
  const query = useQueryClient();
  const [boundaryNow, setBoundaryNow] = useState(0);
  const clock = Math.max(now, boundaryNow);
  const work = useMemo(() => taxiWork(finance, clock), [finance, clock]);
  const { current, active, targetMinor, remainingMinor, income } = work;
  const [reviewedPeriod, setReviewedPeriod] = useState<string | null>(null);
  const previousKey = work.previousPeriod.key;
  const showReport = current.entries.length === 0 && reviewedPeriod !== previousKey;
  const report = useMemo(
    () => (showReport ? taxiHandover(finance, previousKey, clock) : null),
    [finance, previousKey, clock, showReport],
  );
  const plan = useMemo(() => taxiCashPlan(work), [work]);
  useEffect(() => {
    const deadline = current.to;
    let timer: ReturnType<typeof setTimeout>;
    const until = (from: number) => Math.min(86_400_000, Math.max(0, deadline - from));
    const check = () => {
      const currentTime = Date.now();
      if (currentTime < deadline) {
        timer = setTimeout(check, until(currentTime));
        return;
      }
      setBoundaryNow(currentTime);
      void query.invalidateQueries({ queryKey: FINANCE_QUERY });
    };
    timer = setTimeout(check, until(Date.now()));
    return () => clearTimeout(timer);
  }, [current.to, query]);
  const week = finance.taxiWeeks.find((period) => period.key === current.key);
  const unpaid = finance.taxiWeeks.find(
    (period) => period.closed && !period.settled && period.key !== report?.key,
  );
  const progress = targetMinor === null ? 0 : (100 * current.earnedMinor) / targetMinor;
  const fixedHalf =
    active?.thresholdMinor === null &&
    [active.fareBps, active.commissionBps, active.fuelBps].every((rate) => rate === 5000);

  return (
    <section className="renewal-card taxi-work" aria-label="Робота · таксі">
      {report ? (
        <TaxiHandoverReport
          key={`handover-${report.key}`}
          report={report}
          reveal
          onResolve={() =>
            report.canSettle
              ? onAction({ kind: 'taxi-settle', id: report.key })
              : onHistory(report.key)
          }
        />
      ) : (
        <>
          <div className="renewal-section-head">
            <div>
              <p className="renewal-eyebrow">РОБОТА · ТАКСІ</p>
              <h2 className="text-lg font-bold">{work.vehicle}</h2>
            </div>
            {fixedHalf && <span className="taxi-work-chip">50 / 50</span>}
          </div>
          <p className="renewal-chart-note">{taxiRangeLabel(current.from, current.to)}, Київ</p>

          <div className="taxi-work-hero">
            <span className="renewal-muted">Твій заробіток за період</span>
            <strong className={`renewal-big ${current.earnedMinor < 0 ? 'text-neg' : 'text-pos'}`}>
              <UpdatedValue
                value={current.earnedMinor}
                identity={current.key}
                enabled={finance.display?.animations !== false}
              >
                {moneyLabel(current.earnedMinor)}
              </UpdatedValue>
            </strong>
            {work.deltaMinor !== null && (
              <span
                className={`taxi-work-delta ${work.deltaMinor < 0 ? 'text-neg' : work.deltaMinor > 0 ? 'text-pos' : 'renewal-muted'}`}
                title="Порівняння на той самий момент від початку перезмінки"
              >
                {work.deltaMinor === 0
                  ? 'Темп на рівні минулої перезмінки'
                  : `${work.deltaMinor > 0 ? '+' : ''}${moneyLabel(work.deltaMinor)} до темпу минулої`}
              </span>
            )}
            {work.provisional && (
              <p className="renewal-chart-note">
                {work.hasCommission
                  ? 'За записами на зараз · зміна ще триває'
                  : 'Попередня сума · у змінах бракує комісії'}
              </p>
            )}
          </div>
        </>
      )}

      <div className="taxi-work-target">
        {report && (
          <p className="renewal-chart-note">{taxiRangeLabel(current.from, current.to)} · Київ</p>
        )}
        <div className="taxi-work-row">
          <div>
            <span className="renewal-muted">
              {report ? 'Ціль нової перезмінки' : 'Ціль перезмінки'}
            </span>
            {targetMinor !== null && <b>{moneyLabel(targetMinor)}</b>}
          </div>
          <button
            type="button"
            className="renewal-link"
            onClick={() => {
              if (report && targetMinor !== null) setReviewedPeriod(report.key);
              else onAction({ kind: 'taxi-target', id: current.key });
            }}
          >
            {targetMinor === null
              ? 'Поставити ціль'
              : report
                ? 'До нового плану ↗'
                : 'Змінити ціль'}
          </button>
        </div>
        {targetMinor !== null && !report && (
          <>
            <div
              className="renewal-progress"
              role="progressbar"
              aria-label="Прогрес цілі заробітку"
              aria-valuenow={Math.round(Math.max(0, Math.min(100, progress)))}
              aria-valuetext={`${percentLabel(progress)} від цілі`}
            >
              <span style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} />
            </div>
            <div className="taxi-work-row taxi-target-caption">
              <span>{percentLabel(progress)}</span>
              <span>
                {remainingMinor
                  ? `Залишилось ${moneyLabel(remainingMinor)}`
                  : work.hasCommission
                    ? 'Цілі досягнуто'
                    : 'Сума ще уточнюється'}
              </span>
            </div>
          </>
        )}
        {work.nextTargetMinor !== null && (
          <button
            type="button"
            className="renewal-link taxi-next-target"
            aria-label={`Наступна перезмінка · ${moneyLabel(work.nextTargetMinor)}`}
            onClick={() => onAction({ kind: 'taxi-target', id: work.next.key })}
          >
            На наступну · {moneyLabel(work.nextTargetMinor)} ↗
          </button>
        )}
      </div>

      {!report && (
        <TaxiTodayPlan work={work} plan={plan} animations={finance.display?.animations !== false} />
      )}
      <button
        type="button"
        className="renewal-button w-full"
        onClick={() => onAction({ kind: 'taxi' })}
      >
        + Записати зміну
      </button>
      {!report && (
        <TaxiPlanDetails
          key={`plan-${current.key}`}
          work={work}
          plan={plan}
          onEdit={(date) =>
            onAction({
              kind: 'taxi-target',
              id: current.key,
              defaults: { taxiFocusDate: date },
            })
          }
        />
      )}
      {unpaid && (
        <div
          className="renewal-inset taxi-work-unpaid"
          role="region"
          aria-label="Нерозрахована перезмінка"
        >
          <b>Попередній період очікує розрахунку</b>
          <p className="renewal-chart-note">
            {taxiPeriodLabel(unpaid.key, finance.policies)}, Київ
          </p>
          {unpaid.complete && unpaid.settlementMinor !== 0 && (
            <p>
              {unpaid.settlementMinor < 0 ? 'Повернути парку' : 'Отримати від парку'} ·{' '}
              <b>{moneyLabel(Math.abs(unpaid.settlementMinor))}</b>
            </p>
          )}
          <button
            type="button"
            className="renewal-secondary w-full"
            onClick={() =>
              unpaid.complete
                ? onAction({ kind: 'taxi-settle', id: unpaid.key })
                : onHistory(unpaid.key)
            }
          >
            {unpaid.complete ? 'Підтвердити оплату перезмінки' : 'Доповнити записи періоду'}
          </button>
        </div>
      )}

      {!report && (
        <>
          <TaxiWorkChart
            key={`chart-${current.key}`}
            work={work}
            onEditShift={week?.settled ? undefined : (id) => onAction({ kind: 'taxi', id })}
          />
          <TaxiNextShift key={`forecast-${current.key}`} work={work} plan={plan} />
        </>
      )}
      <details className="taxi-work-fold">
        <summary>Увесь дохід</summary>
        <div className="taxi-work-fold-body">
          <div className="taxi-work-row">
            <span>Заробіток за формулою парку</span>
            <b>{moneyLabel(current.earnedMinor)}</b>
          </div>
          <div className="taxi-work-row">
            <span>Окремо записаний особистий дохід</span>
            <b>{moneyLabel(income.period.personalMinor)}</b>
          </div>
          <div className="taxi-work-row taxi-work-total">
            <span>Разом за перезмінку</span>
            <b>
              {income.period.provisional && '≈ '}
              {moneyLabel(income.period.totalMinor)}
            </b>
          </div>
          <div className="taxi-work-row taxi-work-total">
            <span>Поточний місяць</span>
            <b>
              {income.month.provisional && '≈ '}
              {moneyLabel(income.month.totalMinor)}
            </b>
          </div>
          <div className="taxi-work-row taxi-work-total">
            <span>За весь час</span>
            <b>
              {income.all.provisional && '≈ '}
              {moneyLabel(income.all.totalMinor)}
            </b>
          </div>
          <button
            type="button"
            className="renewal-link"
            onClick={() => onAction({ kind: 'taxi-personal' })}
          >
            Записати особистий дохід таксі
          </button>
        </div>
      </details>
      <div className="taxi-work-footer">
        <button
          type="button"
          className="renewal-secondary w-full"
          onClick={() => onHistory(report?.key ?? '')}
        >
          Історія перезмінок
        </button>
        <details className="taxi-work-fold">
          <summary>Каса, умови та дії</summary>
          <div className="taxi-work-fold-body">
            <dl className="taxi-work-ledger">
              <dt>Каса до комісії</dt>
              <dd>{moneyLabel(current.grossMinor)}</dd>
              <dt>Чиста каса</dt>
              <dd className="taxi-net-cash">{moneyLabel(current.netCashMinor)}</dd>
              <dt>Повна комісія</dt>
              <dd>{moneyLabel(sumMoney(current.groups.map((group) => group.commissionMinor)))}</dd>
              <dt>Пальне парку</dt>
              <dd>{moneyLabel(sumMoney(current.groups.map((group) => group.fuelMinor)))}</dd>
              <dt>Чайові до поділу</dt>
              <dd>{moneyLabel(sumMoney(current.entries.map((entry) => entry.tipsMinor)))}</dd>
              {week?.complete && (
                <>
                  <dt>Готівка після робочих оплат</dt>
                  <dd>{moneyLabel(week.heldMinor)}</dd>
                  {!week.settled && week.settlementMinor !== 0 && (
                    <>
                      <dt>
                        {week.settlementMinor < 0 ? 'Повернути парку' : 'Парк доплатить'} ·
                        попередньо
                      </dt>
                      <dd>{moneyLabel(Math.abs(week.settlementMinor))}</dd>
                    </>
                  )}
                </>
              )}
            </dl>
            {week?.complete === false && (
              <p className="renewal-chart-note">
                Для розрахунку уточни комісію та отриману готівку.
              </p>
            )}
            {work.takeHomePer100 !== null && (
              <p className="renewal-chart-note">
                Зі 100 ₴ каси тобі лишилось {amountNumber(Math.round(work.takeHomePer100 * 100))} ₴
                після часток комісії та пального.
              </p>
            )}
            {active && (
              <p className="renewal-chart-note">
                Твої частки · каса {percentLabel(active.fareBps / 100)}, комісія{' '}
                {percentLabel(active.commissionBps / 100)}, пальне{' '}
                {percentLabel(active.fuelBps / 100)}.
              </p>
            )}
            <p className="renewal-chart-note">{taxiScheduleLabel(now, finance.policies)}</p>
            {explanations && (
              <p className="renewal-chart-note">
                Заробіток показує твою частку після робочих витрат. Розрахунок із парком також
                враховує готівку, яку ти вже отримав.
              </p>
            )}
            <div className="taxi-work-actions">
              <button
                type="button"
                className="renewal-link"
                onClick={() => onAction({ kind: 'policy' })}
              >
                Налаштувати таксі ↗
              </button>
              <button
                type="button"
                className="renewal-link"
                onClick={() => onAction({ kind: 'taxi-transition' })}
              >
                Змінити авто / розклад
              </button>
              <button
                type="button"
                className="renewal-link"
                onClick={() =>
                  onAction({
                    kind: 'expense',
                    defaults: { category: 'догляд за авто', description: 'Мийка автомобіля' },
                  })
                }
              >
                Особиста витрата · догляд за авто
              </button>
            </div>
          </div>
        </details>
      </div>
    </section>
  );
}
