// Explicit owner feedback only. Ranking is local, explainable and never an LLM call.
import { leisureFeedbackScopes } from './feedback.mjs';
export const FEEDBACK_REASONS = [
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
];
const GENRES = {
  action: /бойовик|екшн|action/i,
  thriller: /трилер|thriller/i,
  comedy: /комеді|comedy/i,
  drama: /драм|drama/i,
  scifi: /фантаст|sci.?fi|science fiction/i,
  fantasy: /фентез|fantasy/i,
  horror: /жах|horror/i,
  animation: /анімац|мульт|animation/i,
  documentary: /документ|documentary/i,
  romance: /романт|мелодрам|romance/i,
  adventure: /пригод|adventure/i,
  crime: /кримін|детектив|crime|mystery/i,
  history: /історич|historical/i,
  musical: /мюзикл|musical/i,
};
/** @type {Record<string,string>} */
export const FEATURE_LABELS = {
  action: 'бойовик',
  thriller: 'трилер',
  comedy: 'комедія',
  drama: 'драма',
  scifi: 'фантастика',
  fantasy: 'фентезі',
  horror: 'жахи',
  animation: 'анімація',
  documentary: 'документальне',
  romance: 'романтика',
  adventure: 'пригоди',
  crime: 'детектив / кримінал',
  history: 'історичне',
  musical: 'мюзикл',
  standup: 'стендап',
  jazz: 'джаз',
  classical: 'класична музика',
  theatre: 'театр',
  children: 'дитяча аудиторія',
  cafe: 'кав’ярня',
  restaurant: 'ресторан',
  bakery: 'пекарня',
  bar: 'бар',
  marvel: 'Marvel',
  dc: 'DC',
  starwars: 'Зоряні війни',
  pixar: 'Pixar',
  cinema: 'кіно',
  food: 'заклади',
  exhibition: 'виставки',
  concert: 'концерти',
  festival: 'фестивалі',
  show: 'шоу й театр',
  trip: 'поїздки',
  place: 'місця й музеї',
  meetup: 'зустрічі',
  podcast: 'подкасти',
  italian: 'італійська кухня',
  japanese: 'японська кухня',
  chinese: 'китайська кухня',
  ukrainian: 'українська кухня',
  georgian: 'грузинська кухня',
  vegetarian: 'вегетаріанське меню',
  vegan: 'веганське меню',
  pizza: 'піца',
  seafood: 'морепродукти',
};
const INTERESTS = {
  marvel: /marvel|марвел|людин[аи]-?павук|spider.?man|месник|avengers|залізн[аи]й? люд|iron man/iu,
  dc: /(?:^|\W)dc(?:\W|$)|бетмен|batman|супермен|superman/iu,
  starwars: /зоряні війни|star wars/iu,
  pixar: /pixar|піксар/iu,
};
/** Explicit phrases in a review, never an inferred partner preference. @param {string} note */
export function explicitLeisureInterests(note) {
  const result = new Map();
  for (const sentence of String(note ?? '').split(/[.!?;,\n]+|\s+(?:але|проте|однак)\s+/iu)) {
    if (/дівчин|кохан|партнер/iu.test(sentence) && !/(?:^|\s)(?:мені|я)(?:\s|$)/iu.test(sentence))
      continue;
    const negative = /не\s+(?:люблю|подоба|цікав)|ненавиджу/iu.test(sentence);
    const positive = !negative && /люблю|обожнюю|подоба[єл]|улюблен/iu.test(sentence);
    if (!positive && !negative) continue;
    for (const [id, expression] of Object.entries(INTERESTS))
      if (expression.test(sentence)) result.set(`interest:${id}`, positive ? 1 : -1);
  }
  return [...result].map(([feature, direction]) => ({ feature, direction }));
}
/** Tags describe explicit source words, not a guessed personality or partner preference. @param {any} item */
export function leisureFeatures(item) {
  const features = [`category:${item.category}`];
  for (const [key, re] of Object.entries(GENRES))
    if (re.test(item.genre ?? '')) features.push(`genre:${key}`);
  const text = `${item.title ?? ''} ${item.genre ?? ''}`;
  for (const [id, expression] of Object.entries(INTERESTS))
    if (expression.test(`${text} ${item.summary ?? ''}`)) features.push(`interest:${id}`);
  for (const [key, re] of Object.entries({
    standup: /стендап|stand.?up/i,
    jazz: /джаз|jazz/i,
    classical: /класичн|симфонічн/i,
    theatre: /театр|вистава/i,
  }))
    if (re.test(text)) features.push(`format:${key}`);
  if (/для дітей|дитяч(?:ий|а|і)|для малюків/i.test(text)) features.push('audience:children');
  const type = String(item.placeType ?? '');
  for (const cuisine of [
    'italian',
    'japanese',
    'chinese',
    'ukrainian',
    'georgian',
    'vegetarian',
    'vegan',
    'pizza',
    'seafood',
  ])
    if (type.includes(cuisine)) features.push('cuisine:' + cuisine);
  if (/cafe|coffee/.test(type)) features.push('format:cafe');
  else if (/bakery/.test(type)) features.push('format:bakery');
  else if (/bar|pub/.test(type)) features.push('format:bar');
  else if (/restaurant/.test(type)) features.push('format:restaurant');
  if (item.venueId) features.push(`place:${item.venueId}`);
  // Topics are exact title words; a dislike of an artist cannot reject every concert.
  const stop = new Set([
    'львів',
    'львові',
    'концерт',
    'виставка',
    'фестиваль',
    'подія',
    'планета',
    'кіно',
    'україна',
    'україни',
    'новий',
    'нова',
    'вистава',
    'ресторан',
    'кавярня',
  ]);
  for (const word of String(item.title ?? '')
    .toLocaleLowerCase('uk')
    .match(/[\p{L}\p{N}]{4,}/gu) ?? [])
    if (!stop.has(word)) features.push(`topic:${word}`);
  return [...new Set(features)];
}
/** Small content-based profile with a neutral prior. Records remain the source
 * of truth; archived signals contain features, not expired event descriptions.
 * @param {any[]} items @param {any[]} records @param {number} nowMs */
export function leisurePreferenceProfile(items, records, nowMs) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const archived = records.find((r) => r.kind === 'profile');
  const archivedAt = Date.parse(archived?.at ?? '');
  const archiveDecay = Number.isFinite(archivedAt)
    ? Math.pow(0.5, Math.max(0, nowMs - archivedAt) / (180 * 86400000))
    : 1;
  /** @type {Map<string,{positive:number,negative:number}>} */
  const weights = new Map(
    Object.entries(archived?.weights ?? {}).map(([key, value]) => [
      key,
      {
        positive: Number(/** @type {any} */ (value).positive ?? 0) * archiveDecay,
        negative: Number(/** @type {any} */ (value).negative ?? 0) * archiveDecay,
      },
    ]),
  );
  let signals = archived?.signals ?? 0;
  const visited = new Set();
  const add = (
    /** @type {string} */ tag,
    /** @type {number} */ direction,
    /** @type {number} */ amount,
  ) => {
    const row = weights.get(tag) ?? { positive: 0, negative: 0 };
    if (direction > 0) row.positive += amount;
    else row.negative += amount;
    weights.set(tag, row);
  };
  for (const record of records) {
    // These choices describe this occasion/card, never a dislike of its genre.
    if (
      record.kind === 'reaction' &&
      record.verdict !== 'interested' &&
      !record.reasonCodes?.length &&
      ['time', 'not-now', 'this-option', 'company', 'seen'].includes(record.reasonCode)
    )
      continue;
    const reaction =
      record.kind === 'reaction' && ['interested', 'uninterested'].includes(record.verdict);
    const visit = record.kind === 'visit' && ['liked', 'disliked'].includes(record.rating);
    if (!reaction && !visit) continue;
    if (visit) {
      const key = `${record.itemId}|${record.visitedOn ?? 'unknown'}|${record.rating}`;
      if (visited.has(key)) continue;
      visited.add(key);
    }
    signals++;
    const tags =
      record.features ?? (byId.has(record.itemId) ? leisureFeatures(byId.get(record.itemId)) : []);
    const positive = reaction ? record.verdict === 'interested' : record.rating === 'liked';
    const scopes = reaction ? leisureFeedbackScopes(record) : null;
    const applicable = positive
      ? tags.filter((/** @type {string} */ tag) =>
          scopes !== null
            ? scopes.some((scope) => tag.startsWith(scope + ':'))
            : !tag.startsWith('topic:'),
        )
      : reaction && scopes?.length
        ? tags.filter((/** @type {string} */ tag) =>
            scopes.some((scope) => tag.startsWith(scope + ':')),
          )
        : visit
          ? tags.filter((/** @type {string} */ tag) =>
              tag.startsWith(record.category === 'cinema' ? 'genre:' : 'place:'),
            )
          : [];
    const at = Date.parse(record.at ?? record.updatedAt ?? '');
    const recency = Number.isFinite(at)
      ? Math.pow(0.5, Math.max(0, nowMs - at) / (180 * 86400000))
      : 1;
    for (const tag of applicable)
      add(
        tag,
        positive ? 1 : -1,
        ((tag.startsWith('category:') ? 0.15 : visit ? 2 : 1) * recency) /
          Math.max(1, applicable.length),
      );
    for (const interest of explicitLeisureInterests(record.reason))
      add(interest.feature, interest.direction, 3 * recency);
  }
  return {
    signals,
    weights: Object.fromEntries(weights),
    interests: [...weights]
      .map(([feature, row]) => ({
        feature,
        label: FEATURE_LABELS[feature.split(':')[1] ?? ''] ?? feature.split(':').at(-1) ?? feature,
        score: (8 * (row.positive - row.negative)) / (3 + row.positive + row.negative),
        samples: row.positive + row.negative,
      }))
      .filter((x) => !x.feature.startsWith('topic:') && !x.feature.startsWith('place:'))
      .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
      .slice(0, 16),
  };
}
/** @param {any[]} records */
export function leisurePlaceIndex(records) {
  const index = new Map();
  const get = (/** @type {string} */ key) => {
    if (!index.has(key))
      index.set(key, {
        familiar: false,
        frequent: false,
        previousCount: null,
        trackedCount: 0,
        legacyCount: 0,
        since: null,
      });
    return index.get(key);
  };
  for (const record of records) {
    if (!['visit', 'familiarity'].includes(record.kind)) continue;
    const row = get(record.venueId ? `venue:${record.venueId}` : `item:${record.itemId}`);
    if (record.kind === 'visit') {
      row.familiar = true;
      if (record.legacy || !record.visitedOn) row.legacyCount++;
      else row.trackedCount++;
    }
    if (record.kind === 'familiarity' && !record.cleared && record.mode !== 'clear')
      Object.assign(row, {
        familiar: true,
        frequent: record.mode === 'many',
        previousCount: record.mode === 'count' ? record.previousCount : null,
        since: record.trackingSince ?? null,
      });
  }
  return index;
}
/** @param {any} item @param {any[]} records @param {Map<string,any>} [index] */
export function knownLeisurePlace(item, records, index = leisurePlaceIndex(records)) {
  return (
    index.get(item.venueId ? `venue:${item.venueId}` : `item:${item.id}`) ?? {
      familiar: false,
      frequent: false,
      previousCount: null,
      trackedCount: 0,
      legacyCount: 0,
      since: null,
    }
  );
}
/** The whole verified collection stays browseable; scores change its order. @param {any[]} items @param {any[]} records @param {string[]} previousIds @param {any} settings @param {number} nowMs */
export function rankLeisureItems(items, records, previousIds, settings, nowMs) {
  void settings;
  const byId = new Map(items.map((i) => [i.id, i]));
  const knownIndex = leisurePlaceIndex(records);
  const profile = leisurePreferenceProfile(items, records, nowMs);
  const weights = new Map(
    Object.entries(profile.weights).map(([key, row]) => [
      key,
      (8 * (row.positive - row.negative)) / (3 + row.positive + row.negative),
    ]),
  );
  const feedback = records.filter(
    (r) => r.kind === 'reaction' && ['interested', 'uninterested'].includes(r.verdict),
  );
  const previous = new Set(previousIds);
  const planned = new Set(
    records
      .filter((r) => r.kind === 'plan' && r.status === 'planned')
      .flatMap((r) => r.stops?.map((/** @type {any} */ stop) => stop.itemId) ?? []),
  );
  const visited = new Set(records.filter((r) => r.kind === 'visit').map((r) => r.itemId));
  const ranked = items
    .map((item) => {
      const tags = leisureFeatures(item),
        reasons = [];
      let score =
        10 +
        (item.address ? 2 : 0) +
        (item.startAt || item.sessions?.length ? 2 : 0) +
        (item.price?.min != null ? 1 : 0);
      if (item.media?.length) score += 1;
      if (item.schedule?.precision === 'exact') score += 2;
      if (item.schedule?.precision === 'conflicting') {
        score -= 12;
        reasons.push('Розклад у джерелі суперечливий — потрібне уточнення');
      }
      if (item.schedule?.kind === 'on-request')
        reasons.push('Потрібне попереднє узгодження з організатором');
      const exact = feedback.find((r) => r.itemId === item.id);
      if (exact?.verdict === 'interested') {
        score +=
          planned.has(item.id) || visited.has(item.id)
            ? 3
            : exact.interestLevel === 'priority'
              ? 32
              : 20;
        reasons.push(
          exact.interestLevel === 'priority'
            ? 'Ти хочеш відвідати це насамперед'
            : 'Ти позначив цей варіант як цікавий',
        );
      }
      let evidence = 0;
      for (const tag of tags) {
        const cap = tag.startsWith('category:') ? 1.5 : tag.startsWith('format:') ? 3 : 8;
        const weight = Math.max(-cap, Math.min(cap, weights.get(tag) ?? 0));
        score += weight;
        evidence += Math.abs(weight);
        if (weight > 0.2 && !tag.startsWith('category:') && !tag.startsWith('topic:')) {
          const label = FEATURE_LABELS[tag.split(':')[1] ?? ''];
          if (label) reasons.push(`Твої позитивні оцінки: ${label}`);
        }
      }
      if (!previous.has(item.id)) {
        score += 2;
        reasons.push('Новий варіант у каталозі');
      }
      if (previous.has(item.id)) score -= 2;
      if (planned.has(item.id)) {
        score -= 6;
        reasons.push('Уже є у твоєму плані');
      }
      const known = knownLeisurePlace(item, records, knownIndex);
      if (known.familiar)
        reasons.push(
          known.frequent ? 'Твоє знайоме місце · бували багато разів' : 'Ви вже бували тут',
        );
      if (
        item.category === 'cinema' &&
        item.sessions?.some((/** @type {any} */ s) => Date.parse(s.startAt) > nowMs)
      )
        reasons.push('Є майбутні підтверджені сеанси');
      if (item.category !== 'cinema' && item.startDate) reasons.push('Опубліковані дати події');
      if (!evidence && !exact)
        reasons.push('Профіль ще навчається; порядок враховує повноту даних');
      return {
        id: item.id,
        score: Math.round(score * 10) / 10,
        reasons: [...new Set(reasons)].slice(0, 3),
        known,
      };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        String(byId.get(a.id)?.startAt ?? byId.get(a.id)?.startDate ?? '').localeCompare(
          String(byId.get(b.id)?.startAt ?? byId.get(b.id)?.startDate ?? ''),
        ) ||
        a.id.localeCompare(b.id),
    );
  // Every sixth slot can explore an underrepresented category. It remains
  // deterministic for the current catalog and never hides the full selection.
  for (let slot = 5; slot < ranked.length; slot += 6) {
    const recentCategories = ranked.slice(slot - 3, slot).map((r) => byId.get(r.id)?.category);
    const next = ranked.findIndex(
      (r, index) =>
        index > slot &&
        r.score >= (ranked[slot]?.score ?? r.score) - 6 &&
        !leisureFeatures(byId.get(r.id)).some((tag) => (weights.get(tag) ?? 0) < -2) &&
        !recentCategories.includes(byId.get(r.id)?.category),
    );
    if (next >= 0 && ranked[next]) {
      const [candidate] = ranked.splice(next, 1);
      if (!candidate) continue;
      candidate.reasons = ['Новий напрямок для знайомства', ...candidate.reasons].slice(0, 3);
      ranked.splice(slot, 0, candidate);
    }
  }
  return ranked;
}
