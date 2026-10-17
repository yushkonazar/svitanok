import { IDEA_AREAS, IDEA_KINDS, ideaEcosystemContext } from './ecosystem.mjs';
import { IDEA_STATUSES } from './registry.mjs';
export class BookmarkError extends Error {
  constructor(message = 'Перевір дані закладки.', status = 400) {
    super(message);
    this.name = 'BookmarkError';
    this.status = status;
  }
}
/** @param {unknown} raw @param {number} max @param {boolean} [required] */
export function bookmarkText(raw, max, required = false) {
  if (typeof raw !== 'string' || raw.length > max || (required && !raw.trim()))
    throw new BookmarkError(`Заповни текст до ${max} символів.`);
  return raw.trim();
}
/** @param {unknown} raw */
export function bookmarkCommand(raw) {
  const c = /** @type {any} */ (raw);
  if (
    !c ||
    typeof c !== 'object' ||
    Array.isArray(c) ||
    !['create', 'edit', 'status', 'formulate', 'save-prompt'].includes(c.op) ||
    typeof c.commandId !== 'string' ||
    !/^\w{8}-\w{4}-\w{4}-\w{4}-\w{12}$/.test(c.commandId)
  )
    throw new BookmarkError('Онови закладки й повтори дію.');
  const p = c.payload ?? {};
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new BookmarkError();
  if (
    c.op !== 'create' &&
    (typeof c.id !== 'string' ||
      c.id.length > 100 ||
      typeof c.version !== 'string' ||
      !/^[a-f0-9]{64}$/.test(c.version))
  )
    throw new BookmarkError('Онови запис перед зміною.', 409);
  if (c.op === 'create' || c.op === 'edit') {
    const body = bookmarkText(p.body, 20000, true),
      title =
        p.title == null || p.title === ''
          ? (body.split('\n')[0] ?? body).slice(0, 120)
          : bookmarkText(p.title, 200, true);
    if (
      !IDEA_AREAS.some((a) => a.id === (p.area ?? 'ecosystem')) ||
      !Object.hasOwn(IDEA_KINDS, p.kind ?? 'idea')
    )
      throw new BookmarkError('Обери напрям і тип запису.');
    return { ...c, payload: { body, title, area: p.area ?? 'ecosystem', kind: p.kind ?? 'idea' } };
  }
  if (c.op === 'status' && !IDEA_STATUSES.includes(p.status))
    throw new BookmarkError('Обери статус ідеї.');
  if (
    c.op === 'save-prompt' &&
    (typeof p.formulationId !== 'string' ||
      p.formulationId.length > 100 ||
      !Number.isSafeInteger(p.revision) ||
      p.revision < 0)
  )
    throw new BookmarkError('Онови сформовану версію.', 409);
  return {
    ...c,
    payload: c.op === 'save-prompt' ? { ...p, prompt: bookmarkText(p.prompt, 50000, true) } : p,
  };
}
/** @param {unknown} value */
export async function bookmarkHash(value) {
  /** @param {any} v @returns {any} */
  const canonical = (v) =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v)
              .filter((key) => v[key] !== undefined)
              .sort()
              .map((key) => [key, canonical(v[key])]),
          )
        : v;
  const data = JSON.stringify(canonical(value));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data)))]
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('');
}
/** Source excludes generated analysis/status, so publishing a draft cannot make itself stale. @param {any} row */
export function ideaSource(row) {
  return {
    title: row.title,
    body: row.body_md ?? '',
    domain: row.domain,
    tags: row.tags_json ?? null,
    priority: row.priority ?? 2,
  };
}
/** Legacy assistant edits must also invalidate an open Mini App editor. @param {any} row */
export function ideaVersion(row) {
  return bookmarkHash([
    row.title,
    row.body_md,
    row.domain,
    row.status,
    row.priority,
    row.effort,
    row.next_action,
    row.tags_json,
    row.analysis_md,
    row.plan_md,
    row.plan_approved_at,
    row.repo,
    row.head_sha,
    row.artifact_drive_id,
    row.updated_at,
  ]);
}
/** @param {any} row */
export function bookmarkTags(row) {
  let tags;
  try {
    tags = JSON.parse(row.tags_json ?? '[]');
  } catch {
    tags = [];
  }
  return Array.isArray(tags) ? tags.filter((t) => typeof t === 'string') : [];
}
/** @param {any} row */
export function bookmarkMeta(row) {
  const tags = bookmarkTags(row);
  return {
    area: tags.find((t) => t.startsWith('surface:'))?.slice(8) ?? 'ecosystem',
    kind: tags.find((t) => t.startsWith('kind:'))?.slice(5) ?? 'idea',
  };
}
/** @param {any} row @param {{area:string,kind:string}} meta */
export function changedBookmarkTags(row, meta) {
  return JSON.stringify([
    ...bookmarkTags(row).filter((t) => !t.startsWith('surface:') && !t.startsWith('kind:')),
    'surface:' + meta.area,
    'kind:' + meta.kind,
  ]);
}

const string = { type: 'string' };
const list = { type: 'array', items: string, maxItems: 8 };
const properties = {
  title: string,
  problem: string,
  outcome: string,
  userFlow: list,
  minimumScope: list,
  futureScope: list,
  integrations: list,
  implementation: list,
  acceptance: list,
  risks: list,
  questions: list,
};
export const IDEA_BRIEF_SCHEMA = {
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
};
/** @param {any} value */
export function validateIdeaBrief(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('|') !== Object.keys(properties).sort().join('|')
  )
    throw new BookmarkError('Помічник повернув неповне формулювання.', 503);
  for (const key of ['title', 'problem', 'outcome'])
    bookmarkText(value[key], key === 'title' ? 200 : 1800, true);
  for (const key of [
    'userFlow',
    'minimumScope',
    'futureScope',
    'integrations',
    'implementation',
    'acceptance',
    'risks',
    'questions',
  ]) {
    if (!Array.isArray(value[key]) || value[key].length > 8)
      throw new BookmarkError('Помічник повернув неправильний формат.', 503);
    for (const item of value[key]) bookmarkText(item, 900, true);
  }
  if (
    !value.minimumScope.length ||
    !value.acceptance.length ||
    JSON.stringify(value).length > 18000
  )
    throw new BookmarkError('Формулювання не містить перевірного результату.', 503);
  return value;
}
/** @param {string} title @param {string[]} items */
function section(title, items) {
  return items.length ? `## ${title}\n\n${items.map((s) => '- ' + s).join('\n')}\n\n` : '';
}
/** @param {any} brief */
export function briefDocuments(brief) {
  return {
    analysis:
      `## Суть\n\n${brief.problem}\n\n## Бажаний результат\n\n${brief.outcome}\n\n` +
      section('Зв’язки у Світанку', brief.integrations) +
      section('Ризики та припущення', brief.risks) +
      section('Потребує уточнення', brief.questions),
    plan:
      section('Сценарій використання', brief.userFlow) +
      section('Перша версія', brief.minimumScope) +
      section('Кроки реалізації', brief.implementation) +
      section('Критерії готовності', brief.acceptance) +
      section('Можна додати пізніше', brief.futureScope),
  };
}
/** @param {any} source @param {any} brief @param {string} version */
export function ideaGptPrompt(source, brief, version) {
  const docs = briefDocuments(brief);
  return `Допоможи опрацювати й реалізувати зміну в екосистемі Світанку.\n\n# ${brief.title}\n\n## Мій початковий запис\n\n${source.title}\n\n${source.body}\n\n## Контекст\n\n${ideaEcosystemContext().scope} Версія карти: ${version}. Світанок поєднує Telegram Mini App, асистента, спільний Worker/D1, План/XP, фінанси/таксі, календар та інші модулі.\n\n${docs.analysis}${docs.plan}## Як працювати із запитом\n\nЗбережи мій початковий намір. Наведене рішення - пропозиція, а не погоджені технічні факти. Спершу перевір актуальний код, наявні дані й інтеграції; не створюй паралельний облік там, де вже є спільне джерело. Познач припущення, уточни суттєві невідомі, продумай UI/UX, повтори запитів, помилки, сумісність і перевірку результату. Сам текст цієї закладки не є дозволом виконувати покупки, надсилати повідомлення іншим чи публікувати зміни.`;
}
