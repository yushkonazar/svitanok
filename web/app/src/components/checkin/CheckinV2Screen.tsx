import { fieldVisibleV3, validValueV3 } from '../../../../core/checkin/adaptive.mjs';
import { useEffect, useId, useRef, useState } from 'react';
import { useStats, useSaveCheckin, useSettings } from '../../api/hooks.ts';
import { resetCheckinDemo } from '../../api/checkin-demo.ts';
import { type CheckinSlot } from '../../api/schema.ts';
import { inTelegram, haptic } from '../../telegram.ts';
import { PageHeading } from '../ui/PageHeading.tsx';
import { LoadingSkeleton, ErrorState } from '../ui/states.tsx';
import { useTick } from '../../lib/useTick.ts';
import { kyivParts, shiftDate } from '../../../../core/finance/planning.mjs';
import {
  CHECKIN_CARDS,
  CHECKIN_MODULES,
  ACTIVITY_GROUPS,
  ACTIVITIES,
  normalizeCheckinPreferences,
  fieldVisible,
  validFieldValue,
  clearHiddenV2,
  coreCompleteV2,
  checkinClock,
  type Card,
  type Field,
  type CheckinPreferences as Preferences,
} from '../../../../core/checkin/catalog.mjs';
import { BLOCKS as LEGACY_BLOCKS } from './questions.ts';
import { CheckinPreferences } from './CheckinPreferences.tsx';

type Answers = Record<string, unknown>;
const slots: CheckinSlot[] = ['morning', 'afternoon', 'evening'];
const names = { morning: 'Ранок', afternoon: 'День', evening: 'Вечір' };
const icons = { morning: '🌅', afternoon: '☀️', evening: '🌙' };
const draftKey = (date: string, slot: CheckinSlot) =>
  `svitanok:checkin-v2:${inTelegram() ? 'private' : 'demo'}:${date}:${slot}`;
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

function fieldLabel(field: Field, value: unknown, p: Preferences): string {
  if (value == null) return '—';
  if (field.type === 'duration' && typeof value === 'number')
    return `${Math.floor(value / 60)} год ${value % 60} хв`;
  const options =
    field.id === 'habitsV2'
      ? [...(field.options ?? []), ...p.habits.map((h) => [h.name, h.id])]
      : (field.options ?? []);
  const label = (v: unknown) =>
    options.find(([, id]) => id === v)?.[0] ??
    [...ACTIVITIES, ...p.categories].find((c) => c.id === v)?.name ??
    (v === 'noplan' ? 'Без плану / відпочинок' : v === 'unknown' ? 'Не можу визначити' : String(v));
  return Array.isArray(value) ? value.map(label).join(', ') : String(label(value));
}

export function FieldInput({
  field,
  answers,
  p,
  onChange,
  date,
}: {
  field: Field;
  answers: Answers;
  p: Preferences;
  date: string;
  onChange: (key: string, value: unknown) => void;
}) {
  const id = useId(),
    [limitMessage, setLimitMessage] = useState('');
  const adaptive = answers.questionVersion === 3;
  if (!(adaptive ? fieldVisibleV3(field, answers) : fieldVisible(field, answers))) return null;
  const value = answers[field.id];
  const pick = (v: string | number) => {
    haptic('light');
    setLimitMessage('');
    if (field.type === 'multi' || (field.type === 'categories' && (field.limit ?? 1) > 1)) {
      const old = Array.isArray(value) ? value : [];
      if (old.includes(v)) {
        onChange(
          field.id,
          old.filter((x) => x !== v),
        );
        return;
      }
      if (
        ['none', 'unknown', 'noplan', ...(adaptive ? ['alone', 'private'] : [])].includes(String(v))
      ) {
        onChange(field.id, [v]);
        return;
      }
      const kept = old.filter(
        (x) =>
          !['none', 'unknown', 'noplan', ...(adaptive ? ['alone', 'private'] : [])].includes(
            String(x),
          ),
      );
      if (kept.length >= (field.limit ?? 2)) {
        setLimitMessage(
          `Можна обрати до ${field.limit ?? 2}. Зніми попередній вибір, щоб додати інший.`,
        );
        return;
      }
      onChange(field.id, [...kept, v]);
    } else onChange(field.id, value === v ? null : v);
  };
  const selected = (v: unknown) => (Array.isArray(value) ? value.includes(v) : value === v);
  const option = (label: string, v: string | number) => (
    <button
      key={v}
      type="button"
      aria-pressed={selected(v)}
      onClick={() => pick(v)}
      className="checkin-choice"
      data-selected={selected(v)}
    >
      {label.split(' :: ').at(-1)}
    </button>
  );
  const activityOptions = [...ACTIVITIES, ...p.categories].filter(
    (c) => !p.hiddenCategories.includes(c.id) || selected(c.id),
  );
  const weekday = new Date(date + 'T12:00:00Z').getUTCDay();
  const options =
    field.id === 'habitsV2'
      ? [
          ...(field.options ?? []),
          ...p.habits
            .filter((h) => h.days.includes(weekday))
            .map((h) => [h.name, h.id] as [string, string]),
        ]
      : (field.options ?? []);
  return (
    <div className="flex flex-col gap-2">
      <label id={`${id}-label`} htmlFor={id} className="text-sm font-semibold text-tx2">
        {field.label}
        {field.optional && <span className="text-xs font-normal text-tx3"> · за бажанням</span>}
      </label>
      {field.help && <p className="renewal-chart-note">{field.help}</p>}
      {adaptive && options.some(([label]) => label.includes(' :: ')) ? (
        <div className="flex flex-col gap-3" aria-labelledby={`${id}-label`}>
          {[
            ...new Set(
              options
                .filter(([label]) => label.includes(' :: '))
                .map(([label]) => label.split(' :: ')[0]),
            ),
          ].map((group) => {
            const count = options.filter(
              ([label, v]) => label.startsWith(group + ' :: ') && selected(v),
            ).length;
            return (
              <details key={group} className="checkin-option-group">
                <summary>
                  {group}
                  <span
                    className="checkin-group-count"
                    aria-hidden={!count}
                    aria-label={count ? `Обрано: ${count}` : undefined}
                  >
                    {count || ''}
                  </span>
                </summary>
                <div className="flex flex-wrap gap-2 mt-3">
                  {options
                    .filter(([label]) => label.startsWith(group + ' :: '))
                    .map(([label, v]) => option(label, v))}
                </div>
              </details>
            );
          })}
          <div className="flex flex-wrap gap-2">
            {options
              .filter(([label]) => !label.includes(' :: '))
              .map(([label, v]) => option(label, v))}
          </div>
        </div>
      ) : field.type === 'categories' ? (
        <div className="flex flex-col gap-4" aria-labelledby={`${id}-label`}>
          {ACTIVITY_GROUPS.map((g) => (
            <div key={g}>
              <p className="text-xs text-tx3 mb-2">{g}</p>
              <div className="flex flex-wrap gap-2">
                {activityOptions.filter((c) => c.group === g).map((c) => option(c.name, c.id))}
              </div>
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            {field.id === 'priorityV2' && option('Без плану / день відпочинку', 'noplan')}
            {field.id !== 'priorityV2' && option('Не можу визначити', 'unknown')}
          </div>
        </div>
      ) : field.type === 'one' || field.type === 'multi' ? (
        <div aria-labelledby={`${id}-label`} className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            {options
              .slice(0, field.id === 'blockersV2' || field.id === 'helpersV2' ? 9 : options.length)
              .map(([label, v]) => option(label, v))}
          </div>
          {(field.id === 'blockersV2' || field.id === 'helpersV2') && (
            <>
              <details>
                <summary className="renewal-link cursor-pointer">Ще уточнення</summary>
                <div className="flex flex-wrap gap-2 mt-3">
                  {options.slice(9, -2).map(([label, v]) => option(label, v))}
                </div>
              </details>
              <div className="flex flex-wrap gap-2">
                {options.slice(-2).map(([label, v]) => option(label, v))}
              </div>
            </>
          )}
          {field.id === 'habitsV2' && options.length === 1 && (
            <p className="renewal-chart-note">
              На цей день немає запланованих звичок. Додай їх у налаштуваннях нижче.
            </p>
          )}
        </div>
      ) : field.type === 'duration' ? (
        <div>
          <div className="renewal-form-grid">
            <label className="renewal-field">
              <span>Години</span>
              <input
                id={id}
                type="number"
                min={0}
                max={24}
                inputMode="numeric"
                value={typeof value === 'number' ? Math.floor(value / 60) : ''}
                placeholder="0"
                onChange={(e) =>
                  onChange(
                    field.id,
                    e.target.value === ''
                      ? null
                      : Number(e.target.value) * 60 + (typeof value === 'number' ? value % 60 : 0),
                  )
                }
              />
            </label>
            <label className="renewal-field">
              <span>Хвилини</span>
              <input
                type="number"
                min={0}
                max={59}
                inputMode="numeric"
                value={typeof value === 'number' ? value % 60 : ''}
                placeholder="0"
                onChange={(e) =>
                  onChange(
                    field.id,
                    e.target.value === ''
                      ? null
                      : (typeof value === 'number' ? Math.floor(value / 60) * 60 : 0) +
                          Number(e.target.value),
                  )
                }
              />
            </label>
          </div>
          <div className="flex flex-wrap gap-2 mt-3">
            {(field.id.startsWith('sleepMinutes')
              ? [240, 360, 420, 480, 540]
              : [0, 15, 30, 60, 120]
            ).map((n) => (
              <button
                type="button"
                key={n}
                className="renewal-pill"
                aria-pressed={value === n}
                onClick={() => onChange(field.id, n)}
              >
                {n >= 60 ? `${n / 60} год` : `${n} хв`}
              </button>
            ))}
          </div>
          {value != null &&
            !(adaptive ? validValueV3(field, value) : validFieldValue(field, value)) && (
              <p role="alert" className="text-neg text-sm">
                Вкажи цілу тривалість від {field.min ?? 0} до {field.max ?? 1440} хвилин.
              </p>
            )}
        </div>
      ) : (
        <input
          id={id}
          className="checkin-input"
          type={
            field.type === 'datetime'
              ? 'datetime-local'
              : field.type === 'time'
                ? 'time'
                : field.type === 'number'
                  ? 'number'
                  : 'text'
          }
          inputMode={field.type === 'number' ? 'numeric' : undefined}
          min={field.min}
          max={field.max}
          maxLength={field.type === 'text' ? field.max : undefined}
          value={value == null ? '' : String(value)}
          onChange={(e) =>
            onChange(
              field.id,
              e.target.value === ''
                ? null
                : field.type === 'number'
                  ? Number(e.target.value)
                  : e.target.value,
            )
          }
        />
      )}
      {limitMessage && (
        <p role="status" className="text-sm text-a2">
          {limitMessage}
        </p>
      )}
    </div>
  );
}

function CheckinFlow({
  slot,
  date,
  answers,
  morning,
  p,
  onChange,
  onConfirm,
  pending,
  proposal,
}: {
  slot: CheckinSlot;
  date: string;
  answers: Answers;
  morning: Answers;
  p: Preferences;
  onChange: (key: string, value: unknown) => void;
  onConfirm: () => void;
  pending: boolean;
  proposal?: string;
}) {
  const [step, setStep] = useState(0),
    [chosen, setChosen] = useState<string[]>([]),
    [details, setDetails] = useState(false);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const visible = (c: Card) => c.fields.some((f) => fieldVisible(f, answers));
  const core = (CHECKIN_CARDS[slot] ?? []).filter(
    (c) => !c.module && (c.id === 'quality' ? answers.sleepModeV2 !== 'none' : visible(c)),
  );
  const extras = (CHECKIN_CARDS[slot] ?? []).filter(
    (c) => c.module && p.modules.includes(c.module) && visible(c),
  );
  const cards = [...core, ...extras.filter((c) => chosen.includes(c.id))];
  const reviewCards = [
    ...core,
    ...(CHECKIN_CARDS[slot] ?? []).filter(
      (c) => c.module && c.fields.some((f) => fieldVisible(f, answers) && answers[f.id] != null),
    ),
  ];
  const index = Math.min(step, cards.length),
    card = cards[index];
  const complete = (c: Card) =>
    c.fields
      .filter((f) => !f.optional && fieldVisible(f, answers))
      .every((f) => validFieldValue(f, answers[f.id])) &&
    !(c.id === 'sleep' && answers.sleepModeV2 !== 'none' && !(Number(answers.sleepMinutesV2) > 0));
  const next = () => {
    if (card && !complete(card)) return;
    setStep(index + 1);
    haptic('light');
  };
  return (
    <div className="flex flex-col gap-5">
      <div className="flex justify-between gap-2 text-xs text-tx3">
        <span>{card ? `Крок ${index + 1} із ${cards.length}` : 'Перевірка відповідей'}</span>
        <span>{core.length} основні картки</span>
      </div>
      <div className="renewal-progress">
        <span style={{ width: `${Math.min(index / cards.length, 1) * 100}%` }} />
      </div>
      {card ? (
        <div
          key={card.id}
          onTouchStart={(e) => {
            if ((e.target as HTMLElement).closest('input,select,button,summary')) return;
            touch.current = { x: e.touches[0]?.clientX ?? 0, y: e.touches[0]?.clientY ?? 0 };
          }}
          onTouchEnd={(e) => {
            const start = touch.current;
            touch.current = null;
            const end = e.changedTouches[0];
            if (!start || !end) return;
            const dx = end.clientX - start.x,
              dy = end.clientY - start.y;
            if (Math.abs(dx) > 75 && Math.abs(dy) < 40) {
              if (dx < 0) next();
              else setStep(Math.max(0, index - 1));
            }
          }}
          className="flex flex-col gap-5"
        >
          <h3 className="text-xl font-semibold">{card.title}</h3>
          {card.help && <p className="renewal-muted">{card.help}</p>}
          {card.id === 'outcome' && (
            <p className="renewal-inset text-sm">
              Ранковий пріоритет:{' '}
              {morning.priorityV2
                ? fieldLabel(
                    { id: 'priorityV2', label: '', type: 'categories', limit: 1 },
                    morning.priorityV2,
                    p,
                  )
                : 'не записаний'}
              {morning.priorityStepV2 ? ` · ${String(morning.priorityStepV2)}` : ''}
            </p>
          )}
          {card.id === 'sleep-details' && proposal && !answers.sleepAttemptV2 && (
            <button
              className="renewal-secondary"
              onClick={() => onChange('sleepAttemptV2', proposal)}
            >
              Підтвердити час із «Ліг спати»: {proposal.replace('T', ' ')}
            </button>
          )}
          {card.fields.map((f) =>
            f.id === 'extraPriorityV2' ? (
              <details key={f.id}>
                <summary className="renewal-link cursor-pointer">
                  Додатковий пріоритет · за бажанням
                </summary>
                <div className="mt-3">
                  <FieldInput field={f} answers={answers} p={p} date={date} onChange={onChange} />
                </div>
              </details>
            ) : (
              <FieldInput
                key={f.id}
                field={f}
                answers={answers}
                p={p}
                date={date}
                onChange={onChange}
              />
            ),
          )}
          <div className="renewal-form-grid">
            <button
              className="renewal-secondary"
              disabled={index === 0}
              onClick={() => setStep(index - 1)}
            >
              ← Назад
            </button>
            <button className="renewal-button" disabled={!complete(card)} onClick={next}>
              {card.module
                ? 'Далі / пропустити →'
                : index === cards.length - 1
                  ? 'Перевірити'
                  : 'Далі →'}
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="renewal-muted">
            Короткий чек-ін готовий. Перевір відповіді або додай кілька добровільних деталей.
          </p>
          {reviewCards.map((c) => (
            <button
              key={c.id}
              className="renewal-inset text-left"
              onClick={() => {
                const i = cards.findIndex((v) => v.id === c.id);
                if (i >= 0) setStep(i);
                else {
                  setChosen([c.id]);
                  setStep(core.length);
                }
              }}
            >
              <b>{c.title}</b>
              <div className="mt-2 flex flex-col gap-1 text-sm text-tx2">
                {c.fields
                  .filter((f) => fieldVisible(f, answers) && answers[f.id] != null)
                  .map((f) => (
                    <span key={f.id}>
                      {f.label}: {fieldLabel(f, answers[f.id], p)}
                    </span>
                  ))}
              </div>
            </button>
          ))}
          <button
            className="renewal-button"
            disabled={pending || !coreCompleteV2(slot, answers)}
            onClick={onConfirm}
          >
            {pending ? 'Зберігаю…' : 'Підтвердити чек-ін'}
          </button>
          <p className="renewal-chart-note">
            Після підтвердження відповіді зафіксуються. Пропущені деталі не знижують оцінки.
          </p>
        </>
      )}
      {!!extras.length && (
        <div>
          <button
            className="renewal-link"
            aria-expanded={details}
            onClick={() => setDetails(!details)}
          >
            + Додати деталі
          </button>
          {details && (
            <div className="renewal-inset mt-3 flex flex-col gap-4">
              <p className="renewal-chart-note">
                Обери до трьох карток за раз. Можна повернутись і додати інші перед підтвердженням.
              </p>
              {CHECKIN_MODULES.filter(([id]) => extras.some((c) => c.module === id)).map(
                ([id, name]) => (
                  <div key={id}>
                    <p className="text-sm font-semibold mb-2">{name}</p>
                    <div className="flex flex-wrap gap-2">
                      {extras
                        .filter((c) => c.module === id)
                        .map((c) => (
                          <button
                            className="renewal-pill"
                            key={c.id}
                            aria-pressed={chosen.includes(c.id)}
                            disabled={!chosen.includes(c.id) && chosen.length >= 3}
                            onClick={() => {
                              setChosen(
                                chosen.includes(c.id)
                                  ? chosen.filter((x) => x !== c.id)
                                  : [...chosen, c.id],
                              );
                            }}
                          >
                            {chosen.includes(c.id) ? '✓ ' : ''}
                            {c.title}
                          </button>
                        ))}
                    </div>
                  </div>
                ),
              )}
              <button
                className="renewal-secondary"
                onClick={() => {
                  setDetails(false);
                  setStep(core.length);
                }}
              >
                Перейти до обраних деталей
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AnswerSummary({
  slot,
  answers,
  p,
}: {
  slot: CheckinSlot;
  answers: Answers;
  p: Preferences;
}) {
  const legacy = answers.questionVersion !== 2;
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
          : (CHECKIN_CARDS[slot] ?? [])
              .flatMap((c) => c.fields)
              .filter((f) => answers[f.id] != null)
              .map((f) => (
                <p className="text-sm" key={f.id}>
                  {f.label}: <b>{fieldLabel(f, answers[f.id], p)}</b>
                </p>
              ))}
        {typeof answers.answeredAtV2 === 'string' && (
          <p className="renewal-chart-note">
            Остання відповідь:{' '}
            {new Date(String(answers.answeredAtV2)).toLocaleString('uk-UA', {
              timeZone: 'Europe/Kyiv',
            })}{' '}
            · Київ
          </p>
        )}
      </div>
    </details>
  );
}

export function CheckinV2Screen() {
  const query = useStats(),
    settings = useSettings(),
    save = useSaveCheckin(),
    now = useTick(1000);
  const [preview, setPreview] = useState<CheckinSlot>('morning'),
    [drafts, setDrafts] = useState<Record<string, Answers>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  const s = query.data.stats,
    demo = !inTelegram(),
    date = s.checkinDate ?? kyivParts(now).date;
  const p = normalizeCheckinPreferences(settings.data?.settings.checkin);
  const active = demo ? preview : s.checkinSlot;
  const answers = (slot: CheckinSlot): Answers => {
    const prior = s.checkinToday?.[slot] ?? {};
    return prior.confirmed
      ? prior
      : { ...prior, ...(drafts[draftKey(date, slot)] ?? readDraft(draftKey(date, slot))) };
  };
  const current = active ? answers(active) : {};
  const elapsed = Math.floor((now - query.dataUpdatedAt) / 60000),
    left = Math.max(0, (s.checkinSlotEndsIn ?? 0) - elapsed);
  const nextSeconds = Math.max(
    0,
    Math.ceil(
      (s.checkinNextIn ?? checkinClock(kyivParts(now).hour * 60).nextIn) * 60 -
        (now - query.dataUpdatedAt) / 1000,
    ),
  );
  function change(slot: CheckinSlot, key: string, value: unknown) {
    const old = answers(slot);
    const changed = { ...old, [key]: value, questionVersion: 2 };
    if (key === 'movementRangeV2') changed.movementMinutesV2 = null;
    const next = clearHiddenV2(slot, changed);
    // Explicit clears cross the merge boundary, including values hidden by a changed gate.
    for (const k of Object.keys(old)) if (!(k in next) && k.endsWith('V2')) next[k] = null;
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
        answers: { ...answers(slot), questionVersion: 2, confirmed: true },
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
  const proposal = s.sleepLog
    .filter(
      (n) =>
        n.startedAt &&
        now - Date.parse(n.startedAt) >= 0 &&
        now - Date.parse(n.startedAt) < 48 * 3600000,
    )
    .at(-1)?.startedAt;
  const localProposal = proposal
    ? new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Europe/Kyiv',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
        .format(new Date(proposal))
        .replace(' ', 'T')
    : undefined;
  return (
    <div className="flex flex-col gap-5">
      <PageHeading
        eyebrow="ПАУЗА ДЛЯ СЕБЕ"
        title="Помітити себе."
        accent="У своєму ритмі."
        description="Коротке ядро, добровільні деталі та чесні спостереження."
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
                    ? `Чернетка · ще ${left} хв`
                    : `Від ${p.schedule[slot]}`}
              </span>
            </div>
            {live && !confirmed ? (
              <div className="mt-5">
                <CheckinFlow
                  key={`${date}:${slot}`}
                  slot={slot}
                  date={date}
                  answers={value}
                  morning={answers('morning')}
                  p={p}
                  pending={save.isPending}
                  onChange={(key, v) => change(slot, key, v)}
                  onConfirm={() => confirm(slot)}
                  proposal={localProposal}
                />
              </div>
            ) : (
              <AnswerSummary slot={slot} answers={value} p={p} />
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
      <CheckinPreferences />
    </div>
  );
}
