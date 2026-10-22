import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
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
import { Sheet } from '../ui/Sheet.tsx';
import { SessionExpired } from '../ui/SessionExpired.tsx';
import { DeleteTripButton } from './DeleteTripButton.tsx';
import { tripInstant } from '../../../../core/trips/time.mjs';
import './trips.css';

const MODES = {
  bus: 'Автобус',
  train: 'Потяг',
  car: 'Авто',
  plane: 'Літак',
  mixed: 'Змішано',
  walk: 'Пішки',
  hike: 'Похід',
  compare: 'Порівняти',
};
const STAGES = {
  planned: 'Плануємо',
  departed: 'У дорозі',
  arrived: 'На місці',
  returning: 'Повертаємося',
  home: 'Удома',
};
const BOOKING = {
  selected: 'Обрано',
  owner_booked: 'Забронював власник',
  provider_confirmed: 'Є підтвердження провайдера',
  cancelled: 'Скасовано власником',
  refund_pending: 'Очікую повернення коштів',
  refunded: 'Кошти повернули',
};
const KINDS = {
  transport: 'Дорога',
  stay: 'Житло',
  activity: 'Враження',
  insurance: 'Страхування',
  other: 'Інше',
};
const UNITS = {
  person: 'за людину',
  group: 'за групу',
  room_night: 'за номер / ніч',
  stay: 'за проживання',
  ticket: 'за квиток',
  entry: 'за вхід',
};
const TABS = [
  ['overview', 'Огляд'],
  ['options', 'Варіанти'],
  ['route', 'Маршрут'],
  ['tasks', 'Підготовка'],
  ['money', 'Витрати'],
  ['journal', 'Враження'],
] as const;
type Tab = (typeof TABS)[number][0];
type Field = {
  key: string;
  label: string;
  type?: string;
  options?: Record<string, string>;
  required?: boolean;
  hint?: string;
};
type Editor = {
  title: string;
  fields: Field[];
  values: Record<string, string>;
  save: (values: Record<string, string>) => Promise<void>;
};
const value = (c: TravelCurrent, key: string) => String(c.answers[key] ?? '');
const label = (labels: Record<string, string>, key: string) => labels[key] ?? key;
const money = (minor: number, currency: string) =>
  new Intl.NumberFormat('uk-UA', { style: 'currency', currency }).format(minor / 100);
const DATE_FIELDS: Field[] = [
  { key: 'date_from', label: 'Виїзд', type: 'date', required: true },
  { key: 'date_to', label: 'Повернення', type: 'date' },
];
const BRIEF_FIELDS: Field[] = [
  { key: 'to', label: 'Куди', required: true },
  { key: 'from_city', label: 'Звідки' },
  ...DATE_FIELDS,
  { key: 'mode', label: 'Транспорт', options: MODES },
  { key: 'transport_count', label: 'Разом у дорозі', type: 'number' },
  { key: 'destination_count', label: 'Людей на місці', type: 'number' },
  { key: 'lodging_count', label: 'Людей для житла', type: 'number' },
  { key: 'lodging_from', label: 'Дата заселення', type: 'date' },
  { key: 'lodging_to', label: 'Дата виїзду з житла', type: 'date' },
  {
    key: 'purpose',
    label: 'Мета',
    options: { дозвілля: 'Відпочинок', ділова: 'Робота', транзит: 'Транзит' },
  },
  {
    key: 'lodging_needed',
    label: 'Житло',
    options: { yes: 'Потрібно знайти', no: 'Уже є', undecided: 'Ще вирішую' },
  },
  {
    key: 'budget_type',
    label: 'Бюджет',
    options: { flexible: 'Гнучкий', limit: 'Чіткий ліміт', no_limit: 'Без ліміту' },
  },
  { key: 'budget_total', label: 'Ліміт бюджету', type: 'number' },
  { key: 'budget_currency', label: 'Валюта бюджету' },
  {
    key: 'budget_scope',
    label: 'На кого бюджет',
    options: { person: 'На мене', transport_group: 'На тих, хто їде', whole_group: 'На всю групу' },
  },
  {
    key: 'return_meaning',
    label: 'Дата повернення означає',
    options: {
      home_arrival: 'Уже бути вдома',
      destination_departure: 'Виїхати назад',
      undecided: 'Ще не знаю',
    },
  },
  { key: 'interests', label: 'Що хочеться побачити', type: 'textarea' },
  { key: 'constraints', label: 'Важливі обмеження', type: 'textarea' },
  { key: 'accessibility', label: 'Доступність, потреби учасників', type: 'textarea' },
  {
    key: 'support_level',
    label: 'Допомога',
    options: { plan: 'Лише план', reminders: 'План і строки', companion: 'Повний супровід' },
  },
];

export function TripsWorkspace() {
  const [params, setParams] = useSearchParams(),
    selected = params.get('id') ?? undefined;
  const [tab, setTab] = useState<Tab>(
      TABS.some(([id]) => id === params.get('tab')) ? (params.get('tab') as Tab) : 'overview',
    ),
    [editor, setEditor] = useState<Editor | null>(null),
    [notice, setNotice] = useState(''),
    [uncertain, setUncertain] = useState(false),
    [researchRequest, setResearchRequest] = useState<{ until: number; revision: number } | null>(
      null,
    );
  const cache = useQueryClient();
  useEffect(() => {
    if (!researchRequest) return;
    const timer = window.setTimeout(
      () => setResearchRequest(null),
      Math.max(0, researchRequest.until - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [researchRequest]);
  const query = useQuery({
    queryKey: ['trips', selected],
    queryFn: () => fetchTrips(selected),
    refetchInterval: (q) =>
      researchRequest &&
      Date.now() < researchRequest.until &&
      (q.state.data?.current?.research?.revision ?? 0) <= researchRequest.revision
        ? 8000
        : false,
  });
  const mutation = useMutation({
    mutationFn: (command: TravelCommand) => changeTrip(command),
    onSuccess: (snapshot) => {
      if (snapshot) {
        const id = snapshot.current?.id;
        cache.setQueryData(['trips', id], snapshot);
        if (id) setParams({ id, view: 'details' }, { replace: true });
        setUncertain(false);
      } else {
        setNotice('Зміну збережено. Оновлюю поїздку…');
        void query.refetch();
      }
    },
    onError: (error) => {
      setNotice(error.message);
      if (error instanceof TravelChangeError && error.uncertain) setUncertain(true);
    },
  });
  const searching = Boolean(
    researchRequest && (query.data?.current?.research?.revision ?? 0) <= researchRequest.revision,
  );
  const current = query.data?.current,
    busy = mutation.isPending,
    disabled = busy || uncertain;
  const execute = async (command: TravelCommand) => {
    try {
      const snapshot = await mutation.mutateAsync(command);
      setNotice(
        command.op === 'research'
          ? 'Пошук розпочато. Можна залишитися тут або перейти в Telegram.'
          : 'Збережено.',
      );
      if (command.op !== 'research' && snapshot?.current?.research?.options.length)
        setResearchRequest(null);
      setEditor(null);
    } catch {
      /* Keep the form and its stable record id for recovery. */
    }
  };
  const edit = (
    title: string,
    fields: Field[],
    values: Record<string, string>,
    save: Editor['save'],
  ) => {
    mutation.reset();
    setEditor({ title, fields, values, save });
  };
  const workspace = (op: string, data: Record<string, unknown>) =>
    current
      ? execute({
          op: 'workspace',
          id: current.id,
          revision: current.workspace?.revision,
          data: { op, value: data },
        })
      : Promise.resolve();
  const editBrief = (fresh = false) => {
    const original = fresh ? {} : (current?.answers ?? {});
    edit(
      fresh ? 'Нова подорож' : 'Деталі подорожі',
      BRIEF_FIELDS,
      Object.fromEntries(Object.entries(original).map(([key, v]) => [key, String(v ?? '')])),
      async (values) => {
        const numbers = ['transport_count', 'destination_count', 'lodging_count', 'budget_total'];
        const data = Object.fromEntries(
          Object.entries(values)
            .filter(([key, v]) => (fresh ? v !== '' : String(original[key] ?? '') !== v))
            .map(([key, v]) => [key, v === '' ? null : numbers.includes(key) ? Number(v) : v]),
        );
        await execute({
          op: 'brief',
          ...(!fresh && current ? { id: current.id, revision: current.revision } : {}),
          data,
        });
      },
    );
  };
  if (isSessionExpired(query.error) || isSessionExpired(mutation.error)) return <SessionExpired />;
  const ws = current?.workspace,
    ledger = current?.ledger,
    zone = current ? value(current, 'timezone') || 'Europe/Kyiv' : 'Europe/Kyiv';
  const localIso = (at: string | undefined | null) =>
    at
      ? new Intl.DateTimeFormat('sv-SE', { timeZone: zone, dateStyle: 'short', timeStyle: 'short' })
          .format(new Date(at))
          .replace(' ', 'T')
      : '';
  const instant = (s: string) => (s ? new Date(tripInstant(s, zone)).toISOString() : null);
  const party = Object.fromEntries((ws?.party ?? []).map((p) => [p.id, p.label]));
  if (!party.owner) party.owner = 'Я';
  const addTask = () => {
    const id = crypto.randomUUID();
    edit(
      'Справа до поїздки',
      [
        { key: 'title', label: 'Що зробити', required: true },
        { key: 'due_at', label: `Строк · ${zone}`, type: 'datetime-local' },
        { key: 'owner', label: 'Хто відповідає' },
        { key: 'note', label: 'Деталі', type: 'textarea' },
      ],
      {},
      (v) => workspace('task', { ...v, id, due_at: instant(v.due_at ?? '') }),
    );
  };
  const editBooking = (b?: NonNullable<typeof ws>['bookings'][number]) => {
    const id = b?.id ?? crypto.randomUUID();
    edit(
      b ? 'Запис бронювання' : 'Додати бронювання',
      [
        { key: 'title', label: 'Назва', required: true },
        { key: 'kind', label: 'Тип', options: KINDS },
        { key: 'status', label: 'Стан зі слів власника', options: BOOKING },
        { key: 'source_url', label: 'Джерело / кабінет провайдера', type: 'url' },
        { key: 'reference', label: 'Код бронювання (за бажанням)' },
        { key: 'checkin_at', label: `Заселення / реєстрація · ${zone}`, type: 'datetime-local' },
        {
          key: 'cancel_by',
          label: `Кінець безплатного скасування · ${zone}`,
          type: 'datetime-local',
        },
      ],
      {
        title: b?.title ?? '',
        kind: b?.kind ?? 'stay',
        status: b?.status ?? 'owner_booked',
        source_url: b?.source_url ?? '',
        reference: b?.reference ?? '',
        checkin_at: localIso(b?.checkin_at),
        cancel_by: localIso(b?.cancel_by),
      },
      (v) =>
        workspace('booking', {
          ...v,
          id,
          checkin_at: instant(v.checkin_at ?? ''),
          cancel_by: instant(v.cancel_by ?? ''),
        }),
    );
  };
  const editLeg = (l?: NonNullable<typeof ws>['legs'][number]) => {
    const id = l?.id ?? crypto.randomUUID();
    edit(
      l ? 'Етап маршруту' : 'Додати етап',
      [
        { key: 'title', label: 'Назва', required: true },
        {
          key: 'kind',
          label: 'Тип',
          options: { travel: 'Дорога', stay: 'Проживання', activity: 'Заняття' },
        },
        { key: 'mode', label: 'Транспорт', options: MODES },
        { key: 'from', label: 'Звідки' },
        { key: 'to', label: 'Куди' },
        {
          key: 'start',
          label: 'Початок за місцевим часом',
          type: 'datetime-local',
          required: true,
        },
        { key: 'start_zone', label: 'Часовий пояс початку', required: true },
        { key: 'end', label: 'Кінець за місцевим часом', type: 'datetime-local', required: true },
        { key: 'end_zone', label: 'Часовий пояс кінця', required: true },
        { key: 'transfer_minutes', label: 'Запас на пересадку, хв', type: 'number' },
        { key: 'source_url', label: 'Джерело', type: 'url' },
      ],
      {
        id,
        title: l?.title ?? '',
        kind: l?.kind ?? 'activity',
        mode: l?.mode ?? value(current!, 'mode'),
        from: l?.from ?? '',
        to: l?.to ?? '',
        start: l?.start ?? '',
        end: l?.end ?? '',
        start_zone: l?.start_zone ?? zone,
        end_zone: l?.end_zone ?? zone,
        transfer_minutes: String(l?.transfer_minutes ?? 0),
        source_url: l?.source_url ?? '',
      },
      (v) =>
        workspace('leg', {
          ...v,
          id,
          mode: v.mode || null,
          transfer_minutes: Number(v.transfer_minutes || 0),
          booked: l?.booked ?? false,
        }),
    );
  };
  const addExpense = (kind = 'expense', refers_to?: string) => {
    const id = crypto.randomUUID(),
      ref = ledger?.entries.find((e) => e.id === refers_to);
    edit(
      kind === 'refund' ? 'Повернення коштів' : 'Фінансовий запис',
      [
        {
          key: 'kind',
          label: 'Вид запису',
          options: refers_to
            ? { refund: 'Повернення коштів' }
            : {
                expense: 'Витрата',
                deposit: 'Поворотна застава',
                settlement: 'Розрахунок між учасниками',
              },
        },
        { key: 'amount', label: 'Сума', type: 'number', required: true },
        { key: 'currency', label: 'Валюта', required: true },
        {
          key: 'category',
          label: 'Категорія',
          options: {
            transport: 'Дорога',
            lodging: 'Житло',
            food: 'Їжа',
            activities: 'Враження',
            shopping: 'Покупки',
            other: 'Інше',
          },
        },
        { key: 'paid_by', label: 'Хто заплатив', options: party },
        { key: 'paid_to', label: 'Кому (для розрахунку)', options: party },
        { key: 'split', label: 'На кого ділиться витрата', type: 'people', options: party },
        { key: 'note', label: 'За що', type: 'textarea' },
      ],
      {
        kind,
        currency: ref?.currency ?? 'UAH',
        paid_by: ref?.paid_by ?? 'owner',
        paid_to: Object.keys(party).find((p) => p !== 'owner') ?? 'owner',
      },
      async (v) => {
        await execute({
          op: 'expense',
          id: current!.id,
          data: {
            ...v,
            entry_id: id,
            amount: Number(v.amount),
            refers_to,
            split_with: v.split
              ? v.split
                  .split(',')
                  .filter(Boolean)
                  .map((person_id) => ({ person_id }))
              : undefined,
          },
        });
      },
    );
  };

  return (
    <section className="trips-screen">
      <button onClick={() => setParams(selected ? { id: selected } : {})}>
        ← До подорожі крок за кроком
      </button>
      <header className="trips-heading">
        <div>
          <p className="trips-eyebrow">ВІД ІДЕЇ ДО ПОВЕРНЕННЯ</p>
          <h1>Подорожі</h1>
        </div>
        <button className="trips-primary" disabled={disabled} onClick={() => editBrief(true)}>
          ＋ Нова
        </button>
      </header>
      {!inTelegram() && (
        <p className="trips-demo">Приклад поїздки. Власні записи доступні в Telegram.</p>
      )}
      {notice && (
        <div className="trips-notice" role="status">
          {notice}
          {searching && (
            <button onClick={() => setResearchRequest(null)}>Припинити оновлення</button>
          )}
        </div>
      )}
      {(query.error || uncertain) && (
        <div className="trips-error" role="alert">
          <p>{query.error?.message ?? 'Онови дані, перш ніж робити наступну зміну.'}</p>
          <button
            onClick={() =>
              void query.refetch().then((r) => {
                if (r.isSuccess) {
                  setUncertain(false);
                  setNotice('Дані оновлено. Перевір результат попередньої дії.');
                }
              })
            }
          >
            Оновити дані
          </button>
        </div>
      )}
      {query.isPending ? (
        <div className="trips-empty" aria-busy="true">
          Відкриваю плани подорожей…
        </div>
      ) : (
        <>
          {!!query.data?.items.length && (
            <label className="trips-picker">
              Моя поїздка
              <select
                aria-label="Обрати поїздку"
                value={current?.id ?? ''}
                onChange={(e) => {
                  setParams({ id: e.target.value, view: 'details' });
                  setTab('overview');
                  setNotice('');
                }}
              >
                {query.data.items.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title} · {item.date_from ?? 'дати відкриті'}
                    {item.status === 'paused' ? ' · відкладено' : ''}
                    {item.status === 'done' ? ' · завершено' : ''}
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
                  setParams(id ? { id, view: 'details' } : { view: 'details' }, { replace: true });
                  setNotice(message);
                  setUncertain(refreshRequired);
                  setEditor(null);
                  setResearchRequest(null);
                }}
              />
            </div>
          )}
          {!current ? (
            <div className="trips-empty">
              <span>↗</span>
              <h2>Куди наступного разу?</h2>
              <p>
                Назви місто й приблизні дати. Світанок допоможе з дорогою, житлом, підготовкою та
                поверненням.
              </p>
              <button onClick={() => editBrief(true)}>Почати планування</button>
            </div>
          ) : (
            <>
              <article className="trips-hero">
                <p>
                  {value(current, 'from_city') || 'Звідки ще не визначено'} <span>→</span>
                </p>
                <h2>{value(current, 'to') || 'Нова подорож'}</h2>
                <div className="trips-hero-meta">
                  <span>
                    {value(current, 'date_from') || 'Дата відкрита'}
                    {value(current, 'date_to') ? ` — ${value(current, 'date_to')}` : ''}
                  </span>
                  <span>{label(MODES, value(current, 'mode')) || 'Транспорт обираємо'}</span>
                </div>
                <div className="trips-party">
                  <span>
                    <b>{value(current, 'transport_count') || '?'}</b> у дорозі
                  </span>
                  <span>
                    <b>{value(current, 'destination_count') || '?'}</b> на місці
                  </span>
                  <span>
                    <b>{value(current, 'lodging_count') || '?'}</b> для житла
                  </span>
                </div>
              </article>
              <nav className="trips-tabs" aria-label="Розділи поїздки">
                {TABS.map(([id, title]) => (
                  <button
                    key={id}
                    aria-current={tab === id ? 'page' : undefined}
                    onClick={() => setTab(id)}
                  >
                    {title}
                  </button>
                ))}
              </nav>
              {tab === 'overview' && (
                <div className="trips-stack">
                  <article className="trips-card">
                    <div className="trips-card-heading">
                      <h3>{current.kind === 'draft' ? 'Збираємо план' : 'Стан подорожі'}</h3>
                      <span className="trips-tag">
                        {ws ? label(STAGES, ws.progress.stage) : 'Чернетка'}
                      </span>
                    </div>
                    {ws ? (
                      <>
                        <p className="trips-muted">Познач етап, коли він справді настав.</p>
                        <div className="trips-stage">
                          {Object.entries(STAGES).map(([key, title]) => (
                            <button
                              key={key}
                              aria-pressed={ws.progress.stage === key}
                              disabled={disabled || current.status !== 'active'}
                              onClick={() => void workspace('progress', { stage: key })}
                            >
                              {title}
                            </button>
                          ))}
                        </div>
                      </>
                    ) : (
                      <>
                        <p>
                          {current.ask?.[0]?.question ??
                            'Деталі зібрано. Можна підбирати варіанти.'}
                        </p>
                        <button disabled={disabled} onClick={() => editBrief()}>
                          Заповнити деталі
                        </button>
                      </>
                    )}
                  </article>
                  <article className="trips-card">
                    <h3>Час і важливі умови</h3>
                    <dl>
                      <div>
                        <dt>Старт</dt>
                        <dd>{value(current, 'departure_timezone') || 'Ще уточнюємо'}</dd>
                      </div>
                      <div>
                        <dt>На місці</dt>
                        <dd>{value(current, 'timezone') || 'Визначаємо за містом'}</dd>
                      </div>
                      <div>
                        <dt>Дата повернення</dt>
                        <dd>
                          {label(
                            {
                              home_arrival: 'Уже бути вдома',
                              destination_departure: 'Виїхати назад',
                              undecided: 'Ще вирішуємо',
                            },
                            value(current, 'return_meaning'),
                          ) || 'Потрібно уточнити значення'}
                        </dd>
                      </div>
                      {value(current, 'constraints') && (
                        <div>
                          <dt>Обмеження</dt>
                          <dd>{value(current, 'constraints')}</dd>
                        </div>
                      )}
                    </dl>
                    <div className="trips-actions">
                      {current.kind === 'draft' ? (
                        <button disabled={disabled} onClick={() => editBrief()}>
                          Змінити деталі
                        </button>
                      ) : (
                        <button
                          disabled={disabled || current.status !== 'active'}
                          onClick={() =>
                            edit(
                              'Змінити дати',
                              DATE_FIELDS,
                              {
                                date_from: value(current, 'date_from'),
                                date_to: value(current, 'date_to'),
                              },
                              (v) => execute({ op: 'reschedule', id: current.id, data: v }),
                            )
                          }
                        >
                          Перенести дати
                        </button>
                      )}
                      {current.kind === 'trip' && (
                        <button
                          onClick={() =>
                            void downloadTrip(current.id).catch((e) => setNotice(String(e.message)))
                          }
                        >
                          ↓ Офлайн-план
                        </button>
                      )}
                    </div>
                  </article>
                  {current.kind === 'draft' && (
                    <article className="trips-card">
                      <h3>Знайти потрібне</h3>
                      <p>
                        Дорога для тих, хто їде, житло для групи на місці та ідеї за твоїми
                        інтересами.
                      </p>
                      <button
                        className="trips-primary"
                        disabled={disabled || !current.ready_for_research || searching}
                        onClick={() => {
                          setResearchRequest({
                            until: Date.now() + 180000,
                            revision: current.research?.revision ?? 0,
                          });
                          void execute({ op: 'research', id: current.id });
                        }}
                      >
                        Підібрати варіанти
                      </button>
                      <button
                        disabled={disabled}
                        onClick={() =>
                          edit(
                            'Почати супровід',
                            [
                              {
                                key: 'support_level',
                                label: 'Режим',
                                options: {
                                  reminders: 'Підготовка й важливі строки',
                                  companion: 'Також план дня та вечірні враження',
                                },
                              },
                            ],
                            { support_level: 'companion' },
                            (v) =>
                              execute({
                                op: 'start',
                                id: current.id,
                                revision: current.revision,
                                data: { consent: true, support_level: v.support_level },
                              }),
                          )
                        }
                      >
                        Увімкнути супровід
                      </button>
                      <p className="trips-muted">
                        Створить підготовку й повідомлення для цієї поїздки. Бронювання робиш
                        самостійно.
                      </p>
                    </article>
                  )}
                  {ws && (
                    <article className="trips-card">
                      <h3>Супровід</h3>
                      <div className="trips-settings">
                        {[
                          ['paused', 'Призупинити повідомлення'],
                          ['morning', 'Ранковий план'],
                          ['evening', 'Вечірні враження'],
                        ].map(([key, title]) => (
                          <label key={key}>
                            <span>{title}</span>
                            <input
                              type="checkbox"
                              checked={Boolean(ws.preferences[key!] ?? key !== 'paused')}
                              disabled={disabled}
                              onChange={(e) =>
                                void workspace('preferences', { [key!]: e.target.checked })
                              }
                            />
                          </label>
                        ))}
                        <label>
                          <span>Додавати прогноз погоди</span>
                          <input
                            type="checkbox"
                            checked={ws.preferences.weather_share_city === true}
                            disabled={disabled || query.data?.capabilities?.weather === false}
                            onChange={(e) =>
                              void execute({
                                op: 'weather-consent',
                                id: current.id,
                                revision: ws.revision,
                                data: { enabled: e.target.checked },
                              })
                            }
                          />
                        </label>
                      </div>
                      <p className="trips-muted">
                        {query.data?.capabilities?.weather === false
                          ? 'Сервіс прогнозу зараз не підключений.'
                          : 'Після ввімкнення OpenWeather отримуватиме координати міста подорожі для прогнозу. Перевірки можна вимкнути тут.'}
                      </p>
                      <p className="trips-muted">
                        Час повідомлень — місцевий. Ранковий план близько 09:00, враження — 20:30.
                      </p>
                      {current.status === 'active' && (
                        <button
                          className="trips-danger"
                          disabled={disabled}
                          onClick={() =>
                            edit(
                              'Скасувати поїздку',
                              [
                                {
                                  key: 'confirm',
                                  label: 'Зупинити супровід і зберегти журнал?',
                                  options: {
                                    no: 'Повернутися до плану',
                                    yes: 'Так, скасувати',
                                  },
                                },
                              ],
                              { confirm: 'no' },
                              async (v) => {
                                if (v.confirm === 'yes')
                                  await execute({ op: 'cancel', id: current.id });
                                else setEditor(null);
                              },
                            )
                          }
                        >
                          Скасувати поїздку
                        </button>
                      )}
                    </article>
                  )}
                </div>
              )}
              {tab === 'options' && (
                <div className="trips-stack">
                  <button
                    disabled={
                      disabled || searching || (current.kind !== 'draft' && !current.brief_id)
                    }
                    onClick={() => {
                      setResearchRequest({
                        until: Date.now() + 180000,
                        revision: current.research?.revision ?? 0,
                      });
                      void execute({ op: 'research', id: current.id });
                    }}
                  >
                    Знайти або перевірити варіанти
                  </button>
                  {current.research?.stale && (
                    <p className="trips-notice">
                      Умови змінилися. Варіанти потрібно перевірити повторно.
                    </p>
                  )}
                  {current.research?.selection_warnings?.map((warning) => (
                    <p key={warning} className="trips-notice">
                      {warning}
                    </p>
                  ))}
                  {current.research?.summary && <p>{current.research.summary}</p>}
                  {!current.research?.options.length ? (
                    <Empty
                      title="Варіанти ще не підібрані"
                      text="Почни пошук з огляду поїздки або попроси Світанок у чаті знайти житло, квитки чи місця."
                    />
                  ) : (
                    current.research.options.map((o) => (
                      <article className="trips-card" key={o.id}>
                        <div className="trips-card-heading">
                          <span className="trips-eyebrow">{label(KINDS, o.kind)}</span>
                          <span className="trips-tag">
                            {o.stale
                              ? 'Перевірити знову'
                              : current.research?.selections?.[o.kind] === o.id
                                ? 'Обрано'
                                : 'Пропозиція'}
                          </span>
                        </div>
                        <h3>{o.title}</h3>
                        <p className="trips-price">
                          {o.price
                            ? `${o.price.amount} ${o.price.currency}`
                            : 'Ціну не підтверджено'}
                        </p>
                        {o.price && (
                          <p className="trips-muted">
                            {label(UNITS, o.price.unit)} · кількість {o.price.quantity}
                            {o.price.includes ? ` · включено: ${o.price.includes}` : ''}
                            {o.price.excludes ? ` · окремо: ${o.price.excludes}` : ''}
                          </p>
                        )}
                        {o.schedule && <p>{o.schedule}</p>}
                        {o.tradeoffs && <p>{o.tradeoffs}</p>}
                        {o.missing && <p className="trips-muted">Ще уточнити: {o.missing}</p>}
                        {o.cancellation && <p>Скасування: {o.cancellation}</p>}
                        <div className="trips-actions">
                          <a href={o.source_url} target="_blank" rel="noreferrer">
                            Джерело ↗
                          </a>
                          <button
                            disabled={
                              disabled || o.stale || (current.kind !== 'draft' && !current.brief_id)
                            }
                            onClick={() =>
                              void execute({
                                op: 'select',
                                id: current.id,
                                revision: current.research?.revision,
                                data: { option_id: o.id },
                              })
                            }
                          >
                            Обрати
                          </button>
                        </div>
                        <small>
                          Перевірено {new Date(o.checked_at).toLocaleString('uk-UA')}. Наявність
                          перед оплатою треба перевірити.
                        </small>
                      </article>
                    ))
                  )}
                </div>
              )}
              {tab === 'route' && (
                <div className="trips-stack">
                  {!ws ? (
                    <StartFirst />
                  ) : (
                    <>
                      <div className="trips-section-heading">
                        <h3>Місцевий час кожного етапу</h3>
                        <button disabled={disabled} onClick={() => editLeg()}>
                          ＋ Етап
                        </button>
                      </div>
                      {ws.warnings.map((w) => (
                        <p className="trips-error" key={w}>
                          {w}
                        </p>
                      ))}
                      {ws.itinerary_stale && (
                        <button
                          disabled={disabled}
                          onClick={() => void workspace('confirm_itinerary', { consent: true })}
                        >
                          Дати й години маршруту перевірив
                        </button>
                      )}
                      {!ws.legs.length && (
                        <Empty
                          title="Маршрут ще відкритий"
                          text="Додай квитки, заселення та заняття. Світанок перевірить накладення й запас на пересадки."
                        />
                      )}
                      {ws.legs.map((l) => (
                        <article className="trips-card trips-leg" key={l.id}>
                          <p className="trips-eyebrow">
                            {l.start.slice(0, 10)} · {l.start.slice(11)} → {l.end.slice(11)}
                          </p>
                          <h3>{l.title}</h3>
                          <p>
                            {l.from}
                            {l.from && l.to ? ' → ' : ''}
                            {l.to}
                          </p>
                          <p className="trips-muted">
                            {l.start_zone}
                            {l.end_zone !== l.start_zone ? ` → ${l.end_zone}` : ''}
                            {l.transfer_minutes ? ` · запас ${l.transfer_minutes} хв` : ''}
                          </p>
                          <div className="trips-actions">
                            <button disabled={disabled} onClick={() => editLeg(l)}>
                              Змінити
                            </button>
                            <button
                              disabled={disabled}
                              onClick={() => void workspace('remove_leg', { id: l.id })}
                            >
                              Прибрати
                            </button>
                            {l.source_url && (
                              <a href={l.source_url} target="_blank" rel="noreferrer">
                                Джерело ↗
                              </a>
                            )}
                          </div>
                        </article>
                      ))}
                      {!!ws.itinerary_versions.length && (
                        <details className="trips-card">
                          <summary>Збережені версії маршруту</summary>
                          {ws.itinerary_versions.map((v) => (
                            <button
                              key={v.revision}
                              disabled={disabled}
                              onClick={() =>
                                void workspace('restore_revision', { revision: v.revision })
                              }
                            >
                              Відновити {new Date(v.at).toLocaleString('uk-UA')}
                            </button>
                          ))}
                        </details>
                      )}
                    </>
                  )}
                </div>
              )}
              {tab === 'tasks' && (
                <div className="trips-stack">
                  {!ws ? (
                    <StartFirst />
                  ) : (
                    <>
                      <div className="trips-section-heading">
                        <h3>
                          {ws.tasks.filter((t) => t.status === 'done').length} / {ws.tasks.length}{' '}
                          справ
                        </h3>
                        <button disabled={disabled} onClick={addTask}>
                          ＋ Справа
                        </button>
                      </div>
                      <article className="trips-card trips-task-list">
                        {ws.tasks.map((t) => (
                          <div className="trips-task" key={t.id}>
                            <input
                              type="checkbox"
                              aria-label={t.title}
                              checked={t.status === 'done'}
                              disabled={disabled}
                              onChange={(e) =>
                                void workspace('task', {
                                  id: t.id,
                                  status: e.target.checked ? 'done' : 'open',
                                })
                              }
                            />
                            <div>
                              <strong>{t.title}</strong>
                              {t.due_at && (
                                <small>
                                  До{' '}
                                  {new Date(t.due_at).toLocaleString('uk-UA', { timeZone: zone })} ·{' '}
                                  {zone}
                                </small>
                              )}
                              {t.note && <p>{t.note}</p>}
                              <button
                                disabled={disabled}
                                onClick={() =>
                                  edit(
                                    'Змінити справу',
                                    [
                                      { key: 'title', label: 'Назва', required: true },
                                      {
                                        key: 'status',
                                        label: 'Стан',
                                        options: {
                                          open: 'Зробити',
                                          done: 'Готово',
                                          later: 'Пізніше',
                                          not_needed: 'Не потрібно',
                                        },
                                      },
                                      {
                                        key: 'due_at',
                                        label: `Строк · ${zone}`,
                                        type: 'datetime-local',
                                      },
                                      { key: 'note', label: 'Деталі', type: 'textarea' },
                                    ],
                                    {
                                      title: t.title,
                                      status: t.status,
                                      due_at: localIso(t.due_at),
                                      note: t.note ?? '',
                                    },
                                    (v) =>
                                      workspace('task', {
                                        ...v,
                                        id: t.id,
                                        due_at: instant(v.due_at ?? ''),
                                      }),
                                  )
                                }
                              >
                                Змінити
                              </button>
                            </div>
                          </div>
                        ))}
                      </article>
                      <div className="trips-section-heading">
                        <h3>Бронювання й строки</h3>
                        <button disabled={disabled} onClick={() => editBooking()}>
                          ＋ Запис
                        </button>
                      </div>
                      {!ws.bookings.length && (
                        <p className="trips-muted">
                          Після оплати додай підтвердження й строк скасування. Світанок нагадає про
                          наближення строку.
                        </p>
                      )}
                      {ws.bookings.map((b) => (
                        <article className="trips-card" key={b.id}>
                          <span className="trips-tag">{label(BOOKING, b.status)}</span>
                          <h3>{b.title}</h3>
                          {b.cancel_by && (
                            <p>
                              Скасування до{' '}
                              {new Date(b.cancel_by).toLocaleString('uk-UA', { timeZone: zone })}
                            </p>
                          )}
                          <div className="trips-actions">
                            <button disabled={disabled} onClick={() => editBooking(b)}>
                              Змінити запис
                            </button>
                            {b.source_url && (
                              <a href={b.source_url} target="_blank" rel="noreferrer">
                                До провайдера ↗
                              </a>
                            )}
                          </div>
                        </article>
                      ))}
                    </>
                  )}
                </div>
              )}
              {tab === 'money' && (
                <div className="trips-stack">
                  {!ws || !ledger ? (
                    <StartFirst />
                  ) : (
                    <>
                      <div className="trips-section-heading">
                        <h3>Фактично записано</h3>
                        <button disabled={disabled} onClick={() => addExpense()}>
                          ＋ Запис
                        </button>
                      </div>
                      <article className="trips-card">
                        <div className="trips-money-totals">
                          {Object.entries(ledger.totals_minor_by_currency).map(([currency, n]) => (
                            <strong key={currency}>{money(n, currency)}</strong>
                          ))}
                          {!Object.keys(ledger.totals_minor_by_currency).length && (
                            <p>Витрат ще не записували.</p>
                          )}
                        </div>
                        <p className="trips-muted">
                          Кошторис і банківські операції не додаються автоматично. Кожна валюта
                          рахується окремо.
                        </p>
                        {Object.entries(ledger.pending_deposits_minor_by_currency ?? {})
                          .filter(([, n]) => n > 0)
                          .map(([c, n]) => (
                            <p key={c}>Очікує повернення застави: {money(n, c)}</p>
                          ))}
                        <button
                          disabled={disabled}
                          onClick={() =>
                            edit(
                              'Учасники спільних витрат',
                              [
                                {
                                  key: 'names',
                                  label: 'Одне ім’я на рядок. Себе познач «Я».',
                                  type: 'textarea',
                                  required: true,
                                },
                              ],
                              { names: ws.party.map((p) => p.label).join('\n') || 'Я' },
                              async (v) => {
                                const members = (v.names ?? '')
                                  .split('\n')
                                  .map((s) => s.trim())
                                  .filter(Boolean)
                                  .map((name) => ({
                                    id:
                                      name === 'Я'
                                        ? 'owner'
                                        : (ws.party.find((p) => p.label === name)?.id ??
                                          crypto.randomUUID()),
                                    label: name,
                                    count: 1,
                                  }));
                                await workspace('party', { members });
                              },
                            )
                          }
                        >
                          Учасники й розподіл
                        </button>
                      </article>
                      {ledger.suggested_settlement?.length ? (
                        <article className="trips-card">
                          <h3>Як розрахуватися</h3>
                          {ledger.suggested_settlement.map((s, i) => (
                            <p key={i}>
                              {party[s.from] ?? s.from} → {party[s.to] ?? s.to} ·{' '}
                              {money(s.minor, s.currency)}
                            </p>
                          ))}
                          <p className="trips-muted">
                            Розрахунок лише за записами, де названо учасників і частки. Переказів
                            Світанок не робить.
                          </p>
                        </article>
                      ) : null}
                      {ledger.entries.map((e) => (
                        <article className="trips-card trips-expense" key={e.id}>
                          <div>
                            <h3>
                              {e.note ||
                                label(
                                  {
                                    expense: 'Витрата',
                                    refund: 'Повернення',
                                    deposit: 'Застава',
                                    settlement: 'Розрахунок',
                                  },
                                  e.kind ?? 'expense',
                                )}
                            </h3>
                            <small>
                              {party[e.paid_by ?? 'owner'] ?? 'Учасник'} ·{' '}
                              {label(
                                {
                                  expense: 'Витрата',
                                  refund: 'Повернення коштів',
                                  deposit: 'Застава',
                                  settlement: 'Між учасниками',
                                },
                                e.kind ?? 'expense',
                              )}
                            </small>
                          </div>
                          <strong>
                            {e.kind === 'refund' ? '−' : ''}
                            {money(e.minor, e.currency)}
                          </strong>
                          {['expense', 'deposit'].includes(e.kind ?? 'expense') && (
                            <button disabled={disabled} onClick={() => addExpense('refund', e.id)}>
                              Повернення
                            </button>
                          )}
                        </article>
                      ))}
                    </>
                  )}
                </div>
              )}
              {tab === 'journal' && (
                <div className="trips-stack">
                  {!ws ? (
                    <StartFirst />
                  ) : (
                    <>
                      <div className="trips-section-heading">
                        <h3>Місця й враження</h3>
                        <button
                          disabled={disabled}
                          onClick={() =>
                            edit(
                              'Враження дня',
                              [
                                { key: 'date', label: 'День', type: 'date', required: true },
                                {
                                  key: 'note',
                                  label: 'Що запам’яталося',
                                  type: 'textarea',
                                  required: true,
                                },
                                {
                                  key: 'unfinished',
                                  label: 'Що залишити на потім',
                                  type: 'textarea',
                                },
                              ],
                              { date: value(current, 'date_from') },
                              (v) => workspace('review', v),
                            )
                          }
                        >
                          ＋ Враження
                        </button>
                      </div>
                      <button
                        disabled={disabled}
                        onClick={() => {
                          const id = crypto.randomUUID();
                          edit(
                            'Зберегти місце',
                            [
                              { key: 'title', label: 'Назва', required: true },
                              { key: 'url', label: 'Посилання', type: 'url' },
                              {
                                key: 'status',
                                label: 'Стан',
                                options: {
                                  saved: 'Хочу відвідати',
                                  visited: 'Відвідано',
                                  favorite: 'Улюблене',
                                  skipped: 'Пропустили',
                                },
                              },
                              { key: 'note', label: 'Нотатка', type: 'textarea' },
                            ],
                            { status: 'saved' },
                            (v) => workspace('place', { ...v, id }),
                          );
                        }}
                      >
                        ＋ Місце
                      </button>
                      {ws.places.map((p) => (
                        <article className="trips-card" key={p.id}>
                          <h3>{p.title}</h3>
                          <p>{p.note}</p>
                          <div className="trips-actions">
                            <span className="trips-tag">
                              {label(
                                {
                                  saved: 'У планах',
                                  visited: 'Відвідано',
                                  favorite: 'Улюблене',
                                  skipped: 'Пропущено',
                                },
                                p.status,
                              )}
                            </span>
                            {p.status !== 'visited' && (
                              <button
                                disabled={disabled}
                                onClick={() =>
                                  void workspace('place', { id: p.id, status: 'visited' })
                                }
                              >
                                Відвідали
                              </button>
                            )}
                            {p.url && (
                              <a href={p.url} target="_blank" rel="noreferrer">
                                Джерело ↗
                              </a>
                            )}
                          </div>
                        </article>
                      ))}
                      {ws.reviews.map((r) => (
                        <article className="trips-card" key={r.date}>
                          <p className="trips-eyebrow">{r.date}</p>
                          <p>{r.note}</p>
                          {r.unfinished && <p>Залишилося: {r.unfinished}</p>}
                        </article>
                      ))}
                      <details className="trips-card">
                        <summary>Історія змін</summary>
                        {ws.history.map((h) => (
                          <p key={h.revision}>
                            {new Date(h.at).toLocaleString('uk-UA')} ·{' '}
                            {label(
                              {
                                leg: 'Змінено маршрут',
                                remove_leg: 'Прибрано етап',
                                task: 'Оновлено справу',
                                booking: 'Оновлено бронювання',
                                progress: 'Змінено етап подорожі',
                                party: 'Оновлено учасників',
                                preferences: 'Змінено супровід',
                                review: 'Збережено враження',
                                place: 'Оновлено місце',
                              },
                              h.op,
                            )}
                          </p>
                        ))}
                      </details>
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </>
      )}
      {editor && (
        <Sheet label={editor.title} onClose={() => !busy && setEditor(null)}>
          <TravelEditor
            key={editor.title + JSON.stringify(editor.values)}
            editor={editor}
            disabled={disabled}
            busy={busy}
            externalError={mutation.error?.message}
            onRefresh={() => {
              setEditor(null);
              void query.refetch().then((r) => {
                if (r.isSuccess) setUncertain(false);
              });
            }}
            onClose={() => setEditor(null)}
          />
        </Sheet>
      )}
    </section>
  );
}
function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="trips-empty">
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}
function StartFirst() {
  return (
    <Empty
      title="Спочатку збережи обраний план"
      text="Після вибору дороги й умов увімкни супровід в огляді. Тут з’являться маршрут, справи й журнал цієї поїздки."
    />
  );
}
function TravelEditor({
  editor,
  disabled,
  busy,
  onClose,
  externalError,
  onRefresh,
}: {
  editor: Editor;
  disabled: boolean;
  busy: boolean;
  onClose: () => void;
  externalError?: string;
  onRefresh: () => void;
}) {
  const [values, setValues] = useState(editor.values),
    [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await editor.save(values);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Перевір значення.');
    }
  };
  return (
    <form className="trips-editor" onSubmit={(e) => void submit(e)}>
      <div className="trips-card-heading">
        <h2>{editor.title}</h2>
        <button type="button" disabled={busy} onClick={onClose} aria-label="Закрити">
          ×
        </button>
      </div>
      {editor.fields.map((f) => (
        <div className="trips-editor-field" key={f.key}>
          <label htmlFor={`trip-field-${f.key}`}>{f.label}</label>
          {f.type === 'people' ? (
            <div className="trips-people">
              {Object.entries(f.options ?? {}).map(([key, title]) => (
                <label key={key}>
                  <input
                    type="checkbox"
                    checked={(values[f.key] ?? '').split(',').includes(key)}
                    onChange={(e) =>
                      setValues((old) => {
                        const selected = new Set((old[f.key] ?? '').split(',').filter(Boolean));
                        if (e.target.checked) selected.add(key);
                        else selected.delete(key);
                        return { ...old, [f.key]: [...selected].join(',') };
                      })
                    }
                  />
                  {title}
                </label>
              ))}
            </div>
          ) : f.options ? (
            <select
              id={`trip-field-${f.key}`}
              value={values[f.key] ?? ''}
              required={f.required}
              onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
            >
              <option value="">Обрати…</option>
              {Object.entries(f.options).map(([key, title]) => (
                <option key={key} value={key}>
                  {title}
                </option>
              ))}
            </select>
          ) : f.type === 'textarea' ? (
            <textarea
              id={`trip-field-${f.key}`}
              rows={3}
              maxLength={500}
              value={values[f.key] ?? ''}
              required={f.required}
              onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
            />
          ) : (
            <input
              id={`trip-field-${f.key}`}
              type={f.type ?? 'text'}
              step={f.type === 'number' ? '0.01' : undefined}
              min={f.type === 'number' ? 0 : undefined}
              maxLength={300}
              required={f.required}
              value={values[f.key] ?? ''}
              onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
            />
          )}
        </div>
      ))}
      {(error || externalError) && (
        <div className="trips-error" role="alert">
          <p>{error || externalError}</p>
          {externalError && (
            <button type="button" onClick={onRefresh}>
              Оновити й перевірити результат
            </button>
          )}
        </div>
      )}
      <button className="trips-primary" disabled={disabled} type="submit">
        {busy ? 'Зберігаю…' : 'Зберегти'}
      </button>
      <p className="trips-muted">Зміни збережуться також для асистента в чаті.</p>
    </form>
  );
}
