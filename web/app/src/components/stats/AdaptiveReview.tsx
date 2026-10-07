import { useTick } from '../../lib/useTick.ts';
import { useState } from 'react';
import type { Stats, CheckinSlot } from '../../api/schema.ts';
import { inTelegram } from '../../telegram.ts';
import { kyivParts } from '../../../../core/finance/planning.mjs';
import {
  analyzeAdaptive,
  adaptiveDay,
  demoAdaptive,
  frequenciesV3,
  pointsV3,
  type AdaptiveDay,
} from '../../../../core/checkin/adaptive-observations.mjs';
import {
  CHECKIN_CARDS_V3,
  FOLLOWUP_CARDS_V3,
  answerLabelV3,
} from '../../../../core/checkin/adaptive.mjs';
import { ObservationChart } from '../charts/ObservationChart.tsx';
import { ObservationReview } from './ObservationReview.tsx';
import { WeeklyReview } from './WeeklyReview.tsx';

const slots: CheckinSlot[] = ['morning', 'afternoon', 'evening'];
const names = { morning: 'Ранок', afternoon: 'День', evening: 'Вечір' };
const fmt = (n: number | null) =>
  n == null ? '—' : n.toLocaleString('uk-UA', { maximumFractionDigits: 1 });
const labelDate = (d: string) =>
  new Date(d + 'T12:00:00Z').toLocaleDateString('uk-UA', { day: 'numeric', month: 'long' });
function Distribution({
  days,
  slot,
  fieldId,
  title,
}: {
  days: AdaptiveDay[];
  slot: CheckinSlot;
  fieldId: string;
  title: string;
}) {
  const field = [...(CHECKIN_CARDS_V3[slot] ?? []), ...FOLLOWUP_CARDS_V3]
    .flatMap((c) => c.fields)
    .find((f) => f.id === fieldId);
  const data = frequenciesV3(days, slot, fieldId);
  return (
    <div className="adaptive-distribution">
      <h3 className="font-semibold">{title}</h3>
      <p className="renewal-chart-note">
        {data.n} записів із явною відповіддю
        {field?.type === 'multi' ? ' · можна обрати кілька пунктів' : ''}.
      </p>
      {!data.n ? (
        <p className="renewal-muted">Поки немає відповідей на це питання.</p>
      ) : (
        Object.entries(data.counts)
          .sort((a, b) => b[1] - a[1])
          .map(([key, count]) => {
            const option = field?.options?.find(([, v]) => String(v) === key);
            const label = option?.[0].split(' :: ').at(-1) ?? key;
            return (
              <div key={key}>
                <div className="flex justify-between gap-3 text-sm">
                  <span>{label}</span>
                  <b className="font-mono shrink-0">
                    {count}/{data.n}
                  </b>
                </div>
                <div className="renewal-progress mt-2">
                  <span style={{ width: `${(count / data.n) * 100}%` }} />
                </div>
              </div>
            );
          })
      )}
    </div>
  );
}
function RecordedDay({ day }: { day: AdaptiveDay }) {
  const points = (key: 'energy' | 'mood') =>
    slots.flatMap((slot) => {
      const a = day[slot],
        at = a.confirmedAtV3 ?? a.answeredAtV3;
      return typeof a[key] === 'number' && typeof at === 'string'
        ? [{ date: at, value: a[key] }]
        : [];
    });
  return (
    <section className="renewal-inset flex flex-col gap-5">
      <h3 className="font-semibold">{labelDate(day.date)} · відповіді й контекст</h3>
      <ObservationChart
        points={points('energy')}
        label="Енергія протягом дня"
        domain={[1, 5]}
        unit="/5"
      />
      <ObservationChart
        points={points('mood')}
        label="Настрій протягом дня"
        domain={[1, 5]}
        unit="/5"
        color="var(--color-idx-agency)"
      />
      <p className="renewal-chart-note">
        Точки розташовані за фактичним часом запису. Між ними не відновлюємо невідомі зміни стану.
      </p>
      {slots.map((slot) => {
        const a = day[slot];
        const fields = [...(CHECKIN_CARDS_V3[slot] ?? []), ...FOLLOWUP_CARDS_V3].flatMap(
          (c) => c.fields,
        );
        return (
          <details key={slot} className="checkin-option-group">
            <summary>
              {names[slot]} {a.confirmed ? '✓' : '· немає запису'}
            </summary>
            {a.confirmed && (
              <div className="mt-3 flex flex-col gap-2 text-sm">
                {a.confirmedAtV3 && (
                  <p className="text-tx3">
                    {new Date(a.confirmedAtV3).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' })}{' '}
                    · Київ
                  </p>
                )}
                {fields
                  .filter((f) => a[f.id] != null)
                  .map((f) => (
                    <p key={f.id}>
                      {f.label}: <b>{answerLabelV3(f, a[f.id])}</b>
                    </p>
                  ))}
              </div>
            )}
          </details>
        );
      })}
    </section>
  );
}

export function AdaptiveReview({
  s,
  days,
  setDays,
}: {
  s: Stats;
  days: number;
  setDays: (n: number) => void;
}) {
  const [slot, setSlot] = useState<CheckinSlot>('evening'),
    [metric, setMetric] = useState<'energy' | 'mood'>('energy');
  const [selected, setSelected] = useState<string | null>(null),
    [legacy, setLegacy] = useState(false);
  const now = useTick(60000);
  const to = s.checkinDate ?? kyivParts(now).date;
  const demo = !inTelegram();
  const records = {
    ...(demo ? demoAdaptive(to) : {}),
    ...Object.fromEntries(
      Object.entries(s.checkinRaw.records).filter(([, r]) =>
        Object.values(r).some((a) => a?.questionVersion === 3),
      ),
    ),
    [to]: { ...(demo ? demoAdaptive(to)[to] : {}), ...(s.checkinToday ?? {}) },
  };
  const a = analyzeAdaptive(records, to, days);
  const chosen =
    (selected ? adaptiveDay(selected, records[selected]) : null) ??
    a.current
      .filter((d) => d.morning.confirmed || d.afternoon.confirmed || d.evening.confirmed)
      .at(-1) ??
    a.current.at(-1)!;
  const state = a.state[slot];
  const stat = (title: string, value: string, n: string) => (
    <div className="adaptive-stat">
      <small>{title}</small>
      <b>{value}</b>
      <span>{n}</span>
    </div>
  );
  return (
    <>
      {demo && (
        <p className="renewal-inset renewal-chart-note">
          Демонстраційні спостереження. Особисті відповіді тут не підставляються.
        </p>
      )}
      <WeeklyReview
        records={records}
        today={to}
        onDay={(date) => {
          setSelected(date);
          requestAnimationFrame(() =>
            document
              .getElementById('adaptive-recorded-day')
              ?.scrollIntoView({ block: 'start', behavior: 'auto' }),
          );
        }}
      />
      <section className="renewal-card">
        <div className="flex flex-wrap justify-between items-center gap-3">
          <h2 className="text-lg font-semibold">Твій період</h2>
          <div className="renewal-segments">
            {[7, 30, 90].map((n) => (
              <button
                key={n}
                aria-pressed={days === n}
                onClick={() => {
                  setDays(n);
                  setSelected(null);
                }}
              >
                {n}д
              </button>
            ))}
          </div>
        </div>
        <p className="renewal-chart-note mt-3">
          {labelDate(a.from)} — {labelDate(to)} · {a.recordedDays}/{days} днів із записами
        </p>
        <div className="adaptive-stats-grid mt-5">
          {stat(
            'Приблизний сон',
            `${fmt(a.sleep.value)} год`,
            `${a.sleep.n} відповідей про тривалість`,
          )}
          {stat(
            'Твоя оцінка дня',
            `${fmt(a.satisfaction.value)} /5`,
            `${a.satisfaction.n} вечірніх оцінок`,
          )}
          {stat(
            'Навчання · читання',
            `${a.learning} · ${a.reading} днів`,
            `${a.developmentAnswers} відповідей про заняття`,
          )}
          {stat(
            'Підтверджені записи',
            `${a.confirmedSlots}`,
            `із ${days * 3} можливих · без штрафу за пропуски`,
          )}
        </div>
        <p className="renewal-chart-note mt-4">
          Порівняно з попереднім періодом: сон {fmt(a.priorSleep.value)} год ({a.priorSleep.n}{' '}
          відповідей), оцінка дня {fmt(a.priorSatisfaction.value)}/5 ({a.priorSatisfaction.n}).
          Різна повнота може впливати на порівняння.
        </p>
      </section>
      <section className="renewal-card">
        <h2 className="text-lg font-semibold">Як змінюється стан</h2>
        <div className="renewal-segments mt-4">
          {slots.map((x) => (
            <button key={x} aria-pressed={slot === x} onClick={() => setSlot(x)}>
              {names[x]}
            </button>
          ))}
        </div>
        <div className="renewal-segments mt-3">
          {(['energy', 'mood'] as const).map((x) => (
            <button key={x} aria-pressed={metric === x} onClick={() => setMetric(x)}>
              {x === 'energy' ? 'Енергія' : 'Настрій'}
            </button>
          ))}
        </div>
        <p className="renewal-chart-note mt-4">
          Середня оцінка {fmt(state[metric].value)}/5 · {state[metric].n} відповідей. Натисни точку,
          щоб відкрити день.
        </p>
        <ObservationChart
          key={`${days}:${slot}:${metric}`}
          points={pointsV3(a.current, slot, metric)}
          label={metric === 'energy' ? 'Енергія' : 'Настрій'}
          domain={[1, 5]}
          unit="/5"
          maxGapDays={1}
          onSelect={setSelected}
        />
        <p className="renewal-chart-note mt-4">
          Ввечері енергія нижча за ранкову у {a.lowerEnergy}/{a.energyPairs} днів з обома
          відповідями. Пропуски залишають розриви.
        </p>
        <details className="mt-5">
          <summary className="renewal-link cursor-pointer">Розподіл оцінок і пояснення</summary>
          <div className="flex flex-col gap-6 mt-4">
            <Distribution days={a.current} slot={slot} fieldId={metric} title="Обрані оцінки" />
            <Distribution
              days={a.current}
              slot={slot}
              fieldId={metric === 'mood' ? 'moodFactorsV3' : 'energyKindV3'}
              title="Що ти пов’язував зі станом"
            />
          </div>
        </details>
        {(a.recordedDays > 0 ||
          chosen.morning.confirmed ||
          chosen.afternoon.confirmed ||
          chosen.evening.confirmed) && (
          <details id="adaptive-recorded-day" className="mt-5" open={selected != null}>
            <summary className="renewal-link cursor-pointer">Переглянути конкретний день</summary>
            <label className="renewal-field my-4">
              <span>Дата</span>
              <input
                type="date"
                value={chosen.date}
                min={Object.keys(records).sort()[0] ?? a.from}
                max={to}
                onChange={(e) => setSelected(e.target.value)}
              />
            </label>
            <RecordedDay key={chosen.date} day={chosen} />
          </details>
        )}
      </section>
      <details className="renewal-card">
        <summary className="font-semibold cursor-pointer">Сон і те, що відсуває вечір</summary>
        <div className="flex flex-col gap-6 mt-5">
          <p className="renewal-muted">
            {a.poorSleep} епізодів із якістю 1–2; {a.goodSleep} — із якістю 4–5. Середня власна
            якість {fmt(a.sleepQuality.value)}/5 ({a.sleepQuality.n} оцінок).
          </p>
          <ObservationChart
            points={a.current.flatMap((d) =>
              d.sleepHours == null
                ? []
                : [{ date: d.date, value: d.sleepHours, approx: d.morning.sleepModeV3 !== 'none' }],
            )}
            label="Заявлена тривалість сну"
            unit="год"
            maxGapDays={1}
            onSelect={setSelected}
          />
          <Distribution
            days={a.current}
            slot="morning"
            fieldId="sleepModeV3"
            title="Основний сон, дрімота чи без сну"
          />
          <Distribution
            days={a.current}
            slot="morning"
            fieldId="sleepBlockersV3"
            title="Що заважало · серед відповідей про поганий сон"
          />
          <Distribution
            days={a.current}
            slot="morning"
            fieldId="sleepHelpersV3"
            title="Що допомагало · серед відповідей про добрий сон"
          />
          <Distribution
            days={a.current}
            slot="morning"
            fieldId="bedtimeOutcomeV3"
            title="Бажаний і фактичний відхід до сну"
          />
          <Distribution
            days={a.current}
            slot="morning"
            fieldId="bedtimeReasonsV3"
            title="Що відсунуло відхід до сну"
          />
          <Distribution days={a.current} slot="evening" fieldId="napV3" title="Додаткова дрімота" />
          <p className="renewal-chart-note">
            Причини — твої пояснення. Частки рахуємо лише серед явних відповідей на відповідне
            уточнення. Додаткову дрімоту не додаємо до основного сну без перевірки епізодів.
          </p>
        </div>
      </details>
      <details className="renewal-card">
        <summary className="font-semibold cursor-pointer">
          Намір і час на навчання та читання
        </summary>
        <div className="flex flex-col gap-6 mt-5">
          <p className="renewal-inset">
            Планував розвиток у {a.planned} днях; вечірній результат є для {a.followThrough}.
            Заплановані напрямки відбулися у {a.met}/{a.followThrough} цих днів.
          </p>
          <Distribution
            days={a.current}
            slot="morning"
            fieldId="priorityV3"
            title="Головне на день"
          />
          <Distribution
            days={a.current}
            slot="afternoon"
            fieldId="priorityPaceV3"
            title="Як ішов план удень"
          />
          <Distribution
            days={a.current}
            slot="evening"
            fieldId="priorityOutcomeV3"
            title="Результат увечері"
          />
          <Distribution
            days={a.current}
            slot="evening"
            fieldId="freeTimeV3"
            title="Доступний час для себе"
          />
          <Distribution
            days={a.current}
            slot="evening"
            fieldId="developmentBlockersV3"
            title="Що завадило запланованому розвитку"
          />
          <Distribution
            days={a.current}
            slot="evening"
            fieldId="learningRangeV3"
            title="Приблизний час навчання · серед наданих уточнень"
          />
          <Distribution
            days={a.current}
            slot="evening"
            fieldId="readingRangeV3"
            title="Приблизний час читання · серед наданих уточнень"
          />
          <ObservationChart
            points={pointsV3(a.current, 'evening', 'comprehensionV3')}
            label="Розуміння матеріалу"
            domain={[1, 5]}
            unit="/5"
            maxGapDays={1}
            onSelect={setSelected}
          />
          <p className="renewal-chart-note">
            Діапазони не перетворюються на точні години. Свідома зміна плану та відпочинок не є
            невдачею.
          </p>
        </div>
      </details>
      <details className="renewal-card">
        <summary className="font-semibold cursor-pointer">Заняття й люди у твоїх днях</summary>
        <div className="flex flex-col gap-6 mt-5">
          <p className="renewal-chart-note">
            Ранок описує момент запису; день і вечір — переважні заняття за період. Компанія завжди
            стосується моменту. Частота — кількість записів, а не частка витраченого часу.
          </p>
          {slots.map((x) => (
            <div key={x} className="flex flex-col gap-5">
              <Distribution
                days={a.current}
                slot={x}
                fieldId="activitiesV3"
                title={`${names[x]} · заняття`}
              />
              <Distribution
                days={a.current}
                slot={x}
                fieldId="companyV3"
                title={`${names[x]} · компанія`}
              />
            </div>
          ))}
        </div>
      </details>
      <details className="renewal-card">
        <summary className="font-semibold cursor-pointer">Навантаження й відновлення</summary>
        <div className="flex flex-col gap-6 mt-5">
          <Distribution
            days={a.current}
            slot="evening"
            fieldId="workLoadV3"
            title="Навантаження · серед наданих робочих уточнень"
          />
          <Distribution
            days={a.current}
            slot="evening"
            fieldId="workBreaksV3"
            title="Перерви на роботі"
          />
          <Distribution
            days={a.current}
            slot="evening"
            fieldId="recoveryEffectV3"
            title="Як почувався після відпочинку або руху"
          />
          <p className="renewal-chart-note">
            Не всі дні мають ці уточнення. «Не показано» чи пропуск не означають відсутність перерв
            або відновлення. Дані Apple «Здоров’я» ще не підключені.
          </p>
        </div>
      </details>
      <p className="renewal-inset renewal-chart-note">
        Це спостереження за твоїми записами. Пояснення та спільна поява факторів не доводять причину
        зміни. Обрані два фактори не є повним переліком обставин дня.
      </p>
      <details className="renewal-card" onToggle={(e) => setLegacy(e.currentTarget.open)}>
        <summary className="font-semibold cursor-pointer">
          Попередній набір питань · окрема історія
        </summary>
        {legacy && (
          <div className="flex flex-col gap-5 mt-5">
            <ObservationReview s={s} days={days} setDays={setDays} />
          </div>
        )}
      </details>
    </>
  );
}
