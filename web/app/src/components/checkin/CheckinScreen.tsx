import { useEffect, useRef, useState } from 'react';
import { useStats, useSaveCheckin } from '../../api/hooks.ts';
import { resetCheckinDemo } from '../../api/checkin-demo.ts';
import type { CheckinSlot } from '../../api/schema.ts';
import { haptic, inTelegram } from '../../telegram.ts';
import { LoadingSkeleton, ErrorState } from '../ui/states.tsx';
import { cascade } from '../ui/Cascade.tsx';
import { AffectPad } from './AffectPad.tsx';
import { BrandLogo } from './BrandLogo.tsx';
import { useTick } from '../../lib/useTick.ts';
import { PageHeading } from '../ui/PageHeading.tsx';
import { pluralUk } from '../../lib/plural.ts';
import { kyivParts, kyivInstant, shiftDate } from '../../../../core/finance/planning.mjs';
import {
  BLOCKS,
  asList,
  clearGatedAnswers,
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
const currentQuestion = (q: Question) =>
  !['planApply', 'applied', 'jobProgress', 'jobConfidence'].includes(q.id);

const DEBOUNCE_MS = 1200;

// null — явний сигнал «зняв відповідь» (не «ще не відповідав»): questions.ts
// isAnswered/condMet трактують null так само, як відсутній ключ, але на
// дроті це РІЗНІ речі — сервер мусить прибрати поле, а не проігнорувати подію.
type AnswerValue = string | number | Array<string | number> | null;
// confirmed — прапорець «Підтверджено», не відповідь на питання: живе поруч
// із Answers, а не всередині AnswerValue, щоб isAnswered/asList/питання-цикли
// й далі не бачили нічого, крім реальних полів чек-іну.
type Answers = Record<string, AnswerValue> & { confirmed?: boolean };
const draftMemory = new Map<string, Answers>();
function readDraft(key: string): Answers {
  if (draftMemory.has(key)) return draftMemory.get(key)!;
  try {
    const raw = JSON.parse(sessionStorage.getItem(key) ?? '{}');
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length < 100) {
      const valid = Object.fromEntries(
        Object.entries(raw).filter(
          ([k, v]) =>
            k !== 'confirmed' &&
            (v === null ||
              typeof v === 'string' ||
              typeof v === 'number' ||
              (Array.isArray(v) && v.every((x) => typeof x === 'string' || typeof x === 'number'))),
        ),
      );
      draftMemory.set(key, valid as Answers);
      return valid as Answers;
    }
  } catch {
    /* Storage unavailable or invalid draft. */
  }
  return {};
}
function writeDraft(key: string, answers?: Answers) {
  if (answers) draftMemory.set(key, answers);
  else draftMemory.delete(key);
  try {
    if (answers) sessionStorage.setItem(key, JSON.stringify(answers));
    else sessionStorage.removeItem(key);
  } catch {
    /* Keep memory fallback. */
  }
}
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
        background: on
          ? 'color-mix(in srgb, var(--color-a2) 16%, transparent)'
          : 'var(--color-bg2)',
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
            const on = q.kind === 'multi' ? asList(answers[q.id]).includes(v) : answers[q.id] === v;
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
  endsIn,
  onExpire,
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
  /** Хвилин до закриття блоку (сервер). null — блок не активний. */
  endsIn: number | null;
  onExpire: () => void;
}) {
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

  const core = coreQuestions(b, workDay, answers).filter(currentQuestion);
  const deep = deepQuestions(b, workDay, answers).filter(currentQuestion);
  const deepFilled = deep.filter((q) => currentQuestion(q) && isAnswered(q, answers)).length;
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
  const [reviewing, setReviewing] = useState(false);
  const canConfirm = live && !confirmed && coreDone && reviewing;

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
      {/* Таймер лише на ЖИВОМУ й не підтвердженому блоці: у підтвердженого
          вікно вже не має значення (правки не приймаються), у закритого —
          тим паче. */}
      {live && !confirmed && endsIn != null && (
        <SlotTimer key={endsIn} endsIn={endsIn} onExpire={onExpire} />
      )}
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
        aria-hidden={!expanded}
        inert={!expanded}
        className="grid transition-[grid-template-rows] duration-[450ms] ease-[cubic-bezier(.22,1,.36,1)]"
        style={{ gridTemplateRows: expanded ? '1fr' : '0fr' }}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="flex flex-col gap-3.5 px-3.5 pb-3.5">
            <QuestionSteps
              core={core}
              deep={deep}
              onReview={setReviewing}
              answers={answers}
              disabled={disabled}
              onAnswer={onAnswer}
              onPad={onPad}
            />

            {canConfirm && (
              <div className="flex flex-col gap-1.5 border-t border-glassb pt-3.5">
                <p className="text-[10.5px] leading-[1.45] text-tx3">
                  Після підтвердження відповіді зафіксуються — передумати вже не вийде. Перевір,
                  перш ніж тиснути.
                </p>
                <button
                  type="button"
                  onClick={() => {
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
      {confirmed && (
        <details className="px-4 pb-4">
          <summary className="renewal-link">Переглянути відповіді</summary>
          {visibleQuestions(b, workDay, answers)
            .filter((q) => currentQuestion(q) && isAnswered(q, answers))
            .map((q) => (
              <div className="renewal-list-row" key={q.id}>
                <span>{q.t}</span>
                <strong className="text-right text-xs max-w-[55%]">
                  {answerLabel(q, answers)}
                </strong>
              </div>
            ))}
        </details>
      )}
      {(confirmed || (!live && state === 'done' && !reopened)) && (
        <div className="flex flex-wrap gap-1.5 px-3.5 pb-3">
          {/* Чипи підсумку вилітають каскадом, коли блок згорнувся в «записано».
              У ПЕРЕВІДКРИТОМУ блоці їх немає: там уже видно самі відповіді,
              і чипи дублювали б їх удвічі.
              visibleQuestions, а не b.qs: приховане джоб-число (обрав «Робота»,
              ввів, перемкнув на іншу категорію) не мусить зринати чипом. */}
          {visibleQuestions(b, workDay, answers)
            .filter((q) => currentQuestion(q) && isAnswered(q, answers))
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

function answerLabel(q: Question, answers: Answers) {
  if (q.kind === 'pad' && q.pad)
    return `${q.pad.yLabel} ${answers[q.pad.y] ?? '—'} · ${q.pad.xLabel} ${answers[q.pad.x] ?? '—'}`;
  return (
    asList(answers[q.id])
      .map((v) => (q.o ?? []).find(([, ov]) => ov === v)?.[0] ?? String(v))
      .join(', ') || 'Не заповнено'
  );
}

function QuestionSteps({
  onReview,
  core,
  deep,
  answers,
  disabled,
  onAnswer,
  onPad,
}: {
  core: Question[];
  deep: Question[];
  onReview: (ready: boolean) => void;
} & Omit<Parameters<typeof QuestionRow>[0], 'q'>) {
  const [step, setStep] = useState(0);
  const [includeDeep, setIncludeDeep] = useState(false);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const questions = includeDeep ? [...core, ...deep] : core;
  const index = Math.min(step, questions.length);
  const q = questions[index];
  useEffect(() => onReview(!q), [q, onReview]);
  const done = questions.filter((p) => isAnswered(p, answers)).length;
  const next = () => {
    if (q && !q.soft && !q.deep && !isAnswered(q, answers)) return;
    const nextIndex = Math.min(index + 1, questions.length);
    setStep(nextIndex);
    onReview(nextIndex === questions.length);
    haptic('light');
  };
  return (
    <div className="flex flex-col gap-4">
      <div className="renewal-section-head mb-0">
        <span className="renewal-eyebrow">
          {q ? `КРОК ${index + 1} ІЗ ${questions.length}` : 'ПЕРЕВІР ВІДПОВІДІ'}
        </span>
        <span className="text-xs text-tx2">
          {done} {pluralUk(done, ['відповідь', 'відповіді', 'відповідей'])}
        </span>
      </div>
      <div className="renewal-progress mt-0">
        <span
          style={{ width: `${Math.min(100, (index / Math.max(1, questions.length)) * 100)}%` }}
        />
      </div>
      {q ? (
        <div
          key={q.id}
          className="renewal-question"
          style={{ animation: 'fadeUp .24s ease' }}
          onTouchStart={(e) => {
            const p = e.touches[0];
            if (p) touch.current = { x: p.clientX, y: p.clientY };
          }}
          onTouchEnd={(e) => {
            const p = e.changedTouches[0],
              start = touch.current;
            touch.current = null;
            if (!p || !start || q.kind === 'pad' || Math.abs(p.clientY - start.y) > 40) return;
            if (p.clientX - start.x < -70) next();
            else if (p.clientX - start.x > 70) setStep(Math.max(0, index - 1));
          }}
        >
          <QuestionRow
            q={q}
            answers={answers}
            disabled={disabled}
            onAnswer={onAnswer}
            onPad={onPad}
          />
          <div className="renewal-form-grid mt-5">
            <button
              type="button"
              className="renewal-secondary"
              disabled={disabled || index === 0}
              onClick={() => {
                setStep(index - 1);
                onReview(false);
              }}
            >
              ← Назад
            </button>
            <button
              type="button"
              className="renewal-button"
              disabled={disabled || (!q.soft && !q.deep && !isAnswered(q, answers))}
              onClick={next}
            >
              {index === questions.length - 1
                ? 'Перевірити'
                : isAnswered(q, answers)
                  ? 'Далі →'
                  : 'Пропустити →'}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {questions.map((p, i) => (
            <button
              key={p.id}
              type="button"
              className="renewal-list-row w-full text-left"
              disabled={disabled}
              onClick={() => {
                setStep(i);
                onReview(false);
              }}
            >
              <span>{p.t}</span>
              <span className={isAnswered(p, answers) ? 'text-pos' : 'text-tx3'}>
                {isAnswered(p, answers) ? answerLabel(p, answers) : '—'}
              </span>
            </button>
          ))}
        </div>
      )}
      {!!deep.length && (
        <button
          type="button"
          className="renewal-link self-start"
          aria-pressed={includeDeep}
          onClick={() => {
            setIncludeDeep(!includeDeep);
            onReview(false);
            setStep(Math.min(index, core.length - 1));
          }}
        >
          {includeDeep
            ? '− Лише основні питання'
            : `+ Ще ${deep.length} ${pluralizePytannya(deep.length)}`}
        </button>
      )}
    </div>
  );
}

/**
 * Скільки блоку лишилось жити.
 *
 * ⚠️ ЯКІР — СЕРВЕРНИЙ, і це головне рішення тут. Межі блоків київські, а
 * клієнт живе в поясі, який стоїть на телефоні: власний відлік показував би
 * «ще три години» тому, у кого годинник переведено, — і показував би впевнено,
 * тим самим шрифтом. Тому сервер каже, СКІЛЬКИ ХВИЛИН лишилось (одне число), а
 * тут воно лише зменшується.
 *
 * По нулю компонент не вирішує нічого сам, а йде по свіжу відповідь: слот
 * визначає сервер, і саме він мусить сказати, що тепер відкрито.
 *
 * Власний стан у ОКРЕМОМУ компоненті навмисно: тік раз на пів хвилини у
 * CheckinScreen перемальовував би всі три блоки з усіма питаннями.
 */
function SlotTimer({ endsIn, onExpire }: { endsIn: number; onExpire: () => void }) {
  // ⚠️ Годинник живе В ЕФЕКТІ, а не в рендері. Рендер мусить бути чистим, а
  // Date.now() під час рендера дає різний результат на кожен перемальовок —
  // лінтер правий: це рівно той клас помилок, де число «стрибає», коли
  // компонент перемалювався з чужої причини.
  //
  // Скидання при зміні пропа зроблено КЛЮЧЕМ на місці виклику (key={endsIn}),
  // а не setState в ефекті: компонент просто монтується наново з новим
  // початковим значенням — без зайвого рендера й вікна, де на екрані ще старе
  // число, а проп уже новий.
  const [left, setLeft] = useState(endsIn);
  useEffect(() => {
    const at = Date.now();
    const id = setInterval(() => {
      setLeft(Math.max(0, endsIn - Math.floor((Date.now() - at) / 60_000)));
    }, 30_000);
    return () => clearInterval(id);
  }, [endsIn]);

  const expire = useRef(onExpire);
  useEffect(() => {
    expire.current = onExpire;
  }, [onExpire]);
  useEffect(() => {
    // Нуль — не привід вирішувати щось самому: слот визначає сервер, тож ідемо
    // по свіжу відповідь. Саме через ref, а не прямо в залежностях: батько
    // віддає інлайн-стрілку, тобто НОВУ функцію щорендеру — з нею в deps ефект
    // перезапускався б щоразу й на нулі смикав би сервер знову й знову.
    if (left === 0) expire.current();
  }, [left]);

  const h = Math.floor(left / 60);
  const m = left % 60;
  const text = h > 0 ? `${h}:${pad2(m)}` : `${m} хв`;
  // Остання година — інший колір. Не «терміново!», а рівно те, що є: часу
  // лишилось на один блок питань, і це варто помітити боковим зором.
  const soon = left <= 60;
  return (
    <span
      className={`rounded-full border px-1.5 py-px font-mono text-[9px] font-semibold ${
        soon ? 'border-neg/40 text-neg' : 'border-glassb text-tx3'
      }`}
      aria-label={`Блок закриється через ${h > 0 ? `${h} год ${m} хв` : `${m} хв`}`}
    >
      ⏳ {text}
    </span>
  );
}

export function CheckinScreen() {
  const { data, dataUpdatedAt, isLoading, isError, error, refetch } = useStats();
  const nowMs = useTick(1000);
  const save = useSaveCheckin();
  const [local, setLocal] = useState<Record<string, Answers>>({});
  const [previewSlot, setPreviewSlot] = useState<CheckinSlot>('morning');
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
  const demo = !inTelegram();
  const active = demo ? previewSlot : (s?.checkinSlot ?? null);
  const server = s?.checkinToday ?? {};
  const dateKey = s?.checkinDate ?? kyivParts(nowMs).date;
  const keyFor = (slot: CheckinSlot) =>
    `svitanok:checkin-draft:${demo ? 'demo' : 'private'}:${dateKey}:${slot}`;
  const slotIndex = BLOCKS.findIndex((b) => b.id === active),
    nextBlock = BLOCKS[slotIndex + 1] ?? BLOCKS[0];
  const nextAt = kyivInstant(
    slotIndex === BLOCKS.length - 1 ? shiftDate(dateKey, 1) : dateKey,
    nextBlock.from,
  );
  const nextSeconds = demo
    ? Math.max(0, Math.ceil((nextAt - nowMs) / 1000))
    : s?.checkinNextIn == null
      ? null
      : Math.max(0, Math.ceil(s.checkinNextIn * 60 - (nowMs - dataUpdatedAt) / 1000));

  const answersFor = (slot: CheckinSlot): Answers => ({
    ...((server[slot] ?? {}) as Answers),
    ...(server[slot]?.confirmed ? {} : (local[keyFor(slot)] ?? readDraft(keyFor(slot)))),
  });

  /** Дебаунс: шлемо ВЕСЬ блок одним запитом. Без цього чотири тапи = чотири
   *  записи в один KV-ключ, а там ліміт 1/сек і немає CAS.
   *
   *  ⚠️ Тут же гаситься те, що закрив showIf. Місце обрано навмисно — через
   *  queue проходять ОБИДВА способи відповісти (кнопка й пад), тож правило
   *  неможливо обійти, додавши третій. null — той самий явний сигнал «очисти»,
   *  що вже вміє сервер (cleanCheckin), а не видалений ключ: видалений ключ
   *  мердж на сервері прочитав би як «не чіпай». */
  const queue = (slot: CheckinSlot, answers: Answers) => {
    const b = BLOCKS.find((x) => x.id === slot);
    const gated = b ? clearGatedAnswers(b, answers) : {};
    const next: Answers = Object.keys(gated).length ? { ...answers, ...gated } : answers;
    writeDraft(keyFor(slot), next);
    setLocal((p) => ({ ...p, [keyFor(slot)]: next }));
    clearTimeout(timers.current[slot]);
    timers.current[slot] = setTimeout(() => {
      save.mutate({ slot, dateKey: demo ? undefined : dateKey, answers: next });
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
    const pending = answersFor(slot);
    save.mutate(
      { slot, dateKey: demo ? undefined : dateKey, answers: { ...pending, confirmed: true } },
      {
        onSuccess: () => {
          haptic('success');
          window.scrollTo(0, 0);
          writeDraft(keyFor(slot));
          setLocal((p) => {
            const next = { ...p };
            delete next[keyFor(slot)];
            return next;
          });
        },
      },
    );
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
      <PageHeading
        eyebrow="ТВІЙ СТАН — БЕЗ ПОСПІХУ"
        title="Коротка пауза"
        accent="для себе."
        description="Знайомі питання, по одному. Можна повертатися й уточнювати."
      />
      {demo && (
        <div className="renewal-inset">
          <p className="renewal-muted mb-2">
            Демо розкладу: обери слот для перегляду. У Telegram вони відкриватимуться за київським
            часом.
          </p>
          <div className="renewal-segments">
            {BLOCKS.map((b) => (
              <button
                key={b.id}
                type="button"
                aria-pressed={previewSlot === b.id}
                onClick={() => setPreviewSlot(b.id)}
              >
                {b.nm}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="renewal-link mt-3"
            onClick={() => {
              resetCheckinDemo();
              BLOCKS.forEach((b) => writeDraft(keyFor(b.id)));
              setLocal({});
              void refetch();
            }}
          >
            Скинути демо чек-іну
          </button>
        </div>
      )}
      {save.error && (
        <p role="alert" className="renewal-inset text-sm text-neg">
          {save.error.message}
        </p>
      )}
      {nextSeconds != null && (!active || server[active]?.confirmed) && (
        <section className="renewal-card text-center">
          <div className="text-3xl mb-3">✨</div>
          <span className="renewal-pill">
            {active ? 'Чек-ін підтверджено' : 'Пауза між чек-інами'}
          </span>
          <h2 className="text-xl font-semibold mt-4">Можна повернутися до дня</h2>
          <p className="renewal-muted mt-2">
            {active === 'morning'
              ? 'Наступний — післяобід о 14:00'
              : active === 'afternoon'
                ? 'Наступний — вечір о 20:00'
                : active === 'evening'
                  ? 'Наступний — завтра о 08:00'
                  : 'Наступне вікно за розкладом'}
          </p>
          <div className="renewal-focus-clock" role="timer">
            {String(Math.floor(nextSeconds / 3600)).padStart(2, '0')}:
            {String(Math.floor((nextSeconds % 3600) / 60)).padStart(2, '0')}:
            {String(nextSeconds % 60).padStart(2, '0')}
          </div>
          <p className="renewal-chart-note">До наступного чек-іну</p>
          {nextSeconds === 0 && (
            <button className="renewal-button mt-4" onClick={() => refetch()}>
              Оновити й відкрити
            </button>
          )}
        </section>
      )}
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
            state={stateOf(b, active, answersFor(b.id))}
            live={active === b.id}
            answers={answersFor(b.id)}
            workDay={workDay}
            onAnswer={(q, v, multi) => onAnswer(b.id, q, v, multi)}
            onPad={(xId, x, yId, y) => onPad(b.id, xId, x, yId, y)}
            onConfirm={() => onConfirm(b.id)}
            // Серверний таймер лише для фактично активного слоту.
            endsIn={
              demo && active === b.id
                ? Math.max(0, Math.ceil((nextAt - nowMs) / 60000))
                : s?.checkinSlot === b.id && active === b.id
                  ? (s?.checkinSlotEndsIn ?? null)
                  : null
            }
            onExpire={() => void refetch()}
          />
        </div>
      ))}

      <section className="renewal-card">
        <div className="renewal-section-head">
          <h2 className="text-lg font-semibold">Ритм тижня</h2>
          <span className="renewal-chart-note">Дні з відповідями</span>
        </div>
        <div className="renewal-week-grid">
          {Array.from({ length: 7 }, (_, i) => {
            const d = shiftDate(dateKey, i - 6),
              point = s?.checkinSeries.find((p) => p.d === d),
              observed = d === dateKey ? filled > 0 || !!point?.slots : !!point?.slots;
            return (
              <div key={d}>
                <small>
                  {new Date(d + 'T12:00:00Z').toLocaleDateString('uk-UA', { weekday: 'short' })}
                </small>
                <span data-filled={observed}>{observed ? '✓' : '·'}</span>
                <small>{d.slice(8)}</small>
              </div>
            );
          })}
        </div>
        <p className="renewal-chart-note mt-3">
          Пропуск — місце без даних. Наступний чек-ін завжди можна почати заново.
        </p>
      </section>
      {!active && (
        <p className="text-[12.5px] leading-[1.5] text-tx2">
          Блоки живуть за часом: ранок з 08:00, післяобід з 14:00, вечір з 20:00. Пропущений блок
          лишається порожнім — відповідь заднім числом була б здогадкою, а не даними.
        </p>
      )}
    </div>
  );
}
