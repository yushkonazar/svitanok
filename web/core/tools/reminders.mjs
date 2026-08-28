// reminders.create / update / cancel (07-schema §4): нагадування власника.
// Рівень T0 (запис у ВЛАСНЕ сховище, не назовні) - у tainted-сесії policy сама
// підіймає до T1, тут про це знати не треба.
//
// ⚠️ ЧАС РАХУЄ КОД, НЕ МОДЕЛЬ. Інструмент приймає `when` природним текстом
// («через 20 хв», «завтра о 9») і проганяє його через parseReminderTime -
// той самий парсер, що обслуговує /remind. Дозволити моделі передавати
// готовий timestamp означало б, що вона рахує київський час і переведення
// годинника - вона це робить неправильно, і помилка тиха.
//
// Сховище - KV `state.reminders` через чинні примітиви reminders-core (той
// самий масив, який читає крон і показує /reminders). D1-таблиця `reminders`
// існує з міграції 0002, але порожня: перенесення - PR-7 етапу 2, і робити
// це тут означало б дві правди одночасно.

import { loadState, updateState } from '../../kv-store.mjs';
import {
  parseReminderTime,
  addReminder,
  cancelReminder,
  updateReminder,
  listActive,
} from '../../reminders-core.mjs';

/** Стеля списку в результаті: моделі потрібен вибір, не архів. */
const MAX_LIST = 20;
/** Стеля тексту нагадування - як у легасі-шляху (повідомлення Telegram). */
const MAX_TEXT = 200;

/**
 * Розібрати час і текст. Повертає помилку СЛОВАМИ моделі: вона має або
 * перепитати власника, або сформулювати інакше, а не вигадати час.
 * @param {string} when
 * @param {number} nowMs
 */
function resolveWhen(when, nowMs) {
  const parsed = parseReminderTime(when, nowMs);
  if (!parsed) {
    throw new Error(
      `не розібрав час "${when}" - попроси власника сказати інакше («через 20 хв», «завтра о 9»)`,
    );
  }
  // Стосується лише розібраного з ТЕКСТУ часу. Внутрішній whenMs (undo) цю
  // перевірку свідомо минає: «↩» має повернути нагадування таким, яким воно
  // було, навіть якщо термін настав, поки власник роздумував.
  if (parsed.whenMs <= nowMs) throw new Error('час уже минув - потрібен момент у майбутньому');
  return parsed;
}

/**
 * reminders.create: {text, when} → нагадування в KV.
 * `when` - природний текст; якщо в ньому лишився зміст («нагадай купити хліб
 * через годину»), парсер віддає remainder, і він стає текстом, коли `text`
 * не заданий явно.
 * @param {Env} env
 * @param {{ text?: string, when?: string, chat_id?: number, thread_id?: number,
 *   whenMs?: number, restoreId?: string }} args - whenMs/restoreId лише для undo
 * @param {number} nowMs
 */
export async function runRemindersCreate(env, args, nowMs) {
  // whenMs/restoreId - ВНУТРІШНІ поля (undo policy): у схемі інструмента їх
  // немає, тож модель їх не передасть. Потрібні тому, що парсер розуміє
  // природні фрази, а не ISO, а відновлення після «↩» мусить лягти хвилина в
  // хвилину і тим самим id.
  let whenMs;
  let remainder;
  if (typeof args.whenMs === 'number') {
    whenMs = args.whenMs;
  } else {
    if (!args.when) throw new Error('when обовʼязковий');
    ({ whenMs, remainder } = resolveWhen(args.when, nowMs));
  }
  const text = String(args.text ?? remainder ?? '').trim();
  if (!text) throw new Error('text порожній - нагадування без змісту не створюємо');
  if (text.length > MAX_TEXT) throw new Error(`text довший за ${MAX_TEXT} символів`);

  const id = args.restoreId ?? crypto.randomUUID().slice(0, 8);
  await updateState(env, (s) => ({
    ...s,
    reminders: addReminder(s.reminders, {
      id,
      text,
      whenMs,
      nowMs,
      ...(args.chat_id != null ? { chatId: args.chat_id } : {}),
      ...(args.thread_id != null ? { threadId: args.thread_id } : {}),
    }),
  }));
  return { result: { id, text, when: new Date(whenMs).toISOString() } };
}

/**
 * reminders.update: {id, text?, when?} - патч активного нагадування.
 * @param {Env} env
 * @param {{ id: string, text?: string, when?: string, whenMs?: number }} args
 * @param {number} nowMs
 */
export async function runRemindersUpdate(env, args, nowMs) {
  if (!args.id) throw new Error('id обовʼязковий');
  if (args.text == null && args.when == null && args.whenMs == null) {
    throw new Error('нема що змінювати: ні text, ні when');
  }
  const before = await findActive(env, args.id);

  /** @type {{ text?: string, whenMs?: number }} */
  const patch = {};
  if (args.text != null) {
    const text = String(args.text).trim();
    if (!text) throw new Error('text порожній');
    if (text.length > MAX_TEXT) throw new Error(`text довший за ${MAX_TEXT} символів`);
    patch.text = text;
  }
  if (typeof args.whenMs === 'number') patch.whenMs = args.whenMs;
  else if (args.when != null) patch.whenMs = resolveWhen(args.when, nowMs).whenMs;

  await updateState(env, (s) => ({ ...s, reminders: updateReminder(s.reminders, args.id, patch) }));
  return {
    result: {
      id: args.id,
      text: patch.text ?? before.text,
      when: new Date(patch.whenMs ?? before.whenMs).toISOString(),
    },
  };
}

/**
 * reminders.cancel: {id} - зняти активне нагадування.
 * @param {Env} env
 * @param {{ id: string }} args
 */
export async function runRemindersCancel(env, args) {
  if (!args.id) throw new Error('id обовʼязковий');
  const before = await findActive(env, args.id);
  await updateState(env, (s) => ({ ...s, reminders: cancelReminder(s.reminders, args.id) }));
  return { result: { id: args.id, text: before.text, cancelled: true } };
}

/**
 * Активні нагадування - щоб модель могла назвати id для update/cancel.
 * Окремого інструмента 07 §4 не передбачає: список віддає data.read(scope=
 * reminders), а це внутрішній помічник виконавців і undo.
 * @param {Env} env
 */
export async function readActiveReminders(env) {
  const state = await loadState(env);
  return listActive(state.reminders).slice(0, MAX_LIST);
}

/** Знайти АКТИВНЕ нагадування або впасти з чесним текстом для моделі.
 *  @param {Env} env @param {string} id */
async function findActive(env, id) {
  const found = (await readActiveReminders(env)).find((r) => r.id === id);
  if (!found) {
    throw new Error(`нагадування ${id} не знайдено серед активних - перечитай список`);
  }
  return found;
}
