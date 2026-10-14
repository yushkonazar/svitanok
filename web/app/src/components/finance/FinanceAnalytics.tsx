import { useState } from 'react';
import './finance-analytics.css';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { fetchFinanceAnalytics, isSessionExpired } from '../../api/client.ts';
import { FINANCE_QUERY } from '../../api/finance-hooks.ts';
import type { Finance } from '../../api/finance-schema.ts';
import type { AnalyticsRequest } from '../../api/finance-analytics-schema.ts';
import { kyivParts, shiftDate } from '../../../../core/finance/planning.mjs';
import { analyticsSelection } from '../../../../core/finance/analytics.mjs';
import { financeCategoryLabel } from '../../../../core/finance/categories.mjs';
import { moneyLabel } from '../../lib/financeView.ts';
import { useTick } from '../../lib/useTick.ts';
import { SessionExpired } from '../ui/SessionExpired.tsx';
import { Sheet } from '../ui/Sheet.tsx';
import { FinanceForm, type FinanceFormRequest } from './FinanceForm.tsx';
import { TaxiHistory } from './TaxiHistory.tsx';
import { PaymentDetail } from './PaymentDetail.tsx';
import { AnalyticsOperations, type ExplorerOptions } from './AnalyticsExplorer.tsx';
import { MerchantCatalog } from './MerchantCatalog.tsx';
import { financeRange } from './analytics-format.ts';
import { GoalHistory, type GoalHistoryRequest } from './GoalHistory.tsx';
import { periodWindow } from '../../lib/budgetPlanning.ts';
import { CategoryDonut, AnalyticsBars } from './AnalyticsCharts.tsx';
import { ExpenseCalendar } from './ExpenseCalendar.tsx';
import {
  OverviewAnalytics,
  BudgetAnalytics,
  PaymentAnalytics,
  GoalsAnalytics,
  TaxiAnalytics,
  AccountAnalytics,
  Metric,
} from './AnalyticsSections.tsx';
export const ANALYTICS_TABS = {
  overview: 'Огляд',
  expenses: 'Витрати',
  dynamics: 'Динаміка',
  budgets: 'Бюджети',
  payments: 'Платежі й борги',
  goals: 'Цілі',
  taxi: 'Таксі',
  accounts: 'Рахунки',
} as const;
export type AnalyticsTab = keyof typeof ANALYTICS_TABS;
export function analyticsPreset(preset: string, today = kyivParts(Date.now()).date) {
  if (preset === 'month')
    return { from: today.slice(0, 7) + '-01', to: today, comparison: 'month' as const };
  if (preset === 'previous-month') {
    const end = shiftDate(today.slice(0, 7) + '-01', -1);
    return { from: end.slice(0, 7) + '-01', to: end, comparison: 'month' as const };
  }
  return {
    from: shiftDate(today, preset === '30d' ? -29 : -6),
    to: today,
    comparison: 'adjacent' as const,
  };
}
export function FinanceAnalytics({
  finance,
  initialTab = 'expenses',
  initialRequest,
  demo = false,
  onBack,
  onRefreshBank,
  bankBusy = false,
  bankError = '',
}: {
  finance: Finance;
  initialTab?: AnalyticsTab;
  initialRequest?: AnalyticsRequest;
  demo?: boolean;
  onBack: () => void;
  onRefreshBank?: (id: string) => void;
  bankBusy?: boolean;
  bankError?: string;
}) {
  const nowMs = useTick(60000),
    today = kyivParts(nowMs).date;
  const [tab, setTab] = useState<AnalyticsTab>(initialTab),
    [preset, setPreset] = useState(initialRequest ? 'custom' : '7d'),
    [range, setRange] = useState(() =>
      initialRequest
        ? {
            from: initialRequest.from,
            to: initialRequest.to,
            comparison: initialRequest.comparison ?? 'adjacent',
          }
        : analyticsPreset('7d'),
    );
  const [filters, setFilters] = useState({
    account: initialRequest?.account ?? 'all',
    category: initialRequest?.category ?? '',
    merchant: initialRequest?.merchant ?? '',
    source: (initialRequest?.source ?? 'all') as NonNullable<AnalyticsRequest['source']>,
    status: (initialRequest?.status ?? 'all') as NonNullable<AnalyticsRequest['status']>,
  });
  const [filterOpen, setFilterOpen] = useState(false),
    [customOpen, setCustomOpen] = useState(false),
    [draft, setDraft] = useState({ from: range.from, to: range.to }),
    [dateError, setDateError] = useState('');
  const [otherOpen, setOtherOpen] = useState(false),
    [explanation, setExplanation] = useState<string | null>(null),
    [comparisonOpen, setComparisonOpen] = useState(false);
  const [explorer, setExplorer] = useState<
    ({ request: AnalyticsRequest } & ExplorerOptions) | null
  >(null);
  const [moreOpen, setMoreOpen] = useState(false),
    [catalogOpen, setCatalogOpen] = useState(false),
    [lineDay, setLineDay] = useState<string | null>(null);
  const [goalHistory, setGoalHistory] = useState<GoalHistoryRequest | null>(null);
  const [historyReturn, setHistoryReturn] = useState<GoalHistoryRequest | null>(null);
  const [taxiKey, setTaxiKey] = useState<string | null>(null),
    [paymentId, setPaymentId] = useState<string | null>(null),
    [form, setForm] = useState<FinanceFormRequest | null>(null);
  const [groupChoice, setGroup] = useState<'auto' | 'day' | 'week' | 'month'>('auto'),
    [selectedDay, setSelectedDay] = useState<string | null>(null),
    [merchantSort, setMerchantSort] = useState<'amount' | 'count'>('amount');
  const currentState = ['budgets', 'payments', 'accounts'].includes(tab),
    expensesScope = ['expenses', 'dynamics'].includes(tab);
  const request: AnalyticsRequest = {
    ...range,
    ...(expensesScope
      ? filters
      : { account: 'all', category: '', merchant: '', source: 'all', status: 'all' }),
  };
  const query = useQuery({
    queryKey: [
      ...FINANCE_QUERY,
      'analytics',
      request,
      finance.version,
      finance.bankSync?.completedAt,
    ],
    queryFn: () => fetchFinanceAnalytics(request),
    enabled: !currentState,
    staleTime: 60000,
    refetchOnWindowFocus: false,
    placeholderData: keepPreviousData,
  });
  const data = query.data;
  const group =
    groupChoice === 'auto'
      ? (data?.selection.days ?? 7) > 90
        ? 'month'
        : (data?.selection.days ?? 7) > 14
          ? 'week'
          : 'day'
      : groupChoice;
  const selectCategory = (category: string) => {
    if (query.isPlaceholderData) return;
    setExplorer({
      request: { ...request, category, merchant: '' },
      detail: true,
      title: financeCategoryLabel(category),
    });
    setOtherOpen(false);
  };
  const operations = (
    extra: Partial<AnalyticsRequest> = {},
    day?: string,
    kind = 'expense',
    options: ExplorerOptions = {},
  ) => {
    if (!query.isPlaceholderData)
      setExplorer({ request: { ...request, ...extra }, day, kind, ...options });
  };
  const changeRange = (value: string) => {
    setPreset(value);
    setRange(analyticsPreset(value, today));
    setSelectedDay(null);
    setLineDay(null);
  };
  const payment = finance.payments.find((p) => p.id === paymentId);
  const action = (r: FinanceFormRequest) => {
    setTaxiKey(null);
    setForm(r);
  };
  const periods = data ? financeRange(data.selection.from, data.selection.to) : '';
  const points = data
    ? data.daily.reduce<{ key: string; label: string; amountMinor: number }[]>((list, d) => {
        const key =
          group === 'month'
            ? d.date.slice(0, 7)
            : group === 'week'
              ? shiftDate(d.date, -((new Date(d.date + 'T12:00:00Z').getUTCDay() + 6) % 7))
              : d.date;
        const last = list.at(-1);
        if (last?.key === key) last.amountMinor += d.expenseMinor;
        else
          list.push({
            key,
            label:
              group === 'month'
                ? key.slice(5) + '.' + key.slice(2, 4)
                : key.slice(8) + '.' + key.slice(5, 7),
            amountMinor: d.expenseMinor,
          });
        return list;
      }, [])
    : [];
  return (
    <div className="renewal-finance finance-analytics flex flex-col gap-4">
      <button className="renewal-secondary self-start" onClick={onBack}>
        ← До фінансів
      </button>
      <div>
        <p className="renewal-eyebrow mb-2">ФІНАНСИ · ДЕТАЛЬНИЙ ПЕРЕГЛЯД</p>
        <h1 className="text-2xl font-bold">Аналітика та звіти</h1>
        <p className="renewal-muted mt-2">Від загальної суми до конкретної операції.</p>
      </div>
      {demo && (
        <p className="renewal-inset renewal-muted">
          Демонстраційна аналітика: умовні записи цього браузера. Справжні фінансові дані доступні в
          Mini App через Telegram.
        </p>
      )}
      <section className="analytics-controls" aria-label="Період і фільтри аналітики">
        {currentState ? (
          <p className="renewal-inset renewal-chart-note">
            Поточний стан на {today}. Історичні дати обираються у витратах, динаміці, цілях і таксі.
          </p>
        ) : (
          <>
            <div className="analytics-periods">
              {[
                ['7d', '7 днів'],
                ['30d', '30 днів'],
                ['month', 'Цей місяць'],
                ['previous-month', 'Минулий місяць'],
              ].map(([value, label]) => (
                <button
                  className="renewal-secondary"
                  aria-pressed={preset === value}
                  key={value}
                  onClick={() => changeRange(value!)}
                >
                  {label}
                </button>
              ))}
              <button
                className="renewal-secondary"
                aria-pressed={preset === 'custom'}
                onClick={() => {
                  setDraft({ from: range.from, to: range.to });
                  setDateError('');
                  setCustomOpen(true);
                }}
              >
                Власні дати
              </button>
            </div>
            <p className="renewal-chart-note mt-2">{financeRange(range.from, range.to)} · Київ</p>
          </>
        )}
        {expensesScope && (
          <div className="analytics-filter-actions">
            <label className="renewal-field">
              Рахунки
              <select
                value={filters.account}
                onChange={(e) => {
                  setFilters((f) => ({ ...f, account: e.target.value }));
                  setSelectedDay(null);
                }}
              >
                <option value="all">Усі рахунки</option>
                {finance.accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <button className="renewal-secondary" onClick={() => setFilterOpen(true)}>
              Фільтри
              {filters.source !== 'all' || filters.status !== 'all' || filters.merchant ? ' •' : ''}
            </button>
          </div>
        )}
        {expensesScope && (filters.category || filters.merchant) && (
          <div className="analytics-chips">
            {filters.category && (
              <button
                className="renewal-secondary"
                onClick={() => setFilters((f) => ({ ...f, category: '', merchant: '' }))}
              >
                {financeCategoryLabel(filters.category)} ×
              </button>
            )}
            {filters.merchant && (
              <button
                className="renewal-secondary"
                onClick={() => setFilters((f) => ({ ...f, merchant: '' }))}
              >
                {filters.merchant} ×
              </button>
            )}
          </div>
        )}
      </section>
      <nav className="analytics-tabs" aria-label="Розділи фінансової аналітики">
        {(['overview', 'expenses', 'dynamics'] as const).map((t) => (
          <button key={t} aria-pressed={tab === t} onClick={() => setTab(t)}>
            {ANALYTICS_TABS[t]}
          </button>
        ))}
        <button
          aria-label="Інші розділи аналітики"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen(true)}
        >
          Ще ▾
        </button>
      </nav>
      <p className="analytics-context">
        <b>{ANALYTICS_TABS[tab]}</b> ·{' '}
        {currentState ? 'Поточний стан' : expensesScope ? 'Вибраний облік' : 'Усі рахунки'}
        {expensesScope
          ? ` · ${filters.source === 'all' ? 'банк і ручні' : filters.source === 'mono' ? 'Monobank' : 'ручні записи'} · ${filters.status === 'all' ? 'усі статуси' : filters.status === 'confirmed' ? 'підтверджені' : 'hold без підтвердження'}`
          : ''}
      </p>
      {!currentState &&
        data &&
        !query.isPlaceholderData &&
        (data.quality.unclassifiedCount > 0 ||
          data.quality.pendingCount > 0 ||
          data.quality.possibleDuplicateCount > 0) && (
          <div className="analytics-chips">
            <button
              className="renewal-secondary"
              disabled={!data.quality.unclassifiedCount}
              onClick={() => operations({}, undefined, 'unclassified')}
            >
              Без типу: {data.quality.unclassifiedCount}
            </button>
            <button
              className="renewal-secondary"
              disabled={!data.quality.pendingCount}
              onClick={() => operations({ status: 'pending' }, undefined, 'all')}
            >
              Hold API: {data.quality.pendingCount}
            </button>
            {data.quality.possibleDuplicateCount > 0 && (
              <button
                className="renewal-secondary"
                onClick={() => operations({}, undefined, 'all', { issue: 'duplicates' })}
              >
                Перевірити схожі: {data.quality.possibleDuplicateCount}
              </button>
            )}
          </div>
        )}
      {!currentState && query.isFetching && (
        <p className="renewal-chart-note" role="status">
          Оновлюю підсумки…
          {query.isPlaceholderData && data ? ` Поки показано попередній вибір: ${periods}.` : ''}
        </p>
      )}
      {!currentState && isSessionExpired(query.error) && <SessionExpired />}
      {!currentState && query.error && !isSessionExpired(query.error) && (
        <div className="renewal-inset" role="alert">
          <p>{query.error instanceof Error ? query.error.message : 'Аналітика недоступна'}</p>
          <button className="renewal-secondary mt-3" onClick={() => void query.refetch()}>
            Повторити
          </button>
        </div>
      )}
      <div
        className="analytics-report flex flex-col gap-4"
        data-loading={!currentState && query.isPlaceholderData}
        inert={!currentState && query.isPlaceholderData}
        aria-hidden={!currentState && query.isPlaceholderData}
      >
        {tab === 'expenses' && data && (
          <>
            <section className="renewal-card analytics-hero" aria-label="Підсумок витрат">
              <p className="renewal-muted">
                {data.selection.category
                  ? financeCategoryLabel(data.selection.category)
                  : 'Особисті витрати'}
                {data.selection.merchant ? ` · ${data.selection.merchant}` : ''}
              </p>
              <output className="renewal-big" aria-label="Сума особистих витрат">
                {moneyLabel(data.summary.expenseMinor)}
              </output>
              {data.coverage.previousBeforeFirstRecord && (
                <p className="renewal-inset mt-3">
                  Попередній проміжок починається раніше найдавніших збережених записів. Відсоток
                  зміни не показано.
                </p>
              )}
              <button className="renewal-link" onClick={() => setComparisonOpen(true)}>
                {data.summary.changeMinor > 0 ? '+' : ''}
                {moneyLabel(data.summary.changeMinor)}
                {data.summary.changeBps != null
                  ? ` · ${(data.summary.changeBps / 100).toLocaleString('uk-UA', { maximumFractionDigits: 1 })}%`
                  : ''}{' '}
                до попереднього періоду ↗
              </button>
              <div className="renewal-metrics">
                <Metric label="Середнє за календарний день" value={data.summary.averageDayMinor} />
                <div className="renewal-metric">
                  <span className="renewal-muted">Кількість оплат</span>
                  <strong>{data.summary.count}</strong>
                </div>
                <Metric label="Середній платіж" value={data.summary.averagePaymentMinor} />
                <Metric label="Медіанний платіж" value={data.summary.medianMinor} />
              </div>
              <button className="renewal-link mt-3" onClick={() => setExplanation('expenses')}>
                Як пораховано ці цифри?
              </button>
            </section>
            <section className="renewal-card">
              <h2 className="text-lg font-bold">Куди пішли гроші</h2>
              {!data.selection.category ? (
                <CategoryDonut
                  rows={data.categories}
                  onSelect={selectCategory}
                  onOther={() => setOtherOpen(true)}
                />
              ) : (
                <button
                  className="renewal-secondary mt-3"
                  onClick={() => selectCategory(data.selection.category)}
                >
                  Деталі категорії ↗
                </button>
              )}
              {data.selection.category && (
                <button
                  className="renewal-link mt-3"
                  onClick={() => setFilters((f) => ({ ...f, category: '', merchant: '' }))}
                >
                  ← Усі категорії
                </button>
              )}
            </section>
            <section className="renewal-card">
              <div className="renewal-section-head flex-wrap">
                <h2 className="text-lg font-bold">Магазини й заклади</h2>
                <label className="renewal-field">
                  <span className="sr-only">Сортування продавців</span>
                  <select
                    value={merchantSort}
                    onChange={(e) => setMerchantSort(e.target.value as 'amount' | 'count')}
                  >
                    <option value="amount">За сумою</option>
                    <option value="count">За частотою</option>
                  </select>
                </label>
              </div>
              {[...data.merchants]
                .sort((a, b) =>
                  merchantSort === 'count' ? b.count - a.count : b.amountMinor - a.amountMinor,
                )
                .slice(0, 12)
                .map((m) => (
                  <button
                    className="analytics-operation"
                    key={m.merchant}
                    onClick={() => {
                      operations({ merchant: m.merchant }, undefined, 'expense', {
                        detail: true,
                        title: m.merchant,
                      });
                    }}
                  >
                    <span>
                      <b>{m.merchant || 'Без назви'}</b>
                      <small>
                        {m.count} оплат · середнє{' '}
                        {moneyLabel(Math.round(m.amountMinor / Math.max(1, m.count)))}
                      </small>
                    </span>
                    <strong>{moneyLabel(m.amountMinor)}</strong>
                  </button>
                ))}
              {!data.merchants.length && (
                <p className="renewal-muted mt-3">Операцій із відомою гривневою сумою немає.</p>
              )}
              <p className="renewal-chart-note mt-3">
                Рейтинг показує до 12 із {data.merchantCount} назв. Схожі назви різних закладів
                автоматично не зливаються.
              </p>
              <button
                className="renewal-secondary w-full mt-3"
                onClick={() => setCatalogOpen(true)}
              >
                Усі продавці · пошук і групи
              </button>
            </section>
            {data.summary.largest && (
              <section className="renewal-card">
                <h2 className="font-bold">Найбільша оплата</h2>
                <button
                  className="analytics-operation"
                  onClick={() =>
                    operations({}, undefined, 'all', {
                      transactionId: data.summary.largest!.id,
                      title: 'Найбільша оплата',
                    })
                  }
                >
                  <span>
                    <b>{data.summary.largest.description}</b>
                    <small>{kyivParts(Date.parse(data.summary.largest.at)).date}</small>
                  </span>
                  <strong>{moneyLabel(data.summary.largest.amountMinor)}</strong>
                </button>
              </section>
            )}
            <button
              className="renewal-button"
              disabled={query.isPlaceholderData}
              onClick={() => operations()}
            >
              Переглянути операції · {data.summary.count}
            </button>
          </>
        )}
        {tab === 'overview' && data && (
          <OverviewAnalytics data={data} onCategory={selectCategory} />
        )}
        {tab === 'dynamics' && data && (
          <>
            <section className="renewal-card">
              <h2 className="text-lg font-bold">Витрати за періодами</h2>
              <div className="renewal-segments mt-3">
                {(['auto', 'day', 'week', 'month'] as const).map((g) => (
                  <button
                    key={g}
                    aria-pressed={groupChoice === g}
                    onClick={() => {
                      setGroup(g);
                      setSelectedDay(null);
                    }}
                  >
                    {g === 'auto'
                      ? 'Авто'
                      : g === 'day'
                        ? 'Дні'
                        : g === 'week'
                          ? 'Тижні'
                          : 'Місяці'}
                  </button>
                ))}
              </div>
              <AnalyticsBars
                points={points}
                label="Особисті витрати, гривні"
                selected={selectedDay}
                onSelect={(key) => setSelectedDay(key || null)}
              />
              <button
                className="renewal-secondary w-full mt-3"
                onClick={() => {
                  if (group === 'day') operations({}, selectedDay ?? undefined);
                  else if (selectedDay) {
                    const end =
                      group === 'week'
                        ? shiftDate(selectedDay, 6)
                        : shiftDate(
                            selectedDay + '-01',
                            new Date(
                              Number(selectedDay.slice(0, 4)),
                              Number(selectedDay.slice(5)),
                              0,
                            ).getDate() - 1,
                          );
                    const start = group === 'month' ? selectedDay + '-01' : selectedDay;
                    operations({
                      from: start < range.from ? range.from : start,
                      to: end > range.to ? range.to : end,
                    });
                  } else operations();
                }}
              >
                Операції {selectedDay ? 'обраного проміжку' : 'за період'}
              </button>
            </section>
            <ExpenseCalendar daily={data.daily} onSelect={(date) => operations({}, date)} />
            <section className="renewal-card">
              <h2 className="font-bold">Накопичені витрати</h2>
              <AnalyticsBars
                label="Накопичена сума витрат за днями"
                mode="line"
                selected={lineDay}
                pickerLabel="День накопиченої суми"
                onSelect={(key) => setLineDay(key || null)}
                points={data.daily.map((d) => ({
                  key: d.date,
                  label: d.date.slice(8) + '.' + d.date.slice(5, 7),
                  amountMinor: d.cumulativeMinor,
                }))}
              />
              <p className="renewal-chart-note">
                Кожна точка — усі витрати від початку періоду до цього дня.
              </p>
              {lineDay && (
                <button
                  className="renewal-secondary w-full mt-3"
                  onClick={() => operations({ to: lineDay })}
                >
                  Операції до обраного дня
                </button>
              )}
            </section>
            <section className="renewal-card">
              <h2 className="font-bold">Ритм тижня</h2>
              <AnalyticsBars
                label="Середні витрати за днем тижня"
                pickerLabel="День тижня"
                onSelect={(key) => {
                  if (key)
                    operations({}, undefined, 'expense', {
                      weekday: key,
                      title: [
                        'Понеділки',
                        'Вівторки',
                        'Середи',
                        'Четверги',
                        'П’ятниці',
                        'Суботи',
                        'Неділі',
                      ][Number(key)],
                    });
                }}
                points={data.weekdays
                  .filter((d) => d.days > 0)
                  .map((d) => ({
                    key: String(d.day),
                    label: ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'][d.day]!,
                    amountMinor: d.averageMinor,
                  }))}
              />
              <p className="renewal-chart-note">
                Середнє за всі календарні дні відповідного типу, включно з днями без записаних
                витрат. Це спостереження за вибраним періодом, а не висновок про звичку. Кількість
                днів у вибірці:{' '}
                {data.weekdays
                  .filter((d) => d.days > 0)
                  .map((d) => `${['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'][d.day]} ${d.days}`)
                  .join(' · ')}
                .
              </p>
            </section>
          </>
        )}
        {tab === 'budgets' && (
          <BudgetAnalytics
            finance={finance}
            nowMs={nowMs}
            onBudget={(b) => {
              const w = periodWindow(b.period, today);
              if (b.purpose === 'saving')
                setGoalHistory({ goalIds: b.goalIds, from: w.start, to: today, title: b.category });
              else
                setExplorer({
                  request: {
                    ...range,
                    from: w.start,
                    to: today,
                    account: 'all',
                    category: '',
                    merchant: '',
                    source: 'all',
                    status: 'all',
                  },
                  categories: JSON.stringify(b.categories),
                  title: b.category,
                });
            }}
          />
        )}
        {tab === 'payments' && (
          <PaymentAnalytics finance={finance} nowMs={nowMs} onPayment={setPaymentId} />
        )}
        {tab === 'goals' && data && (
          <GoalsAnalytics
            finance={finance}
            data={data}
            onHistory={(goalId, date) =>
              setGoalHistory({
                goalIds: [goalId],
                from: date ?? range.from,
                to: date ?? range.to,
                title: finance.goals.find((g) => g.id === goalId)?.name,
              })
            }
          />
        )}
        {tab === 'taxi' && data && (
          <TaxiAnalytics data={data} onWeek={(key) => setTaxiKey(key ?? '')} />
        )}
        {tab === 'accounts' && (
          <AccountAnalytics
            finance={finance}
            nowMs={nowMs}
            onAction={action}
            onRefresh={onRefreshBank}
            busy={bankBusy}
          />
        )}
        {(bankBusy || finance.bankSync?.active) && (
          <p role="status" className="renewal-inset">
            Monobank оновлюється · {finance.bankSync?.done ?? 0}/{finance.bankSync?.total ?? 1}{' '}
            етапів. Підсумки оновляться після звірки.
          </p>
        )}
        {bankError && (
          <p role="alert" className="text-neg">
            {bankError}
          </p>
        )}
        {!currentState && data && (
          <details className="renewal-card">
            <summary className="renewal-link">Якість і джерела даних</summary>
            <div className="flex flex-col gap-3 mt-4">
              <p className="renewal-chart-note">
                Зібрано{' '}
                {new Date(data.generatedAt).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' })}.
                Відкриття звіту не запускає оновлення Monobank.
              </p>
              <button
                className="analytics-quality"
                disabled={!data.quality.unclassifiedCount}
                onClick={() => operations({}, undefined, 'unclassified')}
              >
                Без визначеного типу: {data.quality.unclassifiedCount}
              </button>
              <button
                disabled={!data.quality.unknownCurrencyCount}
                className="analytics-quality"
                onClick={() => operations({}, undefined, 'all', { issue: 'unknown-uah' })}
              >
                Без гривневої суми: {data.quality.unknownCurrencyCount}
              </button>
              <button
                className="analytics-quality"
                disabled={!data.quality.pendingCount}
                onClick={() => operations({ status: 'pending' }, undefined, 'all')}
              >
                Hold без підтвердження власника: {data.quality.pendingCount} ·{' '}
                {moneyLabel(data.quality.pendingMinor)}
              </button>
              <p className="renewal-chart-note">
                Схожі покупки вже перевірено: {data.quality.resolvedDuplicateCount}.
              </p>
              {(
                [
                  ['duplicates', 'Схожі списання', data.quality.possibleDuplicateCount],
                  ['direction', 'Напрямок суми', data.quality.invalidDirectionCount],
                  ['changed', 'Банк змінив суму', data.quality.amountChangedCount],
                ] as const
              ).map(([issue, label, count]) => (
                <button
                  className="analytics-quality"
                  disabled={!count}
                  key={issue}
                  onClick={() => operations({}, undefined, 'all', { issue })}
                >
                  {label}: {count}
                </button>
              ))}
              <p className="renewal-chart-note">
                Банківська історія зберігається до {data.coverage.bankRetentionDays} днів.
                {data.coverage.oldestTransactionAt
                  ? ` Найдавніший збережений запис: ${kyivParts(Date.parse(data.coverage.oldestTransactionAt)).date}.`
                  : ''}
                {data.coverage.beyondBankRetention
                  ? ' Порівняння виходить за цей строк і може бути неповним.'
                  : ''}
              </p>
              <button
                className="renewal-secondary"
                onClick={() => void query.refetch()}
                disabled={query.isFetching}
              >
                {query.isFetching ? 'Оновлюю звіт…' : 'Оновити звіт'}
              </button>
            </div>
          </details>
        )}
      </div>
      {customOpen && (
        <Sheet label="Дати фінансового звіту" onClose={() => setCustomOpen(false)}>
          <form
            className="renewal-finance flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              try {
                analyticsSelection(new URLSearchParams(draft), nowMs);
                setRange({ ...draft, comparison: 'adjacent' });
                setPreset('custom');
                setCustomOpen(false);
                setSelectedDay(null);
              } catch (err) {
                setDateError(err instanceof Error ? err.message : 'Перевір дати');
              }
            }}
          >
            <h2 className="text-xl font-bold">Власний період</h2>
            {(['from', 'to'] as const).map((key) => (
              <label className="renewal-field" key={key}>
                {key === 'from' ? 'Від' : 'До включно'}
                <input
                  type="date"
                  max={today}
                  value={draft[key]}
                  required
                  onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                />
              </label>
            ))}
            <p className="renewal-chart-note">
              До 366 днів. Порівняння з попереднім проміжком такої самої довжини.
            </p>
            {dateError && (
              <p role="alert" className="text-neg">
                {dateError}
              </p>
            )}
            <button className="renewal-button">Показати</button>
            <button
              type="button"
              className="renewal-secondary"
              onClick={() => setCustomOpen(false)}
            >
              Скасувати
            </button>
          </form>
        </Sheet>
      )}
      {filterOpen && (
        <Sheet label="Фільтри фінансової аналітики" onClose={() => setFilterOpen(false)}>
          <div className="renewal-finance flex flex-col gap-4">
            <h2 className="text-xl font-bold">Фільтри витрат</h2>
            <label className="renewal-field">
              Категорія
              <select
                value={filters.category}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, category: e.target.value, merchant: '' }))
                }
              >
                <option value="">Усі категорії</option>
                {[
                  ...new Set([
                    ...finance.categories,
                    ...(data?.categories.map((c) => c.category) ?? []),
                  ]),
                ].map((c) => (
                  <option key={c} value={c}>
                    {financeCategoryLabel(c)}
                  </option>
                ))}
              </select>
            </label>
            <label className="renewal-field">
              Джерело
              <select
                value={filters.source}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, source: e.target.value as typeof filters.source }))
                }
              >
                <option value="all">Банк і ручні записи</option>
                <option value="mono">Лише Monobank</option>
                <option value="manual">Лише ручний облік</option>
              </select>
            </label>
            <label className="renewal-field">
              Підтвердження
              <select
                value={filters.status}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, status: e.target.value as typeof filters.status }))
                }
              >
                <option value="all">Усі · як в основному обліку</option>
                <option value="confirmed">Без hold або підтверджені мною</option>
                <option value="pending">Hold без мого підтвердження</option>
              </select>
            </label>
            <p className="renewal-chart-note">
              Hold — позначка API, а не перевірка того, що показує застосунок банку. Підтвердження
              власника зберігається окремо. Перекази й резерви виключені з витрат у всіх режимах.
            </p>
            <button className="renewal-button" onClick={() => setFilterOpen(false)}>
              Готово
            </button>
            <button
              className="renewal-secondary"
              onClick={() =>
                setFilters({
                  account: 'all',
                  category: '',
                  merchant: '',
                  source: 'all',
                  status: 'all',
                })
              }
            >
              Скинути фільтри
            </button>
          </div>
        </Sheet>
      )}
      {otherOpen && data && (
        <Sheet label="Усі категорії витрат" onClose={() => setOtherOpen(false)}>
          <div className="renewal-finance">
            <h2 className="text-xl font-bold mb-4">Усі категорії</h2>
            {data.categories.map((c) => (
              <button
                className="analytics-operation"
                key={c.category}
                onClick={() => selectCategory(c.category)}
              >
                <span>{financeCategoryLabel(c.category)}</span>
                <b>{moneyLabel(c.amountMinor)}</b>
              </button>
            ))}
          </div>
        </Sheet>
      )}
      {explanation && data && (
        <Sheet label="Як пораховано витрати" onClose={() => setExplanation(null)}>
          <div className="renewal-finance flex flex-col gap-4">
            <h2 className="text-xl font-bold">Як пораховано</h2>
            <p>
              Особисті витрати — суми записів із типом «Витрата», відомою гривневою сумою та
              вибраними фільтрами за {periods}.
            </p>
            <p>
              Власні перекази, корекції залишку, готівка парку та внески на цілі не додаються.
              Прив’язана банківська оплата враховується один раз.
            </p>
            <p>
              Середнє за календарний день = {moneyLabel(data.summary.expenseMinor)} ÷{' '}
              {data.selection.days} днів. Середній платіж використовує {data.summary.count} оплат;
              медіана — середня за порядком величина.
            </p>
            <p>
              Повернення покупки не розпізнається за позитивною сумою автоматично. Якщо воно не
              пов’язане з початковою витратою в обліку, воно не зменшує її заднім числом.
            </p>
            <button className="renewal-secondary" onClick={() => setExplanation(null)}>
              Зрозуміло
            </button>
          </div>
        </Sheet>
      )}
      {comparisonOpen && data && (
        <Sheet label="Порівняння витрат" onClose={() => setComparisonOpen(false)}>
          <div className="renewal-finance flex flex-col gap-4">
            <h2 className="text-xl font-bold">Порівняння витрат</h2>
            <p className="renewal-chart-note">
              {data.selection.from} — {data.selection.to} проти {data.selection.previousFrom} —{' '}
              {data.selection.previousTo}. Ті самі рахунки, категорії, продавець і статус.
            </p>
            <AnalyticsBars
              label="Витрати за категоріями у двох періодах"
              comparison
              onSelect={(category) => {
                if (category) {
                  setComparisonOpen(false);
                  selectCategory(category);
                }
              }}
              points={[...data.categories]
                .sort((a, b) => Math.abs(b.deltaMinor) - Math.abs(a.deltaMinor))
                .slice(0, 8)
                .map((c, i) => ({
                  key: c.category,
                  label: String(i + 1),
                  amountMinor: c.amountMinor,
                  previousMinor: c.previousMinor,
                }))}
            />
            {[...data.categories]
              .sort((a, b) => Math.abs(b.deltaMinor) - Math.abs(a.deltaMinor))
              .slice(0, 8)
              .map((c, i) => (
                <button
                  className="analytics-operation"
                  key={c.category}
                  onClick={() => {
                    setComparisonOpen(false);
                    selectCategory(c.category);
                  }}
                >
                  <span>
                    {i + 1}. {financeCategoryLabel(c.category)}
                  </span>
                  <b>
                    {c.deltaMinor > 0 ? '+' : ''}
                    {moneyLabel(c.deltaMinor)}
                  </b>
                </button>
              ))}
            {data.summary.changeBps == null && (
              <p className="renewal-chart-note">
                Відсоток зміни не визначається за нульової бази або неповного порівняння.
              </p>
            )}
            <button className="renewal-secondary" onClick={() => setComparisonOpen(false)}>
              До діаграм
            </button>
          </div>
        </Sheet>
      )}
      {explorer && (
        <AnalyticsOperations
          {...explorer}
          finance={finance}
          request={explorer.request}
          onClose={() => {
            setExplorer(null);
            if (historyReturn) {
              setGoalHistory(historyReturn);
              setHistoryReturn(null);
            }
          }}
        />
      )}
      {moreOpen && (
        <Sheet label="Розділи аналітики" onClose={() => setMoreOpen(false)}>
          <div className="renewal-finance">
            <h2 className="text-xl font-bold mb-3">Розділи аналітики</h2>
            {Object.entries(ANALYTICS_TABS).map(([key, label]) => (
              <button
                className="analytics-operation"
                aria-pressed={tab === key}
                key={key}
                onClick={() => {
                  setTab(key as AnalyticsTab);
                  setMoreOpen(false);
                }}
              >
                <span>{label}</span>
                <span>{tab === key ? '✓' : '↗'}</span>
              </button>
            ))}
          </div>
        </Sheet>
      )}
      {catalogOpen && (
        <MerchantCatalog
          request={request}
          finance={finance}
          onClose={() => setCatalogOpen(false)}
          onSelect={(merchant) => {
            setCatalogOpen(false);
            operations({ merchant }, undefined, 'expense', { detail: true, title: merchant });
          }}
        />
      )}
      {goalHistory && (
        <GoalHistory
          finance={finance}
          request={goalHistory}
          onClose={() => setGoalHistory(null)}
          onMove={(id) => {
            setGoalHistory(null);
            setForm({ kind: 'goal-move', id });
          }}
          onTransaction={(id, date, position) => {
            setHistoryReturn({ ...goalHistory, ...position });
            setGoalHistory(null);
            setExplorer({
              request: { from: date, to: date },
              kind: 'all',
              transactionId: id,
              title: 'Операція внеску',
              returnLabel: 'До історії внесків',
            });
          }}
        />
      )}
      {taxiKey !== null && !form && (
        <TaxiHistory
          finance={finance}
          initialKey={taxiKey || undefined}
          onClose={() => setTaxiKey(null)}
          onAction={action}
        />
      )}
      {payment && !form && (
        <Sheet label={payment.name} onClose={() => setPaymentId(null)}>
          <PaymentDetail
            payment={payment}
            onBack={() => setPaymentId(null)}
            onEdit={() => setForm({ kind: 'payment', id: payment.id })}
            onPay={() => setForm({ kind: 'payment-paid', id: payment.id })}
            onCloseDebt={() => setForm({ kind: 'payment-close', id: payment.id })}
            onCancel={() => setForm({ kind: 'payment-cancel', id: payment.id })}
          />
        </Sheet>
      )}
      {form && (
        <FinanceForm
          finance={finance}
          request={form}
          onClose={() => {
            setForm(null);
            setPaymentId(null);
          }}
        />
      )}
    </div>
  );
}
