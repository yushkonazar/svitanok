/** Publisher semantics, not the name of a ticket site or venue. */
export const LEISURE_EVENT_CATEGORIES = [
  'concert',
  'show',
  'festival',
  'exhibition',
  'meetup',
  'event',
];
export const LEISURE_EVENT_FORMATS = {
  opera: 'Опера',
  ballet: 'Балет',
  theatre: 'Театр',
  standup: 'Стендап',
  classical: 'Класична музика',
  concert: 'Концерт',
  workshop: 'Майстер-клас',
  lecture: 'Лекція',
  meeting: 'Зустріч',
  festival: 'Фестиваль',
  exhibition: 'Виставка',
  other: 'Інша подія',
};
/** @type {Record<string,string>} */
export const LEISURE_FORMAT_CATEGORIES = {
  opera: 'show',
  ballet: 'show',
  theatre: 'show',
  standup: 'show',
  classical: 'concert',
  concert: 'concert',
  workshop: 'meetup',
  lecture: 'meetup',
  meeting: 'meetup',
  festival: 'festival',
  exhibition: 'exhibition',
  other: 'event',
};

/** @param {any} item */
export function classifyLeisureEvent(item) {
  const title = String(item.title ?? item.name ?? '');
  const detail = `${item.publisherCategory ?? ''} ${item.eventFormat ?? ''} ${item.genre ?? ''}`;
  const summary = String(item.summary ?? item.description ?? '').slice(0, 1200);
  const primary = title + ' ' + detail;
  const match = (/** @type {RegExp} */ expression) => expression.test(primary);
  const result = (
    /** @type {string} */ category,
    /** @type {string} */ eventFormat,
    /** @type {string} */ evidence = 'назва або рубрика видавця',
  ) => ({ category, eventFormat, classificationEvidence: evidence });
  // Creative activities must win over a generic Event/MusicEvent on an aggregator.
  if (
    match(
      /майстер[\s-]?клас|воркшоп|workshop|гончар|керам|ліплен|ліпк[аи]|скетчинг|занятт.*(?:живопис|малюван|декоратив)/iu,
    )
  )
    return result('meetup', 'workshop');
  if (match(/лекці|лекто[рр]ій|тренінг|семінар|lecture|дискусі|презентаці.*(?:книг|видан)/iu))
    return result('meetup', 'lecture');
  if (match(/фестивал|festival|ярмарок/iu)) return result('festival', 'festival');
  if (match(/виставк|exhibition|експозиці/iu)) return result('exhibition', 'exhibition');
  if (match(/стендап|stand.?up/iu)) return result('show', 'standup');
  if (
    match(/балет|ballet/iu) ||
    /балетн\p{L}*\s+(?:істор|вистав|постанов)|(?<!\p{L})балет\s+(?:на|у|в|за|[«"])/iu.test(summary)
  )
    return result('show', 'ballet');
  if (
    match(/(?<!\p{L})опер[аиу](?!\p{L})|оперет|opera\b/iu) ||
    /(?:опера|оперета)\s+(?:на|в|у|за|[«"])/iu.test(summary)
  )
    return result('show', 'opera');
  if (match(/театр|вистав[аи]|перформанс|theat[er]+/iu)) return result('show', 'theatre');
  if (match(/зустріч|читанн|книжковий клуб|розмовний клуб|meetup/iu))
    return result('meetup', 'meeting');
  if (match(/симфон|камерн|органн|класичн|бах\b|моцарт|вівальді|бетховен|chopin|bach\b/iu))
    return result('concert', 'classical');
  if (match(/концерт|джаз|jazz|live music|concert|оркестр|квартет|гурт|вокал|музичн/iu))
    return result('concert', 'concert');
  const type = String(item.structuredType ?? '');
  if (/EducationEvent/.test(type)) return result('meetup', 'lecture', 'структурований тип видавця');
  if (/ExhibitionEvent/.test(type))
    return result('exhibition', 'exhibition', 'структурований тип видавця');
  if (/Festival/.test(type)) return result('festival', 'festival', 'структурований тип видавця');
  if (/TheaterEvent|DanceEvent/.test(type))
    return result(
      'show',
      /DanceEvent/.test(type) ? 'ballet' : 'theatre',
      'структурований тип видавця',
    );
  if (/MusicEvent/.test(type)) return result('concert', 'concert', 'структурований тип видавця');
  if (/майстер[\s-]?клас|гончар|керамічн.*(?:занят|студі)|занятт.*керам/iu.test(summary))
    return result('meetup', 'workshop', 'опис активності видавця');
  // Known source contracts can resolve an otherwise unnamed performance.
  if (item.source === 'Театр Лесі')
    return result('show', 'theatre', 'театральний репертуар видавця');
  if (item.source === 'Львівський скансен · майстер-класи')
    return result('meetup', 'workshop', 'каталог майстер-класів');
  if (['Львівська філармонія', 'Львівський органний зал'].includes(item.source))
    return result('concert', 'classical', 'музичний календар видавця');
  if (item.category === 'show')
    return result('show', 'other', 'жанр постановки потребує уточнення');
  if (item.category === 'festival')
    return result('festival', 'festival', 'опублікований тип події');
  if (item.category === 'exhibition')
    return result('exhibition', 'exhibition', 'опублікований тип події');
  if (item.category === 'meetup') return result('meetup', 'meeting', 'опублікований тип зустрічі');
  return result('event', 'other', 'формат потребує уточнення');
}

/** Repair the view of existing items without changing IDs, decisions or dates.
 * @param {any} item @param {any} [override] */
export function classifiedLeisureItem(item, override) {
  if (!LEISURE_EVENT_CATEGORIES.includes(item.category)) return item;
  const classification = classifyLeisureEvent(item);
  if (
    override &&
    Object.hasOwn(LEISURE_FORMAT_CATEGORIES, override.eventFormat) &&
    LEISURE_FORMAT_CATEGORIES[override.eventFormat] === override.category
  )
    return {
      ...item,
      ...classification,
      category: override.category,
      eventFormat: override.eventFormat,
      classificationEvidence: 'уточнено власником',
    };
  return {
    ...item,
    ...classification,
    classificationEvidence:
      item.category === classification.category &&
      item.eventFormat === classification.eventFormat &&
      item.classificationEvidence
        ? item.classificationEvidence
        : classification.classificationEvidence,
  };
}
