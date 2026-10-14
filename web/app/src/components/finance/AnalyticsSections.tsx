import type { Finance } from '../../api/finance-schema.ts';
import type { FinanceAnalytics } from '../../api/finance-analytics-schema.ts';
import { budgetRows, orderedBudgets } from '../../lib/budgetPlanning.ts';
import { paymentSchedule } from '../../lib/paymentSchedule.ts';
import { moneyLabel, financeView } from '../../lib/financeView.ts';
import { kyivParts, kyivInstant, shiftDate, sumMoney } from '../../../../core/finance/planning.mjs';
import { PAYMENT_KIND_LABELS, isDebtKind } from '../../../../core/finance/payments.mjs';
import { financeCategoryLabel } from '../../../../core/finance/categories.mjs';
import { AnalyticsBars } from './AnalyticsCharts.tsx';
export function Metric({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="renewal-metric">
      <span className="renewal-muted">{label}</span>
      <strong>{value == null ? 'Немає даних' : moneyLabel(value)}</strong>
    </div>
  );
}
export function OverviewAnalytics({ data }: { data: FinanceAnalytics }) {
  const r = data.report;
  return (
    <>
      <section className="renewal-card analytics-hero">
        <p className="renewal-muted">Результат обліку · усі рахунки</p>
        <div className="renewal-big">{moneyLabel(r.resultMinor)}</div>
        <div className="renewal-metrics">
          <Metric label="Особисті витрати" value={r.expenseMinor} />
          <Metric label="Інші надходження" value={r.otherIncomeMinor} />
          <Metric label="Зароблено в таксі" value={r.taxiEarnedMinor} />
          <Metric label="Різниця розрахунків із парком" value={r.settlementDifferenceMinor} />
        </div>
        <p className="renewal-chart-note mt-3">
          Заробіток таксі + інші надходження − особисті витрати + різниця розрахунків із парком. Це
          результат за період, а не поточний залишок.
        </p>
      </section>
      <section className="renewal-card">
        <h2 className="text-lg font-bold">Що змінило витрати</h2>
        {[...data.categories]
          .sort((a, b) => Math.abs(b.deltaMinor) - Math.abs(a.deltaMinor))
          .slice(0, 6)
          .map((c) => (
            <div className="analytics-row" key={c.category}>
              <span>{financeCategoryLabel(c.category)}</span>
              <b>
                {c.deltaMinor > 0 ? '+' : ''}
                {moneyLabel(c.deltaMinor)}
              </b>
            </div>
          ))}
        {!data.categories.length && (
          <p className="renewal-muted mt-3">За обидва періоди записаних витрат немає.</p>
        )}
      </section>
    </>
  );
}
export function BudgetAnalytics({ finance, nowMs }: { finance: Finance; nowMs: number }) {
  const rows = orderedBudgets(budgetRows(finance, nowMs));
  return (
    <section className="renewal-card">
      <h2 className="text-lg font-bold">Поточні бюджети · план і факт</h2>
      <p className="renewal-chart-note mt-2">
        Чинний план на {kyivParts(nowMs).date}. Для кожного рядка використано його день, тиждень або
        місяць. Історичні версії планів поки не записуються.
      </p>
      {rows.map((b) => (
        <div
          className="analytics-budget"
          key={b.id}
          style={{ paddingInlineStart: Math.min(b.depth, 3) * 10 }}
        >
          <div className="analytics-row">
            <span>
              <b>{b.category}</b>
              <small>
                {b.purpose === 'saving' ? 'Відкладання' : 'Витрати'} ·{' '}
                {b.period === 'day' ? 'день' : b.period === 'week' ? 'тиждень' : 'місяць'}
              </small>
            </span>
            <span>
              <b>{moneyLabel(b.spent)}</b>
              <small>із {moneyLabel(b.limit)}</small>
            </span>
          </div>
          <div className="renewal-progress">
            <span
              style={{
                width: `${b.progress}%`,
                background: b.left < 0 ? 'var(--color-neg)' : 'var(--color-a2)',
              }}
            />
          </div>
          <p className="renewal-chart-note mt-2">
            {b.left < 0 ? 'Перевищення' : 'Залишилось'}: {moneyLabel(Math.abs(b.left))}
          </p>
        </div>
      ))}
      {!rows.length && (
        <p className="renewal-muted mt-4">Створи бюджет на основній сторінці фінансів.</p>
      )}
      <p className="renewal-chart-note mt-4">
        Дочірні бюджети входять у батьківський. Перехресні плани показані окремо; їхні фактичні суми
        не додаються як нові витрати.
      </p>
    </section>
  );
}
export function PaymentAnalytics({
  finance,
  nowMs,
  onPayment,
}: {
  finance: Finance;
  nowMs: number;
  onPayment: (id: string) => void;
}) {
  const today = kyivParts(nowMs).date,
    until = shiftDate(today, 29),
    active = finance.payments.filter((p) => p.status === 'active');
  const planned = active
    .flatMap((p) =>
      paymentSchedule(p, 1200)
        .filter((item) => item.date >= today && item.date <= until)
        .map((item) => ({ ...item, id: p.id, name: p.name, kind: p.kind })),
    )
    .sort((a, b) => a.date.localeCompare(b.date));
  const debts = active.filter((p) => isDebtKind(p.kind)),
    unknown = debts.filter((p) => p.remainingMinor == null);
  const principal = sumMoney(debts.map((p) => p.remainingMinor ?? 0)),
    extra = sumMoney(debts.map((p) => p.overpaymentRemainingMinor ?? 0));
  const overdue = active.filter((p) => p.nextDate < today);
  return (
    <>
      <section className="renewal-card analytics-hero">
        <p className="renewal-muted">Майбутні платежі · 30 днів</p>
        <div className="renewal-big">{moneyLabel(sumMoney(planned.map((p) => p.payment)))}</div>
        <p className="renewal-chart-note">
          {today} — {until} · прогноз введених графіків
        </p>
        <div className="renewal-metrics">
          <Metric
            label="З них підписки"
            value={sumMoney(planned.filter((p) => p.kind === 'subscription').map((p) => p.payment))}
          />
          <Metric label="Відоме тіло боргів" value={debts.length ? principal : null} />
          <Metric label="Введений залишок переплати" value={extra} />
        </div>
        {unknown.length > 0 && (
          <p className="renewal-chart-note mt-3">
            Для {unknown.length} боргів залишок не введено. Вони не зараховані як нуль.
          </p>
        )}
      </section>
      {overdue.length > 0 && (
        <section className="renewal-card">
          <h2 className="font-bold">Потрібно перевірити оплати</h2>
          {overdue.map((p) => (
            <button className="analytics-operation" key={p.id} onClick={() => onPayment(p.id)}>
              <span>
                <b>{p.name}</b>
                <small>Дата в обліку: {p.nextDate}</small>
              </span>
              <strong>{moneyLabel(p.amountMinor)}</strong>
            </button>
          ))}
          <p className="renewal-chart-note">
            Дата в минулому означає непідтверджений запис у Світанку. Це не доказ прострочення в
            банку.
          </p>
        </section>
      )}
      <section className="renewal-card">
        <h2 className="font-bold">Календар майбутніх списань</h2>
        {planned.slice(0, 60).map((p, i) => (
          <button
            className="analytics-operation"
            key={`${p.id}-${p.date}-${i}`}
            onClick={() => onPayment(p.id)}
          >
            <span>
              <b>{p.name}</b>
              <small>
                {p.date} · {PAYMENT_KIND_LABELS[p.kind]}
              </small>
            </span>
            <strong>{moneyLabel(p.payment)}</strong>
          </button>
        ))}
        {planned.length > 60 && (
          <p className="renewal-chart-note">
            Показано найближчі 60 із {planned.length}; підсумок враховує всі.
          </p>
        )}
        {!planned.length && (
          <p className="renewal-muted mt-4">На цей проміжок платежів у графіках немає.</p>
        )}
      </section>
      {debts.map((p) => (
        <section className="renewal-card" key={p.id}>
          <button className="renewal-link" onClick={() => onPayment(p.id)}>
            {p.name} ↗
          </button>
          <div className="renewal-metrics">
            <Metric label="Тіло боргу" value={p.remainingMinor} />
            <Metric
              label="Залишок введеної переплати"
              value={p.overpaymentRemainingMinor ?? null}
            />
          </div>
          <p className="renewal-chart-note mt-2">
            {p.installmentsLeft == null
              ? 'Кількість платежів не вказана'
              : `${p.installmentsLeft} платежів залишилось`}
            . Майбутні відсотки за ставкою є прогнозом; відсутня фактична деталізація не
            вигадується.
          </p>
        </section>
      ))}
    </>
  );
}
export function GoalsAnalytics({ finance, data }: { finance: Finance; data: FinanceAnalytics }) {
  const { from, to } = data.selection,
    start = kyivInstant(from, 0),
    end = kyivInstant(shiftDate(to, 1), 0);
  return (
    <>
      {finance.goals.map((g) => {
        const all = finance.goalMoves.filter((m) => m.goalId === g.id),
          period = all.filter((m) => Date.parse(m.at) >= start && Date.parse(m.at) < end),
          total = sumMoney(all.map((m) => m.amountMinor)),
          value = sumMoney(period.map((m) => m.amountMinor));
        return (
          <section className="renewal-card" key={g.id}>
            <h2 className="text-lg font-bold">{g.name}</h2>
            <div className="renewal-big">{moneyLabel(total)}</div>
            <p className="renewal-chart-note">
              Поточний прогрес за записаними внесками · ціль {moneyLabel(g.targetMinor)}
            </p>
            <div className="renewal-progress mt-3">
              <span
                style={{
                  width: `${g.targetMinor ? Math.min(100, Math.max(0, (total / g.targetMinor) * 100)) : 0}%`,
                  background: 'var(--color-pos)',
                }}
              />
            </div>
            <div className="renewal-metrics">
              <Metric label="Чисті внески за період" value={value} />
              <Metric
                label="Поповнено за період"
                value={sumMoney(period.filter((m) => m.amountMinor > 0).map((m) => m.amountMinor))}
              />
              <Metric
                label="Повернено за період"
                value={-sumMoney(period.filter((m) => m.amountMinor < 0).map((m) => m.amountMinor))}
              />
              <Metric
                label="З них перекази назовні"
                value={sumMoney(
                  period.filter((m) => m.movementKind === 'external').map((m) => m.amountMinor),
                )}
              />
            </div>
            <AnalyticsBars
              label={`Чисті внески на ${g.name}`}
              points={data.daily
                .map((d) => ({
                  key: d.date,
                  label: d.date.slice(8) + '.' + d.date.slice(5, 7),
                  amountMinor: sumMoney(
                    period
                      .filter((m) => kyivParts(Date.parse(m.at)).date === d.date)
                      .map((m) => m.amountMinor),
                  ),
                }))
                .filter((p) => p.amountMinor !== 0)}
            />
            <p className="renewal-chart-note">
              Внески й резерви на цілі не є особистими витратами. Прогрес за обліком не гарантує
              поточного балансу банківської банки.
            </p>
          </section>
        );
      })}
      {!finance.goals.length && (
        <p className="renewal-muted">Створи ціль у фінансах, щоб відстежувати внески.</p>
      )}
    </>
  );
}
export function TaxiAnalytics({
  data,
  onWeek,
}: {
  data: FinanceAnalytics;
  onWeek: (key?: string) => void;
}) {
  const r = data.report;
  return (
    <>
      <section className="renewal-card">
        <h2 className="text-lg font-bold">Таксі · обрані календарні дати</h2>
        <div className="renewal-metrics">
          <Metric label="Зароблено за формулою" value={r.taxiEarnedMinor} />
          <Metric label="Різниця фактичних розрахунків" value={r.settlementDifferenceMinor} />
        </div>
        <p className="renewal-chart-note mt-3">
          Ці суми враховують записи й розрахунки в межах дат звіту. Готівка, отримана від пасажирів,
          не дорівнює власному заробітку.
        </p>
        <button className="renewal-secondary w-full mt-3" onClick={() => onWeek()}>
          Усі перезмінки й записи змін
        </button>
      </section>
      <section className="renewal-card">
        <h2 className="font-bold">Повні робочі тижні</h2>
        <p className="renewal-chart-note mt-2">
          Тижні, що перетинають дати звіту: понеділок 13:00 — наступний понеділок 13:00, Київ. Нижче
          суми за весь робочий тиждень.
        </p>
        <AnalyticsBars
          label="Заробіток за повні робочі тижні"
          points={[...r.taxiWeeks].reverse().map((w) => ({
            key: w.key,
            label: w.key.slice(8) + '.' + w.key.slice(5, 7),
            amountMinor: w.earnedMinor,
          }))}
          onSelect={(key) => onWeek(key || undefined)}
        />
        {r.taxiWeeks.map((w) => (
          <details className="renewal-inset mt-3" key={w.key}>
            <summary className="renewal-link">
              Від {w.key} · {moneyLabel(w.earnedMinor)}
            </summary>
            <div className="renewal-metrics">
              <Metric label="Брудна каса" value={w.grossMinor} />
              <Metric label="Чиста каса після комісії" value={w.netCashMinor} />
              <Metric label="Повна комісія" value={w.commissionMinor} />
              <Metric label="Пальне парку" value={w.fuelMinor} />
              <Metric label="Чайові до поділу" value={w.tipsMinor} />
              <Metric label="Розрахунок за формулою" value={w.expectedMinor} />
              <Metric label="Фактичний розрахунок" value={w.actualMinor} />
              <Metric label="Різниця" value={w.differenceMinor} />
            </div>
            {!w.complete && (
              <p className="text-neg text-sm mt-3">Бракує комісії або отриманої готівки.</p>
            )}
            <button className="renewal-secondary mt-3" onClick={() => onWeek(w.key)}>
              Записи й пояснення формули
            </button>
          </details>
        ))}
        {!r.taxiWeeks.length && (
          <p className="renewal-muted mt-3">Записаних змін за ці дати немає.</p>
        )}
      </section>
    </>
  );
}
export function AccountAnalytics({ finance, nowMs }: { finance: Finance; nowMs: number }) {
  const view = financeView(finance, 7, nowMs),
    unknown = finance.accounts.some((a) => a.currency === 'UAH' && a.balanceMinor == null);
  return (
    <>
      <section className="renewal-card analytics-hero">
        <p className="renewal-muted">Власні гривневі кошти · поточні дані</p>
        <div className="renewal-big">{unknown ? 'Потрібне уточнення' : moneyLabel(view.owned)}</div>
        <div className="renewal-metrics">
          <Metric label="Залишити для парку" value={finance.reserveMinor} />
          <Metric label="Внутрішній резерв на цілі" value={view.allocated} />
          <Metric label="Вільні кошти" value={view.unknownBalances ? null : view.available} />
        </div>
      </section>
      {finance.accounts.map((a) => (
        <section className="renewal-card" key={a.id}>
          <h2 className="font-bold">{a.name}</h2>
          <div className="analytics-row">
            <span>Власні кошти</span>
            <b>
              {a.balanceMinor == null ? 'Не підтверджено' : moneyLabel(a.balanceMinor, a.currency)}
            </b>
          </div>
          {a.kind === 'mono' && (
            <>
              <div className="analytics-row">
                <span>Доступно з лімітом</span>
                <b>
                  {a.availableMinor == null ? 'Невідомо' : moneyLabel(a.availableMinor, a.currency)}
                </b>
              </div>
              <div className="analytics-row">
                <span>Кредитний ліміт</span>
                <b>
                  {a.creditLimitMinor == null
                    ? 'Невідомо'
                    : moneyLabel(a.creditLimitMinor, a.currency)}
                </b>
              </div>
              <div className="analytics-row">
                <span>Використано кредиту</span>
                <b>
                  {a.balanceMinor == null
                    ? 'Невідомо'
                    : moneyLabel(Math.max(0, -a.balanceMinor), a.currency)}
                </b>
              </div>
            </>
          )}
          <p className="renewal-chart-note mt-3">
            {a.asOf
              ? `Оновлено ${new Date(a.asOf).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' })}`
              : 'Початковий або ручний залишок'}
          </p>
        </section>
      ))}
      <p className="renewal-chart-note">
        Історичний графік загальних залишків з’явиться після погодження збереження їхніх знімків.
        Поточні ліміти не застосовуються заднім числом до старих балансів.
      </p>
    </>
  );
}
