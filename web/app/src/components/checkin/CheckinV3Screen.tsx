import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FieldInput } from './CheckinV2Screen.tsx';
import {
  CHECKIN_CARDS_V3,
  FOLLOWUP_CARDS_V3,
  adaptiveContext,
  adaptivePreferences,
  followupsV3,
  fieldVisibleV3,
  validValueV3,
  clearHiddenV3,
  coreCompleteV3,
  answerLabelV3,
  type AdaptiveContext,
} from '../../../../core/checkin/adaptive.mjs';
import { useStats, useSaveCheckin, useSettings, useSaveSettings } from '../../api/hooks.ts';
import { resetCheckinDemo } from '../../api/checkin-demo.ts';
import { type CheckinSlot } from '../../api/schema.ts';
import { inTelegram, haptic, setVerticalSwipes } from '../../telegram.ts';
import { PageHeading } from '../ui/PageHeading.tsx';
import { LoadingSkeleton, ErrorState } from '../ui/states.tsx';
import { useTick } from '../../lib/useTick.ts';
import { kyivParts, shiftDate } from '../../../../core/finance/planning.mjs';
import {
  checkinClock,
  type Card,
  type Field,
  type CheckinPreferences as Preferences,
} from '../../../../core/checkin/catalog.mjs';
import { BLOCKS as LEGACY_BLOCKS } from './questions.ts';
import { AdaptivePreferences } from './AdaptivePreferences.tsx';

type Answers = Record<string, unknown>;
const slots: CheckinSlot[] = ['morning', 'afternoon', 'evening'];
const names = { morning: 'Ранок', afternoon: 'День', evening: 'Вечір' };
const icons = { morning: '🌅', afternoon: '☀️', evening: '🌙' };
const draftKey = (date: string, slot: CheckinSlot) =>
  `svitanok:checkin-v3:${inTelegram() ? 'private' : 'demo'}:${date}:${slot}`;
function readDraft(key: string): Answers {
  try {
    const v = JSON.parse(sessionStorage.getItem(key) ?? '{}');
    return v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length <= 100 ? v : {};
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

export function AdaptiveFlow({
  slot,
  date,
  answers,
  morning,
  p,
  onChange,
  onConfirm,
  pending,
  context,
}: {
  slot: CheckinSlot;
  date: string;
  answers: Answers;
  morning: Answers;
  p: Preferences;
  onChange: (key: string, v: unknown) => void;
  onConfirm: () => void;
  pending: boolean;
  context: AdaptiveContext;
}) {
  const [step, setStep] = useState(0);
  const stage = useRef<HTMLDivElement>(null);
  const previousStep = useRef(step);
  useEffect(() => {
    // The native Telegram pull gesture can resize/move its WKWebView while
    // the user is scrolling a long answer. Restore it when the flow closes.
    setVerticalSwipes(false);
    return () => setVerticalSwipes(true);
  }, []);
  useLayoutEffect(() => {
    if (previousStep.current === step) return;
    previousStep.current = step;
    // Only explicit card navigation scrolls. Answers, saves and timer ticks
    // never restore an older viewport or restart a smooth scroll.
    stage.current?.scrollIntoView?.({ block: 'start', behavior: 'auto' });
  }, [step]);
  const core = CHECKIN_CARDS_V3[slot] ?? [];
  // Selection prioritizes answered details; presentation must not move them
  // past each other as answers arrive while the user is scrolling.
  const branches = followupsV3(slot, answers, context).sort(
    (a, b) => FOLLOWUP_CARDS_V3.indexOf(a) - FOLLOWUP_CARDS_V3.indexOf(b),
  );
  const card = core[step];
  const owner = (id: string) =>
    id.startsWith('sleep') || id === 'bedtime'
      ? 'sleep'
      : id.startsWith('energy') || id === 'mood-context'
        ? 'state'
        : id === 'plan-blocked'
          ? slot === 'afternoon'
            ? 'progress'
            : 'outcome'
          : ['learning', 'reading', 'development-blocked'].includes(id)
            ? 'outcome'
            : 'context';
  const complete = (c: Card) =>
    c.fields
      .filter((f) => !f.optional && fieldVisibleV3(f, answers))
      .every((f) => validValueV3(f, answers[f.id]));
  const renderField = (f: Field) =>
    f.type === 'text' ? (
      <details key={f.id}>
        <summary className="renewal-link">Додати конкретний результат · за бажанням</summary>
        <div className="mt-3">
          <FieldInput field={f} answers={answers} p={p} date={date} onChange={onChange} />
        </div>
      </details>
    ) : (
      <FieldInput key={f.id} field={f} answers={answers} p={p} date={date} onChange={onChange} />
    );
  const review = [...core, ...branches];
  return (
    <div
      className="checkin-adaptive-flow"
      onClickCapture={(event) => {
        // WebKit may scroll a retained button/summary back into view when
        // conditional details change. Pointer taps do not need that focus;
        // keyboard and assistive activation (detail=0) keep normal focus.
        if (event.detail === 0 || !(event.target instanceof Element)) return;
        const control = event.target.closest('button, summary');
        const focused = document.activeElement;
        if (
          control instanceof HTMLElement &&
          event.currentTarget.contains(control) &&
          focused instanceof HTMLElement &&
          event.currentTarget.contains(focused)
        )
          focused.blur();
      }}
    >
      <div className="flex justify-between text-xs text-tx3">
        <span>{card ? `Картка ${step + 1} із ${core.length}` : 'Перевір відповіді'}</span>
        <span>Уточнення за відповідями</span>
      </div>
      <div className="renewal-progress">
        <span style={{ width: `${Math.min(step / core.length, 1) * 100}%` }} />
      </div>
      <div ref={stage} className="checkin-adaptive-stage">
        {card ? (
          <div key={card.id} className="checkin-adaptive-card">
            <h3 className="text-xl font-semibold">{card.title}</h3>
            {card.help && <p className="renewal-chart-note">{card.help}</p>}
            {['progress', 'outcome'].includes(card.id) && (
              <p className="renewal-inset text-sm">
                Ранковий намір:{' '}
                {morning.priorityV3
                  ? answerLabelV3(
                      CHECKIN_CARDS_V3.morning.find((c) => c.id === 'priority')!.fields[0],
                      morning.priorityV3,
                    )
                  : 'не записаний'}
                {morning.priorityStepV3 ? ` · ${String(morning.priorityStepV3)}` : ''}
              </p>
            )}
            {card.fields.map(renderField)}
            {branches
              .filter((c) => owner(c.id) === card.id)
              .map((c) => (
                <section key={c.id} className="checkin-followup" aria-label={c.title}>
                  <p className="text-xs text-a2">УТОЧНЕННЯ ДО ВІДПОВІДІ · можна пропустити</p>
                  <h4 className="font-semibold">{c.title}</h4>
                  {c.id === 'bedtime' && (
                    <p className="renewal-chart-note">
                      Планував лягти о {String(context.previousEvening.bedtimePlanV3)}
                    </p>
                  )}
                  {c.fields.map(renderField)}
                </section>
              ))}
            <div className="renewal-form-grid">
              <button
                className="renewal-secondary"
                disabled={!step}
                onClick={() => setStep(step - 1)}
              >
                ← Назад
              </button>
              <button
                className="renewal-button"
                disabled={!complete(card)}
                onClick={() => {
                  setStep(step + 1);
                  haptic('light');
                }}
              >
                {step === core.length - 1 ? 'Перевірити' : 'Далі →'}
              </button>
            </div>
          </div>
        ) : (
          <>
            <p className="renewal-muted">
              Основні відповіді готові. Уточнення не обов’язкові; пропуск не стане нулем.
            </p>
            {review.map((c) => (
              <button
                key={c.id}
                className="renewal-inset text-left"
                onClick={() =>
                  setStep(
                    Math.max(
                      0,
                      core.findIndex((x) => x.id === (core.includes(c) ? c.id : owner(c.id))),
                    ),
                  )
                }
              >
                <b>{c.title}</b>
                <div className="mt-2 flex flex-col gap-1 text-sm text-tx2">
                  {c.fields
                    .filter((f) => fieldVisibleV3(f, answers) && answers[f.id] != null)
                    .map((f) => (
                      <span key={f.id}>
                        {f.label}: {answerLabelV3(f, answers[f.id])}
                      </span>
                    ))}
                </div>
              </button>
            ))}
            <button
              className="renewal-button"
              disabled={pending || !coreCompleteV3(slot, answers)}
              onClick={onConfirm}
            >
              {pending ? 'Зберігаю…' : 'Підтвердити чек-ін'}
            </button>
            <button className="renewal-link" onClick={() => setStep(core.length - 1)}>
              ← Повернутися
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function AnswerSummary({ slot, answers }: { slot: CheckinSlot; answers: Answers }) {
  const legacy = answers.questionVersion !== 3;
  const old = LEGACY_BLOCKS.find((b) => b.id === slot);
  return (
    <details className="mt-3">
      <summary className="renewal-link cursor-pointer">
        Переглянути {legacy ? 'попередні ' : ''}відповіді
      </summary>
      <div className="mt-3 flex flex-col gap-3">
        {legacy
          ? Object.entries(answers)
              .filter(([id]) => !['confirmed', 'questionVersion'].includes(id))
              .map(([id, v]) => (
                <p className="text-sm" key={id}>
                  {old?.qs.find((q) => q.id === id)?.t ?? id}:{' '}
                  {Array.isArray(v) ? v.join(', ') : String(v)}
                </p>
              ))
          : [...(CHECKIN_CARDS_V3[slot] ?? []), ...FOLLOWUP_CARDS_V3]
              .flatMap((c) => c.fields)
              .filter((f) => answers[f.id] != null)
              .map((f) => (
                <p className="text-sm" key={f.id}>
                  {f.label}: <b>{answerLabelV3(f, answers[f.id])}</b>
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

export function CheckinV3Screen() {
  const query = useStats(),
    settings = useSettings(),
    saveSettings = useSaveSettings(),
    save = useSaveCheckin(),
    now = useTick(1000);
  const [preview, setPreview] = useState<CheckinSlot>('morning'),
    [drafts, setDrafts] = useState<Record<string, Answers>>({}),
    [early, setEarly] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const upgraded = useRef(false);
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
  if (query.isError || !query.data)
    return (
      <ErrorState
        message={query.error?.message ?? 'Не вдалося завантажити чек-ін'}
        onRetry={() => query.refetch()}
      />
    );
  if (inTelegram() && settings.isError)
    return (
      <ErrorState
        message="Не вдалося завантажити налаштування чек-іну"
        onRetry={() => settings.refetch()}
      />
    );
  if (inTelegram() && saveSettings.isError)
    return (
      <ErrorState
        message="Не вдалося увімкнути новий чек-ін"
        onRetry={() => {
          upgraded.current = false;
          saveSettings.reset();
        }}
      />
    );
  if (
    inTelegram() &&
    (!settings.data || settings.data.settings.checkin?.version !== 3 || saveSettings.isPending)
  )
    return <LoadingSkeleton />;
  const s = query.data.stats,
    demo = !inTelegram(),
    date = s.checkinDate ?? kyivParts(now).date;
  const p = adaptivePreferences(settings.data?.settings.checkin);
  const active = demo ? preview : s.checkinSlot;
  const answers = (slot: CheckinSlot): Answers => {
    const stored = s.checkinToday?.[slot] ?? {};
    const prior = stored.confirmed || stored.questionVersion === 3 ? stored : {};
    return prior.confirmed
      ? prior
      : { ...prior, ...(drafts[draftKey(date, slot)] ?? readDraft(draftKey(date, slot))) };
  };
  const current = active ? answers(active) : {};
  const elapsed = Math.floor((now - query.dataUpdatedAt) / 60000),
    left = Math.max(0, (s.checkinSlotEndsIn ?? 0) - elapsed);
  const gap = demo ? 0 : Math.max(0, (s.checkinGapIn ?? 0) - elapsed);
  const allowed = !gap || early === `${date}:${active}`;
  const nextSeconds = Math.max(
    0,
    Math.ceil(
      (s.checkinNextIn ?? checkinClock(kyivParts(now).hour * 60).nextIn) * 60 -
        (now - query.dataUpdatedAt) / 1000,
    ),
  );
  function change(slot: CheckinSlot, key: string, value: unknown) {
    const old = answers(slot);
    const changed = { ...old, [key]: value, questionVersion: 3 };
    const next = clearHiddenV3(
      slot,
      changed,
      adaptiveContext({ ...s.checkinRaw.records, [date]: s.checkinToday ?? {} }, date, slot),
    );
    // Explicit clears cross the merge boundary, including values hidden by a changed gate.
    for (const k of Object.keys(old)) if (!(k in next) && k.endsWith('V3')) next[k] = null;
    const storageKey = draftKey(date, slot);
    writeDraft(storageKey, next);
    setDrafts((v) => ({ ...v, [storageKey]: next }));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(
      () => save.mutate({ slot, dateKey: demo ? undefined : date, answers: next }),
      1200,
    );
  }
  function confirm(slot: CheckinSlot) {
    if (timer.current) clearTimeout(timer.current);
    save.mutate(
      {
        slot,
        dateKey: demo ? undefined : date,
        answers: { ...answers(slot), questionVersion: 3, confirmed: true },
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
          window.scrollTo({ top: 0, behavior: 'smooth' });
        },
      },
    );
  }
  return (
    <div className="checkin-screen flex flex-col gap-5">
      <PageHeading
        eyebrow="ПАУЗА ДЛЯ СЕБЕ"
        title="Помітити себе."
        accent="У своєму ритмі."
        description="Три пов’язані записи. Чіткі питання й уточнення лише за потреби."
      />
      {demo && (
        <section className="renewal-inset">
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
        </section>
      )}
      {save.error && (
        <p role="alert" className="renewal-inset text-neg">
          {save.error.message}
        </p>
      )}
      {(!active || current.confirmed === true) && (
        <section className="renewal-card text-center">
          <span className="renewal-pill">
            {active ? '✓ Чек-ін підтверджено' : 'Пауза між чек-інами'}
          </span>
          <h2 className="text-xl font-semibold mt-4">Можна повернутись до дня</h2>
          <p className="renewal-muted mt-2">
            Наступне вікно —{' '}
            {active === 'morning'
              ? `день о ${p.schedule.afternoon}`
              : active === 'afternoon'
                ? `вечір о ${p.schedule.evening}`
                : `ранок о ${p.schedule.morning}`}
          </p>
          <div className="renewal-focus-clock" role="timer">
            {String(Math.floor(nextSeconds / 3600)).padStart(2, '0')}:
            {String(Math.floor((nextSeconds % 3600) / 60)).padStart(2, '0')}:
            {String(nextSeconds % 60).padStart(2, '0')}
          </div>
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
      {slots.map((slot) => {
        const value = answers(slot),
          live = slot === active,
          confirmed = value.confirmed === true;
        return (
          <section key={`${date}:${slot}`} className="renewal-card" data-checkin-slot={slot}>
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
                      : `Чернетка · ще ${left} хв`
                    : `Від ${p.schedule[slot]}`}
              </span>
            </div>
            {live && !confirmed && allowed ? (
              <div className="mt-5">
                <AdaptiveFlow
                  key={`${date}:${slot}`}
                  slot={slot}
                  date={date}
                  answers={value}
                  morning={answers('morning')}
                  p={p}
                  pending={save.isPending}
                  onChange={(key, v) => change(slot, key, v)}
                  onConfirm={() => confirm(slot)}
                  context={adaptiveContext(
                    { ...s.checkinRaw.records, [date]: s.checkinToday ?? {} },
                    date,
                    slot,
                  )}
                />
              </div>
            ) : Object.keys(value).length ? (
              <AnswerSummary slot={slot} answers={value} />
            ) : (
              <p className="renewal-chart-note mt-3">Відповіді з’являться після проходження.</p>
            )}
          </section>
        );
      })}
      <section className="renewal-card">
        <h2 className="font-semibold">Ритм тижня</h2>
        <p className="renewal-chart-note mt-1">
          Підтверджені чек-іни; чернетки не позначені як завершені.
        </p>
        <div className="renewal-week-grid mt-4">
          {Array.from({ length: 7 }, (_, i) => {
            const d = shiftDate(date, i - 6),
              rec = d === date ? s.checkinToday : s.checkinRaw.records[d];
            const count = slots.filter((slot) => rec?.[slot]?.confirmed).length;
            return (
              <div key={d}>
                <small>
                  {new Date(d + 'T12:00:00Z').toLocaleDateString('uk-UA', { weekday: 'short' })}
                </small>
                <span data-filled={count > 0}>{count ? `${count}/3` : '·'}</span>
                <small>{d.slice(8)}</small>
              </div>
            );
          })}
        </div>
      </section>
      <AdaptivePreferences />
    </div>
  );
}
