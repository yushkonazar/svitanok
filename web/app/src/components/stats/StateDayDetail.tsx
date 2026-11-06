import { adaptiveModel } from '../../../../core/checkin/model.mjs';
import { choiceAnswerLabel } from '../../../../core/checkin/choices.mjs';
import type { AdaptiveDay } from '../../../../core/checkin/adaptive-observations.mjs';
import { recordedCheckinStepsV4 } from '../../../../core/checkin/adaptive-v4.mjs';
import type { Field } from '../../../../core/checkin/catalog.mjs';
import { statePoints, slotNames } from './state-format.ts';
import { stateOutcomeValue } from '../../../../core/checkin/state-analysis.mjs';
import {
  CHECKIN_FLOW_REVISION,
  recordedStateRating,
  STATE_RATING_LABELS,
  stateRatingBand,
} from '../../../../core/checkin/state-ratings.mjs';
import { stateBandNames, stateSlots, stateSlotColors } from './state-series.ts';
import { StateLevel } from './StateVisuals.tsx';
import type { CheckinSlot } from '../../api/schema.ts';

function DayAnswer({ field, record }: { field: Field; record: Record<string, unknown> }) {
  return (
    <dl>
      <dt>{field.label}</dt>
      <dd>{choiceAnswerLabel(field, record[field.id], record)}</dd>
    </dl>
  );
}

function DayTopics({ slot, record }: { slot: CheckinSlot; record: Record<string, unknown> }) {
  return recordedCheckinStepsV4(slot, record).map((step) => {
    const answers = [step, ...step.followups]
      .flatMap((card) => card.fields)
      .filter(
        (field) =>
          record[field.id] != null &&
          field.id !== 'workRangeV4' &&
          !(field.id.endsWith('StatusV4') && record[field.id] === 'known') &&
          !(field.id === 'newPriorityV4' && record[field.id] === record.planTextV4),
      );
    if (!answers.length) return null;
    const main = answers.filter(
      (field) => step.primary.includes(field.id) || field.id === 'sleepMinutesV4',
    );
    const supporting = answers.filter((field) => !main.includes(field));
    return (
      <section key={step.id} className="state-answer-topic" aria-label={step.title}>
        <h3>{step.title}</h3>
        {main.map((field) => (
          <DayAnswer key={field.id} field={field} record={record} />
        ))}
        {!!supporting.length && (
          <details className="state-subdetails state-answer-context">
            <summary>Уточнення</summary>
            <div>
              {supporting.map((field) => (
                <DayAnswer key={field.id} field={field} record={record} />
              ))}
            </div>
          </details>
        )}
      </section>
    );
  });
}

export function StateDayDetail({ day }: { day: AdaptiveDay }) {
  const hasRecords = stateSlots.some((slot) => day[slot].confirmed);
  return (
    <div className="state-day-detail">
      {!hasRecords ? (
        <p className="state-empty">
          Цього дня немає підтверджених чек-інів. Пропуск не змінює середні оцінки.
        </p>
      ) : (
        stateSlots.map((slot, index) => {
          const record = day[slot];
          if (!record.confirmed)
            return (
              <div className="state-day-slot state-day-missing" key={slot}>
                <span>{slotNames[slot]}</span>
                <span>Без запису</span>
              </div>
            );
          const revised = record.flowRevisionV4 === CHECKIN_FLOW_REVISION;
          const model = revised ? null : adaptiveModel(record);
          const ratings = (['energy', 'mood'] as const).flatMap((metric) => {
            const rating = recordedStateRating(record, metric);
            return rating == null ? [] : [{ metric, ...rating }];
          });
          const score = slot === 'evening' ? stateOutcomeValue(day, 'satisfaction') : null;
          const fields = [
            ...new Map(
              [...(model?.cards[slot] ?? []), ...(model?.details ?? [])]
                .flatMap((card) => card.fields)
                .map((field) => [field.id, field]),
            ).values(),
          ].filter(
            (field) =>
              record[field.id] != null &&
              !['energyLevelV4', 'moodLevelV4'].includes(field.id) &&
              !(field.id === 'newPriorityV4' && record[field.id] === record.planTextV4),
          );
          const at = record.confirmedAtV3 ?? record.answeredAtV3;
          return (
            <details className="state-day-slot" key={slot}>
              <summary>
                <span>{slotNames[slot]}</span>
                {ratings.length > 0 && (
                  <span className="state-slot-ratings">
                    {ratings.map(({ metric, value, scale }) => (
                      <span key={metric}>
                        <StateLevel value={value} scale={scale} color={stateSlotColors[index]!} />
                        {stateBandNames[metric][stateRatingBand({ value, scale })]}
                      </span>
                    ))}
                  </span>
                )}
              </summary>
              <div className="state-day-answers">
                {typeof at === 'string' && Number.isFinite(Date.parse(at)) && (
                  <p className="state-caption">
                    Записано{' '}
                    {new Date(at).toLocaleString('uk-UA', {
                      timeZone: 'Europe/Kyiv',
                      day: 'numeric',
                      month: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}{' '}
                    · Київ
                  </p>
                )}
                {record.planTextV4 && (
                  <p className="state-plan">
                    <span>Актуальний план</span>
                    <b>{record.planTextV4}</b>
                  </p>
                )}
                {revised ? (
                  <DayTopics slot={slot} record={record} />
                ) : (
                  fields.map((field) => <DayAnswer key={field.id} field={field} record={record} />)
                )}
                {!revised && (ratings.length > 0 || score != null) && (
                  <details className="state-subdetails state-exact">
                    <summary>Точні оцінки чек-іну</summary>
                    {ratings.map(({ metric, value, scale }) => (
                      <p key={metric} className="state-caption">
                        {metric === 'energy' ? 'Енергія' : 'Настрій'} ·{' '}
                        {scale === 8 ? STATE_RATING_LABELS[metric][value - 1] : statePoints(value)}
                      </p>
                    ))}
                    {score != null && (
                      <p className="state-caption">Оцінка дня · {statePoints(score)}</p>
                    )}
                  </details>
                )}
              </div>
            </details>
          );
        })
      )}
    </div>
  );
}
