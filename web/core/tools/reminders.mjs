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
/** Підпис-заглушка cleanRemainder: не зміст, а «щось таки треба показати». */
const REMINDER_FALLBACK_TEXT = 'Нагадування';

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
 * @param {{ text?: string, when?: string }} args - те, що дає МОДЕЛЬ
 * @param {number} nowMs
 * @param {{ whenMs?: number, restoreId?: string, chatId?: number | string | null,
 *   threadId?: number | string | null }} [internal] - лише ядро: адреса
 *   прогону і відновлення після «↩»
 */
export async function runRemindersCreate(env, args, nowMs, internal = {}) {
  // ⚠️ Внутрішні поля - ОКРЕМИЙ параметр, не частина args (security-ревʼю
  // PR-6). Доти вони жили в args із поміткою «у схемі їх немає, тож модель не
  // передасть» - і це було хибно: proposals.create приймає довільний payload,
  // тож через нього модель дотягувалась і до whenMs (обхід парсера й
  // перевірки майбутнього), і до restoreId, і до адреси доставки.
  let whenMs;
  let remainder;
  if (typeof internal.whenMs === 'number') {
    whenMs = internal.whenMs;
  } else {
    if (!args.when) throw new Error('when обовʼязковий');
    ({ whenMs, remainder } = resolveWhen(args.when, nowMs));
  }
  // ⚠️ remainder НІКОЛИ не буває порожнім: cleanRemainder віддає підпис-
  // заглушку «Нагадування», коли крім часу в тексті нічого немає (ревʼю PR-6).
  // Без цієї перевірки «нагадай через 20 хв» створювало б нагадування з
  // текстом «Нагадування», а перевірка порожнечі нижче була б мертвою.
  const fromRemainder = remainder === REMINDER_FALLBACK_TEXT ? '' : (remainder ?? '');
  const text = String(args.text ?? fromRemainder).trim();
  if (!text) {
    throw new Error('не зрозумів, ПРО ЩО нагадати - постав text або спитай власника');
  }
  if (text.length > MAX_TEXT) throw new Error(`text довший за ${MAX_TEXT} символів`);

  const id = internal.restoreId ?? crypto.randomUUID().slice(0, 8);
  await updateState(env, (s) => ({
    ...s,
    reminders: addReminder(s.reminders, {
      id,
      text,
      whenMs,
      nowMs,
      // Адресу задає ЯДРО з контексту прогону: доти вона приходила з
      // аргументів, і через proposals.create модель могла надіслати
      // нагадування з даними власника в довільний чат (security-ревʼю PR-6).
      ...(internal.chatId != null ? { chatId: internal.chatId } : {}),
      ...(internal.threadId != null ? { threadId: internal.threadId } : {}),
    }),
  }));
  return { result: { id, text, when: new Date(whenMs).toISOString() } };
}

/**
 * reminders.update: {id, text?, when?} - патч активного нагадування.
 * @param {Env} env
 * @param {{ id: string, text?: string, when?: string }} args
 * @param {number} nowMs
 * @param {{ whenMs?: number }} [internal] - лише ядро (undo)
 */
export async function runRemindersUpdate(env, args, nowMs, internal = {}) {
  if (!args.id) throw new Error('id обовʼязковий');
  if (args.text == null && args.when == null && internal.whenMs == null) {
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
  if (typeof internal.whenMs === 'number') patch.whenMs = internal.whenMs;
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
