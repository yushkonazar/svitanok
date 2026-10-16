import {
  cloneElement,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type ReactElement,
} from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  usePlan,
  usePlanChange,
  readPendingPlanCommand,
  type PlanTask,
  type PlanReward,
  type PlanWorkspace,
  type PlanCommand,
} from '../../api/plan.ts';
import { isSessionExpired } from '../../api/client.ts';
import { SessionExpired } from '../ui/SessionExpired.tsx';
import { Sheet } from '../ui/Sheet.tsx';
import { planDate, planLocalTime } from '../../../../core/motivation/model.mjs';
import {
  XP_CATEGORIES,
  PLAN_AREAS,
  suggestTaskScore,
} from '../../../../core/motivation/scoring.mjs';
import {
  TaskAssist,
  RepeatDays,
  TemplatePanel,
  DayExtensionPanel,
  CalendarPanel,
  AreaInsights,
  EarlierHistory,
} from './PlanExtras.tsx';
import { inTelegram, haptic } from '../../telegram.ts';
import { parseMoney } from '../../../../core/finance/planning.mjs';
import './plan.css';

type Payload = Record<string, unknown>;
type Run = (op: string, payload?: Payload, id?: string) => Promise<boolean>;
type Panel =
  | { type: 'task'; task?: PlanTask; goalId?: string; rewardId?: string }
  | { type: 'detail'; task: PlanTask }
  | { type: 'report'; task: PlanTask }
  | {
      type: 'reward';
      reward?: PlanReward;
      suggestion?: { title: string; price: number; scale: string };
    }
  | { type: 'path'; reward: PlanReward }
  | { type: 'redeem'; reward: PlanReward }
  | { type: 'settings' }
  | { type: 'accept' }
  | { type: 'goal' }
  | { type: 'shift' }
  | { type: 'wallet' }
  | { type: 'templates' }
  | { type: 'extend' }
  | { type: 'calendar' };
function dayPlus(date: string, days: number) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function dateText(date: string) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('uk-UA', {
    day: 'numeric',
    month: 'long',
    weekday: 'short',
  });
}
function localValue(iso: string) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Kyiv',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
    .format(new Date(iso))
    .replace(' ', 'T');
}
function localIso(value: string) {
  return planLocalTime(value.slice(0, 10), value.slice(11, 16));
}
function when(iso: string) {
  return new Date(iso).toLocaleString('uk-UA', {
    timeZone: 'Europe/Kyiv',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
function TaskStatus({ task, now }: { task: PlanTask; now: string }) {
  const label =
    task.status === 'draft'
      ? 'Чернетка'
      : task.status === 'excepted'
        ? 'Виняток'
        : task.facts.onTimeUnits >= task.target
          ? 'Вчасно'
          : task.facts.done
            ? 'Зроблено пізніше'
            : task.forfeitedAt
              ? 'Підсумок зафіксовано'
              : task.dueAt < now
                ? 'Потрібен факт'
                : task.startedAt
                  ? 'У роботі'
                  : task.startAt
                    ? when(task.startAt)
                    : task.deadlineKind === 'time'
                      ? `До ${when(task.dueAt)}`
                      : task.deadlineKind === 'shift'
                        ? 'До завершення зміни'
                        : 'Протягом дня';
  return <span className={`plan-status ${task.facts.done ? 'is-done' : ''}`}>{label}</span>;
}
function Meter({ value, max, label }: { value: number; max: number; label: string }) {
  return (
    <div
      className="plan-meter"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.min(value, max)}
      aria-label={label}
    >
      <span style={{ width: `${Math.min(100, Math.max(0, (value / max) * 100))}%` }} />
    </div>
  );
}
function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  const id = useId();
  return (
    <div className="plan-field">
      <label htmlFor={id}>{label}</label>
      {cloneElement(children as ReactElement<Record<string, unknown>>, {
        id,
        'aria-describedby': hint ? `${id}-hint` : undefined,
      })}
      {hint && <small id={`${id}-hint`}>{hint}</small>}
    </div>
  );
}
function FormTitle({ children, sub }: { children: ReactNode; sub?: string }) {
  return (
    <div className="plan-form-title">
      <h2>{children}</h2>
      {sub && <p>{sub}</p>}
    </div>
  );
}

export function PlanScreen() {
  const query = usePlan(),
    mutation = usePlanChange();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<'day' | 'progress' | 'rewards'>('day');
  const [showDone, setShowDone] = useState(false);
  const [panel, setPanel] = useState<Panel | null>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [undo, setUndo] = useState<{ taskId: string; reportId: string } | null>(null);
  const [recovery, setRecovery] = useState(readPendingPlanCommand);
  const retry = useRef<{ signature: string; command: PlanCommand } | null>(null);
  const data = query.data;
  if (isSessionExpired(query.error) || isSessionExpired(mutation.error)) return <SessionExpired />;
  if (!data)
    return (
      <div className="plan-empty">
        <h2>Твій план і можливості</h2>
        {query.isError ? (
          <>
            <p role="alert">{query.error.message}</p>
            <button onClick={() => void query.refetch()}>Спробувати знову</button>
          </>
        ) : (
          <p>Завантажую план…</p>
        )}
      </div>
    );
  const deepTask = data.tasks.find((t) => t.id === params.get('task'));
  let date = deepTask?.date ?? data.today;
  try {
    if (params.get('date')) date = planDate(params.get('date'));
  } catch {
    /* ignore malformed deep links */
  }
  const activePanel = panel ?? (deepTask ? { type: 'detail' as const, task: deepTask } : null);
  const tasks = data.tasks
      .filter((t) => t.date === date)
      .sort(
        (a, b) =>
          Number(a.facts.done) - Number(b.facts.done) ||
          (a.startAt ?? a.dueAt).localeCompare(b.startAt ?? b.dueAt),
      ),
    drafts = tasks.filter((t) => t.status === 'draft'),
    accepted = tasks.filter((t) => t.acceptedAt),
    done = accepted.filter((t) => t.facts.done);
  const reward = data.rewards.find(
      (r) =>
        r.id === data.primaryRewardId &&
        !r.archived &&
        (r.repeatable || !data.coupons.some((c) => c.rewardId === r.id && c.status !== 'refunded')),
    ),
    shift = data.shifts.find((s) => !s.endedAt);
  const close = () => {
    setPanel(null);
    setError('');
    if (params.has('task')) {
      const next = new URLSearchParams(params);
      next.delete('task');
      next.set('date', date);
      setParams(next, { replace: true });
    }
  };
  const open = (next: Panel) => {
    setError('');
    setPanel(next);
  };
  const run: Run = async (op, payload = {}, id) => {
    if (mutation.isPending) return false;
    if (recovery) {
      setError('Спочатку перевір останній непідтверджений запис.');
      return false;
    }
    setError('');
    const signature = JSON.stringify({ op, payload, id });
    const command =
      retry.current?.signature === signature
        ? retry.current.command
        : {
            op,
            payload:
              op === 'report' && !payload.actualAt
                ? {
                    ...payload,
                    actualAt: new Date(
                      Date.parse(data.now) + Math.max(0, Date.now() - query.dataUpdatedAt),
                    ).toISOString(),
                  }
                : payload,
            id,
            commandId: crypto.randomUUID(),
            revision: data.revision,
          };
    retry.current = { signature, command };
    try {
      const result = await mutation.mutateAsync(command);
      retry.current = null;
      setNotice(result.receipt.message);
      haptic('light');
      if (op === 'report' && id && result.receipt.reportId)
        setUndo({ taskId: id, reportId: result.receipt.reportId });
      else setUndo(null);
      return true;
    } catch (cause) {
      setRecovery(readPendingPlanCommand());
      if (cause instanceof Error && 'status' in cause && Number(cause.status) < 500)
        retry.current = null;
      setError(cause instanceof Error ? cause.message : 'Не вдалося підтвердити запис.');
      return false;
    }
  };
  const save: Run = async (...args) => {
    const ok = await run(...args);
    if (ok) close();
    return ok;
  };
  const recoverLast = async () => {
    if (!recovery) return;
    try {
      const result = await mutation.mutateAsync(recovery);
      setNotice(result.receipt.message);
      setRecovery(null);
      retry.current = null;
      close();
    } catch (cause) {
      setRecovery(readPendingPlanCommand());
      setError((cause as Error).message);
    }
  };
  const summaryXp = drafts.reduce((n, t) => n + t.xp - t.facts.credited, 0),
    summaryRisk = drafts.reduce(
      (n, t) =>
        n +
        Math.ceil(
          (((t.xp * data.settings.penaltyPercent) / 100) * (t.target - t.facts.units)) / t.target,
        ),
      0,
    );
  const selectDate = (next: string) => {
    setParams({ date: next });
    setTab('day');
    setPanel(null);
  };
  return (
    <section className="plan-screen" aria-label="Особистий план">
      <header className="plan-heading">
        <div>
          <span className="plan-eyebrow">ТВОЇ КРОКИ</span>
          <h1>Мій план</h1>
        </div>
        <button
          className="plan-wallet"
          aria-label={`Баланс: ${data.wallet.balance} XP`}
          onClick={() => open({ type: 'wallet' })}
        >
          <strong>
            {new Intl.NumberFormat('uk-UA', {
              notation: data.wallet.balance > 99999 ? 'compact' : 'standard',
              maximumFractionDigits: 1,
            }).format(data.wallet.balance)}
          </strong>
          <span>XP на балансі ↗</span>
        </button>
        <button
          className="plan-icon"
          aria-label="Правила плану"
          onClick={() => open({ type: 'settings' })}
        >
          ⚙
        </button>
      </header>
      {!inTelegram() && (
        <p className="plan-demo">
          Демо на цьому пристрої · особисті дані й нагадування не змінюються
        </p>
      )}
      <nav className="plan-tabs" aria-label="Розділи плану">
        {(['day', 'progress', 'rewards'] as const).map((item, i) => (
          <button
            key={item}
            aria-current={tab === item ? 'page' : undefined}
            onClick={() => setTab(item)}
          >
            {['День', 'Прогрес', 'Винагороди'][i]}
          </button>
        ))}
      </nav>
      <div className="plan-feedback" aria-live="polite">
        {notice && (
          <div className="plan-toast">
            {notice}
            {undo && (
              <button
                disabled={mutation.isPending}
                onClick={() => void run('undo-report', { reportId: undo.reportId }, undo.taskId)}
              >
                Скасувати позначку
              </button>
            )}
          </div>
        )}
      </div>
      {recovery && (
        <div className="plan-onboard">
          <p>
            Є запис, підтвердження якого не надійшло. Перевіримо ту саму дію з тим самим
            ідентифікатором.
          </p>
          <button
            className="plan-primary"
            disabled={mutation.isPending}
            onClick={() => void recoverLast()}
          >
            Перевірити останній запис
          </button>
        </div>
      )}
      {query.isError && (
        <div className="plan-error" role="alert">
          Показую останній завантажений стан.{' '}
          <button onClick={() => void query.refetch()}>Оновити план</button>
        </div>
      )}
      {error && !activePanel && (
        <p role="alert" className="plan-error">
          {error}
        </p>
      )}
      {tab === 'day' && (
        <>
          <div className="plan-date-nav">
            <button aria-label="Попередній день" onClick={() => selectDate(dayPlus(date, -1))}>
              ‹
            </button>
            <label>
              <strong>
                {date === data.today
                  ? 'Сьогодні'
                  : date === dayPlus(data.today, 1)
                    ? 'Завтра'
                    : dateText(date)}
              </strong>
              <input
                type="date"
                aria-label="Дата плану"
                value={date}
                onChange={(e) => e.target.value && selectDate(e.target.value)}
              />
            </label>
            <button aria-label="Наступний день" onClick={() => selectDate(dayPlus(date, 1))}>
              ›
            </button>
          </div>
          <div className="plan-quick-tools">
            <button onClick={() => open({ type: 'templates' })}>▤ Шаблони</button>
            <button onClick={() => open({ type: 'calendar' })}>▦ Календар</button>
            <button onClick={() => open({ type: 'extend' })}>◷ Подовжений день</button>
          </div>
          {!data.settings.reviewedAt && !data.settings.enabled && (
            <div className="plan-onboard">
              <h2>Твої рішення. Відомі наслідки.</h2>
              <p>
                Спочатку запиши справи. До прийняття це чернетка; після — усі задачі мають XP, строк
                і погоджений штраф.
              </p>
              <button className="plan-primary" onClick={() => open({ type: 'settings' })}>
                Переглянути й увімкнути правила
              </button>
            </div>
          )}
          {shift && (
            <div className="plan-shift">
              <div>
                <strong>Зміна триває</strong>
                <small>Перевірка до {when(shift.reviewAt)}</small>
              </div>
              <button
                disabled={mutation.isPending}
                onClick={() => void run('shift-close', {}, shift.id)}
              >
                Завершити зміну
              </button>
            </div>
          )}
          <div className="plan-list-heading">
            <div>
              <h2>{drafts.length && !accepted.length ? 'Готую план' : 'Мої кроки'}</h2>
              <p>
                {accepted.length
                  ? `${done.length} із ${accepted.length} результатів · ${dateText(date)}`
                  : 'Ти визначаєш, що для тебе важливо.'}
              </p>
            </div>
            <button
              className="plan-add"
              onClick={() => open({ type: 'task' })}
              aria-label="Додати задачу"
            >
              ＋
            </button>
          </div>
          {tasks.length === 0 ? (
            <div className="plan-empty">
              <span className="plan-empty-sun">◒</span>
              <h3>З чого почнеться цей день?</h3>
              <p>Додай важливу справу й опиши, який результат означатиме «зроблено».</p>
              <button className="plan-primary" onClick={() => open({ type: 'task' })}>
                Додати першу задачу
              </button>
            </div>
          ) : (
            <div className="plan-task-list">
              {tasks
                .filter((task) => showDone || !task.facts.done)
                .map((task) => (
                  <article
                    key={task.id}
                    className={`plan-task ${task.facts.done ? 'is-done' : ''} ${task.status === 'draft' ? 'is-draft' : ''}`}
                  >
                    <button
                      className="plan-check"
                      aria-label={
                        task.status === 'draft'
                          ? `Редагувати ${task.title}`
                          : task.facts.done
                            ? `Переглянути ${task.title}`
                            : `Виконати ${task.title}`
                      }
                      disabled={mutation.isPending}
                      onClick={() => {
                        if (task.status === 'draft') open({ type: 'task', task });
                        else if (task.source) open({ type: 'detail', task });
                        else if (task.facts.done || task.status === 'excepted')
                          open({ type: 'detail', task });
                        else if (task.target === 1 && task.dueAt >= data.now)
                          void run('report', { units: 1 }, task.id);
                        else open({ type: 'report', task });
                      }}
                    >
                      {task.facts.done
                        ? '✓'
                        : task.status === 'draft'
                          ? '＋'
                          : task.status === 'excepted'
                            ? '—'
                            : ''}
                    </button>
                    <button
                      className="plan-task-body"
                      onClick={() =>
                        open({ type: task.status === 'draft' ? 'task' : 'detail', task })
                      }
                    >
                      <TaskStatus task={task} now={data.now} />
                      {task.area && (
                        <span className="plan-area-label">{PLAN_AREAS[task.area]}</span>
                      )}
                      <h3>{task.title}</h3>
                      <p>{task.criterion}</p>
                      {task.target > 1 && (
                        <>
                          <Meter value={task.facts.units} max={task.target} label={task.title} />
                          <small>
                            {task.source?.actualMinor != null
                              ? (task.source.actualMinor / 100).toLocaleString('uk-UA', {
                                  maximumFractionDigits: 2,
                                })
                              : task.facts.units}{' '}
                            / {task.target} {task.source ? 'грн' : task.unit}
                          </small>
                        </>
                      )}
                      {task.source && (
                        <small className="plan-source-label">
                          ↔ Таксі ·{' '}
                          {task.source.metric === 'net' ? 'каса після комісії' : 'каса до комісії'}{' '}
                          · автоматично
                        </small>
                      )}
                      {task.firstStep && !task.startedAt && !task.facts.done && (
                        <small className="plan-first-step">Почати: {task.firstStep}</small>
                      )}
                    </button>
                    <div className="plan-task-xp">
                      <strong>
                        +{Math.max(0, task.xp - (task.fromTaskId ? task.facts.credited : 0))}
                      </strong>
                      <small>
                        {task.status === 'draft'
                          ? `−${Math.ceil((task.xp * data.settings.penaltyPercent) / 100)}`
                          : task.settledAt
                            ? `−${task.penaltyApplied ?? 0}`
                            : `ризик −${task.facts.risk}`}
                      </small>
                    </div>
                  </article>
                ))}
            </div>
          )}
          {tasks.some((task) => task.facts.done) && (
            <button className="plan-done-toggle" onClick={() => setShowDone(!showDone)}>
              {showDone ? 'Згорнути виконані' : 'Показати виконані'} · {done.length}
            </button>
          )}
          {drafts.length > 0 && (
            <div className="plan-accept-bar">
              <p>
                {drafts.length} у чернетці · +{summaryXp} XP · ризик −{summaryRisk}
              </p>
              <button
                className="plan-primary"
                disabled={!data.settings.enabled || mutation.isPending}
                onClick={() => open({ type: 'accept' })}
              >
                Прийняти {accepted.length ? 'нові задачі' : 'план'}
              </button>
            </div>
          )}
          {reward ? (
            <button className="plan-next-reward" onClick={() => open({ type: 'path', reward })}>
              <span>
                Наступна можливість <b>{reward.title}</b>
              </span>
              <strong>
                {reward.mode === 'unlock' ? data.wallet.experience : data.wallet.available} /{' '}
                {reward.price} XP ↗
              </strong>
              <Meter
                value={reward.mode === 'unlock' ? data.wallet.experience : data.wallet.available}
                max={reward.price}
                label={`Шлях до ${reward.title}`}
              />
            </button>
          ) : (
            <button className="plan-next-reward" onClick={() => setTab('rewards')}>
              Обрати, заради чого стараюся ↗
            </button>
          )}
          <div className="plan-day-actions">
            <button onClick={() => selectDate(dayPlus(data.today, 1))}>Підготувати завтра ↗</button>
            <button onClick={() => setTab('progress')}>Оглянути день</button>
            {!shift && <button onClick={() => open({ type: 'shift' })}>Почати робочу зміну</button>}
          </div>
          <p className="plan-footnote">
            Звичайний день — до {data.settings.dayBoundary} за Києвом. Точні строки й зміна мають
            власні межі. За відкриття апки XP немає.
          </p>
        </>
      )}
      {tab === 'progress' && (
        <Progress
          data={data}
          onDate={selectDate}
          onGoal={() => open({ type: 'goal' })}
          onTask={(goalId) => {
            setTab('day');
            open({ type: 'task', goalId });
          }}
        />
      )}
      {tab === 'rewards' && (
        <>
          <div className="plan-list-heading">
            <div>
              <h2>Можливості, які обираєш ти</h2>
              <p>
                Доступно {data.wallet.available} XP · у резерві {data.wallet.reserved}
              </p>
            </div>
            <button
              className="plan-add"
              aria-label="Додати винагороду"
              onClick={() => open({ type: 'reward' })}
            >
              ＋
            </button>
          </div>
          {data.rewards
            .filter((r) => !r.archived)
            .map((r) => (
              <button
                key={r.id}
                className="plan-reward"
                onClick={() => open({ type: 'path', reward: r })}
              >
                <span className="plan-reward-mark">
                  {r.scale === 'large' ? '✧' : r.scale === 'middle' ? '◇' : '◒'}
                </span>
                <div>
                  <span className="plan-eyebrow">
                    {r.id === data.primaryRewardId
                      ? 'ОБРАНА ЦІЛЬ'
                      : r.scale === 'near'
                        ? 'БЛИЗЬКА'
                        : r.scale === 'middle'
                          ? 'НАСТУПНА СХОДИНКА'
                          : 'ВЕЛИКА МОЖЛИВІСТЬ'}
                  </span>
                  <h3>{r.title}</h3>
                  <Meter
                    value={r.mode === 'unlock' ? data.wallet.experience : data.wallet.available}
                    max={r.price}
                    label={r.title}
                  />
                  <small>
                    {data.coupons.some((c) => c.rewardId === r.id && c.status !== 'refunded') &&
                    !r.repeatable
                      ? 'Уже відкрито'
                      : r.gate && !r.gate.confirmed
                        ? 'Потрібен реальний етап готовності'
                        : r.purchase && !r.affordability?.ready
                          ? 'Потрібен фінансовий запас'
                          : (r.mode === 'unlock'
                                ? data.wallet.experience
                                : data.wallet.available) >= r.price &&
                              (!r.purchase || r.affordability?.ready)
                            ? 'XP достатньо'
                            : `Ще ${Math.max(0, r.price - (r.mode === 'unlock' ? data.wallet.experience : data.wallet.available))} XP`}
                  </small>
                </div>
                <strong>
                  {r.price}
                  <small>XP ↗</small>
                </strong>
              </button>
            ))}
          {data.coupons.length > 0 && (
            <>
              <h2 className="plan-section-title">Мої дозволи</h2>
              {data.coupons
                .slice()
                .reverse()
                .map((c) => (
                  <div className="plan-coupon" key={c.id}>
                    <div>
                      <strong>{c.title}</strong>
                      <p>
                        {c.status === 'unlocked' ? (c.unlockXp ?? 0) : c.price} XP ·{' '}
                        {c.status === 'ready'
                          ? 'Готовий до використання'
                          : c.status === 'unlocked'
                            ? 'Відкрито назавжди'
                            : c.status === 'used'
                              ? 'Використано'
                              : 'XP повернено'}
                      </p>
                    </div>
                    {c.status === 'ready' && (
                      <div>
                        <button
                          disabled={mutation.isPending}
                          onClick={() => void run('coupon-use', {}, c.id)}
                        >
                          Використав
                        </button>
                        <button
                          disabled={mutation.isPending}
                          onClick={() => void run('coupon-refund', {}, c.id)}
                        >
                          Повернути XP
                        </button>
                      </div>
                    )}
                  </div>
                ))}
            </>
          )}
          <h2 className="plan-section-title">Ідеї для твого вибору</h2>
          <p className="plan-muted">
            Це кандидати й початкові ціни. Додай тільки те, чого справді хочеш.
          </p>
          <div className="plan-suggestions">
            {data.suggestions.map((s) => (
              <button key={s.title} onClick={() => open({ type: 'reward', suggestion: s })}>
                <span>{s.title}</span>
                <small>{s.price} XP ＋</small>
              </button>
            ))}
          </div>
        </>
      )}
      {activePanel && (
        <Sheet
          label={
            activePanel.type === 'task'
              ? 'Задача'
              : activePanel.type === 'report'
                ? 'Факт виконання'
                : 'План і можливості'
          }
          onClose={close}
        >
          <div className="plan-screen plan-sheet">
            <button className="plan-close" onClick={close} aria-label="Закрити панель">
              Закрити ×
            </button>
            {error && (
              <p className="plan-error" role="alert">
                {error}
              </p>
            )}
            {recovery && (
              <button
                className="plan-primary"
                disabled={mutation.isPending}
                onClick={() => void recoverLast()}
              >
                Перевірити останній запис
              </button>
            )}
            <fieldset disabled={mutation.isPending} className="plan-fieldset">
              {activePanel.type === 'task' && (
                <TaskEditor
                  key={
                    activePanel.task?.id ??
                    `${date}-${activePanel.goalId ?? ''}-${activePanel.rewardId ?? ''}`
                  }
                  date={date}
                  data={data}
                  initial={activePanel.task}
                  goalId={activePanel.goalId}
                  rewardId={activePanel.rewardId}
                  save={save}
                  onError={setError}
                />
              )}
              {activePanel.type === 'settings' && <Settings data={data} save={save} />}
              {activePanel.type === 'templates' && (
                <TemplatePanel
                  data={data}
                  date={date}
                  run={async (...args) => {
                    const ok = await run(...args);
                    if (ok && args[0] === 'template-use') close();
                    return ok;
                  }}
                />
              )}
              {activePanel.type === 'extend' && (
                <DayExtensionPanel date={date} boundary={data.settings.dayBoundary} run={save} />
              )}
              {activePanel.type === 'calendar' && (
                <CalendarPanel date={date} data={data} run={save} />
              )}
              {activePanel.type === 'report' && (
                <Report
                  task={data.tasks.find((t) => t.id === activePanel.task.id) ?? activePanel.task}
                  save={save}
                  onError={setError}
                />
              )}
              {activePanel.type === 'reward' && (
                <RewardEditor
                  initial={activePanel.reward}
                  suggestion={activePanel.suggestion}
                  primary={data.primaryRewardId === activePanel.reward?.id}
                  save={save}
                />
              )}
              {activePanel.type === 'goal' && <GoalEditor date={date} save={save} />}
              {activePanel.type === 'shift' && (
                <ShiftEditor date={data.today} save={save} onError={setError} />
              )}
              {activePanel.type === 'wallet' && (
                <>
                  <FormTitle sub="Один баланс для всіх важливих сфер твого життя.">
                    Твої XP
                  </FormTitle>
                  <dl className="plan-facts">
                    <dt>Баланс</dt>
                    <dd>{data.wallet.balance} XP</dd>
                    <dt>Відкритий ризик</dt>
                    <dd>{data.wallet.risk} XP</dd>
                    <dt>Зарезервовано</dt>
                    <dd>{data.wallet.reserved} XP</dd>
                    <dt>Доступно для винагород</dt>
                    <dd>{data.wallet.available} XP</dd>
                    <dt>Накопичений досвід</dt>
                    <dd>{data.wallet.experience} XP</dd>
                  </dl>
                  <p className="plan-muted">
                    Резерв покриває ще не підсумовані обіцянки. Виконуєш вчасно — він вивільняється.
                    Досвід зберігає зроблене; штрафи й винагороди змінюють баланс. Нижче нуля баланс
                    не опускається.
                  </p>
                </>
              )}
              {activePanel.type === 'accept' && (
                <>
                  <FormTitle
                    sub={`${dateText(date)} · усі перелічені задачі матимуть наслідок невиконання.`}
                  >
                    Мій план — моє рішення
                  </FormTitle>
                  <dl className="plan-facts">
                    <dt>Задач</dt>
                    <dd>{drafts.length}</dd>
                    <dt>За результат</dt>
                    <dd>+{summaryXp} XP</dd>
                    <dt>Максимальна втрата</dt>
                    <dd>−{summaryRisk} XP</dd>
                  </dl>
                  {drafts.map((t) => (
                    <div key={t.id} className="plan-agreement">
                      <strong>{t.title}</strong>
                      <p>{t.criterion}</p>
                      <small>
                        До {when(t.dueAt)} · +{t.xp} / −
                        {Math.ceil((t.xp * data.settings.penaltyPercent) / 100)} XP
                      </small>
                      {t.calendar && (
                        <small>
                          Google Calendar: {when(t.startAt!)} — {when(t.endAt!)}
                        </small>
                      )}
                    </div>
                  ))}
                  <p className="plan-muted">
                    Чернетки не штрафуються. Після прийняття строки й оцінка фіксуються; звичайний
                    перенос їх не скасовує.
                  </p>
                  <button className="plan-primary" onClick={() => void save('accept', { date })}>
                    Приймаю цей план
                  </button>
                </>
              )}
              {activePanel.type === 'detail' && (
                <TaskDetail
                  task={data.tasks.find((t) => t.id === activePanel.task.id) ?? activePanel.task}
                  data={data}
                  run={run}
                  save={save}
                  open={open}
                  onError={setError}
                />
              )}
              {activePanel.type === 'path' && (
                <RewardPath
                  reward={
                    data.rewards.find((r) => r.id === activePanel.reward.id) ?? activePanel.reward
                  }
                  data={data}
                  open={open}
                  run={save}
                />
              )}
              {activePanel.type === 'redeem' && (
                <>
                  <FormTitle
                    sub={
                      activePanel.reward.mode === 'unlock'
                        ? 'Постійний етап за досвідом. Баланс XP залишається.'
                        : 'XP обмінюються на один особистий дозвіл. Реальна покупка чи оплата виконується тобою.'
                    }
                  >
                    Отримати «{activePanel.reward.title}»
                  </FormTitle>
                  <dl className="plan-facts">
                    <dt>Вартість</dt>
                    <dd>{activePanel.reward.price} XP</dd>
                    <dt>Баланс після</dt>
                    <dd>
                      {data.wallet.balance -
                        (activePanel.reward.mode === 'unlock' ? 0 : activePanel.reward.price)}{' '}
                      XP
                    </dd>
                    <dt>Доступно після</dt>
                    <dd>
                      {data.wallet.available -
                        (activePanel.reward.mode === 'unlock' ? 0 : activePanel.reward.price)}{' '}
                      XP
                    </dd>
                  </dl>
                  <p className="plan-muted">
                    {activePanel.reward.mode === 'unlock'
                      ? 'Цей доступ залишиться відкритим. XP не витрачаються.'
                      : 'Невикористаний дозвіл можна повернути з відновленням XP. Витрачені XP віддаляють наступну покупку.'}
                  </p>
                  <button
                    className="plan-primary"
                    onClick={() => void save('redeem', {}, activePanel.reward.id)}
                  >
                    {activePanel.reward.mode === 'unlock' ? 'Відкрити за досвідом' : 'Обміняти'}{' '}
                    {activePanel.reward.price} XP
                  </button>
                </>
              )}
            </fieldset>
            {mutation.isPending && (
              <p role="status" className="plan-muted">
                Зберігаю й перевіряю…
              </p>
            )}
          </div>
        </Sheet>
      )}
    </section>
  );
}

function TaskEditor({
  date,
  data,
  initial,
  goalId,
  rewardId,
  save,
  onError,
}: {
  date: string;
  data: PlanWorkspace;
  initial?: PlanTask;
  goalId?: string;
  rewardId?: string;
  save: Run;
  onError: (s: string) => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? ''),
    [criterion, setCriterion] = useState(initial?.criterion ?? ''),
    [target, setTarget] = useState(initial?.target ?? 1),
    [unit, setUnit] = useState(initial?.unit ?? 'крок');
  const [effort, setEffort] = useState(initial?.effort ?? 1),
    [contribution, setContribution] = useState(initial?.contribution ?? 0),
    [xp, setXp] = useState(initial?.xp ?? 20);
  const [deadline, setDeadline] = useState(initial?.deadlineKind ?? 'day'),
    [due, setDue] = useState(initial ? localValue(initial.dueAt) : `${date}T21:00`),
    [sensitive, setSensitive] = useState(initial?.timeSensitive ?? false);
  const [first, setFirst] = useState(initial?.firstStep ?? ''),
    [start, setStart] = useState(initial?.startAt ? localValue(initial.startAt) : ''),
    [end, setEnd] = useState(initial?.endAt ? localValue(initial.endAt) : ''),
    [calendar, setCalendar] = useState(initial?.calendar ?? false),
    [remind, setRemind] = useState(
      initial?.remindMinutes == null ? (initial ? '' : '10') : String(initial.remindMinutes),
    ),
    [estimate, setEstimate] = useState(initial?.estimateMinutes ?? 0),
    [goal, setGoal] = useState(initial?.goalId ?? goalId ?? ''),
    [reward, setReward] = useState(initial?.rewardId ?? rewardId ?? '');
  const shift = data.shifts.find((s) => !s.endedAt && s.date === date);
  const [area, setArea] = useState(initial?.area ?? 'life'),
    [challenge, setChallenge] = useState(initial?.challenge ?? 0),
    [routine, setRoutine] = useState(initial?.routine ?? false),
    [source, setSource] = useState(initial?.source?.metric ?? ''),
    [template, setTemplate] = useState(false),
    [templateDays, setTemplateDays] = useState([1, 2, 3, 4, 5]);
  const suggested = (overrides: Record<string, unknown> = {}) =>
    suggestTaskScore({
      effort,
      contribution,
      challenge,
      routine,
      estimateMinutes: estimate,
      ...overrides,
    });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    try {
      void save(
        'task-save',
        {
          date,
          title,
          criterion,
          target,
          unit,
          effort,
          contribution,
          area,
          challenge,
          routine,
          scoringVersion: 2,
          source: source ? { kind: 'taxi', metric: source } : null,
          template,
          templateDays,
          calendarOriginId: initial?.calendarOriginId ?? null,
          xp,
          deadlineKind: deadline,
          dueAt:
            deadline === 'shift'
              ? (shift?.reviewAt ?? planLocalTime(dayPlus(date, 1), '12:00'))
              : deadline === 'time'
                ? localIso(due)
                : undefined,
          timeSensitive: sensitive,
          firstStep: first,
          startAt: start ? localIso(start) : null,
          endAt: end ? localIso(end) : null,
          calendar,
          remindMinutes: remind === '' ? null : Number(remind),
          estimateMinutes: estimate,
          goalId: goal || null,
          rewardId: reward || null,
        },
        initial?.id,
      );
    } catch (error) {
      onError((error as Error).message);
    }
  };
  return (
    <form onSubmit={submit} className="plan-form">
      <FormTitle sub="Спочатку результат. Час, підказки й зв’язки — за потреби.">
        {initial ? 'Уточнити чернетку' : 'Новий крок'}
      </FormTitle>
      {!initial?.fromTaskId && (
        <TaskAssist
          date={date}
          onApply={(draft) => {
            setTitle(draft.title);
            setCriterion(draft.criterion);
            setTarget(draft.target);
            setUnit(draft.unit);
            setArea(draft.area);
            setEffort(draft.effort);
            setContribution(draft.contribution);
            setChallenge(draft.challenge);
            setRoutine(draft.routine);
            setEstimate(draft.estimateMinutes);
            setFirst(draft.firstStep);
            setXp(draft.xp);
            setSource(
              draft.source === 'taxi-net' ? 'net' : draft.source === 'taxi-gross' ? 'gross' : '',
            );
            setSensitive(draft.timeSensitive);
            if (draft.dueTime) {
              setDeadline('time');
              setDue(
                `${draft.dueTime < data.settings.dayBoundary ? dayPlus(date, 1) : date}T${draft.dueTime}`,
              );
            } else setDeadline('day');
            setStart(
              draft.startTime
                ? `${draft.startTime < data.settings.dayBoundary ? dayPlus(date, 1) : date}T${draft.startTime}`
                : '',
            );
          }}
        />
      )}
      <Field label="Напрям">
        <select value={area} onChange={(e) => setArea(e.target.value)}>
          {Object.entries(PLAN_AREAS).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Що хочу зробити">
        <input
          required
          maxLength={180}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Наприклад, попрактикувати SQL"
          autoFocus
        />
      </Field>
      <Field
        label="Коли це означатиме «зроблено»"
        hint="Конкретний результат допомагає чесно оцінити виконання."
      >
        <textarea
          required
          maxLength={500}
          value={criterion}
          onChange={(e) => setCriterion(e.target.value)}
          placeholder="Розв’язано 5 задач самостійно"
        />
      </Field>
      <div className="plan-form-row">
        <Field label="Обсяг">
          <input
            type="number"
            required
            min={1}
            max={100000000}
            step={1}
            value={target}
            onChange={(e) => setTarget(Number(e.target.value))}
          />
        </Field>
        <Field label="Одиниця">
          <input
            maxLength={24}
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            placeholder="задач / грн / крок"
          />
        </Field>
      </div>
      <Field label="Як фіксується результат">
        <select
          value={source}
          onChange={(e) => {
            setSource(e.target.value as typeof source);
            if (e.target.value) {
              setUnit('грн');
              setSensitive(false);
              if (target === 1) setTarget(3500);
              setArea('work');
            }
          }}
        >
          <option value="">Вручну: позначка або число</option>
          <option value="net">З таксі · каса після комісії</option>
          <option value="gross">З таксі · каса до комісії</option>
        </select>
      </Field>
      {source && (
        <p className="plan-muted">
          Ціль — у цілих гривнях. Після прийняття прогрес надходитиме із записів таксі цього дня; XP
          і завершення рахуються автоматично. Уточнення фінансового запису уточнить результат. Для
          одного проміжку — одна пов’язана обіцянка.
        </p>
      )}
      <Field label="Строк">
        <select value={deadline} onChange={(e) => setDeadline(e.target.value as typeof deadline)}>
          <option value="day">До кінця мого дня · {data.settings.dayBoundary}</option>
          <option value="time">Точна дата й час</option>
          <option value="shift">До завершення робочої зміни</option>
        </select>
      </Field>
      {deadline === 'time' && (
        <Field label="Крайній час · Київ">
          <input
            type="datetime-local"
            required
            value={due}
            onChange={(e) => setDue(e.target.value)}
          />
        </Field>
      )}
      {deadline === 'shift' && (
        <p className="plan-muted">
          {shift
            ? `Поточна зміна: перевірка до ${when(shift.reviewAt)}.`
            : `Без відкритої зміни межа перевірки — ${dateText(dayPlus(date, 1))}, 12:00. Почнеш зміну — вона прив’яжеться до цього дня.`}{' '}
          Підсумок зміни фіксується окремо від звичайної межі дня.
        </p>
      )}
      <label className="plan-toggle">
        <input
          type="checkbox"
          checked={sensitive}
          disabled={Boolean(source)}
          onChange={(e) => {
            setSensitive(e.target.checked);
            if (e.target.checked) setTarget(1);
          }}
        />
        Сам час — частина результату («встати до…»)
      </label>
      <div className="plan-score">
        <div className="plan-form-row">
          <Field label="Зусилля">
            <select
              value={effort}
              onChange={(e) => {
                setEffort(Number(e.target.value));
                setXp(suggested({ effort: Number(e.target.value) }).xp);
              }}
            >
              <option value={0}>Малі</option>
              <option value={1}>Звичайні</option>
              <option value={2}>Значні</option>
            </select>
          </Field>
          <Field label="Внесок">
            <select
              value={contribution}
              onChange={(e) => {
                setContribution(Number(e.target.value));
                setXp(suggested({ contribution: Number(e.target.value) }).xp);
              }}
            >
              <option value={0}>Необхідна дія</option>
              <option value={1}>Важливий крок до цілі</option>
            </select>
          </Field>
        </div>
        <Field label="Особистий виклик">
          <select
            value={challenge}
            onChange={(e) => {
              setChallenge(Number(e.target.value));
              setXp(suggested({ challenge: Number(e.target.value) }).xp);
            }}
          >
            <option value={0}>Звична складність</option>
            <option value={1}>Потрібно подолати відкладання або опанувати нове</option>
            <option value={2}>Складний самостійний результат</option>
          </select>
        </Field>
        <label className="plan-toggle">
          <input
            type="checkbox"
            checked={routine}
            onChange={(e) => {
              setRoutine(e.target.checked);
              setXp(suggested({ routine: e.target.checked }).xp);
            }}
          />
          Звична повторювана дія
        </label>
        <p className="plan-muted">
          Пропозиція: {suggested().title} · {suggested().xp} XP.{' '}
          {XP_CATEGORIES.find((category) => category.xp === xp)?.detail}
        </p>
        <div className="plan-score-result">
          <span>
            За результат <strong>+{xp} XP</strong>
          </span>
          <span>
            Ризик <strong>−{Math.ceil((xp * data.settings.penaltyPercent) / 100)} XP</strong>
          </span>
        </div>
        <details>
          <summary>Уточнити оцінку</summary>
          <Field label="Погоджена смуга XP">
            <select value={xp} onChange={(e) => setXp(Number(e.target.value))}>
              {XP_CATEGORIES.map((category) => (
                <option key={category.xp} value={category.xp}>
                  {category.xp} XP · {category.title}
                </option>
              ))}
            </select>
          </Field>
          <p className="plan-muted">
            Оцінка за результат, не за хвилини. Після прийняття вона фіксується.
          </p>
        </details>
      </div>
      <details open={Boolean(initial?.startAt || goalId || rewardId)}>
        <summary>Початок, нагадування й зв’язки</summary>
        <Field label="Перший простий крок">
          <input
            maxLength={300}
            value={first}
            onChange={(e) => setFirst(e.target.value)}
            placeholder="Після сніданку відкрити першу задачу"
          />
        </Field>
        <Field label="Запланований початок · Київ">
          <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
        </Field>
        <Field label="Нагадати до початку або строку">
          <select value={remind} onChange={(e) => setRemind(e.target.value)}>
            <option value="">Без сигналу</option>
            <option value="0">У момент початку</option>
            <option value="10">За 10 хвилин</option>
            <option value="30">За 30 хвилин</option>
            <option value="60">За годину</option>
          </select>
        </Field>
        <label className="plan-toggle">
          <input
            type="checkbox"
            checked={calendar}
            onChange={(e) => setCalendar(e.target.checked)}
          />
          Додати цей блок у Google Calendar після прийняття
        </label>
        {calendar && (
          <Field label="Кінець календарного блоку · Київ">
            <input
              type="datetime-local"
              required
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
          </Field>
        )}
        <Field label="Приблизно хвилин">
          <input
            type="number"
            min={0}
            max={1440}
            value={estimate}
            onChange={(e) => {
              setEstimate(Number(e.target.value));
              setXp(suggested({ estimateMinutes: Number(e.target.value) }).xp);
            }}
          />
        </Field>
        <Field label="Ціль тижня або місяця">
          <select value={goal} onChange={(e) => setGoal(e.target.value)}>
            <option value="">Без зв’язку</option>
            {data.goals.map((g) => (
              <option key={g.id} value={g.id}>
                {g.title}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Підкріплює винагороду">
          <select value={reward} onChange={(e) => setReward(e.target.value)}>
            <option value="">Загальний рух</option>
            {data.rewards
              .filter((r) => !r.archived)
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {r.title}
                </option>
              ))}
          </select>
        </Field>
      </details>
      {!initial?.fromTaskId && (
        <>
          <label className="plan-toggle">
            <input
              type="checkbox"
              checked={template}
              onChange={(e) => setTemplate(e.target.checked)}
            />
            Зберегти як шаблон
          </label>
          {template && (
            <>
              <RepeatDays days={templateDays} onChange={setTemplateDays} />
              <p className="plan-muted">
                Вибрані дні: автоматичні чернетки. Без вибраних днів — шаблон лише для ручного
                використання.
              </p>
            </>
          )}
        </>
      )}
      <button className="plan-primary" type="submit">
        Зберегти в чернетку
      </button>
      {initial && (
        <button
          type="button"
          className="plan-danger"
          onClick={() => void save('task-delete', {}, initial.id)}
        >
          Прибрати чернетку
        </button>
      )}
    </form>
  );
}

function Settings({ data, save }: { data: PlanWorkspace; save: Run }) {
  const [penalty, setPenalty] = useState(data.settings.penaltyPercent),
    [boundary, setBoundary] = useState(data.settings.dayBoundary),
    [grace, setGrace] = useState(data.settings.reportGraceHours),
    [evening, setEvening] = useState(data.settings.eveningAt),
    [enabled, setEnabled] = useState(data.settings.enabled);
  return (
    <form
      className="plan-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save('settings', {
          enabled,
          penaltyPercent: penalty,
          dayBoundary: boundary,
          reportGraceHours: grace,
          eveningAt: evening,
        });
      }}
    >
      <FormTitle sub="Початкові значення можна змінити. Уже прийняті обіцянки зберігають свої умови.">
        Зрозумілі правила
      </FormTitle>
      <ol className="plan-rules">
        <li>До прийняття — чернетка. Після — усі задачі мають наслідок.</li>
        <li>За результат — XP один раз. Частковий прогрес не є провалом.</li>
        <li>Пізніше доробив — отримав решту XP. Порушений строк лишається в історії.</li>
        <li>Вчасно зробив, пізно записав — уточни справжній час. Списання виправиться.</li>
        <li>XP відкривають можливості. Великі покупки мають реальний бюджет.</li>
      </ol>
      <Field
        label="Штраф за невиконаний обсяг, %"
        hint="Для 35 XP та 30% максимальна втрата — 11 XP. Денна сума не обрізається; боргу нижче нуля немає."
      >
        <input
          type="number"
          min={1}
          max={100}
          required
          value={penalty}
          onChange={(e) => setPenalty(Number(e.target.value))}
        />
      </Field>
      <Field label="Межа звичайного дня · Київ">
        <input
          required
          type="time"
          value={boundary}
          onChange={(e) => setBoundary(e.target.value)}
        />
      </Field>
      <Field
        label="Годин на внесення факту після строку"
        hint="Це час для звіту, а не подовження виконання."
      >
        <input
          type="number"
          min={0}
          max={48}
          required
          value={grace}
          onChange={(e) => setGrace(Number(e.target.value))}
        />
      </Field>
      <Field label="Вечірнє запрошення спланувати завтра">
        <input required type="time" value={evening} onChange={(e) => setEvening(e.target.value)} />
      </Field>
      <label className="plan-toggle">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Увімкнути ручний план і його нагадування
      </label>
      <p className="plan-muted">
        Тихі години спільні з асистентом. Вимкнення нагадувань не скасовує вже прийнятих обіцянок.
      </p>
      <button className="plan-primary" type="submit">
        Зберегти правила
      </button>
    </form>
  );
}

function Report({
  task,
  save,
  onError,
}: {
  task: PlanTask;
  save: Run;
  onError: (s: string) => void;
}) {
  const [units, setUnits] = useState(task.facts.units),
    [earlier, setEarlier] = useState(false),
    [actual, setActual] = useState(localValue(new Date().toISOString()));
  return (
    <form
      className="plan-form"
      onSubmit={(e) => {
        e.preventDefault();
        try {
          void save(
            'report',
            { units, ...(earlier ? { actualAt: localIso(actual) } : {}) },
            task.id,
          );
        } catch (error) {
          onError((error as Error).message);
        }
      }}
    >
      <FormTitle sub={task.criterion}>{task.title}</FormTitle>
      <Field
        label={`Фактично зроблено загалом із ${task.target} (${task.unit})`}
        hint="Внеси загальний результат, а не приріст. Повторний запис не подвоює XP."
      >
        <input
          type="number"
          min={0}
          max={task.target}
          step={1}
          required
          value={units}
          onChange={(e) => setUnits(Number(e.target.value))}
        />
      </Field>
      <label className="plan-toggle">
        <input type="checkbox" checked={earlier} onChange={(e) => setEarlier(e.target.checked)} />
        Цей результат був раніше, записую зараз
      </label>
      {earlier && (
        <Field label="Справжній час виконання · Київ">
          <input
            type="datetime-local"
            required
            value={actual}
            onChange={(e) => setActual(e.target.value)}
          />
        </Field>
      )}
      <p className="plan-muted">
        Строк: {when(task.dueAt)}. За зроблену частину отримаєш XP. Незаповнений залишок до строку
        не штрафується. {task.timeSensitive ? 'У цій задачі своєчасність є умовою результату.' : ''}
      </p>
      <button className="plan-primary" type="submit">
        Зберегти факт
      </button>
    </form>
  );
}

function TaskDetail({
  task,
  data,
  run,
  save,
  open,
  onError,
}: {
  task: PlanTask;
  data: PlanWorkspace;
  run: Run;
  save: Run;
  open: (p: Panel) => void;
  onError: (s: string) => void;
}) {
  const [reason, setReason] = useState(''),
    [moving, setMoving] = useState('');
  return (
    <div className="plan-form">
      <FormTitle sub={task.criterion}>{task.title}</FormTitle>
      <TaskStatus task={task} now={data.now} />
      <dl className="plan-facts">
        <dt>Крайній строк</dt>
        <dd>{when(task.dueAt)}</dd>
        <dt>Результат</dt>
        <dd>
          {task.facts.units} / {task.target} {task.unit}
        </dd>
        <dt>Вчасно</dt>
        <dd>
          {task.facts.onTimeUnits} / {task.target}
        </dd>
        <dt>Зараховано за результат</dt>
        <dd>{task.facts.credited} XP</dd>
        <dt>{task.settledAt ? 'Списано за цю обіцянку' : 'Поточний ризик'}</dt>
        <dd>{task.settledAt ? (task.penaltyApplied ?? 0) : task.facts.risk} XP</dd>
      </dl>
      {task.calendar && (
        <p className="plan-muted">
          Google Calendar:{' '}
          {
            {
              none: 'без блоку',
              pending: 'очікує запису',
              synced: 'блок записано',
              error: 'не вдалося записати; повторю у фоні',
              conflict: 'подія змінена зовні; умови задачі збережені',
            }[task.calendarState]
          }
          .
        </p>
      )}
      {task.exceptionReason && <p>Виняток: {task.exceptionReason}</p>}
      {task.status === 'draft' ? (
        <button className="plan-primary" onClick={() => open({ type: 'task', task })}>
          Редагувати чернетку
        </button>
      ) : (
        task.acceptedAt &&
        (task.status === 'accepted' || task.status === 'excepted') && (
          <>
            {task.source ? (
              <div className="plan-source-info">
                <strong>↔ Результат із фінансів таксі</strong>
                <p>
                  Уточнюй суму в записі зміни. Враховуються записи після прийняття, у проміжку цього
                  планового дня.
                </p>
                {task.source.warning && <p className="plan-error">{task.source.warning}</p>}
                {task.source.checkedAt && <small>Перевірено: {when(task.source.checkedAt)}</small>}
                <a className="plan-secondary" href="#/finance?action=taxi">
                  Відкрити таксі ↗
                </a>
              </div>
            ) : (
              <button className="plan-primary" onClick={() => open({ type: 'report', task })}>
                {task.facts.done ? 'Уточнити факт' : 'Внести результат'}
              </button>
            )}
            {!task.facts.done && !task.forfeitedAt && task.status === 'accepted' && (
              <>
                <button onClick={() => void run('start', {}, task.id)}>Почав виконання</button>
                <button onClick={() => void run('focus-start', {}, task.id)}>
                  Почну з п’яти хвилин
                </button>
                <button onClick={() => void run('snooze', { minutes: 15 }, task.id)}>
                  Відкласти лише сигнал на 15 хв
                </button>
              </>
            )}
            {!task.source &&
              task.lastReport &&
              Date.parse(data.now) - Date.parse(task.lastReport.recordedAt) < 600000 && (
                <button
                  onClick={() =>
                    void run('undo-report', { reportId: task.lastReport!.id }, task.id)
                  }
                >
                  Скасувати останню позначку
                </button>
              )}
            {!task.calendar && !task.facts.done && task.status === 'accepted' && (
              <details>
                <summary>Змінити початок</summary>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    try {
                      void save('move-start', { startAt: localIso(moving) }, task.id);
                    } catch (error) {
                      onError((error as Error).message);
                    }
                  }}
                >
                  <Field label="Новий початок · строк незмінний">
                    <input
                      required
                      type="datetime-local"
                      value={moving}
                      onChange={(e) => setMoving(e.target.value)}
                    />
                  </Field>
                  <button type="submit">Зберегти початок</button>
                </form>
              </details>
            )}
            {task.settledAt && !task.facts.done && !task.timeSensitive && (
              <button
                onClick={() => void save('recommit', { date: dayPlus(data.today, 1) }, task.id)}
              >
                Підготувати залишок на завтра
              </button>
            )}
            {!task.facts.done && !task.forfeitedAt && task.status === 'accepted' && (
              <details>
                <summary>Не виконав або зовнішня перешкода</summary>
                <p className="plan-muted">
                  «Сьогодні не зроблю» фіксує погоджений наслідок зараз. Зовнішній виняток потребує
                  чесної причини; він зберігається в історії.
                </p>
                <button className="plan-danger" onClick={() => void save('forfeit', {}, task.id)}>
                  Сьогодні не зроблю · врахувати −{task.facts.risk} XP
                </button>
                <Field label="Причина зовнішнього винятку">
                  <textarea
                    value={reason}
                    maxLength={500}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </Field>
                <button
                  disabled={!reason.trim()}
                  onClick={() => void save('exception', { reason }, task.id)}
                >
                  Зберегти виняток без нового XP і штрафу
                </button>
              </details>
            )}
          </>
        )
      )}
      {data.events
        .filter((e) => e.taskId === task.id)
        .slice(0, 12)
        .map((e) => (
          <div className="plan-history-row" key={e.id}>
            <div>
              <strong>{eventLabel(e.kind)}</strong>
              <small>{when(e.at)}</small>
            </div>
            <span>
              {e.delta > 0 ? '+' : ''}
              {e.delta} XP
            </span>
          </div>
        ))}
    </div>
  );
}

function RewardEditor({
  initial,
  suggestion,
  primary,
  save,
}: {
  initial?: PlanReward;
  suggestion?: { title: string; price: number; scale: string };
  primary: boolean;
  save: Run;
}) {
  const [title, setTitle] = useState(initial?.title ?? suggestion?.title ?? ''),
    [price, setPrice] = useState(initial?.price ?? suggestion?.price ?? 100),
    [scale, setScale] = useState(initial?.scale ?? suggestion?.scale ?? 'near'),
    [why, setWhy] = useState(initial?.why ?? ''),
    [repeat, setRepeat] = useState(initial?.repeatable ?? suggestion?.scale !== 'large'),
    [main, setMain] = useState(primary),
    [gate, setGate] = useState(Boolean(initial?.gate)),
    [gateNote, setGateNote] = useState(initial?.gate?.note ?? ''),
    [confirmed, setConfirmed] = useState(initial?.gate?.confirmed ?? false);
  const [mode, setMode] = useState(initial?.mode ?? 'spend'),
    [moneyGate, setMoneyGate] = useState(Boolean(initial?.purchase)),
    [moneyAmount, setMoneyAmount] = useState(String((initial?.purchase?.amountMinor ?? 0) / 100)),
    [moneyBuffer, setMoneyBuffer] = useState(String((initial?.purchase?.bufferMinor ?? 0) / 100)),
    [moneyDays, setMoneyDays] = useState(initial?.purchase?.horizonDays ?? 30),
    [moneyError, setMoneyError] = useState('');
  return (
    <form
      className="plan-form"
      onSubmit={(e) => {
        e.preventDefault();
        let purchase = null;
        try {
          if (moneyGate)
            purchase = {
              amountMinor: parseMoney(moneyAmount),
              bufferMinor: parseMoney(moneyBuffer),
              horizonDays: moneyDays,
            };
        } catch (cause) {
          setMoneyError((cause as Error).message);
          return;
        }
        void save(
          'reward-save',
          {
            title,
            price,
            scale,
            why,
            repeatable: repeat,
            mode,
            purchase,
            primary: main,
            gate:
              gate || scale === 'large'
                ? { kind: scale === 'large' ? 'purchase' : 'milestone', note: gateNote, confirmed }
                : null,
          },
          initial?.id,
        );
      }}
    >
      <FormTitle sub="Твоє бажання й твоя ціна в XP. Звичайний відпочинок та базові потреби не потрібно заробляти.">
        {initial ? 'Умови винагороди' : 'Нова можливість'}
      </FormTitle>
      <Field label="Як відкривається можливість">
        <select
          value={mode}
          onChange={(e) => {
            setMode(e.target.value as typeof mode);
            if (e.target.value === 'unlock') setRepeat(false);
          }}
        >
          <option value="spend">Один дозвіл за доступний баланс XP</option>
          <option value="unlock">Постійний етап за накопиченим досвідом</option>
        </select>
      </Field>
      <p className="plan-muted">
        {mode === 'unlock'
          ? 'Досвід відкриває цей етап один раз, без списання балансу. Подальші витрати XP його не закривають.'
          : 'Баланс витрачається на один дозвіл; накопичений досвід зберігається.'}
      </p>
      <Field label="Що хочу собі дозволити">
        <input required maxLength={180} value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <div className="plan-form-row">
        <Field label="Ціна, XP">
          <input
            type="number"
            required
            min={1}
            max={1000000}
            value={price}
            onChange={(e) => setPrice(Number(e.target.value))}
          />
        </Field>
        <Field label="Масштаб">
          <select
            value={scale}
            onChange={(e) => {
              setScale(e.target.value);
              setConfirmed(false);
            }}
          >
            <option value="near">Близька</option>
            <option value="middle">Середня</option>
            <option value="large">Велика</option>
          </select>
        </Field>
      </div>
      <Field label="Яку зміну це для мене підкріплює">
        <textarea maxLength={500} value={why} onChange={(e) => setWhy(e.target.value)} />
      </Field>
      <label className="plan-toggle">
        <input
          type="checkbox"
          checked={repeat}
          disabled={mode === 'unlock'}
          onChange={(e) => setRepeat(e.target.checked)}
        />
        Можна отримувати повторно
      </label>
      <label className="plan-toggle">
        <input
          type="checkbox"
          checked={moneyGate}
          onChange={(e) => setMoneyGate(e.target.checked)}
        />
        Перевіряти реальні кошти й майбутні витрати
      </label>
      {moneyGate && (
        <div className="plan-score">
          <Field label="Потрібно мати для цього дозволу, грн">
            <input
              type="text"
              inputMode="decimal"
              required
              value={moneyAmount}
              onChange={(e) => setMoneyAmount(e.target.value)}
            />
          </Field>
          <Field label="Залишити резерв понад цю суму, грн">
            <input
              type="text"
              inputMode="decimal"
              required
              value={moneyBuffer}
              onChange={(e) => setMoneyBuffer(e.target.value)}
            />
          </Field>
          <Field label="Перевіряти майбутні витрати за">
            <select value={moneyDays} onChange={(e) => setMoneyDays(Number(e.target.value))}>
              <option value={7}>7 днів</option>
              <option value={30}>30 днів</option>
              <option value={90}>90 днів</option>
            </select>
          </Field>
          <p className="plan-muted">
            Потрібні фактичні власні кошти після планів і резервів. Прогноз доходу показує сценарій
            і не стає грошима зараз. Для розстрочки ця сума може бути платежем; перевірка одного
            платежу не підтверджує доступність усієї розстрочки.
          </p>
          {moneyError && <p role="alert">{moneyError}</p>}
        </div>
      )}
      <label className="plan-toggle">
        <input type="checkbox" checked={main} onChange={(e) => setMain(e.target.checked)} />
        Показувати як обрану ціль у «Дні»
      </label>
      {scale !== 'large' && (
        <label className="plan-toggle">
          <input type="checkbox" checked={gate} onChange={(e) => setGate(e.target.checked)} />
          Крім XP, є реальний етап готовності
        </label>
      )}
      {(gate || scale === 'large') && (
        <div className="plan-score">
          <Field
            label={
              scale === 'large'
                ? 'Реальний бюджет і умови покупки'
                : 'Конкретний етап та його підтвердження'
            }
            hint={
              scale === 'large'
                ? 'Повна ціна, виплати й комісії, обов’язкові витрати, резерв та джерело/дата перевірки. XP не є грошима.'
                : undefined
            }
          >
            <textarea
              required={confirmed}
              maxLength={1200}
              value={gateNote}
              onChange={(e) => {
                setGateNote(e.target.value);
                setConfirmed(false);
              }}
              placeholder="Спочатку визнач умови. Підтверди тільки після фактичної перевірки."
            />
          </Field>
          <label className="plan-toggle">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            Я особисто перевірив і підтверджую ці умови
          </label>
        </div>
      )}
      <button className="plan-primary" type="submit">
        Зберегти винагороду
      </button>
    </form>
  );
}
function RewardPath({
  reward,
  data,
  open,
  run,
}: {
  reward: PlanReward;
  data: PlanWorkspace;
  open: (p: Panel) => void;
  run: Run;
}) {
  const linked = data.tasks.filter((t) => t.rewardId === reward.id),
    amount = reward.mode === 'unlock' ? data.wallet.experience : data.wallet.available,
    received = data.coupons.some((c) => c.rewardId === reward.id && c.status !== 'refunded'),
    ready =
      amount >= reward.price &&
      (!reward.purchase || reward.affordability?.ready === true) &&
      (!reward.gate || reward.gate.confirmed) &&
      (!received || reward.repeatable);
  return (
    <div className="plan-form">
      <FormTitle sub={reward.why || 'Обрана можливість, до якої рухаєшся власними кроками.'}>
        {reward.title}
      </FormTitle>
      <div className="plan-path-number">
        {amount}
        <span> / {reward.price} XP</span>
      </div>
      <Meter value={amount} max={reward.price} label={reward.title} />
      <p className="plan-muted">
        {Math.max(0, reward.price - amount)} XP до доступності · {data.wallet.reserved} XP
        покривають відкриті обіцянки.
      </p>
      {reward.mode === 'unlock' && (
        <p className="plan-muted">
          Це постійний етап за досвідом: його відкриття не витрачає баланс.
        </p>
      )}
      {reward.purchase && (
        <div className="plan-agreement">
          <strong>
            {reward.affordability?.ready
              ? '✓ Фінансовий запас підтверджено'
              : '◇ Потрібен фінансовий запас'}
          </strong>
          <p>{reward.affordability?.reason ?? 'Фінансові дані ще не перевірено.'}</p>
          <p>
            Потрібно: {(reward.purchase.amountMinor / 100).toLocaleString('uk-UA')} грн + резерв{' '}
            {(reward.purchase.bufferMinor / 100).toLocaleString('uk-UA')} грн.
          </p>
          {reward.affordability?.currentSafeMinor != null && (
            <p>
              Зараз після планів:{' '}
              {(reward.affordability.currentSafeMinor / 100).toLocaleString('uk-UA')} грн.
            </p>
          )}
        </div>
      )}
      {reward.gate && (
        <div className="plan-agreement">
          <strong>
            {reward.gate.confirmed
              ? '✓ Реальну умову підтверджено'
              : '◇ Потрібен реальний етап готовності'}
          </strong>
          <p>{reward.gate.note}</p>
          {reward.gate.checkedAt && (
            <small>
              {reward.gate.confirmed ? 'Перевірку підтверджено' : 'Умови збережено'}:{' '}
              {when(reward.gate.checkedAt)}
            </small>
          )}
        </div>
      )}
      <button
        className="plan-primary"
        disabled={!ready}
        onClick={() => open({ type: 'redeem', reward })}
      >
        {received && !reward.repeatable
          ? 'Винагороду вже отримано'
          : ready
            ? 'Отримати можливість'
            : 'Ще рухаюся до відкриття'}
      </button>
      <button onClick={() => void run('settings', { primaryRewardId: reward.id })}>
        Обрати основною ціллю
      </button>
      {!received && (
        <button onClick={() => open({ type: 'reward', reward })}>Уточнити умови й бюджет</button>
      )}
      <button className="plan-danger" onClick={() => void run('reward-archive', {}, reward.id)}>
        Прибрати з активних винагород
      </button>
      <h3>Кроки, які це підкріплюють</h3>
      {linked.length ? (
        linked.map((t) => (
          <button
            className="plan-agreement"
            key={t.id}
            onClick={() => open({ type: 'detail', task: t })}
          >
            <strong>{t.title}</strong>
            <p>
              {dateText(t.date)} ·{' '}
              {t.facts.done ? 'результат є' : t.status === 'draft' ? 'чернетка' : 'у плані'}
            </p>
          </button>
        ))
      ) : (
        <p className="plan-muted">
          Можеш пов’язати важливі дії з цією ціллю. Усі інші сфери також приносять спільні XP.
        </p>
      )}
      <button onClick={() => open({ type: 'task', rewardId: reward.id })}>
        ＋ Підготувати наступний крок
      </button>
      <p className="plan-footnote">
        Бали відкривають твій дозвіл. Світанок не оформлює розстрочку й не виконує покупку.
      </p>
    </div>
  );
}
function GoalEditor({ date, save }: { date: string; save: Run }) {
  const [title, setTitle] = useState(''),
    [why, setWhy] = useState(''),
    [horizon, setHorizon] = useState('week'),
    [due, setDue] = useState(dayPlus(date, 7));
  return (
    <form
      className="plan-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save('goal-save', { title, why, horizon, dueDate: due });
      }}
    >
      <FormTitle sub="Ціль об’єднує щоденні кроки; окремі XP за ту саму роботу не додаються.">
        Напрям на тиждень чи місяць
      </FormTitle>
      <Field label="Бажаний результат">
        <input required maxLength={180} value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label="Чому це для мене важливо">
        <textarea value={why} maxLength={500} onChange={(e) => setWhy(e.target.value)} />
      </Field>
      <Field label="Горизонт">
        <select
          value={horizon}
          onChange={(e) => {
            setHorizon(e.target.value);
            setDue(dayPlus(date, e.target.value === 'month' ? 30 : 7));
          }}
        >
          <option value="week">Тиждень</option>
          <option value="month">Місяць</option>
        </select>
      </Field>
      <Field label="Орієнтир дати">
        <input required type="date" value={due} onChange={(e) => setDue(e.target.value)} />
      </Field>
      <button className="plan-primary">Зберегти напрям</button>
    </form>
  );
}
function ShiftEditor({
  date,
  save,
  onError,
}: {
  date: string;
  save: Run;
  onError: (s: string) => void;
}) {
  const [review, setReview] = useState(`${dayPlus(date, 1)}T12:00`);
  return (
    <form
      className="plan-form"
      onSubmit={(e) => {
        e.preventDefault();
        try {
          void save('shift-open', { reviewAt: localIso(review) });
        } catch (error) {
          onError((error as Error).message);
        }
      }}
    >
      <FormTitle sub="Початок не дає XP. Зміна зберігається однією сесією й після опівночі.">
        Починаю робочу зміну
      </FormTitle>
      <Field label="Гранична перевірка стану · Київ">
        <input
          required
          type="datetime-local"
          value={review}
          onChange={(e) => setReview(e.target.value)}
        />
      </Field>
      <p className="plan-muted">
        Завершиш роботу — натисни «Завершити зміну» й внеси реальний результат. Невідомий дохід не
        записується як нуль.
      </p>
      <button className="plan-primary">Зміна почалась зараз</button>
    </form>
  );
}
const eventNames: Record<string, string> = {
  earned: 'Результат записано',
  deadline: 'Підсумок строку',
  accepted: 'Обіцянку прийнято',
  'penalty-correction': 'Штраф уточнено',
  'report-reversed': 'Позначку скасовано',
  exception: 'Зовнішній виняток',
  'exception-refund': 'Списання повернено',
  redeemed: 'Винагороду відкрито',
  'coupon-used': 'Дозвіл використано',
  'coupon-refunded': 'Дозвіл повернено',
  draft: 'Чернетку збережено',
  started: 'Виконання почато',
  forfeited: 'Відмову від виконання зафіксовано',
  'recommit-draft': 'Залишок у новій чернетці',
  'template-saved': 'Шаблон збережено',
  'template-archived': 'Шаблон прибрано',
  'template-error': 'Шаблон потребує уточнення',
  'day-extended': 'День подовжено',
  'source-synced': 'Результат оновлено з фінансів',
  'source-needs-review': 'Уточни фінансовий запис',
  'focus-started': 'Перші п’ять хвилин',
  unlocked: 'Постійний доступ відкрито',
};
function eventLabel(kind: string) {
  return (
    eventNames[kind] ??
    {
      settings: 'Правила оновлено',
      goal: 'Ціль збережено',
      'reward-saved': 'Винагороду збережено',
      'shift-opened': 'Зміну розпочато',
      'shift-closed': 'Зміну завершено',
      'signal-snoozed': 'Сигнал відкладено',
      'start-moved': 'Початок переміщено',
      'draft-deleted': 'Чернетку прибрано',
      'reward-archived': 'Винагороду архівовано',
    }[kind] ??
    'Зміну збережено'
  );
}
function uniqueResults(tasks: PlanTask[]) {
  return [...new Map(tasks.map((t) => [t.resultId, t])).values()];
}
function Progress({
  data,
  onDate,
  onGoal,
  onTask,
}: {
  data: PlanWorkspace;
  onDate: (s: string) => void;
  onGoal: () => void;
  onTask: (goalId: string) => void;
}) {
  const [period, setPeriod] = useState<7 | 30>(7);
  const from = dayPlus(data.today, -period + 1),
    tasks = data.tasks.filter((t) => t.acceptedAt && t.date >= from && t.date <= data.today),
    results = uniqueResults(tasks),
    completed = results.filter((t) => t.facts.done),
    onTime = tasks.filter((t) => t.facts.onTimeUnits >= t.target),
    minutes = tasks.reduce((n, t) => n + t.estimateMinutes, 0),
    dates = Array.from({ length: period }, (_, i) => dayPlus(from, i));
  return (
    <div className="plan-progress">
      <div className="plan-list-heading">
        <div>
          <h2>Видно зроблене. Зрозуміло наступне.</h2>
          <p>Факти й обіцянки, до яких можна повернутися.</p>
        </div>
      </div>
      <div className="plan-period">
        {([7, 30] as const).map((n) => (
          <button key={n} aria-pressed={period === n} onClick={() => setPeriod(n)}>
            {n === 7 ? '7 днів' : '30 днів'}
          </button>
        ))}
      </div>
      <div className="plan-progress-grid">
        <div>
          <strong>
            {completed.length}
            <span> / {results.length}</span>
          </strong>
          <small>результатів у плані</small>
        </div>
        <div>
          <strong>{onTime.length}</strong>
          <small>обіцянок виконано вчасно</small>
        </div>
      </div>
      <p className="plan-muted">
        {tasks.length
          ? `Оцінений обсяг прийнятого плану — ${Math.round((minutes / 60) * 10) / 10} год за період. Це оцінка, не фактично відпрацьований час.`
          : 'Прогрес почнеться з першого прийнятого плану. Дні без плану не вважаються провалом.'}
      </p>
      <AreaInsights data={data} from={from} />
      <div className="plan-days" aria-label="Історія днів">
        {dates.map((date) => {
          const day = data.tasks.filter((t) => t.date === date && t.acceptedAt),
            done = day.filter((t) => t.facts.done).length;
          return (
            <button
              key={date}
              className={day.length ? 'has-plan' : ''}
              onClick={() => onDate(date)}
              aria-label={`${dateText(date)}: ${done} із ${day.length}`}
            >
              <small>{date.slice(8)}</small>
              <span style={{ opacity: day.length ? 0.35 + (0.65 * done) / day.length : 0.12 }}>
                ◒
              </span>
            </button>
          );
        })}
      </div>
      <div className="plan-list-heading">
        <h2>Тиждень і місяць</h2>
        <button className="plan-add" aria-label="Додати ціль" onClick={onGoal}>
          ＋
        </button>
      </div>
      {data.goals.length ? (
        data.goals.map((g) => {
          const linked = uniqueResults(data.tasks.filter((t) => t.goalId === g.id && t.acceptedAt)),
            done = linked.filter((t) => t.facts.done).length;
          return (
            <div className="plan-goal" key={g.id}>
              <span className="plan-eyebrow">
                {g.horizon === 'month' ? 'МІСЯЦЬ' : 'ТИЖДЕНЬ'} · ДО {dateText(g.dueDate)}
              </span>
              <h3>{g.title}</h3>
              <p>{g.why}</p>
              <Meter value={done} max={Math.max(1, linked.length)} label={g.title} />
              <small>
                {done} із {linked.length} пов’язаних кроків · це не відсоток всієї цілі
              </small>
              <button onClick={() => onTask(g.id)}>Додати щоденний крок ↗</button>
            </div>
          );
        })
      ) : (
        <p className="plan-muted">
          Напрям на тиждень допоможе пов’язати щоденні справи з бажаною зміною.
        </p>
      )}
      <h2 className="plan-section-title">Історія змін</h2>
      <p className="plan-muted">
        Останні {data.events.length} записів. Давніші події можна завантажити нижче.
      </p>
      {data.events.map((e) => (
        <div className="plan-history-row" key={e.id}>
          <div>
            <strong>{e.title}</strong>
            <p>{eventLabel(e.kind)}</p>
            <small>{when(e.at)}</small>
          </div>
          <span className={e.delta > 0 ? 'plan-positive' : e.delta < 0 ? 'plan-negative' : ''}>
            {e.delta > 0 ? '+' : ''}
            {e.delta} XP
          </span>
        </div>
      ))}
      <EarlierHistory key={data.historyCursor} data={data} />
    </div>
  );
}
