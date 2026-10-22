// One vocabulary for the server, Mini App and assistant. Labels are category-specific;
// codes describe the signal, never an inferred taste of the owner's partner.
/** @type {Record<string, (string|null)[][]>} */
const vocabulary = {
  event: [
    ['topic', 'Тематика', 'Не цікавить тема', 'topic'],
    ['format', 'Формат', 'Не підходить формат', 'format'],
    ['program', 'Програма', 'Не цікава програма', 'topic'],
    ['atmosphere', 'Атмосфера', 'Ціна', null],
    ['venue', 'Місце проведення', 'Незручне місце', 'place'],
    ['novelty', 'Незвичний досвід', 'Незручна дата / час', null],
    ['together', 'Участь удвох', 'Не для цього виходу', null],
    ['this-option', 'Саме ця подія', 'Не хочу саме цю подію', null],
  ],
  food: [
    ['cuisine', 'Кухня / меню', 'Не цікавить кухня', 'cuisine'],
    ['atmosphere', 'Атмосфера', 'Не моя атмосфера', null],
    ['design', 'Інтер’єр / вид', 'Не підходить формат', null],
    ['coffee', 'Кава / десерти', 'Ціна', 'format'],
    ['novelty', 'Хочеться нового', 'Уже знайомий варіант', null],
    ['location', 'Зручне розташування', 'Незручне розташування', null],
    ['together', 'Для побачення', 'Не для цього виходу', null],
    ['this-option', 'Особливість закладу', 'Не хочу саме цей заклад', null],
  ],
  place: [
    ['topic', 'Тема / експозиція', 'Не цікавить тема', 'topic'],
    ['learning', 'Дізнатися нове', 'Не підходить формат', null],
    ['experience', 'Незвичний досвід', 'Уже були', null],
    ['architecture', 'Архітектура / простір', 'Незручне розташування', null],
    ['interactive', 'Інтерактивність', 'Незручні години', null],
    ['quiet', 'Спокійний формат', 'Ціна', null],
    ['together', 'Провести час разом', 'Не для цього виходу', null],
    ['novelty', 'Хочу вперше', 'Не хочу саме це місце', null],
  ],
  trip: [
    ['landscape', 'Краєвид', 'Далеко', null],
    ['nature', 'Природа / відпочинок', 'Складно дістатися', null],
    ['activity', 'Прогулянка / активність', 'Не підходить активність', 'format'],
    ['novelty', 'Нове місце', 'Завелика тривалість', null],
    ['heritage', 'Історія / архітектура', 'Залежить від погоди', null],
    ['photos', 'Для фото', 'Уже були', null],
    ['together', 'Спільний досвід', 'Додаткові витрати', null],
    ['location', 'Маршрут / локація', 'Не хочу саме це місце', null],
  ],
  cinema: [
    ['plot', 'Сюжет / тема', 'Не цікавить сюжет', 'topic'],
    ['genre', 'Жанр', 'Не подобається жанр', 'genre'],
    ['cast', 'Актори', 'Актори / режисер', null],
    ['director', 'Режисер', 'Не мій всесвіт', null],
    ['universe', 'Франшиза / всесвіт', 'Уже дивився', 'interest'],
    ['visual', 'Візуальний стиль', 'Завелика тривалість', null],
    ['premiere', 'Хочеться новинки', 'Не підходять сеанси / мова', null],
    ['together', 'Для спільного перегляду', 'Не хочу саме цей фільм', null],
  ],
  concert: [
    ['artist', 'Виконавець', 'Не цікавить виконавець', 'topic'],
    ['genre', 'Музичний напрям', 'Не мій музичний напрям', 'genre'],
    ['live', 'Живий звук', 'Формат / гучність', 'format'],
    ['program', 'Програма', 'Не підходить майданчик', 'topic'],
    ['atmosphere', 'Атмосфера', 'Ціна', null],
    ['venue', 'Майданчик', 'Незручна дата / час', 'place'],
    ['novelty', 'Відкрити нового виконавця', 'Не для цього виходу', null],
    ['together', 'Спільний вечір', 'Не хочу саме цей концерт', null],
  ],
  festival: [
    ['topic', 'Тематика', 'Не цікавить тематика', 'topic'],
    ['artists', 'Учасники', 'Не цікавлять учасники', 'topic'],
    ['program', 'Програма', 'Натовп / шум', null],
    ['atmosphere', 'Атмосфера', 'Ціна', null],
    ['market', 'Їжа / маркет', 'Незручне місце', null],
    ['workshops', 'Майстер-класи', 'Незручна дата', null],
    ['outdoor', 'Просто неба', 'Завелика тривалість', null],
    ['together', 'Провести разом багато часу', 'Не хочу саме цей фестиваль', null],
  ],
  show: [
    ['genre', 'Жанр', 'Не цікавить жанр', 'genre'],
    ['topic', 'Сюжет / тема', 'Не підходить тема / гумор', 'topic'],
    ['cast', 'Актори / комік', 'Не цікавлять учасники', 'topic'],
    ['direction', 'Режисура', 'Не підходить формат', 'format'],
    ['format', 'Формат виступу', 'Ціна', 'format'],
    ['atmosphere', 'Атмосфера', 'Незручний майданчик', null],
    ['novelty', 'Новий досвід', 'Незручна дата / час', null],
    ['together', 'Спільний вечір', 'Не хочу саме цей виступ', null],
  ],
  exhibition: [
    ['topic', 'Тема', 'Не цікавить тема', 'topic'],
    ['artist', 'Автор / митці', 'Не мій напрям мистецтва', 'topic'],
    ['style', 'Напрям мистецтва', 'Не цікавлять автор / роботи', 'format'],
    ['works', 'Конкретні роботи', 'Не підходить формат', null],
    ['space', 'Простір', 'Уже бачив', null],
    ['interactive', 'Інтерактивність', 'Не підходять години / дати', null],
    ['novelty', 'Нові враження', 'Ціна / локація', null],
    ['together', 'Спокійне побачення', 'Не хочу саме цю виставку', null],
  ],
  meetup: [
    ['topic', 'Тема', 'Не цікавить тема', 'topic'],
    ['speaker', 'Спікер', 'Не цікавить спікер', 'topic'],
    ['skill', 'Практична навичка', 'Не підходить рівень', null],
    ['discussion', 'Обговорення', 'Не підходить формат', 'format'],
    ['people', 'Нові знайомства', 'Не підходить аудиторія', 'audience'],
    ['together', 'Спільна участь', 'Ціна', null],
    ['novelty', 'Незвичний формат', 'Незручна дата / час', null],
    ['learning', 'Особистий інтерес', 'Не хочу саме цю зустріч', null],
  ],
  podcast: [
    ['topic', 'Тема', 'Не цікавить тема', 'topic'],
    ['host', 'Ведучий', 'Не цікавить ведучий', 'topic'],
    ['guest', 'Гість', 'Не цікавить гість', 'topic'],
    ['depth', 'Глибина розмови', 'Не підходить стиль розмови', null],
    ['humor', 'Гумор', 'Тривалість', null],
    ['format', 'Формат / тривалість', 'Мова / якість запису', 'format'],
    ['series', 'Знайома серія', 'Уже слухав', null],
    ['novelty', 'Новий погляд', 'Не хочу саме цей випуск', null],
  ],
};
// Negative choices have their own meaning: a positive slot's code must never
// accidentally teach a dislike (e.g. price under "atmosphere").
/** @type {Record<string, string[]>} */
const negativeCodes = {
  event: ['topic', 'format', 'program', 'price', 'location', 'time', 'company', 'this-option'],
  food: ['cuisine', 'atmosphere', 'format', 'price', 'seen', 'location', 'company', 'this-option'],
  place: ['topic', 'format', 'seen', 'location', 'time', 'price', 'company', 'this-option'],
  trip: [
    'distance',
    'transport',
    'activity',
    'duration',
    'weather',
    'seen',
    'price',
    'this-option',
  ],
  cinema: ['plot', 'genre', 'cast', 'universe', 'seen', 'duration', 'time', 'this-option'],
  concert: ['artist', 'genre', 'format', 'place', 'price', 'time', 'company', 'this-option'],
  festival: ['topic', 'artists', 'crowd', 'price', 'location', 'time', 'duration', 'this-option'],
  show: ['genre', 'topic', 'cast', 'format', 'price', 'place', 'time', 'this-option'],
  exhibition: ['topic', 'style', 'artist', 'format', 'seen', 'time', 'price', 'this-option'],
  meetup: ['topic', 'speaker', 'level', 'format', 'audience', 'price', 'time', 'this-option'],
  podcast: ['topic', 'host', 'guest', 'format', 'duration', 'language', 'seen', 'this-option'],
};
const neutralCodes = new Set([
  'time',
  'not-now',
  'company',
  'seen',
  'this-option',
  'price',
  'location',
  'distance',
  'transport',
  'duration',
  'weather',
  'crowd',
  'level',
  'language',
]);
const legacy = new Set([
  'genre',
  'format',
  'topic',
  'audience',
  'place',
  'price',
  'time',
  'not-now',
  'this-option',
  'company',
  'seen',
  'other',
]);
/** @param {string} category @param {boolean} [positive] */
export function leisureFeedbackChoices(category, positive = false) {
  const rows = vocabulary[category] ?? vocabulary.place ?? [];
  return [
    ...rows.map((row, index) => ({
      code: positive ? String(row[0]) : (negativeCodes[category]?.[index] ?? String(row[0])),
      label: String(row[positive ? 1 : 2]),
      scope: positive
        ? positiveScope(String(row[0]))
        : negativeScope(negativeCodes[category]?.[index] ?? String(row[0])),
    })),
    { code: 'other', label: 'Інша причина', scope: null },
  ];
}
/** @param {string} code */
function positiveScope(code) {
  if (['genre', 'format', 'cuisine', 'topic'].includes(code)) return code;
  if (
    [
      'plot',
      'artist',
      'artists',
      'cast',
      'director',
      'speaker',
      'host',
      'guest',
      'program',
      'works',
    ].includes(code)
  )
    return 'topic';
  if (['universe', 'series'].includes(code)) return 'interest';
  if (['activity', 'style', 'coffee'].includes(code)) return 'format';
  if (['venue', 'architecture', 'space'].includes(code)) return 'place';
  return null;
}
/** @param {string} code */
function negativeScope(code) {
  if (neutralCodes.has(code) || code === 'other') return null;
  if (['genre', 'format', 'topic', 'audience', 'place', 'cuisine'].includes(code)) return code;
  if (['plot', 'artist', 'artists', 'cast', 'speaker', 'host', 'guest'].includes(code))
    return 'topic';
  if (code === 'universe') return 'interest';
  if (code === 'activity' || code === 'style') return 'format';
  return null;
}
/** @param {any} item @param {any} payload @param {any} current @param {number} nowMs */
export function normalizeLeisureFeedback(item, payload, current, nowMs) {
  const positive = payload.verdict === 'interested';
  const choices = leisureFeedbackChoices(item.category, positive);
  const codes =
    payload.reasonCodes ??
    (payload.reasonCode
      ? [payload.reasonCode]
      : current?.verdict === payload.verdict
        ? (current.reasonCodes ?? (current.reasonCode ? [current.reasonCode] : []))
        : []);
  if (
    !Array.isArray(codes) ||
    codes.length > 3 ||
    codes.some(
      (c) =>
        typeof c !== 'string' ||
        (!choices.some((x) => x.code === c) &&
          !(payload.verdict === 'later' && ['time', 'not-now', 'company'].includes(c)) &&
          !(payload.reasonCodes == null && legacy.has(c))),
    )
  )
    throw new Error('Обери до трьох причин, які підходять до цієї категорії.');
  // Preserve clients predating category-specific reasons, except impossible movie genres on places.
  if (
    codes.includes('genre') &&
    ['food', 'trip', 'place', 'meetup', 'podcast'].includes(item.category)
  )
    throw new Error('Ця причина не підходить до категорії.');
  const interestLevel = positive
    ? (payload.interestLevel ?? current?.interestLevel ?? 'interested')
    : null;
  if (positive && !['priority', 'interested'].includes(interestLevel))
    throw new Error('Обери рівень інтересу.');
  let snoozeUntil = null;
  if (payload.verdict === 'later' && payload.snoozeUntil) {
    const end = Date.parse(payload.snoozeUntil);
    if (!Number.isFinite(end) || end <= nowMs) throw new Error('Обери майбутню дату повернення.');
    snoozeUntil = new Date(end).toISOString();
  }
  return {
    interestLevel,
    reasonCodes: [...new Set(codes)],
    reasonCode: codes[0] ?? null,
    reason:
      payload.reason == null && current?.verdict === payload.verdict
        ? (current.reason ?? '')
        : String(payload.reason ?? '').slice(0, 300),
    revisit: positive && (payload.revisit ?? current?.revisit) === true,
    snoozeUntil,
  };
}
/** Only explicit, applicable dimensions can generalize to other candidates.
 * @param {any} record @returns {string[]|null} */
export function leisureFeedbackScopes(record) {
  if (!record.reasonCodes?.length)
    return record.verdict === 'interested'
      ? null
      : record.reasonCode
        ? [negativeScope(record.reasonCode)].filter((x) => typeof x === 'string')
        : null;
  const choices = leisureFeedbackChoices(record.category, record.verdict === 'interested');
  return [
    ...new Set(
      /** @type {string[]} */ (record.reasonCodes)
        .map((code) => choices.find((c) => c.code === code)?.scope)
        .filter((x) => typeof x === 'string'),
    ),
  ];
}
/** One owner-choice snapshot for undo; independent of a later category correction.
 * @param {any} record */
export function leisureReactionSnapshot(record) {
  return {
    verdict: record?.verdict ?? 'clear',
    interestLevel: record?.interestLevel ?? null,
    reasonCodes: record?.reasonCodes ?? [],
    reasonCode: record?.reasonCode ?? null,
    reason: record?.reason ?? '',
    revisit: record?.revisit ?? false,
    snoozeUntil: record?.snoozeUntil ?? null,
  };
}
