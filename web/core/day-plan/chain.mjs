// DayPlanChain (07 §6, ADR-035, S-P-9…15): Workflow, що живе від вечірнього
// «Що завтра?» до вечірнього огляду наступного дня. Машина станів -
// runDayPlanChain(env, params, step, io): усі кроки через `step.do`, очікування
// через `step.waitForEvent`, а вихід у світ - через `io` (повідомлення, старт
// працівника, календар, енергія). Клас DayPlanChain - тонка обгортка з
// бойовим io; тести ганяють машину з фейковими step/io (03-plan: «unit -
// машина станів кожного Workflow (мок waitForEvent)»).
//
// Денний працівник (day-planner.md) - прогін профілю `day-planner` у мозку:
// вхід JSON {chain_id, mode, date, task}, вихід - подія `worker` у цей
// ланцюг через /internal/runs outcome.chain (без deliver). Працівник
// недоступний або впав - резерв: наївний розбір наміру і formatDraft, ланцюг
// не вмирає (00-README п.6: помилка видима, але без тиші).

import { WorkflowEntrypoint } from 'cloudflare:workers';
import { kyivDateKey, kyivMinuteOfDay } from '../../kyiv-time.mjs';
import { addDaysToDateKey } from '../../reminders-core.mjs';
import { readCalendarRange } from '../../google.mjs';
import { loadStats } from '../../kv-store.mjs';
import { enqueueOutbox, drainOutbox } from '../tg/outbox.mjs';
import { assistantHomeTarget } from '../tg/home.mjs';
import { renderMdParts } from '../tg/markdown.mjs';
import { buildCallbackActionCardRows } from '../tg/action-card.mjs';
import {
  setChainState,
  patchChainState,
  waitOrNull,
  readChainState,
  chainTarget,
} from '../chains/state.mjs';
import { startChainWorkerRun } from '../brain/chain-worker.mjs';
import { calendarizeBlocks } from '../tools/plan.mjs';
import { runRoutesEta } from '../tools/places.mjs';
import {
  requireClockRangeQuestions,
  applyNamedWorkClocks,
  exactAnswerClock,
  plannedRoute,
  requestsRouteCheck,
} from './clarifications.mjs';
import { computeSlots, formatDraft, energyBySlot, hhmmToMin, minToHhmm } from './slots.mjs';
import {
  readDayPlanConfig,
  getDayPlan,
  upsertDayPlan,
  replaceItems,
  normalizeItem,
  normalizePlanItems,
  acceptPlan,
  updateItems,
  reviewPlan,
  carryItems,
  carriedInto,
  markReviewed,
  listItems,
  kyivMs,
  nextPlannedDay,
  ITEMS_MAX,
} from './store.mjs';

export const CHAIN_KIND = 'day-plan';
/** Таймаути очікувань (07 §6). */
export const WAIT_INTENT_MS = 3 * 3_600_000;
export const WAIT_ANSWER_MS = 3_600_000;
export const WAIT_WORKER_MS = 10 * 60_000;
export const WAIT_CARRY_MS = 2 * 3_600_000;
/** Захисна стеля змін одного редагування; кілька вечірніх справ допустимі. */
export const REPLAN_MAX_CHANGES = 20;
export const DAY_PLANNER_MODEL = 'claude-sonnet-5';

/** An unanswered old workflow must not overwrite another draft/approval.
 * @param {Env} env @param {string} date @param {string} chainId
 */
async function closeUnansweredPlan(env, date, chainId) {
  if (!env.DB) throw new Error('привʼязки DB немає');
  await env.DB.prepare(
    `UPDATE day_plans SET status='skipped'
    WHERE date=? AND workflow_id=? AND status='intent'
      AND (intent_text IS NULL OR TRIM(intent_text)='')
      AND NOT EXISTS (SELECT 1 FROM plan_items WHERE date=?)`,
  )
    .bind(date, chainId, date)
    .run();
}

/**
 * @typedef {{
 *   now: () => number,
 *   target?: { chatId: number | string | null, threadId: number | string | null },
 *   send: (text: string, buttons?: { text: string, callback_data: string }[][]) => Promise<void>,
 *   startWorker: (mode: 'intent' | 'explain' | 'replan', task: Record<string, unknown>) => Promise<boolean>,
 *   readCalendar: (date: string) => Promise<{ title: string, startMin: number | null, endMin: number | null, transparent?: boolean }[] | null>,
 *   readEnergy: () => Promise<{ morning: number, afternoon: number, evening: number } | null>,
 *   readRoute?: (args: {from: string, to: string, mode: string, depart_at?: string}) => Promise<{duration_min: number, distance_km: number, traffic?: boolean} | null>,
 * }} ChainIo
 * @typedef {{
 *   do: <T>(name: string, fn: () => Promise<T>) => Promise<T>,
 *   sleepUntil: (name: string, ms: number) => Promise<void>,
 *   waitForEvent: (name: string, opts: { type: string, timeout: string }) => Promise<{ payload: any }>,
 * }} ChainStep
 */

/** Кнопки ланцюга (07 §9 `c:<id>:<choice>`). @param {string} chainId @param {[string, string][]} pairs */
function buttons(chainId, pairs) {
  return buildCallbackActionCardRows({
    choicePairs: pairs.map(([text, choice]) => ({ text, callback_data: `c:${chainId}:${choice}` })),
  });
}

/** @param {Env} env @param {string} chainId @param {number} questionIndex */
function questionState(env, chainId, questionIndex) {
  return patchChainState(env, chainId, 'waiting', {
    awaiting: 'answer',
    awaiting_since: new Date().toISOString(),
    question_index: questionIndex,
  });
}

/** Ignore delayed duplicate taps already queued before the next question.
 * @param {ChainStep} step @param {ChainIo} io @param {string} name @param {number} questionIndex
 */
async function questionAnswer(step, io, name, questionIndex) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const answer = await waitOrNull(
      step,
      attempt ? `${name}-stale-${attempt}` : name,
      'answer',
      WAIT_ANSWER_MS,
    );
    if (!answer || !Number.isInteger(answer.item) || answer.item === questionIndex) return answer;
    await step.do(`${name}-reject-${attempt}`, () =>
      io.send('Це попереднє уточнення. Відповідай під останнім запитанням.'),
    );
  }
  return null;
}

/**
 * Машина станів ланцюга. Повертає підсумок для журналу.
 * @param {Env} env
 * @param {{ chainId: string, date: string, oneShot?: boolean, initialIntent?: string, resumeDraft?: boolean }} params
 * @param {ChainStep} step
 * @param {ChainIo} io
 */
export async function runDayPlanChain(env, params, step, io) {
  const { chainId, date } = params;
  const config = await step.do('config', () => readDayPlanConfig(env, io.now()));
  const eve = addDaysToDateKey(date, -1);
  const savedDraft = params.resumeDraft
    ? await step.do('load-draft', async () =>
        (await getDayPlan(env, date))?.status === 'draft' ? await listItems(env, date) : null,
      )
    : null;

  // 1. Scheduled workflow asks the evening before. A direct /plan or an
  // explicit free-text day-plan request starts the same workflow immediately.
  /** @type {{ text?: string, choice?: string } | null} */
  let intent = savedDraft?.length
    ? { choice: 'resume' }
    : typeof params.initialIntent === 'string' && params.initialIntent.trim()
      ? { text: params.initialIntent.trim() }
      : null;
  if (!intent) {
    if (!params.oneShot)
      await step.sleepUntil('intent-at', kyivMs(eve, config.settings.intent_at) ?? io.now());
    await step.do('ask-intent', async () => {
      await setChainState(env, chainId, { status: 'waiting', awaiting: 'intent' });
      const question = params.oneShot
        ? `Що запланувати на ${date === kyivDateKey(new Date(io.now())) ? 'сьогодні' : 'завтра'}, ${ddmm(date)}? Напиши справи, порядок і відомі часи.`
        : `Що завтра (${ddmm(date)})? Назви всі справи, роботу й відомі часи текстом або голосом. «Нічого особливого» — теж відповідь.`;
      await io.send(
        question,
        buttons(chainId, [
          ['Нічого особливого', 'none'],
          ['Не зараз', 'skip'],
        ]),
      );
    });
    intent = await waitOrNull(step, 'wait-intent', 'intent', WAIT_INTENT_MS);
  }
  if (intent?.choice === 'skip') {
    await step.do('skip', async () => {
      await closeUnansweredPlan(env, date, chainId);
      await setChainState(env, chainId, { status: 'done', awaiting: null });
    });
    return { outcome: 'skipped' };
  }
  // Мовчання не є «порожнім планом». Раніше таймаут о 23:30 проходив далі,
  // створював нуль пунктів і все одно надсилав власнику план, якого він не
  // просив. Закриваємо саме цей запуск; наступного вечора питання з'явиться
  // знову, а перенесені пункти не губляться в базі.
  if (intent == null) {
    await step.do('no-intent', async () => {
      await closeUnansweredPlan(env, date, chainId);
      await setChainState(env, chainId, { status: 'done', awaiting: null });
    });
    return { outcome: 'no-input' };
  }
  const intentText = typeof intent?.text === 'string' ? intent.text.trim() : '';

  // 2. Намір → пункти (Денний, mode=intent) з уточненнями (S-P-10).
  /** @type {ReturnType<typeof normalizeItem>[]} */
  let items = savedDraft?.map((r, i) => normalizeItem(r, i)) ?? [];
  if (intentText) {
    await step.do('save-intent', () =>
      upsertDayPlan(
        env,
        date,
        { status: 'intent', intent_text: intentText, workflow_id: chainId },
        io.now(),
      ),
    );
    const started = await step.do('worker-intent', () =>
      io.startWorker('intent', {
        text: intentText,
        date,
        ...(config.habits.work_start_at
          ? {
              work_start_at: config.habits.work_start_at,
              work_start_samples: config.habits.work_start_samples,
            }
          : {}),
      }),
    );
    const parsed = started
      ? await waitOrNull(step, 'wait-intent-parsed', 'worker', WAIT_WORKER_MS)
      : null;
    items = await step.do('items', async () => normalizeIntent(parsed?.output, intentText));
    /** @type {any[]} */
    const questions = Array.isArray(parsed?.output?.questions)
      ? parsed.output.questions
          .filter((/** @type {any} */ q) => q && typeof q === 'object')
          .sort(
            (/** @type {any} */ a, /** @type {any} */ b) =>
              Number(b.field === 'choice') - Number(a.field === 'choice'),
          )
          .slice(0, 4)
      : [];
    const excludedIds = new Set();
    requireClockRangeQuestions(items, intentText, questions, config.habits.work_start_at);
    for (let index = 0; index < items.length && questions.length < 4; index += 1) {
      const item = items[index];
      if (!item) continue;
      if (
        !item.hard_at &&
        (item.kind === 'moment' ||
          (item.role === 'work' && item.hard_end && !config.habits.work_start_at)) &&
        !questions.some((q) => q.item === index && q.field === 'hard_at')
      ) {
        questions.push({
          item: index,
          field: 'hard_at',
          q: `О котрій починається «${item.title}»?`,
          options: ['08:00', '09:00', 'не знаю'],
        });
      }
    }
    // Працівник має питати тривалість для глибоких блоків і виїздів. Це
    // критичне правило дублюємо в ядрі: якщо модель пропустила уточнення,
    // не дозволяємо типовій оцінці непомітно перетворитися на готовий розклад.
    const durationAsked = new Set(
      questions
        .filter((q) => (q?.field == null || q.field === 'duration') && Number.isInteger(q?.item))
        .map((q) => q.item),
    );
    for (let itemIndex = 0; itemIndex < items.length && questions.length < 4; itemIndex += 1) {
      const item = items[itemIndex];
      if (!item) continue;
      if (
        item.est_min != null ||
        item.flexible ||
        !['deep', 'errand', 'move'].includes(item.kind) ||
        durationAsked.has(itemIndex)
      )
        continue;
      questions.push({
        item: itemIndex,
        field: 'duration',
        q: `Скільки часу закласти на «${item.title}»?`,
        options: ['30 хв', '1 год', '2 год', 'не знаю'],
      });
      durationAsked.add(itemIndex);
    }
    if (questions.length) {
      const namedAnswers = new Set();
      let routeRequested = requestsRouteCheck(intentText);
      for (let qi = 0; qi < questions.length; qi += 1) {
        const q = questions[qi];
        if (namedAnswers.has(`${q.item}:${q.field}`)) continue;
        if (Number.isInteger(q?.item) && excludedIds.has(items[q.item]?.id)) continue;
        const routeAlreadyRequested =
          routeRequested &&
          (q.field == null || q.field === 'duration') &&
          items[q.item]?.kind === 'move' &&
          items.filter((item) => item.kind === 'move').length === 1 &&
          plannedRoute(intentText) &&
          io.readRoute;
        if (!routeAlreadyRequested)
          await step.do(`ask-question-${qi}`, async () => {
            await questionState(env, chainId, qi);
            /** @type {unknown[]} */
            const options =
              q.field === 'choice' && Array.isArray(q.choices)
                ? q.choices.slice(0, 4).map((/** @type {any} */ c) => c.label)
                : Array.isArray(q.options)
                  ? q.options.slice(0, 4)
                  : ['не знаю'];
            await io.send(
              String(q.q ?? 'Уточни, будь ласка'),
              buttons(
                chainId,
                options.map(
                  (o, oi) => /** @type {[string, string]} */ ([String(o), `a${qi}_${oi}`]),
                ),
              ),
            );
          });
        const answer = routeAlreadyRequested
          ? { text: 'Перевір маршрут сам' }
          : await questionAnswer(step, io, `wait-answer-${qi}`, qi);
        if (q.field === 'choice' && Array.isArray(q.choices)) {
          const alternatives = new Set(
            q.choices.flatMap((/** @type {any} */ c) =>
              Array.isArray(c.items) ? c.items.filter(Number.isInteger) : [],
            ),
          );
          const picked =
            typeof answer?.option === 'number'
              ? q.choices[answer.option]
              : q.choices.find(
                  (/** @type {any} */ c) =>
                    String(c.label).toLowerCase() ===
                    String(answer?.text ?? '')
                      .trim()
                      .toLowerCase(),
                );
          if (picked && Array.isArray(picked.items)) {
            const kept = new Set(picked.items.filter(Number.isInteger));
            for (const index of alternatives)
              if (!kept.has(index) && items[index]) excludedIds.add(items[index].id);
          } else {
            for (const index of alternatives) if (items[index]) items[index].flexible = true;
          }
          continue;
        }
        if (typeof answer?.text === 'string') {
          routeRequested ||= requestsRouteCheck(answer.text);
          const clocksAnswered = applyNamedWorkClocks(items, answer.text);
          for (const key of clocksAnswered) namedAnswers.add(key);
          const item = items[q.item];
          if (
            (q.field == null || q.field === 'duration') &&
            item?.kind === 'move' &&
            items.filter((candidate) => candidate.kind === 'move').length === 1 &&
            routeRequested
          ) {
            const route = plannedRoute(intentText);
            if (route && io.readRoute) {
              let mode = route.mode;
              if (!mode) {
                await step.do(`ask-route-mode-${qi}`, async () => {
                  await questionState(env, chainId, 100 + qi);
                  await io.send(
                    'Чим їдеш? Перевірю час дороги для цього транспорту.',
                    buttons(chainId, [
                      ['Авто', `a${100 + qi}_0`],
                      ['Громадський транспорт', `a${100 + qi}_1`],
                      ['Пішки', `a${100 + qi}_2`],
                    ]),
                  );
                });
                const transport = await questionAnswer(step, io, `wait-route-mode-${qi}`, 100 + qi);
                mode =
                  typeof transport?.option === 'number'
                    ? (['car', 'transit', 'walk'][transport.option] ?? null)
                    : (plannedRoute(`${intentText}, ${String(transport?.text ?? '')}`)?.mode ??
                      null);
              }
              const depart = item.hard_at ? kyivMs(date, item.hard_at) : null;
              const routeReader = io.readRoute;
              const estimate = mode
                ? await step.do(`route-estimate-${qi}`, () =>
                    routeReader({
                      from: route.from,
                      to: route.to,
                      mode,
                      ...(depart == null ? {} : { depart_at: new Date(depart).toISOString() }),
                    }).catch(() => null),
                  )
                : null;
              if (estimate && Number.isFinite(estimate.duration_min) && estimate.duration_min > 0) {
                item.est_min = Math.ceil(estimate.duration_min);
                item.floating = true;
                item.flexible = questions.some(
                  (question) =>
                    question.item === q.item &&
                    ['hard_at', 'hard_end', 'not_before', 'not_after'].includes(question.field) &&
                    hhmmToMin(
                      item[
                        /** @type {'hard_at' | 'hard_end' | 'not_before' | 'not_after'} */ (
                          question.field
                        )
                      ],
                    ) == null,
                );
                await step.do(`route-result-${qi}`, () =>
                  io.send(
                    `Час дороги за маршрутом — приблизно ${item.est_min} хв. Це оцінка, без твоїх зупинок; фактичний час може змінитися.`,
                  ),
                );
              } else {
                item.flexible = true;
                const fallbackOptions = ['30 хв', '1 год', '4 год', 'не знаю'];
                await step.do(`ask-route-fallback-${qi}`, async () => {
                  await questionState(env, chainId, 200 + qi);
                  await io.send(
                    'Час дороги не вдалося перевірити. Скільки часу закласти за твоєю оцінкою?',
                    buttons(
                      chainId,
                      fallbackOptions.map((label, option) => [label, `a${200 + qi}_${option}`]),
                    ),
                  );
                });
                const fallback = await questionAnswer(
                  step,
                  io,
                  `wait-route-fallback-${qi}`,
                  200 + qi,
                );
                items = applyAnswer(
                  items,
                  questions,
                  fallback
                    ? {
                        text:
                          typeof fallback.option === 'number'
                            ? fallbackOptions[fallback.option]
                            : fallback.text,
                      }
                    : null,
                  qi,
                );
              }
              routeRequested = false;
              continue;
            }
          }
          // A named work answer cannot become an unrelated wake-up or duration answer.
          if (clocksAnswered.size && !clocksAnswered.has(`${q.item}:${q.field}`)) continue;
        }
        if (!namedAnswers.has(`${q.item}:${q.field}`))
          items = applyAnswer(items, questions, answer, qi);
      }
      if (excludedIds.size) items = items.filter((item) => !excludedIds.has(item.id));
    }
  }
  // Перенесені з учора - у план завжди (S-P-15).
  const carried = await step.do('carried', () => carriedInto(env, date));
  for (const c of carried) {
    if (!items.some((i) => i.title === c.title)) {
      items.push(
        normalizeItem(
          {
            id: c.id,
            title: c.title,
            kind: c.kind,
            est_min: c.est_min,
            deadline: c.deadline,
            place: c.place,
            carried_from: c.carried_from,
            priority: c.priority,
            optional: c.optional,
            floating: c.floating,
            notify: c.notify,
            role: c.role,
          },
          items.length,
        ),
      );
    }
  }

  // 3. Розкладка ядром (S-P-11) і чернетка (S-P-12).
  let draft = await step.do('slots', async () => {
    const events = await io.readCalendar(date);
    const energy = await io.readEnergy();
    const slots = computeSlots({
      date,
      items,
      events: events ?? [],
      settings: config.settings,
      habits: config.habits,
      energy,
      nowMin: date === kyivDateKey(new Date(io.now())) ? kyivMinuteOfDay(new Date(io.now())) : null,
    });
    await replaceItems(env, date, slots, items);
    await upsertDayPlan(
      env,
      date,
      { status: 'draft', fill_ratio: config.settings.fill_ratio },
      io.now(),
    );
    return { slots, events: events ?? [], calendarUnavailable: events == null };
  });
  let approved = false;
  for (let revision = 0; revision < 6; revision += 1) {
    const unresolved = draft.slots.flexible.filter((i) => !i.optional);
    const canApprove = !draft.calendarUnavailable && unresolved.length === 0;
    await step.do(`send-draft-${revision}`, async () => {
      await setChainState(env, chainId, { status: 'waiting', awaiting: 'accept' });
      await io.send(
        `${draft.calendarUnavailable ? '⚠️ Календар недоступний; план поки не можна затвердити.\n' : ''}${formatDraft(date, draft.slots, draft.events)}`,
        buttons(
          chainId,
          /** @type {[string, string][]} */ ([
            ...(canApprove ? [['✅ Затвердити й записати', 'accept']] : []),
            ['✏️ Змінити', 'edit'],
            ['🕓 Пізніше', 'later'],
          ]),
        ),
      );
    });
    const decision = await waitOrNull(
      step,
      `wait-accept-${revision}`,
      'accept',
      params.oneShot
        ? 12 * 60 * 60_000
        : Math.max(60_000, (kyivMs(date, config.settings.morning_at) ?? io.now()) - io.now()),
    );
    if (!decision || decision.choice === 'later') {
      if (decision?.choice === 'later')
        await io.send('Чернетку збережено. Повернися до неї через «План дня».');
      break;
    }
    if (decision.choice === 'edit') {
      await step.do(`ask-edit-${revision}`, async () => {
        await questionState(env, chainId, -1);
        await io.send(
          'Що змінити? Можеш пересунути, додати або прибрати кілька справ одним повідомленням.',
        );
      });
      const change = await waitOrNull(step, `wait-edit-${revision}`, 'answer', WAIT_ANSWER_MS);
      if (typeof change?.text !== 'string' || !change.text.trim()) break;
      const started = await step.do(`worker-replan-${revision}`, () =>
        io.startWorker('replan', { text: change.text, date, items }),
      );
      const replan = started
        ? await waitOrNull(step, `wait-replan-${revision}`, 'worker', WAIT_WORKER_MS)
        : null;
      const out = replan?.output && typeof replan.output === 'object' ? replan.output : null;
      if (!out) {
        await io.send('Зміни не розібрав. Чернетка збережена; спробуй ще раз через «План дня».');
        break;
      }
      const changes = replanChanges(out);
      await step.do(`replan-${revision}`, async () => {
        if (changes.done.length || changes.moves.length || changes.drop.length)
          await updateItems(env, date, changes, io.now());
        const rows = (await listItems(env, date)).filter((r) => r.status === 'planned');
        items = [
          ...rows.map((r, i) => normalizeItem(r, i)),
          ...changes.add.map((r, i) => normalizeItem(r, rows.length + i)),
        ];
        if (items.length > ITEMS_MAX) throw new Error(`понад ${ITEMS_MAX} справ у плані`);
        const events = await io.readCalendar(date);
        const slots = computeSlots({
          date,
          items,
          events: events ?? [],
          settings: config.settings,
          habits: config.habits,
          energy: await io.readEnergy(),
          nowMin:
            date === kyivDateKey(new Date(io.now())) ? kyivMinuteOfDay(new Date(io.now())) : null,
        });
        await replaceItems(env, date, slots, items);
        draft = { slots, events: events ?? [], calendarUnavailable: events == null };
      });
      continue;
    }
    if ((decision.choice === 'accept' || decision.choice === 'calendar') && canApprove) {
      await step.do('accept', async () => {
        const res = await acceptPlan(env, date, io.now(), io.target ?? address(env));
        await proposeCalendar(env, date, res.items, io.now(), io);
      });
      approved = true;
      break;
    }
  }
  if (!approved) {
    await step.do('leave-draft', async () => {
      await setChainState(env, chainId, { status: 'done', awaiting: null });
    });
    return { outcome: 'draft-left-for-later', items: items.length };
  }

  // One-off interactive plans end after the owner decides; they must not
  // continue into the scheduled morning and evening check-ins.
  if (params.oneShot) {
    await step.do('finish-one-shot', async () => {
      await setChainState(env, chainId, { status: 'done', awaiting: null });
    });
    return { outcome: 'accepted', items: items.length };
  }

  // 4. Ранковий план (S-P-13).
  const firstStart = Math.min(
    ...items.map((i) => hhmmToMin(i.hard_at)).filter((t) => t != null),
    hhmmToMin(config.settings.morning_at) ?? 8 * 60 + 30,
  );
  const morningAt = minToHhmm(Math.max(0, firstStart - 15));
  await step.sleepUntil('morning-at', kyivMs(date, morningAt) ?? io.now());
  await step.do('morning', async () => {
    await setChainState(env, chainId, { status: 'running', awaiting: null });
    const [events, rows] = await Promise.all([io.readCalendar(date), listItems(env, date)]);
    await io.send(
      `${events == null ? '⚠️ Календар недоступний.\n' : ''}${morningText(date, rows, events ?? [])}`,
    );
  });

  // 5. Вечірній огляд (S-P-15).
  await step.sleepUntil('review-at', kyivMs(date, config.settings.review_at) ?? io.now());
  const review = await step.do('review', async () => {
    const r = await reviewPlan(env, date);
    await setChainState(env, chainId, { status: 'waiting', awaiting: 'carry' });
    if (r.open.length === 0) {
      await io.send(`З плану ${r.done}/${r.planned} ✅ - усе закрито.`);
      return { ...r, asked: false };
    }
    await io.send(
      `З плану ${r.done}/${r.planned} ✅ · перенести «${r.open.map((o) => o.title).join('», «')}» на завтра?`,
      buttons(chainId, [
        ['Так', 'carry_all'],
        ['Ні', 'carry_none'],
      ]),
    );
    return { ...r, asked: true };
  });
  const carry = review.asked ? await waitOrNull(step, 'wait-carry', 'carry', WAIT_CARRY_MS) : null;
  await step.do('carry', async () => {
    const to = nextPlannedDay(date, config.weekdays);
    if (carry?.choice === 'carry_all') {
      const res = await carryItems(env, date, to, [], io.now());
      if (res.stale.length) {
        await io.send(
          `«${res.stale.map((s) => s.title).join('», «')}» переїжджає вже ${res.stale[0]?.days} день - забути чи в ідеї?`,
        );
      }
    } else {
      await markReviewed(env, date, io.now());
    }
    await setChainState(env, chainId, { status: 'done', awaiting: null });
  });
  return { outcome: 'done', items: items.length };
}

// ── Кроки-помічники ────────────────────────────────────────────────────────

/**
 * Пункти з JSON працівника; без нього - наївний розбір (кома/крапка з комою/
 * рядки), усі routine без оцінок, щоб ланцюг не вмер без мозку.
 * @param {any} output @param {string} intentText
 */
export function normalizeIntent(output, intentText) {
  /** @type {Record<string, unknown>[]} */
  const raw = Array.isArray(output?.items)
    ? [
        ...output.items,
        ...(Array.isArray(output?.deferred)
          ? output.deferred
              .filter((/** @type {any} */ r) => r && typeof r.title === 'string' && r.title.trim())
              .map((/** @type {any} */ r) => ({ ...r, flexible: true }))
          : []),
      ]
    : intentText
        .split(/[\n;,]|\s+і\s+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((title) => ({ title, kind: 'routine', flexible: true }));
  // id від працівника не приймаємо: replaceItems робить INSERT OR REPLACE за
  // id, і чужий id «перетягнув» би рядок іншої дати разом із reminder_id.
  if (raw.length > ITEMS_MAX)
    throw new Error(`у плані понад ${ITEMS_MAX} справ; не обрізаю їх мовчки`);
  return normalizePlanItems(raw);
}

/**
 * Зміни від працівника (mode=replan): done, moves, drop і нові справи.
 * @param {Record<string, unknown>} out
 */
export function replanChanges(out) {
  const strings = (/** @type {unknown} */ v) =>
    Array.isArray(v) ? v.filter((x) => typeof x === 'string').map(String) : [];
  const moves = Array.isArray(out.moves)
    ? out.moves
        .filter(
          (m) => m && typeof m === 'object' && typeof m.id === 'string' && typeof m.to === 'string',
        )
        .map((m) => ({ id: String(m.id), to: String(m.to) }))
    : [];
  const add = Array.isArray(out.add)
    ? out.add.filter((r) => r && typeof r === 'object' && typeof r.title === 'string')
    : [];
  const done = strings(out.done).slice(0, REPLAN_MAX_CHANGES);
  const selectedMoves = moves.slice(0, REPLAN_MAX_CHANGES - done.length);
  const drop = strings(out.drop).slice(0, REPLAN_MAX_CHANGES - done.length - selectedMoves.length);
  const selectedAdd = add.slice(
    0,
    REPLAN_MAX_CHANGES - done.length - selectedMoves.length - drop.length,
  );
  return {
    done,
    moves: selectedMoves,
    drop,
    add: selectedAdd.map((item) => ({
      ...item,
      id: undefined,
      after_item_id: undefined,
      overlap_with_item_id: undefined,
    })),
  };
}

/**
 * Apply an answer to the field named by the question. A time answer must not
 * be mistaken for a duration or discarded as an unknown answer.
 * Кнопка несе {item, option}; текст із prerouter - лише {text}, тоді пункт -
 * той, чиє питання зараз чекає відповіді (qiDefault).
 * @param {ReturnType<typeof normalizeItem>[]} items
 * @param {any[]} questions
 * @param {{ item?: number, option?: number, text?: string } | null} answer
 * @param {number} [qiDefault]
 */
export function applyAnswer(items, questions, answer, qiDefault = 0) {
  const qi = Number.isInteger(answer?.item) ? Number(answer?.item) : qiDefault;
  const q = questions[qi];
  const target = items[Number(q?.item ?? qi)];
  if (!target) return items;
  const field = String(q?.field ?? 'duration');
  if (!answer) {
    target.flexible = true;
    if (
      field === 'hard_end' ||
      field === 'hard_at' ||
      field === 'not_before' ||
      field === 'not_after'
    )
      target[field] = null;
    return items;
  }
  const option =
    typeof answer.option === 'number'
      ? String(q?.options?.[answer.option] ?? '')
      : String(answer.text ?? '');
  if (
    field === 'hard_end' ||
    field === 'hard_at' ||
    field === 'not_before' ||
    field === 'not_after'
  ) {
    const time = exactAnswerClock(option);
    if (hhmmToMin(time) != null) {
      target[field] = time;
      if (
        questions
          .filter(
            (question) =>
              question.item === Number(q.item ?? qi) &&
              ['hard_at', 'hard_end', 'not_before', 'not_after'].includes(question.field),
          )
          .every(
            (question) =>
              hhmmToMin(
                target[
                  /** @type {'hard_at' | 'hard_end' | 'not_before' | 'not_after'} */ (
                    question.field
                  )
                ],
              ) != null,
          ) &&
        (!['deep', 'move', 'errand'].includes(target.kind) || target.est_min != null)
      )
        target.flexible = false;
    } else {
      target[field] = null;
      target.flexible = true;
    }
    return items;
  }
  const min = parseDurationMin(option);
  if (min != null) {
    target.est_min = min;
    target.flexible = questions.some(
      (question) =>
        question.item === Number(q.item ?? qi) &&
        ['hard_at', 'hard_end', 'not_before', 'not_after'].includes(question.field) &&
        hhmmToMin(
          target[
            /** @type {'hard_at' | 'hard_end' | 'not_before' | 'not_after'} */ (question.field)
          ],
        ) == null,
    );
  } else target.flexible = true;
  return items;
}

/** «1 год», «2 год», «30 хв», «1.5 год» → хвилини; «не знаю» → null. @param {string} s */
export function parseDurationMin(s) {
  const t = s.toLowerCase().replace(',', '.');
  const h = /(\d+(?:\.\d+)?)\s*год/.exec(t);
  const m = /(\d+)\s*хв/.exec(t);
  if (!h && !m) return null;
  return Math.round((h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0)) || null;
}

/** Ранкове повідомлення з прийнятих блоків + подій. @param {string} date @param {any[]} rows @param {any[]} events */
export function morningText(date, rows, events) {
  const lines = [`Ранок ${ddmm(date)}`];
  const timed = rows.filter((r) => r.window_start && r.status === 'planned');
  for (const r of timed) lines.push(`• ${r.window_start}-${r.window_end} ${r.title}`);
  for (const e of events) {
    if (
      e.startMin != null &&
      !timed.some(
        (r) =>
          (r.title === e.title || (r.floating && e.title.startsWith(`${r.title} · ≈`))) &&
          hhmmToMin(r.window_start) === e.startMin,
      )
    )
      lines.push(`• ${minToHhmm(e.startMin)} ${e.title} (календар)`);
  }
  const flex = rows.filter((r) => !r.window_start && r.status === 'planned');
  if (flex.length) lines.push(`Гнучке: ${flex.map((f) => f.title).join(', ')}`);
  return lines.join('\n');
}

/**
 * Після схвалення всі блоки з часом їдуть у календар. Підсумок - один;
 * окремі картки лишаються тільки для дій, що ще потребують підтвердження.
 * @param {Env} env @param {string} date @param {{ id?: string, event_id?: string | null, title: string, window_start: string | null, window_end: string | null }[]} rows @param {number} nowMs
 * @param {ChainIo} io
 */
async function proposeCalendar(env, date, rows, nowMs, io) {
  const existing = rows.filter((r) => r.event_id).length;
  const out = await calendarizeBlocks(
    env,
    date,
    rows,
    nowMs,
    io.target ?? address(env),
    (text, actionButtons) => {
      const pending = /** @type {{ text: string, callback_data: string }[][]} */ (
        actionButtons ?? []
      );
      return pending.flat().some((b) => b.callback_data.startsWith('p:'))
        ? io.send(text, pending)
        : Promise.resolve();
    },
  );
  await io.send(
    `🗓 План погоджено. У календарі: ${out.added + existing} блоків.${out.proposed ? ` Ще ${out.proposed} чекають підтвердження.` : ''}${out.failed.length ? ` Не записано: ${out.failed.join(', ')}.` : ''}`,
  );
}

/** @param {Env} env */
function address(env) {
  const home = assistantHomeTarget(env);
  return {
    chatId: home?.chatId ?? null,
    threadId: home?.threadId ?? null,
  };
}

/** @param {string} date */
function ddmm(date) {
  const [, m, d] = date.split('-');
  return `${d}.${m}`;
}

// ── Стан ланцюга в D1 (`chains`) ───────────────────────────────────────────

// setChainState живе в chains/state.mjs (спільний з IdeaAnalysis); реекспорт
// заради тестів. Пошук ланцюга, що чекає тексту, і доставка подій - у
// chains/registry.mjs (етап 5: kind рядка вибирає привʼязку).
export { setChainState };

/**
 * Створити ланцюг на дату: рядок у chains + інстанс Workflow (id = chainId,
 * щоб кнопки й події адресували його без другого ключа).
 * @param {Env} env @param {string} date @param {number} nowMs
 * @param {{ oneShot?: boolean, initialIntent?: string, resumeDraft?: boolean,
 *   target?: { chatId: number | string | null, threadId: number | string | null } }} [options]
 */
export async function startDayPlanChain(env, date, nowMs, options = {}) {
  if (!env.DB) throw new Error('привʼязки DB немає');
  if (!env.DAY_PLAN) throw new Error('привʼязки DAY_PLAN (Workflow) немає');
  const prior = await getDayPlan(env, date);
  if (prior?.status === 'accepted')
    throw new Error('План на цей день уже погоджено й записано в календар. Не створюю дубль.');
  if (prior?.workflow_id) {
    const active = await env.DB.prepare(
      "SELECT id FROM chains WHERE id = ? AND status IN ('running', 'waiting')",
    )
      .bind(prior.workflow_id)
      .first();
    if (active)
      throw new Error('План на цей день уже відкритий. Заверши або відклади поточну чернетку.');
  }
  const chainId = crypto.randomUUID();
  const iso = new Date(nowMs).toISOString();
  const home = options.target ?? address(env);
  if (!home.chatId) throw new Error('чат асистента не налаштовано');
  await env.DB.prepare(
    `INSERT INTO chains (id, kind, workflow_id, state_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'running', ?, ?)`,
  )
    .bind(
      chainId,
      CHAIN_KIND,
      chainId,
      JSON.stringify({
        date,
        awaiting: null,
        chat_id: home.chatId,
        thread_id:
          home.threadId ??
          (Number(env.TELEGRAM_OWNER_USER_ID) > 0 &&
          String(home.chatId) === String(env.TELEGRAM_OWNER_USER_ID)
            ? 'dm'
            : null),
        one_shot: Boolean(options.oneShot),
      }),
      iso,
      iso,
    )
    .run();
  await env.DAY_PLAN.create({
    id: chainId,
    params: {
      chainId,
      date,
      ...(options.oneShot ? { oneShot: true } : {}),
      ...(options.initialIntent ? { initialIntent: options.initialIntent } : {}),
      ...(options.resumeDraft ? { resumeDraft: true } : {}),
    },
  });
  await upsertDayPlan(
    env,
    date,
    { status: options.resumeDraft ? 'draft' : 'intent', workflow_id: chainId },
    nowMs,
  );
  return chainId;
}

/**
 * Старт Денного працівника (профіль `day-planner` у мозку): вхід - JSON
 * задачі; вихід повернеться подією `worker` у ланцюг через /internal/runs.
 * @param {Env} env
 * @param {{ chainId: string, date: string, mode: string, task: Record<string, unknown> }} req
 * @param {number} nowMs
 */
export function startDayPlannerRun(env, req, nowMs) {
  return startChainWorkerRun(
    env,
    {
      profile: 'day-planner',
      instruction: 'day-planner',
      model: DAY_PLANNER_MODEL,
      input: {
        chain_id: req.chainId,
        mode: req.mode,
        date: req.date,
        task: req.task,
        format: req.mode === 'explain' ? 'chat' : 'json',
      },
      log: 'day-plan',
    },
    nowMs,
  );
}

/**
 * Бойове io ланцюга. chainId/date замикаються тут: кожна задача працівника
 * несе chain_id, щоб його відповідь (outcome.chain) знайшла саме цей ланцюг.
 * Доставка - enqueue + best-effort drain (як у підказках/експорті): збій
 * драйну лишає повідомлення в outbox сторожу `outbox-drain`, але в лог іде.
 * @param {Env} env @param {string} chainId @param {string} date
 * @param {{ chatId: string | number | null, threadId: string | number | null }} [target]
 */
export function productionIo(env, chainId, date, target = address(env)) {
  return /** @type {ChainIo} */ ({
    now: () => Date.now(),
    target,
    send: async (text, btns) => {
      if (!target.chatId) throw new Error('чат асистента не налаштовано');
      await enqueueOutbox(
        env,
        {
          chatId: target.chatId,
          threadId: target.threadId,
          kind: 'send',
          // Текст плану - Markdown працівника → HTML Telegram, як deliver.
          parts: renderMdParts(text),
          payload: btns ? { reply_markup: { inline_keyboard: btns } } : {},
        },
        Date.now(),
      );
      await drainOutbox(env, { nowMs: Date.now() }).catch((/** @type {any} */ e) => {
        console.error(`day-plan ${chainId}: драйн outbox впав, доставить sweeper`, e?.message);
      });
    },
    startWorker: async (mode, task) =>
      startDayPlannerRun(
        env,
        { chainId, date, mode, task: { ...task, chain_id: chainId, date } },
        Date.now(),
      ),
    readCalendar: async (day) => {
      const events = await readCalendarRange(env, day, day);
      // Чат-шлях (plan.intent) без календаря відмовляє; ланцюг мусить дожити
      // до ранку - планує без подій, але не мовчки.
      if (events == null) {
        console.error(`day-plan ${chainId}: календар недоступний, розкладка без подій`);
      }
      if (events == null) return null;
      return events.map((e) => ({
        title: String(e.title ?? ''),
        startMin: typeof e.startMs === 'number' ? kyivMinuteOfDay(new Date(e.startMs)) : null,
        endMin: typeof e.endMs === 'number' ? kyivMinuteOfDay(new Date(e.endMs)) : null,
        transparent: e.transparent,
      }));
    },
    readEnergy: async () => energyBySlot((await loadStats(env)).checkins ?? {}),
    readRoute: async (args) => {
      try {
        const { result } = await runRoutesEta(env, args, Date.now());
        return result;
      } catch {
        return null;
      }
    },
  });
}

/** Workflow-клас (wrangler.jsonc `workflows`, worker.js export). */
export class DayPlanChain extends WorkflowEntrypoint {
  /**
   * @override
   * @param {any} event - WorkflowEvent<{ chainId: string, date: string }>
   * @param {any} step - WorkflowStep
   */
  async run(event, step) {
    const env = /** @type {Env} */ (this.env);
    const params = /** @type {{ chainId: string, date: string }} */ (event.payload);
    const saved = await readChainState(env, params.chainId);
    const target = saved ? chainTarget(env, saved.state ?? {}) : address(env);
    const io = productionIo(env, params.chainId, params.date, target);
    try {
      return await runDayPlanChain(env, params, step, io);
    } catch (/** @type {any} */ e) {
      console.error(`day-plan chain ${params.chainId} впав`, e?.message);
      await setChainState(env, params.chainId, { status: 'failed', awaiting: null }).catch(
        () => {},
      );
      throw e;
    }
  }
}

// Експорт для тестів: дата сьогодні за Києвом (kick рахує «завтра» від неї).
export { kyivDateKey, hhmmToMin };
