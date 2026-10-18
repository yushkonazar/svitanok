import { version as appVersion } from '../../../package.json';
import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchSystem, type SystemSelection } from '../../api/client.ts';
import { inTelegram } from '../../telegram.ts';
import { PageHeading } from '../ui/PageHeading.tsx';
import { RequestDiagnostics } from '../ui/RequestDiagnostics.tsx';
import {
  ControlsPanel,
  ServiceCards,
  TasksPanel,
  UsagePanel,
  WorkersPanel,
  ReadWarning,
  money,
  time,
  states,
} from './SystemPanels.tsx';

const panels = {
  overview: 'Огляд',
  usage: 'Витрати API',
  services: 'Функції',
  events: 'Задачі',
  workers: 'Працівники',
  control: 'Керування',
};
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Kyiv' });
export function SystemScreen() {
  const [panel, setPanel] = useState<keyof typeof panels>('overview');
  const [selection, setSelection] = useState<SystemSelection>({ range: 'month' });
  const [custom, setCustom] = useState(false);
  const [from, setFrom] = useState(`${today().slice(0, 7)}-01`),
    [to, setTo] = useState(today());
  const [error, setError] = useState('');
  const [cursors, setCursors] = useState<(string | undefined)[]>([]);
  const forced = useRef(false);
  const query = useQuery({
    queryKey: ['system', selection],
    queryFn: () => fetchSystem(selection, forced.current),
    enabled: inTelegram(),
    staleTime: 60000,
    retry: false,
  });
  const data = query.data,
    usage = data?.usage?.data;
  async function refresh() {
    forced.current = true;
    try {
      await query.refetch();
    } finally {
      forced.current = false;
    }
  }
  function choose(next: SystemSelection) {
    setCursors([]);
    setSelection(next);
    setError('');
  }
  const attention = data
    ? [
        ...(data.brain?.data && ['down', 'desync', 'stale'].includes(data.brain.data.state)
          ? [{ id: 'brain', title: 'Сервіс асистента', detail: states[data.brain.data.state] }]
          : []),
        ...(data.brain?.data && ['degraded', 'unready'].includes(data.brain.data.modelState)
          ? [
              {
                id: 'model',
                title: 'Готовність моделі',
                detail: states[data.brain.data.modelState],
              },
            ]
          : []),
        ...(data.services?.data?.filter((s) =>
          ['degraded', 'stale', 'access', 'unavailable'].includes(s.state),
        ) ?? []),
      ]
    : [];
  return (
    <div className="system-screen flex flex-col gap-5">
      <PageHeading eyebrow="ПАНЕЛЬ ВЛАСНИКА" title="Система" accent="Світанку." />
      <p className="renewal-chart-note">
        Версія {appVersion}. Стан функцій, задачі й витрати. Час за Києвом. Перегляд не викликає
        моделі.
      </p>
      {!inTelegram() ? (
        <section className="renewal-card">
          <h2 className="font-semibold">Приватна панель</h2>
          <p className="renewal-chart-note mt-2">
            Відкрий Світанок в особистому чаті з ботом. Доступ має основний власник.
          </p>
        </section>
      ) : (
        <>
          <div className="system-nav" role="group" aria-label="Розділи системи">
            {Object.entries(panels).map(([id, label]) => (
              <button
                type="button"
                key={id}
                className={panel === id ? 'renewal-primary' : 'renewal-secondary'}
                aria-pressed={panel === id}
                onClick={() => setPanel(id as keyof typeof panels)}
              >
                {label}
              </button>
            ))}
          </div>
          <section className="system-period" aria-label="Період огляду">
            <div className="flex flex-wrap gap-2">
              {(
                [
                  ['today', 'Сьогодні'],
                  ['7d', '7 днів'],
                  ['month', 'Місяць'],
                ] as const
              ).map(([range, label]) => (
                <button
                  type="button"
                  key={range}
                  className={selection.range === range ? 'renewal-primary' : 'renewal-secondary'}
                  aria-pressed={selection.range === range}
                  onClick={() => {
                    setCustom(false);
                    choose({ range });
                  }}
                >
                  {label}
                </button>
              ))}
              <button
                type="button"
                className={custom ? 'renewal-primary' : 'renewal-secondary'}
                aria-expanded={custom}
                onClick={() => setCustom(!custom)}
              >
                Свої дати
              </button>
            </div>
            {custom && (
              <form
                className="mt-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (from <= to && to <= today()) choose({ range: 'custom', from, to });
                  else
                    setError('Перевір дати: початок має бути до завершення, без майбутніх днів.');
                }}
              >
                <div className="system-date-grid">
                  <label className="renewal-field">
                    Від
                    <input
                      type="date"
                      required
                      value={from}
                      max={to}
                      onChange={(e) => setFrom(e.target.value)}
                    />
                  </label>
                  <label className="renewal-field">
                    До
                    <input
                      type="date"
                      required
                      value={to}
                      min={from}
                      max={today()}
                      onChange={(e) => setTo(e.target.value)}
                    />
                  </label>
                </div>
                <button type="submit" className="renewal-secondary mt-3">
                  Застосувати дати
                </button>
              </form>
            )}
            {data?.selection && (
              <p className="renewal-chart-note mt-2">
                {data.selection.from} — {data.selection.to}. Технічна історія зберігається{' '}
                {data.selection.telemetryDays} днів; давніший облік може бути неповним.
              </p>
            )}
          </section>
          <div className="system-row">
            <p className="renewal-chart-note">
              {data ? `Огляд отримано ${time(data.generatedAt)}` : 'Завантаження стану'}
            </p>
            <button
              type="button"
              className="renewal-secondary"
              disabled={query.isFetching}
              onClick={() => void refresh()}
            >
              {query.isFetching ? 'Оновлюю…' : 'Оновити'}
            </button>
          </div>
          {query.error && (
            <p role="alert" className="system-warning">
              {query.error.message}
              {data ? ' Попередній огляд залишено на екрані.' : ''}
            </p>
          )}
          {error && (
            <p role="alert" className="system-warning">
              {error}
            </p>
          )}
          {query.isPending && <p role="status">Завантажую наявні записи…</p>}
          {data && (
            <>
              {panel === 'overview' && (
                <>
                  <section className="renewal-card">
                    <h2 className="font-semibold">Потребує уваги</h2>
                    {attention.map((item) => (
                      <article className="system-attention" key={item.id}>
                        <h3 className="font-semibold">{item.title}</h3>
                        <p className="renewal-chart-note mt-1">{item.detail}</p>
                        <button
                          type="button"
                          className="renewal-secondary mt-3"
                          onClick={() => setPanel('services')}
                        >
                          Переглянути деталі
                        </button>
                      </article>
                    ))}
                    {data.delivery.data &&
                      (data.delivery.data.outbox.failed ||
                        data.delivery.data.outbox.stuck ||
                        data.delivery.data.reminders.breached) > 0 && (
                        <article className="system-attention">
                          <h3 className="font-semibold">Затримки доставки</h3>
                          <button
                            type="button"
                            className="renewal-secondary mt-3"
                            onClick={() => setPanel('events')}
                          >
                            Перевірити доставку
                          </button>
                        </article>
                      )}
                    {!attention.length && (
                      <p className="renewal-chart-note mt-3">
                        У наявних перевірках немає зафіксованих проблем. Неперевірені функції мають
                        окремий стан.
                      </p>
                    )}
                    {(!data.billing?.connected ||
                      data.billing.items?.some((item) => !item.snapshot)) && (
                      <article className="system-attention">
                        <h3 className="font-semibold">Рахунки провайдерів ще неповні</h3>
                        <p className="renewal-chart-note mt-1">
                          Оцінки Світанку охоплюють частину використання. Рахунки та баланс
                          перевіряй окремо для кожного провайдера.
                        </p>
                        <button
                          type="button"
                          className="renewal-secondary mt-3"
                          onClick={() => setPanel('control')}
                        >
                          Як підключити
                        </button>
                      </article>
                    )}
                  </section>
                  <section className="renewal-card">
                    <h2 className="font-semibold">Витрати за період</h2>
                    <ReadWarning section={data.usage} />
                    <div className="system-row">
                      <span>Відома оцінка API</span>
                      <b>{money(usage?.estimatedUsd)}</b>
                    </div>
                    {usage?.equivalents ? (
                      <div className="system-row">
                        <span>API-еквівалент SDK · окремо</span>
                        <b>{money(usage.equivalentUsd)}</b>
                      </div>
                    ) : null}
                    <p className="renewal-chart-note mt-2">
                      {usage
                        ? `Ціна відома для ${usage.knownCosts} із ${usage.records} записів.`
                        : 'Облік ще недоступний.'}{' '}
                      Невідомі суми не вважаються нулем.
                    </p>
                    {selection.range === 'month' &&
                      data.preferences?.data?.budgets.overallUsd != null && (
                        <p className="renewal-chart-note mt-3">
                          Твій місячний орієнтир: {money(data.preferences.data.budgets.overallUsd)}.{' '}
                          {usage?.estimatedUsd != null &&
                          usage.estimatedUsd > data.preferences.data.budgets.overallUsd
                            ? 'Записана оцінка API вже перевищила його.'
                            : 'Оцінка охоплює лише зафіксовані витрати; решта може бути невідомою.'}
                        </p>
                      )}
                    <button
                      type="button"
                      className="renewal-secondary mt-3"
                      onClick={() => setPanel('usage')}
                    >
                      Що сформувало витрати
                    </button>
                  </section>
                  <section className="renewal-card">
                    <h2 className="font-semibold">Зараз</h2>
                    <div className="system-metrics mt-4">
                      <div className="renewal-inset">
                        <strong>{data.registry.data?.active ?? '—'}</strong>
                        <span className="renewal-chart-note">активних задач</span>
                      </div>
                      <div className="renewal-inset">
                        <strong>{data.scheduler.data?.scheduled ?? '—'}</strong>
                        <span className="renewal-chart-note">запланованих задач</span>
                      </div>
                    </div>
                    <ReadWarning section={data.registry} />
                    <ReadWarning section={data.scheduler} />
                    <p className="renewal-chart-note mt-3">
                      Асистент:{' '}
                      {data.mode === 'on'
                        ? 'увімкнений'
                        : data.mode === 'shadow'
                          ? 'тестовий режим'
                          : 'вимкнений'}
                      . Останній тік: {time(data.scheduler.data?.lastTick)}.
                    </p>
                    {!data.scheduler.available && (
                      <p className="renewal-chart-note mt-2">
                        Стан планувальника зараз недоступний.
                      </p>
                    )}
                  </section>
                  <section className="renewal-card">
                    <h2 className="font-semibold">Твої функції</h2>
                    <ServiceCards data={data} />
                  </section>
                </>
              )}
              {panel === 'services' && (
                <>
                  <section className="renewal-card">
                    <h2 className="font-semibold">Асистент</h2>
                    <ReadWarning section={data.brain} />
                    <div className="system-row">
                      <span>Сервіс</span>
                      <b>{states[data.brain?.data?.state ?? 'unknown'] ?? 'Стан невідомий'}</b>
                    </div>
                    <div className="system-row">
                      <span>Модель</span>
                      <b>{states[data.brain?.data?.modelState ?? 'unknown'] ?? 'Стан невідомий'}</b>
                    </div>
                    <p className="renewal-chart-note mt-3">
                      Перевірено: {time(data.brain?.data?.checkedAtMs)}. Готовність сервісу не
                      доводить якість відповіді.
                    </p>
                  </section>
                  <section className="renewal-card">
                    <h2 className="font-semibold">Стан функцій</h2>
                    <ServiceCards data={data} />
                  </section>
                </>
              )}
              {panel === 'usage' && (
                <UsagePanel data={data} selection={selection} refresh={refresh} />
              )}
              {panel === 'events' && (
                <TasksPanel
                  data={data}
                  newer={
                    cursors.length
                      ? () => {
                          const stack = [...cursors],
                            before = stack.pop();
                          setCursors(stack);
                          setSelection({ ...selection, before });
                        }
                      : undefined
                  }
                  older={
                    data.runs.data?.nextCursor
                      ? () => {
                          setCursors([...cursors, selection.before]);
                          setSelection({
                            ...selection,
                            before: data.runs.data?.nextCursor ?? undefined,
                          });
                        }
                      : undefined
                  }
                  busy={query.isFetching}
                />
              )}
              {panel === 'workers' && <WorkersPanel data={data} />}
              {panel === 'control' && (
                <ControlsPanel data={data} refresh={refresh} appVersion={appVersion} />
              )}
            </>
          )}
        </>
      )}
      <RequestDiagnostics />
    </div>
  );
}
