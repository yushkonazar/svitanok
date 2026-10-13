import { version as appVersion } from '../../../package.json';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useSettings } from '../../api/hooks.ts';
import { fetchSystem } from '../../api/client.ts';
import { inTelegram } from '../../telegram.ts';
import { PageHeading } from '../ui/PageHeading.tsx';

const panels = { overview: 'Огляд', workers: 'Працівники', usage: 'Витрати API', events: 'Задачі' };
const names: Record<string, string> = {
  analyst: 'Аналітик',
  editor: 'Редактор',
  finance: 'Фінанси',
  'mail-secretary': 'Пошта',
  planner: 'Планувальник',
  'place-search': 'Пошук закладів',
  'price-search': 'Ціни',
  researcher: 'Дослідник',
  tutor: 'Навчання',
};
const quotas: Record<string, string> = {
  news_editor_usd: 'Редактор новин · USD',
  gemini_usd: 'Gemini · USD',
  deepgram_min: 'Голос · хвилини',
  places_text: 'Пошук місць · запити',
  places_details: 'Деталі місць · запити',
  routes: 'Маршрути · запити',
  geocoding: 'Координати · запити',
  actions_min: 'GitHub Actions · хвилини',
  workflow_steps: 'Кроки workflow',
};
function time(value: unknown) {
  const date = typeof value === 'number' || typeof value === 'string' ? new Date(value) : null;
  return date && Number.isFinite(date.getTime())
    ? date.toLocaleString('uk-UA', {
        timeZone: 'Europe/Kyiv',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : 'Немає даних';
}
export function SystemScreen() {
  const { data: settings } = useSettings();
  const [panel, setPanel] = useState<keyof typeof panels>('overview');
  const query = useQuery({
    queryKey: ['system'],
    queryFn: fetchSystem,
    enabled: inTelegram(),
    staleTime: 60_000,
    retry: false,
  });
  const data = query.data;
  const healthLabels: Record<string, string> = {
    ok: 'Доступний за останньою перевіркою',
    down: 'Перевірка зафіксувала збій',
    desync: 'Версії не збігаються',
    stale: 'Перевірка застаріла',
    unknown: 'Ще немає перевірки',
    'not-configured': 'Не налаштований',
    ready: 'Готовий',
    unavailable: 'Недоступний',
  };
  return (
    <div className="flex flex-col gap-5">
      <PageHeading eyebrow="ПАНЕЛЬ ВЛАСНИКА" title="Система" accent="Світанку." />
      <p className="renewal-chart-note">
        Версія {appVersion}. Технічний стан і витрати за наявними записами. Час за Києвом. Відкриття
        сторінки не викликає моделі.
      </p>
      {!inTelegram() ? (
        <section className="renewal-card">
          <h2 className="font-semibold">Приватна панель</h2>
          <p className="renewal-chart-note mt-2">
            Відкрий Світанок в особистому чаті з ботом. Доступ має основний власник; у браузері
            технічні дані не завантажуються.
          </p>
        </section>
      ) : (
        <>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Розділи системи">
            {Object.entries(panels).map(([id, label]) => (
              <button
                key={id}
                className={panel === id ? 'renewal-primary' : 'renewal-secondary'}
                aria-pressed={panel === id}
                onClick={() => setPanel(id as keyof typeof panels)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="system-row">
            <p className="renewal-chart-note">
              {data ? `Оновлено ${time(data.generatedAt)}` : 'Завантаження стану'}
            </p>
            <button
              className="renewal-secondary"
              disabled={query.isFetching}
              onClick={() => void query.refetch()}
            >
              {query.isFetching ? 'Оновлюю…' : 'Оновити'}
            </button>
          </div>
          {query.error && <p role="alert">{query.error.message}</p>}
          {query.isPending && <p role="status">Завантажую наявні записи…</p>}
          {data && (
            <>
              {panel === 'overview' && (
                <>
                  <section className="renewal-card">
                    <h2 className="font-semibold">Зараз</h2>
                    <div className="system-metrics mt-4">
                      <div className="renewal-inset">
                        <strong>{data.registry.data?.active ?? '—'}</strong>
                        <span className="renewal-chart-note">активних прогонів</span>
                      </div>
                      <div className="renewal-inset">
                        <strong>{data.scheduler.data?.scheduled ?? '—'}</strong>
                        <span className="renewal-chart-note">запланованих задач</span>
                      </div>
                    </div>
                    <p className="renewal-chart-note mt-3">
                      Асистент:{' '}
                      {data.mode === 'on'
                        ? 'увімкнений'
                        : data.mode === 'shadow'
                          ? 'тестовий режим'
                          : 'вимкнений'}
                      . Останній тік планувальника: {time(data.scheduler.data?.lastTick)}.
                    </p>
                    {!data.scheduler.available && (
                      <p role="status" className="renewal-chart-note mt-2">
                        Стан планувальника зараз недоступний.
                      </p>
                    )}
                  </section>
                  <section className="renewal-card">
                    <h2 className="font-semibold">Доставка</h2>
                    {data.delivery.data ? (
                      <>
                        <div className="system-row">
                          <span>Нагадування із запізненням</span>
                          <b>{data.delivery.data.reminders.breached}</b>
                        </div>
                        <div className="system-row">
                          <span>Повідомлення в черзі</span>
                          <b>{data.delivery.data.outbox.pending}</b>
                        </div>
                        <div className="system-row">
                          <span>Збої / завислі повідомлення</span>
                          <b>
                            {data.delivery.data.outbox.failed} / {data.delivery.data.outbox.stuck}
                          </b>
                        </div>
                        <p className="renewal-chart-note mt-3">
                          Останній доставлений брифінг:{' '}
                          {data.delivery.data.briefing.last_sent_date ?? 'Немає даних'}.{' '}
                          {data.delivery.data.briefing.status === 'breached'
                            ? 'Дедлайн доставки минув — потрібна перевірка.'
                            : ''}
                        </p>
                      </>
                    ) : (
                      <p className="renewal-chart-note mt-3">Дані доставки зараз недоступні.</p>
                    )}
                  </section>
                  <section className="renewal-card">
                    <h2 className="font-semibold">Асистент та інтеграції</h2>
                    <p className="renewal-chart-note mt-3">
                      Сервіс асистента:{' '}
                      {healthLabels[data.brain?.data?.state ?? 'unknown'] ?? 'Стан невідомий'}.
                      Перевірено: {time(data.brain?.data?.checkedAtMs)}.
                    </p>
                    <p className="renewal-chart-note mt-2">
                      Готовність моделі:{' '}
                      {healthLabels[data.brain?.data?.modelState ?? 'unknown'] ?? 'Стан невідомий'}.
                    </p>
                    <div className="system-row">
                      <span>Google</span>
                      <b>
                        {settings
                          ? settings.connectors.google
                            ? 'Налаштовано'
                            : 'Не підключено'
                          : 'Невідомо'}
                      </b>
                    </div>
                    <div className="system-row">
                      <span>Monobank</span>
                      <b>
                        {settings
                          ? settings.connectors.mono
                            ? 'Налаштовано'
                            : 'Не підключено'
                          : 'Невідомо'}
                      </b>
                    </div>
                    <p className="renewal-chart-note mt-3">
                      Налаштована інтеграція не гарантує доступності зовнішнього API. Дозволи й
                      перемикачі є в налаштуваннях.
                    </p>
                    {data.deployment && (
                      <details className="mt-3">
                        <summary className="renewal-chart-note">Версія сервера</summary>
                        <p className="renewal-chart-note break-words mt-2">
                          Deployment: {data.deployment}
                        </p>
                      </details>
                    )}
                    <h2 className="font-semibold mt-5">Керування</h2>
                    <div className="flex flex-wrap gap-3 mt-3">
                      <Link className="renewal-secondary" to="/settings">
                        Модулі й інтеграції
                      </Link>
                      <Link className="renewal-secondary" to="/memory">
                        Пам’ять асистента
                      </Link>
                      <Link className="renewal-secondary" to="/finance?action=settings">
                        Нагадування
                      </Link>
                    </div>
                    <p className="renewal-chart-note mt-3">
                      Усі перемикачі використовують спільні налаштування асистента й Mini App.
                    </p>
                  </section>
                </>
              )}
              {panel === 'workers' && (
                <section className="renewal-card">
                  <h2 className="font-semibold">Працівники · 30 днів</h2>
                  <p className="renewal-chart-note mt-2">
                    Модельний запис, завершена відповідь і твоя оцінка — різні показники.
                    Відсутність викликів не означає збій.
                  </p>
                  {!data.runs.available ? (
                    <p className="mt-4">Огляд недоступний.</p>
                  ) : (
                    <>
                      {data.runs.data?.worker_quality.map((item) => (
                        <article className="renewal-inset mt-4" key={item.worker}>
                          <div className="system-row">
                            <h3 className="font-semibold">{names[item.worker] ?? item.worker}</h3>
                            <span>{item.results} відповідей</span>
                          </div>
                          <p className="renewal-chart-note mt-2">
                            Модельних записів: {item.sample_size}. Успішних: {item.succeeded}; зі
                            збоєм: {item.failed}; результат невідомий:{' '}
                            {Math.max(0, item.sample_size - item.succeeded - item.failed)}.
                          </p>
                          <p className="renewal-chart-note mt-2">
                            Технічна успішність:{' '}
                            {item.succeeded + item.failed >= 5 && item.success_rate_pct != null
                              ? `${item.success_rate_pct}% серед відомих результатів`
                              : 'мало даних'}
                            . Час у середньому:{' '}
                            {item.avg_latency_ms == null
                              ? 'невідомо'
                              : `${(item.avg_latency_ms / 1000).toFixed(1)} с`}
                            .
                          </p>
                          <p className="renewal-chart-note mt-2">
                            Твої оцінки: 👍 {item.feedback.good} · 👎 {item.feedback.bad}. Без
                            оцінки — якість невідома.
                          </p>
                        </article>
                      ))}
                      {!data.runs.data?.worker_quality.length && (
                        <p className="mt-4">За цей період викликів ще немає.</p>
                      )}
                    </>
                  )}
                </section>
              )}
              {panel === 'usage' && (
                <>
                  <section className="renewal-card">
                    <h2 className="font-semibold">Моделі · 30 днів</h2>
                    <p className="renewal-chart-note mt-2">
                      Це оцінка за телеметрією, а не рахунок провайдера. Claude SDK показує
                      API-еквівалент; підписка може оплачуватися інакше. Вартість зовнішніх
                      інструментів сюди не включена.
                    </p>
                    {data.models.data?.items.map((item) => (
                      <article key={item.model} className="renewal-inset mt-4">
                        <h3 className="font-semibold break-words">{item.model}</h3>
                        <div className="system-row">
                          <span>
                            {item.calls} записів моделі{item.shadow ? ' · порівняльні виклики' : ''}
                          </span>
                          <b>{item.costUsd == null ? 'Невідомо' : `$${item.costUsd.toFixed(4)}`}</b>
                        </div>
                        <p className="renewal-chart-note mt-2">
                          Вартість відома для {item.knownCostCalls} із {item.calls}. Токени відомі
                          для {item.knownUsageCalls}: вхід{' '}
                          {item.inputTokens?.toLocaleString('uk-UA') ?? '—'}, вихід{' '}
                          {item.outputTokens?.toLocaleString('uk-UA') ?? '—'}.
                        </p>
                      </article>
                    ))}
                    {!data.models.data?.items.length && (
                      <p className="renewal-chart-note mt-3">Немає доступної телеметрії моделей.</p>
                    )}
                    {data.models.data?.truncated && (
                      <p className="renewal-chart-note mt-3">
                        Огляд обмежений останніми 5000 записів.
                      </p>
                    )}
                  </section>
                  <section className="renewal-card">
                    <h2 className="font-semibold">Внутрішні квоти · {data.period}</h2>
                    <p className="renewal-chart-note mt-2">
                      Лічильники лише використання Світанку. Вони не показують залишок кредитів чи
                      всю оплату акаунта.
                    </p>
                    {data.quotas.data?.map((item) => (
                      <div key={item.key} className="renewal-inset mt-3">
                        <div className="system-row">
                          <span>{quotas[item.key] ?? item.key}</span>
                          <b>{Number(item.value.toFixed(4)).toLocaleString('uk-UA')}</b>
                        </div>
                        <p className="renewal-chart-note mt-2">
                          {item.key === 'deepgram_min'
                            ? 'Історичний орієнтир кредиту; залишок у провайдера невідомий.'
                            : `Внутрішня межа: ${item.limit_value.toLocaleString('uk-UA')}.`}{' '}
                          Оновлено {time(item.updated_at)}.
                        </p>
                      </div>
                    ))}
                    {!data.quotas.data?.length && (
                      <p className="renewal-chart-note mt-3">
                        Лічильників за цей місяць ще немає або вони недоступні.
                      </p>
                    )}
                  </section>
                  <section className="renewal-card">
                    <h2 className="font-semibold">Баланс провайдерів</h2>
                    <p className="renewal-chart-note mt-2">
                      Billing-доступ не підключено. Баланс і повний рахунок невідомі; нові
                      адміністративні доступи потребують окремого налаштування.
                    </p>
                  </section>
                </>
              )}
              {panel === 'events' && (
                <section className="renewal-card">
                  <h2 className="font-semibold">Останні 50 прогонів</h2>
                  <p className="renewal-chart-note mt-2">
                    Технічні метадані без повідомлень, промптів, результатів інструментів і даних
                    доступу. Старий збій не означає, що сервіс недоступний зараз.
                  </p>
                  {data.runs.data?.recent.map((run) => (
                    <details key={run.id} className="renewal-inset mt-3">
                      <summary className="cursor-pointer">
                        <b>{run.profile ?? run.trigger ?? 'Задача'}</b> ·{' '}
                        {run.terminal === 'completed'
                          ? 'Завершено'
                          : run.terminal === 'failed'
                            ? 'Збій'
                            : 'Триває'}
                        <p className="renewal-chart-note mt-1">{time(run.started_at)}</p>
                      </summary>
                      <p className="renewal-chart-note mt-3">
                        Модель: {run.model ?? 'не записана'}. Інструментів: {run.tools.calls}.
                        Повторних спроб: {run.retries}. Тривалість:{' '}
                        {run.duration_ms == null
                          ? 'невідомо'
                          : `${(run.duration_ms / 1000).toFixed(1)} с`}
                        .
                      </p>
                      {run.error && <p className="renewal-chart-note mt-2">{run.error}</p>}
                    </details>
                  ))}
                  {!data.runs.data?.recent.length && (
                    <p className="renewal-chart-note mt-3">Немає доступних прогонів.</p>
                  )}
                </section>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
