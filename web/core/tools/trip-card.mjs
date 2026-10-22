// Картка одного уточнення поїздки. Індекс у callback посилається тільки на
// allowlisted options поточного питання, а не містить довільний текст моделі.

const MODE_LABELS = {
  car: '🚗 Авто',
  train: '🚆 Потяг',
  bus: '🚌 Автобус',
  plane: '✈️ Літак',
  mixed: '🔀 Змішано',
  walk: '🚶 Пішки',
  hike: '🥾 Похід',
  compare: '⚖️ Порівняти',
};
/** @type {Record<string, Record<string, string>>} */
const LABELS = {
  purpose: { ділова: 'Робота', транзит: 'Транзит', дозвілля: 'Відпочинок' },
  participants: { 1: 'Сам / сама', 2: 'Двоє', 3: 'Троє', 4: 'Четверо', other: 'Інша кількість' },
  lodging_count: { 1: 'Одна людина', 2: 'Двоє', 3: 'Троє', 4: 'Четверо', other: 'Інша кількість' },
  return_meaning: {
    home_arrival: 'Уже бути вдома',
    destination_departure: 'Виїхати назад',
    undecided: 'Ще не знаю',
  },
  budget_scope: {
    person: 'На мене',
    transport_group: 'На тих, хто їде',
    whole_group: 'На всю групу',
  },
  travel_pace: { relaxed: 'Спокійний', balanced: 'Збалансований', busy: 'Насичений' },
  lodging_layout: {
    apartment: 'Квартира',
    separate_rooms: 'Окремі номери',
    shared_room: 'Спільний номер',
    undecided: 'Порівняти',
  },
  support_level: {
    plan: 'Лише план',
    reminders: 'План і нагадування',
    companion: 'Повний супровід',
  },
  pets: { no: 'Без тварин', yes: 'З твариною' },
  return_type: {
    round_trip: '↩ Туди й назад',
    one_way: '➡️ В один бік',
    undecided: 'Ще не знаю',
  },
  budget_type: { limit: '💰 Чіткий ліміт', flexible: 'Гнучкий', no_limit: 'Без ліміту' },
  lodging_needed: { yes: 'Потрібне житло', no: 'Житло є', undecided: 'Ще не знаю' },
  ticket_status: { booked: 'Квитки є', not_booked: 'Шукаю', undecided: 'Ще не знаю' },
  mode: MODE_LABELS,
  international: { так: 'Так', ні: 'Ні' },
};
/** @type {Record<string,string>} */
const FIELD_CODES = {
  destination_choice: 'dst',
  origin_choice: 'org',
  return_meaning: 'ret',
  transport_count: 'tc',
  destination_count: 'dc',
  departure_window: 'dw',
};
/** @param {string} field */
export const tripCallbackField = (field) => FIELD_CODES[field] ?? field;
/** @param {string} code */
export const tripAnswerField = (code) =>
  Object.keys(FIELD_CODES).find((field) => FIELD_CODES[field] === code) ?? code;
/** @type {Record<string,string>} */
export const TRIP_EDIT_FIELDS = {
  eto: 'to',
  edate: 'date_from',
  ereturn: 'date_to',
  epeople: 'participants',
  emode: 'mode',
  ebudget: 'budget_type',
  estay: 'lodging_needed',
  ewishes: 'constraints',
};
/** @type {Record<string,string>} */
export const TRIP_FIELD_LABELS = {
  to: 'Місто',
  from_city: 'Звідки',
  date_from: 'Виїзд',
  date_to: 'Повернення',
  return_meaning: 'Що означає повернення',
  mode: 'Транспорт',
  participants: 'Учасники',
  transport_count: 'Разом у дорозі',
  destination_count: 'На місці',
  return_count: 'Назад',
  lodging_count: 'Для житла',
  lodging_from: 'Заселення',
  lodging_to: 'Виїзд із житла',
  country: 'Країна',
  timezone: 'Час на місці',
  departure_timezone: 'Час старту',
  purpose: 'Мета',
  departure_window: 'Коли виїхати',
  ticket_status: 'Квитки',
  budget_type: 'Бюджет',
  budget_total: 'Ліміт',
  budget_currency: 'Валюта',
  budget_scope: 'На кого бюджет',
  lodging_needed: 'Житло',
  lodging_layout: 'Розміщення',
  lodging_preference: 'Побажання до житла',
  constraints: 'Обмеження',
  interests: 'Інтереси',
  support_level: 'Супровід',
  return_type: 'Дорога назад',
};
/** @param {any} result */
export function tripBriefSummary(result) {
  const lines = Object.entries(result.answers ?? {})
    .filter(([key]) => TRIP_FIELD_LABELS[key])
    .map(
      ([key, value]) =>
        `${TRIP_FIELD_LABELS[key]}: ${LABELS[key]?.[String(value)] ?? value}${result.answers._inferred?.[key] ? ' (за складом групи; можна змінити)' : ''}`,
    );
  return `🧳 ${result.answers?.to ?? 'Поїздка'}\n${lines.join('\n')}`.slice(0, 3000);
}
/** @param {any} result */
export function tripBriefEditCard(result) {
  const options = Object.entries(TRIP_EDIT_FIELDS).map(([code, field]) => ({
    text: TRIP_FIELD_LABELS[field] ?? field,
    callback_data: `m:tb:${result.draft_id}:${code}:0:${tripChoiceFingerprint(result)}`,
  }));
  const buttons = [];
  for (let i = 0; i < options.length; i += 2) buttons.push(options.slice(i, i + 2));
  buttons.push([
    {
      text: 'До питання',
      callback_data: `m:tb:${result.draft_id}:resume:0:${tripChoiceFingerprint(result)}`,
    },
  ]);
  return { text: tripBriefSummary(result), buttons };
}

/** Version the displayed choices so changing facts cannot turn an old vehicle
 * index into a different car. This is a stale-card checksum, not authorization.
 * @param {any} result */
export function tripChoiceFingerprint(result) {
  const question = result?.ask?.[0];
  const source = JSON.stringify([
    question?.field,
    question?.options ?? [],
    question?.labels ?? [],
    result?.revision ?? 0,
    result?.known?.vehicles ?? [],
  ]);
  let hash = 2166136261;
  for (let i = 0; i < source.length; i += 1)
    hash = Math.imul(hash ^ source.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16).padStart(8, '0').slice(0, 5);
}

/** @param {any} result */
export function tripBriefChoices(result) {
  const question = result?.ask?.[0];
  if (!result?.draft_id || !question || !/^[0-9a-f-]{36}$/i.test(result.draft_id)) return [];
  /** @type {string[]} */
  const options = Array.isArray(question.options) ? question.options.slice(0, 8) : [];
  const vehicleNames = new Map(
    (result.known?.vehicles ?? []).map((/** @type {{key:string,name:string}} */ vehicle) => [
      vehicle.key,
      vehicle.name,
    ]),
  );
  return options.map((option, index) => ({
    field: question.field,
    value:
      question.field === 'international'
        ? index === 0
        : [
              'lodging_count',
              'transport_count',
              'destination_count',
              'return_count',
              'lodging_rooms',
            ].includes(question.field) && option !== 'other'
          ? Number(option)
          : option,
    label:
      question.field === 'vehicle_key'
        ? String(option === 'other' ? 'Інше авто' : (vehicleNames.get(option) ?? option)).slice(
            0,
            40,
          )
        : String(question.labels?.[index] ?? LABELS[question.field]?.[option] ?? option).slice(
            0,
            40,
          ),
    callback_data: `m:tb:${result.draft_id}:${tripCallbackField(question.field)}:${index}:${tripChoiceFingerprint(result)}`,
  }));
}

/** @param {any} result */
export function tripBriefCard(result) {
  if (!result?.draft_id) return null;
  const question = result?.ask?.[0];
  if (!question) return null;
  const choices = tripBriefChoices(result);
  /** @type {{text:string,callback_data:string}[][]} */
  const buttons = [];
  for (let index = 0; index < choices.length; index += 2) {
    buttons.push(
      choices.slice(index, index + 2).map((choice) => ({
        text: choice.label,
        callback_data: choice.callback_data,
      })),
    );
  }
  if (question.optional && result.draft_id) {
    buttons.push([
      {
        text: '⏭ Це пізніше',
        callback_data: `m:tb:${result.draft_id}:skip:0:${tripChoiceFingerprint(result)}`,
      },
    ]);
  }
  if (result.draft_id) {
    const view = {
      text: '📋 Зібрані дані',
      callback_data: `m:tb:${result.draft_id}:view:0:${tripChoiceFingerprint(result)}`,
    };
    if (question.optional) buttons[buttons.length - 1]?.push(view);
    else buttons.push([view]);
    if (result.answers?._meta?.history?.length) {
      const back = {
        text: 'Назад',
        callback_data: `m:tb:${result.draft_id}:back:0:${tripChoiceFingerprint(result)}`,
      };
      const row = buttons[buttons.length - 1];
      if (row && row.length < 2) row.push(back);
    }
  }
  return { text: `🧳 ${question.question}`, buttons };
}
