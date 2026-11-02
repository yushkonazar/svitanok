import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { fetchWeeklyReports } from '../../api/client.ts';
import type { WeeklyReports } from '../../api/weekly-report-schema.ts';
import { PageHeading } from '../ui/PageHeading.tsx';
import { ErrorState, LoadingSkeleton } from '../ui/states.tsx';

const statusLabels = {
  ready: 'Готовий огляд',
  partial: 'Частковий огляд',
  failed: 'Не сформовано',
};
const money = (amount: number | null | undefined) =>
  amount == null
    ? 'Невідомо'
    : new Intl.NumberFormat('uk-UA', { style: 'currency', currency: 'UAH' }).format(amount / 100);
const date = (key: string) =>
  new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'short' }).format(
    new Date(`${key}T12:00:00Z`),
  );
const time = (at: string | null | undefined) =>
  at
    ? new Intl.DateTimeFormat('uk-UA', {
        timeZone: 'Europe/Kyiv',
        dateStyle: 'short',
        timeStyle: 'short',
      }).format(new Date(at))
    : 'Невідомо';
const metricLabels: Record<string, string> = {
  'morning.energy': 'Ранкова енергія',
  'evening.energy': 'Вечірня енергія',
  'morning.mood': 'Ранковий настрій',
  'evening.mood': 'Вечірній настрій',
  'evening.dayScore': 'Оцінка дня',
  'morning.sleepMinutesV3': 'Сон, хв',
  sleepHours: 'Сон, год',
  dayScore: 'Оцінка дня',
};
const lifecycleLabels: Record<string, string> = {
  completed: 'Виконано вчасно',
  'completed-late': 'Виконано із запізненням',
  missed: 'Не виконано вчасно',
  scheduled: 'Заплановано',
  ready: 'Очікує виконання',
  'in-progress': 'У роботі',
  excepted: 'Виняток',
  draft: 'Чернетка',
};
type Report = NonNullable<WeeklyReports['report']>;
const sectionNames = {
  personal: 'ТВІЙ СТАН',
  plan: 'СПРАВИ Й РЕЗУЛЬТАТИ',
  finance: 'ГРОШІ Й РІШЕННЯ',
};
function ReportAnalysis({ report }: { report: Report }) {
  const analysis = report.analysis;
  if (!analysis?.sections.length)
    return (
      <section className="renewal-card">
        <p className="whitespace-pre-wrap text-sm leading-relaxed [overflow-wrap:anywhere]">
          {report.text}
        </p>
      </section>
    );
  return (
    <>
      {analysis.sections.map((section) => (
        <section
          key={section.kind}
          className={`renewal-card weekly-insight weekly-insight-${section.kind}`}
        >
          <p className="renewal-eyebrow">{sectionNames[section.kind]}</p>
          <h2>{section.title}</h2>
          {section.paragraphs.map((paragraph, i) => (
            <p key={i} className="weekly-insight-copy">
              {paragraph}
            </p>
          ))}
          {section.evidence.length > 0 && (
            <details className="weekly-insight-evidence">
              <summary>На чому ґрунтується висновок</summary>
              <div>
                {section.evidence.map((item, i) => (
                  <span key={i}>
                    <small>{item.label}</small>
                    <b>{item.value}</b>
                  </span>
                ))}
              </div>
            </details>
          )}
          <Link
            className="renewal-link mt-4 inline-block"
            to={
              section.kind === 'finance'
                ? `/finance?analytics=expenses&from=${report.from}&to=${report.to}`
                : section.kind === 'personal'
                  ? '/stats'
                  : '/plan'
            }
          >
            {section.kind === 'finance'
              ? 'Операції цього тижня'
              : section.kind === 'personal'
                ? 'Мій стан'
                : 'Переглянути План'}{' '}
            →
          </Link>
        </section>
      ))}
      {analysis.actions.length > 0 && (
        <section className="renewal-card weekly-next">
          <p className="renewal-eyebrow">НА НАСТУПНИЙ ТИЖДЕНЬ</p>
          <h2>Що варто спробувати</h2>
          {analysis.actions.map((action, i) => (
            <p key={i}>
              <span aria-hidden="true">{i + 1}</span>
              {action}
            </p>
          ))}
        </section>
      )}
    </>
  );
}
function Value({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div className="flex min-w-0 flex-wrap justify-between gap-x-4 gap-y-1 py-1 text-sm">
      <span className="text-tx2">{label}</span>
      <span className="font-semibold [overflow-wrap:anywhere]">{value ?? 'Невідомо'}</span>
    </div>
  );
}
function ReportDetails({ report }: { report: Report }) {
  const details = report.details;
  if (!details)
    return (
      <p className="renewal-chart-note">
        Для цього старого огляду збережено лише текст. Дані доступні у відповідних розділах
        застосунку.
      </p>
    );
  const plan = details.plan,
    finance = details.finance;
  const financePath = `/finance?analytics=expenses&from=${report.from}&to=${report.to}`;
  return (
    <div className="flex flex-col gap-4">
      <details className="renewal-card">
        <summary className="cursor-pointer font-bold">Справи й результати</summary>
        <div className="mt-4">
          {plan?.summary ? (
            <>
              <Value label="Прийняті обіцянки" value={plan.summary.acceptedCommitments} />
              <Value label="Унікальні результати" value={plan.summary.distinctResults} />
              <Value label="Завершені результати" value={plan.summary.completedDistinctResults} />
              <Value label="Обіцянки виконано вчасно" value={plan.summary.lifecycle?.completed} />
              <Value
                label="Виконано із запізненням"
                value={plan.summary.lifecycle?.['completed-late']}
              />
              <p className="renewal-chart-note mt-2">
                Фактичне виконання враховано окремо від вчасності та XP. Продовження може мати
                спільний результат.
              </p>
              {!!plan.tasks?.length && (
                <ul className="mt-4 space-y-3">
                  {plan.tasks.map((task, i) => (
                    <li key={i} className="min-w-0 text-sm">
                      <span className="[overflow-wrap:anywhere]">{task.title}</span>
                      <p className="text-xs text-tx3">
                        {lifecycleLabels[task.lifecycle ?? ''] ?? 'Стан не визначено'}
                        {task.dueAt ? ` · строк ${time(task.dueAt)}` : ''}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <p className="renewal-chart-note">
              Підсумки Плану не отримано. Це не означає відсутності виконаних справ.
            </p>
          )}
          <Link className="mt-4 inline-block text-sm font-bold text-a2" to="/plan">
            Відкрити План →
          </Link>
        </div>
      </details>
      <details className="renewal-card">
        <summary className="cursor-pointer font-bold">Особисті спостереження</summary>
        <div className="mt-4 space-y-4">
          {details.personalPeriods?.current ? (
            <>
              <p className="renewal-chart-note">
                Середні та кількість відповідей за збережений період. Версії анкет показано окремо.
              </p>
              {(['legacy', 'observationsV2', 'observationsV3'] as const).map((version, index) => {
                const metrics = Object.entries(
                  details.personalPeriods?.current?.[version] ?? {},
                ).filter(
                  ([key, value]) =>
                    metricLabels[key] &&
                    (value.numericN ?? value.n ?? 0) > 0 &&
                    value.average != null,
                );
                if (!metrics.length) return null;
                return (
                  <div key={version}>
                    <h3 className="mb-2 text-xs font-semibold text-tx3">
                      {['Попередня анкета', 'Анкета v2', 'Анкета v3'][index]}
                    </h3>
                    {metrics.map(([key, value]) => (
                      <Value
                        key={key}
                        label={metricLabels[key] ?? key}
                        value={`${new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 1 }).format(value.average!)} · ${value.numericN ?? value.n} відповідей`}
                      />
                    ))}
                  </div>
                );
              })}
            </>
          ) : (
            <p className="renewal-chart-note">Зіставні особисті підсумки не отримано.</p>
          )}
          <Link className="inline-block text-sm font-bold text-a2" to="/stats">
            Переглянути мій стан →
          </Link>
        </div>
      </details>
      <details className="renewal-card">
        <summary className="cursor-pointer font-bold">Фінанси за період</summary>
        <div className="mt-4">
          {finance?.summary ? (
            <>
              <Value label="Обліковані витрати" value={money(finance.summary.expenseMinor)} />
              <Value
                label="Банківські записи"
                value={money(finance.sourceTotals?.mono?.expenseMinor)}
              />
              <Value
                label="Ручні записи"
                value={money(finance.sourceTotals?.manual?.expenseMinor)}
              />
              <Value
                label="Підтверджені витрати"
                value={money(finance.review?.outflows?.confirmedExpenseMinor)}
              />
              <Value
                label="Очікувані, включені до суми"
                value={money(finance.review?.outflows?.pendingExpenseMinor)}
              />
              {finance.comparison?.complete ? (
                <Value
                  label="Середнє 4 попередніх тижнів"
                  value={money(finance.comparison.averageExpenseMinor)}
                />
              ) : finance.comparison?.previousWeek?.complete ? (
                <Value
                  label="Попередній тиждень"
                  value={money(finance.comparison.previousWeek.expenseMinor)}
                />
              ) : (
                <p className="renewal-chart-note mt-2">Надійної бази порівняння немає.</p>
              )}
              {finance.categoryBreakdown && (
                <div className="mt-4 border-t border-glassb pt-3">
                  {finance.categoryBreakdown.top?.map((row, i) => (
                    <Value
                      key={i}
                      label={row.category ?? 'Категорія'}
                      value={money(row.amountMinor)}
                    />
                  ))}
                  <Value
                    label="Решта категорій"
                    value={money(finance.categoryBreakdown.rest?.amountMinor)}
                  />
                  <Value
                    label="Інше"
                    value={money(finance.categoryBreakdown.otherCategory?.amountMinor)}
                  />
                </div>
              )}
              {finance.context && (
                <div className="mt-4 border-t border-glassb pt-3">
                  <p className="renewal-chart-note mb-2">
                    Поточний знімок коштів, збережений під час формування:{' '}
                    {time(finance.context.asOf)}. Це не історичний баланс на кінець тижня.
                  </p>
                  <Value label="Власні кошти" value={money(finance.context.balances?.ownedMinor)} />
                  <Value
                    label="Після резервів"
                    value={money(finance.context.reserves?.availableAfterReservesMinor)}
                  />
                  <Value label="Найближчі платежі" value={finance.context.upcoming?.count} />
                  {finance.context.upcoming?.payments?.map((payment, i) => (
                    <Value
                      key={i}
                      label={`${payment.name ?? 'Платіж'}${payment.date ? ` · ${date(payment.date)}` : ''}`}
                      value={money(payment.amountMinor)}
                    />
                  ))}
                </div>
              )}
            </>
          ) : (
            <p className="renewal-chart-note">
              Фінансовий підсумок не отримано. Невідома сума не є нулем.
            </p>
          )}
          <Link className="mt-4 inline-block text-sm font-bold text-a2" to={financePath}>
            Операції та уточнення →
          </Link>
        </div>
      </details>
      <details className="renewal-card">
        <summary className="cursor-pointer font-bold">Робота системи</summary>
        <div className="mt-4">
          <Value label="Прогони за тиждень" value={details.system?.runs?.total} />
          <Value label="Помилки прогонів" value={details.system?.runs?.failed} />
          <Value label="Невдалі виклики інструментів" value={details.system?.toolCalls?.failed} />
          {details.system?.costs?.month && (
            <>
              <Value
                label="Відома місячна оцінка"
                value={
                  details.system.costs.month.estimatedUsd == null
                    ? 'Невідомо'
                    : `$${details.system.costs.month.estimatedUsd.toFixed(2)}`
                }
              />
              <Value
                label="Подій із відомою ціною"
                value={`${details.system.costs.month.knownCostRecords ?? '—'} із ${details.system.costs.month.records ?? '—'}`}
              />
            </>
          )}
          <p className="renewal-chart-note mt-2">
            Журнальна оцінка може бути неповною. Це не рахунок провайдера.
          </p>
          <Link className="mt-4 inline-block text-sm font-bold text-a2" to="/system">
            Відкрити систему →
          </Link>
        </div>
      </details>
    </div>
  );
}
export function WeeklyReportScreen() {
  const [params, setParams] = useSearchParams();
  const week = params.get('week') ?? undefined;
  const query = useQuery({
    queryKey: ['weeklyReports', week],
    queryFn: () => fetchWeeklyReports(week),
    staleTime: 60000,
    retry: 1,
  });
  if (query.isLoading) return <LoadingSkeleton />;
  if (query.isError || !query.data)
    return (
      <ErrorState
        message={
          query.error instanceof Error ? query.error.message : 'Не вдалося завантажити огляди'
        }
        onRetry={() => query.refetch()}
      />
    );
  const { history, report } = query.data;
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <PageHeading
        eyebrow="РЕЗУЛЬТАТИ Й РІШЕННЯ"
        title="Твій тиждень."
        accent="Що за ним стоїть."
      />
      {!!history.length && (
        <label className="flex min-w-0 flex-col gap-2 text-sm text-tx2">
          Період
          <select
            className="min-w-0 max-w-full rounded-xl border border-glassb bg-glass px-3 py-3 text-tx"
            value={report?.from ?? week ?? ''}
            onChange={(event) => setParams({ week: event.target.value })}
          >
            {week && !history.some((row) => row.week === week) && (
              <option value={week}>{date(week)} · огляду немає</option>
            )}
            {history.map((row) => (
              <option key={row.week} value={row.week}>
                {date(row.week)} — {date(row.to)} · {statusLabels[row.status]}
              </option>
            ))}
          </select>
        </label>
      )}
      {report ? (
        <>
          <div className="weekly-report-state">
            <p className="text-xs font-semibold text-a2">{statusLabels[report.status]}</p>
            <p className="text-xs text-tx3">
              Сформовано {time(report.asOf ?? report.createdAt)} · Київ
            </p>
          </div>
          <ReportAnalysis report={report} />
          <details className="weekly-evidence-root">
            <summary className="renewal-link">Цифри та джерела огляду</summary>
            <div className="mt-4">
              <ReportDetails report={report} />
            </div>
          </details>
          {!!report.missing.length && (
            <details className="renewal-card">
              <summary className="cursor-pointer font-bold">Повнота даних</summary>
              <ul className="mt-4 space-y-2 text-sm text-tx2">
                {report.missing.map((reason, i) => (
                  <li key={i}>{reason}</li>
                ))}
              </ul>
            </details>
          )}
        </>
      ) : (
        <section className="renewal-card">
          <h2 className="font-bold">Огляду поки немає</h2>
          <p className="renewal-chart-note mt-2">
            Плановий огляд надходить у понеділок о 08:00 за завершений тиждень. Відкриття цієї
            сторінки лише читає збережене.
          </p>
        </section>
      )}
    </div>
  );
}
