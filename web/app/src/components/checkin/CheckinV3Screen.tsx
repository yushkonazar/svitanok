import { LegacyAdaptiveFlow } from './LegacyAdaptiveFlow.tsx';
import { AdaptiveFlow } from './AdaptiveFlow.tsx';
import { usePresentation } from '../../lib/presentation.ts';
import { Link } from 'react-router-dom';
import { adaptiveModel } from '../../../../core/checkin/model.mjs';
import { useEffect, useRef, useState } from 'react';
import { adaptivePreferences, answerLabelV4 } from '../../../../core/checkin/adaptive-v4.mjs';
import {
  useStats,
  useSaveCheckin,
  useSettings,
  useSaveSettings,
  useExtendCheckin,
} from '../../api/hooks.ts';
import { isSessionExpired } from '../../api/client.ts';
import { resetCheckinDemo } from '../../api/checkin-demo.ts';
import { type CheckinSlot } from '../../api/schema.ts';
import { inTelegram, haptic, setVerticalSwipes } from '../../telegram.ts';
import { LoadingSkeleton, ErrorState } from '../ui/states.tsx';
import { useTick } from '../../lib/useTick.ts';
import { kyivParts, shiftDate } from '../../../../core/finance/planning.mjs';
import { BLOCKS as LEGACY_BLOCKS } from './questions.ts';
import { AdaptivePreferences } from './AdaptivePreferences.tsx';
import { useCheckinProgress } from '../../lib/useCheckinProgress.ts';
import {
  checkinDayProgress,
  checkinDayRecord,
  openCheckinWindows,
  preferredCheckinWindow,
} from '../../lib/checkinProgress.ts';
import { CheckinDayProgress } from './CheckinDayProgress.tsx';
import { CHECKIN_CARDS } from '../../../../core/checkin/catalog.mjs';

type Answers = Record<string, unknown>;
type Completion = {
  date: string;
  slot: CheckinSlot;
  answers: Answers;
  height: number;
  feedbackTop: number;
  phase: 'saving' | 'success' | 'leaving';
};
const slots: CheckinSlot[] = ['morning', 'afternoon', 'evening'];
const names = { morning: 'Ранок', afternoon: 'День', evening: 'Вечір' };
const icons = { morning: '🌅', afternoon: '☀️', evening: '🌙' };
const draftKey = (date: string, slot: CheckinSlot) =>
  `svitanok:checkin-v4:${inTelegram() ? 'private' : 'demo'}:${date}:${slot}`;
function readDraft(key: string): Answers {
  try {
    const v = JSON.parse(sessionStorage.getItem(key) ?? '{}');
    return v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length <= 160 ? v : {};
  } catch {
    return {};
  }
}
function writeDraft(key: string, value?: Answers) {
  try {
    if (value) sessionStorage.setItem(key, JSON.stringify(value));
    else sessionStorage.removeItem(key);
  } catch {
    /* session storage optional */
  }
}

export { AdaptiveFlow } from './AdaptiveFlow.tsx';

function hasAnswers(slot: CheckinSlot, answers: Answers) {
  if (answers.questionVersion === 2)
    return (CHECKIN_CARDS[slot] ?? []).some((c) => c.fields.some((f) => answers[f.id] != null));
  if (![3, 4].includes(Number(answers.questionVersion)))
    return LEGACY_BLOCKS.find((b) => b.id === slot)?.qs.some((f) => answers[f.id] != null) ?? false;
  const model = adaptiveModel(answers);
  return [...(model.cards[slot] ?? []), ...model.details].some((c) =>
    c.fields.some((f) => answers[f.id] != null),
  );
}
function AnswerSummary({ slot, answers }: { slot: CheckinSlot; answers: Answers }) {
  const legacy = ![2, 3, 4].includes(Number(answers.questionVersion));
  const model = adaptiveModel(answers);
  const catalog =
    answers.questionVersion === 2
      ? (CHECKIN_CARDS[slot] ?? [])
      : [...(model.cards[slot] ?? []), ...model.details];
  const old = LEGACY_BLOCKS.find((b) => b.id === slot);
  return (
    <details className="mt-3">
      <summary className="renewal-link cursor-pointer">
        Переглянути {legacy ? 'попередні ' : ''}відповіді
      </summary>
      <div className="mt-3 flex flex-col gap-3">
        {slot !== 'morning' && typeof answers.planTextV4 === 'string' && (
          <p className="renewal-inset text-sm">
            <b>{String(answers.planSourceV4 ?? 'План')}</b>
            <br />
            {answers.planTextV4}
          </p>
        )}
        {legacy
          ? Object.entries(answers)
              .filter(([id]) => !['confirmed', 'questionVersion'].includes(id))
              .map(([id, v]) => (
                <p className="text-sm" key={id}>
                  {old?.qs.find((q) => q.id === id)?.t ?? id}:{' '}
                  {Array.isArray(v) ? v.join(', ') : String(v)}
                </p>
              ))
          : catalog
              .flatMap((c) => c.fields)
              .filter((f) => answers[f.id] != null)
              .map((f) => (
                <p className="text-sm" key={f.id}>
                  {f.label}: <b>{answerLabelV4(f, answers[f.id])}</b>
                </p>
              ))}
        {typeof answers.answeredAtV3 === 'string' && (
          <p className="renewal-chart-note">
            Остання відповідь:{' '}
            {new Date(String(answers.answeredAtV3)).toLocaleString('uk-UA', {
              timeZone: 'Europe/Kyiv',
            })}{' '}
            · Київ
          </p>
        )}
      </div>
    </details>
  );
}

export function CheckinV3Screen({
  target,
}: {
  target?: { date: string | null; slot: string | null };
}) {
  const query = useStats(),
    settings = useSettings(),
    saveSettings = useSaveSettings(),
    save = useSaveCheckin(),
    extend = useExtendCheckin(),
    now = useTick(1000);
  const checkin = useCheckinProgress(query, now);
  const { explanations } = usePresentation();
  const [historyDate, setHistoryDate] = useState<string | null>(null);
  const [preview, setPreview] = useState<CheckinSlot>('morning'),
    [drafts, setDrafts] = useState<Record<string, Answers>>({}),
    [early, setEarly] = useState<string | null>(null),
    [selection, setSelection] = useState<{ date: string; slot: CheckinSlot } | null>(null);
  const [localPending, setLocalPending] = useState<{ date: string; slot: CheckinSlot } | null>(
    null,
  );
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingDraft = useRef<{ slot: CheckinSlot; dateKey?: string; answers: Answers } | null>(
    null,
  );
  const upgraded = useRef(false);
  const [completion, setCompletion] = useState<Completion | null>(null);
  const confirming = useRef(false);
  const slotNodes = useRef<Partial<Record<CheckinSlot, HTMLElement>>>({});
  useEffect(() => {
    if (!completion || completion.phase === 'saving') return;
    setVerticalSwipes(false);
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    if (completion.phase === 'success') {
      const pause = setTimeout(
        () => setCompletion((c) => (c ? { ...c, phase: 'leaving' } : null)),
        reduced ? 0 : 450,
      );
      return () => {
        clearTimeout(pause);
        setVerticalSwipes(true);
      };
    }
    // Keep the old section height until the viewport is at the top. Removing
    // a long form first lets WebKit clamp scrollY before smooth scrolling starts.
    const from = window.scrollY;
    let start: number | undefined;
    let frame: number;
    const tick = (time: number) => {
      start ??= time;
      const progress = reduced ? 1 : Math.min(1, (time - start) / 650);
      window.scrollTo({ top: from * Math.pow(1 - progress, 3), behavior: 'auto' });
      if (progress < 1) frame = requestAnimationFrame(tick);
      else {
        confirming.current = false;
        setCompletion(null);
      }
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      setVerticalSwipes(true);
    };
  }, [completion]);
  useEffect(() => {
    if (!settings.data || upgraded.current || settings.data.settings.checkin?.version === 3) return;
    upgraded.current = true;
    saveSettings.mutate(
      { checkin: { ...adaptivePreferences(settings.data.settings.checkin), version: 3 } },
      {
        onSuccess: () => {
          query.refetch();
        },
        onError: () => {
          /* Explicit retry only: never loop on an unavailable settings API. */
        },
      },
    );
  }, [settings.data, saveSettings, query]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  if (query.isLoading) return <LoadingSkeleton />;
  if (!query.data || isSessionExpired(query.error))
    return (
      <ErrorState
        message={query.error?.message ?? 'Не вдалося завантажити чек-ін'}
        onRetry={() => query.refetch()}
      />
    );
  if (inTelegram() && settings.isError && (!settings.data || isSessionExpired(settings.error)))
    return (
      <ErrorState
        message="Не вдалося завантажити налаштування чек-іну"
        onRetry={() => settings.refetch()}
      />
    );
  if (
    inTelegram() &&
    saveSettings.isError &&
    (settings.data?.settings.checkin?.version !== 3 || isSessionExpired(saveSettings.error))
  )
    return (
      <ErrorState
        message="Не вдалося увімкнути новий чек-ін"
        onRetry={() => {
          upgraded.current = false;
          saveSettings.reset();
        }}
      />
    );
  if (inTelegram() && (!settings.data || settings.data.settings.checkin?.version !== 3))
    return <LoadingSkeleton />;
  const s = query.data.stats,
    demo = !inTelegram();
  const elapsedMs = Math.max(0, now - (query.data.receivedAtMs ?? query.dataUpdatedAt));
  const serverNow = checkin.serverNow;
  const openWindows = openCheckinWindows(s, serverNow);
  const defaultWindow = preferredCheckinWindow(s, serverNow);
  // Pin an existing unfinished draft once; a later server window must not replace it.
  // This guarded adjustment changes its own condition on the next render.
  if (!demo && !selection && !target?.date && defaultWindow) {
    const value = checkinDayRecord(s, defaultWindow.dateKey)?.[defaultWindow.slot];
    if (value && !value.confirmed && hasAnswers(defaultWindow.slot, value))
      setSelection({ date: defaultWindow.dateKey, slot: defaultWindow.slot });
  }

  const selected =
    selection ??
    (target?.date && slots.includes(target.slot as CheckinSlot)
      ? { date: target.date, slot: target.slot as CheckinSlot }
      : null);
  const selectedWindow = selected
    ? s.checkinWindows?.find((w) => w.dateKey === selected.date && w.slot === selected.slot)
    : defaultWindow;
  const date = demo
    ? (s.checkinDate ?? kyivParts(now).date)
    : (selected?.date ?? selectedWindow?.dateKey ?? s.checkinDate ?? kyivParts(now).date);
  const p = adaptivePreferences(settings.data?.settings.checkin);
  const active = demo
    ? preview
    : selectedWindow
      ? openWindows.includes(selectedWindow)
        ? selectedWindow.slot
        : null
      : selected
        ? null
        : s.checkinWindows
          ? null
          : s.checkinSlot;
  const day = checkinDayRecord(s, date, kyivParts(serverNow).date);
  const dayProgress = checkinDayProgress(s, serverNow, date, checkin.pending);
  const answers = (slot: CheckinSlot): Answers => {
    const stored = day?.[slot] ?? {};
    const prior = stored.confirmed || [3, 4].includes(Number(stored.questionVersion)) ? stored : {};
    const key = draftKey(date, slot);
    let local = drafts[key] ?? readDraft(key);
    if (!Object.keys(local).length && !Object.keys(prior).length)
      local = readDraft(key.replace('checkin-v4:', 'checkin-v3:'));
    return prior.confirmed ? prior : { questionVersion: 4, ...prior, ...local };
  };
  const current = completion?.date === date ? completion.answers : active ? answers(active) : {};
  // useTick can lag behind a just-received snapshot. Never turn a zero gap into +1 minute.
  // Optimistic autosaves update dataUpdatedAt, but must not restart the server countdown.
  const elapsed = Math.floor(elapsedMs / 60000),
    left = selectedWindow
      ? Math.max(0, Math.ceil((Date.parse(selectedWindow.endAt) - serverNow) / 60000))
      : Math.max(0, (s.checkinSlotEndsIn ?? 0) - elapsed);
  const gap = demo ? 0 : Math.max(0, (selectedWindow?.gapIn ?? s.checkinGapIn ?? 0) - elapsed);
  const allowed = !gap || early === `${date}:${active}`;
  const nextWindow = s.checkinWindows
    ?.filter((w) => Date.parse(w.startAt) > serverNow)
    .sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt))[0];
  function selectWindow(dateKey: string, slot: CheckinSlot) {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const draft = pendingDraft.current;
    pendingDraft.current = null;
    setLocalPending(null);
    if (draft) save.mutate(draft);
    setSelection({ date: dateKey, slot });
    extend.reset();
  }
  function change(slot: CheckinSlot, key: string, value: unknown) {
    const old = answers(slot);
    const revision = old.questionVersion === 3 ? 3 : 4;
    const changed = { ...old, [key]: value, questionVersion: revision };
    const model = adaptiveModel(changed);
    const next = model.clearHidden(
      slot,
      changed,
      model.context({ ...s.checkinRaw.records, [date]: day ?? {} }, date, slot),
    );
    // Explicit clears cross the merge boundary, including values hidden by a changed gate.
    for (const k of Object.keys(old))
      if (!(k in next) && (k.endsWith('V3') || k.endsWith('V4') || k.endsWith('V4Other')))
        next[k] = null;
    const storageKey = draftKey(date, slot);
    writeDraft(storageKey, next);
    setDrafts((v) => ({ ...v, [storageKey]: next }));
    if (timer.current) clearTimeout(timer.current);
    pendingDraft.current = { slot, dateKey: demo ? undefined : date, answers: next };
    setLocalPending({ date, slot });
    timer.current = setTimeout(() => {
      timer.current = null;
      const draft = pendingDraft.current;
      pendingDraft.current = null;
      setLocalPending(null);
      if (draft) save.mutate(draft);
    }, 1200);
  }
  function confirm(slot: CheckinSlot) {
    if (confirming.current) return;
    confirming.current = true;
    const bounds = slotNodes.current[slot]?.getBoundingClientRect();
    const height = bounds?.height ?? 0;
    setCompletion({
      date,
      slot,
      answers: answers(slot),
      height,
      feedbackTop: Math.max(
        24,
        Math.min(Math.max(24, height - 180), -(bounds?.top ?? 0) + window.innerHeight * 0.3),
      ),
      phase: 'saving',
    });
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    pendingDraft.current = null;
    setLocalPending(null);
    save.mutate(
      {
        slot,
        dateKey: demo ? undefined : date,
        answers: { ...answers(slot), confirmed: true },
      },
      {
        onSuccess: () => {
          writeDraft(draftKey(date, slot));
          setDrafts((v) => {
            const copy = { ...v };
            delete copy[draftKey(date, slot)];
            return copy;
          });
          haptic('success');
          setCompletion((c) => (c ? { ...c, phase: 'success' } : null));
        },
        onError: () => {
          confirming.current = false;
          setCompletion(null);
        },
      },
    );
  }
  return (
    <div className="checkin-screen flex flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Чек-ін</h1>
        <button
          type="button"
          className="renewal-link text-sm"
          onClick={() => {
            const panel = document.getElementById('checkin-preferences');
            if (panel instanceof HTMLDetailsElement) {
              panel.open = true;
              panel.scrollIntoView({ block: 'start', behavior: 'auto' });
            }
          }}
        >
          Розклад і нагадування
        </button>
      </div>
      <section>
        <p className="renewal-chart-note mb-2">
          {date === kyivParts(serverNow).date
            ? 'Чек-іни за сьогодні'
            : `Чек-іни за ${date.slice(8)}.${date.slice(5, 7)}`}
        </p>
        <CheckinDayProgress
          progress={dayProgress}
          selectedSlot={active}
          onSelect={(slot) => {
            if (demo) setPreview(slot);
            else if (openWindows.some((w) => w.dateKey === date && w.slot === slot))
              selectWindow(date, slot);
            requestAnimationFrame(() =>
              slotNodes.current[slot]?.scrollIntoView?.({ block: 'start', behavior: 'auto' }),
            );
          }}
        />
      </section>
      {demo && (
        <details className="renewal-inset">
          <summary className="renewal-link cursor-pointer">Демо · змінити час доби</summary>
          <p className="renewal-chart-note mb-3">
            Демо: обери час доби. Особисті записи не змінюються.
          </p>
          <div className="renewal-segments">
            {slots.map((slot) => (
              <button key={slot} aria-pressed={preview === slot} onClick={() => setPreview(slot)}>
                {names[slot]}
              </button>
            ))}
          </div>
          <button
            className="renewal-link mt-3"
            onClick={() => {
              resetCheckinDemo();
              slots.forEach((slot) => writeDraft(draftKey(date, slot)));
              setDrafts({});
              query.refetch();
            }}
          >
            Скинути демо чек-іну
          </button>
        </details>
      )}
      {!demo && (selected || openWindows.length > 1) && (
        <section className="renewal-inset">
          <p className="renewal-chart-note">
            Чек-ін за {date.slice(8)}.{date.slice(5, 7)}.
            {openWindows.length > 1 && ' Продовжений слот не замінює наступний.'}
          </p>
          {selected && !active && (
            <p role="status" className="mt-2">
              Цей чек-ін уже закритий. Збережені відповіді залишилися.
            </p>
          )}
          <div className="renewal-segments mt-3">
            {openWindows.map((w) => (
              <button
                key={`${w.dateKey}:${w.slot}`}
                aria-pressed={date === w.dateKey && active === w.slot}
                onClick={() => selectWindow(w.dateKey, w.slot)}
              >
                {names[w.slot]} · {w.dateKey.slice(8)}.{w.dateKey.slice(5, 7)}
              </button>
            ))}
          </div>
        </section>
      )}
      {!demo && active && !current.confirmed && selectedWindow && (
        <section className="renewal-inset">
          <p role="status" className="renewal-chart-note">
            {selectedWindow.extended ? 'Продовжено один раз' : 'Відкрито'} до{' '}
            {new Date(selectedWindow.endAt).toLocaleString('uk-UA', {
              timeZone: 'Europe/Kyiv',
              day: '2-digit',
              month: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
            })}
            .
          </p>
          {selectedWindow.extensionAvailable && !extend.isSuccess && (
            <button
              className="renewal-secondary mt-3"
              disabled={extend.isPending || save.isPending}
              onClick={() => {
                setSelection({ date, slot: active });
                extend.mutate({ dateKey: date, slot: active, key: selectedWindow.key });
              }}
            >
              {extend.isPending ? 'Продовжую…' : 'Ще годину'}
            </button>
          )}
          {extend.isSuccess && !selectedWindow.extended && (
            <p role="status" className="renewal-chart-note mt-2">
              Продовжено. Оновлюю термін закриття.
              <button className="renewal-link ml-2" onClick={() => void query.refetch()}>
                Оновити
              </button>
            </p>
          )}
          {extend.error && (
            <p role="alert" className="text-neg mt-2">
              {extend.error.message}
            </p>
          )}
        </section>
      )}
      {!completion && (!active || current.confirmed === true) && (
        <section className="renewal-inset checkin-waiting">
          <span className="renewal-pill">
            {active ? '✓ Чек-ін підтверджено' : 'Пауза між чек-інами'}
          </span>
          {nextWindow ? (
            <p className="renewal-muted mt-2">
              Наступний{' '}
              {{ morning: 'ранковий', afternoon: 'денний', evening: 'вечірній' }[nextWindow.slot]}{' '}
              чек-ін ·{' '}
              {new Date(nextWindow.startAt).toLocaleString('uk-UA', {
                timeZone: 'Europe/Kyiv',
                day: '2-digit',
                month: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </p>
          ) : (
            <p className="renewal-chart-note mt-2">
              {demo
                ? 'Обери інший час доби в демо вище.'
                : 'Час наступного вікна поки недоступний.'}
            </p>
          )}
        </section>
      )}
      {gap > 0 && !current.confirmed && !allowed && (
        <section className="renewal-card">
          <h2 className="font-semibold">Дай дню трохи часу</h2>
          <p className="renewal-muted mt-3">
            Від попереднього запису ще не минуло три години. Рекомендований наступний запис — через{' '}
            {gap} хв.
          </p>
          <button className="renewal-secondary mt-4" onClick={() => setEarly(`${date}:${active}`)}>
            Хочу записати стан зараз
          </button>
        </section>
      )}
      {[...slots]
        .sort((a, b) => Number(b === active) - Number(a === active))
        .map((slot) => {
          const finishing =
            completion?.slot === slot && completion.date === date ? completion : null;
          const value = finishing
              ? { ...finishing.answers, confirmed: finishing.phase !== 'saving' }
              : answers(slot),
            live = slot === active || finishing != null,
            confirmed = value.confirmed === true;
          const Flow = value.questionVersion === 3 ? LegacyAdaptiveFlow : AdaptiveFlow;
          return (
            <section
              key={`${date}:${slot}`}
              ref={(node) => {
                slotNodes.current[slot] = node ?? undefined;
              }}
              className={`renewal-card checkin-slot-card ${live && !confirmed ? 'is-live' : 'is-folded'}`}
              style={finishing ? { minHeight: finishing.height } : undefined}
              data-checkin-slot={slot}
              data-completion={finishing?.phase}
              aria-busy={finishing?.phase === 'saving' || undefined}
              onClickCapture={() => {
                if (live && !demo && !selected && s.checkinWindows) setSelection({ date, slot });
              }}
            >
              <div className="flex items-center justify-between gap-3">
                <h2 className="font-semibold">
                  {icons[slot]} {names[slot]}
                </h2>
                <span className="renewal-chart-note">
                  {confirmed
                    ? '✓ Підтверджено'
                    : live
                      ? demo
                        ? 'Демо проходження'
                        : `${hasAnswers(slot, value) ? 'Чернетка' : 'Відкрито'} · ще ${left} хв`
                      : dayProgress.items.find((item) => item.slot === slot)?.description}
                </span>
              </div>
              {finishing && finishing.phase !== 'saving' ? (
                <div
                  className="checkin-completion"
                  style={{ top: finishing.feedbackTop }}
                  role="status"
                  aria-live="polite"
                >
                  <svg className="checkin-completion-mark" viewBox="0 0 48 48" aria-hidden="true">
                    <circle cx="24" cy="24" r="21" />
                    <path d="m14 24 7 7 14-15" />
                  </svg>
                  <h3 className="text-lg font-semibold">Чек-ін збережено</h3>
                  <p className="renewal-chart-note">
                    {names[slot]} · відповіді вже у твоїй статистиці
                  </p>
                </div>
              ) : live && !confirmed && allowed ? (
                <div className="mt-5" inert={finishing?.phase === 'saving' || undefined}>
                  {value.questionVersion === 3 && (
                    <p className="renewal-chart-note mb-4">
                      Цю чернетку почато в попередній формі. Заверши її зі збереженими відповідями;
                      наступний запис відкриється в оновленій.
                    </p>
                  )}
                  <Flow
                    key={`${date}:${slot}`}
                    slot={slot}
                    nowMs={serverNow}
                    date={date}
                    answers={value}
                    morning={answers('morning')}
                    p={p}
                    pending={save.isPending || finishing?.phase === 'saving'}
                    saveStatus={
                      localPending?.slot === slot && localPending.date === date
                        ? 'Чернетка на пристрої · очікує збереження'
                        : save.variables?.slot === slot && save.isPending
                          ? 'Зберігаю чернетку…'
                          : save.variables?.slot === slot && save.error
                            ? 'Чернетка на пристрої · не вдалося синхронізувати'
                            : save.variables?.slot === slot && save.isSuccess
                              ? 'Чернетку збережено'
                              : 'Відповіді зберігаються автоматично'
                    }
                    onChange={(key, v) => change(slot, key, v)}
                    onConfirm={() => confirm(slot)}
                    context={adaptiveModel(value).context(
                      { ...s.checkinRaw.records, [date]: day ?? {} },
                      date,
                      slot,
                    )}
                  />
                </div>
              ) : hasAnswers(slot, value) ? (
                <AnswerSummary slot={slot} answers={value} />
              ) : (
                <>
                  {explanations && (
                    <p className="renewal-chart-note mt-3">
                      Відповіді з’являться після проходження.
                    </p>
                  )}
                </>
              )}
            </section>
          );
        })}
      {save.error && (
        <p role="alert" className="renewal-inset text-neg">
          {save.error.message}
        </p>
      )}
      {(query.isError || settings.isError) && (
        <section role="status" className="renewal-inset">
          <p className="renewal-chart-note">
            Не вдалося оновити дані. Твої відповіді збережені в чернетці; можна продовжувати.
          </p>
          <button
            className="renewal-link mt-3"
            onClick={() => {
              if (query.isError) void query.refetch();
              if (settings.isError) void settings.refetch();
            }}
          >
            Повторити оновлення
          </button>
        </section>
      )}
      <section className="renewal-card">
        <h2 className="font-semibold">Ритм тижня</h2>
        {explanations && (
          <p className="renewal-chart-note mt-1">
            Підтверджені чек-іни; чернетки не позначені як завершені.
          </p>
        )}
        <div className="renewal-week-grid mt-4">
          {Array.from({ length: 7 }, (_, i) => {
            const d = shiftDate(date, i - 6);
            const count = checkinDayProgress(s, serverNow, d, checkin.pending).completed;
            return (
              <button
                type="button"
                key={d}
                className="checkin-history-day"
                aria-pressed={historyDate === d}
                aria-label={`Переглянути чек-іни за ${d}`}
                onClick={() => setHistoryDate(historyDate === d ? null : d)}
              >
                <small>
                  {new Date(d + 'T12:00:00Z').toLocaleDateString('uk-UA', { weekday: 'short' })}
                </small>
                <span data-filled={count > 0}>{count ? `${count}/3` : '·'}</span>
                <small>{d.slice(8)}</small>
              </button>
            );
          })}
        </div>
      </section>
      {historyDate && (
        <section className="renewal-card" aria-label="Історія чек-інів">
          <div className="flex justify-between">
            <h2 className="font-semibold">
              {historyDate.slice(8)}.{historyDate.slice(5, 7)} · записи
            </h2>
            <button className="renewal-link" onClick={() => setHistoryDate(null)}>
              Закрити
            </button>
          </div>
          {slots.map((slot) => {
            const entry = checkinDayRecord(s, historyDate, kyivParts(serverNow).date)?.[slot] ?? {};
            return (
              <div className="renewal-inset mt-3" key={slot}>
                <b>{names[slot]}</b> ·{' '}
                {entry.confirmed
                  ? '✓ Підтверджено'
                  : Object.keys(entry).length
                    ? 'Чернетка · не підтверджено'
                    : 'Немає запису'}
                {Object.keys(entry).length > 0 && <AnswerSummary slot={slot} answers={entry} />}
              </div>
            );
          })}
          <Link to="/stats" className="renewal-link mt-4">
            Динаміка й детальні спостереження ↗
          </Link>
        </section>
      )}
      <AdaptivePreferences />
    </div>
  );
}
