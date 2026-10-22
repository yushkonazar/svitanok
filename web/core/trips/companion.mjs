import { tripLocalParts, tripZone } from './time.mjs';

export const COMPANION_OPS = ['task', 'booking', 'progress', 'party', 'preferences', 'prepare'];
export const TASK_GROUPS = ['documents', 'bookings', 'packing', 'home', 'return', 'other', 'post'];
const STATES = ['planned', 'departed', 'arrived', 'returning', 'home'];
/** @type {Record<string,string>} */
const STAGE_LABELS = {
  planned: 'ще не підтверджений',
  departed: 'у дорозі',
  arrived: 'на місці',
  returning: 'повертаюся',
  home: 'вдома',
};
/** @type {Record<string,string>} */
const BOOKING_LABELS = {
  selected: 'обрано',
  owner_booked: 'заброньовано зі слів власника',
  provider_confirmed: 'є підтвердження провайдера',
  cancelled: 'скасовано',
  refund_pending: 'очікую повернення коштів',
  refunded: 'кошти повернули',
};
/** @param {unknown} value @param {number} max */
const text = (value, max) =>
  String(value ?? '')
    .trim()
    .slice(0, max);
/** @param {unknown} value */
function id(value) {
  const result = String(value ?? crypto.randomUUID());
  if (!/^[\w-]{8,64}$/.test(result)) throw new Error('Не вдалося визначити запис.');
  return result;
}
/** @param {unknown} value */
function instant(value) {
  if (value == null || value === '') return null;
  const v = String(value);
  if (!/(?:Z|[+-]\d\d:\d\d)$/.test(v) || !Number.isFinite(Date.parse(v)))
    throw new Error('Строк потребує дати, години й часового поясу.');
  return new Date(v).toISOString();
}
/** @param {unknown} value */
function url(value) {
  if (!value) return null;
  const u = new URL(String(value));
  if (u.protocol !== 'https:' || u.username || u.password || u.href.length > 1200)
    throw new Error('Потрібне звичайне HTTPS-посилання.');
  return u.href;
}

/** Pure validated mutations shared by assistant and Mini App. No booking or payment occurs.
 * @param {string} op @param {any} input @param {any} travel @param {number} nowMs @param {any} [state] @returns {{facet:string,value:any}|null} */
export function companionChange(op, input, travel, nowMs, state = {}) {
  if (!COMPANION_OPS.includes(op)) return null;
  const at = new Date(nowMs).toISOString();
  if (op === 'prepare') {
    const old = Array.isArray(travel.tasks) ? travel.tasks : [];
    const existing = new Set(old.map((/** @type {any} */ t) => t.id));
    const value = [...old, ...suggestedPreparation(state).filter((t) => !existing.has(t.id))];
    if (value.length > 200)
      throw new Error('У списку вже забагато справ. Прибери зайві перед доповненням.');
    return { facet: 'tasks', value };
  }
  if (op === 'progress') {
    if (!STATES.includes(input.stage))
      throw new Error('Обери етап: план, виїхав, прибув, повертаюся або вдома.');
    return {
      facet: 'progress',
      value: { stage: input.stage, at, confirmed: true, note: text(input.note, 240) },
    };
  }
  if (op === 'preferences') {
    const old = travel.preferences ?? {};
    const value = { ...old };
    if (input.support_level != null) {
      if (!['plan', 'reminders', 'companion'].includes(input.support_level))
        throw new Error('Обери режим супроводу.');
      value.support_level = input.support_level;
    }
    for (const key of ['morning', 'evening', 'paused', 'weather_share_city'])
      if (input[key] != null) {
        if (typeof input[key] !== 'boolean') throw new Error('Обери стан повідомлень.');
        value[key] = input[key];
      }
    if (input.timezone != null) value.timezone = tripZone(input.timezone);
    if (Object.hasOwn(input, 'weather_share_city'))
      value.weather_consent = input.weather_share_city
        ? { provider: 'OpenWeather', scope: 'destination_city', at, source: 'owner_ui' }
        : null;
    return { facet: 'preferences', value: { ...value, updated_at: at } };
  }
  if (op === 'party') {
    if (!Array.isArray(input.members) || input.members.length > 100)
      throw new Error('Укажи учасників групи.');
    const members = input.members.map((/** @type {any} */ p) => ({
      id: p.id === 'owner' ? 'owner' : id(p.id),
      label: text(p.label, 80),
      count: Number(p.count ?? 1),
    }));
    if (
      new Set(members.map((/** @type {any} */ p) => p.id)).size !== members.length ||
      members.some(
        (/** @type {any} */ p) =>
          !p.label || !Number.isInteger(p.count) || p.count < 1 || p.count > 100,
      )
    )
      throw new Error('Перевір імена, кількість та різні ідентифікатори учасників.');
    return { facet: 'party', value: members };
  }
  const facet = op === 'task' ? 'tasks' : 'bookings';
  const list = Array.isArray(travel[facet]) ? travel[facet] : [];
  const recordId = id(input.id),
    old = list.find((/** @type {any} */ r) => r.id === recordId);
  if (input.remove === true)
    return { facet, value: list.filter((/** @type {any} */ r) => r.id !== recordId) };
  const title = text(input.title ?? old?.title, 160);
  if (!title) throw new Error('Назви справу або бронювання.');
  let record;
  if (op === 'task') {
    const group = input.group ?? old?.group ?? 'other';
    if (!TASK_GROUPS.includes(group)) throw new Error('Обери розділ списку.');
    const status = input.status ?? old?.status ?? 'open';
    if (!['open', 'done', 'later', 'not_needed'].includes(status))
      throw new Error('Обери стан справи.');
    const due_at = Object.hasOwn(input, 'due_at') ? instant(input.due_at) : (old?.due_at ?? null);
    record = {
      ...old,
      id: recordId,
      title,
      group,
      status,
      due_at,
      owner: text(input.owner ?? old?.owner, 80),
      note: text(input.note ?? old?.note, 300),
      updated_at: at,
    };
    if (due_at !== old?.due_at || status !== old?.status) delete record.notified_at;
  } else {
    const status = input.status ?? old?.status ?? 'selected',
      kind = input.kind ?? old?.kind ?? 'stay';
    if (
      ![
        'selected',
        'owner_booked',
        'provider_confirmed',
        'cancelled',
        'refund_pending',
        'refunded',
      ].includes(status) ||
      !['transport', 'stay', 'activity', 'insurance', 'other'].includes(kind)
    )
      throw new Error('Уточни тип і стан бронювання.');
    if (status === 'provider_confirmed' && !input.source_url && !old?.source_url)
      throw new Error('Для підтвердження провайдером потрібне джерело.');
    record = {
      ...old,
      id: recordId,
      title,
      status,
      kind,
      source_url: url(input.source_url ?? old?.source_url),
      reference: text(input.reference ?? old?.reference, 100),
      cancel_by: Object.hasOwn(input, 'cancel_by')
        ? instant(input.cancel_by)
        : (old?.cancel_by ?? null),
      checkin_at: Object.hasOwn(input, 'checkin_at')
        ? instant(input.checkin_at)
        : (old?.checkin_at ?? null),
      note: text(input.note ?? old?.note, 300),
      updated_at: at,
    };
  }
  const value = [...list.filter((/** @type {any} */ r) => r.id !== recordId), record];
  if (value.length > 200) throw new Error('У поїздці вже 200 записів цього виду.');
  return { facet, value };
}

/** @param {any} state */
export function suggestedPreparation(state) {
  const a = state.preferences ?? state,
    tasks = [
      ['documents', 'Перевірити документи, квитки й потрібне страхування', 'documents'],
      ['packing', 'Перевірити остаточний список речей і ліміти багажу', 'packing'],
      ['offline', 'Зберегти маршрут, адреси, квитки й контакти офлайн', 'documents'],
      ['home', 'Підготувати дім і завершити справи перед від’їздом', 'home'],
      ['return', 'Перевірити зворотні квитки й час прибуття додому', 'return'],
      ['pack-clothes', 'Одяг, білизна й шкарпетки на тривалість поїздки', 'packing'],
      ['pack-shoes', 'Зручне взуття для маршруту', 'packing'],
      ['pack-weather', 'Верхній одяг і захист від дощу за прогнозом', 'packing'],
      ['pack-hygiene', 'Засоби гігієни з урахуванням правил багажу', 'packing'],
      ['pack-medicine', 'Особисті ліки, рецепти й базова аптечка', 'packing'],
      ['pack-charger', 'Телефон, зарядні пристрої, павербанк і потрібний адаптер', 'packing'],
      ['pack-money', 'Платіжні картки та резервна готівка', 'packing'],
      ['pack-daybag', 'Невеликий рюкзак, вода та перекус у дорогу', 'packing'],
      ['home-keys', 'Ключі, вікна, вода, техніка й доступ довіреної людини', 'home'],
      ['home-care', 'Рослини, тварини, пошта й побутові платежі', 'home'],
      ['booking-transport', 'Перевірити стан квитків, імена, місце посадки та час', 'bookings'],
      ['return-bag', 'Перед виїздом перевірити речі, документи й залишені застави', 'return'],
    ];
  if (a.lodging_needed === 'yes')
    tasks.push([
      'lodging',
      'Підтвердити адресу, заселення, виїзд, податки й умови скасування житла',
      'bookings',
    ]);
  if (state.mode === 'car')
    tasks.push(['vehicle', 'Перевірити авто, зупинки, пальне/зарядки й парковку', 'bookings']);
  if (state.mode === 'plane')
    tasks.push(['flight', 'Перевірити реєстрацію, багаж, пересадки й трансфери', 'bookings']);
  if (['hike', 'walk'].includes(state.mode))
    tasks.push([
      'outdoor',
      'Перевірити умови маршруту, денне світло, спорядження й зв’язок',
      'packing',
    ]);
  if (a.international || (state.country && !/^(UA|Україна)$/iu.test(state.country)))
    tasks.push(
      [
        'border',
        'Перевірити актуальні правила виїзду, в’їзду й транзиту для кожного учасника',
        'documents',
      ],
      ['connection', 'Підготувати роумінг / eSIM, валюту та резервну оплату', 'packing'],
      [
        'passport',
        'Перевірити чинність паспортів, віз / дозволів і документи дітей, якщо потрібні',
        'documents',
      ],
    );
  if (a.children_count > 0)
    tasks.push(['pack-children', 'Дитячі речі, харчування та потрібне спорядження', 'packing']);
  return tasks.map(([key, title, group]) => ({
    id: `suggest-${key}`,
    title,
    group,
    status: 'open',
    suggested: true,
  }));
}

/** @param {any} state @param {any} travel @param {number} nowMs */
export function companionView(state, travel, nowMs) {
  const zone = tripZone(travel.preferences?.timezone ?? state.preferences?.timezone),
    local = tripLocalParts(nowMs, zone);
  const tasks = Array.isArray(travel.tasks) ? travel.tasks : [];
  const bookings = Array.isArray(travel.bookings) ? travel.bookings : [];
  return {
    progress: travel.progress ?? { stage: 'planned', confirmed: false },
    party: travel.party ?? [],
    tasks,
    bookings,
    preferences: travel.preferences ?? {},
    suggested_tasks: suggestedPreparation(state),
    local_date: local.date,
    timezone: zone,
    open_tasks: tasks.filter((/** @type {any} */ t) => t.status === 'open'),
    upcoming_deadlines: bookings
      .filter(
        (/** @type {any} */ b) =>
          b.status !== 'cancelled' && b.cancel_by && Date.parse(b.cancel_by) > nowMs,
      )
      .sort((/** @type {any} */ a, /** @type {any} */ b) => a.cancel_by.localeCompare(b.cancel_by)),
  };
}

/** @param {any} state @param {any} costs @param {string} date @param {number} nowMs */
export function tripDayPlan(state, costs, date, nowMs = Date.parse(`${date}T12:00:00Z`)) {
  const travel = costs.travel ?? {},
    view = companionView(state, travel, nowMs);
  const legs = travel.itinerary_stale
    ? []
    : (travel.legs ?? []).filter((/** @type {any} */ l) => l.start?.slice(0, 10) === date);
  return [
    `${state.to_text ?? state.to} · ${date}`,
    `Етап зі слів власника: ${STAGE_LABELS[view.progress.stage] ?? 'не визначено'}`,
    ...legs.map(
      (/** @type {any} */ l) =>
        `${l.start.slice(11)}–${l.end.slice(11)} · ${l.title} (${l.start_zone}${l.end_zone !== l.start_zone ? ` → ${l.end_zone}` : ''})${l.transfer_minutes ? ` · запас ${l.transfer_minutes} хв` : ''}`,
    ),
    ...view.open_tasks
      .filter(
        (/** @type {any} */ t) =>
          !t.due_at || tripLocalParts(Date.parse(t.due_at), view.timezone).date <= date,
      )
      .slice(0, 5)
      .map((/** @type {any} */ t) => `☐ ${t.title}`),
    ...view.upcoming_deadlines
      .slice(0, 2)
      .map((/** @type {any} */ b) => `До ${b.cancel_by}: умови скасування «${b.title}»`),
    ...(travel.itinerary_stale
      ? ['Дати змінилися. Перевір і підтвердь маршрут у розділі Подорожі.']
      : legs.length
        ? []
        : ['Точний маршрут дня ще не збережений. Обери місця або додай етапи.']),
  ].join('\n');
}

/** Portable first-party text; downloaded once and available without network.
 * @param {any} state @param {any} costs @param {any[]} [planningStages] */
export function tripOfflinePack(state, costs, planningStages = []) {
  const travel = costs.travel ?? {};
  return [
    `# ${state.to_text ?? state.to ?? 'Подорож'}`,
    `${state.date_from} — ${state.date_to ?? 'повернення ще не визначене'}`,
    `Звідки: ${state.from_city ?? 'ще не визначено'}`,
    `Час: ${state.preferences?.departure_timezone ?? 'не визначено'} → ${state.preferences?.timezone ?? 'не визначено'}`,
    '',
    '## Обраний план',
    ...planningStages.flatMap((stage) => {
      const d = stage.decision;
      if (!d) return [];
      const label =
        /** @type {Record<string,string>} */ ({
          transport: 'Дорога',
          stay: 'Житло',
          activity: 'Місця',
        })[stage.kind] ?? stage.kind;
      return [
        `### ${label}${stage.resolved ? '' : ' — потребує повторної перевірки'}`,
        ...(d.mode === 'later'
          ? ['Рішення відкладено.']
          : d.mode === 'manual'
            ? [d.note]
            : (d.options ?? []).map(
                (/** @type {any} */ o) =>
                  `- ${o.title}; ${o.dates ?? ''}; ${o.schedule ?? ''}; ${o.location ?? ''}; ${o.source_url}`,
              )),
        'Обраний варіант сам по собі не підтверджує бронювання.',
      ];
    }),
    '',
    '## Маршрут',
    ...(travel.itinerary_stale
      ? ['Увага: дати змінено; наведені етапи потребують повторної перевірки.']
      : []),
    ...(travel.legs ?? []).map(
      (/** @type {any} */ l) =>
        `- ${l.start} ${l.start_zone} → ${l.end} ${l.end_zone}: ${l.title}; ${l.from ?? ''} → ${l.to ?? ''}${l.source_url ? ` (${l.source_url})` : ''}`,
    ),
    '',
    '## Підготовка',
    ...(travel.tasks ?? []).map(
      (/** @type {any} */ t) =>
        `- [${t.status === 'done' ? 'x' : ' '}] ${t.title}${t.due_at ? ` · до ${t.due_at}` : ''}`,
    ),
    '',
    '## Бронювання та джерела',
    ...(travel.bookings ?? []).map(
      (/** @type {any} */ b) =>
        `- ${b.title}: ${BOOKING_LABELS[b.status] ?? 'стан не визначено'}${b.reference ? ` · ${b.reference}` : ''}${b.source_url ? ` · ${b.source_url}` : ''}${b.cancel_by ? ` · скасування до ${b.cancel_by}` : ''}`,
    ),
    '',
    '## Місця',
    ...(travel.places ?? []).map(
      (/** @type {any} */ p) =>
        `- ${p.title}${p.note ? ` · ${p.note}` : ''}${p.url ? ` · ${p.url}` : ''}`,
    ),
    '',
    'Збережена копія плану. Актуальні зміни перевізника та наявність послуг потребують повторної перевірки.',
  ].join('\n');
}
