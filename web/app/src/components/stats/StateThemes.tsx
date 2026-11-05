import { useState } from 'react';
import type { StateReport } from '../../../../core/checkin/state-analysis.mjs';
import { stateDistribution } from '../../../../core/checkin/state-analysis.mjs';
import { ObservationChart } from '../charts/ObservationChart.tsx';
import { StateDates, StateDistributionView } from './StateComparisons.tsx';
import { stateNumber, stateSleep } from './state-format.ts';

export function StateThemes({
  report: r,
  onDay,
  explanations,
}: {
  report: StateReport;
  onDay: (date: string) => void;
  explanations: boolean;
}) {
  const [learning, setLearning] = useState('study');
  const sleep = r.overview.find((m) => m.id === 'sleep')!;
  const naps = r.current.filter(
    (d) => d.evening.questionVersion === 4 && ['yes', 'no'].includes(d.evening.napV4),
  );
  const napped = naps.filter((d) => d.evening.napV4 === 'yes');
  const comprehension = r.current.flatMap((d) =>
    typeof d.evening[`${learning}ComprehensionV4`] === 'number'
      ? [{ date: d.date, value: d.evening[`${learning}ComprehensionV4`] }]
      : [],
  );
  const actual = stateDistribution(r.current, 'evening', 'developmentActual', 4);
  return (
    <div className="state-themes">
      <details className="state-panel" id="state-sleep">
        <summary>
          <span>Сон</span>
          <small>{sleep.n ? stateSleep(sleep.value) : 'Ще немає тривалості'}</small>
        </summary>
        <div className="state-panel-body">
          {!!sleep.n && (
            <>
              <ObservationChart
                points={sleep.points}
                label="Тривалість сну"
                unit="год"
                maxGapDays={1}
                onSelect={onDay}
              />
              <p className="state-caption">
                {sleep.n} ранкових відповідей із відомою тривалістю · приблизний час
              </p>
            </>
          )}
          <StateDistributionView
            days={r.current}
            slot="morning"
            stem="sleepQuality"
            revision={4}
            title="Наскільки відпочив після сну"
            onDay={onDay}
          />
          {!!naps.length && (
            <div className="state-topic-row">
              <span>Дрімота вдень</span>
              <b>
                {napped.length}/{naps.length} відповідей
              </b>
              <StateDates dates={napped.map((d) => d.date)} onDay={onDay} />
            </div>
          )}
          <StateDistributionView
            days={r.current}
            slot="morning"
            stem="bedtimeOutcome"
            revision={4}
            title="Як вийшло з планом сну"
            onDay={onDay}
          />
          <details className="state-subdetails">
            <summary>Твої пояснення сну</summary>
            <StateDistributionView
              days={r.current}
              slot="morning"
              stem="sleepBlockers"
              title="Що заважало"
              onDay={onDay}
            />
            <StateDistributionView
              days={r.current}
              slot="morning"
              stem="sleepHelpers"
              title="Що допомагало"
              onDay={onDay}
            />
          </details>
          {!sleep.n && (
            <p className="state-empty">
              Тривалість з’явиться після ранкового запису про сон. «Не знаю» не рахується нулем.
            </p>
          )}
          {explanations && (
            <p className="state-caption">
              План лягти спати — намір, а не виміряний час засинання. Старі формулювання якості сну
              лишаються в записах дня.
            </p>
          )}
        </div>
      </details>
      <details className="state-panel">
        <summary>
          <span>Навантаження й відновлення</span>
          <small>
            {r.personal.n
              ? `${r.personal.enough}/${r.personal.n} · часу вистачило`
              : 'Робота · час для себе'}
          </small>
        </summary>
        <div className="state-panel-body">
          <StateDistributionView
            days={r.current}
            slot="evening"
            stem="workLoad"
            revision={4}
            title="Власна оцінка навантаження"
            onDay={onDay}
          />
          <StateDistributionView
            days={r.current}
            slot="evening"
            stem="workRange"
            revision={4}
            title="Час на роботу"
            onDay={onDay}
          />
          <StateDistributionView
            days={r.current}
            slot="evening"
            stem="workBreaks"
            revision={4}
            title="Чи вистачало перерв"
            onDay={onDay}
          />
          {!!r.personal.n && (
            <div className="state-topic-row">
              <h4>Часу для себе вистачило</h4>
              <b>
                {r.personal.enough} з {r.personal.n} відповідей
              </b>
              <StateDates dates={r.personal.dates} onDay={onDay} />
            </div>
          )}
          <StateDistributionView
            days={r.current}
            slot="evening"
            stem="freeTime"
            revision={4}
            title="Скільки було особистого часу"
            onDay={onDay}
          />
          {r.recovery
            .filter((item) => item.n)
            .map((item) => (
              <div className="state-topic-row" key={item.id}>
                <h4>{item.label}</h4>
                <p>
                  Після цього почувався краще у{' '}
                  <b>
                    {item.better} з {item.n}
                  </b>{' '}
                  описаних випадків.
                </p>
                <StateDates dates={item.dates} onDay={onDay} />
              </div>
            ))}
          {!r.current.some((d) => d.evening.questionVersion === 4) && (
            <p className="state-empty">
              Деталі з’являться після вечірніх відповідей про роботу й особистий час.
            </p>
          )}
          <details className="state-subdetails">
            <summary>Твої пояснення відновлення</summary>
            <StateDistributionView
              days={r.current}
              slot="evening"
              stem="recoveryHelpers"
              revision={4}
              title="Що допомагало"
              onDay={onDay}
            />
            <StateDistributionView
              days={r.current}
              slot="evening"
              stem="recoveryBlockers"
              revision={4}
              title="Що заважало"
              onDay={onDay}
            />
          </details>
          {explanations && (
            <p className="state-caption">
              Ефект відновлення — твоє враження після заняття. Діапазони тривалості не
              перетворюються на точні хвилини.
            </p>
          )}
        </div>
      </details>
      <details className="state-panel">
        <summary>
          <span>Навчання й плани</span>
          <small>Навчання · курс · читання</small>
        </summary>
        <div className="state-panel-body">
          <div className="state-learning-list">
            {[
              ['study', 'Навчання'],
              ['course', 'Курс'],
              ['read', 'Читання'],
            ].map(([id, label]) => {
              const item = r.learning[id];
              return (
                <div className="state-topic-row" key={id}>
                  <h4>{label}</h4>
                  <b>
                    {item?.known
                      ? `${item.done} з ${item.known} відомих днів`
                      : 'Ще немає окремих відповідей'}
                  </b>
                  {!!item?.planned && (
                    <p className="state-caption">
                      Із {item.planned} ранкових намірів відомий підсумок {item.observed}; заняття
                      відбулося у {item.met}.
                    </p>
                  )}
                  <StateDates dates={item?.dates ?? []} onDay={onDay} />
                </div>
              );
            })}
          </div>
          {!!actual.items.find((item) => item.id === 'unknown')?.count && (
            <p className="state-caption">
              Днів із відповіддю «Не знаю»:{' '}
              {actual.items.find((item) => item.id === 'unknown')!.count}. Вони не означають
              відсутність занять.
            </p>
          )}
          {!!r.legacyLearning && (
            <p className="state-caption">
              У попередніх записах навчання й курс були об’єднані: {r.legacyLearning} днів. Їх не
              розділяємо заднім числом.
            </p>
          )}
          <div className="renewal-segments">
            <button
              type="button"
              aria-pressed={learning === 'study'}
              onClick={() => setLearning('study')}
            >
              Навчання
            </button>
            <button
              type="button"
              aria-pressed={learning === 'course'}
              onClick={() => setLearning('course')}
            >
              Курс
            </button>
          </div>
          {!!comprehension.length && (
            <>
              <h4>Розуміння матеріалу · {learning === 'study' ? 'навчання' : 'курс'}</h4>
              <ObservationChart
                key={learning}
                points={comprehension}
                label={`Розуміння: ${learning === 'study' ? 'навчання' : 'курс'}`}
                unit="/5"
                domain={[1, 5]}
                maxGapDays={1}
                onSelect={onDay}
              />
              <p className="state-caption">
                {comprehension.length} власних оцінок · середня{' '}
                {stateNumber(
                  comprehension.reduce((sum, p) => sum + p.value, 0) / comprehension.length,
                )}
                /5
              </p>
            </>
          )}
          <StateDistributionView
            days={r.current}
            slot="evening"
            stem={`${learning}Range`}
            revision={4}
            title="Час на заняття"
            onDay={onDay}
          />
          <StateDistributionView
            days={r.current}
            slot="evening"
            stem={`${learning}Practice`}
            revision={4}
            title="Застосування на практиці"
            onDay={onDay}
          />
          <StateDistributionView
            days={r.current}
            slot="evening"
            stem="priorityOutcome"
            revision={4}
            title="Що вийшло з головним планом"
            onDay={onDay}
          />
          {explanations && (
            <p className="state-caption">
              Порівнюємо намір і відомий вечірній підсумок. Зміна плану й відпочинок не вважаються
              невдачею.
            </p>
          )}
        </div>
      </details>
    </div>
  );
}
