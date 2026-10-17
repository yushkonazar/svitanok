import type { Bookmark, BookmarkCommand, BookmarkDetail, BookmarkList } from './bookmarks.ts';
import { ideaEcosystemContext } from '../../../core/ideas/ecosystem.mjs';
const key = 'svitanok:bookmarks:demo:v1';
let items: Bookmark[] | undefined;
const receipts = new Map<string, { fingerprint: string; id: string }>();
function load() {
  if (items) return items;
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '[]');
    if (Array.isArray(value)) return (items = value);
  } catch {
    /* isolated demo */
  }
  return (items = []);
}
async function digest(value: unknown) {
  if (!crypto.subtle) return crypto.randomUUID().replaceAll('-', '').repeat(2);
  return [
    ...new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))),
    ),
  ]
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('');
}
export async function readBookmarkDemoList(
  q = '',
  status = 'active',
  cursor?: string,
): Promise<BookmarkList> {
  const offset = Number(cursor ?? 0);
  const rows = load()
    .filter(
      (r) =>
        (status === 'all' ||
          (status === 'active'
            ? !['зроблено', 'відхилено'].includes(r.status)
            : r.status === status)) &&
        `${r.title} ${r.body}`.toLocaleLowerCase('uk-UA').includes(q.toLocaleLowerCase('uk-UA')),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return {
    items: rows.slice(offset, offset + 30),
    cursor: rows.length > offset + 30 ? String(offset + 30) : null,
    context: ideaEcosystemContext().version,
  };
}
export async function readBookmarkDemo(id: string, _before?: string): Promise<BookmarkDetail> {
  const item = load().find((r) => r.id === id);
  if (!item) throw new Error('Закладку не знайдено.');
  return { item, formulations: [], historyCursor: null };
}
export async function changeBookmarkDemo(command: BookmarkCommand) {
  if (command.op === 'formulate')
    throw new Error(
      'Формування помічником доступне у твоїй Telegram-сесії. У демо можна зберігати, редагувати та копіювати записи.',
    );
  const rows = load(),
    p = command.payload,
    fingerprint = JSON.stringify(command),
    prior = receipts.get(command.commandId),
    now = new Date().toISOString();
  if (prior) {
    if (prior.fingerprint !== fingerprint) throw new Error('Інша дія з цим ідентифікатором.');
    return {
      receipt: { id: prior.id, message: 'Закладку збережено.', formulationId: null },
      detail: await readBookmarkDemo(prior.id),
    };
  }
  let row = rows.find((r) => r.id === command.id);
  if (command.op === 'create') {
    const body = String(p.body ?? '').trim();
    if (!body) throw new Error('Запиши суть ідеї.');
    row = {
      id: 'idea-' + command.commandId,
      number: Math.max(0, ...rows.map((r) => r.number)) + 1,
      title: String(p.title || body.split('\n')[0]).slice(0, 200),
      body,
      status: 'нова',
      priority: 2,
      area: String(p.area ?? 'ecosystem'),
      kind: String(p.kind ?? 'idea'),
      createdAt: now,
      updatedAt: now,
      version: '',
      sourceHash: '',
      analysis: null,
      plan: null,
    };
    rows.push(row);
  } else {
    if (!row || row.version !== command.version)
      throw new Error('Закладка вже змінилася. Онови запис.');
    if (command.op === 'edit') {
      row.title = String(p.title || p.body)
        .split('\n')[0]
        .slice(0, 200);
      row.body = String(p.body ?? '');
      row.area = String(p.area ?? 'ecosystem');
      row.kind = String(p.kind ?? 'idea');
    }
    if (command.op === 'status') row.status = String(p.status);
    row.updatedAt = now;
  }
  row.sourceHash = await digest([row.title, row.body, row.area, row.kind]);
  row.version = await digest(row);
  receipts.set(command.commandId, { fingerprint, id: row.id });
  try {
    localStorage.setItem(key, JSON.stringify(rows));
  } catch {
    /* session remains usable */
  }
  return {
    receipt: { id: row.id, message: 'Закладку збережено.', formulationId: null },
    detail: await readBookmarkDemo(row.id),
  };
}
export function resetBookmarkDemo() {
  items = undefined;
  receipts.clear();
  localStorage.removeItem(key);
}
