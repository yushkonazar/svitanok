import { adaptiveModel } from '../../../../core/checkin/model.mjs';
import { choiceAnswerLabel } from '../../../../core/checkin/choices.mjs';
import type { AdaptiveDay } from '../../../../core/checkin/adaptive-observations.mjs';
import { statePoints, slotNames } from './state-format.ts';
import { stateOutcomeValue } from '../../../../core/checkin/state-analysis.mjs';
import { stateBand, stateBandNames, stateSlots, stateSlotColors } from './state-series.ts';
import { StateLevel } from './StateVisuals.tsx';

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
                <span>Пропущений чек-ін</span>
              </div>
            );
          const model = adaptiveModel(record);
          const ratings = (['energy', 'mood'] as const).flatMap((metric) => {
            const value = stateOutcomeValue(day, `${slot}_${metric}`);
            return value == null ? [] : [{ metric, value }];
          });
          const score = slot === 'evening' ? stateOutcomeValue(day, 'satisfaction') : null;
          const fields = [
            ...new Map(
              [...(model.cards[slot] ?? []), ...model.details]
                .flatMap((card) => card.fields)
                .map((field) => [field.id, field]),
            ).values(),
          ].filter(
            (field) =>
              record[field.id] != null &&
              !(field.id === 'newPriorityV4' && record[field.id] === record.planTextV4),
          );
          const at = record.confirmedAtV3 ?? record.answeredAtV3;
          return (
            <details className="state-day-slot" key={slot}>
              <summary>
                <span>{slotNames[slot]}</span>
                {ratings.length > 0 && (
                  <span className="state-slot-ratings">
                    {ratings.map(({ metric, value }) => (
                      <span key={metric}>
                        <StateLevel value={value} color={stateSlotColors[index]!} />
                        {metric === 'mood' ? 'Настрій ' : ''}
                        {metric === 'energy'
                          ? stateBandNames.energy[stateBand(value, metric)]
                          : stateBandNames.mood[stateBand(value, metric)].toLowerCase()}
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
                {fields.map((field) => (
                  <dl key={field.id}>
                    <dt>{field.label}</dt>
                    <dd>{choiceAnswerLabel(field, record[field.id], record)}</dd>
                  </dl>
                ))}
                {(ratings.length > 0 || score != null) && (
                  <details className="state-subdetails state-exact">
                    <summary>Точні оцінки чек-іну</summary>
                    {ratings.map(({ metric, value }) => (
                      <p key={metric} className="state-caption">
                        {metric === 'energy' ? 'Енергія' : 'Настрій'} · {statePoints(value)}
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
