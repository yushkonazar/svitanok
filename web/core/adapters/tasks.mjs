// Адаптер Google Tasks (07 §4 `proposals.create(kind=tasks.create)`, S-8-4,
// етап 7 PR-1). Один виклик - створити задачу у списку за замовчуванням.
//
// ⚠️ Tasks зберігає лише ДАТУ, час у полі `due` він приймає й мовчки
// відкидає (документоване обмеження API). Тому ядро не показує власнику
// вигаданої години: у підтвердження йде дата, а «нагадай о 15:00» - це
// reminders.create, не Tasks. Плутати два сховища термінів гірше, ніж мати
// два: у першому випадку власник чекає сигналу, якого не буде.

import { googleAccessToken, assertGoogleScope } from '../../google.mjs';
import { kyivDateKey } from '../../kyiv-time.mjs';

const TASKS_API = 'https://tasks.googleapis.com/tasks/v1';
/** Список за замовчуванням: власник веде один, окремих списків не просив. */
export const DEFAULT_TASKLIST = '@default';
const TASKS_TIMEOUT_MS = 15_000;
export const TASK_TITLE_MAX = 1024;
export const TASK_NOTES_MAX = 8192;

/**
 * `due` для Tasks: RFC3339 з обнуленим часом. Приймає і `YYYY-MM-DD`, і повний
 * ISO; будь-що інше - null (поле просто не піде, задача створиться без строку).
 * @param {unknown} raw
 * @returns {string | null}
 */
export function taskDueRfc3339(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T00:00:00Z`) : Date.parse(s);
  if (!Number.isFinite(ms)) return null;
  // ⚠️ Дата - КИЇВСЬКА (ревʼю етапу 7). Модель дає час у UTC ISO, тож
  // «завтра о 00:30» - це 21:30 UTC попередньої доби, і зріз UTC-рядка ставив
  // би задачу на день раніше. Вікно помилки - щоночі з 21:00 UTC.
  return `${kyivDateKey(new Date(ms))}T00:00:00.000Z`;
}

/**
 * Створити задачу. Кидає при будь-якому збої - це термінальна дія після ✅,
 * і тихе «ок» без задачі тут неприпустиме.
 * @param {Env} env
 * @param {{ title: string, notes?: string | null, due?: string | null }} input
 * @returns {Promise<{ id: string, title: string, due: string | null, link: string | null }>}
 */
export async function createTask(env, input) {
  await assertGoogleScope(env, 'tasks');
  const token = await googleAccessToken(env);
  if (!token) throw new Error('Google OAuth недоступний (секрети або мережа)');
  const title = String(input.title ?? '')
    .trim()
    .slice(0, TASK_TITLE_MAX);
  if (!title) throw new Error('tasks.create: потрібен title');
  const due = taskDueRfc3339(input.due);
  const notes = input.notes == null ? null : String(input.notes).trim().slice(0, TASK_NOTES_MAX);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TASKS_TIMEOUT_MS);
  try {
    const res = await fetch(`${TASKS_API}/lists/${DEFAULT_TASKLIST}/tasks`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title, ...(notes ? { notes } : {}), ...(due ? { due } : {}) }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Tasks HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = /** @type {any} */ (await res.json());
    if (typeof json?.id !== 'string') throw new Error('Tasks: задачу створено без id');
    return {
      id: json.id,
      title: String(json.title ?? title),
      // Віддаємо ТЕ, що записав Google, а не те, що просили: якщо він строк
      // відкинув, власник має побачити задачу без строку, а не з вигаданим.
      due: typeof json.due === 'string' ? json.due.slice(0, 10) : null,
      link: typeof json.selfLink === 'string' ? json.selfLink : null,
    };
  } finally {
    clearTimeout(timer);
  }
}
