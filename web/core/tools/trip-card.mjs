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

/** Version the displayed choices so changing facts cannot turn an old vehicle
 * index into a different car. This is a stale-card checksum, not authorization.
 * @param {any} result */
export function tripChoiceFingerprint(result) {
  const question = result?.ask?.[0];
  const source = JSON.stringify([
    question?.field,
    question?.options ?? [],
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
    value: question.field === 'international' ? index === 0 : option,
    label:
      question.field === 'vehicle_key'
        ? String(option === 'other' ? 'Інше авто' : (vehicleNames.get(option) ?? option)).slice(
            0,
            40,
          )
        : String(LABELS[question.field]?.[option] ?? option).slice(0, 40),
    callback_data: `m:tb:${result.draft_id}:${question.field}:${index}:${tripChoiceFingerprint(result)}`,
  }));
}

/** @param {any} result */
export function tripBriefCard(result) {
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
        text: '⏭ Досить уточнень',
        callback_data: `m:tb:${result.draft_id}:skip:0:${tripChoiceFingerprint(result)}`,
      },
    ]);
  }
  if (!buttons.length) return null;
  return { text: `🧳 ${question.question}`, buttons };
}
