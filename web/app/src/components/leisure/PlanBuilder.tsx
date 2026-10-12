import { PlaceInfo } from './PlaceInfo.tsx';
import { useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { GlassCard } from '../ui/primitives.tsx';
import { openLink } from '../../telegram.ts';
import {
  money,
  pairPrice,
  leisureDate,
  leisureTime,
  toKyivInput,
  fromKyivInput,
  type LeisureWorkspace,
  type LeisureItem,
  type LeisurePlan,
  type LeisureReceipt,
} from '../../api/leisure.ts';
type Send = (op: string, payload: Record<string, unknown>, id?: string) => Promise<LeisureReceipt>;
function Button({
  primary = false,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean; children: ReactNode }) {
  return (
    <button type="button" className={`leisure-button${primary ? ' is-primary' : ''}`} {...props}>
      {children}
    </button>
  );
}
function budgetValue(value: string) {
  if (!value.trim()) return null;
  const clean = value.replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(?:\.\d{1,2})?$/.test(clean))
    throw new Error('Укажи суму з максимум двома знаками після коми.');
  const minor = Math.round(Number(clean) * 100);
  if (!Number.isSafeInteger(minor) || minor > 10000000000) throw new Error('Перевір суму бюджету.');
  return minor;
}
type FormStop = {
  itemId: string;
  sessionId?: string | null;
  start: string;
  end: string;
  tickets: boolean;
  reservation: boolean;
};
function initialStop(item: LeisureItem, sessionId?: string): FormStop {
  const session = item.sessions.find((s) => s.id === sessionId);
  const today = toKyivInput(new Date().toISOString()).slice(0, 10),
    date = item.startDate && item.startDate > today ? item.startDate : today;
  const eventStart = item.startAt && Date.parse(item.startAt) > Date.now() ? item.startAt : null;
  const preferred = fromKyivInput(`${date}T18:00`);
  const defaultStart =
    Date.parse(preferred) > Date.now() ? preferred : new Date(Date.now() + 3600000).toISOString();
  const start = session?.startAt ?? eventStart ?? defaultStart,
    end =
      session?.endAt ??
      (eventStart && item.endAt && item.endDate === item.startDate ? item.endAt : null) ??
      new Date(Date.parse(start) + 3600000).toISOString();
  return {
    itemId: item.id,
    sessionId: session?.id,
    start: toKyivInput(start),
    end: toKyivInput(end),
    tickets: false,
    reservation: false,
  };
}
export function PlanBuilder({
  data,
  initialItem,
  initialSessionId,
  existing,
  busy,
  send,
  done,
}: {
  data: LeisureWorkspace;
  initialItem?: LeisureItem;
  initialSessionId?: string;
  existing?: LeisurePlan;
  busy: boolean;
  send: Send;
  done: () => void;
}) {
  const [stage, setStage] = useState(0),
    [checking, setChecking] = useState(false),
    [budget, setBudget] = useState(
      existing?.estimatedBudgetMinor != null ? String(existing.estimatedBudgetMinor / 100) : '',
    ),
    [journey, setJourney] = useState<LeisureReceipt['legs']>(),
    [allowJourney, setAllowJourney] = useState(false),
    [additionSession, setAdditionSession] = useState('');
  const goStage = (next: number) => {
    setStage(next);
    requestAnimationFrame(() => {
      const panel = document.querySelector('[role=dialog]');
      if (panel instanceof HTMLElement) panel.scrollTop = 0;
    });
  };
  const baseRevision = useRef(existing?.revision ?? 0);
  const [title, setTitle] = useState(existing?.title ?? 'Наш вечір'),
    [stops, setStops] = useState<FormStop[]>(() =>
      existing
        ? existing.stops.map((s) => ({
            itemId: s.itemId,
            sessionId: s.sessionId,
            start: toKyivInput(s.startAt),
            end: toKyivInput(s.endAt),
            tickets: s.tickets,
            reservation: s.reservation,
          }))
        : initialItem
          ? [initialStop(initialItem, initialSessionId)]
          : [],
    ),
    [calendar, setCalendar] = useState(existing?.calendar ?? true),
    [check, setCheck] = useState<LeisureReceipt | null>(null),
    [allowConflict, setAllowConflict] = useState(false),
    [allowUnverified, setAllowUnverified] = useState(false),
    [error, setError] = useState(''),
    [addition, setAddition] = useState('');
  const lookup = new Map(data.items.map((i) => [i.id, i]));
  const checkVersion = useRef(0);
  const invalidateCheck = () => {
    checkVersion.current++;
    setCheck(null);
    setJourney(undefined);
    setAllowJourney(false);
    setAllowConflict(false);
    setAllowUnverified(false);
  };
  const edit = (index: number, patch: Partial<FormStop>) => {
    setStops((v) => v.map((s, i) => (i === index ? { ...s, ...patch } : s)));
    invalidateCheck();
  };
  const payload = () => ({
    title,
    estimatedBudgetMinor: budgetValue(budget),
    stops: stops.map((s) => ({
      ...s,
      startAt:
        lookup.get(s.itemId)?.sessions.find((session) => session.id === s.sessionId)?.startAt ??
        fromKyivInput(s.start),
      endAt: (() => {
        const session = lookup
          .get(s.itemId)
          ?.sessions.find((session) => session.id === s.sessionId);
        return session?.endAt && toKyivInput(session.endAt) === s.end
          ? session.endAt
          : fromKyivInput(s.end);
      })(),
    })),
    calendar,
    revision: baseRevision.current,
    conflictConfirmed: allowConflict,
    calendarUnavailableConfirmed: allowUnverified,
  });
  const known = stops.reduce(
      (sum, s) => sum + (lookup.get(s.itemId) ? (pairPrice(lookup.get(s.itemId)!) ?? 0) : 0),
      0,
    ),
    unknown = stops.filter(
      (s) => !lookup.get(s.itemId) || pairPrice(lookup.get(s.itemId)!) == null,
    ).length;
  const submit = async () => {
    setError('');
    try {
      const result = await send('plan', payload(), existing?.id);
      if (result.id) done();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не вдалося зберегти план.');
    }
  };
  return (
    <>
      <h2>План дозвілля</h2>
      <div className="leisure-plan-steps" aria-label="Етапи планування">
        {['Вибір', 'Час і бронювання', 'Перевірка'].map((label, index) => (
          <button
            type="button"
            key={label}
            aria-current={stage === index ? 'step' : undefined}
            disabled={busy || checking || (index > 0 && !stops.length)}
            onClick={() => goStage(index)}
          >
            {index + 1}. {label}
          </button>
        ))}
      </div>
      <p className="leisure-secondary">
        {stage === 0
          ? 'Обери один варіант або поєднай кілька місць.'
          : stage === 1
            ? 'Вкажи час, відкрий квитки чи бронювання й познач результат.'
            : 'Перевір дорогу, вартість та накладки перед остаточним погодженням.'}
      </p>
      <p className="leisure-secondary">Час за Києвом. Додай потрібні місця й перевір календар.</p>
      <div hidden={stage !== 0}>
        <label className="leisure-field">
          Назва
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={180} />
        </label>
        {stops.map((stop, index) => (
          <GlassCard key={`${stop.itemId}-${index}`} className="leisure-stop">
            <h3>
              {index + 1}. {lookup.get(stop.itemId)?.title ?? 'Варіант'}
            </h3>
            <p className="leisure-secondary">
              {stop.start.slice(0, 10) || 'Обери дату'} · {stop.start.slice(11)}–
              {stop.end.slice(11)}
            </p>
            <button
              type="button"
              className="leisure-text-button"
              onClick={() => {
                setStops((v) => v.filter((_, n) => n !== index));
                invalidateCheck();
              }}
            >
              Прибрати пункт
            </button>
          </GlassCard>
        ))}
      </div>
      <div hidden={stage !== 1}>
        {stops.map((s, index) => (
          <GlassCard key={`${s.itemId}-${index}`} className="leisure-stop">
            <h3>
              {index + 1}. {lookup.get(s.itemId)?.title ?? 'Варіант'}
            </h3>
            {lookup.get(s.itemId)?.bookingUrl && (
              <Button onClick={() => openLink(lookup.get(s.itemId)!.bookingUrl!)}>
                Забронювати
              </Button>
            )}
            {lookup.get(s.itemId)?.siteUrl && !lookup.get(s.itemId)?.bookingUrl && (
              <Button onClick={() => openLink(lookup.get(s.itemId)!.siteUrl!)}>Сайт закладу</Button>
            )}
            {lookup.get(s.itemId)?.sourceUrl && (
              <Button
                onClick={() =>
                  openLink(
                    lookup.get(s.itemId)?.sessions.find((session) => session.id === s.sessionId)
                      ?.url ?? lookup.get(s.itemId)!.sourceUrl,
                  )
                }
              >
                {s.sessionId
                  ? 'Купити квитки'
                  : lookup.get(s.itemId)?.source === 'Concert.ua'
                    ? 'Квитки / реєстрація'
                    : 'Переглянути джерело'}
              </Button>
            )}
            {lookup.get(s.itemId)?.placeId && (
              <Button
                disabled={busy || checking}
                onClick={() =>
                  void send('place-check', {}, s.itemId).catch((e) => setError(e.message))
                }
              >
                Перевірити графік і сайт
              </Button>
            )}
            {lookup.get(s.itemId)?.hours && (
              <p className="leisure-secondary">{lookup.get(s.itemId)?.hours}</p>
            )}
            {lookup.get(s.itemId) && (
              <PlaceInfo item={lookup.get(s.itemId)!} now={data.generatedAt} />
            )}
            <div className="leisure-fields leisure-plan-times">
              <label>
                Початок
                <input
                  type="datetime-local"
                  value={s.start}
                  onChange={(e) => edit(index, { start: e.target.value })}
                  disabled={!!s.sessionId}
                />
              </label>
              <label>
                Завершення
                <input
                  type="datetime-local"
                  value={s.end}
                  onChange={(e) => edit(index, { end: e.target.value })}
                />
              </label>
            </div>
            <p className="leisure-secondary">
              {s.sessionId
                ? 'Початок за розкладом. Завершення за тривалістю фільму, рекламу можна врахувати вручну.'
                : 'Можеш змінити дату й час. Графік закладу або події перевір у джерелі.'}
            </p>
            {(s.tickets ||
              !lookup.get(s.itemId) ||
              !['food', 'trip'].includes(lookup.get(s.itemId)!.category) ||
              lookup.get(s.itemId)?.registration) && (
              <label className="leisure-check">
                <input
                  type="checkbox"
                  checked={s.tickets}
                  onChange={(e) => edit(index, { tickets: e.target.checked })}
                />
                Квитки / реєстрацію підтверджено
              </label>
            )}
            {(s.reservation ||
              !lookup.get(s.itemId) ||
              lookup.get(s.itemId)?.category === 'food') && (
              <label className="leisure-check">
                <input
                  type="checkbox"
                  checked={s.reservation}
                  onChange={(e) => edit(index, { reservation: e.target.checked })}
                />
                Бронювання підтверджено
              </label>
            )}
            <button
              type="button"
              className="leisure-text-button"
              onClick={() => {
                setStops((v) => v.filter((_, i) => i !== index));
                invalidateCheck();
              }}
            >
              Прибрати пункт
            </button>
          </GlassCard>
        ))}
      </div>
      <div hidden={stage !== 0}>
        <label className="leisure-field">
          Додати місце або подію
          <select
            value={addition}
            onChange={(e) => {
              setAddition(e.target.value);
              setAdditionSession('');
            }}
          >
            <option value="">Обери варіант</option>
            {data.items
              .filter((i) => !stops.some((s) => s.itemId === i.id))
              .map((i) => (
                <option key={i.id} value={i.id}>
                  {i.title}
                </option>
              ))}
          </select>
        </label>
        {lookup.get(addition)?.source === 'Планета кіно' && (
          <label className="leisure-field">
            Сеанс для доданого фільму
            <select value={additionSession} onChange={(e) => setAdditionSession(e.target.value)}>
              <option value="">Обери підтверджений сеанс</option>
              {lookup
                .get(addition)!
                .sessions.filter((s) => Date.parse(s.startAt) > Date.parse(data.generatedAt))
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.cinema} · {leisureDate(s.startAt)} {leisureTime(s.startAt)}
                  </option>
                ))}
            </select>
          </label>
        )}
        <Button
          disabled={
            !addition || (lookup.get(addition)?.source === 'Планета кіно' && !additionSession)
          }
          onClick={() => {
            const item = lookup.get(addition);
            if (item) {
              setStops((v) => [...v, initialStop(item, additionSession || undefined)]);
              setAddition('');
              invalidateCheck();
            }
          }}
        >
          Додати пункт
        </Button>
      </div>
      {stage < 2 && (
        <Button
          primary
          disabled={busy || checking || !stops.length || !title.trim()}
          onClick={() => {
            setError('');
            try {
              payload();
              goStage(stage + 1);
            } catch (e) {
              setError(e instanceof Error ? e.message : 'Перевір час.');
            }
          }}
        >
          Далі: {stage === 0 ? 'час і бронювання' : 'перевірка'}
        </Button>
      )}
      <div hidden={stage !== 2}>
        <GlassCard className="leisure-budget">
          <h3>Вартість для двох</h3>
          <p>
            {unknown > 0 && known === 0 ? (
              'Суму ще не визначено'
            ) : (
              <>
                Підтверджений мінімум: <strong>{money(known)}</strong>
              </>
            )}
          </p>
          {unknown > 0 && (
            <p className="leisure-secondary">
              Ще {unknown} пунктів без підтвердженої ціни. Повної суми поки немає.
            </p>
          )}
          <p className="leisure-secondary">
            Дорога, паркування та сервісні збори окремо. Це план, не запис витрати.
          </p>
        </GlassCard>
        <label className="leisure-field">
          Твоя оцінка загальної вартості, ₴ · необов’язково
          <input
            inputMode="decimal"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            placeholder="Наприклад, 1500"
          />
        </label>
        <p className="leisure-secondary">
          Можна врахувати їжу, квитки, дорогу й паркування. Ця сума не записується як витрата.
        </p>
        <Button
          disabled={busy || checking || !stops.length}
          onClick={() => {
            setError('');
            try {
              const version = checkVersion.current,
                prepared = payload();
              setChecking(true);
              void (async () => {
                for (const stop of stops)
                  if (lookup.get(stop.itemId)?.placeId) await send('place-check', {}, stop.itemId);
                  else if (
                    lookup.get(stop.itemId) &&
                    !['cinema', 'food'].includes(lookup.get(stop.itemId)!.category)
                  )
                    await send('source-check', {}, stop.itemId);
                const route = stops.length > 1 ? await send('journey-check', prepared) : null;
                const result = await send('calendar-check', prepared, existing?.id);
                if (version === checkVersion.current) {
                  setJourney(route?.legs);
                  setCheck(result);
                }
              })()
                .catch((e) => {
                  if (version === checkVersion.current) setError(e.message);
                })
                .finally(() => setChecking(false));
            } catch (e) {
              setError(e instanceof Error ? e.message : 'Перевір час.');
            }
          }}
        >
          {checking ? 'Перевіряю…' : 'Перевірити календар'}
        </Button>
        {journey?.map((leg, index) => (
          <p key={`${leg.from}-${leg.to}`} className="leisure-notice">
            Дорога {index + 1}:{' '}
            {leg.available
              ? `${leg.minutes} хв · ${Math.round((leg.distanceM ?? 0) / 100) / 10} км; між пунктами ${leg.gapMinutes} хв${leg.enoughTime ? '' : ' — часу недостатньо'}`
              : 'не вдалося підтвердити час дороги'}
          </p>
        ))}
        {journey?.some((leg) => leg.available && !leg.enoughTime) && (
          <label className="leisure-check">
            <input
              type="checkbox"
              checked={allowJourney}
              onChange={(e) => setAllowJourney(e.target.checked)}
            />
            Перевірив дорогу й погоджую цей проміжок часу
          </label>
        )}
        {check?.available && !check.conflicts?.length && (
          <p className="leisure-notice">Накладок із календарем не знайдено.</p>
        )}
        {!!check?.conflicts?.length && (
          <div className="leisure-notice">
            <strong>Є накладки</strong>
            {check.conflicts.map((c, i) => (
              <p key={c.id ?? i}>
                {c.title} · {leisureTime(c.startAt)}–{leisureTime(c.endAt)}
              </p>
            ))}
            <label className="leisure-check">
              <input
                type="checkbox"
                checked={allowConflict}
                onChange={(e) => setAllowConflict(e.target.checked)}
              />
              Погоджую цей час попри накладку
            </label>
          </div>
        )}
        {check?.available === false && (
          <label className="leisure-check">
            <input
              type="checkbox"
              checked={allowUnverified}
              onChange={(e) => setAllowUnverified(e.target.checked)}
            />
            Календар недоступний. Погоджую збереження без перевірки накладок.
          </label>
        )}
        <label className="leisure-check">
          <input
            type="checkbox"
            checked={calendar}
            onChange={(e) => setCalendar(e.target.checked)}
          />
          Додати / оновити Google Calendar після погодження
        </label>
        <Button
          primary
          disabled={
            busy ||
            checking ||
            (journey?.some((leg) => leg.available && !leg.enoughTime) && !allowJourney) ||
            !stops.length ||
            !check ||
            (!!check.conflicts?.length && !allowConflict) ||
            (check.available === false && !allowUnverified)
          }
          onClick={() => void submit()}
        >
          {busy ? 'Зберігаю…' : calendar ? 'Погодити й додати в календар' : 'Погодити план'}
        </Button>
      </div>
      {stage > 0 && (
        <Button disabled={busy || checking} onClick={() => goStage(stage - 1)}>
          ← Попередній етап
        </Button>
      )}
      {error && (
        <p role="alert" className="leisure-error">
          {error}
        </p>
      )}
    </>
  );
}
