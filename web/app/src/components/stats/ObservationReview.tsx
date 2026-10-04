import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSettings } from '../../api/hooks.ts';
import { postEvent } from '../../api/client.ts';
import { type Stats, type CheckinSlot } from '../../api/schema.ts';
import { inTelegram } from '../../telegram.ts';
import {
  CHECKIN_CARDS,
  ACTIVITIES,
  normalizeCheckinPreferences,
} from '../../../../core/checkin/catalog.mjs';
import {
  analyzeObservations,
  observationPoints,
  observedMean,
  compareObservedFactor,
  type ObservationDay,
} from '../../../../core/checkin/observations.mjs';
import { ObservationChart } from '../charts/ObservationChart.tsx';
import { BLOCKS as LEGACY_BLOCKS } from '../checkin/questions.ts';
import { useTick } from '../../lib/useTick.ts';
import { kyivParts } from '../../../../core/finance/planning.mjs';

const slotNames = { morning: 'Ранок', afternoon: 'День', evening: 'Вечір' };
const fmt = (v: number | null) =>
  v == null ? '—' : v.toLocaleString('uk-UA', { maximumFractionDigits: 1 });
const dateLabel = (d: string) =>
  new Date(d + 'T12:00:00Z').toLocaleDateString('uk-UA', { day: 'numeric', month: 'long' });
const duration = (m: number) => `${Math.floor(m / 60)} год ${m % 60} хв`;
const outcomes: Record<string, string> = {
  finished: 'Завершив',
  progress: 'Просунувся',
  notstarted: 'Не почав',
  changed: 'Свідомо змінив',
  noplan: 'Без плану / відпочинок',
};

function ObservationExplorer({ days }: { days: ObservationDay[] }) {
  const [slot, setSlot] = useState<CheckinSlot>('evening'),
    [fieldId, setFieldId] = useState('physicalV2');
  const fields = [
    ...new Map(
      (CHECKIN_CARDS[slot] ?? [])
        .flatMap((c) => c.fields)
        .filter((f) => !['text', 'datetime', 'time'].includes(f.type))
        .map((f) => [f.id, f]),
    ).values(),
  ];
  const field = fields.find((f) => f.id === fieldId) ?? fields[0];
  const points = field ? observationPoints(days, slot, field.id) : [];
  const mean = observedMean(points.map((p) => p.value));
  const categorical =
    field?.type === 'categories' ||
    field?.type === 'multi' ||
    (field?.type === 'one' && field.options?.some(([, v]) => typeof v === 'string'));
  const counts: Record<string, number> = {};
  if (field)
    for (const day of days) {
      const value = day[slot][field.id];
      for (const v of Array.isArray(value) ? value : value == null ? [] : [value])
        counts[String(v)] = (counts[String(v)] ?? 0) + 1;
    }
  const [date, setDate] = useState<string | null>(null);
  return (
    <details className="renewal-card">
      <summary className="cursor-pointer font-semibold">
        Інші спостереження: тіло, увага, очікування й контекст
      </summary>
      <div className="flex flex-col gap-4 mt-5">
        <div className="renewal-segments">
          {(['morning', 'afternoon', 'evening'] as const).map((s) => (
            <button
              key={s}
              aria-pressed={slot === s}
              onClick={() => {
                setSlot(s);
                setDate(null);
              }}
            >
              {slotNames[s]}
            </button>
          ))}
        </div>
        <label className="renewal-field">
          <span>Показник із твоїх відповідей</span>
          <select
            value={field?.id ?? ''}
            onChange={(e) => {
              setFieldId(e.target.value);
              setDate(null);
            }}
          >
            {fields.map((f) => (
              <option value={f.id} key={f.id}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        {field &&
          (categorical ? (
            <div>
              {Object.entries(counts).map(([v, n]) => {
                const snapshot = days.find(
                  (d) => d[slot].activityLabelsV2?.[v] || d[slot].habitLabelsV2?.[v],
                )?.[slot];
                const label =
                  field.options?.find(([, id]) => String(id) === v)?.[0] ??
                  snapshot?.activityLabelsV2?.[v] ??
                  snapshot?.habitLabelsV2?.[v] ??
                  ACTIVITIES.find((c) => c.id === v)?.name ??
                  (v === 'unknown' ? 'Не можу визначити' : v === 'noplan' ? 'Без плану' : v);
                return (
                  <div className="renewal-list-row" key={v}>
                    <span>{label}</span>
                    <b>{n} дн.</b>
                  </div>
                );
              })}
              {!Object.keys(counts).length && (
                <p className="renewal-muted">Підтверджених відповідей ще немає.</p>
              )}
              <p className="renewal-chart-note mt-3">
                Частота явних відповідей, без оцінок «краще / гірше». Категорії не перетворюються на
                години.
              </p>
            </div>
          ) : (
            <>
              <p className="renewal-chart-note">
                Середнє: {fmt(mean.value)} · {mean.n}/{days.length} відповідей. Пропуски та «не
                стосується» виключені.
              </p>
              <ObservationChart
                key={`${slot}:${field.id}`}
                points={points}
                label={field.label}
                unit={
                  field.type === 'duration'
                    ? 'хв'
                    : field.type === 'number'
                      ? ''
                      : field.options?.some(([, v]) => v === 0)
                        ? '/4'
                        : '/5'
                }
                domain={
                  field.type === 'one'
                    ? [
                        field.options?.some(([, v]) => v === 0) ? 0 : 1,
                        field.options?.some(([, v]) => v === 0) ? 4 : 5,
                      ]
                    : undefined
                }
                maxGapDays={1}
                onSelect={setDate}
              />
            </>
          ))}
        <DayContext
          key={`${slot}:${field?.id}:${date}`}
          day={days.find((d) => d.date === (date ?? days.at(-1)?.date))}
          open={date != null}
        />
      </div>
    </details>
  );
}

function DayContext({ day, open = false }: { day: ObservationDay | undefined; open?: boolean }) {
  if (!day) return null;
  return (
    <details className="renewal-inset mt-4" open={open}>
      <summary className="cursor-pointer font-semibold">
        {dateLabel(day.date)} · відповіді та контекст
      </summary>
      <div className="flex flex-col gap-5 mt-4">
        {(['morning', 'afternoon', 'evening'] as const).map((slot) => {
          const answers = day[slot],
            fields = (CHECKIN_CARDS[slot] ?? [])
              .flatMap((c) => c.fields)
              .filter((f) => answers[f.id] != null);
          return (
            <div key={slot}>
              <h4 className="font-semibold">{slotNames[slot]}</h4>
              {!fields.length ? (
                <p className="renewal-chart-note mt-2">
                  Немає підтверджених відповідей нового набору.
                </p>
              ) : (
                fields.map((f) => {
                  const value = answers[f.id],
                    label = (v: unknown) =>
                      f.options?.find(([, id]) => id === v)?.[0] ??
                      answers.activityLabelsV2?.[String(v)] ??
                      answers.habitLabelsV2?.[String(v)] ??
                      ACTIVITIES.find((c) => c.id === v)?.name ??
                      (v === 'noplan' ? 'Без плану' : String(v));
                  return (
                    <div className="renewal-list-row items-start" key={f.id}>
                      <span className="text-sm">{f.label}</span>
                      <b className="text-sm text-right max-w-[50%]">
                        {f.type === 'duration'
                          ? duration(Number(value))
                          : f.type === 'datetime' && typeof value === 'string'
                            ? `${dateLabel(value.slice(0, 10))} о ${value.slice(11, 16)}`
                            : Array.isArray(value)
                              ? value.map(label).join(', ')
                              : label(value)}
                      </b>
                    </div>
                  );
                })
              )}
              {answers.answeredAtV2 && (
                <p className="renewal-chart-note mt-2">
                  Записано{' '}
                  {new Date(String(answers.answeredAtV2)).toLocaleTimeString('uk-UA', {
                    timeZone: 'Europe/Kyiv',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}{' '}
                  за Києвом. Поточний стан стосується часу відповіді; підсумок — дня.
                </p>
              )}
            </div>
          );
        })}
        {day.napOverlap && (
          <p className="text-sm text-a2">
            Час додаткової дрімоти перетинає основний сон. Дрімота показана окремо, до суми її не
            додаємо.
          </p>
        )}
      </div>
    </details>
  );
}

function WeeklyReflection({
  to,
  prior,
}: {
  to: string;
  prior?: { help: string; change: string; step: string };
}) {
  const qc = useQueryClient(),
    [values, setValues] = useState(prior ?? { help: '', change: '', step: '' }),
    [saved, setSaved] = useState(false);
  const mutation = useMutation({
    mutationFn: () => postEvent('checkin_reflection', { ...values }),
    onSuccess: () => {
      setSaved(true);
      qc.invalidateQueries({ queryKey: ['stats'] });
    },
  });
  return (
    <details className="renewal-inset mt-5">
      <summary className="cursor-pointer font-semibold">Добровільна рефлексія тижня</summary>
      <div className="mt-4 flex flex-col gap-3">
        <p className="renewal-chart-note">
          До {dateLabel(to)}. Власні рішення без балів і автоматичних оцінок.
        </p>
        {(['help', 'change', 'step'] as const).map((key, i) => (
          <label className="renewal-field" key={key}>
            <span>
              {
                [
                  'Що цього тижня допомагало?',
                  'Що хочу змінити?',
                  'Один невеликий крок на наступний тиждень',
                ][i]
              }
            </span>
            <textarea
              rows={2}
              maxLength={500}
              value={values[key]}
              onChange={(e) => {
                setValues((v) => ({ ...v, [key]: e.target.value }));
                setSaved(false);
              }}
            />
          </label>
        ))}
        <button
          className="renewal-secondary"
          disabled={mutation.isPending || !Object.values(values).some((v) => v.trim())}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending ? 'Зберігаю…' : 'Зберегти рефлексію'}
        </button>
        {saved && (
          <p role="status" className="text-sm text-pos">
            {inTelegram() ? 'Збережено в особистій історії.' : 'Збережено в цьому демо-сеансі.'}
          </p>
        )}
        {mutation.error && (
          <p role="alert" className="text-sm text-neg">
            {mutation.error.message}
          </p>
        )}
      </div>
    </details>
  );
}

export function ObservationReview({
  s,
  days,
  setDays,
}: {
  s: Stats;
  days: number;
  setDays: (d: number) => void;
}) {
  const settings = useSettings(),
    p = normalizeCheckinPreferences(settings.data?.settings.checkin);
  const [slot, setSlot] = useState<CheckinSlot>('morning'),
    [selected, setSelected] = useState<string | null>(null),
    [factor, setFactor] = useState('recoveryV2:well');
  const now = useTick(60000);
  const [contextScope, setContextScope] = useState<string | null>(null);
  const selectDay = (scope: string) => (date: string) => {
    setSelected(date);
    setContextScope(scope);
  };
  const to = s.checkinRaw.to || s.checkinDate || kyivParts(now).date,
    a = analyzeObservations(s.checkinRaw.records, to, days);
  const chosen = a.current.find((d) => d.date === (selected ?? to)) ?? a.current.at(-1);
  const charts = [
    { key: 'energy', label: 'Енергія', max: 5, min: 1, color: 'var(--color-a2)' },
    { key: 'mood', label: 'Настрій', max: 5, min: 1, color: '#b8a0dc' },
    { key: 'tensionV2', label: 'Напруження', max: 4, min: 0, color: '#8ed4bd' },
  ];
  const comparisons = [
    ['recoveryV2:well', 'Добре відновився'],
    ['supportV2:yes', 'Відчував підтримку'],
    ['blockersV2:fatigue', 'Відзначив брак сил'],
    ['helpersV2:rest', 'Відзначив перерву / сон'],
    ['activitiesV2:taxi', 'Працював у таксі'],
    ['activitiesV2:mate', 'Навчався в Mate Academy'],
  ] as const;
  const [field, value] = factor.split(':'),
    comparison = compareObservedFactor(a.current, field, value);
  const sleepPoints = a.current.flatMap((d) =>
    d.sleepHours == null ? [] : [{ date: d.date, value: d.sleepHours, approx: d.sleepApprox }],
  );
  const qualityPoints = a.current.flatMap((d) =>
    d.sleepQuality == null ? [] : [{ date: d.date, value: d.sleepQuality }],
  );
  const learningPoints = a.current.flatMap((d) =>
    d.learningMinutes == null
      ? []
      : [
          {
            date: d.date,
            value: d.learningMinutes,
            approx: d.evening.learningPrecisionV2 !== 'exact' && d.learningMinutes > 0,
          },
        ],
  );
  const priorityDays = a.current.filter((d) => d.morning.priorityV2 && d.evening.priorityOutcomeV2);
  const newSlots = a.current.reduce(
    (n, d) =>
      n +
      ['morning', 'afternoon', 'evening'].filter(
        (slot) =>
          Object.keys((d as unknown as Record<string, Record<string, unknown>>)[slot]).length,
      ).length,
    0,
  );
  return (
    <>
      <section className="renewal-card">
        <div className="renewal-section-head">
          <h2 className="text-lg font-semibold">Твої спостереження</h2>
          <div className="renewal-segments">
            {[7, 30, 90].map((n) => (
              <button
                key={n}
                aria-pressed={days === n}
                onClick={() => {
                  setDays(n);
                  setSelected(null);
                  setContextScope(null);
                }}
              >
                {n}д
              </button>
            ))}
          </div>
        </div>
        <p className="renewal-muted">
          {dateLabel(a.from)} — {dateLabel(to)} · {a.recordedDays}/{days} днів ·{' '}
          {a.facts.confirmedSlots}/{days * 3} підтверджених чек-інів.
        </p>
        <p className="renewal-chart-note mt-3">
          Новий набір v2. Пропуски, «не стосується» й «не знаю» не стають нулем. Попередні питання з
          іншим змістом доступні в історії нижче.
        </p>
        {!newSlots && (
          <p className="renewal-inset mt-4">
            Нові графіки почнуть наповнюватись після першого підтвердженого чек-іну. Наявні записи
            збережені.
          </p>
        )}
      </section>
      <section className="renewal-card">
        <div className="renewal-section-head">
          <h2 className="text-lg font-semibold">Мій ритм</h2>
        </div>
        <div className="renewal-segments mb-5">
          {(['morning', 'afternoon', 'evening'] as const).map((id) => (
            <button key={id} aria-pressed={slot === id} onClick={() => setSlot(id)}>
              {slotNames[id]}
            </button>
          ))}
        </div>
        <div className="flex flex-col gap-6">
          {charts.map((metric) => {
            const points = observationPoints(a.current, slot, metric.key),
              prev = observationPoints(a.previous, slot, metric.key),
              mean = observedMean(points.map((d) => d.value)),
              old = observedMean(prev.map((d) => d.value));
            return (
              <div key={`${days}:${to}:${slot}:${metric.key}`} className="renewal-inset">
                <div className="flex justify-between gap-2">
                  <h3 className="font-semibold">
                    {metric.label} · {slotNames[slot].toLowerCase()}
                  </h3>
                  <b className="font-mono">
                    {fmt(mean.value)} / {metric.max}
                  </b>
                </div>
                <p className="renewal-chart-note mt-2 mb-3">
                  {mean.n}/{days} відповідей. Попередні {days} днів, цей самий слот:{' '}
                  {fmt(old.value)} · {old.n} відповідей
                  {mean.value != null && old.value != null
                    ? ` · зміна ${fmt(mean.value - old.value)}`
                    : ''}
                  .
                </p>
                <ObservationChart
                  points={points}
                  label={`${metric.label}, ${slotNames[slot]}`}
                  domain={[metric.min, metric.max]}
                  unit={`/${metric.max}`}
                  maxGapDays={1}
                  color={metric.color}
                  onSelect={selectDay('rhythm')}
                />
              </div>
            );
          })}
        </div>
        <DayContext key={`rhythm:${selected}`} day={chosen} open={contextScope === 'rhythm'} />
      </section>
      <section className="renewal-card">
        <h2 className="text-lg font-semibold mb-4">Сон і наступний день</h2>
        <div className="renewal-form-grid">
          <div className="renewal-inset">
            <small className="text-tx3">Заявлений сон</small>
            <p className="text-2xl font-mono mt-2">
              {fmt(a.sleep.value)} <small>год</small>
            </p>
            <p className="renewal-chart-note">
              {a.sleep.n}/{days} відповідей ·{' '}
              {a.current.filter((d) => d.sleepApprox && d.sleepHours != null).length} приблизних
            </p>
          </div>
          <div className="renewal-inset">
            <small className="text-tx3">Якість окремо</small>
            <p className="text-2xl font-mono mt-2">
              {fmt(a.sleepQuality.value)} <small>/ 5</small>
            </p>
            <p className="renewal-chart-note">{a.sleepQuality.n} оцінок сну</p>
          </div>
        </div>
        <div className="mt-5">
          <ObservationChart
            key={`sleep:${days}:${to}`}
            points={sleepPoints}
            label="Заявлена тривалість сну"
            unit="год"
            domain={[0, Math.max(12, ...sleepPoints.map((d) => Math.ceil(d.value)))]}
            maxGapDays={1}
            color="#8ed4bd"
            onSelect={selectDay('sleep')}
          />
        </div>
        <details className="mt-4">
          <summary className="renewal-link cursor-pointer">
            Якість, режим, дрімоти й сонливість
          </summary>
          <div className="mt-4 flex flex-col gap-4">
            <ObservationChart
              key={`quality:${days}:${to}`}
              points={qualityPoints}
              label="Якість сну"
              unit="/5"
              domain={[1, 5]}
              maxGapDays={1}
              onSelect={selectDay('sleep')}
            />
            <p className="renewal-muted">
              Розкид часу спроби заснути: {fmt(a.sleepRegularity.spreadMinutes)} хв ·{' '}
              {a.sleepRegularity.n} записів. Пробудження: {fmt(a.wakeRegularity.spreadMinutes)} хв ·{' '}
              {a.wakeRegularity.n} записів. Менший розкид означає стабільніший час, а не оцінку
              здоров’я.
            </p>
            <p className="renewal-muted">
              Додаткові дрімоти: {a.current.filter((d) => d.napMinutes != null).length} записів із
              тривалістю; {a.current.filter((d) => d.napOverlap).length} перетинів із основним сном.
              Епізоди не підсумовуються без перевірки дат.
            </p>
            <ObservationChart
              key={`sleepiness:${days}:${to}:${slot}`}
              points={observationPoints(a.current, slot, 'sleepinessV2')}
              label={`Сонливість · ${slotNames[slot]}`}
              unit="/4"
              domain={[0, 4]}
              maxGapDays={1}
              onSelect={selectDay('sleep')}
            />
          </div>
        </details>
        <p className="renewal-chart-note mt-4">
          «Не спав» — 0 годин без оцінки якості. Дрімоті не підставляються 2 години. Час відкриття
          застосунку не є пробудженням. Приблизні оцінки позначені у відповідях дня.
        </p>
      </section>
      {contextScope === 'sleep' && <DayContext key={`sleep:${selected}`} day={chosen} open />}
      <section className="renewal-card">
        <h2 className="text-lg font-semibold">Намір і результат</h2>
        <p className="renewal-chart-note mt-2">
          {priorityDays.length} днів із ранковим пріоритетом та вечірнім результатом. Денна
          відповідь не замінює підсумок.
        </p>
        <div className="flex flex-col gap-3 mt-5">
          {Object.entries(outcomes).map(([key, label]) => (
            <div key={key} className="flex items-center gap-3">
              <span className="text-sm flex-1">{label}</span>
              <div className="renewal-progress w-24">
                <span
                  style={{
                    width: `${
                      ((a.outcomes[key] ?? 0) /
                        Math.max(
                          1,
                          Object.values(a.outcomes).reduce((s, n) => s + n, 0),
                        )) *
                      100
                    }%`,
                  }}
                />
              </div>
              <b>{a.outcomes[key] ?? 0}</b>
            </div>
          ))}
        </div>
        <details className="mt-4">
          <summary className="renewal-link cursor-pointer">
            Пріоритети по днях і частота занять
          </summary>
          <div className="mt-3">
            {a.current
              .filter((d) => d.morning.priorityV2 || d.evening.priorityOutcomeV2)
              .map((d) => (
                <div className="renewal-list-row items-start" key={d.date}>
                  <small>{dateLabel(d.date)}</small>
                  <span className="text-sm text-right max-w-[65%]">
                    {d.morning.activityLabelsV2?.[d.morning.priorityV2] ??
                      [...ACTIVITIES, ...p.categories].find((c) => c.id === d.morning.priorityV2)
                        ?.name ??
                      (d.morning.priorityV2 === 'noplan' ? 'Без плану' : 'Пріоритет не записаний')}
                    {d.morning.priorityStepV2 ? ` · ${d.morning.priorityStepV2}` : ''}
                    <br />
                    <b>{outcomes[d.evening.priorityOutcomeV2] ?? 'Немає вечірньої відповіді'}</b>
                  </span>
                </div>
              ))}
            <h3 className="font-semibold mt-4">Групи занять · дні з відміткою</h3>
            {Object.entries(a.activityGroups).map(([group, n]) => (
              <div key={group} className="renewal-list-row">
                <span>{group}</span>
                <b>{n} дн.</b>
              </div>
            ))}
            <h3 className="font-semibold mt-4">Окремі заняття</h3>
            {Object.entries(a.activities).map(([id, n]) => (
              <div key={id} className="renewal-list-row">
                <span>
                  {a.current.find((d) => d.evening.activityLabelsV2?.[id])?.evening
                    .activityLabelsV2?.[id] ??
                    [...ACTIVITIES, ...p.categories].find((c) => c.id === id)?.name ??
                    (id === 'unknown' ? 'Не можу визначити' : id)}
                </span>
                <b>{n} дн.</b>
              </div>
            ))}
          </div>
        </details>
        <p className="renewal-chart-note mt-4">
          Перепланування й відпочинок — окремі стани. Категорії показують наявність занять, не
          розподіл часу.
        </p>
      </section>
      <section className="renewal-card">
        <h2 className="text-lg font-semibold">Навчання</h2>
        <div className="renewal-form-grid mt-4">
          <div className="renewal-inset">
            <small className="text-tx3">Дні навчання</small>
            <p className="text-2xl font-mono mt-2">{a.facts.learningDays}</p>
            <p className="renewal-chart-note">
              {learningPoints.length}/{days} відповідей про тривалість ·{' '}
              {learningPoints.filter((p) => p.approx).length} приблизних або без уточнення точності
            </p>
          </div>
          <div className="renewal-inset">
            <small className="text-tx3">Записаний час</small>
            <p className="font-mono text-xl mt-2">{duration(a.facts.learningMinutes)}</p>
          </div>
        </div>
        <div className="mt-4">
          <ObservationChart
            key={`learning:${days}:${to}`}
            points={learningPoints}
            label="Час навчання"
            unit="хв"
            maxGapDays={1}
            onSelect={selectDay('learning')}
          />
        </div>
        <details className="mt-4">
          <summary className="renewal-link cursor-pointer">Розуміння, фокус і перешкоди</summary>
          <div className="mt-4 flex flex-col gap-5">
            <h3 className="font-semibold">Розуміння матеріалу</h3>
            <ObservationChart
              key={`comprehension:${days}:${to}`}
              points={observationPoints(a.current, 'evening', 'comprehensionV2')}
              label="Розуміння матеріалу"
              unit="/5"
              domain={[1, 5]}
              maxGapDays={1}
              onSelect={selectDay('learning')}
            />
            <h3 className="font-semibold">Фокус важливої справи</h3>
            <ObservationChart
              key={`focus:${days}:${to}`}
              points={observationPoints(a.current, 'evening', 'focusV2')}
              label="Фокус"
              unit="/5"
              domain={[1, 5]}
              maxGapDays={1}
              onSelect={selectDay('learning')}
            />
          </div>
        </details>
        <p className="renewal-chart-note mt-4">
          Час не дорівнює якості. «Не було нового матеріалу» не стає нулем. Прогноз завершення Mate
          Academy без навчального плану не будується.
        </p>
      </section>
      {contextScope === 'learning' && <DayContext key={`learning:${selected}`} day={chosen} open />}
      <section className="renewal-card">
        <h2 className="text-lg font-semibold">Що супроводжує різні дні</h2>
        <label className="renewal-field mt-4">
          <span>Спостереження для порівняння</span>
          <select value={factor} onChange={(e) => setFactor(e.target.value)}>
            {comparisons.map(([key, label]) => (
              <option value={key} key={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <div className="renewal-form-grid mt-4">
          <div className="renewal-inset">
            <small className="text-tx3">З цією відповіддю</small>
            <p className="font-mono text-2xl mt-2">
              {fmt(comparison.withFactor.value)} <small>/5</small>
            </p>
            <p className="renewal-chart-note">{comparison.withFactor.n} днів</p>
          </div>
          <div className="renewal-inset">
            <small className="text-tx3">З іншою явною відповіддю</small>
            <p className="font-mono text-2xl mt-2">
              {fmt(comparison.withoutFactor.value)} <small>/5</small>
            </p>
            <p className="renewal-chart-note">{comparison.withoutFactor.n} днів</p>
          </div>
        </div>
        <p className="renewal-muted mt-4">
          {comparison.eligible
            ? `Задоволення днем відрізнялося на ${fmt(comparison.difference)} бала в твоїх записах.`
            : 'Показані сирі середні. Для опису різниці потрібно хоча б 8 днів у кожній групі.'}
        </p>
        <p className="renewal-chart-note mt-3">
          {dateLabel(a.from)} — {dateLabel(to)}. Пропущена відповідь не означає відсутність фактора.
          Це спільна поява у твоїх записах, без висновку про причину. Інші умови дня також можуть
          відрізнятися.
        </p>
      </section>
      <section className="renewal-card">
        <h2 className="text-lg font-semibold">Період у кількох фактах</h2>
        <div className="mt-4 flex flex-col gap-3">
          <p className="renewal-inset">
            {a.facts.energyPairs
              ? `Ввечері енергія була нижчою, ніж уранці, у ${a.facts.lowerEnergy} із ${a.facts.energyPairs} днів з обома відповідями.`
              : 'Порівняння ранку й вечора з’явиться після дня з обома відповідями.'}
          </p>
          <p className="renewal-inset">
            Навчання було записане у {a.facts.learningDays} днях. Загальний заявлений час —{' '}
            {duration(a.facts.learningMinutes)}.
          </p>
          <p className="renewal-inset">
            Підтверджено {a.facts.confirmedSlots} чек-інів за {days} днів. Решта — відсутні
            відповіді або чернетки, без штрафних балів.
          </p>
        </div>
        <WeeklyReflection key={to} to={to} prior={s.checkinReflections?.[to]} />
      </section>
      <ObservationExplorer key={`${days}:${to}`} days={a.current} />
      <section className="renewal-card">
        <h2 className="font-semibold">Власні звички</h2>
        <p className="renewal-chart-note mt-2">
          Графік і виконання окремі від настрою. Відсутня відповідь не означає, що звичку не
          виконав.
        </p>
        {p.habits.length ? (
          p.habits.map((h) => {
            const scheduled = a.current.filter((d) =>
              Array.isArray(d.evening.habitDueV2)
                ? d.evening.habitDueV2.includes(h.id)
                : h.days.includes(new Date(d.date + 'T12:00:00Z').getUTCDay()),
            );
            const replied = scheduled.filter((d) => Array.isArray(d.evening.habitsV2)),
              done = replied.filter((d) => d.evening.habitsV2.includes(h.id));
            return (
              <div className="renewal-list-row" key={h.id}>
                <span>{h.name}</span>
                <b className="text-right text-sm">
                  {done.length} виконань
                  <br />
                  <small className="font-normal text-tx3">
                    {replied.length}/{scheduled.length} днів з відміткою
                  </small>
                </b>
              </div>
            );
          })
        ) : (
          <p className="renewal-muted mt-4">
            Додай добровільні звички та їхній графік у налаштуваннях чек-іну.
          </p>
        )}
      </section>
      <details className="renewal-card">
        <summary className="cursor-pointer font-semibold">Історія попереднього набору</summary>
        <p className="renewal-chart-note mt-3">
          Змінені шкали не змішані з новими. Старі категорії сну є діапазонами чи припущеннями;
          походження точного значення не завжди можна встановити.
        </p>
        <div className="mt-4 flex flex-col gap-3">
          {Object.entries(s.checkinRaw.records)
            .filter(
              ([d, r]) =>
                d >= a.from &&
                d <= to &&
                Object.values(r).some((v) => v && v.questionVersion !== 2),
            )
            .reverse()
            .map(([d, r]) => (
              <details key={d} className="renewal-inset">
                <summary className="cursor-pointer text-sm">{dateLabel(d)}</summary>
                {Object.entries(r)
                  .filter(([, answers]) => answers && answers.questionVersion !== 2)
                  .map(([slot, answers]) => (
                    <div key={slot} className="mt-3">
                      <b>{slotNames[slot as CheckinSlot]}</b>
                      {Object.entries(answers!)
                        .filter(([key]) => key !== 'confirmed')
                        .map(([key, value]) => (
                          <p className="renewal-chart-note" key={key}>
                            {LEGACY_BLOCKS.find((b) => b.id === slot)?.qs.find((q) => q.id === key)
                              ?.t ??
                              (key === 'energy' ? 'Енергія' : key === 'mood' ? 'Настрій' : key)}
                            :{' '}
                            {Array.isArray(value)
                              ? value
                                  .map(
                                    (v) =>
                                      LEGACY_BLOCKS.find((b) => b.id === slot)
                                        ?.qs.find((q) => q.id === key)
                                        ?.o?.find(([, id]) => id === v)?.[0] ?? String(v),
                                  )
                                  .join(', ')
                              : (LEGACY_BLOCKS.find((b) => b.id === slot)
                                  ?.qs.find((q) => q.id === key)
                                  ?.o?.find(([, id]) => id === value)?.[0] ?? String(value))}
                          </p>
                        ))}
                    </div>
                  ))}
              </details>
            ))}
        </div>
      </details>
    </>
  );
}
