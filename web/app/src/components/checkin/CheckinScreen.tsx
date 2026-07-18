import { useEffect, useRef, useState } from 'react';
import { useStats, useSaveCheckin } from '../../api/hooks.ts';
import type { CheckinSlot } from '../../api/schema.ts';
import { haptic, inTelegram } from '../../telegram.ts';
import { LoadingSkeleton, ErrorState } from '../ui/states.tsx';
import { cascade } from '../ui/Cascade.tsx';
import { BLOCKS, isDone, isWorkDay, visibleQuestions, type Block } from './questions.ts';

// Таб «Чек-ін» (фідбек власника, п.7): три блоки, що відкриваються за часом.
//
// Стани блоку:
//   locked  — час ще не настав;
//   open    — час настав, ще не відповіли (розгорнутий);
//   done    — відповіли (згортається з анімацією, лишає підсумок чипами);
//   missed  — час минув, порожній.
//
// ⚠️ Пропущений блок НЕ дозаповнюється, і це рішення, а не недогляд. На питання
// «як почуваєшся ЗАРАЗ» о 23:00 за ранок відповіді немає — буде здогадка. Одна
// така здогадка на тиждень, і крива енергії показує те, чого не було. Дірка в
// даних чесніша за вигадку; до того ж самі пропуски — сигнал (ранок заповнений
// 25 разів, вечір 4 — це вже висновок).
//
// Активний блок каже СЕРВЕР (stats.checkinSlot): клієнтському годиннику не
// віримо, інакше «ранковий» блок відкривався б опівночі переведенням годинника.

/** Скільки чекаємо після останнього тапу, перш ніж слати блок. */
const DEBOUNCE_MS = 1200;

type Answers = Record<string, string | number>;
type State = 'locked' | 'open' | 'done' | 'missed';

const ORDER: CheckinSlot[] = ['morning', 'afternoon', 'evening'];

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Стан блоку. `active` — що каже сервер (null у тиху зону 02:00–07:59).
 *
 * «Минув» рахуємо за ПОРЯДКОМ блоків, а не за годинником: активний вечір означає,
 * що ранок і післяобід уже позаду. У тиху зону (active=null) минулих немає —
 * там доба вже нова, і всі три просто чекають свого часу.
 */
function stateOf(b: Block, active: CheckinSlot | null | undefined, answers?: Answers): State {
  if (isDone(b, answers)) return 'done';
  if (active === b.id) return 'open';
  if (!active) return 'locked';
  return ORDER.indexOf(b.id) < ORDER.indexOf(active) ? 'missed' : 'locked';
}

function BlockCard({
  b,
  state,
  answers,
  workDay,
  onAnswer,
}: {
  b: Block;
  state: State;
  answers: Answers;
  workDay: boolean;
  onAnswer: (q: string, v: string | number) => void;
}) {
  const label =
    state === 'open'
      ? 'ЗАПОВНИ'
      : state === 'done'
        ? '✓ ЗАПИСАНО'
        : state === 'missed'
          ? 'ПРОПУЩЕНО'
          : `ВІДКРИЄТЬСЯ О ${pad(b.from)}:00`;

  const tone =
    state === 'open' ? 'text-a2' : state === 'done' ? 'text-pos' : 'text-tx3';

  return (
    <div
      className="overflow-hidden rounded-2xl border transition-[border-color,background,opacity] duration-[400ms]"
      style={{
        borderColor: state === 'open' ? 'color-mix(in srgb, var(--color-a2) 55%, transparent)' : 'var(--color-glassb)',
        background:
          state === 'open' ? 'color-mix(in srgb, var(--color-a2) 7%, var(--color-glass))' : 'var(--color-glass)',
        opacity: state === 'locked' ? 0.5 : state === 'missed' ? 0.62 : 1,
      }}
    >
      <div className="flex items-center gap-2.5 px-3.5 py-3">
        <span className="text-[15px]">{b.ic}</span>
        <span className="text-[13.5px] font-bold">{b.nm}</span>
        <span className={`ml-auto font-mono text-[9.5px] font-semibold tracking-[0.05em] ${tone}`}>
          {label}
        </span>
      </div>

      {/* grid-rows 0fr->1fr анімує висоту, не знаючи її в px (вона різна в блоках). */}
      <div
        className="grid transition-[grid-template-rows] duration-[450ms] ease-[cubic-bezier(.22,1,.36,1)]"
        style={{ gridTemplateRows: state === 'open' ? '1fr' : '0fr' }}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="flex flex-col gap-3.5 px-3.5 pb-3.5">
            {visibleQuestions(b, workDay).map((q) => (
              <div key={q.id} className="flex flex-col gap-1.5">
                <div className="text-[12.5px] font-semibold text-tx2">{q.t}</div>
                <div className="flex flex-wrap gap-1.5">
                  {q.o.map(([lbl, v]) => {
                    const on = answers[q.id] === v;
                    return (
                      <button
                        key={String(v)}
                        type="button"
                        aria-pressed={on}
                        // tabIndex -1 у згорнутому: інакше блок «пропущено» лишається
                        // доступним з клавіатури, хоч візуально закритий.
                        tabIndex={state === 'open' ? 0 : -1}
                        onClick={() => onAnswer(q.id, v)}
                        className="min-w-[40px] flex-auto rounded-[10px] border px-1.5 py-2 text-[11.5px] font-semibold transition-colors"
                        style={{
                          borderColor: on ? 'var(--color-a2)' : 'var(--color-glassb)',
                          background: on
                            ? 'color-mix(in srgb, var(--color-a2) 16%, transparent)'
                            : 'var(--color-bg2)',
                          color: on ? 'var(--color-tx)' : 'var(--color-tx2)',
                        }}
                      >
                        {/* pop лише на ВИБІР (ремоунт за key, як серце NewsItem);
                            зняття відповіді проходить тихо — підстрибувати на
                            «передумав» нема чому. */}
                        <span
                          key={String(on)}
                          className="block"
                          style={on ? { animation: 'pop .24s cubic-bezier(.22,1,.36,1)' } : undefined}
                        >
                          {lbl}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {state === 'done' && (
        <div className="flex flex-wrap gap-1.5 px-3.5 pb-3">
          {/* Чипи підсумку вилітають каскадом, коли блок згорнувся в «записано».
              visibleQuestions, а не b.qs: приховане джоб-число (обрав «Робота»,
              ввів, перемкнув на іншу категорію) не мусить зринати чипом. */}
          {visibleQuestions(b, workDay)
            .filter((q) => answers[q.id] !== undefined)
            .map((q, i) => (
              <span
                key={q.id}
                className="rounded-full border border-glassb px-2 py-0.5 font-mono text-[9.5px] font-semibold text-tx2"
                style={cascade(i, 40)}
              >
                {q.o.find(([, v]) => v === answers[q.id])?.[0] ?? String(answers[q.id])}
              </span>
            ))}
        </div>
      )}
    </div>
  );
}

export function CheckinScreen() {
  const { data, isLoading, isError, error, refetch } = useStats();
  const save = useSaveCheckin();
  const [local, setLocal] = useState<Record<string, Answers>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // Гасимо таймери на розмонтуванні — інакше пішов би запит з екрана, якого вже
  // немає, і React лаявся б на setState після unmount.
  useEffect(() => {
    const t = timers.current;
    return () => Object.values(t).forEach(clearTimeout);
  }, []);

  if (isLoading) return <LoadingSkeleton />;
  if (isError)
    return <ErrorState message={(error as Error)?.message ?? 'Спробуй ще раз'} onRetry={() => void refetch()} />;

  const s = data?.stats;
  const active = s?.checkinSlot ?? null;
  const server = s?.checkinToday ?? {};
  // Демо (поза Telegram): відкриваємо ВСІ незаповнені блоки, щоб на прев'ю було
  // видно всі питання одразу. У проді час і далі гейтить блоки (це лише огляд).
  const demo = !inTelegram();

  const answersFor = (slot: CheckinSlot): Answers => ({
    ...((server[slot] ?? {}) as Answers),
    ...(local[slot] ?? {}),
  });

  const onAnswer = (slot: CheckinSlot, q: string, v: string | number) => {
    haptic('light');
    const cur = answersFor(slot);
    // Повторний тап знімає — щоб можна було передумати.
    const next: Answers = { ...cur };
    if (next[q] === v) delete next[q];
    else next[q] = v;
    setLocal((p) => ({ ...p, [slot]: next }));

    // Дебаунс: шлемо ВЕСЬ блок одним запитом. Без цього чотири тапи = чотири
    // записи в один KV-ключ, а там ліміт 1/сек і немає CAS.
    clearTimeout(timers.current[slot]);
    timers.current[slot] = setTimeout(() => {
      save.mutate({ slot, answers: next });
    }, DEBOUNCE_MS);
  };

  const filled = ORDER.filter((slot) => {
    const b = BLOCKS.find((x) => x.id === slot)!;
    return isDone(b, answersFor(slot));
  }).length;

  // Роб.день — за ранковим «головне». Керує показом опційних джоб-чисел у всіх
  // блоках (вечірнє «скільки вийшло» теж залежить від ранкового вибору).
  const workDay = isWorkDay(answersFor('morning'));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[10.5px] font-medium text-tx3">
          {active ? `ЗАПОВНЕНО ${filled} З 3` : 'ЗАРАЗ ЖОДЕН БЛОК НЕ ВІДКРИТИЙ'}
        </span>
      </div>

      {/* Ранок → післяобід → вечір зʼявляються по черзі: каскад повторює
          порядок доби. Індекси статичні, тож голого cascade(i) досить. */}
      {BLOCKS.map((b, i) => (
        <div key={b.id} style={cascade(i, 80)}>
          <BlockCard
            b={b}
            state={
              demo && !isDone(b, answersFor(b.id))
                ? 'open'
                : stateOf(b, active, answersFor(b.id))
            }
            answers={answersFor(b.id)}
            workDay={workDay}
            onAnswer={(q, v) => onAnswer(b.id, q, v)}
          />
        </div>
      ))}

      {!active && (
        <p className="text-[12.5px] leading-[1.5] text-tx2">
          Блоки живуть за часом: ранок з 08:00, післяобід з 14:00, вечір з 20:00.
          Пропущений блок лишається порожнім — відповідь заднім числом була б
          здогадкою, а не даними.
        </p>
      )}
    </div>
  );
}
