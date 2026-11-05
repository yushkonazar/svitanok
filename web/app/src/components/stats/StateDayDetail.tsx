import { adaptiveModel } from '../../../../core/checkin/model.mjs';
import { choiceAnswerLabel } from '../../../../core/checkin/choices.mjs';
import type { AdaptiveDay } from '../../../../core/checkin/adaptive-observations.mjs';
import { stateDate, slotNames } from './state-format.ts';

export function StateDayDetail({ day }: { day: AdaptiveDay }) {
  const hasRecords = (['morning', 'afternoon', 'evening'] as const).some(
    (slot) => day[slot].confirmed,
  );
  return (
    <div className="state-day-detail">
      <h3>{stateDate(day.date)} · відповіді й контекст</h3>
      {!hasRecords ? (
        <p className="state-empty">
          Цього дня немає підтверджених чек-інів. Пропуск не змінює середні оцінки.
        </p>
      ) : (
        (['morning', 'afternoon', 'evening'] as const).map((slot) => {
          const record = day[slot],
            model = adaptiveModel(record);
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
                <span>{record.confirmed ? '✓' : 'немає запису'}</span>
              </summary>
              {record.confirmed && (
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
                </div>
              )}
            </details>
          );
        })
      )}
    </div>
  );
}
