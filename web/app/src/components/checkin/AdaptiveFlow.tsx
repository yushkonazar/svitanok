import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  CHECKIN_CARDS_V4,
  FOLLOWUP_CARDS_V4,
  checkinStepsV4,
  checkinStepCompleteV4,
  currentPlanV4,
  nextSleepDateV4,
  fieldVisibleV4,
  clearHiddenV4,
  type AdaptiveContext,
} from '../../../../core/checkin/adaptive-v4.mjs';
import { choiceAnswerLabel } from '../../../../core/checkin/choices.mjs';
import {
  recordedStateRating,
  stateRatingDirection,
} from '../../../../core/checkin/state-ratings.mjs';
import type { Card, Field, CheckinPreferences } from '../../../../core/checkin/catalog.mjs';
import type { CheckinSlot } from '../../api/schema.ts';
import { ChoiceFieldInput } from './ChoiceFieldInput.tsx';
import { haptic, setVerticalSwipes } from '../../telegram.ts';
import { usePresentation } from '../../lib/presentation.ts';

type Answers = Record<string, unknown>;
const fieldsBySlot = Object.fromEntries(
  Object.entries(CHECKIN_CARDS_V4).map(([slot, cards]) => [
    slot,
    new Set([...cards, ...FOLLOWUP_CARDS_V4].flatMap((c) => c.fields.map((f) => f.id))),
  ]),
);

export function AdaptiveFlow({
  slot,
  date,
  answers,
  p,
  onChange,
  onConfirm,
  pending,
  context,
  saveStatus = '',
  nowMs,
}: {
  slot: CheckinSlot;
  date: string;
  answers: Answers;
  morning?: Answers;
  p: CheckinPreferences;
  onChange: (key: string, value: unknown) => void;
  onConfirm: () => void;
  pending: boolean;
  context: AdaptiveContext;
  saveStatus?: string;
  nowMs: number;
}) {
  const { explanations } = usePresentation();
  const steps = checkinStepsV4(slot, answers, context);
  const [step, setStep] = useState(() => {
    const first = steps.findIndex((card) => !checkinStepCompleteV4(card, answers));
    return first < 0 ? steps.length : first;
  });
  const stage = useRef<HTMLDivElement>(null);
  const previousStep = useRef(step);
  useEffect(() => {
    setVerticalSwipes(false);
    return () => setVerticalSwipes(true);
  }, []);
  useLayoutEffect(() => {
    if (previousStep.current === step) return;
    previousStep.current = step;
    stage.current?.scrollIntoView?.({ block: 'start', behavior: 'auto' });
  }, [step]);
  useEffect(() => {
    const cleaned = clearHiddenV4(slot, answers, context);
    const changed = Object.keys(answers).find(
      (key) =>
        fieldsBySlot[slot]?.has(key) &&
        !['energy', 'mood', 'workRangeV4'].includes(key) &&
        answers[key] != null &&
        JSON.stringify(answers[key]) !== JSON.stringify(cleaned[key]),
    );
    if (changed) onChange(changed, cleaned[changed] ?? null);
  }, [slot, answers, context, onChange]);

  const card = steps[step];
  const firstIncomplete = steps.findIndex((item) => !checkinStepCompleteV4(item, answers));
  const plan = currentPlanV4(context);
  const planAt =
    plan.at &&
    new Date(plan.at).toLocaleTimeString('uk-UA', {
      timeZone: 'Europe/Kyiv',
      hour: '2-digit',
      minute: '2-digit',
    });
  const planContext = (
    <p className="renewal-inset text-sm">
      <b>
        {plan.source}
        {planAt ? ` · ${planAt}` : ''}
      </b>
      <br />
      {plan.text}
    </p>
  );
  const renderField = (f: Field) => (
    <div key={f.id}>
      <ChoiceFieldInput
        field={f}
        choices={context.choices}
        answers={answers}
        p={p}
        date={date}
        onChange={onChange}
      />
      {f.id === 'bedtimePlanV4' && nextSleepDateV4(nowMs, answers.bedtimePlanV4) && (
        <p className="renewal-chart-note mt-2">
          План на {nextSleepDateV4(nowMs, answers.bedtimePlanV4)?.split('-').reverse().join('.')} ·
          час за Києвом
        </p>
      )}
    </div>
  );
  const visible = (section: Card) => section.fields.filter((f) => fieldVisibleV4(f, answers));
  const inlineSection = (id: string, title: string, fields: Field[]) =>
    fields.length > 0 && (
      <section className="checkin-inline-followup" key={id} aria-label={title}>
        <h4>{title}</h4>
        {fields.map(renderField)}
      </section>
    );
  const mainFields = card ? visible(card).filter((f) => card.primary.includes(f.id)) : [];
  const secondaryFields = card ? visible(card).filter((f) => !mainFields.includes(f)) : [];
  const metric = card?.id === 'energy' || card?.id === 'mood' ? card.id : null;
  const current = metric && recordedStateRating(answers, metric);
  const prior = metric && recordedStateRating(context.previous, metric);
  const previousAt = context.previous.confirmedAtV3 ?? context.previous.answeredAtV3;
  const previousTime =
    typeof previousAt === 'string' && Number.isFinite(Date.parse(previousAt))
      ? new Date(previousAt).toLocaleTimeString('uk-UA', {
          timeZone: 'Europe/Kyiv',
          hour: '2-digit',
          minute: '2-digit',
        })
      : null;
  const direction = current && prior ? stateRatingDirection(prior, current) : null;
  const deltaText =
    direction == null
      ? ''
      : metric === 'energy'
        ? direction > 0
          ? 'сил більше'
          : direction < 0
            ? 'сил менше'
            : 'сили на тому самому рівні'
        : direction > 0
          ? 'настрій кращий'
          : direction < 0
            ? 'настрій важчий'
            : 'настрій на тому самому рівні';

  return (
    <div
      className="checkin-adaptive-flow"
      onClickCapture={(event) => {
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
        <span>{card ? `Крок ${step + 1} із ${steps.length}` : 'Перевір відповіді'}</span>
      </div>
      <div className="renewal-progress">
        <span style={{ width: `${Math.min(step / Math.max(1, steps.length), 1) * 100}%` }} />
      </div>
      <p role="status" className="checkin-save-status">
        {saveStatus || '\u00a0'}
      </p>
      <div ref={stage} className="checkin-adaptive-stage">
        {card ? (
          <div className="checkin-adaptive-card" key={card.id}>
            <h3 className="text-xl font-semibold">{card.title}</h3>
            {explanations && card.help && <p className="renewal-chart-note">{card.help}</p>}
            {['progress', 'outcome'].includes(card.id) && planContext}
            {mainFields.map(renderField)}
            {deltaText && (
              <p className="renewal-chart-note" aria-label="Порівняння з попереднім записом">
                Від попереднього чек-іну{previousTime ? ` о ${previousTime}` : ''} {deltaText}.
              </p>
            )}
            {inlineSection('details', 'Уточнення', secondaryFields)}
            {card.followups.map((section) =>
              inlineSection(section.id, section.title, visible(section)),
            )}
            <div className="renewal-form-grid checkin-flow-actions">
              <button
                type="button"
                className="renewal-secondary"
                disabled={!step}
                onClick={() => setStep(step - 1)}
              >
                ← Назад
              </button>
              <button
                type="button"
                className="renewal-button"
                disabled={!checkinStepCompleteV4(card, answers)}
                onClick={() => {
                  setStep(step + 1);
                  haptic('light');
                }}
              >
                {step === steps.length - 1 ? 'Перевірити' : 'Далі →'}
              </button>
            </div>
          </div>
        ) : (
          <>
            {slot !== 'morning' && planContext}
            {steps.map((item, index) => (
              <button
                type="button"
                key={item.id}
                className="renewal-inset text-left checkin-review-row"
                onClick={() => setStep(index)}
              >
                <b>
                  {item.title} <span aria-hidden="true">↗</span>
                </b>
                <span className="flex flex-col gap-1 text-sm text-tx2 mt-2">
                  {[item, ...item.followups]
                    .flatMap(visible)
                    .filter((f) => answers[f.id] != null)
                    .map((f) => (
                      <span key={f.id}>
                        {f.label} · {choiceAnswerLabel(f, answers[f.id], answers)}
                      </span>
                    ))}
                </span>
              </button>
            ))}
            {firstIncomplete >= 0 && (
              <button
                type="button"
                className="renewal-secondary"
                onClick={() => setStep(firstIncomplete)}
              >
                Завершити крок «{steps[firstIncomplete]?.title}»
              </button>
            )}
            <button
              type="button"
              className="renewal-button"
              disabled={pending || firstIncomplete >= 0}
              onClick={onConfirm}
            >
              {pending ? 'Зберігаю…' : 'Підтвердити чек-ін'}
            </button>
            <button
              type="button"
              className="renewal-link"
              onClick={() => setStep(steps.length - 1)}
            >
              ← Повернутися
            </button>
          </>
        )}
      </div>
    </div>
  );
}
