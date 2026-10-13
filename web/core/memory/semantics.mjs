// Storage addresses stay stable: semantic type lives in the versioned value,
// so reclassification uses the existing atomic write-token/ledger operation.
export const MEMORY_TYPES = [
  'fact',
  'preference',
  'routine',
  'aspiration',
  'relationship',
  'resource',
  'event',
  'technical',
];
export const MEMORY_DOMAINS = [
  'general',
  'food',
  'transport',
  'relationships',
  'work',
  'learning',
  'leisure',
  'health',
  'schedule',
  'communication',
  'testing',
];
export const MEMORY_RELATIONS = [
  'none',
  'likes',
  'dislikes',
  'wants',
  'owns',
  'family',
  'work',
  'rented',
  'knows',
  'completed',
];
export const MEMORY_TYPE_LABELS = {
  fact: 'Факт',
  preference: 'Вподобання',
  routine: 'Звичка',
  aspiration: 'Бажання / ціль',
  relationship: 'Стосунки',
  resource: 'Доступний ресурс',
  event: 'Окрема подія',
  technical: 'Технічний запис',
};
const relations = {
  fact: ['none'],
  preference: ['likes', 'dislikes'],
  routine: ['none'],
  aspiration: ['wants'],
  relationship: ['knows'],
  resource: ['owns', 'family', 'work', 'rented'],
  event: ['completed'],
  technical: ['none'],
};
/** @param {unknown} value @returns {value is Record<string, any>} */
export function isMemoryRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = /** @type {Record<string,any>} */ (value);
  return (
    v.schemaVersion === 2 &&
    MEMORY_TYPES.includes(v.type) &&
    MEMORY_DOMAINS.includes(v.domain) &&
    MEMORY_RELATIONS.includes(v.relation) &&
    typeof v.subject === 'string' &&
    !!v.subject.trim()
  );
}
/** @param {unknown} value */
export function assertMemoryRecord(value) {
  if (
    value &&
    typeof value === 'object' &&
    Object.hasOwn(value, 'schemaVersion') &&
    !isMemoryRecord(value)
  )
    throw new Error('Непідтримувана версія запису пам’яті.');
  if (!isMemoryRecord(value)) return;
  const allowed = [
    'schemaVersion',
    'type',
    'domain',
    'subject',
    'relation',
    'details',
    'entityId',
    'properties',
  ];
  if (
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    !MEMORY_TYPES.includes(value.type) ||
    !MEMORY_DOMAINS.includes(value.domain) ||
    !MEMORY_RELATIONS.includes(value.relation) ||
    !(/** @type {Record<string,string[]>} */ (relations)[value.type]?.includes(value.relation))
  )
    throw new Error('Тип і зв’язок запису пам’яті не узгоджені.');
  for (const [key, max] of [
    ['subject', 160],
    ['details', 500],
    ['entityId', 128],
  ]) {
    const field = value[String(key)];
    if (
      (key === 'subject' || field != null) &&
      (typeof field !== 'string' || !field.trim() || field.length > Number(max))
    )
      throw new Error('Вкажи короткий предмет запису й коректні пояснення.');
  }
  if (value.properties != null) {
    const p = value.properties;
    if (
      value.type !== 'resource' ||
      value.domain !== 'transport' ||
      !p ||
      typeof p !== 'object' ||
      Array.isArray(p) ||
      Object.keys(p).some((key) => !['per100', 'fuel'].includes(key)) ||
      (p.per100 != null &&
        (typeof p.per100 !== 'number' ||
          !Number.isFinite(p.per100) ||
          p.per100 <= 0 ||
          p.per100 > 100)) ||
      (p.fuel != null && (typeof p.fuel !== 'string' || !p.fuel.trim() || p.fuel.length > 40))
    )
      throw new Error(
        'Характеристики транспорту мають містити лише підтверджену витрату й пальне.',
      );
  }
}
/** @param {string} kind @param {string} key @param {unknown} value */
export function memorySemantics(kind, key, value) {
  if (isMemoryRecord(value)) {
    try {
      assertMemoryRecord(value);
      return {
        type: value.type,
        domain: value.domain,
        relation: value.relation,
        structured: true,
        needsReview: false,
      };
    } catch {
      /* malformed records are not current semantic truth */
    }
  }
  const technical = kind === 'setting' && /(?:^|\.)test_(?:word|reminder_word)$/.test(key);
  const preference =
    !!value &&
    typeof value === 'object' &&
    typeof (/** @type {any} */ (value).preference) === 'string' &&
    ['like', 'dislike'].includes(/** @type {any} */ (value).stance);
  const schedule = kind === 'habit' && ['day_start', 'day_end', 'lunch_at'].includes(key);
  const style = kind === 'profile' && ['reply_style', 'reply_language'].includes(key);
  return {
    type: technical ? 'technical' : preference ? 'preference' : schedule ? 'routine' : 'fact',
    domain: technical ? 'testing' : schedule ? 'schedule' : style ? 'communication' : 'general',
    relation: preference
      ? /** @type {any} */ (value).stance === 'like'
        ? 'likes'
        : 'dislikes'
      : 'none',
    structured: false,
    needsReview: !technical && !preference && !schedule && !style,
  };
}
/** @param {Record<string,any>} value */
export function memoryRecordText(value) {
  const prefix = {
    likes: 'Подобається',
    dislikes: 'Не подобається',
    wants: 'Хочу',
    owns: 'Мій ресурс',
    family: 'Сімейний ресурс',
    work: 'Робочий ресурс',
    rented: 'Орендований ресурс',
    knows: 'Стосунки',
    completed: 'Відбулася подія',
    none: '',
  };
  const lead = /** @type {Record<string,string>} */ (prefix)[value.relation];
  return `${lead ? `${lead}: ` : ''}${value.subject}${value.details ? `\n${value.details}` : ''}`;
}
