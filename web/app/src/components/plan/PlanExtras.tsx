import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  suggestPlanTask,
  fetchPlanCalendar,
  fetchPlanPage,
  type TaskDraftSuggestion,
  type PlanWorkspace,
} from '../../api/plan.ts';
import { planLocalTime } from '../../../../core/motivation/model.mjs';
import { PLAN_AREAS } from '../../../../core/motivation/scoring.mjs';
import { readablePlanDate } from './PlanLocalTime.tsx';

type Run = (op: string, payload?: Record<string, unknown>, id?: string) => Promise<boolean>;
const nextDate = (date: string) =>
  new Date(Date.parse(`${date}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
export const WEEK_DAYS = [
  ['1', 'Пн'],
  ['2', 'Вт'],
  ['3', 'Ср'],
  ['4', 'Чт'],
  ['5', 'Пт'],
  ['6', 'Сб'],
  ['0', 'Нд'],
];

export function TaskAssist({
  date,
  onApply,
  initialText = '',
  onTextChange,
}: {
  date: string;
  onApply: (draft: TaskDraftSuggestion) => void;
  initialText?: string;
  onTextChange?: (value: string) => void;
}) {
  const [text, setText] = useState(initialText),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [questions, setQuestions] = useState<string[]>([]),
    [done, setDone] = useState(false);
  return (
    <details className="plan-assist" open>
      <summary>Допомогти заповнити з мого опису ✧</summary>
      <p className="plan-muted">
        Почни з опису — Світанок запропонує результат, час і налаштування. Нижче перевір або виправ.
        Для незалежних дій із різними строками краще створювати окремі задачі.
      </p>
      <p className="plan-muted">
        День задачі: {readablePlanDate(date)}. Для іншого дня спочатку зміни дату вище.
      </p>
      <label>
        Опиши одну задачу
        <textarea
          maxLength={3000}
          value={text}
          disabled={busy}
          onChange={(e) => {
            setText(e.target.value);
            onTextChange?.(e.target.value);
            setDone(false);
            setQuestions([]);
          }}
          placeholder="Завтра хочу попрактикувати SQL: п’ять задач самостійно, приблизно година після обіду."
        />
      </label>
      <button
        type="button"
        className="plan-secondary"
        disabled={busy || !text.trim()}
        onClick={async () => {
          setBusy(true);
          setError('');
          setDone(false);
          try {
            const draft = await suggestPlanTask(text, date);
            onApply(draft);
            setQuestions(draft.questions);
            setDone(true);
          } catch (cause) {
            setError((cause as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Готую пропозицію…' : 'Заповнити форму'}
      </button>
      {error && (
        <p role="alert" className="plan-error">
          {error}
        </p>
      )}
      {done && (
        <p role="status" className="plan-muted">
          Пропозиція у формі нижче. Перевір результат, час і XP перед збереженням.
        </p>
      )}
      {questions.map((question) => (
        <p className="plan-inset" key={question}>
          {question}
        </p>
      ))}
    </details>
  );
}
export function RepeatDays({
  days,
  onChange,
}: {
  days: number[];
  onChange: (days: number[]) => void;
}) {
  return (
    <div className="plan-weekdays" aria-label="Дні повторення">
      {WEEK_DAYS.map(([key, label]) => (
        <button
          type="button"
          key={key}
          aria-pressed={days.includes(Number(key))}
          onClick={() =>
            onChange(
              days.includes(Number(key))
                ? days.filter((n) => n !== Number(key))
                : [...days, Number(key)],
            )
          }
        >
          {label}
        </button>
      ))}
    </div>
  );
}
export function TemplatePanel({
  data,
  date,
  run,
}: {
  data: PlanWorkspace;
  date: string;
  run: Run;
}) {
  const templates = data.templates.filter((template) => !template.archived);
  return (
    <div className="plan-form">
      <h2>Мої шаблони</h2>
      <p className="plan-muted">
        Задачі на вибрані дні з’являються чернетками. Суму, час і XP можна уточнити перед
        прийняттям.
      </p>
      {!templates.length && <p>Під час додавання задачі вибери «Зберегти як шаблон».</p>}
      {templates.map((template) => (
        <article className="plan-template" key={template.id}>
          <h3>{template.title}</h3>
          <p>
            {template.days.length
              ? WEEK_DAYS.filter(([key]) => template.days.includes(Number(key)))
                  .map(([, label]) => label)
                  .join(' · ')
              : 'Тільки вручну'}
          </p>
          {template.lastErrorDate === date && (
            <p role="status" className="plan-muted">
              Потрібне уточнення: {template.lastError}. Відкрий шаблон в інший день або створи
              чернетку вручну.
            </p>
          )}
          <div className="plan-day-actions">
            <button
              disabled={template.usedDates?.includes(date)}
              onClick={() => void run('template-use', { date }, template.id)}
            >
              {template.usedDates?.includes(date) ? 'Уже підготовлено' : 'Підготувати на цей день'}
            </button>
            <button onClick={() => void run('template-archive', {}, template.id)}>
              Прибрати шаблон
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}
export function DayExtensionPanel({
  date,
  boundary,
  run,
}: {
  date: string;
  boundary: string;
  run: Run;
}) {
  const [until, setUntil] = useState('05:00'),
    [reason, setReason] = useState('Подовжений робочий день'),
    [error, setError] = useState('');
  return (
    <form
      className="plan-form"
      onSubmit={(e) => {
        e.preventDefault();
        try {
          setError('');
          void run('day-extend', { date, until: planLocalTime(nextDate(date), until), reason });
        } catch (cause) {
          setError((cause as Error).message);
        }
      }}
    >
      <h2>Подовжений день</h2>
      <p className="plan-muted">
        Один раз до межі {boundary} можна явно подовжити звичайні задачі цього дня. Точні строки не
        змінюються. Подовження зберігається в історії.
      </p>
      <label className="plan-extra-field">
        Нова межа наступного ранку · Київ
        <input
          type="time"
          required
          max="12:00"
          value={until}
          onChange={(e) => setUntil(e.target.value)}
        />
      </label>
      <label className="plan-extra-field">
        Причина
        <textarea
          required
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      {error && (
        <p role="alert" className="plan-error">
          {error}
        </p>
      )}
      <button className="plan-primary">Погодити нову межу</button>
    </form>
  );
}
export function CalendarPanel({
  date,
  data,
  run,
}: {
  date: string;
  data: PlanWorkspace;
  run: Run;
}) {
  const query = useQuery({
    queryKey: ['plan-calendar', date],
    queryFn: () => fetchPlanCalendar(date),
    retry: false,
    staleTime: 60000,
  });
  return (
    <div className="plan-form">
      <h2>Google Calendar · {date}</h2>
      <p className="plan-muted">
        Подія стає чернеткою лише за твоїм вибором. Вона залишиться у календарі; другий календарний
        запис не створюється.
      </p>
      {query.isPending && <p role="status">Завантажую події…</p>}
      {query.isError && (
        <p role="alert" className="plan-error">
          {query.error.message}
        </p>
      )}
      {query.data?.length === 0 && <p>На цей день подій немає.</p>}
      {query.data?.map((event, index) => {
        const imported = Boolean(
          event.id &&
          data.tasks.some((task) => task.calendarOriginId === event.id && task.date === date),
        );
        return (
          <article className="plan-template" key={event.id ?? index}>
            <small>
              {event.time ?? 'Увесь день'}
              {event.transparent ? ' · вільний час' : ''}
            </small>
            <h3>{event.title}</h3>
            <button
              disabled={imported}
              onClick={() =>
                void run('task-save', {
                  date,
                  title: event.title,
                  criterion: `Виконано заплановане: ${event.title}`,
                  target: 1,
                  xp: 20,
                  calendar: false,
                  calendarOriginId: event.id,
                  deadlineKind: event.time && event.endMs ? 'time' : 'day',
                  dueAt:
                    event.time && event.endMs ? new Date(event.endMs).toISOString() : undefined,
                  startAt:
                    event.time && event.startMs ? new Date(event.startMs).toISOString() : null,
                  endAt: event.time && event.endMs ? new Date(event.endMs).toISOString() : null,
                  remindMinutes: 10,
                })
              }
            >
              {imported ? 'Уже у плані' : 'Підготувати чернетку'}
            </button>
          </article>
        );
      })}
    </div>
  );
}
export function AreaInsights({ data, from }: { data: PlanWorkspace; from: string }) {
  const tasks = [
    ...new Map(
      data.tasks
        .filter((task) => task.acceptedAt && task.date >= from && task.date <= data.today)
        .map((task) => [task.resultId, task]),
    ).values(),
  ];
  return (
    <section className="plan-area-insights" aria-label="Прогрес за напрямами">
      {Object.entries(PLAN_AREAS).map(([area, label]) => {
        const rows = tasks.filter((task) => (task.area ?? 'life') === area);
        return (
          <div key={area}>
            <span>{label}</span>
            <strong>
              {rows.filter((task) => task.facts.done).length} / {rows.length}
            </strong>
            <small>
              {rows.reduce((sum, task) => sum + task.facts.credited, 0)} XP за результати
            </small>
            <meter
              aria-label={label}
              value={rows.filter((task) => task.facts.done).length}
              min={0}
              max={Math.max(1, rows.length)}
            />
          </div>
        );
      })}
    </section>
  );
}
export function EarlierHistory({ data }: { data: PlanWorkspace }) {
  const [rows, setRows] = useState<PlanWorkspace['events']>([]),
    [cursor, setCursor] = useState(data.historyCursor),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const visible = rows.filter((row) => !data.events.some((event) => event.id === row.id));
  return (
    <>
      {visible.map((event) => (
        <div className="plan-history-row" key={event.id}>
          <div>
            <strong>{event.title}</strong>
            <small>{new Date(event.at).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' })}</small>
          </div>
          <span>
            {event.delta > 0 ? '+' : ''}
            {event.delta} XP
          </span>
        </div>
      ))}
      {error && (
        <p role="alert" className="plan-error">
          {error}
        </p>
      )}
      {cursor && (
        <button
          className="plan-secondary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              const next = await fetchPlanPage(cursor);
              setRows((previous) => [
                ...new Map([...previous, ...next.events].map((row) => [row.id, row])).values(),
              ]);
              setCursor(next.historyCursor);
            } catch (cause) {
              setError((cause as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Завантажую…' : 'Раніші події'}
        </button>
      )}
    </>
  );
}
