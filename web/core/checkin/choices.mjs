/** Personal descriptive choices. IDs and historical answer snapshots outlive edits/deletion.
 * @typedef {import('./catalog.mjs').Field} Field
 * @typedef {{field:string,id:string,label:string,group:string,scope:string,deleted:boolean}} ChoiceEntry
 * @typedef {{version:1,revision:number,entries:ChoiceEntry[],receipts:{id:string,signature:string}[]}} ChoiceCatalog
 */
const protectedValues = new Set(['none', 'unknown', 'other', 'private', 'alone', 'noplan', 'na']);
const customId = /^user_[a-z0-9_-]{8,80}$/;
const fieldId = /^[a-zA-Z][a-zA-Z0-9]{1,70}V4$/;
/** @param {unknown} value @param {number} max */
const shortText = (value, max) =>
  typeof value === 'string'
    ? value
        .replace(/\p{Cc}/gu, ' ')
        .replace(/\s+/g, ' ')
        .replace(/\s*::\s*/g, ': ')
        .trim()
        .slice(0, max)
    : '';
/** @param {unknown} raw @returns {ChoiceCatalog} */
export function normalizeChoiceCatalog(raw) {
  const a =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? /** @type {KvBlob} */ (raw) : {};
  /** @type {ChoiceEntry[]} */ const entries = [];
  const seen = new Set();
  for (const item of Array.isArray(a.entries) ? a.entries.slice(0, 500) : []) {
    if (
      !item ||
      typeof item !== 'object' ||
      !fieldId.test(item.field) ||
      typeof item.id !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,90}$/.test(item.id) ||
      protectedValues.has(item.id)
    )
      continue;
    const key = `${item.field}:${item.id}`,
      label = shortText(item.label, 100),
      group = shortText(item.group, 50);
    if (seen.has(key) || !label || !group) continue;
    seen.add(key);
    entries.push({
      field: item.field,
      id: item.id,
      label,
      group,
      scope: shortText(item.scope, 50) || 'default',
      deleted: item.deleted === true,
    });
  }
  return {
    version: 1,
    revision: Number.isSafeInteger(a.revision) && a.revision >= 0 ? a.revision : 0,
    entries,
    receipts: (Array.isArray(a.receipts) ? a.receipts : [])
      .filter(
        (/** @type {KvBlob} */ x) =>
          x &&
          typeof x.id === 'string' &&
          typeof x.signature === 'string' &&
          x.id.length <= 100 &&
          x.signature.length <= 1000,
      )
      .slice(-40)
      .map((/** @type {KvBlob} */ x) => ({ id: x.id, signature: x.signature })),
  };
}
/** @param {unknown} raw */
export function publicChoiceCatalog(raw) {
  const catalog = normalizeChoiceCatalog(raw);
  return { version: catalog.version, revision: catalog.revision, entries: catalog.entries };
}
/** Fixed scales, ranges, exclusive escape answers and flow controllers remain semantic constants.
 * @param {Field} field */
export function editableChoiceField(field) {
  return (
    !!field.options &&
    (field.id === 'priorityV4' ||
      (field.type === 'multi' &&
        field.id.endsWith('V4') &&
        !['developmentActualV4', 'developmentPlanV4', 'energyKindV4'].includes(field.id)))
  );
}
/** @param {unknown} id */
export function editableChoiceValue(id) {
  return typeof id === 'string' && !protectedValues.has(id);
}
/** @param {string} field @returns {[string,string][]} */
export function choiceScopes(field) {
  if (field === 'moodFactorsV4')
    return [
      ['Для хорошого настрою', 'mood:positive'],
      ['Для складного настрою', 'mood:negative'],
      ['Лише для нейтрального / змішаного', 'mood:mixed'],
    ];
  if (field === 'energyFactorsV4')
    return [
      ['Для будь-якої нестачі сил', 'energy:any'],
      ['Коли хочеться спати', 'energy:sleepy'],
      ['Для фізичної втоми', 'energy:physical'],
      ['Для розумової втоми', 'energy:mental'],
      ['Для емоційної втоми', 'energy:emotional'],
      ['Коли важко почати справу', 'energy:activation'],
      ['Коли голодний', 'energy:hunger'],
      ['Для нездужання / дискомфорту', 'energy:discomfort'],
    ];
  if (field === 'workFactorsV4')
    return [
      ['За будь-якого навантаження', 'work:any'],
      ['За легкого навантаження', 'work:light'],
      ['За важкого навантаження', 'work:heavy'],
    ];
  return [['Для цього питання', 'default']];
}
/** @param {string} field @param {KvBlob} answers */
export function activeChoiceScopes(field, answers) {
  if (field === 'moodFactorsV4')
    return answers.mood >= 4
      ? ['mood:positive']
      : answers.mood <= 2
        ? ['mood:negative']
        : ['mood:positive', 'mood:negative', 'mood:mixed'];
  if (field === 'energyFactorsV4')
    return [
      'energy:any',
      ...(Array.isArray(answers.energyKindV4)
        ? answers.energyKindV4.map((/** @type {string} */ x) => `energy:${x}`)
        : []),
    ];
  if (field === 'workFactorsV4')
    return [1, 2].includes(answers.workLoadV4)
      ? ['work:any', 'work:light']
      : [4, 5].includes(answers.workLoadV4)
        ? ['work:any', 'work:heavy']
        : ['work:any', 'work:light', 'work:heavy'];
  return ['default'];
}
/** @param {string} field @param {KvBlob} answers */
export function defaultChoiceScope(field, answers) {
  const scopes = activeChoiceScopes(field, answers);
  return field === 'moodFactorsV4' && answers.mood === 3
    ? 'mood:mixed'
    : field === 'energyFactorsV4' && scopes.length === 2
      ? (scopes[1] ?? 'energy:any')
      : (scopes[0] ?? 'default');
}
/** Resolve labels/hiding only within the already contextual base list. An override cannot
 * reintroduce a negative base cause into a positive branch. @param {Field} field @param {unknown} raw @param {string[]} [scopes] @returns {Field} */
export function resolveFieldChoices(field, raw, scopes) {
  if (!editableChoiceField(field)) return field;
  const entries = normalizeChoiceCatalog(raw).entries.filter((x) => x.field === field.id);
  /** @type {[string,string|number][]} */ const options = [];
  for (const [label, id] of field.options ?? []) {
    const edit = entries.find((x) => x.id === id);
    if (!edit?.deleted) options.push([edit ? `${edit.group} :: ${edit.label}` : label, id]);
  }
  for (const entry of entries)
    if (
      customId.test(entry.id) &&
      !entry.deleted &&
      !options.some(([, id]) => id === entry.id) &&
      (!scopes || scopes.includes(entry.scope))
    )
      options.push([`${entry.group} :: ${entry.label}`, entry.id]);
  return { ...field, options };
}
export class ChoiceCatalogError extends Error {
  /** @param {string} message @param {number} [status] */
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
/** Atomic, revision-checked and retry-safe CRUD over the canonical settings blob.
 * @param {unknown} raw @param {KvBlob} command @param {Field[]} fields @returns {ChoiceCatalog} */
export function applyChoiceCommand(raw, command, fields) {
  const catalog = normalizeChoiceCatalog(raw);
  if (
    !command ||
    typeof command !== 'object' ||
    !['create', 'update', 'delete', 'restore'].includes(command.op) ||
    !/^[a-zA-Z0-9_-]{8,100}$/.test(command.requestId ?? '')
  )
    throw new ChoiceCatalogError('Некоректна дія з варіантом відповіді.');
  const field = fields.find((f) => f.id === command.field);
  if (!field || !editableChoiceField(field))
    throw new ChoiceCatalogError(
      'Ці відповіді визначають шкалу або ланцюжок питань і не редагуються.',
    );
  const label = shortText(command.label, 100),
    group = shortText(command.group, 50);
  const signature = JSON.stringify([
    command.op,
    command.field,
    command.optionId,
    label,
    group,
    command.scope,
  ]);
  const receipt = catalog.receipts.find((r) => r.id === command.requestId);
  if (receipt) {
    if (receipt.signature !== signature)
      throw new ChoiceCatalogError('Повтор дії має інший зміст.', 409);
    return catalog;
  }
  if (
    !Number.isSafeInteger(command.expectedRevision) ||
    command.expectedRevision !== catalog.revision
  )
    throw new ChoiceCatalogError(
      'Список уже змінився на іншому пристрої. Онови його й повтори дію.',
      409,
    );
  const id = command.optionId;
  if (!editableChoiceValue(id))
    throw new ChoiceCatalogError('Цей службовий варіант залишається доступним.');
  const base = field.options?.find(([, v]) => v === id),
    existing = catalog.entries.find((x) => x.field === field.id && x.id === id);
  if (command.op === 'create') {
    if (!customId.test(id) || existing || base)
      throw new ChoiceCatalogError('Обери новий варіант відповіді.');
    if (
      catalog.entries.filter((x) => x.field === field.id && x.id.startsWith('user_') && !x.deleted)
        .length >= 50 ||
      catalog.entries.length >= 500
    )
      throw new ChoiceCatalogError(
        'Забагато власних варіантів. Видали непотрібні перед додаванням нових.',
      );
  } else if (!base && !existing)
    throw new ChoiceCatalogError('Цього варіанта вже немає. Онови список.', 404);
  if (command.op === 'update' && existing?.deleted)
    throw new ChoiceCatalogError('Спочатку віднови видалений варіант.', 409);
  const baseText = String(base?.[0] ?? '').split(' :: '),
    baseLabel = baseText.at(-1) ?? '',
    baseGroup = baseText.length > 1 ? (baseText[0] ?? 'Основне') : 'Основне';
  const next = {
    field: field.id,
    id: String(id),
    label: existing?.label ?? baseLabel,
    group: existing?.group ?? baseGroup,
    scope: existing?.scope ?? 'default',
    deleted: command.op === 'delete',
  };
  if (['create', 'update'].includes(command.op)) {
    if (
      !label ||
      !group ||
      String(command.label ?? '').trim().length > 100 ||
      String(command.group ?? '').trim().length > 50
    )
      throw new ChoiceCatalogError('Вкажи назву до 100 символів і категорію до 50 символів.');
    if (customId.test(id) && !choiceScopes(field.id).some(([, s]) => s === command.scope))
      throw new ChoiceCatalogError('Обери, для якої відповіді показувати цей варіант.');
    if (
      (resolveFieldChoices(field, catalog).options ?? []).some(
        ([l, v]) =>
          v !== id &&
          l.split(' :: ').at(-1)?.toLocaleLowerCase('uk-UA') === label.toLocaleLowerCase('uk-UA'),
      )
    )
      throw new ChoiceCatalogError('Такий варіант уже є в цьому питанні.');
    Object.assign(next, { label, group, ...(customId.test(id) ? { scope: command.scope } : {}) });
  }
  return {
    version: 1,
    revision: catalog.revision + 1,
    entries: [...catalog.entries.filter((x) => x.field !== field.id || x.id !== id), next],
    receipts: [...catalog.receipts, { id: command.requestId, signature }].slice(-40),
  };
}
/** Snapshot-aware labels for immutable historical records. @param {Field} field @param {unknown} value @param {KvBlob} [record] */
export function choiceAnswerLabel(field, value, record = {}) {
  if (field.type === 'duration' && typeof value === 'number')
    return `${Math.floor(value / 60)} год ${value % 60} хв`;
  const label = (/** @type {unknown} */ v) =>
    String(
      record.optionLabelsV4?.[field.id]?.[String(v)] ??
        field.options?.find(([, id]) => id === v)?.[0] ??
        (String(v).startsWith('user_') ? 'Власний варіант' : v) ??
        '—',
    )
      .split(' :: ')
      .at(-1) ?? '—';
  return Array.isArray(value) ? value.map(label).join(', ') : label(value);
}
/** Aggregates keep stable IDs; labels come from observed records, never today's editor.
 * @param {KvBlob[]} days @param {string} slot @param {Field} field @returns {Record<string,string>} */
export function choiceLabelsForDays(days, slot, field) {
  const labels = Object.fromEntries(
    field.options?.map(([label, id]) => [String(id), label.split(' :: ').at(-1) ?? label]) ?? [],
  );
  for (const day of [...days].sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
    for (const [id, label] of Object.entries(day[slot]?.optionLabelsV4?.[field.id] ?? {}))
      if (typeof label === 'string') labels[id] = label.split(' :: ').at(-1) ?? label;
  }
  return labels;
}
