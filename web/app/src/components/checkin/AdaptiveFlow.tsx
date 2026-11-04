import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  CHECKIN_CARDS_V4,
  FOLLOWUP_CARDS_V4,
  contextualCardV4,
  currentPlanV4,
  nextSleepDateV4,
  eligibleFollowupsV4,
  followupsV4,
  fieldVisibleV4,
  validValueV4,
  coreCompleteV4,
  answerLabelV4,
  type AdaptiveContext,
} from '../../../../core/checkin/adaptive-v4.mjs';
import type { Card, Field, CheckinPreferences } from '../../../../core/checkin/catalog.mjs';
import type { CheckinSlot } from '../../api/schema.ts';
import { FieldInput } from './CheckinV2Screen.tsx';
import { haptic, setVerticalSwipes } from '../../telegram.ts';
import { usePresentation } from '../../lib/presentation.ts';

type Answers = Record<string, unknown>;
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
  const core = CHECKIN_CARDS_V4[slot].map((c) => contextualCardV4(c, answers, context));
  const complete = (c: Card) =>
    c.fields
      .filter((f) => !f.optional && fieldVisibleV4(f, answers))
      .every((f) => validValueV4(f, answers[f.id]));
  const [step, setStep] = useState(() => {
    const first = core.findIndex(
      (c) =>
        !complete(c) ||
        (c.fields.every((f) => f.optional) &&
          !c.fields.some((f) => answers[f.id] != null) &&
          !(Array.isArray(answers.visitedStepsV4) && answers.visitedStepsV4.includes(c.id))),
    );
    return first < 0 ? core.length : first;
  });
  const [adding, setAdding] = useState(false);
  const stage = useRef<HTMLDivElement>(null),
    previousStep = useRef(step);
  useEffect(() => {
    setVerticalSwipes(false);
    return () => setVerticalSwipes(true);
  }, []);
  useLayoutEffect(() => {
    if (previousStep.current === step) return;
    previousStep.current = step;
    stage.current?.scrollIntoView?.({ block: 'start', behavior: 'auto' });
  }, [step]);
  const eligible = eligibleFollowupsV4(slot, answers, context);
  const branches = followupsV4(slot, answers, context).sort(
    (a, b) =>
      FOLLOWUP_CARDS_V4.findIndex((c) => c.id === a.id) -
      FOLLOWUP_CARDS_V4.findIndex((c) => c.id === b.id),
  );
  const card = core[step];
  const owner = (id: string) =>
    id.startsWith('sleep') || id === 'bedtime'
      ? 'sleep'
      : ['mood-context', 'energy-context', 'morning-context'].includes(id)
        ? 'state'
        : id === 'plan-blocked'
          ? slot === 'afternoon'
            ? 'progress'
            : 'outcome'
          : id.startsWith('development-') || id.startsWith('missing-')
            ? 'outcome'
            : 'context';
  const answered = (c: Card) =>
    c.fields.some((f) => fieldVisibleV4(f, answers) && answers[f.id] != null);
  const plan = currentPlanV4(context);
  const formatTime = (at: unknown) =>
    typeof at === 'string'
      ? new Date(at).toLocaleTimeString('uk-UA', {
          timeZone: 'Europe/Kyiv',
          hour: '2-digit',
          minute: '2-digit',
        })
      : '';
  const renderField = (f: Field) => {
    if (!fieldVisibleV4(f, answers)) return null;
    return (
      <FieldInput key={f.id} field={f} answers={answers} p={p} date={date} onChange={onChange} />
    );
  };
  const visibleFields = (card?.fields ?? []).filter((f) => fieldVisibleV4(f, answers));
  const primaryFields = visibleFields.filter(
    (f) =>
      card?.id === 'context' ||
      !f.optional ||
      f.id === 'newPriorityV4' ||
      (f.id.endsWith('Other') &&
        !card?.fields.find((parent) => parent.id === f.when?.key)?.optional),
  );
  const optionalFields = visibleFields.filter((f) => !primaryFields.includes(f));
  const renderCoreField = (f: Field) => (
    <div key={f.id}>
      {renderField(f)}
      {['developmentPlanV4', 'developmentActualV4'].includes(f.id) && (
        <p className="renewal-chart-note mt-2">
          Навчання — поза окремим курсом. Читання для себе не враховуй вдруге в навчанні чи курсі.
        </p>
      )}
      {f.id === 'bedtimePlanV4' && nextSleepDateV4(nowMs, answers.bedtimePlanV4) && (
        <p className="renewal-chart-note mt-2">
          План на {nextSleepDateV4(nowMs, answers.bedtimePlanV4)?.split('-').reverse().join('.')} ·
          час за Києвом
        </p>
      )}
    </div>
  );
  const optionalTitles: Record<string, string> = {
    sleep: 'Додати тривалість сну',
    priority: 'Додати наміри або конкретну справу',
    time: 'Деталі про вільний час',
    'next-sleep': 'Наступний сон і замітка дня',
  };
  const detail = (c: Card, expanded = false) => (
    <details key={c.id} className="checkin-followup" open={expanded || undefined}>
      <summary>
        <span>{c.title}</span>
        <span className="text-xs text-tx3">{answered(c) ? 'Додано' : 'За бажанням'}</span>
      </summary>
      <div className="flex flex-col gap-5 mt-4">{c.fields.map(renderField)}</div>
    </details>
  );
  function addTopic(id: string) {
    onChange('detailTopicsV4', [
      ...new Set([...(Array.isArray(answers.detailTopicsV4) ? answers.detailTopicsV4 : []), id]),
    ]);
    const target = core.findIndex((c) => c.id === owner(id));
    if (target >= 0) setStep(target);
    setAdding(false);
  }
  const moreDetails = (
    <>
      <button
        type="button"
        className="renewal-link checkin-add-details"
        aria-expanded={adding}
        onClick={() => setAdding(!adding)}
      >
        ＋ Додати деталі
      </button>
      {adding && (
        <div className="checkin-detail-topics" aria-label="Доступні теми уточнень">
          {eligible
            .filter((c) => !card || owner(c.id) === card.id)
            .map((c) => (
              <button
                type="button"
                className="renewal-secondary"
                key={c.id}
                onClick={() => addTopic(c.id)}
              >
                {c.title}
                {answered(c) ? ' ✓' : ''}
              </button>
            ))}
          {!eligible.length && (
            <p className="renewal-chart-note">Теми з’являться після основних відповідей.</p>
          )}
        </div>
      )}
    </>
  );
  return (
    <div
      className="checkin-adaptive-flow"
      onClickCapture={(event) => {
        if (event.detail === 0 || !(event.target instanceof Element)) return;
        const control = event.target.closest('button, summary'),
          focused = document.activeElement;
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
        <span>{card ? `Крок ${step + 1} із ${core.length}` : 'Перевір відповіді'}</span>
      </div>
      <div className="renewal-progress">
        <span style={{ width: `${Math.min(step / core.length, 1) * 100}%` }} />
      </div>
      <p role="status" className="checkin-save-status">
        {saveStatus || '\u00a0'}
      </p>
      <div ref={stage} className="checkin-adaptive-stage">
        {card ? (
          <div className="checkin-adaptive-card" key={card.id}>
            <h3 className="text-xl font-semibold">{card.title}</h3>
            {explanations && card.help && <p className="renewal-chart-note">{card.help}</p>}
            {['progress', 'outcome'].includes(card.id) && (
              <p className="renewal-inset text-sm">
                <b>
                  {plan.source}
                  {plan.at ? ` · ${formatTime(plan.at)}` : ''}
                </b>
                <br />
                {plan.text}
              </p>
            )}
            {card.id === 'next-sleep' && (
              <p className="renewal-chart-note">
                Запис за {date.slice(8)}.{date.slice(5, 7)}. Наступний основний сон може початися
                після опівночі; це ще не запис про його тривалість.
              </p>
            )}
            {primaryFields.map(renderCoreField)}
            {card.id === 'state' &&
              ['energy', 'mood'].some(
                (id) =>
                  typeof answers[id] === 'number' && typeof context.previous?.[id] === 'number',
              ) && (
                <div className="checkin-state-delta" aria-label="Порівняння з попереднім записом">
                  <small>
                    Порівняно з підтвердженим записом
                    {formatTime(context.previous.confirmedAtV3 ?? context.previous.answeredAtV3)
                      ? ` о ${formatTime(context.previous.confirmedAtV3 ?? context.previous.answeredAtV3)}`
                      : ''}
                  </small>
                  {(['energy', 'mood'] as const).map((id) =>
                    typeof answers[id] === 'number' &&
                    typeof context.previous?.[id] === 'number' ? (
                      <span key={id}>
                        {id === 'energy' ? 'Енергія' : 'Настрій'}: {String(context.previous[id])} →{' '}
                        <b>{String(answers[id])}</b>
                      </span>
                    ) : null,
                  )}
                </div>
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
                disabled={!complete(card)}
                onClick={() => {
                  if (card.fields.every((f) => f.optional))
                    onChange('visitedStepsV4', [
                      ...new Set([
                        ...(Array.isArray(answers.visitedStepsV4) ? answers.visitedStepsV4 : []),
                        card.id,
                      ]),
                    ]);
                  setStep(step + 1);
                  setAdding(false);
                  haptic('light');
                }}
              >
                {step === core.length - 1 ? 'Перевірити' : 'Далі →'}
              </button>
            </div>
            {optionalFields.length > 0 && (
              <details className="checkin-followup">
                <summary>
                  {optionalTitles[card.id] ?? 'Додати до відповіді'}
                  <span className="text-xs text-tx3">За бажанням</span>
                </summary>
                <div className="flex flex-col gap-5 mt-4">
                  {optionalFields.map(renderCoreField)}
                </div>
              </details>
            )}
            {branches
              .filter((c) => owner(c.id) === card.id)
              .map((c) =>
                detail(
                  c,
                  Array.isArray(answers.detailTopicsV4) && answers.detailTopicsV4.includes(c.id),
                ),
              )}
            {moreDetails}
          </div>
        ) : (
          <>
            {slot !== 'morning' && (
              <p className="renewal-inset text-sm">
                <b>
                  {plan.source}
                  {plan.at ? ` · ${formatTime(plan.at)}` : ''}
                </b>
                <br />
                {plan.text}
              </p>
            )}
            {explanations && (
              <p className="renewal-muted">
                Перевір основні відповіді. Уточнення можна додати за бажанням.
              </p>
            )}
            {[...core, ...branches].filter(answered).map((c) => (
              <button
                type="button"
                key={c.id}
                className="renewal-inset text-left checkin-review-row"
                onClick={() =>
                  setStep(
                    Math.max(
                      0,
                      core.findIndex(
                        (x) => x.id === (core.some((x) => x.id === c.id) ? c.id : owner(c.id)),
                      ),
                    ),
                  )
                }
              >
                <b>
                  {c.title} <span aria-hidden="true">↗</span>
                </b>
                <span className="flex flex-col gap-1 text-sm text-tx2 mt-2">
                  {c.fields
                    .filter((f) => fieldVisibleV4(f, answers) && answers[f.id] != null)
                    .map((f) => (
                      <span key={f.id}>
                        {f.label}: {answerLabelV4(f, answers[f.id])}
                      </span>
                    ))}
                </span>
              </button>
            ))}
            {moreDetails}
            <button
              type="button"
              className="renewal-button"
              disabled={pending || !coreCompleteV4(slot, answers)}
              onClick={onConfirm}
            >
              {pending ? 'Зберігаю…' : 'Підтвердити чек-ін'}
            </button>
            <button type="button" className="renewal-link" onClick={() => setStep(core.length - 1)}>
              ← Повернутися
            </button>
          </>
        )}
      </div>
    </div>
  );
}
