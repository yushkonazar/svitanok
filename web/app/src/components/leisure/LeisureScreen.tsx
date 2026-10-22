import { PlaceInfo, ContentInfo } from './PlaceInfo.tsx';
import { LeisureMedia } from './LeisureMedia.tsx';
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
  LeisureSaveUncertainError,
  type LeisureCommand,
  type LeisureItem,
  type LeisurePlan,
  type LeisureVisit,
  type LeisureWorkspace,
  type LeisureReceipt,
} from '../../api/leisure.ts';
import { PlanBuilder } from './PlanBuilder.tsx';
import { SwipeDeck } from './SwipeDeck.tsx';
import { CategoryArtwork } from './CategoryArtwork.tsx';
import { RequestDiagnostics } from '../ui/RequestDiagnostics.tsx';
import { readPendingLeisure, keepPendingLeisure } from './pending-command.ts';
import { LeisureFeedback, PreviousVisits } from './LeisureFeedback.tsx';
import { LeisureCollection } from './LeisureCollection.tsx';
import { LeisureHistory } from './LeisureHistory.tsx';
import { TogetherPlanner } from './TogetherPlanner.tsx';
import { RestaurantCatalog } from './RestaurantCatalog.tsx';
import { CategoryBrowse } from './CategoryBrowse.tsx';
import { FiniteLeisureDeck } from './FiniteLeisureDeck.tsx';
import { SelectionSettings, CategoryCorrection } from './SelectionSettings.tsx';
import { LEISURE_EVENT_CATEGORIES } from '../../../../core/leisure/taxonomy.mjs';
import { leisureFeedbackChoices } from '../../../../core/leisure/feedback.mjs';
import {
  leisureIdentity,
  leisureReactionHidden,
  leisureDecisionIndex,
} from '../../../../core/leisure/identity.mjs';
import type { LeisurePlanSeed } from '../../api/leisure.ts';
import './leisure.css';

type Dialog = {
  type:
    | 'detail'
    | 'interest'
    | 'together'
    | 'reject'
    | 'familiarity'
    | 'plan'
    | 'visit'
    | 'settings'
    | 'plans'
    | 'sources'
    | 'classification';
  itemId?: string;
  planId?: string;
  visitId?: string;
  sessionId?: string;
  revisit?: boolean;
};
type Send = (op: string, payload: Record<string, unknown>, id?: string) => Promise<LeisureReceipt>;
const CATEGORY_GROUPS = [
  ['all', 'Усе'],
  ['food', 'Заклади'],
  ['cinema', 'Кіно'],
  ['events', 'Події'],
  ['place', 'Місця'],
  ['trip', 'Поїздки'],
  ['podcast', 'Послухати'],
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
  return value == null
    ? item.placeId && item.category === 'food'
      ? 'Точна сума залежить від замовлення'
      : 'Ціну не підтверджено'
    : `Від ${money(value)} за двох`;
}
function dateLabel(item: LeisureItem) {
  if (item.schedule?.kind === 'on-request') return 'Час за попереднім узгодженням';
  if (item.schedule?.precision === 'conflicting') return 'Дату потрібно уточнити';
  if (item.category === 'podcast')
    return item.publishedAt
      ? 'Опубліковано ' + leisureDate(item.publishedAt)
      : 'Слухай, коли зручно';
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
      <button
        type="button"
        className="leisure-item-open"
        aria-label={`Деталі: ${item.title}`}
        aria-haspopup="dialog"
        onClick={onOpen}
      />
      <div className="leisure-item-head">
        <CategoryArtwork category={item.category} variant="thumb" />
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
          className={`leisure-icon-button leisure-item-save${saved ? ' is-saved' : ''}`}
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
        <span className="leisure-text-button">
          Деталі <Icon kind="open" />
        </span>
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
    [day, setDay] = useState(''),
    [notice, setNotice] = useState(''),
    [genre, setGenre] = useState(''),
    [deckRevision, setDeckRevision] = useState(0),
    [undoReaction, setUndoReaction] = useState<{
      id: string;
      payload: Record<string, unknown>;
    } | null>(null),
    [reviewMode, setReviewMode] = useState(false),
    [reviewed, setReviewed] = useState<Set<string>>(() => new Set());
  const [planSeed, setPlanSeed] = useState<LeisurePlanSeed | null>(null);
  const [togetherFlow, setTogetherFlow] = useState(false);
  const [restored] = useState(readPendingLeisure);
  const [recovery, setRecovery] = useState<LeisureCommand | null>(restored);
  const [dialog, setDialog] = useState<Dialog | null>(() =>
    params.get('action') === 'settings'
      ? { type: 'settings' }
      : params.get('item')
        ? { type: 'detail', itemId: params.get('item')! }
        : null,
  );
  const pending = useRef<{ signature: string; command: LeisureCommand } | null>(
    restored
      ? {
          signature: JSON.stringify({
            op: restored.op,
            id: restored.id,
            payload: restored.payload,
          }),
          command: restored,
        }
      : null,
  );
  const sending = useRef(false);
  const send = useCallback<Send>(
    async (op, payload, id) => {
      const signature = JSON.stringify({ op, id, payload });
      if (sending.current) throw new Error('Зачекай, попередня дія ще зберігається.');
      if (recovery && pending.current?.signature !== signature)
        throw new LeisureSaveUncertainError();
      if (pending.current?.signature !== signature)
        pending.current = {
          signature,
          command: { op, id, payload, commandId: crypto.randomUUID() },
        };
      sending.current = true;
      keepPendingLeisure(pending.current.command);
      const previous =
        op === 'reaction' && id
          ? cache
              .getQueryData<LeisureWorkspace>(['leisure'])
              ?.records.find((r) => r.kind === 'reaction' && r.itemId === id)
          : undefined;
      try {
        const result = await change.mutateAsync({
          ...pending.current.command,
          verifyFirst: Boolean(recovery),
        });
        pending.current = null;
        keepPendingLeisure(null);
        setRecovery(null);
        setNotice(result.receipt.message);
        if (op === 'reaction') {
          setUndoReaction(
            payload.verdict === 'clear' || !id
              ? null
              : {
                  id,
                  payload: {
                    restorePrevious: true,
                    revision: result.receipt.revision,
                    ...(previous?.kind === 'reaction'
                      ? {
                          verdict: previous.verdict,
                          interestLevel: previous.interestLevel,
                          reasonCodes: previous.reasonCodes,
                          reasonCode: previous.reasonCode,
                          reason: previous.reason,
                          revisit: previous.revisit,
                          snoozeUntil: previous.snoozeUntil,
                        }
                      : { verdict: 'clear' }),
                  },
                },
          );
          if (id)
            setReviewed((old) => {
              const next = new Set(old);
              if (payload.verdict === 'clear') next.delete(id);
              else next.add(id);
              return next;
            });
          if (payload.verdict === 'clear') setDeckRevision((n) => n + 1);
        }
        haptic('success');
        return result.receipt;
      } catch (error) {
        if (error instanceof LeisureSaveUncertainError)
          setRecovery(pending.current?.command ?? null);
        else {
          pending.current = null;
          keepPendingLeisure(null);
          setRecovery(null);
        }
        throw error;
      } finally {
        sending.current = false;
      }
    },
    [change, recovery, cache],
  );
  const close = () => {
    if (sending.current) return;
    setDialog(null);
    setTogetherFlow(false);
    setPlanSeed(null);
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
  const decisions = leisureDecisionIndex(data.items, [
    ...(data.discoveryDecisions ?? []).map((r) => ({ ...r, kind: 'discovery' })),
    ...data.records,
  ]);
  const hidden = new Set(
    data.items
      .filter((i) =>
        leisureReactionHidden(
          decisions.get(i.identityKey ?? leisureIdentity(i)) ?? {},
          Date.parse(data.generatedAt),
        ),
      )
      .map((i) => i.id),
  );
  const decided = new Set([
    ...data.saved,
    ...visits.map((v) => v.itemId),
    ...data.records.flatMap((r) => (r.kind === 'familiarity' && !r.cleared ? [r.itemId] : [])),
    ...plans.filter((p) => p.status === 'planned').flatMap((p) => p.stops.map((s) => s.itemId)),
  ]);
  const decidedKeys = new Set(
    data.items.filter((i) => decided.has(i.id)).map((i) => i.identityKey ?? leisureIdentity(i)),
  );
  for (const [key, decision] of decisions)
    if (
      decision.verdict === 'interested' ||
      leisureReactionHidden(decision, Date.parse(data.generatedAt))
    )
      decidedKeys.add(key);
  const categoryBrowser =
    ['food', 'cinema', 'place', 'trip', 'podcast'].includes(category) ||
    (category === 'events' && !['all', 'concert'].includes(subCategory));
  const baseIds =
    tab === 'saved'
      ? [
          ...new Set([
            ...data.records.flatMap((r) =>
              r.kind === 'reaction' && r.verdict !== 'clear' ? [r.itemId] : [],
            ),
            ...data.saved,
          ]),
        ]
      : tab === 'visited'
        ? [
            ...new Set([
              ...visits.map((v) => v.itemId),
              ...data.records.flatMap((r) =>
                r.kind === 'familiarity' && !r.cleared ? [r.itemId] : [],
              ),
            ]),
          ]
        : categoryBrowser
          ? data.items.map((i) => i.id)
          : reviewMode
            ? [
                ...new Set([
                  ...data.records.flatMap((r) =>
                    r.kind === 'reaction' && r.verdict !== 'clear' ? [r.itemId] : [],
                  ),
                  ...data.saved,
                ]),
              ].filter((id) => !reviewed.has(id))
            : [...(data.edition?.ids ?? []), ...(data.edition?.futureIds ?? [])].filter(
                (id) =>
                  !decided.has(id) &&
                  !decidedKeys.has(
                    itemById.get(id)?.identityKey ?? leisureIdentity(itemById.get(id) ?? {}),
                  ),
              );
  const candidates = baseIds
    .map((id) => itemById.get(id))
    .filter((i): i is LeisureItem => !!i)
    .filter(
      (i) =>
        (tab !== 'feed' || categoryBrowser || reviewMode || !hidden.has(i.id)) &&
        (category === 'all' ||
          (category === 'events'
            ? LEISURE_EVENT_CATEGORIES.includes(i.category)
            : category === 'places'
              ? i.category === 'place'
              : i.category === category)) &&
        (!genre || i.genre.toLocaleLowerCase('uk').includes(genre.toLocaleLowerCase('uk'))) &&
        (subCategory === 'all' || category !== 'events' || i.category === subCategory) &&
        (!search ||
          `${i.title} ${i.venue ?? ''} ${i.address ?? ''} ${
            tab === 'visited'
              ? visits
                  .filter((v) => v.itemId === i.id)
                  .map((v) => v.reason)
                  .join(' ')
              : ''
          }`
            .toLocaleLowerCase('uk')
            .includes(search.toLocaleLowerCase('uk'))) &&
        (!day || ((!i.startDate || i.startDate <= day) && (!i.endDate || i.endDate >= day))),
    );
  const selectedItem = dialog?.itemId ? itemById.get(dialog.itemId) : null,
    selectedPlan = dialog?.planId ? plans.find((p) => p.id === dialog.planId) : undefined;
  const busy = change.isPending || !!recovery;
  const choose = (
    item: LeisureItem,
    choice: 'interested' | 'priority' | 'uninterested' | 'clear',
  ) => {
    const current = data.records.find((r) => r.kind === 'reaction' && r.itemId === item.id);
    const interested = current?.kind === 'reaction' && current.verdict === 'interested';
    const priority = interested && current.interestLevel === 'priority';
    const verdict =
      choice === 'clear' || (choice === 'interested' && interested && !priority)
        ? 'clear'
        : choice === 'uninterested'
          ? 'uninterested'
          : 'interested';
    const allowed = leisureFeedbackChoices(item.category, true).map((c) => c.code);
    fire(
      send(
        'reaction',
        {
          verdict,
          interestLevel:
            verdict === 'interested'
              ? choice === 'priority' && !priority
                ? 'priority'
                : 'interested'
              : null,
          reasonCodes:
            verdict === 'uninterested'
              ? ['this-option']
              : current?.kind === 'reaction'
                ? (current.reasonCodes ?? []).filter((code) => allowed.includes(code))
                : [],
          ...(current?.kind === 'reaction'
            ? { revision: current.revision, reason: current.reason, revisit: current.revisit }
            : {}),
        },
        item.id,
      ),
    );
  };
  const browseProps = {
    data,
    items: candidates,
    busy,
    onOpen: (item: LeisureItem) => setDialog({ type: 'detail', itemId: item.id }),
    onChoose: choose,
    onVisit: (item: LeisureItem) =>
      setDialog({
        type: ['food', 'place', 'trip'].includes(item.category) ? 'familiarity' : 'visit',
        itemId: item.id,
      }),
    onExplain: (item: LeisureItem) =>
      setDialog({
        type:
          decisions.get(item.identityKey ?? leisureIdentity(item))?.verdict === 'uninterested'
            ? 'reject'
            : 'interest',
        itemId: item.id,
      }),
    onFollow: (series: string) =>
      fire(
        send('settings', {
          selection: {
            followedPodcastSeries: data.settings.selection.followedPodcastSeries.includes(series)
              ? data.settings.selection.followedPodcastSeries.filter((s) => s !== series)
              : [...data.settings.selection.followedPodcastSeries, series],
          },
        }),
      ),
    onCorrect: (item: LeisureItem) => setDialog({ type: 'classification', itemId: item.id }),
  };
  const recover = recovery && (
    <div className="leisure-recovery" role="alert">
      <p>Підтвердження не надійшло. Перевіримо ту саму дію, щоб не створити дубль.</p>
      {change.error instanceof LeisureSaveUncertainError && change.error.diagnostic && (
        <RequestDiagnostics entry={change.error.diagnostic} />
      )}
      <Button
        disabled={change.isPending}
        onClick={() => fire(send(recovery.op, recovery.payload, recovery.id).then(close))}
      >
        {change.isPending ? 'Перевіряю…' : 'Перевірити збереження'}
      </Button>
    </div>
  );
  return (
    <div
      className="leisure-screen"
      aria-hidden={dialog ? true : undefined}
      inert={dialog ? true : undefined}
    >
      <div className="leisure-heading">
        <div>
          <h1>Дозвілля</h1>
          <p className="leisure-secondary">Для ваших вечорів і вихідних.</p>
        </div>
        <div className="leisure-heading-actions">
          <button
            type="button"
            className="leisure-icon-button"
            aria-label={plans.length ? 'Переглянути плани дозвілля' : 'Скласти план дозвілля'}
            onClick={() => setDialog({ type: plans.length ? 'plans' : 'plan' })}
          >
            <Icon kind="calendar" />
          </button>
          <button
            type="button"
            className="leisure-icon-button"
            aria-label="Налаштування дозвілля"
            onClick={() => setDialog({ type: 'settings' })}
          >
            <Icon kind="settings" />
          </button>
        </div>
      </div>
      <button
        type="button"
        className="leisure-together-entry"
        onClick={() => {
          setTogetherFlow(true);
          setDialog({ type: 'together' });
        }}
      >
        <span className="leisure-together-entry-icon" aria-hidden="true">
          <Icon kind="route" />
        </span>
        <span>
          <strong>Спланувати час разом</strong>
          <small>Один день або кілька на вибір</small>
        </span>
        <span className="leisure-together-entry-arrow" aria-hidden="true">
          ↗
        </span>
      </button>
      {!inTelegram() && <p className="leisure-demo">Демо: дії не змінюють сервер і календар.</p>}
      {upcoming && (
        <div className="leisure-plan-bar">
          <button
            type="button"
            onClick={() => setDialog({ type: upcoming ? 'plans' : 'plan', planId: upcoming?.id })}
          >
            <Icon kind="calendar" />
            <span>
              <strong>{upcoming ? upcoming.title : 'Спланувати вихід'}</strong>
              <small>
                {upcoming
                  ? leisureDate(upcoming.startAt) + ' · ' + leisureTime(upcoming.startAt)
                  : 'Обери цікаве й перевір календар'}
              </small>
            </span>
            <Icon kind="open" />
          </button>
          {plans.length > 0 && (
            <button
              type="button"
              className="leisure-text-button"
              onClick={() => setDialog({ type: 'plans' })}
            >
              Усі плани · {plans.length}
            </button>
          )}
        </div>
      )}
      {pendingReview.length > 0 && (
        <button
          type="button"
          className="leisure-review-prompt"
          onClick={() => setDialog({ type: 'plans', planId: pendingReview[0]!.id })}
        >
          Як пройшов «{pendingReview[0]!.title}»? <span>Були / не пішли / перенесли →</span>
        </button>
      )}
      <div className="leisure-tabs">
        {(
          [
            ['feed', 'Нове'],
            ['saved', 'Моє'],
            ['visited', 'Історія'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={tab === id}
            onClick={() => {
              setTab(id);
              setReviewMode(false);
              setSearch('');
              setDay('');
            }}
          >
            {label}
            {id === 'saved' && baseIds.length > 0 && tab === 'saved' ? ' · ' + baseIds.length : ''}
          </button>
        ))}
      </div>
      {tab === 'feed' &&
        !categoryBrowser &&
        (reviewMode ||
          data.records.some((r) => r.kind === 'reaction' && r.verdict !== 'clear') ||
          data.saved.length > 0) && (
          <div className={`leisure-review-mode${reviewMode ? ' is-active' : ''}`}>
            {reviewMode && (
              <div>
                <strong>Повторний відбір</strong>
                <p>Попередній вибір зберігається, доки ти не зміниш його на картці.</p>
              </div>
            )}
            <button
              type="button"
              className="leisure-text-button"
              disabled={busy}
              onClick={() => {
                setReviewMode(!reviewMode);
                setReviewed(new Set());
                setCategory('all');
                setSubCategory('all');
                setGenre('');
                setDay('');
                setSearch('');
                setDeckRevision((n) => n + 1);
                setNotice('');
                setUndoReaction(null);
              }}
            >
              {reviewMode ? 'До нових карток' : 'Переглянути оцінені'}
            </button>
          </div>
        )}
      {tab !== 'feed' && (
        <p className="leisure-secondary">
          {tab === 'saved'
            ? 'Переглянь деталі й обери, куди підете.'
            : 'Твої відвідування, перегляди та враження.'}
        </p>
      )}
      <div className="leisure-filter-bar">
        <div className="leisure-pills leisure-category-pills">
          {CATEGORY_GROUPS.map(([id, label]) => (
            <Pill
              key={id}
              active={category === id}
              onClick={() => {
                setCategory(id);
                if (['food', 'cinema', 'place', 'trip', 'podcast'].includes(id))
                  setReviewMode(false);
                setSubCategory('all');
                setGenre('');
              }}
            >
              {label}
            </Pill>
          ))}
        </div>
        <button
          type="button"
          className="leisure-icon-button"
          aria-label="Пошук і фільтри"
          aria-expanded={searchOpen}
          onClick={() => setSearchOpen((v) => !v)}
        >
          <Icon kind="search" />
        </button>
      </div>
      {searchOpen && (
        <div className="leisure-filter-panel">
          <label className="leisure-field">
            Пошук
            <input
              type="search"
              placeholder={
                tab === 'visited' ? 'Назва або слова з відгуку' : 'Подія, фільм або заклад'
              }
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
              }}
            />
          </label>
          {tab !== 'visited' && (
            <label className="leisure-field">
              На конкретний день
              <input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
            </label>
          )}
          {day && <Button onClick={() => setDay('')}>Усі дати</Button>}
          {category === 'cinema' && (
            <label className="leisure-field">
              Жанр
              <select value={genre} onChange={(e) => setGenre(e.target.value)}>
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
        </div>
      )}
      {category === 'events' && (
        <div className="leisure-pills leisure-event-kinds" aria-label="Формати подій">
          <Pill active={subCategory === 'all'} onClick={() => setSubCategory('all')}>
            Коротка добірка
          </Pill>
          {(['concert', 'show', 'festival', 'exhibition', 'meetup', 'event'] as const).map((c) => (
            <Pill key={c} active={subCategory === c} onClick={() => setSubCategory(c)}>
              {categoryLabels[c]}
            </Pill>
          ))}
        </div>
      )}
      {data.edition?.stale && (
        <p className="leisure-notice">
          Це попередня добірка. Онови її, щоб перевірити актуальність.
        </p>
      )}
      {data.refresh?.active && (
        <p role="status" className="leisure-notice">
          Перевіряємо джерела у фоні · {data.refresh.done}/{data.refresh.total}.
        </p>
      )}
      {notice && (
        <div role="status" className="leisure-choice-notice">
          <span>{notice}</span>
          {undoReaction && (
            <button
              type="button"
              className="leisure-text-button"
              disabled={busy}
              onClick={() =>
                fire(
                  send('reaction', undoReaction.payload, undoReaction.id).then(() => {
                    setReviewed((old) => {
                      const next = new Set(old);
                      next.delete(undoReaction.id);
                      return next;
                    });
                    setUndoReaction(null);
                    setDeckRevision((n) => n + 1);
                  }),
                )
              }
            >
              Скасувати вибір
            </button>
          )}
        </div>
      )}
      {!dialog && recover}
      {!dialog && change.error && !recovery && (
        <p role="alert" className="leisure-error">
          {change.error.message}
        </p>
      )}
      {tab === 'feed' ? (
        category === 'food' ? (
          <RestaurantCatalog key={category} {...browseProps} />
        ) : categoryBrowser ? (
          <CategoryBrowse
            key={category + subCategory}
            {...browseProps}
            mode={category === 'events' ? subCategory : category}
          />
        ) : (
          <FiniteLeisureDeck
            key={[data.edition?.week, category, subCategory, genre, day, search, reviewMode].join(
              '|',
            )}
            data={data}
            items={candidates.filter((i) => i.category !== 'food')}
            scope={[category, subCategory, genre, day, search].join(':')}
            reviewing={reviewMode}
            useWeeklySet={category !== 'events' || subCategory === 'all'}
          >
            {(deckItems) => (
              <SwipeDeck
                deferLike={reviewMode}
                key={[category, subCategory, genre, day, search, deckRevision, reviewMode].join(
                  '|',
                )}
                reviewing={reviewMode}
                previousChoice={(id) => {
                  const reaction = data.records.find(
                    (r) => r.kind === 'reaction' && r.itemId === id,
                  );
                  return reaction?.kind === 'reaction'
                    ? reaction.verdict === 'interested'
                      ? reaction.interestLevel === 'priority'
                        ? 'Насамперед'
                        : 'Цікаво'
                      : reaction.verdict === 'later'
                        ? 'Відкладено'
                        : 'Нецікаво'
                    : 'Збережено';
                }}
                items={deckItems}
                newCount={
                  deckItems.filter(
                    (i) =>
                      i.firstDiscoveredAt &&
                      toKyivInput(i.firstDiscoveredAt).slice(0, 10) >=
                        (data.edition?.week ?? '9999'),
                  ).length
                }
                busy={busy}
                reasons={(id) =>
                  reviewMode ? [] : (data.edition?.rankings.find((r) => r.id === id)?.reasons ?? [])
                }
                onLike={async (item) => {
                  if (reviewMode) {
                    setDialog({ type: 'interest', itemId: item.id });
                    return false;
                  }
                  await send(
                    'reaction',
                    { verdict: 'interested', interestLevel: 'interested', reasonCodes: [] },
                    item.id,
                  );
                  return true;
                }}
                onReject={(item) => {
                  if (reviewMode) setDialog({ type: 'reject', itemId: item.id });
                  else choose(item, 'uninterested');
                }}
                onPriority={(item) => choose(item, 'priority')}
                onVisit={browseProps.onVisit}
                onOpen={(item) => setDialog({ type: 'detail', itemId: item.id })}
              />
            )}
          </FiniteLeisureDeck>
        )
      ) : tab === 'saved' ? (
        <LeisureCollection
          data={data}
          items={candidates}
          busy={busy}
          send={send}
          onOpen={(item) => setDialog({ type: 'detail', itemId: item.id })}
          onFeedback={(item) => setDialog({ type: 'interest', itemId: item.id })}
        />
      ) : (
        <>
          <LeisureHistory
            data={data}
            items={candidates}
            visits={visits}
            onOpen={(id) => setDialog({ type: 'detail', itemId: id })}
            onEdit={(v) => setDialog({ type: 'visit', itemId: v.itemId, visitId: v.id })}
            onReturn={(id) => setDialog({ type: 'interest', itemId: id, revisit: true })}
          />
          {candidates.some((i) => !visits.some((v) => v.itemId === i.id)) && (
            <details className="leisure-manage">
              <summary>Знайомі місця без окремих відвідувань</summary>
              {candidates
                .filter((i) => !visits.some((v) => v.itemId === i.id))
                .map((item) => (
                  <ItemCard
                    key={item.id}
                    item={item}
                    known={data.knownPlaces[item.id]}
                    saved={data.saved.includes(item.id)}
                    busy={busy}
                    onOpen={() => setDialog({ type: 'detail', itemId: item.id })}
                    onSave={() =>
                      fire(send('save', { saved: !data.saved.includes(item.id) }, item.id))
                    }
                  />
                ))}
            </details>
          )}
          {data.historyTotal > data.records.filter((r) => r.kind !== 'draft').length && (
            <Button
              onClick={() =>
                fire(fetchLeisure(true).then((all) => cache.setQueryData(LEISURE_QUERY, all)))
              }
            >
              Завантажити всю історію ({data.historyTotal})
            </Button>
          )}
        </>
      )}
      <details className="leisure-manage">
        <summary>Добірка й персоналізація</summary>
        <p className="leisure-secondary">
          Понеділок · 08:00. Кіно доповнюється після публікації розкладу. Дайджест новинок можна
          налаштувати у параметрах дозвілля. Показуємо актуальні варіанти на тиждень і події
          наперед.
        </p>
        <p>Твоїх оцінок: {data.preferenceProfile?.signals ?? data.edition?.profileSignals ?? 0}</p>
        <p className="leisure-secondary">
          «Цікаво» й оцінки відвідувань змінюють порядок. Причина «не зараз» приховує варіант, не
          знижуючи оцінку жанру. Частина карток допомагає відкрити нові напрямки.
        </p>
        {!!data.preferenceProfile?.interests.length && (
          <div className="leisure-interest-tags">
            {data.preferenceProfile.interests.map((i) => (
              <span key={i.feature}>
                {i.score > 0 ? '↑' : '↓'} {i.label}
              </span>
            ))}
          </div>
        )}
        <p className="leisure-secondary">
          Минулі не обрані події прибираються під час оновлення каталогу. Для навчання залишаються
          ознаки вподобань. Збережене, плани й твої відгуки залишаються в історії дозвілля.
        </p>
        <div className="leisure-actions">
          <Button disabled={busy} onClick={() => fire(send('refresh', {}))}>
            {change.isPending ? 'Оновлюю…' : 'Оновити добірку'}
          </Button>
          <Button onClick={() => setDialog({ type: 'sources' })}>Джерела</Button>
        </div>
      </details>
      {dialog && (
        <Sheet
          label={
            dialog.type === 'interest'
              ? 'Зберегти інтерес'
              : dialog.type === 'together'
                ? 'Спланувати час разом'
                : dialog.type === 'detail'
                  ? 'Деталі варіанта'
                  : dialog.type === 'reject'
                    ? 'Що не підходить?'
                    : dialog.type === 'plan'
                      ? 'План дозвілля'
                      : dialog.type === 'visit'
                        ? 'Відвідування й враження'
                        : dialog.type === 'settings'
                          ? 'Налаштування дозвілля'
                          : dialog.type === 'plans'
                            ? 'Ваші плани'
                            : dialog.type === 'classification'
                              ? 'Уточнити тип події'
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
                disabled={change.isPending}
                onClick={close}
              >
                ×
              </button>
            </div>
            {recover}
            <fieldset className="leisure-dialog-fields" disabled={!!recovery}>
              {(dialog.type === 'reject' || dialog.type === 'interest') && selectedItem && (
                <LeisureFeedback
                  key={dialog.type + selectedItem.id}
                  positive={dialog.type === 'interest'}
                  current={data.records.find(
                    (r): r is Extract<LeisureWorkspace['records'][number], { kind: 'reaction' }> =>
                      r.kind === 'reaction' && r.itemId === selectedItem.id,
                  )}
                  known={!!data.knownPlaces[selectedItem.id]?.familiar}
                  revisitInitially={dialog.revisit}
                  onSeen={() => setDialog({ type: 'visit', itemId: selectedItem.id })}
                  item={selectedItem}
                  busy={busy}
                  send={send}
                  done={close}
                  back={close}
                />
              )}
              {(dialog.type === 'together' || (dialog.type === 'plan' && togetherFlow)) && (
                <div hidden={dialog.type !== 'together'}>
                  <TogetherPlanner
                    active={dialog.type === 'together'}
                    data={data}
                    busy={busy}
                    send={send}
                    onChoose={(seed) => {
                      setPlanSeed(seed);
                      setDialog({ type: 'plan' });
                    }}
                  />
                </div>
              )}
              {dialog.type === 'detail' && selectedItem && (
                <>
                  <ItemDetail
                    item={selectedItem}
                    data={data}
                    busy={change.isPending}
                    send={send}
                    plan={(sessionId) =>
                      setDialog({ type: 'plan', itemId: selectedItem.id, sessionId })
                    }
                    visit={() => setDialog({ type: 'visit', itemId: selectedItem.id })}
                    interested={() => setDialog({ type: 'interest', itemId: selectedItem.id })}
                    familiar={() => setDialog({ type: 'familiarity', itemId: selectedItem.id })}
                    done={close}
                  />
                  {selectedItem.eventFormat && (
                    <button
                      type="button"
                      className="leisure-button"
                      disabled={busy}
                      onClick={() => setDialog({ type: 'classification', itemId: selectedItem.id })}
                    >
                      Уточнити тип події
                    </button>
                  )}
                </>
              )}
              {dialog.type === 'classification' && selectedItem && (
                <CategoryCorrection item={selectedItem} busy={busy} send={send} done={close} />
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
                  seed={selectedItem || selectedPlan ? undefined : (planSeed ?? undefined)}
                  backToSuggestions={
                    togetherFlow
                      ? () => {
                          setPlanSeed(null);
                          setDialog({ type: 'together' });
                        }
                      : undefined
                  }
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
                  key={`${selectedItem.id}-${dialog.visitId ?? 'new'}`}
                  item={selectedItem}
                  existing={visits.find((v) => v.id === dialog.visitId)}
                  visits={visits}
                  editDuplicate={(visitId) => setDialog({ ...dialog, visitId })}
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
                    Недоступне джерело не означає, що події скасовано. Фото й дані Google
                    оновлюються під час перегляду; ціни та години залежать від закладу.
                  </p>
                  {data.edition?.sources.map((s) => (
                    <div key={s.id} className="leisure-source">
                      <strong>{s.name}</strong>
                      <p className="leisure-secondary">
                        {s.status === 'ok'
                          ? `${s.count} записів із джерела`
                          : s.status === 'empty'
                            ? 'Не знайдено придатних записів'
                            : 'Не вдалося перевірити'}{' '}
                        · {leisureDate(s.checkedAt)}
                      </p>
                      {s.coverage && s.count > 0 && (
                        <div className="leisure-source-coverage">
                          <span>Фото: {s.coverage.withMedia}</span>
                          <span>Ціна: {s.coverage.withPrice}</span>
                          <span>Розклад: {s.coverage.withTime}</span>
                          {s.coverage.needsCheck > 0 && (
                            <span>Потребують уточнення: {s.coverage.needsCheck}</span>
                          )}
                        </div>
                      )}
                      {s.errorCode === 'source-http-403' && (
                        <p className="leisure-secondary">
                          Сайт тимчасово обмежив доступ. Зберігаємо попередні дані й перевіряємо
                          незалежні афіші.
                        </p>
                      )}
                      {s.diagnostics &&
                        s.diagnostics.unparsed +
                          s.diagnostics.invalid +
                          s.diagnostics.pageFailures >
                          0 && (
                          <p className="leisure-secondary">
                            Потребують повторної перевірки:{' '}
                            {s.diagnostics.unparsed +
                              s.diagnostics.invalid +
                              s.diagnostics.pageFailures}{' '}
                            із {s.diagnostics.attempted} переглянутих анонсів.
                          </p>
                        )}
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
            </fieldset>
            {change.error && !recovery && (
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
  interested,
  done,
}: {
  item: LeisureItem;
  data: LeisureWorkspace;
  busy: boolean;
  send: Send;
  plan: (sessionId?: string) => void;
  visit: () => void;
  familiar: () => void;
  interested: () => void;
  done: () => void;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [cinema, setCinema] = useState(data.settings.cinemas[0] ?? 'forum-lviv'),
    [date, setDate] = useState('');
  const sessions = item.sessions.filter(
    (s) =>
      s.cinemaSlug ===
        (cinema === 'forum-lviv'
          ? 'forum-lviv'
          : cinema === 'multiplex-victoria'
            ? cinema
            : 'king-cross-leopolis') &&
      (!date || toKyivInput(s.startAt).slice(0, 10) === date) &&
      Date.parse(s.startAt) > Date.parse(data.generatedAt),
  );
  const branch = item.sessions.length
    ? item.sessions.find(
        (s) =>
          s.cinemaSlug ===
          (cinema === 'forum-lviv'
            ? 'forum-lviv'
            : cinema === 'multiplex-victoria'
              ? cinema
              : 'king-cross-leopolis'),
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
  const location = branch ? { ...item, address: branch.address, venue: branch.cinema } : item;
  return (
    <>
      <LeisureMedia item={item} variant="detail" />
      <div className="leisure-caption">{categoryLabels[item.category]}</div>
      <h2 className="leisure-detail-title">{item.title}</h2>
      <p>{item.summary}</p>
      {data.records
        .filter((r) => r.kind === 'visit' && r.itemId === item.id)
        .map(
          (v) =>
            v.kind === 'visit' && (
              <div key={v.id} className="leisure-history-entry">
                <strong>Твої враження{v.visitedOn ? ' · ' + leisureDate(v.visitedOn) : ''}</strong>
                <p>
                  {v.rating === 'liked'
                    ? 'Сподобалось'
                    : v.rating === 'disliked'
                      ? 'Не сподобалось'
                      : v.rating === 'neutral'
                        ? 'Нормально'
                        : 'Без оцінки'}
                </p>
                {v.reason && <p className="leisure-impression">{v.reason}</p>}
              </div>
            ),
        )}
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
        {item.hours && !(item.placeId && inTelegram()) && (
          <p className="leisure-secondary">{item.hours}</p>
        )}
        <PlaceInfo item={item} now={data.generatedAt} />
        <ContentInfo item={item} />
        {item.registration && <p>Потрібна попередня реєстрація.</p>}
        {item.studentNote && <p className="leisure-secondary">{item.studentNote}</p>}
        {item.genre && <p className="leisure-secondary">Жанр: {item.genre}</p>}
        {item.age && <p className="leisure-secondary">Вікова категорія: {item.age}</p>}
        {item.endAt && (
          <p className="leisure-secondary">
            Завершення: {leisureDate(item.endAt)} · {leisureTime(item.endAt)}
          </p>
        )}
        {item.price.min != null &&
          item.price.max != null &&
          item.price.max > item.price.min &&
          item.price.basis !== 'unknown' && (
            <p className="leisure-secondary">
              Діапазон ціни за двох:{' '}
              {money(item.price.min * (item.price.basis === 'person' ? 2 : 1))} —{' '}
              {money(item.price.max * (item.price.basis === 'person' ? 2 : 1))}.
            </p>
          )}
        {item.status !== 'available' && (
          <p className="leisure-notice">
            {
              {
                'sold-out': 'У джерелі квитки розпродані',
                cancelled: 'Подію скасовано',
                postponed: 'Подію перенесено — перевір нову дату у джерелі',
                'schedule-pending': 'Розклад ще не підтверджено',
              }[item.status]
            }
          </p>
        )}
        {item.durationMinutes && (
          <p className="leisure-secondary">Тривалість: {item.durationMinutes} хв</p>
        )}
      </GlassCard>
      {item.category === 'cinema' &&
      (item.sessions.length > 0 || ['Планета кіно', 'Multiplex'].includes(item.source)) ? (
        <>
          <h3>Обери сеанс</h3>
          <div className="leisure-pills">
            {data.settings.cinemas.map((c) => (
              <Pill key={c} active={cinema === c} onClick={() => setCinema(c)}>
                {c === 'forum-lviv'
                  ? 'Forum Lviv'
                  : c === 'multiplex-victoria'
                    ? 'Multiplex'
                    : 'King Cross'}
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
              На цей вибір сеансів не підтверджено. Кінотеатр доповнює розклад поступово; перевір
              доступні покази у джерелі.
            </p>
          )}
          <p className="leisure-secondary">
            Купівля та вибір місць — на сторінці кінотеатру. Звір дату й час сеансу; студентська
            ціна залежить від умов показу.
          </p>
        </>
      ) : item.category === 'podcast' ? (
        <Button primary onClick={() => openLink(item.sourceUrl)}>
          Слухати випуск ↗
        </Button>
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
      <details className="leisure-manage">
        <summary>Мій досвід і вибір</summary>
        <div className="leisure-actions">
          <Button onClick={visit}>
            {item.category === 'cinema'
              ? 'Записати перегляд'
              : item.category === 'podcast'
                ? 'Записати прослуховування'
                : 'Записати відвідування'}
          </Button>
          {!['cinema', 'podcast'].includes(item.category) && (
            <Button onClick={familiar}>Були тут раніше</Button>
          )}
          <Button disabled={busy} onClick={() => setRejecting(true)}>
            Нецікаво
          </Button>
        </div>
        <div className="leisure-actions">
          <Button disabled={busy} onClick={interested}>
            {data.records.some(
              (r) => r.kind === 'reaction' && r.itemId === item.id && r.verdict === 'interested',
            )
              ? 'Уточнити інтерес'
              : 'Цікаво'}
          </Button>
        </div>
      </details>

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
  visits,
  editDuplicate,
  planId,
  busy,
  send,
  done,
}: {
  item: LeisureItem;
  existing?: LeisureVisit;
  visits: LeisureVisit[];
  editDuplicate: (id: string) => void;
  planId?: string;
  busy: boolean;
  send: Send;
  done: () => void;
}) {
  const baseRevision = useRef(existing?.revision);
  const [date, setDate] = useState(existing?.visitedOn ?? ''),
    [rating, setRating] = useState(existing?.rating ?? ''),
    [reason, setReason] = useState(existing?.reason ?? ''),
    [legacy, setLegacy] = useState(existing?.legacy ?? false),
    [allowRepeat, setAllowRepeat] = useState(false),
    [error, setError] = useState('');
  const duplicate =
    !existing && item.category === 'cinema' && date
      ? visits.find((v) => v.itemId === item.id && v.visitedOn === date)
      : null;
  return (
    <>
      <h2>
        {existing
          ? 'Твої враження'
          : item.category === 'cinema'
            ? 'Записати перегляд'
            : item.category === 'podcast'
              ? 'Записати прослуховування'
              : 'Записати відвідування'}
      </h2>
      <h3>{item.title}</h3>
      <label className="leisure-field">
        {item.category === 'cinema'
          ? 'Коли дивився? Необов’язково'
          : item.category === 'podcast'
            ? 'Коли слухав? Необов’язково'
            : 'Коли були? Необов’язково'}
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </label>
      <p className="leisure-secondary">
        Якщо минулу дату не пам’ятаєш, залиш порожньою. Новий похід — окремий запис цього самого
        місця.
      </p>
      {duplicate && (
        <div className="leisure-recovery">
          <strong>За цю дату вже є перегляд</strong>
          <p>{duplicate.reason || 'Можеш доповнити збережену оцінку й враження.'}</p>
          <Button onClick={() => editDuplicate(duplicate.id)}>Доповнити збережений відгук</Button>
          <label className="leisure-check">
            <input
              type="checkbox"
              checked={allowRepeat}
              onChange={(e) => setAllowRepeat(e.target.checked)}
            />
            Це окремий повторний перегляд
          </label>
        </div>
      )}
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
          placeholder={
            item.category === 'cinema'
              ? 'Що сподобалося? Наприклад: обожнюю Marvel.'
              : 'Їжа, атмосфера, шум, програма…'
          }
        />
      </label>
      <Button
        primary
        disabled={busy || (!!duplicate && !allowRepeat)}
        onClick={() => {
          setError('');
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
              allowRepeat: !!duplicate && allowRepeat,
            },
            item.id,
          )
            .then(done)
            .catch((e) => setError(e.message));
        }}
      >
        {busy
          ? 'Зберігаю…'
          : existing
            ? 'Оновити враження'
            : item.category === 'podcast'
              ? 'Зберегти прослуховування'
              : 'Зберегти відвідування'}
      </Button>
      {error && (
        <p role="alert" className="leisure-error">
          {error}
        </p>
      )}
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
          {!!p.alerts?.length && (
            <div className="leisure-notice" role="status">
              <strong>План потребує перевірки</strong>
              {p.alerts.map((alert) => (
                <p key={alert}>{alert}</p>
              ))}
            </div>
          )}
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
    [telegram, setTelegram] = useState(data.settings.telegram),
    [planAlerts, setPlanAlerts] = useState(data.settings.planAlerts),
    [clearConfirmed, setClearConfirmed] = useState(false);
  const [selection, setSelection] = useState(data.settings.selection);
  const toggle = (values: string[], value: string) =>
    values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
  return (
    <>
      <h2>Налаштування дозвілля</h2>
      <p className="leisure-secondary">
        Львів · нові місця, події й враження. Оновлення щопонеділка о 08:00 за Києвом.
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
      <label className="leisure-check">
        <input type="checkbox" checked={telegram} onChange={(e) => setTelegram(e.target.checked)} />
        Щотижневий дайджест новинок у Telegram
      </label>
      <label className="leisure-check">
        <input
          type="checkbox"
          checked={planAlerts}
          onChange={(e) => setPlanAlerts(e.target.checked)}
        />
        Повідомляти про важливі зміни погоджених планів
      </label>
      <SelectionSettings value={selection} onChange={setSelection} />
      <h3>Кінотеатри</h3>
      <div className="leisure-pills">
        {[
          ['forum-lviv', 'Forum Lviv'],
          ['king-cross', 'King Cross'],
          ['multiplex-victoria', 'Multiplex Victoria Gardens'],
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
        Понеділок, 08:00 за Києвом. Пільги враховуються лише там, де їх підтвердило джерело.
      </p>
      <p className="leisure-secondary">
        Зберігаються видані добірки й твої явні збереження, плани, відвідування та відгуки до
        видалення. Час перегляду й геолокація не збираються.
      </p>
      <Button
        primary
        disabled={busy || !categories.length || !cinemas.length}
        onClick={() =>
          void send('settings', {
            categories,
            cinemas,
            students,
            enabled,
            telegram,
            planAlerts,
            selection,
          })
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
