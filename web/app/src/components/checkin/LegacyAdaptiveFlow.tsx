import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FieldInput } from './CheckinV2Screen.tsx';
import {
  CHECKIN_CARDS_V3,
  FOLLOWUP_CARDS_V3,
  followupsV3,
  fieldVisibleV3,
  validValueV3,
  coreCompleteV3,
  answerLabelV3,
  type AdaptiveContext,
} from '../../../../core/checkin/adaptive.mjs';
import type {
  Card,
  Field,
  CheckinPreferences as Preferences,
} from '../../../../core/checkin/catalog.mjs';
import type { CheckinSlot } from '../../api/schema.ts';
import { haptic, setVerticalSwipes } from '../../telegram.ts';
type Answers = Record<string, unknown>;
export function LegacyAdaptiveFlow({
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
  nowMs?: number;
  saveStatus?: string;
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
    (a, b) =>
      FOLLOWUP_CARDS_V3.findIndex((c) => c.id === a.id) -
      FOLLOWUP_CARDS_V3.findIndex((c) => c.id === b.id),
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
