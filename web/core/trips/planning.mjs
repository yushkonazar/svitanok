import { tripResearchBasis, tripResearchView } from './options.mjs';
import { normalizeTripAnswers } from '../tools/trip.mjs';
import { normalizeTripSearchResult, TRIP_SEARCH_PROVIDERS } from './providers.mjs';
import {
  canonical,
  PLANNING_KINDS,
  planningBriefKey,
  planningStageKey,
  planningOptionReference,
} from './planning-basis.mjs';
export {
  PLANNING_KINDS,
  planningBriefKey,
  planningStageKey,
  planningOptionReference,
} from './planning-basis.mjs';
export const TRIP_SEARCH_TIMEOUT = 9 * 60_000;

/** The same saved brief powers both chat and the guided Mini App. Known geography is never asked twice.
 * @param {any} brief @param {boolean} [includeAnswered] */
export function planningQuestions(brief, includeAnswered = false) {
  const a = brief.answers ?? {},
    skipped = new Set(a._skipped ?? []);
  /** @type {any[]} */
  const questions = [];
  /** @param {string} field @param {string} section @param {string} question @param {any} [opts] */
  const add = (field, section, question, opts = {}) => {
    if (!includeAnswered && skipped.has(field) && opts.optional) return;
    if (
      !includeAnswered &&
      a[field] != null &&
      a[field] !== '' &&
      !(field === 'lodging_count' && a._inferred?.lodging_count)
    )
      return;
    const choices = Object.entries(opts.choices ?? {}).map(([value, label]) => ({
      value:
        opts.type === 'number'
          ? Number(value)
          : field === 'international'
            ? value === 'true'
            : value,
      label,
    }));
    questions.push({
      field,
      section,
      question,
      type: opts.type ?? 'text',
      optional: opts.optional === true,
      choices,
      custom: opts.custom !== false,
      hint: opts.hint ?? '',
    });
  };
  for (const q of brief.ask ?? []) {
    if (['destination_choice', 'origin_choice'].includes(q.field)) {
      questions.push({
        ...q,
        section: 'Маршрут',
        type: 'text',
        custom: false,
        choices: (q.options ?? []).map((/** @type {string} */ v, /** @type {number} */ i) => ({
          value: v,
          label: q.labels?.[i] ?? v,
        })),
      });
      return questions;
    }
  }
  if (
    !includeAnswered &&
    brief.warnings?.length &&
    (!brief.already_started || (a.date_to && a.date_from && a.date_to < a.date_from))
  ) {
    const field = a.date_to && a.date_from && a.date_to < a.date_from ? 'date_to' : 'date_from';
    return [
      {
        field,
        section: 'Дати',
        question: brief.warnings.join(' '),
        type: 'date',
        optional: false,
        choices: [],
        custom: true,
        hint: '',
      },
    ];
  }
  if (!includeAnswered && a.lodging_from && a.lodging_to && a.lodging_to <= a.lodging_from)
    return [
      {
        field: 'lodging_to',
        section: 'Житло',
        question: 'Дата виїзду з житла має бути пізнішою за заселення.',
        type: 'date',
        optional: false,
        choices: [],
        custom: true,
        hint: '',
      },
    ];
  add('to', 'Маршрут', 'Куди хочеш поїхати?', {
    hint: 'Місто або конкретне місце. Країну й часовий пояс визначу за містом.',
  });
  add('from_city', 'Маршрут', 'Звідки вирушаєте?');
  add('date_from', 'Дати', 'Коли виїжджаєте?', { type: 'date' });
  add('return_type', 'Дати', 'Плануємо й дорогу додому?', {
    custom: false,
    choices: {
      round_trip: 'Так, туди й назад',
      one_way: 'Лише в один бік',
      undecided: 'Дату ще визначимо',
    },
  });
  if (a.return_type === 'round_trip') {
    add('date_to', 'Дати', 'Яка дата повернення?', { type: 'date' });
    add('return_meaning', 'Дати', 'Що означає ця дата?', {
      custom: false,
      choices: {
        home_arrival: 'Цього дня вже бути вдома',
        destination_departure: 'Цього дня виїхати назад',
        undecided: 'Ще уточню',
      },
    });
  }
  add('mode', 'Транспорт', 'Чим хочете їхати?', {
    custom: false,
    choices: {
      bus: 'Автобус',
      train: 'Потяг',
      car: 'Авто',
      plane: 'Літак',
      mixed: 'Кілька видів транспорту',
      compare: 'Допоможи порівняти',
      hike: 'Похід',
      walk: 'Пішки',
    },
  });
  add('transport_count', 'Учасники', 'Скільки людей їде разом із тобою, враховуючи тебе?', {
    type: 'number',
    choices: { 1: 'Сам / сама', 2: 'Двоє', 3: 'Троє', 4: 'Четверо' },
  });
  add('destination_count', 'Учасники', 'А скільки вас буде загалом на місці?', {
    type: 'number',
    choices: Object.fromEntries(
      [...new Set([a.transport_count, 2, 3, 4, 5, 6].filter(Boolean))].map((n) => [
        n,
        n === a.transport_count ? `Стільки ж — ${n}` : String(n),
      ]),
    ),
    hint: 'Для дороги й житла зберігаю окремий склад групи.',
  });
  add('children_count', 'Учасники', 'У групі будуть діти?', {
    type: 'number',
    optional: true,
    choices: { 0: 'Ні', 1: 'Одна дитина', 2: 'Двоє дітей' },
  });
  if (a.children_count > 0)
    add('children_ages', 'Учасники', 'Який вік дітей на час подорожі?', {
      optional: true,
      hint: 'Вік впливає на квитки, поселення та відповідні заняття.',
    });
  add('purpose', 'Побажання', 'Для чого ця поїздка?', {
    choices: {
      дозвілля: 'Відпочинок',
      ділова: 'Робота',
      подія: 'Подія / зустріч',
      транзит: 'Транзит',
    },
  });
  add('international', 'Документи', 'Це поїздка за кордон?', {
    custom: false,
    choices: { true: 'Так', false: 'Ні' },
  });
  if (a.international === true) {
    add('country', 'Документи', 'У яку країну їдете?', {
      hint: 'Потрібно лише якщо місце не вдалося однозначно визначити.',
    });
    add('citizenship', 'Документи', 'Громадянство учасників для перевірки правил в’їзду?', {
      optional: true,
      choices: { Україна: 'Усі — Україна', 'Різне; уточню окремо': 'Різне, уточню пізніше' },
      hint: 'Не потрібні номери чи фото документів. Для змішаної групи можна описати кожну частину.',
    });
  }
  if (['bus', 'train', 'plane', 'mixed', 'compare'].includes(a.mode)) {
    add('departure_window', 'Транспорт', 'Коли зручно вирушити?', {
      choices: {
        Вранці: 'Вранці',
        Вдень: 'Вдень',
        Ввечері: 'Ввечері',
        Вночі: 'Вночі',
        'Будь-коли': 'Без різниці',
      },
    });
    add('ticket_status', 'Транспорт', 'Квитки вже є?', {
      custom: false,
      choices: { not_booked: 'Ще шукаємо', booked: 'Уже купили', undecided: 'Ще вирішуємо' },
    });
  }
  if (a.mode === 'car')
    add('vehicle_description', 'Транспорт', 'Яким авто їдете?', {
      optional: true,
      hint: 'Модель, пальне / зарядка, витрата — якщо відомі.',
    });
  if (a.mode === 'plane')
    add('departure_airport', 'Транспорт', 'З якого аеропорту зручно летіти?', { optional: true });
  add('baggage', 'Транспорт', 'Який багаж плануєте?', {
    optional: true,
    choices: {
      'Лише ручна поклажа': 'Ручна поклажа',
      'Валізи та ручна поклажа': 'Валізи',
      'Ще визначимо': 'Ще не знаю',
    },
  });
  if (a.return_type === 'round_trip') {
    add('return_count', 'Учасники', 'Скільки людей їде назад разом із тобою?', {
      type: 'number',
      optional: true,
      choices: Object.fromEntries(
        [...new Set([a.transport_count, a.destination_count].filter(Boolean))].map((n) => [
          n,
          `${n} людей`,
        ]),
      ),
    });
    add('return_window', 'Транспорт', 'Який час зворотної дороги зручний?', {
      optional: true,
      choices: { Вранці: 'Вранці', Вдень: 'Вдень', Ввечері: 'Ввечері', 'Будь-коли': 'Без різниці' },
    });
  }
  add('lodging_needed', 'Житло', 'Потрібно підшукати житло?', {
    custom: false,
    choices: { yes: 'Так, шукаємо', no: 'Уже є / не потрібне', undecided: 'Поки вирішую' },
  });
  if (['yes', 'undecided'].includes(a.lodging_needed)) {
    add('lodging_count', 'Житло', 'На скількох людей шукати житло?', {
      type: 'number',
      choices: Object.fromEntries(
        [...new Set([a.destination_count, a.transport_count, 2, 4].filter(Boolean))].map((n) => [
          n,
          `${n} людей`,
        ]),
      ),
      hint: a._inferred?.lodging_count ?? '',
    });
    add('lodging_layout', 'Житло', 'Як хочете розміститися?', {
      custom: false,
      choices: {
        apartment: 'Одна квартира',
        separate_rooms: 'Окремі номери',
        shared_room: 'Спільний номер',
        undecided: 'Порівняй варіанти',
      },
    });
    if (a.lodging_layout === 'separate_rooms')
      add('lodging_rooms', 'Житло', 'Скільки номерів потрібно?', {
        type: 'number',
        choices: { 1: 'Один', 2: 'Два', 3: 'Три' },
      });
    add('lodging_from', 'Житло', 'Коли заселяєтесь?', {
      type: 'date',
      hint: 'Нічний автобус може прибути наступного дня після виїзду.',
    });
    add('lodging_to', 'Житло', 'Коли виїжджаєте з житла?', { type: 'date' });
    add('lodging_preference', 'Житло', 'Що найважливіше в житлі?', {
      optional: true,
      choices: {
        'Ближче до центру': 'Ближче до центру',
        'Тиша і комфорт': 'Тиша і комфорт',
        'Найнижча ціна': 'Найнижча ціна',
        'Баланс ціни та розташування': 'Баланс ціни й розташування',
      },
    });
  }
  add('budget_type', 'Бюджет', 'Як плануємо бюджет?', {
    custom: false,
    choices: {
      limit: 'Є ліміт',
      flexible: 'Покажи орієнтовні витрати',
      no_limit: 'Ліміт поки не задаю',
    },
  });
  if (a.budget_type === 'limit') {
    add('budget_total', 'Бюджет', 'Який загальний ліміт?', { type: 'number' });
    add('budget_currency', 'Бюджет', 'У якій валюті?', {
      choices: { UAH: 'Гривня', EUR: 'Євро', USD: 'Долар', CZK: 'Чеська крона' },
    });
    add('budget_scope', 'Бюджет', 'Для кого цей бюджет?', {
      custom: false,
      choices: {
        person: 'На мене',
        transport_group: 'На тих, хто їде разом',
        whole_group: 'На всю групу на місці',
      },
    });
  }
  add('interests', 'Враження', 'Що хочеться робити на місці?', {
    optional: true,
    choices: {
      'Прогулянки, архітектура й головні пам’ятки': 'Прогулянки й архітектура',
      'Музеї та культура': 'Музеї й культура',
      'Їжа, кав’ярні та місцева кухня': 'Їжа й кав’ярні',
      'Природа та активний відпочинок': 'Природа й активності',
      'Різноманітна програма': 'Трохи всього',
    },
  });
  add('travel_pace', 'Враження', 'Який темп подорожі?', {
    optional: true,
    custom: false,
    choices: { relaxed: 'Без поспіху', balanced: 'Збалансовано', busy: 'Насичено' },
  });
  add('food_preference', 'Враження', 'Є побажання до їжі?', {
    optional: true,
    choices: {
      'Без обмежень': 'Без обмежень',
      'Вегетаріанське харчування': 'Вегетаріанське',
      'Місцева кухня': 'Місцева кухня',
    },
  });
  add('accessibility', 'Потреби', 'Що врахувати для комфорту й доступності?', {
    optional: true,
    choices: {
      'Особливих потреб немає': 'Особливих потреб немає',
      'Менше ходьби': 'Менше ходьби',
      'Безбар’єрний доступ': 'Безбар’єрний доступ',
    },
  });
  add('constraints', 'Потреби', 'Ще щось важливе для цієї поїздки?', {
    optional: true,
    hint: 'Наприклад: тварини, події на конкретну годину, пересадки, потреби дітей.',
  });
  add('support_level', 'Супровід', 'Як допомагати після планування?', {
    custom: false,
    choices: {
      plan: 'Лише план у застосунку',
      reminders: 'План і важливі нагадування',
      companion: 'Супровід протягом подорожі',
    },
  });
  return questions;
}

/** @param {any} answers @param {string} kind @param {number} nowMs */
function stageView(answers, kind, nowMs) {
  const p = answers._planning ?? {},
    basis = planningStageKey(answers, kind);
  const job = p.searches?.[kind] ?? null;
  const candidates = tripResearchView(answers, nowMs).options.filter(
    (/** @type {any} */ o) => o.kind === kind && (!o.planning_basis || o.planning_basis === basis),
  );
  const decision = p.decisions?.[kind];
  const valid = Boolean(
    decision &&
    decision.basis === basis &&
    (decision.mode !== 'selected' ||
      decision.options.every((/** @type {any} */ o) =>
        candidates.some(
          (/** @type {any} */ candidate) =>
            candidate.id === o.id &&
            !candidate.stale &&
            canonical(planningOptionReference(candidate)) === canonical(planningOptionReference(o)),
        ),
      )),
  );
  const status =
    job && job.basis !== basis
      ? 'stale'
      : job?.status === 'running' && nowMs - Date.parse(job.started_at) > TRIP_SEARCH_TIMEOUT
        ? 'timed_out'
        : (job?.status ?? 'idle');
  return {
    kind,
    status,
    summary: job?.summary ?? '',
    started_at: job?.started_at ?? null,
    options: candidates,
    decision: decision ?? null,
    resolved: valid,
    needs_review: Boolean(decision && !valid),
  };
}
/** @param {any} brief @param {number} nowMs */
export function tripPlanningView(brief, nowMs) {
  const a = brief.answers ?? {},
    p = a._planning ?? {},
    questions = planningQuestions(brief);
  const stages = PLANNING_KINDS.map((kind) => stageView(a, kind, nowMs));
  const confirmed = p.confirmed_basis === planningBriefKey(a) && questions.length === 0;
  return {
    revision: Number(p.revision ?? 0),
    brief_revision: brief.revision ?? 0,
    question: questions[0] ?? null,
    fields: planningQuestions(brief, true),
    remaining: questions.length,
    confirmed,
    step: !confirmed
      ? questions.length
        ? 'questions'
        : 'review'
      : (stages.find((stage) => !stage.resolved)?.kind ?? 'ready'),
    stages,
    providers: TRIP_SEARCH_PROVIDERS,
  };
}

/** CAS protects answers, choices and pending jobs as one record. @param {Env} env @param {any} row @param {any} answers @param {number} nowMs */
export async function savePlanning(env, row, answers, nowMs) {
  if (!env.DB) throw new Error('Сховище подорожей недоступне.');
  const saved = await env.DB.prepare(
    'UPDATE trip_briefs SET answers_json=?,updated_at=? WHERE id=? AND scope_key=? AND answers_json=?',
  )
    .bind(
      JSON.stringify(answers),
      new Date(nowMs).toISOString(),
      row.id,
      row.scope_key,
      row.answers_json,
    )
    .run();
  if (Number(saved.meta?.changes ?? 0) !== 1)
    throw new Error('План змінився паралельно. Онови сторінку перед повтором.');
}
/** Owner-only control plane, called by the authenticated Mini App; never exposed as a model tool.
 * @param {Env} env @param {any} row @param {any} brief @param {any} data @param {number|undefined} revision @param {number} nowMs */
export async function changePlanning(env, row, brief, data, revision, nowMs) {
  const stored = JSON.parse(String(row.answers_json));
  // Read-only legacy repair derives the same geography/counts shown in the guide. Persist that
  // normalized projection with the explicit owner action, so review and research use one brief.
  const a = {
      ...stored,
      ...normalizeTripAnswers(brief?.answers),
      ...(brief?.answers?._inferred ? { _inferred: brief.answers._inferred } : {}),
    },
    p = a._planning ?? {},
    kind = data.kind;
  const view = tripPlanningView(
    { ...brief, answers: a, already_started: row.status === 'started' },
    nowMs,
  );
  const requestedKind =
    data.action === 'confirm' && data.start_search === true ? 'transport' : kind;
  if (
    ['search', 'confirm'].includes(data.action) &&
    p.active &&
    p.active.kind === requestedKind &&
    p.active.basis === planningStageKey(a, requestedKind) &&
    nowMs - Date.parse(p.active.started_at) <= TRIP_SEARCH_TIMEOUT
  )
    return { run_id: p.active.run_id, already_running: true };
  if (revision !== view.revision) throw new Error('План змінився. Онови сторінку.');
  const next = { ...p, revision: view.revision + 1 };
  if (data.action === 'confirm') {
    if (view.remaining) throw new Error('Спочатку заверши короткий бриф.');
    next.confirmed_basis = planningBriefKey(a);
    next.confirmed_at = new Date(nowMs).toISOString();
    if (data.start_search === true) {
      const job = {
        run_id: crypto.randomUUID(),
        kind: 'transport',
        basis: planningStageKey(a, 'transport'),
        status: 'running',
        started_at: new Date(nowMs).toISOString(),
      };
      next.active = job;
      next.searches = { ...p.searches, transport: job };
    }
  } else {
    if (!PLANNING_KINDS.includes(kind)) throw new Error('Обери етап пошуку.');
    if (!view.confirmed) throw new Error('Перевір і підтвердь дані перед пошуком.');
    const index = PLANNING_KINDS.indexOf(kind);
    if (view.stages.slice(0, index).some((stage) => !stage.resolved))
      throw new Error('Спочатку заверши попередній крок планування.');
    if (data.action === 'decision') {
      if (!['selected', 'manual', 'later'].includes(data.mode))
        throw new Error('Обери варіант або відклади рішення.');
      let options = [];
      if (data.mode === 'selected') {
        if (
          !Array.isArray(data.ids) ||
          !data.ids.length ||
          data.ids.length > (kind === 'activity' ? 12 : 1) ||
          new Set(data.ids).size !== data.ids.length
        )
          throw new Error('Обери потрібні варіанти зі списку.');
        const stage = view.stages[index];
        if (!stage) throw new Error('Обери етап пошуку.');
        options = data.ids.map((/** @type {string} */ id) =>
          stage.options.find((/** @type {any} */ o) => o.id === id && !o.stale),
        );
        if (options.some((/** @type {any} */ o) => !o))
          throw new Error('Варіанти потребують повторної перевірки.');
      }
      const note = String(data.note ?? '')
        .trim()
        .slice(0, 1000);
      if (data.mode === 'manual' && !note)
        throw new Error('Коротко запиши свій варіант, щоб врахувати його далі.');
      next.decisions = {
        ...p.decisions,
        [kind]: {
          mode: data.mode,
          options,
          note,
          basis: planningStageKey(a, kind),
          at: new Date(nowMs).toISOString(),
        },
      };
      // Keep the shared research surface consistent with explicit owner choices.
      if (options.length) {
        const first = options[0],
          old = a._research ?? {};
        a._research = {
          ...old,
          revision: Number(old.revision ?? 0) + 1,
          selections: { ...old.selections, [kind]: first.id },
          selection_snapshots: {
            ...old.selection_snapshots,
            [kind]: {
              option: first,
              basis: tripResearchBasis(a),
              selected_at: new Date(nowMs).toISOString(),
            },
          },
        };
      } else if (a._research?.selections?.[kind]) {
        a._research = {
          ...a._research,
          revision: Number(a._research.revision ?? 0) + 1,
          selections: { ...a._research.selections },
          selection_snapshots: { ...a._research.selection_snapshots },
        };
        delete a._research.selections[kind];
        delete a._research.selection_snapshots[kind];
      }
    } else if (data.action === 'search') {
      if (
        p.active &&
        nowMs - Date.parse(p.active.started_at) <= TRIP_SEARCH_TIMEOUT &&
        p.active.basis === planningStageKey(a, p.active.kind)
      )
        throw new Error('Попередній пошук ще триває. Зачекай на результат.');
      const job = {
        run_id: crypto.randomUUID(),
        kind,
        basis: planningStageKey(a, kind),
        status: 'running',
        started_at: new Date(nowMs).toISOString(),
        more: data.more === true,
        provider_page: data.more === true ? (p.searches?.[kind]?.next_page ?? null) : null,
      };
      next.active = job;
      next.searches = { ...p.searches, [kind]: job };
    } else throw new Error('Невідома дія планування.');
  }
  await savePlanning(env, row, { ...a, _planning: next }, nowMs);
  return data.action === 'search' || (data.action === 'confirm' && data.start_search === true)
    ? { run_id: next.active.run_id, queued: true }
    : { saved: true };
}

/** Only a registered trip-research run can deliver data here. Late, superseded and stale results cannot replace the owner's plan.
 * @param {Env} env @param {string} runId @param {any} output @param {boolean} failed @param {number} nowMs @param {boolean} [authenticatedQuote] */
export async function finishPlanningSearch(
  env,
  runId,
  output,
  failed,
  nowMs,
  authenticatedQuote = false,
) {
  if (!env.DB) throw new Error('Сховище подорожей недоступне.');
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await env.DB.prepare(
      "SELECT * FROM trip_briefs WHERE json_extract(answers_json,'$._planning.active.run_id')=?",
    )
      .bind(runId)
      .first();
    if (!row) return { ignored: true };
    const a = JSON.parse(String(row.answers_json)),
      p = a._planning,
      job = p.active;
    if (
      job.basis !== planningStageKey(a, job.kind) ||
      nowMs - Date.parse(job.started_at) > TRIP_SEARCH_TIMEOUT
    )
      return { ignored: true };
    let options = [],
      summary = '',
      status = 'failed';
    if (!failed) {
      try {
        const normalized = normalizeTripSearchResult(output, job.kind, nowMs, authenticatedQuote);
        options = normalized.options.map((/** @type {any} */ o) => ({
          ...o,
          planning_basis: job.basis,
        }));
        summary = normalized.summary;
        status = options.length ? 'completed' : 'no_results';
      } catch {
        status = 'failed';
      }
    }
    const completed = {
      ...job,
      next_page:
        authenticatedQuote && typeof output?.next_page === 'string'
          ? output.next_page.slice(0, 2000)
          : null,
      status,
      summary:
        status === 'failed'
          ? 'Не вдалося завершити пошук. Можна повторити або додати свій варіант.'
          : summary,
      completed_at: new Date(nowMs).toISOString(),
    };
    const old = a._research ?? {};
    const next = {
      ...a,
      _planning: {
        ...p,
        active: null,
        revision: Number(p.revision ?? 0) + 1,
        searches: { ...p.searches, [job.kind]: completed },
      },
    };
    if (status === 'completed' || status === 'no_results') {
      const ids = new Set(options.map((/** @type {any} */ o) => o.id));
      const selectedIds = new Set(Object.values(old.selections ?? {}));
      const previous = (old.options ?? []).filter((/** @type {any} */ o) => !ids.has(o.id));
      next._research = {
        ...old,
        basis: tripResearchBasis(a),
        stale: false,
        revision: Number(old.revision ?? 0) + 1,
        options: [
          ...options,
          ...previous.filter((/** @type {any} */ o) => selectedIds.has(o.id)),
          ...previous.filter((/** @type {any} */ o) => !selectedIds.has(o.id)),
        ].slice(0, 36),
        checked_at: new Date(nowMs).toISOString(),
        summary,
        provenance: 'external_reference',
      };
    }
    try {
      await savePlanning(env, row, next, nowMs);
      return { status };
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
  return { ignored: true };
}
