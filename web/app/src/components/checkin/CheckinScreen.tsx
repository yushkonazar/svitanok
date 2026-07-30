import { useEffect, useRef, useState } from 'react';
import { useStats, useSaveCheckin } from '../../api/hooks.ts';
import type { CheckinSlot } from '../../api/schema.ts';
import { haptic, inTelegram } from '../../telegram.ts';
import { LoadingSkeleton, ErrorState } from '../ui/states.tsx';
import { cascade } from '../ui/Cascade.tsx';
import { AffectPad } from './AffectPad.tsx';
import { BrandLogo } from './BrandLogo.tsx';
import {
  BLOCKS,
  asList,
  coreQuestions,
  deepQuestions,
  isAnswered,
  isDone,
  isWorkDay,
  pluralizePytannya,
  visibleQuestions,
  type Block,
  type Question,
} from './questions.ts';

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
//
// Розділ «Детальніше» згорнутий за замовчуванням: розширений набір питань
// (сон-латентність, румінація, автономія, екран, кофеїн…) цінний для аналізу,
// але щоденне ядро мусить лишатись коротким — інакше звичка вмирає.

/** Скільки чекаємо після останнього тапу, перш ніж слати блок. */
const DEBOUNCE_MS = 1200;

// null — явний сигнал «зняв відповідь» (не «ще не відповідав»): questions.ts
// isAnswered/condMet трактують null так само, як відсутній ключ, але на
// дроті це РІЗНІ речі — сервер мусить прибрати поле, а не проігнорувати подію.
type AnswerValue = string | number | Array<string | number> | null;
// confirmed — прапорець «Підтверджено», не відповідь на питання: живе поруч
// із Answers, а не всередині AnswerValue, щоб isAnswered/asList/питання-цикли
// й далі не бачили нічого, крім реальних полів чек-іну.
type Answers = Record<string, AnswerValue> & { confirmed?: boolean };
type State = 'locked' | 'open' | 'done' | 'missed';

const ORDER: CheckinSlot[] = ['morning', 'afternoon', 'evening'];

const pad2 = (n: number) => String(n).padStart(2, '0');

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

/** Один варіант відповіді — спільна кнопка для `one` і `multi`. */
function OptionButton({
  label,
  icon,
  on,
  disabled,
  onClick,
}: {
  label: string;
  icon?: React.ReactNode;
  on: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      // tabIndex -1 у згорнутому: інакше блок «пропущено» лишається
      // доступним з клавіатури, хоч візуально закритий. Візуальне згортання
      // (grid-rows 0fr) робить тап недосяжним для звичайного дотику, але сам
      // обробник — друга лінія захисту: підтверджений блок мусить лишатись
      // незмінним НАВІТЬ якщо хтось дістанеться кнопки в обхід розмітки.
      tabIndex={disabled ? -1 : 0}
      disabled={disabled}
      onClick={disabled ? undefined : onClick}
      className="min-w-[40px] flex-auto rounded-[10px] border px-1.5 py-2 text-[11.5px] font-semibold transition-colors disabled:cursor-default"
      style={{
        borderColor: on ? 'var(--color-a2)' : 'var(--color-glassb)',
        background: on ? 'color-mix(in srgb, var(--color-a2) 16%, transparent)' : 'var(--color-bg2)',
        color: on ? 'var(--color-tx)' : 'var(--color-tx2)',
      }}
    >
      {/* pop лише на ВИБІР (ремоунт за key, як серце NewsItem); зняття
          відповіді проходить тихо — підстрибувати на «передумав» нема чому. */}
      <span
        key={String(on)}
        className="flex items-center justify-center gap-1"
        style={on ? { animation: 'pop .24s cubic-bezier(.22,1,.36,1)' } : undefined}
      >
        {icon}
        {label}
      </span>
    </button>
  );
}

function QuestionRow({
  q,
  answers,
  disabled,
  onAnswer,
  onPad,
}: {
  q: Question;
  answers: Answers;
  disabled: boolean;
  onAnswer: (id: string, v: string | number, multi?: number) => void;
  onPad: (xId: string, x: number, yId: string, y: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-1.5">
        <div className="text-[12.5px] font-semibold text-tx2">{q.t}</div>
        {q.kind === 'multi' && (
          <span className="font-mono text-[9px] text-tx3">до {q.max ?? 3}</span>
        )}
      </div>

      {q.kind === 'pad' && q.pad ? (
        <AffectPad
          xLabel={q.pad.xLabel}
          yLabel={q.pad.yLabel}
          x={answers[q.pad.x] as number | null | undefined}
          y={answers[q.pad.y] as number | null | undefined}
          disabled={disabled}
          onPick={(x, y) => onPad(q.pad!.x, x, q.pad!.y, y)}
        />
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {(q.o ?? []).map(([lbl, v]) => {
            const on =
              q.kind === 'multi' ? asList(answers[q.id]).includes(v) : answers[q.id] === v;
            return (
              <OptionButton
                key={String(v)}
                label={lbl}
                icon={q.id === 'flames' ? <BrandLogo id={String(v)} /> : undefined}
                on={on}
                disabled={disabled}
                onClick={() => onAnswer(q.id, v, q.kind === 'multi' ? (q.max ?? 3) : undefined)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function BlockCard({
  b,
  state,
  live,
  answers,
  workDay,
  onAnswer,
  onPad,
  onConfirm,
}: {
  b: Block;
  state: State;
  /** Активне вікно ЦЬОГО блоку зараз (або демо-режим) — підтвердити можна
   *  ЛИШЕ поки воно живе, інакше кнопка обіцяла б збереження, якого сервер
   *  однаково відкинув би (слот/дату визначає він, а не клієнтський час). */
  live: boolean;
  answers: Answers;
  workDay: boolean;
  onAnswer: (q: string, v: string | number, multi?: number) => void;
  onPad: (xId: string, x: number, yId: string, y: number) => void;
  onConfirm: () => void;
}) {
  const [deepOpen, setDeepOpen] = useState(false);
  // «Записаний» блок можна РОЗГОРНУТИ НАЗАД. Без цього була дірка: isDone
  // рахує лише ЯДРО (не-soft core-питання), тож щойно відповів на основні —
  // блок згортався в «✓ ЗАПИСАНО», а разом із ним ставав недосяжним і розділ
  // «Детальніше». Тобто на глибокі питання не було як відповісти взагалі.
  // Згортання лишається (підсумок чипами — корисний стан), але тепер це
  // ПЕРЕМИКАЧ, а не однобічні двері.
  //
  // ⚠️ Підтверджений блок (confirmed) з цього правила ВИКЛЮЧЕНИЙ навмисне:
  // кнопка «Підтвердити» (нижче) існує рівно для того, щоб після неї
  // «розгорнути назад» більше не можна було — інакше підтвердження нічого
  // не гарантує.
  const [reopened, setReopened] = useState(false);
  const confirmed = !!answers.confirmed;

  const core = coreQuestions(b, workDay, answers);
  const deep = deepQuestions(b, workDay, answers);
  const deepFilled = deep.filter((q) => isAnswered(q, answers)).length;
  const deepLeft = deep.length - deepFilled;
  const coreDone = isDone(b, answers);

  // ⚠️ isDone (у stateOf) перевіряється РАНІШЕ за «активний слот», тож щойно
  // відповів на ядро — state миттю стає 'done', НАВІТЬ якщо вікно блоку й
  // досі активне. Раніше це й спричиняло автозгортання просто на середині
  // заповнення. Тому «розгорнуто» рахуємо НЕ від state, а від `live` напряму:
  // поки вікно живе, блок лишається відкритим завжди — заповнюєш ядро, бачиш
  // кнопку «Підтвердити», можеш дозаповнити «Детальніше» — усе без згортання.
  // Лише коли вікно ЗАКРИЛОСЬ (і підтвердження не було), вмикається старий
  // режим «згорнуто, розгорни вручну» (canReopen).
  const canReopen = state === 'done' && !confirmed && !live;
  const expanded = !confirmed && (live || (canReopen && reopened));
  // «Пропущений» лишається замкненим свідомо: відповідь заднім числом —
  // здогадка, не дані. Підтверджений — замкнений НАЗАВЖДИ, а не до кінця вікна.
  const disabled = !expanded;
  // Показуємо кнопку, лише поки вікно блоку РЕАЛЬНО живе: підтвердження,
  // надіслане в закрите вікно, сервер тихо відкинув би (той самий гейт, що
  // й звичайні правки), і власник побачив би «підтверджено», яке насправді
  // не зберіглось. Чесніше не показувати кнопку взагалі, ніж брехати нею.
  const canConfirm = live && !confirmed && coreDone;

  const label = confirmed
    ? '🔒 ПІДТВЕРДЖЕНО'
    : live
      ? coreDone
        ? deepLeft > 0
          ? `ГОТОВО · ЩЕ ${deepLeft}`
          : 'ГОТОВО — ПІДТВЕРДЬ'
        : 'ЗАПОВНИ'
      : state === 'done'
        ? reopened
          ? '▲ ЗГОРНУТИ'
          : deepLeft > 0
            ? `✓ ЗАПИСАНО · ЩЕ ${deepLeft}`
            : '✓ ЗАПИСАНО'
        : state === 'missed'
          ? 'ПРОПУЩЕНО'
          : `ВІДКРИЄТЬСЯ О ${pad2(b.from)}:00`;

  const tone =
    confirmed || (live && coreDone)
      ? 'text-pos'
      : live || state === 'open'
        ? 'text-a2'
        : state === 'done'
          ? 'text-pos'
          : 'text-tx3';

  const head = (
    <>
      <span className="text-[15px]">{b.ic}</span>
      <span className="text-[13.5px] font-bold">{b.nm}</span>
      <span className={`ml-auto font-mono text-[9.5px] font-semibold tracking-[0.05em] ${tone}`}>
        {label}
      </span>
    </>
  );

  return (
    <div
      className="overflow-hidden rounded-2xl border transition-[border-color,background,opacity] duration-[400ms]"
      style={{
        borderColor:
          live && !confirmed
            ? 'color-mix(in srgb, var(--color-a2) 55%, transparent)'
            : 'var(--color-glassb)',
        background:
          live && !confirmed
            ? 'color-mix(in srgb, var(--color-a2) 7%, var(--color-glass))'
            : 'var(--color-glass)',
        opacity: state === 'locked' ? 0.5 : state === 'missed' ? 0.62 : 1,
      }}
    >
      {canReopen ? (
        <button
          type="button"
          aria-expanded={reopened}
          onClick={() => {
            haptic('light');
            setReopened((v) => !v);
          }}
          className="flex w-full items-center gap-2.5 px-3.5 py-3 text-left"
        >
          {head}
        </button>
      ) : (
        <div className="flex items-center gap-2.5 px-3.5 py-3">{head}</div>
      )}

      {/* grid-rows 0fr->1fr анімує висоту, не знаючи її в px (вона різна в блоках). */}
      <div
        className="grid transition-[grid-template-rows] duration-[450ms] ease-[cubic-bezier(.22,1,.36,1)]"
        style={{ gridTemplateRows: expanded ? '1fr' : '0fr' }}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="flex flex-col gap-3.5 px-3.5 pb-3.5">
            {core.map((q) => (
              <QuestionRow
                key={q.id}
                q={q}
                answers={answers}
                disabled={disabled}
                onAnswer={onAnswer}
                onPad={onPad}
              />
            ))}

            {deep.length > 0 && (
              <>
                <button
                  type="button"
                  tabIndex={disabled ? -1 : 0}
                  onClick={() => {
                    haptic('light');
                    setDeepOpen((v) => !v);
                  }}
                  className="flex items-center gap-1.5 self-start rounded-full border border-glassb bg-glass px-3 py-1.5 text-[11px] font-semibold text-tx2"
                >
                  <span>{deepOpen ? '−' : '+'} Детальніше</span>
                  <span className="font-mono text-[9.5px] text-tx3">
                    {deepFilled
                      ? `${deepFilled}/${deep.length}`
                      : `${deep.length} ${pluralizePytannya(deep.length)}`}
                  </span>
                </button>
                {deepOpen && (
                  <div className="flex flex-col gap-3.5 border-t border-glassb pt-3.5">
                    {deep.map((q) => (
                      <QuestionRow
                        key={q.id}
                        q={q}
                        answers={answers}
                        disabled={disabled}
                        onAnswer={onAnswer}
                        onPad={onPad}
                      />
                    ))}
                  </div>
                )}
              </>
            )}

            {canConfirm && (
              <div className="flex flex-col gap-1.5 border-t border-glassb pt-3.5">
                <p className="text-[10.5px] leading-[1.45] text-tx3">
                  Після підтвердження відповіді зафіксуються — передумати вже не вийде. Перевір,
                  перш ніж тиснути.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    haptic('success');
                    onConfirm();
                  }}
                  className="rounded-xl py-2.5 text-center text-[12.5px] font-bold"
                  style={{ background: 'var(--grad)', color: 'var(--color-onacc)' }}
                >
                  🔒 Підтвердити відповіді
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Чипи — коли блок ЗГОРНУТИЙ: підтверджено назавжди, АБО вікно
          закрилось (не live) і не розгорнуто вручну. Поки вікно живе,
          блок лишається розгорнутим (expanded=true), тож чипи тут не мають
          сенсу — там уже видно самі відповіді. */}
      {(confirmed || (!live && state === 'done' && !reopened)) && (
        <div className="flex flex-wrap gap-1.5 px-3.5 pb-3">
          {/* Чипи підсумку вилітають каскадом, коли блок згорнувся в «записано».
              У ПЕРЕВІДКРИТОМУ блоці їх немає: там уже видно самі відповіді,
              і чипи дублювали б їх удвічі.
              visibleQuestions, а не b.qs: приховане джоб-число (обрав «Робота»,
              ввів, перемкнув на іншу категорію) не мусить зринати чипом. */}
          {visibleQuestions(b, workDay, answers)
            .filter((q) => isAnswered(q, answers))
            .map((q, i) => {
              const text =
                q.kind === 'pad' && q.pad
                  ? `${q.pad.yLabel} ${answers[q.pad.y]} · ${q.pad.xLabel} ${answers[q.pad.x]}`
                  : asList(answers[q.id])
                      .map((v) => (q.o ?? []).find(([, ov]) => ov === v)?.[0] ?? String(v))
                      .join(', ');
              return (
                <span
                  key={q.id}
                  className="rounded-full border border-glassb px-2 py-0.5 font-mono text-[9.5px] font-semibold text-tx2"
                  style={cascade(i, 40)}
                >
                  {text}
                </span>
              );
            })}
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
    return (
      <ErrorState
        message={(error as Error)?.message ?? 'Спробуй ще раз'}
        onRetry={() => void refetch()}
      />
    );

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

  /** Дебаунс: шлемо ВЕСЬ блок одним запитом. Без цього чотири тапи = чотири
   *  записи в один KV-ключ, а там ліміт 1/сек і немає CAS. */
  const queue = (slot: CheckinSlot, next: Answers) => {
    setLocal((p) => ({ ...p, [slot]: next }));
    clearTimeout(timers.current[slot]);
    timers.current[slot] = setTimeout(() => {
      save.mutate({ slot, answers: next });
    }, DEBOUNCE_MS);
  };

  const onAnswer = (slot: CheckinSlot, q: string, v: string | number, multi?: number) => {
    haptic('light');
    const cur = answersFor(slot);
    const next: Answers = { ...cur };
    if (multi) {
      const list = asList(cur[q]);
      // Повторний тап знімає; понад ліміт — витісняємо найстаріший вибір, а не
      // мовчки ігноруємо тап (інакше кнопка виглядає зламаною).
      const has = list.includes(v);
      const kept = has ? list.filter((x) => x !== v) : [...list, v].slice(-multi);
      // [] — ЯВНИЙ сигнал «очисти» (stats-core.mjs cleanCheckin), не «не
      // чіпай»: без нього сервер лишав би старий вибір навіть після того, як
      // тут показано порожньо (баг: зняти відповідь можна було лише ЛОКАЛЬНО,
      // до першого дебаунсу — на сервері значення трималось назавжди).
      next[q] = kept.length ? kept : [];
    } else if (next[q] === v) {
      // null — ЯВНИЙ сигнал «очисти» (не відсутній ключ): та сама причина,
      // що для мультивибору вище — «передумав» мусить дійти до сервера.
      next[q] = null;
    } else {
      next[q] = v;
    }
    queue(slot, next);
  };

  const onPad = (slot: CheckinSlot, xId: string, x: number, yId: string, y: number) => {
    haptic('light');
    const cur = answersFor(slot);
    const next: Answers = { ...cur };
    // Повторний тап по ТІЙ САМІЙ клітинці знімає обидві осі разом — пад
    // поводиться як одна відповідь, якою й є для власника. null (не delete) —
    // явний сигнал «очисти» для сервера, той самий мотив, що onAnswer вище.
    if (cur[xId] === x && cur[yId] === y) {
      next[xId] = null;
      next[yId] = null;
    } else {
      next[xId] = x;
      next[yId] = y;
    }
    queue(slot, next);
  };

  /**
   * Підтвердження — ОДИН атомарний запит, а не «спершу дошли правки, тоді
   * підтверди»: два окремі запити до KV (ліміт 1/сек, немає CAS) ризикували б
   * гонкою, де confirmed приземлився б РАНІШЕ за останню правку. Тому
   * невідісланий local[slot] їде в тому самому тілі, що й confirmed:true —
   * сервер мерджить і фіксує однією операцією (case 'checkin' у stats-core.mjs).
   */
  const onConfirm = (slot: CheckinSlot) => {
    clearTimeout(timers.current[slot]);
    const pending = local[slot] ?? {};
    save.mutate({ slot, answers: { ...pending, confirmed: true } });
    setLocal((p) => {
      const next = { ...p };
      delete next[slot];
      return next;
    });
  };

  const filled = ORDER.filter((slot) => {
    const b = BLOCKS.find((x) => x.id === slot)!;
    return isDone(b, answersFor(slot));
  }).length;

  // Роб.день — за ранковим «головне». Керує показом опційних джоб-питань у всіх
  // блоках (вечірні «просування/віра» теж залежать від ранкового вибору).
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
              demo && !isDone(b, answersFor(b.id)) ? 'open' : stateOf(b, active, answersFor(b.id))
            }
            live={demo || active === b.id}
            answers={answersFor(b.id)}
            workDay={workDay}
            onAnswer={(q, v, multi) => onAnswer(b.id, q, v, multi)}
            onPad={(xId, x, yId, y) => onPad(b.id, xId, x, yId, y)}
            onConfirm={() => onConfirm(b.id)}
          />
        </div>
      ))}

      {!active && (
        <p className="text-[12.5px] leading-[1.5] text-tx2">
          Блоки живуть за часом: ранок з 08:00, післяобід з 14:00, вечір з 20:00. Пропущений блок
          лишається порожнім — відповідь заднім числом була б здогадкою, а не даними.
        </p>
      )}
    </div>
  );
}
