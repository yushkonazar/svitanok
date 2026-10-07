import { useState, useLayoutEffect, useRef } from 'react';
import { useTick } from '../../lib/useTick.ts';
import { useSearchParams } from 'react-router-dom';
import { useFinance } from '../../api/finance-hooks.ts';
import { isSessionExpired } from '../../api/client.ts';
import { financeView, moneyLabel } from '../../lib/financeView.ts';
import { sumMoney, calculateTaxiWeek } from '../../../../core/finance/planning.mjs';
import { LoadingSkeleton, ErrorState } from '../ui/states.tsx';
import { SessionExpired } from '../ui/SessionExpired.tsx';
import { ObservationChart } from '../charts/ObservationChart.tsx';
import { FinanceForm, type FinanceFormRequest } from './FinanceForm.tsx';
import { PageHeading } from '../ui/PageHeading.tsx';
import { TaxiHistory } from './TaxiHistory.tsx';
import { FinanceReport } from './FinanceReport.tsx';
import { PaymentDetail } from './PaymentDetail.tsx';
import { PaymentCard } from './PaymentCard.tsx';
import { FinanceExplanation } from './FinanceExplanation.tsx';
import { PaymentCalendar } from './PaymentCalendar.tsx';
import { paymentSchedule } from '../../lib/paymentSchedule.ts';
import { kyivParts, shiftDate } from '../../../../core/finance/planning.mjs';
import { resetFinanceDemo } from '../../api/finance-demo.ts';

const LABELS: Record<string, string> = {
  income: 'Надходження',
  expense: 'Витрата',
  transfer: 'Переказ',
  adjustment: 'Корекція',
  'taxi-custody': 'Готівка таксі',
  'taxi-settlement': 'Розрахунок із парком',
  unclassified: 'Уточни тип',
};
const PERIOD: Record<string, string> = { day: 'день', week: 'тиждень', month: 'місяць' };
function Progress({ percent }: { percent: number }) {
  return (
    <div className="renewal-progress">
      <span style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
    </div>
  );
}
export function FinanceScreen() {
  const { data, isLoading, error, refetch } = useFinance();
  const [allOperations, setAllOperations] = useState(false);
  const [paymentsExpanded, setPaymentsExpanded] = useState(() => {
    try {
      return localStorage.getItem('svitanok.finance.paymentsExpanded') === 'true';
    } catch {
      return false;
    }
  });
  const togglePayments = () => {
    const next = !paymentsExpanded;
    setPaymentsExpanded(next);
    try {
      localStorage.setItem('svitanok.finance.paymentsExpanded', String(next));
    } catch {
      /* The list still toggles when browser storage is unavailable. */
    }
  };
  const [historyOpen, setHistoryOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [explainOpen, setExplainOpen] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const overviewScroll = useRef(0);
  useLayoutEffect(() => {
    window.scrollTo(0, detailId || reportOpen ? 0 : overviewScroll.current);
  }, [detailId, reportOpen]);
  const [dayChoice, setDays] = useState<number | null>(null);
  const days = dayChoice ?? (data?.finance.settings.incomePeriod === 'month' ? 30 : 7);
  const [form, setForm] = useState<FinanceFormRequest | null>(null);
  const [params, setParams] = useSearchParams();
  const activeForm =
    form ??
    (params.get('action') === 'expense'
      ? { kind: 'expense' as const }
      : params.get('action') === 'settings'
        ? { kind: 'settings' as const }
        : null);
  const nowMs = useTick(30_000);
  if (isSessionExpired(error)) return <SessionExpired />;
  if (isLoading) return <LoadingSkeleton />;
  if (error || !data)
    return (
      <ErrorState
        message={error instanceof Error ? error.message : 'Фінанси недоступні'}
        onRetry={() => refetch()}
      />
    );
  const f = data.finance,
    view = financeView(f, days);
  const taxi = calculateTaxiWeek(f.taxiEntries, f.policies, nowMs);
  const activePolicy = f.policies.filter((p) => Date.parse(p.effectiveAt) <= nowMs).at(-1)!;
  const latestWeek = f.taxiWeeks.find((w) => w.key === taxi.key);
  const detail = f.payments.find((p) => p.id === detailId);
  const formNode = activeForm && (
    <FinanceForm
      key={`${activeForm.kind}-${activeForm.id ?? ''}`}
      request={activeForm}
      finance={f}
      onClose={() => {
        if (['payment-paid', 'payment-close', 'payment-cancel'].includes(activeForm.kind))
          setDetailId(null);
        setForm(null);
        setParams({}, { replace: true });
      }}
    />
  );
  const today = kyivParts(nowMs).date,
    until = shiftDate(today, days - 1);
  const unplanned = f.payments.some(
    (p) =>
      p.status === 'active' &&
      p.installmentsLeft === 0 &&
      (p.remainingMinor ?? 0) + (p.overpaymentRemainingMinor ?? 0) > 0,
  );
  const obligations = sumMoney(
    f.payments
      .filter((p) => p.status === 'active')
      .flatMap((p) =>
        paymentSchedule(p, 1200)
          .filter((r) => r.date <= until)
          .map((r) => r.payment),
      ),
  );
  if (reportOpen) return <FinanceReport onBack={() => setReportOpen(false)} />;
  if (detail)
    return (
      <>
        <PaymentDetail
          payment={detail}
          onBack={() => setDetailId(null)}
          onEdit={() => setForm({ kind: 'payment', id: detail.id })}
          onPay={() => setForm({ kind: 'payment-paid', id: detail.id })}
          onCloseDebt={() => setForm({ kind: 'payment-close', id: detail.id })}
          onCancel={() => setForm({ kind: 'payment-cancel', id: detail.id })}
        />
        {formNode}
      </>
    );
  return (
    <div className="renewal-finance flex flex-col gap-5">
      <PageHeading
        eyebrow="ГРОШІ БЕЗ ТУМАНУ"
        title="Знати, що є."
        accent="Планувати далі."
        description="Рахунки, витрати й зобов’язання в одному місці."
        action={
          <button
            className="renewal-secondary"
            onClick={() => setForm({ kind: 'settings' })}
            aria-label="Налаштування фінансів"
          >
            ⚙
          </button>
        }
      />
      {data.demo && (
        <div className="renewal-inset renewal-muted">
          Демонстраційний облік. Зміни зберігаються лише в цьому браузері й не стосуються твоїх
          справжніх грошей.{' '}
          <button
            className="renewal-link mt-2"
            onClick={() => {
              resetFinanceDemo();
              void refetch();
            }}
          >
            Скинути демо до початкових даних
          </button>
        </div>
      )}
      <section
        className="renewal-card renewal-money-hero"
        style={{
          background:
            'radial-gradient(ellipse at 100% 0%,rgba(255,164,92,.13),transparent 65%),var(--color-bg2)',
        }}
      >
        <div className="renewal-section-head">
          <span className="renewal-eyebrow">ВІЛЬНІ КОШТИ</span>
          <div className="renewal-segments">
            {[7, 30].map((n) => (
              <button key={n} onClick={() => setDays(n)} aria-pressed={days === n}>
                {n} днів
              </button>
            ))}
          </div>
        </div>
        <div
          className="renewal-big"
          style={{ color: view.available < 0 ? 'var(--color-neg)' : 'var(--color-a2)' }}
        >
          {view.unknownBalances ? '—' : moneyLabel(view.available)}
        </div>
        <p className="renewal-muted mt-2">
          {view.unknownBalances
            ? 'Потрібно підтвердити залишки й кредитний ліміт картки або доповнити комісію й готівку змін таксі.'
            : 'Власні кошти на рахунках мінус резерв парку та зарезервовані кошти на цілі. Кредитний ліміт не є твоїми грошима.'}
        </p>
        <button className="renewal-link mt-3" onClick={() => setExplainOpen(true)}>
          Як порахована ця сума?
        </button>
        <div className="renewal-metrics">
          <div className="renewal-metric">
            <span className="renewal-muted">На рахунках · ₴</span>
            <strong>{moneyLabel(view.owned)}</strong>
          </div>
          <div className="renewal-metric">
            <span className="renewal-muted">Залишити для парку</span>
            <strong className="text-a2">{moneyLabel(f.reserveMinor)}</strong>
          </div>
          <div className="renewal-metric">
            <span className="renewal-muted">Інші надходження · {days}д</span>
            <strong className="text-pos">{moneyLabel(view.income)}</strong>
          </div>
          <div className="renewal-metric">
            <span className="renewal-muted">Особисті витрати · {days}д</span>
            <strong>{moneyLabel(view.expense)}</strong>
          </div>
        </div>
        <div className="renewal-finance-actions mt-4">
          <button className="renewal-button" onClick={() => setForm({ kind: 'expense' })}>
            Записати витрату
          </button>
          <button className="renewal-secondary" onClick={() => setForm({ kind: 'income' })}>
            Додати дохід
          </button>
        </div>
        {f.accounts.some((a) => a.currency !== 'UAH') && (
          <p className="renewal-muted mt-3">
            Валютні рахунки показані окремо й не підсумовані з гривнею.
          </p>
        )}
      </section>

      {f.settings.taxiVisible && (
        <section className="renewal-card">
          <div className="renewal-section-head">
            <div>
              <p className="renewal-eyebrow mb-2">РОБОТА · ТАКСІ</p>
              <h2 className="text-lg font-bold">
                Тиждень від {taxi.key.slice(8)}.{taxi.key.slice(5, 7)}
              </h2>
            </div>
            <button className="renewal-link" onClick={() => setForm({ kind: 'settings' })}>
              Налаштувати таксі ↗
            </button>
          </div>
          <div className="renewal-metrics mb-3">
            <div className="renewal-metric">
              <span className="renewal-muted">Чиста каса · після комісії</span>
              <strong>{moneyLabel(taxi.netCashMinor)}</strong>
            </div>
            <div className="renewal-metric">
              <span className="renewal-muted">Брудна каса</span>
              <strong>{moneyLabel(taxi.grossMinor)}</strong>
            </div>
            <div className="renewal-metric">
              <span className="renewal-muted">Заробіток за формулою</span>
              <strong className="text-pos">{moneyLabel(taxi.earnedMinor)}</strong>
            </div>
            <div className="renewal-metric">
              <span className="renewal-muted">
                {(latestWeek?.settlementMinor ?? 0) < 0 ? 'Залишити для парку' : 'Парк доплатить'}
              </span>
              <strong>{moneyLabel(Math.abs(latestWeek?.settlementMinor ?? 0))}</strong>
            </div>
          </div>
          {latestWeek?.complete === false && (
            <p className="renewal-inset renewal-muted mt-3">
              Попередній розрахунок: ще не вказано комісію або отриману готівку. Відкрий деталі й
              доповни зміну.
            </p>
          )}
          <button className="renewal-button mt-4 w-full" onClick={() => setForm({ kind: 'taxi' })}>
            + Записати зміну
          </button>
          <button
            className="renewal-secondary mt-3 w-full"
            onClick={() => setForm({ kind: 'taxi-personal' })}
          >
            Особистий дохід · решта, чайові, поїздка
          </button>
          <p className="renewal-muted mt-2">
            Додатково особисто за тиждень:{' '}
            {moneyLabel(
              sumMoney(
                f.transactions
                  .filter(
                    (t) =>
                      t.personalTaxiType &&
                      t.kind === 'income' &&
                      Date.parse(t.at) >= taxi.from &&
                      Date.parse(t.at) < taxi.to,
                  )
                  .map((t) => t.amountUah ?? 0),
              ),
            )}
            . Уже враховано в готівці та надходженнях.
          </p>
          <button className="renewal-secondary mt-3 w-full" onClick={() => setHistoryOpen(true)}>
            Історія перезмінок
          </button>
          <details className="mt-3">
            <summary className="renewal-link cursor-pointer">Каса, умови та розрахунки</summary>
            <button className="renewal-secondary mt-3" onClick={() => setForm({ kind: 'policy' })}>
              Змінити умови роботи
            </button>
            <p className="renewal-muted">Перезмінка — понеділок о 13:00, Київ.</p>
            <div className="renewal-metrics">
              <div className="renewal-metric">
                <span className="renewal-muted">Чиста каса · після комісії</span>
                <strong>{moneyLabel(taxi.netCashMinor)}</strong>
              </div>
              <div className="renewal-metric">
                <span className="renewal-muted">Брудна каса</span>
                <strong>{moneyLabel(taxi.grossMinor)}</strong>
              </div>
              <div className="renewal-metric">
                <span className="renewal-muted">Твій заробіток</span>
                <strong className="text-pos">{moneyLabel(taxi.earnedMinor)}</strong>
              </div>
              <div className="renewal-metric">
                <span className="renewal-muted">Отримана готівка</span>
                <strong>{moneyLabel(latestWeek?.heldMinor ?? 0)}</strong>
              </div>
              <div className="renewal-metric">
                <span className="renewal-muted">
                  {(latestWeek?.settlementMinor ?? 0) < 0 ? 'Повернути парку' : 'Парк доплатить'}
                </span>
                <strong className="text-a2">
                  {moneyLabel(Math.abs(latestWeek?.settlementMinor ?? 0))}
                </strong>
              </div>
            </div>
            <p className="renewal-muted mt-3">
              Поточні умови: каса {activePolicy.fareBps / 100}%, комісія{' '}
              {activePolicy.commissionBps / 100}%, пальне {activePolicy.fuelBps / 100}%.
            </p>
            {activePolicy.thresholdMinor !== null && (
              <div className="mt-4">
                <p className="renewal-muted">
                  {taxi.grossMinor > activePolicy.thresholdMinor
                    ? `${activePolicy.bonusFareBps / 100}% на касу за цими умовами; частки комісії й пального залишаються незмінними.`
                    : `Для ${activePolicy.bonusFareBps / 100}% потрібно перевищити ${moneyLabel(activePolicy.thresholdMinor)} брудної каси.`}
                </p>
                <Progress
                  percent={(taxi.grossMinor / Math.max(1, activePolicy.thresholdMinor)) * 100}
                />
              </div>
            )}
            <p className="renewal-muted mt-3">
              Заробіток є розрахунком, не другим надходженням на рахунок. Пальне з паливної картки
              не списується з особистих коштів.
            </p>
          </details>
        </section>
      )}

      <section className="renewal-card">
        <div className="renewal-section-head renewal-payment-head">
          <h2 className="text-lg font-bold">Платежі, кредити й підписки</h2>
          <button className="renewal-link" onClick={() => setForm({ kind: 'payment' })}>
            Додати +
          </button>
        </div>
        <button
          type="button"
          className="renewal-secondary w-full"
          aria-expanded={paymentsExpanded}
          aria-controls="finance-payment-list"
          onClick={togglePayments}
        >
          {paymentsExpanded
            ? 'Приховати список'
            : `Показати список (${f.payments.filter((p) => p.status === 'active' || p.status === 'paused').length})`}
        </button>
        <div id="finance-payment-list" hidden={!paymentsExpanded}>
          {f.payments
            .filter((p) => p.status === 'active')
            .sort((a, b) => a.nextDate.localeCompare(b.nextDate))
            .map((p) => (
              <PaymentCard
                key={p.id}
                payment={p}
                onOpen={() => {
                  overviewScroll.current = window.scrollY;
                  setDetailId(p.id);
                }}
                onPay={() => setForm({ kind: 'payment-paid', id: p.id })}
                onEdit={() => setForm({ kind: 'payment', id: p.id })}
                onCloseDebt={() => setForm({ kind: 'payment-close', id: p.id })}
                onCancel={() => setForm({ kind: 'payment-cancel', id: p.id })}
              />
            ))}
          {!f.payments.some((p) => p.status === 'active') && (
            <p className="renewal-muted mt-3">
              Активних платежів немає. Додай підписку, кредит або інший платіж.
            </p>
          )}
          {f.payments.some((p) => p.status === 'paused') && (
            <details className="mt-3">
              <summary className="renewal-link">Призупинені платежі</summary>
              {f.payments
                .filter((p) => p.status === 'paused')
                .map((p) => (
                  <button
                    className="renewal-list-row w-full text-left"
                    key={p.id}
                    onClick={() => setForm({ kind: 'payment', id: p.id })}
                  >
                    <span>
                      {p.name}
                      <small>Призупинено</small>
                    </span>
                    <span className="renewal-link">Налаштувати</span>
                  </button>
                ))}
            </details>
          )}
          {!!f.detectedSubscriptions.length && (
            <details className="mt-3">
              <summary className="renewal-link">Підписки, виявлені банківським обліком</summary>
              {f.detectedSubscriptions.map((p) => (
                <p className="renewal-muted" key={p.id}>
                  {p.merchant} · {moneyLabel(p.amountMinor, p.currency)}
                </p>
              ))}
            </details>
          )}
        </div>
      </section>

      <section className="renewal-card">
        <div className="renewal-section-head">
          <h2 className="text-lg font-bold">Останні операції</h2>
          <button className="renewal-link" onClick={() => refetch()}>
            Оновити ↻
          </button>
        </div>
        {!!view.unclassified.length && (
          <p className="renewal-muted mb-3">
            {view.unclassified.length} операцій потребують уточнення типу. Перекази й невизначені
            надходження не зараховані в дохід автоматично.
          </p>
        )}
        {(allOperations ? view.txs.slice(0, 40) : view.txs.slice(0, 5)).map((t) => (
          <button
            type="button"
            key={t.id}
            disabled={
              !!t.reference || (!t.bank && !['expense', 'income', 'unclassified'].includes(t.kind))
            }
            className="renewal-list-row w-full text-left"
            onClick={() =>
              setForm({
                kind:
                  !t.bank && ['expense', 'income'].includes(t.kind)
                    ? 'edit-transaction'
                    : 'classify',
                id: t.id,
              })
            }
          >
            <span>
              <b>{t.description}</b>
              <small>
                {t.category} · {LABELS[t.kind] ?? t.kind} ·{' '}
                {new Date(t.at).toLocaleDateString('uk-UA', { timeZone: 'Europe/Kyiv' })}
              </small>
            </span>
            <b
              className={`font-mono whitespace-nowrap ${t.amountMinor > 0 ? 'text-pos' : 'text-tx'}`}
            >
              {moneyLabel(t.amountMinor, t.currency)}
            </b>
          </button>
        ))}
        {view.txs.length > 5 && (
          <button className="renewal-secondary mt-3" onClick={() => setAllOperations((v) => !v)}>
            {allOperations
              ? 'Показати останні 5'
              : `Усі операції (${Math.min(view.txs.length, 40)})`}
          </button>
        )}
        {!view.txs.length && <p className="renewal-muted">За цей період операцій немає.</p>}
      </section>
      <section className="renewal-card">
        <div className="renewal-section-head">
          <h2 className="text-lg font-bold">План витрат</h2>
          <button className="renewal-link" onClick={() => setForm({ kind: 'budget' })}>
            Бюджет +
          </button>
        </div>
        {!view.budgets.length && (
          <p className="renewal-muted">Додай денний, тижневий або місячний ліміт за категоріями.</p>
        )}
        {view.budgets.map((b) => (
          <div key={b.id} className="mb-5">
            <div className="renewal-section-head mb-1">
              <b className="text-sm">{b.category}</b>
              <button
                className="renewal-link"
                onClick={() => setForm({ kind: 'budget', id: b.id })}
              >
                Змінити
              </button>
            </div>
            <p className="renewal-muted">
              {moneyLabel(b.spent)} із {moneyLabel(b.limit)} / {PERIOD[b.period]}
              {b.shareBps != null ? ` · ${b.shareBps / 100}% планового доходу` : ''}
            </p>
            <Progress percent={b.progress} />
            <p className={`mt-2 text-xs ${b.left < 0 ? 'text-neg' : 'text-tx2'}`}>
              {b.left < 0
                ? `Перевищення ${moneyLabel(-b.left)}`
                : `Залишилось ${moneyLabel(b.left)}`}
            </p>
          </div>
        ))}
        <button className="renewal-secondary" onClick={() => setForm({ kind: 'template' })}>
          Додати план 50 / 30 / 20
        </button>
      </section>

      <section className="renewal-card">
        <div className="renewal-section-head">
          <h2 className="text-lg font-semibold">План на {days === 7 ? 'тиждень' : 'місяць'}</h2>
          <span className="renewal-pill">
            {f.settings.incomePeriod === 'week' ? 'Тижнева каса' : 'Місячна каса'}
          </span>
        </div>
        <p className="renewal-muted">
          Після платежів до{' '}
          {new Date(until + 'T12:00:00Z').toLocaleDateString('uk-UA', {
            day: 'numeric',
            month: 'long',
          })}
        </p>
        <button
          className="renewal-link mt-3"
          onClick={() => {
            overviewScroll.current = window.scrollY;
            setCalendarOpen(true);
          }}
        >
          Календар платежів ↗
        </button>
        <div className="renewal-big mt-3">
          {view.unknownBalances || unplanned ? '—' : moneyLabel(view.available - obligations)}
        </div>
        {unplanned && (
          <p className="renewal-inset renewal-muted mt-3">
            Є борг із завершеним графіком. Уточни кількість майбутніх платежів, щоб план показував
            повний залишок після зобов’язань.
          </p>
        )}
        {[
          ['Особисті витрати', view.expense],
          ['Найближчі зобов’язання', obligations],
          ['Вже виділено на цілі', view.allocated],
        ].map(([label, value]) => (
          <div key={String(label)}>
            <div className="renewal-plan-lane">
              <span>{label}</span>
              <strong>{moneyLabel(Number(value))}</strong>
            </div>
            <Progress percent={view.owned > 0 ? (Number(value) / view.owned) * 100 : 0} />
          </div>
        ))}
        <p className="renewal-chart-note mt-4">
          Платежі — план, а не списання. Резерв парку та внески на цілі вже враховані у вільних
          коштах. Прострочені платежі теж включені.
        </p>
      </section>

      <section className="renewal-card">
        <div className="renewal-section-head">
          <h2 className="text-lg font-bold">Мої цілі</h2>
          <button className="renewal-link" onClick={() => setForm({ kind: 'goal' })}>
            Ціль +
          </button>
        </div>
        {f.goals.map((g) => {
          const allocated = sumMoney(
            f.goalMoves.filter((m) => m.goalId === g.id).map((m) => m.amountMinor),
          );
          return (
            <div key={g.id} className="mb-5">
              <div className="renewal-section-head flex-wrap">
                <b className="text-sm w-full">{g.name}</b>
                <button
                  className="renewal-link"
                  onClick={() => setForm({ kind: 'goal', id: g.id })}
                >
                  Налаштувати
                </button>
                <button
                  className="renewal-link"
                  onClick={() => setForm({ kind: 'goal-move', id: g.id })}
                >
                  Внесок / повернення
                </button>
              </div>
              <p className="renewal-muted">
                {moneyLabel(allocated)} із {moneyLabel(g.targetMinor)}
                {g.deadline ? ` · до ${g.deadline}` : ''}
              </p>
              <Progress percent={(allocated / g.targetMinor) * 100} />
              {g.planAmountMinor != null && g.planPeriod && (
                <p className="renewal-inset renewal-muted mt-3">
                  План: {moneyLabel(g.planAmountMinor)} / {PERIOD[g.planPeriod]}. У поточному
                  періоді внесено{' '}
                  {moneyLabel(
                    sumMoney(
                      f.goalMoves
                        .filter((m) => {
                          const date = kyivParts(Date.parse(m.at)).date;
                          const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
                          const from =
                            g.planPeriod === 'day'
                              ? today
                              : g.planPeriod === 'week'
                                ? shiftDate(today, -dow)
                                : `${today.slice(0, 7)}-01`;
                          return m.goalId === g.id && date >= from && Date.parse(m.at) <= nowMs;
                        })
                        .map((m) => m.amountMinor),
                    ),
                  )}
                  . План не створює автоматичного списання.
                </p>
              )}
            </div>
          );
        })}
        <p className="renewal-muted">
          На рахунках зарезервовано {moneyLabel(view.allocated)}. Фактичні внески в банки вже
          зменшили відповідні залишки й повторно з вільної суми не віднімаються.
        </p>
      </section>

      <details className="renewal-card renewal-disclosure">
        <summary className="renewal-section-head cursor-pointer">
          <h2 className="text-lg font-bold">Рахунки та інструменти</h2>
          <span className="renewal-muted">{f.accounts.length} рахунки</span>
        </summary>
        <div className="renewal-section-head">
          <h2 className="text-lg font-bold">Рахунки й залишки</h2>
          <button className="renewal-link" onClick={() => setForm({ kind: 'account' })}>
            Додати +
          </button>
        </div>
        {f.accounts.map((a) => (
          <div className="renewal-list-row" key={a.id}>
            <span>
              {a.name}
              <small>
                {a.kind === 'mono'
                  ? 'Дані Monobank'
                  : a.kind === 'cash'
                    ? 'Готівка'
                    : 'Ручний облік'}
                {a.asOf ? ` · ${new Date(a.asOf).toLocaleDateString('uk-UA')}` : ''}
              </small>
              {a.kind === 'mono' && (
                <small>
                  Доступно в банку:{' '}
                  {a.availableMinor == null ? '—' : moneyLabel(a.availableMinor, a.currency)} ·
                  Кредитний ліміт:{' '}
                  {a.creditLimitMinor == null
                    ? 'не визначено'
                    : moneyLabel(a.creditLimitMinor, a.currency)}
                  <button
                    className="renewal-link block mt-2"
                    onClick={() => setForm({ kind: 'credit-limit', id: a.id })}
                  >
                    Налаштувати кредитний ліміт
                  </button>
                </small>
              )}
            </span>
            <b className="font-mono">
              {a.balanceMinor == null
                ? a.kind === 'mono' && a.creditLimitMinor == null
                  ? 'Вкажи ліміт'
                  : 'Немає залишку'
                : moneyLabel(a.balanceMinor, a.currency)}
            </b>
          </div>
        ))}
        <div className="mt-4 flex gap-3">
          <button className="renewal-secondary" onClick={() => setForm({ kind: 'transfer' })}>
            Переказ
          </button>
          <button
            className="renewal-secondary"
            onClick={() => setForm({ kind: 'account-balance' })}
          >
            Вказати поточний залишок
          </button>
        </div>
      </details>

      <details className="renewal-card renewal-disclosure">
        <summary className="text-lg font-bold cursor-pointer">Ритм особистих витрат</summary>
        <ObservationChart
          key={days}
          label="Особисті витрати за день"
          points={view.chart}
          unit="₴"
        />
        <p className="renewal-muted">Перекази, корекції та готівка парку не входять у витрати.</p>
      </details>
      <section className="renewal-card">
        <h2 className="text-lg font-bold">Історія фінансів</h2>
        <p className="renewal-muted mt-2 mb-4">
          Витрати, надходження й таксі за минулі періоди — в окремому звіті.
        </p>
        <button
          className="renewal-secondary w-full"
          onClick={() => {
            overviewScroll.current = window.scrollY;
            setReportOpen(true);
          }}
        >
          Фінансові звіти
        </button>
      </section>
      {explainOpen && <FinanceExplanation finance={f} onClose={() => setExplainOpen(false)} />}
      {calendarOpen && (
        <PaymentCalendar
          finance={f}
          onClose={() => setCalendarOpen(false)}
          onPayment={(id) => {
            setCalendarOpen(false);
            // Let Sheet restore/unlock the overview before opening the detail at its top.
            requestAnimationFrame(() => setDetailId(id));
          }}
        />
      )}
      {historyOpen && (
        <TaxiHistory
          finance={f}
          onClose={() => setHistoryOpen(false)}
          onAction={(r) => {
            setHistoryOpen(false);
            setForm(r);
          }}
        />
      )}
      {activeForm && (
        <FinanceForm
          key={`${activeForm.kind}-${activeForm.id ?? ''}`}
          request={activeForm}
          finance={f}
          onClose={() => {
            setForm(null);
            setParams({}, { replace: true });
          }}
          onOpenForm={setForm}
        />
      )}
    </div>
  );
}
