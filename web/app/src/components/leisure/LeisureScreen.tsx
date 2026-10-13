import { PlaceInfo } from './PlaceInfo.tsx';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Sheet } from '../ui/Sheet.tsx';
import { GlassCard } from '../ui/primitives.tsx';
import { SessionExpired } from '../ui/SessionExpired.tsx';
import { isSessionExpired } from '../../api/client.ts';
import { inTelegram, openLink, haptic, setVerticalSwipes } from '../../telegram.ts';
import {
  useLeisure,
  useLeisureChange,
  categoryLabels,
  pairPrice,
  money,
  leisureDate,
  leisureTime,
  toKyivInput,
  fetchLeisure,
  LEISURE_QUERY,
  type LeisureItem,
  type LeisurePlan,
  type LeisureVisit,
  type LeisureWorkspace,
  type LeisureReceipt,
} from '../../api/leisure.ts';
import { PlanBuilder } from './PlanBuilder.tsx';
import { LeisureFeedback, PreviousVisits } from './LeisureFeedback.tsx';
import './leisure.css';

type Dialog = {
  type: 'detail' | 'familiarity' | 'plan' | 'visit' | 'settings' | 'plans' | 'sources';
  itemId?: string;
  planId?: string;
  visitId?: string;
  sessionId?: string;
};
type Send = (op: string, payload: Record<string, unknown>, id?: string) => Promise<LeisureReceipt>;
const CATEGORY_GROUPS = [
  ['all', 'Усе'],
  ['cinema', 'Кіно'],
  ['events', 'Події'],
  ['food', 'Заклади'],
  ['trip', 'Поїздки'],
] as const;
const fire = (promise: Promise<unknown>) => {
  void promise.catch(() => {});
};
function Icon({ kind, className = '' }: { kind: string; className?: string }) {
  return (
    <svg
      className={`leisure-icon ${className}`}
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === 'save' ? (
        <path d="M6 3h12v18l-6-4-6 4Z" />
      ) : kind === 'cinema' ? (
        <>
          <rect x="3" y="7" width="18" height="14" rx="2" />
          <path d="m3 7 18-4M6 5l3 3M13 4l3 3M3 12h18" />
        </>
      ) : kind === 'food' ? (
        <>
          <path d="M5 3v7c0 3 5 3 5 0V3M7.5 3v18M18 3v18M18 3c-4 0-4 10 0 10" />
        </>
      ) : kind === 'settings' ? (
        <>
          <path d="M3 7h18M3 17h18" />
          <circle cx="8" cy="7" r="2" />
          <circle cx="16" cy="17" r="2" />
        </>
      ) : kind === 'route' ? (
        <>
          <circle cx="5" cy="5" r="2" />
          <circle cx="19" cy="19" r="2" />
          <path d="M7 5h8a4 4 0 0 1 0 8H9a4 4 0 0 0 0 6h8" />
        </>
      ) : kind === 'calendar' ? (
        <>
          <rect x="3" y="5" width="18" height="16" rx="3" />
          <path d="M8 3v5M16 3v5M3 10h18" />
        </>
      ) : kind === 'pin' ? (
        <>
          <path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z" />
          <circle cx="12" cy="10" r="2" />
        </>
      ) : kind === 'search' ? (
        <>
          <circle cx="10" cy="10" r="6" />
          <path d="m15 15 5 5" />
        </>
      ) : kind === 'back' ? (
        <path d="m14 5-7 7 7 7" />
      ) : (
        <>
          <path d="m7 17 10-10M7 7h10v10" />
        </>
      )}
    </svg>
  );
}
function Button({
  children,
  onClick,
  disabled,
  primary = false,
  type = 'button',
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  primary?: boolean;
  type?: 'button' | 'submit';
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`leisure-button${primary ? ' is-primary' : ''}`}
    >
      {children}
    </button>
  );
}
function Pill({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={`leisure-pill${active ? ' is-active' : ''}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
function maps(item: { title?: string; address?: string | null; placeId?: string | null }) {
  const url = new URL('https://www.google.com/maps/search/');
  url.searchParams.set('api', '1');
  url.searchParams.set('query', item.address ?? item.title ?? 'Львів');
  if (item.placeId) url.searchParams.set('query_place_id', item.placeId);
  openLink(url.href);
}
function route(plan: LeisurePlan) {
  const stops = plan.stops.filter((s) => s.address);
  if (!stops.length) return;
  const url = new URL('https://www.google.com/maps/dir/');
  url.searchParams.set('api', '1');
  url.searchParams.set('destination', stops.at(-1)!.address!);
  url.searchParams.set('travelmode', 'driving');
  if (stops.length > 1) {
    url.searchParams.set('origin', stops[0]!.address!);
    if (stops.length > 2)
      url.searchParams.set(
        'waypoints',
        stops
          .slice(1, -1)
          .map((s) => s.address)
          .join('|'),
      );
  }
  openLink(url.href);
}
function priceLabel(item: LeisureItem) {
  const value = pairPrice(item);
  if (value === 0) return 'Безплатно';
  return value == null ? 'Ціну не підтверджено' : `Від ${money(value)} за двох`;
}
function dateLabel(item: LeisureItem) {
  if (!item.startDate) return 'Можна обрати день';
  if (
    item.endDate &&
    item.endDate !== item.startDate &&
    item.startDate <= toKyivInput(new Date().toISOString()).slice(0, 10)
  )
    return `Триває до ${leisureDate(item.endDate)}`;
  if (item.endDate && item.endDate !== item.startDate)
    return `${leisureDate(item.startDate)} — ${leisureDate(item.endDate)}`;
  return `${leisureDate(item.startDate)}${item.startAt ? ` · ${leisureTime(item.startAt)}` : ''}`;
}
function calendarLabel(plan: LeisurePlan) {
  return {
    none: 'Без календарного запису',
    pending: 'Синхронізується з календарем',
    'delete-pending': 'Прибирається з календаря',
    error: 'Не вдалося синхронізувати — повтори',
    synced: 'Додано в Google Calendar',
    conflict: 'Календар змінився вручну — потрібна перевірка',
  }[plan.calendarState];
}

function ItemCard({
  item,
  rank,
  reasons,
  known,
  saved,
  busy,
  onOpen,
  onSave,
}: {
  item: LeisureItem;
  rank?: number;
  reasons?: string[];
  known?: NonNullable<LeisureWorkspace['edition']>['rankings'][number]['known'];
  saved: boolean;
  busy: boolean;
  onOpen: () => void;
  onSave: () => void;
}) {
  return (
    <GlassCard className="leisure-item">
      <div className="leisure-item-head">
        <div className="leisure-art">
          <Icon
            kind={item.category === 'cinema' ? 'cinema' : item.category === 'food' ? 'food' : 'pin'}
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="leisure-caption">
            {categoryLabels[item.category]}
            {rank && <span className="leisure-rank"> · №{rank}</span>}
          </div>
          <h3>{item.title}</h3>
          <p className="leisure-secondary">{item.venue ?? item.address ?? dateLabel(item)}</p>
        </div>
        <button
          type="button"
          className={`leisure-icon-button${saved ? ' is-saved' : ''}`}
          aria-label={saved ? `Прибрати ${item.title} зі збереженого` : `Зберегти ${item.title}`}
          aria-pressed={saved}
          disabled={busy}
          onClick={onSave}
        >
          <Icon kind="save" />
        </button>
      </div>
      {known?.familiar && (
        <p className="leisure-known">
          ★{' '}
          {known.frequent
            ? 'Бували багато разів'
            : known.previousCount != null
              ? `До обліку: ${known.previousCount}`
              : 'Знайоме місце'}{' '}
          · записано: {known.trackedCount}
        </p>
      )}
      {!!reasons?.length && (
        <p className="leisure-secondary leisure-ranking-reason">{reasons[0]}</p>
      )}
      <div className="leisure-item-bottom">
        <div>
          <strong>{priceLabel(item)}</strong>
          <p className="leisure-secondary">
            {item.registration
              ? 'Потрібна реєстрація'
              : item.status === 'schedule-pending'
                ? 'Сеанси ще не підтверджені'
                : dateLabel(item)}
          </p>
        </div>
        <button type="button" className="leisure-text-button" onClick={onOpen}>
          Деталі <Icon kind="open" />
        </button>
      </div>
    </GlassCard>
  );
}

export function LeisureScreen() {
  useEffect(() => {
    setVerticalSwipes(false);
    return () => setVerticalSwipes(true);
  }, []);
  const cache = useQueryClient();
  const query = useLeisure(),
    change = useLeisureChange(),
    [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<'feed' | 'saved' | 'visited'>('feed'),
    [category, setCategory] = useState('all'),
    [subCategory, setSubCategory] = useState('all'),
    [search, setSearch] = useState(''),
    [searchOpen, setSearchOpen] = useState(false),
    [shown, setShown] = useState(8),
    [day, setDay] = useState(''),
    [notice, setNotice] = useState(''),
    [genre, setGenre] = useState(''),
    [futureShown, setFutureShown] = useState(4),
    [undoReaction, setUndoReaction] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(() =>
    params.get('action') === 'settings'
      ? { type: 'settings' }
      : params.get('item')
        ? { type: 'detail', itemId: params.get('item')! }
        : null,
  );
  const pending = useRef<{ signature: string; commandId: string } | null>(null);
  const send = useCallback<Send>(
    async (op, payload, id) => {
      const signature = JSON.stringify({ op, id, payload });
      if (pending.current?.signature !== signature)
        pending.current = { signature, commandId: crypto.randomUUID() };
      const result = await change.mutateAsync({
        op,
        id,
        payload,
        commandId: pending.current.commandId,
      });
      pending.current = null;
      setNotice(result.receipt.message);
      if (op === 'reaction')
        setUndoReaction(
          payload.verdict === 'uninterested' || payload.verdict === 'later' ? (id ?? null) : null,
        );
      haptic('success');
      return result.receipt;
    },
    [change],
  );
  const close = () => {
    setDialog(null);
    if (params.has('item') || params.get('action') === 'settings') {
      params.delete('item');
      params.delete('action');
      setParams(params, { replace: true });
    }
  };
  const data = query.data;
  const plans = useMemo(
    () =>
      data?.records
        .filter((r) => r.kind === 'plan')
        .sort((a, b) => a.startAt.localeCompare(b.startAt)) ?? [],
    [data],
  );
  const visits = useMemo(() => data?.records.filter((r) => r.kind === 'visit') ?? [], [data]);
  if (isSessionExpired(query.error) || isSessionExpired(change.error)) return <SessionExpired />;
  if (!data)
    return (
      <div className="leisure-screen">
        <h1>Дозвілля</h1>
        <p className="leisure-secondary">
          {query.isPending
            ? 'Завантажую добірку…'
            : (query.error?.message ?? 'Дозвілля поки недоступне.')}
        </p>
        {query.isError && <Button onClick={() => void query.refetch()}>Спробувати знову</Button>}
      </div>
    );
  const itemById = new Map(data.items.map((i) => [i.id, i]));
  const upcoming = plans.find(
    (p) => p.status === 'planned' && Date.parse(p.endAt) >= Date.parse(data.generatedAt),
  );
  const pendingReview = plans.filter(
    (p) => p.status === 'planned' && Date.parse(p.endAt) < Date.parse(data.generatedAt),
  );
  const hidden = new Set(
    data.records
      .filter((r) => r.kind === 'reaction')
      .filter(
        (r) =>
          r.verdict === 'uninterested' ||
          (r.verdict === 'later' &&
            r.at &&
            toKyivInput(r.at).slice(0, 10) >= (data.edition?.week ?? '')),
      )
      .map((r) => r.itemId),
  );
  const baseIds =
    tab === 'saved'
      ? data.saved
      : tab === 'visited'
        ? [
            ...new Set([
              ...visits.map((v) => v.itemId),
              ...data.records.flatMap((r) =>
                r.kind === 'familiarity' && !r.cleared ? [r.itemId] : [],
              ),
            ]),
          ]
        : (data.edition?.ids ?? []);
  const candidates = baseIds
    .map((id) => itemById.get(id))
    .filter((i): i is LeisureItem => !!i)
    .filter(
      (i) =>
        (tab !== 'feed' || !hidden.has(i.id)) &&
        (category === 'all' ||
          (category === 'events'
            ? ['exhibition', 'festival', 'concert', 'show'].includes(i.category)
            : i.category === category)) &&
        (!genre || i.genre.toLocaleLowerCase('uk').includes(genre.toLocaleLowerCase('uk'))) &&
        (subCategory === 'all' || category !== 'events' || i.category === subCategory) &&
        (!search ||
          `${i.title} ${i.venue ?? ''} ${i.address ?? ''}`
            .toLocaleLowerCase('uk')
            .includes(search.toLocaleLowerCase('uk'))) &&
        (!day || ((!i.startDate || i.startDate <= day) && (!i.endDate || i.endDate >= day))),
    );
  const selectedItem = dialog?.itemId ? itemById.get(dialog.itemId) : null,
    selectedPlan = dialog?.planId ? plans.find((p) => p.id === dialog.planId) : undefined;
  return (
    <div className="leisure-screen">
      <div className="leisure-heading">
        <div>
          <h1>Дозвілля</h1>
          <p className="leisure-secondary">Для ваших вечорів і вихідних.</p>
        </div>
        <button
          type="button"
          className="leisure-icon-button"
          aria-label="Налаштування дозвілля"
          onClick={() => setDialog({ type: 'settings' })}
        >
          <Icon kind="settings" />
        </button>
      </div>
      {!inTelegram() && <p className="leisure-demo">Демо: дії не змінюють сервер і календар.</p>}
      {upcoming ? (
        <GlassCard className="leisure-next-plan">
          <div className="leisure-caption">Ваш найближчий план</div>
          <h2>{upcoming.title}</h2>
          <p>
            {leisureDate(upcoming.startAt)} · {leisureTime(upcoming.startAt)}
          </p>
          <p className="leisure-secondary">{upcoming.stops.map((s) => s.title).join(' → ')}</p>
          <p className="leisure-secondary">{calendarLabel(upcoming)}</p>
          <div className="leisure-actions">
            <Button primary onClick={() => setDialog({ type: 'plans', planId: upcoming.id })}>
              Переглянути план
            </Button>
            <Button
              onClick={() => route(upcoming)}
              disabled={!upcoming.stops.some((s) => s.address)}
            >
              <Icon kind="route" />
              Маршрут
            </Button>
          </div>
        </GlassCard>
      ) : (
        <button
          type="button"
          className="leisure-button leisure-create-plan"
          onClick={() => setDialog({ type: 'plan' })}
        >
          + Скласти план із кількох місць
        </button>
      )}
      {plans.length > 0 && (
        <button
          type="button"
          className="leisure-text-button leisure-all-plans"
          onClick={() => setDialog({ type: 'plans' })}
        >
          Усі плани та минулі виходи ({plans.length})
        </button>
      )}
      {pendingReview.length > 0 && (
        <GlassCard className="leisure-review">
          <h3>Як пройшов вихід?</h3>
          <p className="leisure-secondary">
            {pendingReview[0]!.title} · {leisureDate(pendingReview[0]!.startAt)}
          </p>
          <div className="leisure-actions">
            <Button onClick={() => setDialog({ type: 'plans', planId: pendingReview[0]!.id })}>
              Були / не пішли / перенесли
            </Button>
          </div>
        </GlassCard>
      )}
      <div className="leisure-tabs">
        {(
          [
            ['feed', 'Для вас'],
            ['saved', `Збережене${data.saved.length ? ` · ${data.saved.length}` : ''}`],
            ['visited', 'Ваші місця'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={tab === id}
            onClick={() => {
              setTab(id);
              setShown(8);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="leisure-heading">
        <div>
          <h2>
            {tab === 'feed' ? 'Рейтинг для вас' : tab === 'saved' ? 'Розглядаємо' : 'Ваші місця'}
          </h2>
          <button
            type="button"
            className="leisure-text-button"
            onClick={() => setSearchOpen((v) => !v)}
          >
            {data.edition
              ? `${leisureDate(data.edition.week)} — ${leisureDate(data.edition.until)}`
              : 'Добірка ще не зібрана'}
          </button>
        </div>
        <button
          type="button"
          className="leisure-icon-button"
          aria-label="Пошук і вибір дня"
          onClick={() => setSearchOpen((v) => !v)}
        >
          <Icon kind="search" />
        </button>
      </div>
      {searchOpen && (
        <div className="leisure-fields">
          <label>
            Пошук
            <input
              type="search"
              placeholder="Подія, фільм або заклад"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setShown(8);
              }}
            />
          </label>
          <label>
            На конкретний день
            <input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
          </label>
          {day && <Button onClick={() => setDay('')}>Увесь тиждень</Button>}
        </div>
      )}
      <div className="leisure-pills">
        {CATEGORY_GROUPS.map(([id, label]) => (
          <Pill
            key={id}
            active={category === id}
            onClick={() => {
              setCategory(id);
              setSubCategory('all');
              setGenre('');
              setShown(8);
            }}
          >
            {label}
            <span aria-hidden="true" className="leisure-count">
              {
                baseIds
                  .map((id) => itemById.get(id))
                  .filter(
                    (i) =>
                      i &&
                      (id === 'all' ||
                        (id === 'events'
                          ? ['exhibition', 'festival', 'concert', 'show'].includes(i.category)
                          : i.category === id)),
                  ).length
              }
            </span>
          </Pill>
        ))}
      </div>
      {category === 'cinema' && (
        <label className="leisure-field">
          Жанр · фільтр каталогу
          <select
            value={genre}
            onChange={(e) => {
              setGenre(e.target.value);
              setShown(8);
            }}
          >
            <option value="">Усі жанри</option>
            {[
              ...new Set(
                data.items
                  .filter((i) => i.category === 'cinema')
                  .flatMap((i) =>
                    i.genre
                      .split(/[,/;|]/)
                      .map((g) => g.trim())
                      .filter(Boolean),
                  ),
              ),
            ]
              .sort((a, b) => a.localeCompare(b, 'uk'))
              .map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
          </select>
        </label>
      )}
      {category === 'events' && (
        <div className="leisure-pills">
          <Pill active={subCategory === 'all'} onClick={() => setSubCategory('all')}>
            Усі події
          </Pill>
          {(['exhibition', 'festival', 'concert', 'show'] as const).map((c) => (
            <Pill key={c} active={subCategory === c} onClick={() => setSubCategory(c)}>
              {categoryLabels[c]}
            </Pill>
          ))}
        </div>
      )}
      {data.edition?.stale && (
        <p className="leisure-notice">
          Це попередня добірка. Онови її, щоб перевірити актуальні варіанти.
        </p>
      )}
      {tab === 'feed' && (
        <p className="leisure-secondary">
          Варіантів: {candidates.length} · твоїх оцінок: {data.edition?.profileSignals ?? 0}
        </p>
      )}
      {data.refresh?.active && (
        <p role="status" className="leisure-notice">
          Каталог оновлюється у фоні · {data.refresh.done}/{data.refresh.total} джерел і напрямків
          перевірено.
        </p>
      )}
      <div className="leisure-list">
        {candidates.slice(0, shown).map((item, index) => (
          <ItemCard
            key={item.id}
            item={item}
            rank={tab === 'feed' ? index + 1 : undefined}
            reasons={data.edition?.rankings.find((r) => r.id === item.id)?.reasons}
            known={
              data.knownPlaces[item.id] ??
              data.edition?.rankings.find((r) => r.id === item.id)?.known
            }
            saved={data.saved.includes(item.id)}
            busy={change.isPending}
            onOpen={() => setDialog({ type: 'detail', itemId: item.id })}
            onSave={() => fire(send('save', { saved: !data.saved.includes(item.id) }, item.id))}
          />
        ))}
      </div>
      {!candidates.length && (
        <GlassCard className="leisure-empty">
          <h3>
            {tab === 'saved'
              ? 'Поки нічого не збережено'
              : tab === 'visited'
                ? 'Тут будуть ваші місця'
                : 'За цим вибором немає нових варіантів'}
          </h3>
          <p className="leisure-secondary">
            {tab === 'visited'
              ? 'Познач попередній досвід або запиши відвідування в деталях. Повторний похід збережеться окремо.'
              : tab === 'saved'
                ? 'Додай закладку до варіанта, щоб повернутися пізніше.'
                : 'Можна змінити категорію або оновити джерела. Знайомі місця залишаються у своїх списках.'}
          </p>
        </GlassCard>
      )}
      {candidates.length > shown && (
        <Button onClick={() => setShown((n) => n + 8)}>
          Ще варіанти ({candidates.length - shown})
        </Button>
      )}
      {tab === 'visited' && visits.length > 0 && (
        <div className="leisure-history">
          <h2>Історія відвідувань</h2>
          {visits.map((v) => (
            <div key={v.id}>
              <strong>{v.title}</strong>
              <p className="leisure-secondary">
                {v.visitedOn ? leisureDate(v.visitedOn) : 'Минула дата невідома'} ·{' '}
                {v.rating === 'liked'
                  ? 'Сподобалось'
                  : v.rating === 'disliked'
                    ? 'Не сподобалось'
                    : v.rating === 'neutral'
                      ? 'Нормально'
                      : 'Без оцінки'}
              </p>
              {v.reason && <p>{v.reason}</p>}
              <button
                type="button"
                className="leisure-text-button"
                onClick={() => setDialog({ type: 'visit', itemId: v.itemId, visitId: v.id })}
              >
                Уточнити враження
              </button>
            </div>
          ))}
        </div>
      )}
      {tab === 'feed' && !!data.edition?.futureIds.length && (
        <div className="leisure-future">
          {data.edition.futureIds.length > futureShown && (
            <Button onClick={() => setFutureShown((n) => n + 8)}>
              Ще майбутні події ({data.edition.futureIds.length - futureShown})
            </Button>
          )}
          <h2>Варто запланувати пізніше</h2>
          {data.edition.futureIds
            .slice(0, futureShown)
            .map((id) => itemById.get(id))
            .filter((i): i is LeisureItem => !!i)
            .map((i) => (
              <button
                key={i.id}
                type="button"
                onClick={() => setDialog({ type: 'detail', itemId: i.id })}
              >
                <span>
                  {i.title}
                  <small>
                    {dateLabel(i)} · {priceLabel(i)}
                  </small>
                </span>
                <Icon kind="open" />
              </button>
            ))}
        </div>
      )}
      <div className="leisure-actions">
        <Button disabled={change.isPending} onClick={() => fire(send('refresh', {}))}>
          {change.isPending ? 'Зберігаю або оновлюю…' : 'Оновити добірку'}
        </Button>
        <Button onClick={() => setDialog({ type: 'sources' })}>Джерела</Button>
      </div>
      {data.historyTotal > data.records.length && (
        <Button
          onClick={() =>
            fire(fetchLeisure(true).then((all) => cache.setQueryData(LEISURE_QUERY, all)))
          }
        >
          Завантажити всю історію ({data.historyTotal})
        </Button>
      )}
      <p className="leisure-secondary leisure-footer-note">
        Понеділок · 08:00. Кіно доповнюється після публікації розкладу. Без Telegram-розсилки.
      </p>
      {notice && (
        <p role="status" className="leisure-notice">
          {notice}
          {undoReaction && (
            <button
              type="button"
              className="leisure-text-button"
              disabled={change.isPending}
              onClick={() => fire(send('reaction', { verdict: 'clear' }, undoReaction))}
            >
              Повернути прихований варіант
            </button>
          )}
        </p>
      )}
      {change.error && (
        <p role="alert" className="leisure-error">
          {change.error.message}
        </p>
      )}
      {dialog && (
        <Sheet
          label={
            dialog.type === 'detail'
              ? 'Деталі варіанта'
              : dialog.type === 'plan'
                ? 'План дозвілля'
                : dialog.type === 'visit'
                  ? 'Відвідування й враження'
                  : dialog.type === 'settings'
                    ? 'Налаштування дозвілля'
                    : dialog.type === 'plans'
                      ? 'Ваші плани'
                      : 'Джерела добірки'
          }
          onClose={close}
        >
          <div className="leisure-screen leisure-dialog">
            <div className="leisure-dialog-head">
              <span className="leisure-caption">Дозвілля</span>
              <button
                type="button"
                className="leisure-icon-button"
                aria-label="Закрити вікно дозвілля"
                onClick={close}
              >
                ×
              </button>
            </div>
            {dialog.type === 'detail' && selectedItem && (
              <ItemDetail
                item={selectedItem}
                data={data}
                busy={change.isPending}
                send={send}
                plan={(sessionId) =>
                  setDialog({ type: 'plan', itemId: selectedItem.id, sessionId })
                }
                visit={() => setDialog({ type: 'visit', itemId: selectedItem.id })}
                familiar={() => setDialog({ type: 'familiarity', itemId: selectedItem.id })}
                done={close}
              />
            )}
            {dialog.type === 'familiarity' && selectedItem && (
              <PreviousVisits
                item={selectedItem}
                data={data}
                busy={change.isPending}
                send={send}
                done={close}
              />
            )}
            {dialog.type === 'plan' && (
              <PlanBuilder
                data={data}
                initialItem={selectedItem ?? undefined}
                initialSessionId={dialog.sessionId}
                existing={selectedPlan}
                busy={change.isPending}
                send={send}
                done={close}
              />
            )}
            {dialog.type === 'visit' && selectedItem && (
              <VisitForm
                item={selectedItem}
                existing={visits.find((v) => v.id === dialog.visitId)}
                planId={dialog.planId}
                busy={change.isPending}
                send={send}
                done={close}
              />
            )}
            {dialog.type === 'settings' && (
              <LeisureSettings data={data} busy={change.isPending} send={send} done={close} />
            )}
            {dialog.type === 'plans' && (
              <PlansList
                plans={selectedPlan ? [selectedPlan] : plans}
                busy={change.isPending}
                send={send}
                edit={(p) => setDialog({ type: 'plan', planId: p.id })}
                visit={(p, itemId) => setDialog({ type: 'visit', itemId, planId: p.id })}
              />
            )}
            {dialog.type === 'sources' && (
              <>
                <h2>Джерела й актуальність</h2>
                <p className="leisure-secondary">
                  Недоступне джерело не означає, що події скасовано. Відкриття картки не викликає
                  модель.
                </p>
                {data.edition?.sources.map((s) => (
                  <div key={s.id} className="leisure-source">
                    <strong>{s.name}</strong>
                    <p className="leisure-secondary">
                      {s.status === 'ok'
                        ? `${s.count} підтверджених записів`
                        : s.status === 'empty'
                          ? 'Не знайдено придатних записів'
                          : 'Не вдалося перевірити'}{' '}
                      · {leisureDate(s.checkedAt)}
                    </p>
                    <button
                      type="button"
                      className="leisure-text-button"
                      onClick={() => openLink(s.url)}
                    >
                      Переглянути джерело ↗
                    </button>
                  </div>
                ))}
              </>
            )}
            {dialog.type === 'detail' && !selectedItem && (
              <p>Варіант не знайдено. Онови добірку.</p>
            )}
            {change.error && (
              <p className="leisure-error" role="alert">
                {change.error.message}
              </p>
            )}
          </div>
        </Sheet>
      )}
    </div>
  );
}

function ItemDetail({
  item,
  data,
  busy,
  send,
  plan,
  visit,
  familiar,
  done,
}: {
  item: LeisureItem;
  data: LeisureWorkspace;
  busy: boolean;
  send: Send;
  plan: (sessionId?: string) => void;
  visit: () => void;
  familiar: () => void;
  done: () => void;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [cinema, setCinema] = useState(data.settings.cinemas[0] ?? 'forum-lviv'),
    [date, setDate] = useState('');
  const sessions = item.sessions.filter(
    (s) =>
      s.cinemaSlug === (cinema === 'forum-lviv' ? 'forum-lviv' : 'king-cross-leopolis') &&
      (!date || toKyivInput(s.startAt).slice(0, 10) === date) &&
      Date.parse(s.startAt) > Date.parse(data.generatedAt),
  );
  const branch =
    item.source === 'Планета кіно'
      ? item.sessions.find(
          (s) => s.cinemaSlug === (cinema === 'forum-lviv' ? 'forum-lviv' : 'king-cross-leopolis'),
        )
      : null;
  if (rejecting)
    return (
      <LeisureFeedback
        item={item}
        busy={busy}
        send={send}
        done={done}
        back={() => setRejecting(false)}
      />
    );
  const location = branch
    ? { ...item, address: branch.address, venue: `Планета кіно · ${branch.cinema}` }
    : item;
  return (
    <>
      <div className="leisure-caption">{categoryLabels[item.category]}</div>
      <h2 className="leisure-detail-title">{item.title}</h2>
      <p>{item.summary}</p>
      <GlassCard className="leisure-detail-facts">
        <p>
          <Icon kind="calendar" />
          {dateLabel(item)}
        </p>
        <p>
          <Icon kind="pin" />
          {location.address ?? location.venue ?? 'Місце ще не уточнене'}
        </p>
        <p>
          <strong>{priceLabel(item)}</strong>
        </p>
        {item.price.note && <p className="leisure-secondary">{item.price.note}</p>}
        {item.hours && <p className="leisure-secondary">{item.hours}</p>}
        <PlaceInfo item={item} now={data.generatedAt} />
        {item.registration && <p>Потрібна попередня реєстрація.</p>}
        {item.studentNote && <p className="leisure-secondary">{item.studentNote}</p>}
        {item.durationMinutes && (
          <p className="leisure-secondary">
            Тривалість фільму: {item.durationMinutes} хв · {item.age}
          </p>
        )}
      </GlassCard>
      {item.category === 'cinema' && item.source === 'Планета кіно' ? (
        <>
          <h3>Обери сеанс</h3>
          <div className="leisure-pills">
            {data.settings.cinemas.map((c) => (
              <Pill key={c} active={cinema === c} onClick={() => setCinema(c)}>
                {c === 'forum-lviv' ? 'Forum Lviv' : 'King Cross'}
              </Pill>
            ))}
          </div>
          <label className="leisure-field">
            На день
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          {sessions.length ? (
            sessions.map((s) => (
              <GlassCard key={s.id} className="leisure-session">
                <strong>
                  {leisureDate(s.startAt)} · {leisureTime(s.startAt)}
                </strong>
                <p className="leisure-secondary">
                  {s.format}
                  {s.language ? ` · ${s.language}` : ''} ·{' '}
                  {s.price == null ? 'Ціна на сайті кінотеатру' : money(s.price * 2) + ' за двох'}
                </p>
                <div className="leisure-actions">
                  <Button onClick={() => plan(s.id)} primary>
                    Запланувати
                  </Button>
                  <Button onClick={() => openLink(s.url ?? item.sourceUrl)}>Квитки ↗</Button>
                </div>
              </GlassCard>
            ))
          ) : (
            <p className="leisure-notice">
              На цей вибір сеансів не підтверджено. Новий розклад кінотижня публікується в понеділок
              увечері; уже доступні покази залишаються в афіші.
            </p>
          )}
          <p className="leisure-secondary">
            Купівля та вибір місць — на сторінці фільму в Планеті кіно. Звір дату й час сеансу;
            студентська ціна залежить від умов показу.
          </p>
        </>
      ) : (
        <Button
          primary
          onClick={() => plan()}
          disabled={['sold-out', 'cancelled', 'postponed'].includes(item.status)}
        >
          Додати до плану вечора
        </Button>
      )}
      <div className="leisure-actions">
        <Button
          disabled={busy}
          onClick={() => fire(send('save', { saved: !data.saved.includes(item.id) }, item.id))}
        >
          <Icon kind="save" />
          {data.saved.includes(item.id) ? 'Збережено' : 'Зберегти'}
        </Button>
        <Button disabled={!location.address && !location.placeId} onClick={() => maps(location)}>
          <Icon kind="pin" />
          Місце й маршрут
        </Button>
      </div>
      <div className="leisure-actions">
        <Button onClick={visit}>Записати відвідування</Button>
        {item.category !== 'cinema' && <Button onClick={familiar}>Були тут раніше</Button>}
        <Button disabled={busy} onClick={() => setRejecting(true)}>
          Нецікаво
        </Button>
      </div>
      <div className="leisure-actions">
        <Button
          disabled={busy}
          onClick={() =>
            fire(
              send(
                'reaction',
                {
                  verdict: data.records.some(
                    (r) =>
                      r.kind === 'reaction' && r.itemId === item.id && r.verdict === 'interested',
                  )
                    ? 'clear'
                    : 'interested',
                },
                item.id,
              ),
            )
          }
        >
          {data.records.some(
            (r) => r.kind === 'reaction' && r.itemId === item.id && r.verdict === 'interested',
          )
            ? 'Цікаво ✓'
            : 'Цікаво'}
        </Button>
      </div>
      {item.placeId && (
        <Button disabled={busy} onClick={() => fire(send('place-check', {}, item.id))}>
          Перевірити заклад і бронювання
        </Button>
      )}
      {item.bookingUrl && <Button onClick={() => openLink(item.bookingUrl!)}>Забронювати</Button>}
      {item.siteUrl && !item.bookingUrl && (
        <Button onClick={() => openLink(item.siteUrl!)}>Сайт закладу</Button>
      )}
      {item.source === 'Concert.ua' && (
        <Button onClick={() => openLink(item.sourceUrl)}>Квитки / реєстрація</Button>
      )}
      <button
        type="button"
        className="leisure-text-button"
        onClick={() => openLink(item.sourceUrl)}
      >
        Джерело: {item.source} ↗
      </button>
      <p className="leisure-secondary">
        Перевірено {leisureDate(item.checkedAt)}. Збереження не означає бронювання.
      </p>
      <p className="leisure-secondary">
        {(data.edition?.rankings.find((r) => r.id === item.id)?.reasons ?? []).join(' · ')}
      </p>
      <p className="leisure-secondary">
        У добірці, тому що відповідає обраному напрямку «{categoryLabels[item.category]}». Порядок
        враховує дати й твої явні відгуки.
      </p>
    </>
  );
}

function VisitForm({
  item,
  existing,
  planId,
  busy,
  send,
  done,
}: {
  item: LeisureItem;
  existing?: LeisureVisit;
  planId?: string;
  busy: boolean;
  send: Send;
  done: () => void;
}) {
  const baseRevision = useRef(existing?.revision);
  const [date, setDate] = useState(
      existing ? (existing.visitedOn ?? '') : toKyivInput(new Date().toISOString()).slice(0, 10),
    ),
    [rating, setRating] = useState(existing?.rating ?? ''),
    [reason, setReason] = useState(existing?.reason ?? ''),
    [legacy, setLegacy] = useState(existing?.legacy ?? false);
  return (
    <>
      <h2>{existing ? 'Враження від відвідування' : 'Записати відвідування'}</h2>
      <h3>{item.title}</h3>
      <label className="leisure-field">
        Коли були? Необов’язково
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </label>
      <p className="leisure-secondary">
        Якщо минулу дату не пам’ятаєш, залиш порожньою. Новий похід — окремий запис цього самого
        місця.
      </p>
      <label className="leisure-check">
        <input type="checkbox" checked={legacy} onChange={(e) => setLegacy(e.target.checked)} />
        Це старий візит до початку обліку
      </label>
      <div className="leisure-pills">
        {(
          [
            ['liked', 'Сподобалось'],
            ['neutral', 'Нормально'],
            ['disliked', 'Не сподобалось'],
          ] as const
        ).map(([id, label]) => (
          <Pill key={id} active={rating === id} onClick={() => setRating(rating === id ? '' : id)}>
            {label}
          </Pill>
        ))}
      </div>
      <label className="leisure-field">
        Що варто врахувати наступного разу? Необов’язково
        <textarea
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Їжа, атмосфера, шум, програма…"
        />
      </label>
      <Button
        primary
        disabled={busy}
        onClick={() =>
          void send(
            'visit',
            {
              visitedOn: date || null,
              legacy,
              rating: rating || null,
              reason,
              planId: planId ?? existing?.planId,
              visitId: existing?.id,
              revision: baseRevision.current,
            },
            item.id,
          )
            .then(done)
            .catch(() => {})
        }
      >
        {existing ? 'Оновити враження' : 'Зберегти відвідування'}
      </Button>
    </>
  );
}
function PlansList({
  plans,
  busy,
  send,
  edit,
  visit,
}: {
  plans: LeisurePlan[];
  busy: boolean;
  send: Send;
  edit: (plan: LeisurePlan) => void;
  visit: (plan: LeisurePlan, itemId: string) => void;
}) {
  return (
    <>
      <h2>Ваші плани й виходи</h2>
      {plans.map((p) => (
        <GlassCard key={p.id} className="leisure-plan-detail">
          <h3>{p.title}</h3>
          <p>
            {leisureDate(p.startAt)} · {leisureTime(p.startAt)}–{leisureTime(p.endAt)}
          </p>
          <p className="leisure-secondary">
            {p.status === 'cancelled'
              ? 'Скасовано'
              : p.status === 'went'
                ? 'Вихід відбувся'
                : p.status === 'not-went'
                  ? 'Не пішли'
                  : calendarLabel(p)}
          </p>
          {p.stops.map((s, i) => (
            <div key={`${s.itemId}-${i}`} className="leisure-plan-stop">
              <strong>
                {leisureTime(s.startAt)} · {s.title}
              </strong>
              <p className="leisure-secondary">{s.address ?? 'Адресу не уточнено'}</p>
              <p className="leisure-secondary">
                {s.tickets
                  ? 'Квитки / реєстрація підтверджені'
                  : 'Квитки / реєстрація не підтверджені'}{' '}
                · {s.reservation ? 'Бронювання є' : 'Бронювання не зазначене'}
              </p>
              {p.status === 'went' && (
                <button
                  type="button"
                  className="leisure-text-button"
                  onClick={() => visit(p, s.itemId)}
                >
                  Відмітити цей пункт і враження
                </button>
              )}
            </div>
          ))}
          <div className="leisure-actions">
            <Button disabled={busy || p.status === 'cancelled'} onClick={() => edit(p)}>
              Змінити / перенести
            </Button>
            <Button disabled={!p.stops.some((s) => s.address)} onClick={() => route(p)}>
              Маршрут
            </Button>
          </div>
          {p.status === 'planned' && (
            <>
              <div className="leisure-actions">
                <Button
                  disabled={busy}
                  onClick={() =>
                    fire(send('outcome', { status: 'went', revision: p.revision }, p.id))
                  }
                >
                  Були
                </Button>
                <Button
                  disabled={busy}
                  onClick={() =>
                    fire(
                      send(
                        'outcome',
                        {
                          status: 'not-went',
                          reason: 'Не пішли; причина не уточнена',
                          revision: p.revision,
                        },
                        p.id,
                      ),
                    )
                  }
                >
                  Не пішли
                </Button>
              </div>
              <Button
                disabled={busy}
                onClick={() => fire(send('cancel', { revision: p.revision }, p.id))}
              >
                Скасувати план і календарний запис
              </Button>
            </>
          )}
        </GlassCard>
      ))}
    </>
  );
}
function LeisureSettings({
  data,
  busy,
  send,
  done,
}: {
  data: LeisureWorkspace;
  busy: boolean;
  send: Send;
  done: () => void;
}) {
  const [categories, setCategories] = useState(data.settings.categories),
    [cinemas, setCinemas] = useState(data.settings.cinemas),
    [students, setStudents] = useState(data.settings.students),
    [enabled, setEnabled] = useState(data.settings.enabled),
    [clearConfirmed, setClearConfirmed] = useState(false);
  const toggle = (values: string[], value: string) =>
    values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
  return (
    <>
      <h2>Налаштування дозвілля</h2>
      <p className="leisure-secondary">
        Львів · машиною · без встановленого бюджету чи радіуса. Понеділок о 08:00, без
        Telegram-розсилки.
      </p>
      <h3>Цікаві напрямки</h3>
      <div className="leisure-pills">
        {Object.entries(categoryLabels).map(([id, label]) => (
          <Pill
            key={id}
            active={categories.includes(id)}
            onClick={() => setCategories((v) => toggle(v, id))}
          >
            {label}
          </Pill>
        ))}
      </div>
      <p className="leisure-secondary">
        Обрані напрямки визначають добірку. Особистий рейтинг навчається з «Цікаво», причин
        «Нецікаво» та твоїх відгуків.
      </p>
      <h3>Планета кіно</h3>
      <div className="leisure-pills">
        {[
          ['forum-lviv', 'Forum Lviv'],
          ['king-cross', 'King Cross'],
        ].map(([id, label]) => (
          <Pill
            key={id}
            active={cinemas.includes(id!)}
            onClick={() => setCinemas((v) => toggle(v, id!))}
          >
            {label}
          </Pill>
        ))}
      </div>
      <label className="leisure-field">
        Студентських квитків, якщо діють пільги
        <select value={students} onChange={(e) => setStudents(Number(e.target.value))}>
          <option value={0}>Не враховувати</option>
          <option value={1}>Один</option>
          <option value={2}>Два</option>
        </select>
      </label>
      <label className="leisure-check">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Оновлювати добірку автоматично
      </label>
      <p className="leisure-secondary">
        Понеділок, 08:00 за Києвом. Регулярної Telegram-розсилки немає. Пільги враховуються лише
        там, де їх підтвердило джерело.
      </p>
      <p className="leisure-secondary">
        Зберігаються видані добірки й твої явні збереження, плани, відвідування та відгуки до
        видалення. Час перегляду й геолокація не збираються.
      </p>
      <Button
        primary
        disabled={busy || !categories.length || !cinemas.length}
        onClick={() =>
          void send('settings', { categories, cinemas, students, enabled })
            .then(done)
            .catch(() => {})
        }
      >
        Зберегти налаштування
      </Button>
      <Button
        onClick={() => {
          void fetchLeisure(true)
            .then((all) => {
              const url = URL.createObjectURL(
                new Blob([JSON.stringify(all, null, 2)], { type: 'application/json' }),
              );
              const a = document.createElement('a');
              a.href = url;
              a.download = 'svitanok-leisure.json';
              a.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            })
            .catch(() => {
              window.alert('Не вдалося завантажити історію. Спробуй ще раз.');
            });
        }}
      >
        Завантажити мої записи
      </Button>
      <label className="leisure-check">
        <input
          type="checkbox"
          checked={clearConfirmed}
          onChange={(e) => setClearConfirmed(e.target.checked)}
        />
        Очистити історію й збереження дозвілля. Події Google Calendar залишаться.
      </label>
      <Button
        disabled={busy || !clearConfirmed}
        onClick={() =>
          void send('clear', { confirmed: true })
            .then(done)
            .catch(() => {})
        }
      >
        Очистити історію дозвілля
      </Button>
    </>
  );
}
