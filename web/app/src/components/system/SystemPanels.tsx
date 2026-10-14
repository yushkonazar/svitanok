import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { postSystem, type SystemSelection } from '../../api/client.ts';
import type { SystemSnapshot } from '../../api/system-schema.ts';

export const features: Record<string, string> = {
  assistant: 'Асистент',
  news: 'Новини',
  translation: 'Переклад',
  content: 'Факти й цитати',
  maps: 'Карти й маршрути',
  voice: 'Голос',
  finance: 'Фінанси',
  leisure: 'Дозвілля',
  memory: 'Пам’ять',
  learning: 'Навчання',
  media: 'Зображення й відео',
  comparison: 'Порівняльні виклики',
  other: 'Інше',
};
export const states: Record<string, string> = {
  ok: 'Працює за останньою перевіркою',
  observed: 'Є успішний запис',
  ready: 'Готовий',
  degraded: 'Частково доступно',
  unready: 'Модель не готова',
  down: 'Перевірка зафіксувала збій',
  desync: 'Версії не збігаються',
  stale: 'Дані застаріли',
  unknown: 'Ще немає перевірки',
  unavailable: 'Не вдалося прочитати стан',
  'not-configured': 'Не налаштовано',
  configured: 'Доступ налаштовано',
  access: 'Потрібні права доступу',
  off: 'Вимкнено',
  empty: 'Ще немає записів',
  running: 'Оновлення триває',
};
const errors: Record<string, string> = {
  timeout: 'Перевищено час очікування. Перевір стан сервісу й наступну спробу.',
  access: 'Потрібно перевірити права або чинність доступу.',
  quota: 'Досягнуто обмеження провайдера або частоти запитів.',
  network: 'Не вдалося зв’язатися із сервісом.',
  configuration:
    'Перевір ключ білінгу й Project ID у Cloudflare: без лапок і переносів усередині значення.',
  request: 'Провайдер відхилив параметри запиту. Перевір Project ID.',
  redirect: 'Провайдер перенаправив запит. Ключ не передано на іншу адресу.',
  internal: 'Помилка обробки рахунку у Світанку.',
  execution: 'Задача завершилася зі збоєм. Перевір її технічні кроки.',
  provider: 'Провайдер не повернув дані.',
  format: 'Формат даних провайдера змінився.',
  scope: 'Рахунок не відповідає потрібному проєкту або валюті.',
  incomplete: 'Рахунок неповний; попередні дані збережено.',
};
const quotaLabels: Record<string, string> = {
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
const workers: Record<string, string> = {
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
export function time(value: unknown) {
  const date = typeof value === 'string' || typeof value === 'number' ? new Date(value) : null;
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
export function money(value: number | null | undefined) {
  return value == null
    ? 'Невідомо'
    : new Intl.NumberFormat('uk-UA', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: Math.abs(value) > 0 && Math.abs(value) < 0.000001 ? 9 : 6,
      }).format(value);
}
function duration(value: number | null | undefined) {
  return value == null
    ? 'Невідомо'
    : `${(value / 1000).toLocaleString('uk-UA', { maximumFractionDigits: 1 })} с`;
}
export function ReadWarning({
  section,
}: {
  section?: { available: boolean; cached?: boolean; checkedAt?: string };
}) {
  return section && !section.available ? (
    <p role="status" className="system-warning">
      {section.cached
        ? `Оновлення не вдалося. Показано попередні дані від ${time(section.checkedAt)}.`
        : 'Не вдалося отримати дані цього блоку. Це не означає нульове використання.'}
    </p>
  ) : null;
}
export function ServiceCards({ data }: { data: SystemSnapshot }) {
  return (
    <>
      <ReadWarning section={data.services} />
      {data.services?.data?.map((service) => (
        <details className="system-service renewal-inset" key={service.id}>
          <summary>
            <span>
              <strong>{service.title}</strong>
              <span className="system-secondary">{states[service.state] ?? 'Стан невідомий'}</span>
            </span>
            <span aria-hidden="true">⌄</span>
          </summary>
          <div className="system-service-body">
            <p className="renewal-chart-note">{service.detail}</p>
            <p className="renewal-chart-note mt-2">Останній запис: {time(service.checkedAt)}</p>
            {service.metrics?.map((metric) => (
              <div className="system-row" key={metric.label}>
                <span>{metric.label}</span>
                <b>
                  {typeof metric.value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(metric.value)
                    ? time(metric.value)
                    : metric.value}
                </b>
              </div>
            ))}
            {service.sources?.map((source, index) => (
              <div className="system-row" key={`${source.label}:${index}`}>
                <span>
                  {source.label}
                  <small className="system-secondary">{time(source.checkedAt)}</small>
                </span>
                <span>
                  {states[source.state] ?? source.state} · {source.count}
                </span>
              </div>
            ))}
            {service.href !== '/system' && (
              <Link className="renewal-secondary mt-3" to={service.href}>
                Відкрити розділ
              </Link>
            )}
          </div>
        </details>
      ))}
      {data.services?.available && !data.services.data?.length && (
        <p className="renewal-chart-note mt-3">Метадані функцій ще не записані.</p>
      )}
    </>
  );
}
export function UsagePanel({
  data,
  selection,
  refresh,
}: {
  data: SystemSnapshot;
  selection: SystemSelection;
  refresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null),
    [error, setError] = useState('');
  const usage = data.usage?.data;
  const [groupBy, setGroupBy] = useState<'feature' | 'provider'>('feature');
  const [clock, setClock] = useState(Date.now);
  const timersActive =
    data.billing?.items?.some((item) => item.retryAt && Date.parse(item.retryAt) > clock) ?? false;
  useEffect(() => {
    if (!timersActive) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [timersActive]);
  const groups = groupBy === 'feature' ? usage?.features : usage?.providers;
  async function update(provider: string) {
    setBusy(provider);
    setError('');
    try {
      await postSystem({ action: 'billing-refresh', provider }, selection);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не вдалося оновити рахунок.');
    } finally {
      await refresh();
      setBusy(null);
    }
  }
  return (
    <>
      <section className="renewal-card">
        <h2 className="font-semibold">
          Витрати за {groupBy === 'feature' ? 'функціями' : 'провайдерами'}
        </h2>
        <div className="flex flex-wrap gap-2 mt-3">
          <button
            type="button"
            className={groupBy === 'feature' ? 'renewal-primary' : 'renewal-secondary'}
            aria-pressed={groupBy === 'feature'}
            onClick={() => setGroupBy('feature')}
          >
            За функціями
          </button>
          <button
            type="button"
            className={groupBy === 'provider' ? 'renewal-primary' : 'renewal-secondary'}
            aria-pressed={groupBy === 'provider'}
            onClick={() => setGroupBy('provider')}
          >
            За провайдерами
          </button>
        </div>
        <ReadWarning section={data.usage} />
        <p className="renewal-chart-note mt-2">
          Оцінки записаних викликів. API-еквівалент SDK показано окремо від оцінки платного API.
          Рахунки нижче потрібні для звірки й не додаються до оцінок.
        </p>
        {groups?.map((item) => (
          <details className="system-service renewal-inset" key={item[groupBy]}>
            <summary>
              <span>
                <strong>
                  {groupBy === 'feature'
                    ? (features[item.feature ?? ''] ?? item.feature)
                    : item.provider}
                </strong>
                <span className="system-secondary">
                  {item.records} записів · ціна відома для {item.knownCosts}
                </span>
              </span>
              <b>{money(item.estimatedUsd)}</b>
            </summary>
            <div className="system-service-body">
              {groupBy === 'feature' &&
                selection.range === 'month' &&
                data.preferences?.data?.budgets.features[item.feature ?? ''] != null && (
                  <p className="renewal-chart-note">
                    Місячний орієнтир:{' '}
                    {money(data.preferences.data.budgets.features[item.feature ?? ''])}.{' '}
                    {item.estimatedUsd != null &&
                    item.estimatedUsd > data.preferences.data.budgets.features[item.feature ?? '']!
                      ? 'Записана оцінка API вже перевищила орієнтир.'
                      : 'Облік може бути неповним; це не гарантований залишок бюджету.'}
                  </p>
                )}
              {item.equivalents > 0 && (
                <div className="system-row">
                  <span>API-еквівалент SDK</span>
                  <b>{money(item.equivalentUsd)}</b>
                </div>
              )}
              {(usage?.items ?? [])
                .filter((row) => row[groupBy] === item[groupBy])
                .map((row) => (
                  <div
                    className="system-usage-row"
                    key={`${row.feature}:${row.provider}:${row.sku}`}
                  >
                    <span>
                      <b>
                        {row.provider} · {row.sku}
                      </b>
                      {groupBy === 'provider' && (
                        <small className="system-secondary">
                          {features[row.feature ?? ''] ?? row.feature}
                        </small>
                      )}
                      <small className="system-secondary">
                        {row.records} записів · збоїв: {row.failed}
                        {row.equivalents ? ' · API-еквівалент SDK' : ''}
                      </small>
                      <small className="system-secondary">
                        Вхід: {row.inputTokens?.toLocaleString('uk-UA') ?? '—'} · вихід:{' '}
                        {row.outputTokens?.toLocaleString('uk-UA') ?? '—'} · кеш:{' '}
                        {row.cachedTokens?.toLocaleString('uk-UA') ?? '—'}
                      </small>
                    </span>
                    <strong>{money(row.costUsd)}</strong>
                  </div>
                ))}
            </div>
          </details>
        ))}
        {usage?.records === 0 && (
          <p className="renewal-chart-note mt-3">
            За цей період ще немає записаних викликів. Це не підтверджує нульовий рахунок
            провайдерів.
          </p>
        )}
        {usage?.legacyTruncated && (
          <p className="system-warning">
            Старий журнал обмежено 5000 записів. Історичний підсумок неповний; нові структуровані
            записи враховуються всі.
          </p>
        )}
        {usage && (
          <p className="renewal-chart-note mt-3">
            Єдиний облік ведеться з {time(usage.trackingSince)}. Давні витрати зовнішніх
            інструментів не відновлюються зі здогадок.
          </p>
        )}
        {usage?.daily.length ? (
          <details className="mt-4">
            <summary className="system-detail-summary">Витрати за днями</summary>
            {usage.daily.map((day) => (
              <div className="system-row" key={day.day}>
                <span>
                  {day.day}
                  <small className="system-secondary">
                    {day.knownCosts} із {day.records} записів із ціною
                    {day.equivalents ? ` · еквівалент SDK ${money(day.equivalentUsd)}` : ''}
                  </small>
                </span>
                <b>{money(day.estimatedUsd)}</b>
              </div>
            ))}
          </details>
        ) : null}
        {!usage &&
          data.models.data?.items.map((item) => (
            <div className="renewal-inset mt-3" key={item.model}>
              <b>{item.model}</b>
              <div className="system-row">
                <span>{item.calls} записів</span>
                <strong>{money(item.costUsd)}</strong>
              </div>
              <p className="renewal-chart-note mt-2">
                Вартість відома для {item.knownCostCalls} із {item.calls}.
                {item.model.includes('claude:')
                  ? ' Це API-еквівалент SDK, а не рахунок підписки.'
                  : ''}
              </p>
            </div>
          ))}
      </section>
      <section className="renewal-card">
        <h2 className="font-semibold">Рахунки провайдерів</h2>
        <p className="renewal-chart-note mt-2">
          Нарахування можуть з’являтися із затримкою. Поточні суми ще можуть змінитися. Баланс
          передплати й нарахування — різні показники.
        </p>
        {error && (
          <p role="alert" className="system-warning">
            {error}
          </p>
        )}
        {data.billing?.items?.map((item) => {
          const remaining = item.retryAt
            ? Math.max(0, Math.ceil((Date.parse(item.retryAt) - clock) / 1000))
            : 0;
          return (
            <article className="renewal-inset mt-3" key={item.provider}>
              <h3 className="font-semibold">{item.title}</h3>
              <div className="system-row">
                <span>Нарахування</span>
                <b>{money(item.snapshot?.costUsd)}</b>
              </div>
              <div className="system-row">
                <span>Баланс за API</span>
                <b>{money(item.snapshot?.balanceUsd)}</b>
              </div>
              <p className="renewal-chart-note mt-2">
                {item.snapshot
                  ? `${item.snapshot.from} — ${item.snapshot.to} · отримано ${time(item.snapshot.collectedAt)}${item.snapshot.timeZone === 'provider' ? '. Межі доби задає провайдер; зіставлення з київськими днями приблизне.' : ''}`
                  : item.configured
                    ? 'Ключі додано. Онови рахунок, щоб перевірити доступ.'
                    : 'Окремий доступ не підключено.'}
              </p>
              {item.normalizationApplied && (
                <p className="renewal-chart-note mt-2">
                  Зайві пробіли або переноси навколо налаштувань прибрано автоматично.
                </p>
              )}
              {item.errorClass && (
                <p className="system-warning">
                  {errors[item.errorClass] ?? 'Оновлення не вдалося.'}
                  {item.snapshot ? ' Попередній успішний рахунок збережено.' : ''}
                </p>
              )}
              {item.configured && (
                <button
                  type="button"
                  className="renewal-secondary mt-3"
                  disabled={busy !== null || remaining > 0}
                  onClick={() => void update(item.provider)}
                >
                  {busy === item.provider
                    ? 'Отримую рахунок…'
                    : remaining > 0
                      ? `${item.refreshing ? 'Оновлення триває' : 'Повтор через'} ${remaining} с`
                      : 'Оновити рахунок'}
                </button>
              )}
            </article>
          );
        })}
        {!data.billing?.items?.length && (
          <p className="renewal-chart-note mt-3">
            Billing-доступ не підключено. Баланс і повний рахунок невідомі.
          </p>
        )}
      </section>
      <details className="renewal-card">
        <summary className="system-detail-summary">
          Внутрішні квоти · поточний місяць {data.period}
        </summary>
        <ReadWarning section={data.quotas} />
        <p className="renewal-chart-note mt-2">
          Лічильники використання Світанку. Вони не показують залишок кредитів чи повний рахунок
          акаунта.
        </p>
        {data.quotas.data?.map((item) => (
          <div className="system-row" key={item.key}>
            <span>
              {quotaLabels[item.key] ?? item.key}
              <small className="system-secondary">
                {time(item.updated_at)}
                {item.key === 'deepgram_min'
                  ? ' · залишок кредитів невідомий'
                  : ` · внутрішня межа ${item.limit_value}`}
              </small>
            </span>
            <b>{item.value.toLocaleString('uk-UA', { maximumFractionDigits: 4 })}</b>
          </div>
        ))}
        {data.quotas.available && !data.quotas.data?.length && (
          <p className="renewal-chart-note mt-3">За поточний місяць лічильники ще не записані.</p>
        )}
      </details>
    </>
  );
}
export function TasksPanel({
  data,
  newer,
  older,
  busy,
}: {
  data: SystemSnapshot;
  newer?: () => void;
  older?: () => void;
  busy: boolean;
}) {
  return (
    <>
      <section className="renewal-card">
        <h2 className="font-semibold">Доставка</h2>
        <ReadWarning section={data.delivery} />
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
        <h2 className="font-semibold">Задачі за період</h2>
        <ReadWarning section={data.runs} />
        <p className="renewal-chart-note mt-2">
          {data.runs.data?.summary
            ? `Усього: ${data.runs.data.summary.total}; завершено: ${data.runs.data.summary.completed}; зі збоєм: ${data.runs.data.summary.failed}.`
            : ''}{' '}
          Старий збій не означає недоступність сервісу зараз.
        </p>
        {data.runs.data?.recent.map((run) => (
          <details className="system-service renewal-inset" key={run.id}>
            <summary>
              <span>
                <strong>
                  {workers[run.profile ?? ''] ?? run.profile ?? run.trigger ?? 'Задача'}
                </strong>
                <span className="system-secondary">{time(run.started_at)}</span>
              </span>
              <span>
                {run.terminal === 'completed'
                  ? 'Завершено'
                  : run.terminal === 'failed'
                    ? 'Збій'
                    : 'Триває'}
              </span>
            </summary>
            <div className="system-service-body">
              <p className="renewal-chart-note">
                Тривалість: {duration(run.duration_ms)} · очікування: {duration(run.queue_wait_ms)}{' '}
                · інструментів: {run.tools.calls} · повторів: {run.retries}.
              </p>
              {run.error_class && (
                <p className="system-warning">{errors[run.error_class] ?? errors.execution}</p>
              )}
              {run.models?.map((model, index) => (
                <div className="system-usage-row" key={`${model.name}:${index}`}>
                  <span>
                    <b>{model.name}</b>
                    <small className="system-secondary">
                      Вхід: {model.usage.input_tokens ?? '—'} · вихід:{' '}
                      {model.usage.output_tokens ?? '—'} · кеш:{' '}
                      {model.usage.cached_input_tokens ?? '—'}
                    </small>
                    <small className="system-secondary">
                      Відповідей моделі: {model.model_responses ?? '—'} · API-спроб:{' '}
                      {model.api_attempts ?? '—'} · {duration(model.duration_ms)}
                    </small>
                  </span>
                  <strong>{money(model.estimated_cost_usd)}</strong>
                </div>
              ))}
              {!run.models?.length && (
                <p className="renewal-chart-note mt-2">Модель: {run.model ?? 'не записана'}.</p>
              )}
              {run.steps?.length ? (
                <details className="mt-3">
                  <summary className="system-detail-summary">Послідовність кроків</summary>
                  <ol className="system-steps">
                    {run.steps.map((step, index) => (
                      <li key={index}>
                        <span>
                          {step.kind} · {step.name}
                        </span>
                        <small>
                          {step.ok === true
                            ? 'Успішно'
                            : step.ok === false
                              ? 'Збій'
                              : 'Результат невідомий'}{' '}
                          · {duration(step.ms)}
                        </small>
                      </li>
                    ))}
                  </ol>
                  {run.steps_truncated && (
                    <p className="renewal-chart-note mt-2">Показано перші 200 технічних кроків.</p>
                  )}
                </details>
              ) : null}
            </div>
          </details>
        ))}
        {data.runs.available && !data.runs.data?.recent.length && (
          <p className="renewal-chart-note mt-3">За цей період задач ще немає.</p>
        )}
        <div className="flex flex-wrap gap-3 mt-4">
          {newer && (
            <button type="button" className="renewal-secondary" disabled={busy} onClick={newer}>
              Новіші задачі
            </button>
          )}
          {older && (
            <button type="button" className="renewal-secondary" disabled={busy} onClick={older}>
              Раніші задачі
            </button>
          )}
        </div>
      </section>
    </>
  );
}
export function WorkersPanel({ data }: { data: SystemSnapshot }) {
  return (
    <section className="renewal-card">
      <h2 className="font-semibold">Працівники за період</h2>
      <ReadWarning section={data.runs} />
      <p className="renewal-chart-note mt-2">
        Виклики моделі, збережені відповіді й твої оцінки рахуються окремо. Технічна успішність не
        доводить корисність відповіді.
      </p>
      {data.runs.data?.worker_quality.map((item) => (
        <article className="renewal-inset mt-3" key={item.worker}>
          <h3 className="font-semibold">{workers[item.worker] ?? item.worker}</h3>
          <div className="system-row">
            <span>Записів моделі / результатів</span>
            <b>
              {item.sample_size} / {item.results}
            </b>
          </div>
          <div className="system-row">
            <span>Успішно / зі збоєм</span>
            <b>
              {item.succeeded} / {item.failed}
            </b>
          </div>
          <p className="renewal-chart-note mt-2">
            {item.succeeded + item.failed >= 5 && item.success_rate_pct != null
              ? `Технічна успішність: ${item.success_rate_pct}%.`
              : 'Замало відомих результатів для відсотка успішності.'}{' '}
            Середня тривалість: {duration(item.avg_latency_ms)}. Твої оцінки: 👍{' '}
            {item.feedback.good} · 👎 {item.feedback.bad}.
          </p>
        </article>
      ))}
      {data.runs.available && !data.runs.data?.worker_quality.length && (
        <p className="renewal-chart-note mt-3">
          За цей період працівники ще не мали записаних викликів. Це не означає, що вони зламані.
        </p>
      )}
    </section>
  );
}
function BudgetEditor({
  value,
  refresh,
}: {
  value: NonNullable<SystemSnapshot['preferences']>['data'];
  refresh: () => Promise<void>;
}) {
  const [overall, setOverall] = useState(value?.budgets.overallUsd?.toString() ?? '');
  const [entries, setEntries] = useState<Record<string, string>>(
    Object.fromEntries(
      Object.entries(value?.budgets.features ?? {}).map(([key, amount]) => [key, String(amount)]),
    ),
  );
  const [selected, setSelected] = useState('assistant'),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [error, setError] = useState('');
  const number = (text: string) => (text.trim() ? Number(text.replace(',', '.')) : null);
  async function save() {
    const overallUsd = number(overall),
      featureAmounts = Object.fromEntries(
        Object.entries(entries)
          .map(([key, text]) => [key, number(text)])
          .filter(([, amount]) => amount !== null),
      );
    if (
      (overallUsd !== null && (!Number.isFinite(overallUsd) || overallUsd <= 0)) ||
      Object.values(featureAmounts).some(
        (amount) => typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0,
      )
    ) {
      setError('Вкажи додатні суми або залиш поле порожнім.');
      return;
    }
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await postSystem({
        action: 'budgets',
        revision: value?.revision ?? 0,
        budgets: { overallUsd, features: featureAmounts },
      });
      setMessage('Місячні орієнтири збережено.');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не вдалося зберегти.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="renewal-card">
      <h2 className="font-semibold">Твої місячні орієнтири</h2>
      <p className="renewal-chart-note mt-2">
        Суми для контролю витрат API. Порожнє поле прибирає орієнтир. Збереження не зупиняє функції
        й не вмикає розсилку.
      </p>
      <label className="renewal-field mt-4">
        Загалом на місяць, USD
        <input
          type="text"
          inputMode="decimal"
          value={overall}
          onChange={(e) => setOverall(e.target.value)}
          placeholder="Без орієнтира"
        />
      </label>
      {Object.entries(entries).map(([key, text]) => (
        <div className="system-budget-row" key={key}>
          <label className="renewal-field">
            {features[key] ?? key}, USD
            <input
              type="text"
              inputMode="decimal"
              value={text}
              onChange={(e) => setEntries({ ...entries, [key]: e.target.value })}
            />
          </label>
          <button
            type="button"
            className="renewal-secondary"
            onClick={() =>
              setEntries(Object.fromEntries(Object.entries(entries).filter(([id]) => id !== key)))
            }
            aria-label={`Прибрати орієнтир: ${features[key] ?? key}`}
          >
            Прибрати
          </button>
        </div>
      ))}
      <div className="system-budget-row mt-4">
        <label className="renewal-field">
          Функція
          <select value={selected} onChange={(e) => setSelected(e.target.value)}>
            {Object.entries(features).map(([key, name]) => (
              <option key={key} value={key}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="renewal-secondary"
          disabled={selected in entries}
          onClick={() => setEntries({ ...entries, [selected]: '' })}
        >
          Додати
        </button>
      </div>
      <button
        type="button"
        className="renewal-primary mt-4"
        disabled={busy}
        onClick={() => void save()}
      >
        {busy ? 'Зберігаю…' : 'Зберегти орієнтири'}
      </button>
      {error && (
        <p className="system-warning" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="renewal-chart-note mt-3" role="status">
          {message}
        </p>
      )}
    </section>
  );
}
export function ControlsPanel({
  data,
  refresh,
  appVersion,
}: {
  data: SystemSnapshot;
  refresh: () => Promise<void>;
  appVersion: string;
}) {
  const [budgetMessage, setBudgetMessage] = useState('');
  function exportDiagnostics() {
    const blob = new Blob([JSON.stringify({ appVersion, ...data }, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob),
      anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `svitanok-system-${data.generatedAt.slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }
  return (
    <>
      <section className="renewal-card">
        <h2 className="font-semibold">Підключення рахунків</h2>
        <p className="renewal-chart-note mt-2">
          Окремі серверні доступи. Секрети не вводяться в Mini App. Рахунки оновлюються вручну після
          налаштування доступу.
        </p>
        {data.billing?.items?.map((item) => (
          <details className="system-service renewal-inset" key={item.provider}>
            <summary>
              <span>
                <strong>{item.title}</strong>
                <span className="system-secondary">
                  {item.configured
                    ? 'Готово до ручного читання'
                    : item.supported
                      ? 'Потрібне налаштування'
                      : 'Потрібне окреме підключення'}
                </span>
              </span>
              <span aria-hidden="true">⌄</span>
            </summary>
            <div className="system-service-body">
              <ol className="system-steps">
                {item.steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
              <a
                className="renewal-secondary mt-3"
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                Офіційна інструкція ↗
              </a>
            </div>
          </details>
        ))}
      </section>
      <ReadWarning section={data.preferences} />
      {budgetMessage && (
        <p className="renewal-chart-note" role="status">
          {budgetMessage}
        </p>
      )}
      {data.preferences?.data && data.preferences.available && (
        <BudgetEditor
          key={data.preferences.data.revision}
          value={data.preferences.data}
          refresh={async () => {
            await refresh();
            setBudgetMessage('Місячні орієнтири збережено.');
          }}
        />
      )}
      <section className="renewal-card">
        <h2 className="font-semibold">Керування й діагностика</h2>
        <div className="flex flex-wrap gap-3 mt-4">
          <Link className="renewal-secondary" to="/settings">
            Модулі й інтеграції
          </Link>
          <Link className="renewal-secondary" to="/memory">
            Пам’ять асистента
          </Link>
          <button type="button" className="renewal-secondary" onClick={exportDiagnostics}>
            Експорт діагностики
          </button>
        </div>
        <p className="renewal-chart-note mt-3">
          Експорт містить метадані цього огляду без повідомлень, промптів, результатів інструментів
          і секретів. Жорсткі ліміти, нові сповіщення та довша історія налаштовуються окремо.
        </p>
        {data.deployment && (
          <details className="mt-4">
            <summary className="system-detail-summary">Версія сервера</summary>
            <p className="renewal-chart-note break-words">{data.deployment}</p>
          </details>
        )}
      </section>
    </>
  );
}
