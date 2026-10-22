import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  changeTrip,
  fetchTrips,
  downloadTrip,
  TravelChangeError,
  type TravelCommand,
  type TravelCurrent,
} from '../../api/trips.ts';
import { isSessionExpired } from '../../api/client.ts';
import { inTelegram } from '../../telegram.ts';
import { SessionExpired } from '../ui/SessionExpired.tsx';
import { DeleteTripButton } from './DeleteTripButton.tsx';
import './trips.css';
import './journey.css';

type Guide = NonNullable<TravelCurrent['planning']>;
type Question = Guide['fields'][number];
type SearchStage = Guide['stages'][number];
type Execute = (command: TravelCommand) => Promise<boolean>;
type Lifecycle = 'planning' | 'preparation' | 'outbound' | 'destination' | 'return' | 'after';
const LIFE: [Lifecycle, string, string][] = [
  ['planning', 'Планування', '01'],
  ['preparation', 'Підготовка', '02'],
  ['outbound', 'У дорогу', '03'],
  ['destination', 'На місці', '04'],
  ['return', 'Додому', '05'],
  ['after', 'Після подорожі', '06'],
];
const SEARCH: Record<string, { title: string; description: string; button: string }> = {
  transport: {
    title: 'Спершу — дорога',
    description: 'Порівняємо маршрут, час у дорозі, багаж і вартість для тих, хто їде разом.',
    button: 'Знайти транспорт',
  },
  stay: {
    title: 'Тепер — де зупинитися',
    description: 'Урахую склад групи для житла, дати заселення й обраний шлях до міста.',
    button: 'Знайти житло',
  },
  activity: {
    title: 'Чим наповнимо подорож',
    description: 'Підберу місця, заклади й заняття з урахуванням житла, інтересів і темпу.',
    button: 'Знайти місця й заклади',
  },
};
const MODES: Record<string, string> = {
  bus: 'Автобус',
  train: 'Потяг',
  car: 'Авто',
  plane: 'Літак',
  mixed: 'Кілька видів транспорту',
  compare: 'Порівнюємо транспорт',
  hike: 'Похід',
  walk: 'Пішки',
};
const GROUPS: Record<string, string> = {
  documents: 'Документи',
  bookings: 'Квитки й бронювання',
  packing: 'Речі',
  home: 'Дім',
  return: 'Повернення',
  other: 'Моє',
};
const UNITS: Record<string, string> = {
  person: 'за людину',
  group: 'за групу',
  room_night: 'за номер / ніч',
  stay: 'за проживання',
  ticket: 'за квиток',
  entry: 'за вхід',
};
const atext = (c: TravelCurrent, field: string) => String(c.answers[field] ?? '');
function actualStage(c: TravelCurrent): Lifecycle {
  return (
    (
      {
        departed: 'outbound',
        arrived: 'destination',
        returning: 'return',
        home: 'after',
      } as Record<string, Lifecycle>
    )[c.workspace?.progress.stage ?? ''] ?? (c.kind === 'draft' ? 'planning' : 'preparation')
  );
}

export function TripJourney() {
  const [params, setParams] = useSearchParams(),
    selected = params.get('id') ?? undefined;
  const fresh = params.get('new') === '1';
  const [notice, setNotice] = useState(''),
    [uncertain, setUncertain] = useState(false);
  const cache = useQueryClient();
  const query = useQuery({
    queryKey: ['trips', selected],
    queryFn: () => fetchTrips(selected),
    refetchInterval: (q) =>
      q.state.data?.current?.planning?.stages.some((stage) => stage.status === 'running')
        ? 5000
        : false,
  });
  const mutation = useMutation({ mutationFn: (command: TravelCommand) => changeTrip(command) });
  const execute: Execute = async (command) => {
    setNotice('');
    try {
      const snapshot = await mutation.mutateAsync(command);
      if (snapshot) {
        const id = snapshot.current?.id;
        cache.setQueryData(['trips', id], snapshot);
        if (id) setParams({ id }, { replace: true });
        setUncertain(false);
      } else {
        setUncertain(true);
        setNotice('Зміну прийнято. Онови дані, щоб перевірити результат.');
        void query.refetch();
      }
      return Boolean(snapshot);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Не вдалося зберегти зміну.');
      if (error instanceof TravelChangeError && error.uncertain) setUncertain(true);
      return false;
    }
  };
  const refresh = async () => {
    const result = await query.refetch();
    if (!result.error) {
      setUncertain(false);
      setNotice('Дані оновлено. Перевір збережений стан.');
    }
  };
  if (isSessionExpired(query.error) || isSessionExpired(mutation.error)) return <SessionExpired />;
  const current = fresh ? null : query.data?.current,
    disabled = mutation.isPending || uncertain;
  return (
    <section className="trips-screen journey-screen">
      <header className="trips-heading">
        <div>
          <p className="trips-eyebrow">СВІТАНОК · ПОДОРОЖІ</p>
          <h1>Від задуму до спогадів</h1>
        </div>
        {current && (
          <button
            disabled={disabled}
            onClick={() => {
              setParams({ new: '1' });
              setNotice('');
            }}
          >
            ＋ Нова
          </button>
        )}
      </header>
      {!inTelegram() && (
        <p className="trips-demo">
          Приклад подорожі. Свої дані можна зберігати в Mini App у Telegram.
        </p>
      )}
      {query.data && query.data.items.length > 0 && (
        <label className="trips-picker">
          Мої подорожі
          <select
            aria-label="Мої подорожі"
            disabled={disabled}
            value={fresh ? '' : (current?.id ?? '')}
            onChange={(e) => {
              if (e.target.value) setParams({ id: e.target.value });
            }}
          >
            <option value="">Нова подорож</option>
            {query.data.items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title} · {item.date_from ?? 'дати ще обираємо'}
              </option>
            ))}
          </select>
        </label>
      )}
      {current && (
        <div className="trips-record-actions">
          <DeleteTripButton
            key={current.id}
            current={current}
            disabled={disabled}
            onNavigate={(id, message, refreshRequired) => {
              setParams(id ? { id } : {}, { replace: true });
              setNotice(message);
              setUncertain(refreshRequired);
            }}
          />
        </div>
      )}
      {notice && (
        <div
          className={uncertain || mutation.isError ? 'trips-error' : 'trips-notice'}
          role={mutation.isError ? 'alert' : 'status'}
        >
          {notice}
        </div>
      )}
      {uncertain && (
        <button onClick={() => void refresh()} disabled={query.isFetching}>
          Оновити й перевірити результат
        </button>
      )}
      {query.isLoading ? (
        <p role="status" className="journey-loading">
          Відкриваю подорожі…
        </p>
      ) : query.error ? (
        <div role="alert" className="trips-error">
          <p>{query.error.message}</p>
          <button onClick={() => void refresh()}>Спробувати ще раз</button>
        </div>
      ) : current ? (
        <Journey
          key={current.id}
          current={current}
          execute={execute}
          disabled={disabled || current.status === 'cancelled'}
          details={(tab = 'overview') => setParams({ id: current.id, view: 'details', tab })}
        />
      ) : (
        <DestinationCard
          disabled={disabled}
          onSubmit={(to) => execute({ op: 'brief', data: { to } })}
        />
      )}
    </section>
  );
}

function DestinationCard({
  disabled,
  onSubmit,
}: {
  disabled: boolean;
  onSubmit: (to: string) => Promise<boolean>;
}) {
  const [destination, setDestination] = useState('');
  return (
    <article className="journey-welcome">
      <div className="journey-symbol" aria-hidden="true">
        ↗
      </div>
      <p className="trips-eyebrow">ПОЧНЕМО З ІДЕЇ</p>
      <h2>Куди вирушимо?</h2>
      <p>
        Розкажи про задум. Далі разом оберемо дорогу, житло й враження та підготуємо все до виїзду.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (destination.trim()) void onSubmit(destination.trim());
        }}
      >
        <label htmlFor="trip-destination">Місто або місце</label>
        <input
          id="trip-destination"
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
          placeholder="Наприклад, Прага"
          maxLength={120}
          required
          disabled={disabled}
        />
        <button className="trips-primary" disabled={disabled || !destination.trim()}>
          Почати планування →
        </button>
      </form>
      <div className="journey-promise">
        <span>01 · Короткий бриф</span>
        <span>02 · Обираємо варіанти</span>
        <span>03 · Готуємось і подорожуємо</span>
      </div>
    </article>
  );
}

function Journey({
  current: c,
  execute,
  disabled,
  details,
}: {
  current: TravelCurrent;
  execute: Execute;
  disabled: boolean;
  details: (tab?: string) => void;
}) {
  const [view, setView] = useState<Lifecycle | null>(null);
  const phase = view ?? actualStage(c),
    active = actualStage(c);
  const workspace = (op: string, value: Record<string, unknown>) =>
    execute({ op: 'workspace', id: c.id, revision: c.workspace?.revision, data: { op, value } });
  const progress = async (stage: string) => {
    if (await workspace('progress', { stage })) setView(null);
  };
  return (
    <div className="trips-stack">
      <article className="journey-trip-hero">
        <div>
          <p className="trips-eyebrow">ТВОЯ ПОДОРОЖ</p>
          <h2>{atext(c, 'to')}</h2>
          <p>
            {atext(c, 'from_city') || 'Звідки — ще обираємо'} <span aria-hidden="true">→</span>{' '}
            {atext(c, 'to')}
          </p>
        </div>
        <span className="journey-dates">
          {atext(c, 'date_from') || 'Обираємо дати'}
          {atext(c, 'date_to') ? ` — ${atext(c, 'date_to')}` : ''}
        </span>
        <div className="journey-facts">
          <span>{MODES[atext(c, 'mode')] ?? 'Обираємо транспорт'}</span>
          {c.answers.transport_count != null && <span>{atext(c, 'transport_count')} у дорозі</span>}
          {c.answers.destination_count != null && (
            <span>{atext(c, 'destination_count')} на місці</span>
          )}
          {c.answers.lodging_count != null && <span>{atext(c, 'lodging_count')} для житла</span>}
        </div>
        {Boolean(c.answers.country) && (
          <p className="trips-muted">
            {atext(c, 'country')} · {atext(c, 'timezone')}
          </p>
        )}
      </article>
      <nav className="journey-lifecycle" aria-label="Етапи подорожі">
        {LIFE.map(([key, name, n]) => (
          <button
            key={key}
            disabled={c.kind === 'draft' && key !== 'planning'}
            aria-current={key === phase ? 'step' : undefined}
            onClick={() => setView(key)}
          >
            <span>{n}</span>
            {name}
            {active === key && c.kind !== 'draft' && <i aria-label="Поточний етап" />}
          </button>
        ))}
      </nav>
      {c.status === 'cancelled' && (
        <p className="trips-notice">Поїздку скасовано. Збережений план доступний у деталях.</p>
      )}
      {phase === 'planning' && (
        <Planning
          current={c}
          disabled={disabled}
          execute={execute}
          onPreparation={() => setView('preparation')}
        />
      )}
      {phase !== 'planning' && c.workspace && (
        <>
          {phase === 'preparation' && (
            <>
              <PhaseHeading
                eyebrow="02 · ПЕРЕД ВИЇЗДОМ"
                title="Усе важливе — під рукою"
                text="Документи, квитки, речі й дім. Доповни список своїм і відмічай те, що вже готове."
              />
              <Preparation current={c} disabled={disabled} workspace={workspace} />
              <div className="journey-next">
                <p>Коли справді вирушите, підтвердь початок дороги.</p>
                <button
                  className="trips-primary"
                  disabled={disabled}
                  onClick={() => void progress('departed')}
                >
                  Ми вирушили →
                </button>
              </div>
            </>
          )}
          {phase === 'outbound' && (
            <>
              <PhaseHeading
                eyebrow="03 · У ДОРОЗІ"
                title="Спокійної дороги"
                text="Перевір посадку, документи й час прибуття. Точний розклад збережено в маршруті."
              />
              <Route current={c} />
              <TravelEssentials current={c} details={details} />
              <div className="journey-next">
                <p>Після прибуття перейдемо до планів на місці.</p>
                <button
                  className="trips-primary"
                  disabled={disabled}
                  onClick={() => void progress('arrived')}
                >
                  Ми вже на місці →
                </button>
              </div>
            </>
          )}
          {phase === 'destination' && (
            <>
              <PhaseHeading
                eyebrow="04 · ЧАС ДЛЯ ВРАЖЕНЬ"
                title="Подорож у твоєму темпі"
                text="Тут обрані місця й план. Можна відзначати відвідане, додавати своє та зберігати витрати."
              />
              <Route current={c} />
              <Places current={c} disabled={disabled} workspace={workspace} />
              <div className="journey-shortcuts">
                <button onClick={() => details('money')}>＋ Витрата</button>
                <button onClick={() => details('journal')}>Враження дня</button>
                <button onClick={() => setView('planning')}>Доповнити план</button>
              </div>
              <div className="journey-next">
                <p>Перед дорогою назад перевір заселення / виїзд, речі й зворотні квитки.</p>
                <button
                  className="trips-primary"
                  disabled={disabled}
                  onClick={() => void progress('returning')}
                >
                  Вирушаємо додому →
                </button>
              </div>
            </>
          )}
          {phase === 'return' && (
            <>
              <PhaseHeading
                eyebrow="05 · ПОВЕРНЕННЯ"
                title="Нічого не залишити позаду"
                text="Час виїзду, документи, речі, ключі від житла й застави. Усе потрібне для дороги додому."
              />
              <Preparation
                current={c}
                disabled={disabled}
                workspace={workspace}
                onlyGroup="return"
              />
              <TravelEssentials current={c} details={details} />
              <div className="journey-next">
                <p>Підтвердь, коли вже будеш удома.</p>
                <button
                  className="trips-primary"
                  disabled={disabled}
                  onClick={() => void progress('home')}
                >
                  Я вже вдома →
                </button>
              </div>
            </>
          )}
          {phase === 'after' && (
            <>
              <PhaseHeading
                eyebrow="06 · ПІСЛЯ ПОДОРОЖІ"
                title="Залишити найкраще"
                text="Звір витрати, повернення коштів і застави, розбери речі та збережи враження на майбутнє."
              />
              <Preparation current={c} disabled={disabled} workspace={workspace} onlyGroup="post" />
              <button onClick={() => details('money')}>Витрати й розрахунки групи</button>
              <button onClick={() => details('journal')}>Зберегти враження про подорож</button>
            </>
          )}
        </>
      )}
      <div className="journey-footer">
        <button onClick={() => details()}>Усі деталі подорожі ↗</button>
        <span>Маршрут · бронювання · витрати · враження</span>
      </div>
    </div>
  );
}

function PhaseHeading({ eyebrow, title, text }: { eyebrow: string; title: string; text: string }) {
  return (
    <div className="journey-phase">
      <p className="trips-eyebrow">{eyebrow}</p>
      <h2>{title}</h2>
      <p>{text}</p>
    </div>
  );
}

function Planning({
  current: c,
  execute,
  disabled,
  onPreparation,
}: {
  current: TravelCurrent;
  execute: Execute;
  disabled: boolean;
  onPreparation: () => void;
}) {
  const guide = c.planning;
  const [editing, setEditing] = useState<string | null>(null),
    [focus, setFocus] = useState<string | null>(null),
    [actualMode, setActualMode] = useState('');
  const answer = async (field: string, value: unknown, skip = false) => {
    if (c.kind !== 'draft' && field === 'support_level') {
      const saved = await execute({
        op: 'workspace',
        id: c.id,
        revision: c.workspace?.revision,
        data: { op: 'preferences', value: { support_level: value } },
      });
      if (saved) setEditing(null);
      return saved;
    }
    const saved = await execute({
      op: 'brief',
      id: c.id,
      revision: guide?.brief_revision ?? c.revision,
      ...(skip ? { skip_field: field } : {}),
      data: skip ? {} : { [field]: value },
    });
    if (saved) setEditing(null);
    return saved;
  };
  const plan = (data: Record<string, unknown>) =>
    execute({ op: 'planning', id: c.id, revision: guide?.revision, data });
  if (!guide)
    return (
      <article className="trips-card">
        <h3>Збережений план</h3>
        <p>
          Ця подорож створена раніше. Документи, речі й інші записи доступні на наступному етапі.
        </p>
        {c.kind !== 'draft' && (
          <button className="trips-primary" onClick={onPreparation}>
            До підготовки →
          </button>
        )}
      </article>
    );
  const question = editing ? guide.fields.find((q) => q.field === editing) : guide.question;
  const currentKind = focus ?? (SEARCH[guide.step] ? guide.step : 'transport');
  const stage = guide.stages.find((s) => s.kind === currentKind)!;
  return (
    <div className="trips-stack">
      {c.kind !== 'draft' && <button onClick={onPreparation}>До підготовки подорожі →</button>}
      {question ? (
        <QuestionCard
          key={`${question.field}:${editing ?? 'next'}`}
          question={question}
          value={c.answers[question.field]}
          disabled={disabled}
          submit={(value) => answer(question.field, value)}
          skip={() => answer(question.field, null, true)}
          back={
            editing
              ? () => setEditing(null)
              : () => {
                  const index = guide.fields.findIndex((q) => q.field === question.field);
                  const previous = guide.fields
                    .slice(0, index)
                    .reverse()
                    .find((q) => c.answers[q.field] != null);
                  if (previous) setEditing(previous.field);
                }
          }
          editing={Boolean(editing)}
        />
      ) : !guide.confirmed ? (
        <>
          <PhaseHeading
            eyebrow="БРИФ ГОТОВИЙ"
            title="Перевіримо задум"
            text="Підтвердь дані — і почнемо з транспорту. Житло шукатимемо після твого вибору дороги, а місця — після житла."
          />
          <BriefReview current={c} guide={guide} edit={setEditing} disabled={disabled} />
          <button
            className="trips-primary journey-wide"
            disabled={disabled}
            onClick={() => void plan({ action: 'confirm', start_search: true })}
          >
            Підтвердити й знайти транспорт →
          </button>
          <button disabled={disabled} onClick={() => void plan({ action: 'confirm' })}>
            Підтвердити — транспорт додам самостійно
          </button>
        </>
      ) : (
        <>
          <nav className="journey-search-steps" aria-label="Кроки планування">
            {guide.stages.map((s, i) => (
              <button
                key={s.kind}
                aria-current={stage.kind === s.kind ? 'step' : undefined}
                disabled={guide.stages.slice(0, i).some((p) => !p.resolved)}
                onClick={() => setFocus(s.kind)}
              >
                <span>{s.resolved ? '✓' : `0${i + 1}`}</span>
                {
                  { transport: 'Транспорт', stay: 'Житло', activity: 'Місця' }[
                    s.kind as 'transport'
                  ]
                }
              </button>
            ))}
          </nav>
          {guide.step === 'ready' && !focus ? (
            <article className="journey-ready">
              <div className="journey-symbol" aria-hidden="true">
                ✓
              </div>
              <p className="trips-eyebrow">ОСНОВУ ПОДОРОЖІ ЗІБРАНО</p>
              <h2>Переходимо до підготовки</h2>
              <p>
                Додамо списки документів і речей, справи перед виїздом та наступні етапи. Обрані
                варіанти ще потребують твого бронювання.
              </p>
              {guide.stages.map((s) => (
                <div className="journey-decision" key={s.kind}>
                  <b>
                    {
                      { transport: 'Дорога', stay: 'Житло', activity: 'Місця' }[
                        s.kind as 'transport'
                      ]
                    }
                  </b>
                  <p>
                    {s.decision?.mode === 'later'
                      ? 'Вирішимо пізніше'
                      : s.decision?.note || s.decision?.options.map((o) => o.title).join(', ')}
                  </p>
                  <button disabled={disabled} onClick={() => setFocus(s.kind)}>
                    Переглянути
                  </button>
                </div>
              ))}
              {c.kind === 'draft' ? (
                <>
                  {atext(c, 'mode') === 'compare' && (
                    <label className="journey-input-label">
                      Фактичний транспорт для супроводу
                      <select value={actualMode} onChange={(e) => setActualMode(e.target.value)}>
                        <option value="">Обери транспорт</option>
                        {Object.entries(MODES)
                          .filter(([key]) => key !== 'compare')
                          .map(([key, name]) => (
                            <option key={key} value={key}>
                              {name}
                            </option>
                          ))}
                      </select>
                    </label>
                  )}
                  <p className="trips-muted">
                    Telegram:{' '}
                    {(
                      {
                        plan: 'лише план, без нагадувань',
                        reminders: 'важливі нагадування',
                        companion: 'супровід протягом подорожі',
                      } as Record<string, string>
                    )[atext(c, 'support_level')] ?? 'за твоїми налаштуваннями'}
                    .
                  </p>
                  <button
                    className="trips-primary journey-wide"
                    disabled={disabled || (atext(c, 'mode') === 'compare' && !actualMode)}
                    onClick={() =>
                      void execute({
                        op: 'start',
                        id: c.id,
                        revision: guide.brief_revision,
                        data: {
                          consent: true,
                          support_level: atext(c, 'support_level') || 'plan',
                          ...(actualMode ? { actual_mode: actualMode } : {}),
                        },
                      })
                    }
                  >
                    Перейти до підготовки →
                  </button>
                </>
              ) : (
                <button className="trips-primary" onClick={onPreparation}>
                  Продовжити підготовку →
                </button>
              )}
            </article>
          ) : (
            <SearchCard
              key={`${stage.kind}:${stage.status}`}
              stage={stage}
              current={c}
              disabled={disabled}
              search={() => plan({ action: 'search', kind: stage.kind })}
              decide={async (mode, ids, note) => {
                if (await plan({ action: 'decision', kind: stage.kind, mode, ids, note }))
                  setFocus(null);
              }}
            />
          )}
          <details className="journey-details">
            <summary>Дані подорожі й побажання</summary>
            <BriefReview current={c} guide={guide} edit={setEditing} disabled={disabled} />
          </details>
        </>
      )}
      <p className="journey-help">
        Відповіді зберігаються після кожного кроку. Країну й часовий пояс визначаю за містом.
        Необов’язкові деталі можна додати пізніше.
      </p>
    </div>
  );
}

function QuestionCard({
  question: q,
  value,
  disabled,
  submit,
  skip,
  back,
  editing,
}: {
  question: Question;
  value: unknown;
  disabled: boolean;
  submit: (value: unknown) => Promise<boolean>;
  skip: () => Promise<boolean>;
  back: () => void;
  editing: boolean;
}) {
  const [custom, setCustom] = useState(!q.choices.length),
    [input, setInput] = useState(value == null ? '' : String(value));
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (input.trim()) void submit(q.type === 'number' ? Number(input) : input.trim());
  };
  return (
    <article className="journey-question">
      <div className="journey-question-top">
        <p className="trips-eyebrow">
          {editing ? 'УТОЧНЮЄМО' : 'ЗНАЙОМИМОСЯ З ПОДОРОЖЖЮ'} · {q.section}
        </p>
        {q.optional && <span className="trips-tag">За бажанням</span>}
      </div>
      <h2>{q.question}</h2>
      {q.hint && <p className="journey-hint">{q.hint}</p>}
      {q.choices.length > 0 && (
        <div className="journey-choices">
          {q.choices.map((choice) => (
            <button
              key={String(choice.value)}
              aria-pressed={value === choice.value}
              disabled={disabled}
              onClick={() => void submit(choice.value)}
            >
              {choice.label}
              <span aria-hidden="true">→</span>
            </button>
          ))}
        </div>
      )}
      {q.custom && !custom && (
        <button className="journey-text-button" disabled={disabled} onClick={() => setCustom(true)}>
          Вписати свій варіант
        </button>
      )}
      {q.custom && custom && (
        <form className="journey-answer" onSubmit={onSubmit}>
          <label htmlFor={`answer-${q.field}`}>
            {q.choices.length ? 'Свій варіант' : 'Твоя відповідь'}
          </label>
          <input
            id={`answer-${q.field}`}
            type={q.type}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            maxLength={q.field === 'to' ? 120 : 300}
            min={q.field === 'children_count' ? 0 : 1}
            step={q.type === 'number' ? 1 : undefined}
            disabled={disabled}
            required
          />
          <button className="trips-primary" disabled={disabled || !input.trim()}>
            Далі →
          </button>
        </form>
      )}
      <div className="journey-question-bottom">
        <button className="journey-text-button" disabled={disabled} onClick={back}>
          {editing ? 'Повернутися без змін' : '← Попередня відповідь'}
        </button>
        {q.optional && !editing && (
          <button disabled={disabled} onClick={() => void skip()}>
            Додам пізніше
          </button>
        )}
      </div>
    </article>
  );
}

function BriefReview({
  current: c,
  guide,
  edit,
  disabled,
}: {
  current: TravelCurrent;
  guide: Guide;
  edit: (field: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="journey-review">
      {guide.fields.map((q) => {
        const value = c.answers[q.field];
        const label =
          q.choices.find((choice) => choice.value === value)?.label ??
          (value == null ? 'Ще не уточнювали' : String(value));
        const locked =
          c.kind !== 'draft' &&
          ['to', 'from_city', 'date_from', 'date_to', 'return_type', 'mode'].includes(q.field);
        return (
          <button key={q.field} disabled={disabled || locked} onClick={() => edit(q.field)}>
            <span>
              {q.question}
              {locked ? ' · зміна дат у деталях подорожі' : ''}
            </span>
            <b>{label}</b>
            <i aria-hidden="true">↗</i>
          </button>
        );
      })}
    </div>
  );
}

function SearchCard({
  stage,
  current: c,
  disabled,
  search,
  decide,
}: {
  stage: SearchStage;
  current: TravelCurrent;
  disabled: boolean;
  search: () => Promise<boolean>;
  decide: (mode: string, ids: string[], note: string) => Promise<void>;
}) {
  const [ids, setIds] = useState<string[]>([]),
    [manual, setManual] = useState(false),
    [note, setNote] = useState('');
  const copy = SEARCH[stage.kind],
    running = stage.status === 'running';
  const start = async () => {
    await search();
  };
  return (
    <article className="journey-search">
      <p className="trips-eyebrow">
        КРОК {{ transport: '1 / 3', stay: '2 / 3', activity: '3 / 3' }[stage.kind as 'transport']}
      </p>
      <h2>{copy.title}</h2>
      <p>{copy.description}</p>
      {stage.needs_review && (
        <div className="trips-notice">
          Дані або попередній вибір змінилися. Перевір цей крок за новими умовами.
        </div>
      )}
      {stage.resolved && (
        <p className="trips-notice">
          Збережено:{' '}
          {stage.decision?.mode === 'later'
            ? 'рішення відкладено'
            : stage.decision?.note || stage.decision?.options.map((o) => o.title).join(', ')}
          .
        </p>
      )}
      {stage.kind === 'stay' && atext(c, 'lodging_needed') === 'no' && (
        <button
          className="trips-primary journey-wide"
          disabled={disabled}
          onClick={() =>
            void decide('manual', [], 'Житло вже є або не потрібне — як зазначено в брифі.')
          }
        >
          Житло вже є / не потрібне — далі →
        </button>
      )}
      {running ? (
        <div className="journey-searching" role="status">
          <span className="journey-spinner" aria-hidden="true" />
          <div>
            <b>Підбираю варіанти й перевіряю джерела</b>
            <p>
              Зазвичай це займає кілька хвилин. Можна закрити застосунок і повернутися: результат
              збережеться тут.
            </p>
          </div>
        </div>
      ) : (
        <button
          className="trips-primary journey-wide"
          disabled={disabled}
          onClick={() => void start()}
        >
          {stage.status === 'idle' ? copy.button : 'Пошукати ще раз'}
        </button>
      )}
      {['failed', 'timed_out'].includes(stage.status) && (
        <p className="trips-error" role="alert">
          {stage.status === 'timed_out'
            ? 'Пошук не встиг завершитися. Повтори спробу або додай свій варіант.'
            : stage.summary || 'Пошук не завершився. Спробуй ще раз.'}
        </p>
      )}
      {stage.status === 'no_results' && (
        <p className="trips-notice">
          {stage.summary ||
            'Не вдалося підтвердити доречні варіанти. Можна уточнити побажання, повторити пошук або додати свій варіант.'}
        </p>
      )}
      {stage.status === 'completed' && stage.summary && (
        <p className="journey-search-summary">{stage.summary}</p>
      )}
      <div className="journey-offers">
        {stage.options.map((o) => (
          <article className={`journey-offer ${ids.includes(o.id) ? 'is-picked' : ''}`} key={o.id}>
            <div className="journey-offer-top">
              <span>{o.provider || 'Знайдено в мережі'}</span>
              <span>
                {o.stale
                  ? 'Потрібна нова перевірка'
                  : o.availability === 'provider_quote'
                    ? 'Пропозиція провайдера'
                    : 'Перевірити наявність'}
              </span>
            </div>
            <h3>{o.title}</h3>
            <p className="journey-price">
              {o.price ? `${o.price.amount} ${o.price.currency}` : 'Ціну не підтверджено'}
              {o.price && (
                <small>
                  {UNITS[o.price.unit] ?? o.price.unit} · кількість {o.price.quantity}
                </small>
              )}
            </p>
            {o.price?.includes && <p className="trips-muted">У ціні: {o.price.includes}</p>}
            {o.price?.excludes && <p className="trips-muted">Окремо: {o.price.excludes}</p>}
            {o.dates && <p>{o.dates}</p>}
            {o.schedule && <p>{o.schedule}</p>}
            {o.location && <p>{o.location}</p>}
            {o.tradeoffs && <p>{o.tradeoffs}</p>}
            {o.cancellation && <p className="trips-muted">Скасування: {o.cancellation}</p>}
            {o.missing && <p className="trips-muted">Уточнити: {o.missing}</p>}
            <div className="trips-actions">
              <a href={o.source_url} target="_blank" rel="noreferrer noopener">
                Переглянути джерело ↗
              </a>
              <button
                disabled={disabled || o.stale || running}
                aria-pressed={ids.includes(o.id)}
                onClick={() =>
                  stage.kind === 'activity'
                    ? setIds((old) =>
                        old.includes(o.id) ? old.filter((id) => id !== o.id) : [...old, o.id],
                      )
                    : void decide('selected', [o.id], '')
                }
              >
                {stage.kind === 'activity'
                  ? ids.includes(o.id)
                    ? '✓ У плані'
                    : '＋ До плану'
                  : 'Обрати й далі →'}
              </button>
            </div>
            <small>
              Перевірено {new Date(o.checked_at).toLocaleString('uk-UA')}. Вибір зберігає задум;
              бронювання виконуєш ти.
            </small>
          </article>
        ))}
      </div>
      {stage.kind === 'activity' && ids.length > 0 && (
        <button
          className="trips-primary journey-wide"
          disabled={disabled || running}
          onClick={() => void decide('selected', ids, '')}
        >
          Зберегти {ids.length} місць і продовжити →
        </button>
      )}
      {!running && (
        <div className="journey-alternatives">
          <button disabled={disabled} onClick={() => setManual((v) => !v)}>
            Маю свій варіант / уже обрано
          </button>
          <button disabled={disabled} onClick={() => void decide('later', [], '')}>
            Вирішу пізніше — далі
          </button>
        </div>
      )}
      {manual && !running && (
        <form
          className="journey-answer"
          onSubmit={(e) => {
            e.preventDefault();
            if (note.trim()) void decide('manual', [], note.trim());
          }}
        >
          <label htmlFor="trip-manual-choice">Що врахувати далі?</label>
          <textarea
            id="trip-manual-choice"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={1000}
            required
            placeholder={
              stage.kind === 'transport'
                ? 'Перевізник, час відправлення й прибуття, стан квитків…'
                : stage.kind === 'stay'
                  ? 'Адреса або район, дати, час заселення…'
                  : 'Назви місць, дати й побажання…'
            }
          />
          <button className="trips-primary" disabled={disabled || !note.trim()}>
            Зберегти свій варіант →
          </button>
        </form>
      )}
    </article>
  );
}

type Workspace = (op: string, value: Record<string, unknown>) => Promise<boolean>;
function taskGroup(task: NonNullable<TravelCurrent['workspace']>['tasks'][number]) {
  if (task.id.startsWith('post-')) return 'post';
  if (task.group) return task.group;
  if (/documents|offline|border|passport/.test(task.id)) return 'documents';
  if (/packing|pack-|connection/.test(task.id)) return 'packing';
  if (/home/.test(task.id)) return 'home';
  if (/return/.test(task.id)) return 'return';
  if (/lodging|vehicle|flight/.test(task.id)) return 'bookings';
  return 'other';
}
function Preparation({
  current: c,
  disabled,
  workspace,
  onlyGroup,
}: {
  current: TravelCurrent;
  disabled: boolean;
  workspace: Workspace;
  onlyGroup?: string;
}) {
  const [group, setGroup] = useState('documents'),
    [title, setTitle] = useState(''),
    [recordId, setRecordId] = useState(() => crypto.randomUUID());
  const selected = onlyGroup ?? group,
    tasks = c.workspace?.tasks ?? [],
    visible = tasks.filter((task) => taskGroup(task) === selected);
  const done = visible.filter(
    (task) => task.status === 'done' || task.status === 'not_needed',
  ).length;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (
      title.trim() &&
      (await workspace('task', {
        id: recordId,
        title: title.trim(),
        group: selected,
        status: 'open',
      }))
    ) {
      setTitle('');
      setRecordId(crypto.randomUUID());
    }
  };
  return (
    <article className="journey-checklist">
      {!onlyGroup && (
        <nav className="journey-groups" aria-label="Розділи підготовки">
          {Object.entries(GROUPS).map(([key, name]) => (
            <button
              key={key}
              aria-current={selected === key ? 'page' : undefined}
              onClick={() => setGroup(key)}
            >
              {name}
              <span>
                {
                  tasks.filter(
                    (t) => taskGroup(t) === key && ['done', 'not_needed'].includes(t.status),
                  ).length
                }
                /{tasks.filter((t) => taskGroup(t) === key).length}
              </span>
            </button>
          ))}
        </nav>
      )}
      <div className="trips-card-heading">
        <h3>{selected === 'post' ? 'Завершуємо подорож' : GROUPS[selected]}</h3>
        <span className="trips-tag">
          {done} / {visible.length} готово
        </span>
      </div>
      {visible.length ? (
        visible.map((task) => (
          <div className="journey-task" key={task.id}>
            <label>
              <input
                type="checkbox"
                checked={task.status === 'done' || task.status === 'not_needed'}
                disabled={disabled}
                onChange={(e) =>
                  void workspace('task', {
                    id: task.id,
                    status: e.target.checked ? 'done' : 'open',
                  })
                }
              />
              <span className={task.status === 'done' ? 'is-done' : ''}>{task.title}</span>
            </label>
            {task.status !== 'not_needed' && task.status !== 'done' && (
              <button
                className="journey-text-button"
                aria-label={`Не потрібно: ${task.title}`}
                disabled={disabled}
                onClick={() => void workspace('task', { id: task.id, status: 'not_needed' })}
              >
                Не потрібно
              </button>
            )}
            {task.status === 'not_needed' && <small>Не потрібно</small>}
          </div>
        ))
      ) : (
        <p className="trips-muted">Додай те, що важливо саме для твоєї подорожі.</p>
      )}
      {selected === 'documents' && (
        <p className="journey-help">
          Для правил виїзду, в’їзду й транзиту потрібні актуальні вимоги для громадянства та
          документів кожного учасника. Підтверджуй справу після власної перевірки.
        </p>
      )}
      <form className="journey-add" onSubmit={(e) => void submit(e)}>
        <label htmlFor={`trip-task-${selected}`}>
          {selected === 'packing' ? 'Додати свою річ' : 'Додати свою справу'}
        </label>
        <div>
          <input
            id={`trip-task-${selected}`}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={160}
            required
            disabled={disabled}
          />
          <button disabled={disabled || !title.trim()}>＋ Додати</button>
        </div>
      </form>
      {!onlyGroup && (
        <div className="journey-question-bottom">
          <button disabled={disabled} onClick={() => void workspace('prepare', {})}>
            Доповнити рекомендованими справами
          </button>
          {Object.keys(GROUPS).indexOf(group) < Object.keys(GROUPS).length - 1 && (
            <button
              className="trips-primary"
              onClick={() => setGroup(Object.keys(GROUPS)[Object.keys(GROUPS).indexOf(group) + 1])}
            >
              Наступний розділ →
            </button>
          )}
        </div>
      )}
    </article>
  );
}

function Route({ current: c }: { current: TravelCurrent }) {
  const legs = c.workspace?.legs ?? [];
  const selected = c.planning?.stages.find((stage) => stage.kind === 'transport');
  return (
    <article className="trips-card">
      <h3>Збережений маршрут</h3>
      {c.workspace?.itinerary_stale && (
        <p className="trips-notice">Дати змінювалися. Перевір маршрут у деталях.</p>
      )}
      {legs.length ? (
        legs.map((leg) => (
          <div className="journey-route-leg" key={leg.id}>
            <b>{leg.title}</b>
            <p>
              {leg.start} ({leg.start_zone}) → {leg.end} ({leg.end_zone})
            </p>
            <small>
              {leg.from} → {leg.to}
              {leg.booked ? ' · Квитки підтверджено власником' : ''}
            </small>
          </div>
        ))
      ) : selected?.decision ? (
        <>
          {!selected.resolved && (
            <p className="trips-notice">Обрана дорога потребує перевірки за поточними умовами.</p>
          )}
          {selected.decision.mode === 'selected' ? (
            selected.decision.options.map((o) => (
              <div className="journey-route-leg" key={o.id}>
                <b>{o.title}</b>
                <p>{o.dates}</p>
                <p>{o.schedule}</p>
                <a href={o.source_url} target="_blank" rel="noreferrer noopener">
                  Перевірити рейс у джерелі ↗
                </a>
              </div>
            ))
          ) : (
            <p>{selected.decision.note || 'Транспорт ще обираємо.'}</p>
          )}
          <small>
            Час і місце посадки звіряй із придбаними квитками. Точні етапи можна додати в деталях
            маршруту.
          </small>
        </>
      ) : (
        <p>
          Точні етапи ще не внесені. Додай час і місце посадки з придбаних квитків у деталях
          маршруту.
        </p>
      )}
    </article>
  );
}
function TravelEssentials({
  current: c,
  details,
}: {
  current: TravelCurrent;
  details: (tab?: string) => void;
}) {
  const [notice, setNotice] = useState('');
  const stay = c.planning?.stages.find((stage) => stage.kind === 'stay')?.decision;
  return (
    <article className="trips-card">
      <h3>Потрібне в дорозі</h3>
      <p>Квитки, адреса житла, документи, зарядка й резерв оплати.</p>
      {stay?.mode === 'manual' && <p>{stay.note}</p>}
      {stay?.mode === 'selected' &&
        stay.options.map((o) => (
          <div className="journey-place" key={o.id}>
            <b>{o.title}</b>
            <p>{o.location}</p>
            <p>{o.schedule}</p>
            <a href={o.source_url} target="_blank" rel="noreferrer noopener">
              Сторінка житла ↗
            </a>
          </div>
        ))}
      {notice && (
        <p role="alert" className="trips-error">
          {notice}
        </p>
      )}
      <div className="trips-actions">
        <button onClick={() => details('route')}>Маршрут і квитки</button>
        <button
          onClick={() => {
            setNotice('');
            void downloadTrip(c.id).catch((error: unknown) =>
              setNotice(error instanceof Error ? error.message : 'Не вдалося зберегти план.'),
            );
          }}
        >
          Зберегти план офлайн
        </button>
        <button onClick={() => details('overview')}>Дані й налаштування</button>
      </div>
    </article>
  );
}
function Places({
  current: c,
  disabled,
  workspace,
}: {
  current: TravelCurrent;
  disabled: boolean;
  workspace: Workspace;
}) {
  const places = c.workspace?.places ?? [],
    selected =
      c.planning?.stages.find((stage) => stage.kind === 'activity')?.decision?.options ?? [];
  return (
    <article className="trips-card">
      <h3>Місця з твого плану</h3>
      {!places.length && !selected.length && (
        <p>Місця можна знайти на етапі планування або додати у враженнях.</p>
      )}
      {places.map((place) => (
        <div className="journey-place" key={place.id}>
          <b>{place.title}</b>
          <p>{place.note}</p>
          <button
            disabled={disabled}
            aria-pressed={place.status === 'visited'}
            onClick={() =>
              void workspace('place', {
                ...place,
                status: place.status === 'visited' ? 'saved' : 'visited',
              })
            }
          >
            {place.status === 'visited' ? '✓ Відвідали' : 'Відзначити відвіданим'}
          </button>
        </div>
      ))}
      {selected
        .filter((o) => !places.some((p) => p.url === o.source_url))
        .map((o) => (
          <div className="journey-place" key={o.id}>
            <b>{o.title}</b>
            <p>{o.schedule}</p>
            <div className="trips-actions">
              <a href={o.source_url} target="_blank" rel="noreferrer noopener">
                Джерело ↗
              </a>
              <button
                disabled={disabled}
                onClick={() =>
                  void workspace('place', {
                    id: o.id,
                    title: o.title,
                    status: 'visited',
                    url: o.source_url,
                    note: o.location ?? '',
                  })
                }
              >
                Відвідали — до вражень
              </button>
            </div>
          </div>
        ))}
    </article>
  );
}
