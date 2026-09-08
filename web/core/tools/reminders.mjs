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
// Сховище - D1 `reminders` (07 §1) через core/reminders/store. KV
// `state.reminders` лишається джерелом ЛЕГАСІ-шляху (крон + /remind) до фліпа
// ASSISTANT_V2=on; перенесення робить scripts/migrate-reminders.mjs під час
// фліпа, коли легасі-цикл уже заглушено - інакше те саме нагадування прийшло б
// двічі, з обох сховищ.

import { parseReminderTime } from '../../reminders-core.mjs';
import {
  createReminder,
  updateReminder,
  cancelReminder,
  listActiveReminders,
  getReminder,
} from '../reminders/store.mjs';

/** Стеля тексту нагадування - як у легасі-шляху (повідомлення Telegram). */
const MAX_TEXT = 200;
/** Стеля пачки скасування: більше за раз - це вже «скасуй усе», інший намір. */
export const CANCEL_BATCH_MAX = 20;
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
  // Стосується лише розібраного з ТЕКСТУ часу. Внутрішній dueAtMs (undo) цю
  // перевірку свідомо минає: «↩» має повернути нагадування таким, яким воно
  // було, навіть якщо термін настав, поки власник роздумував.
  if (parsed.whenMs <= nowMs) throw new Error('час уже минув - потрібен момент у майбутньому');
  return parsed;
}

/**
 * reminders.create: {text, when} → рядок у D1.
 * `when` - природний текст; якщо в ньому лишився зміст («нагадай купити хліб
 * через годину»), парсер віддає remainder, і він стає текстом, коли `text`
 * не заданий явно.
 *
 * ⚠️ Внутрішні поля - ОКРЕМИЙ параметр, не частина args (security-ревʼю PR-6):
 * proposals.create приймає довільний payload, тож усе, що лежить в args,
 * досяжне для моделі - зокрема адреса доставки й обхід парсера.
 * @param {Env} env
 * @param {{ text?: string, when?: string }} args - те, що дає МОДЕЛЬ
 * @param {number} nowMs
 * @param {{ dueAtMs?: number, restoreId?: string, chatId?: number | string | null,
 *   threadId?: number | string | null }} [internal] - лише ядро: адреса
 *   прогону і відновлення після «↩»
 */
export async function runRemindersCreate(env, args, nowMs, internal = {}) {
  let dueAtMs;
  let remainder;
  if (typeof internal.dueAtMs === 'number') {
    dueAtMs = internal.dueAtMs;
  } else {
    if (!args.when) throw new Error('when обовʼязковий');
    ({ whenMs: dueAtMs, remainder } = resolveWhen(args.when, nowMs));
  }
  // remainder НІКОЛИ не буває порожнім: cleanRemainder віддає підпис-заглушку
  // «Нагадування», коли крім часу в тексті нічого немає (ревʼю PR-6).
  const fromRemainder = remainder === REMINDER_FALLBACK_TEXT ? '' : (remainder ?? '');
  const text = String(args.text ?? fromRemainder).trim();
  if (!text) {
    throw new Error('не зрозумів, ПРО ЩО нагадати - постав text або спитай власника');
  }
  if (text.length > MAX_TEXT) throw new Error(`text довший за ${MAX_TEXT} символів`);

  const id = internal.restoreId ?? crypto.randomUUID().slice(0, 8);
  const created = await createReminder(env, {
    id,
    text,
    dueAtMs,
    // Адресу задає ЯДРО з контексту прогону: доти вона приходила з аргументів,
    // і через proposals.create модель могла надіслати нагадування з даними
    // власника в довільний чат (security-ревʼю PR-6).
    chatId: internal.chatId ?? null,
    threadId: internal.threadId ?? null,
  });
  return {
    result: {
      id: created.id,
      text: created.text,
      when: created.dueAt,
      deliver_at: deliverAt(dueAtMs),
    },
  };
}

/**
 * Коли нагадування СПРАВДІ піде. Планувальник тікає раз на хвилину, тож
 * секунди всередині хвилини нічого не означають: округляємо вгору до межі
 * хвилини й називаємо власнику цей час. Обіцяти «о 14:41:37» було б
 * неправдою (скарга власника 08.09: «нагадування прийшло пізно»).
 * @param {number} dueAtMs
 * @returns {string} ISO
 */
export function deliverAt(dueAtMs) {
  return new Date(Math.ceil(dueAtMs / 60_000) * 60_000).toISOString();
}

/**
 * reminders.update: {id, text?, when?} - патч активного нагадування.
 * @param {Env} env
 * @param {{ id: string, text?: string, when?: string }} args
 * @param {number} nowMs
 * @param {{ dueAtMs?: number }} [internal] - лише ядро (undo)
 */
export async function runRemindersUpdate(env, args, nowMs, internal = {}) {
  if (!args.id) throw new Error('id обовʼязковий');
  if (args.text == null && args.when == null && internal.dueAtMs == null) {
    throw new Error('нема що змінювати: ні text, ні when');
  }
  const before = await findActive(env, args.id);

  /** @type {{ text?: string, dueAtMs?: number }} */
  const patch = {};
  if (args.text != null) {
    const text = String(args.text).trim();
    if (!text) throw new Error('text порожній');
    if (text.length > MAX_TEXT) throw new Error(`text довший за ${MAX_TEXT} символів`);
    patch.text = text;
  }
  if (typeof internal.dueAtMs === 'number') patch.dueAtMs = internal.dueAtMs;
  else if (args.when != null) patch.dueAtMs = resolveWhen(args.when, nowMs).whenMs;

  const ok = await updateReminder(env, args.id, patch);
  if (!ok) throw new Error(`нагадування ${args.id} не оновилось - перечитай список`);
  return {
    result: {
      id: args.id,
      text: patch.text ?? before.text,
      when: patch.dueAtMs != null ? new Date(patch.dueAtMs).toISOString() : before.dueAt,
      deliver_at: deliverAt(patch.dueAtMs ?? Date.parse(before.dueAt)),
    },
  };
}

/**
 * reminders.cancel: {id} - зняти активне нагадування.
 * @param {Env} env
 * @param {{ id?: string, ids?: unknown[] }} args
 */
export async function runRemindersCancel(env, args) {
  // ⚠️ ПАЧКОЮ ТЕЖ (PR-7 §3.4): «скасуй усі три» доти означало три виклики
  // інструмента, тобто три кроки прогону на дію, яка логічно одна. `ids`
  // приймається поруч із `id` - старий контракт лишається чинним.
  const ids = Array.isArray(args.ids)
    ? args.ids.map((x) => String(x ?? '').trim()).filter(Boolean)
    : args.id
      ? [String(args.id)]
      : [];
  if (ids.length === 0) throw new Error('id обовʼязковий (або ids списком)');
  if (ids.length > CANCEL_BATCH_MAX) {
    throw new Error(`за раз скасовую щонайбільше ${CANCEL_BATCH_MAX} нагадувань`);
  }
  // Одне нагадування - стара поведінка дослівно: помилка летить як була
  // («не знайдено», «вже надіслане»), бо саме її модель показує власнику.
  if (ids.length === 1) {
    const id = /** @type {string} */ (ids[0]);
    const before = await findActive(env, id);
    if (!(await cancelReminder(env, id))) {
      throw new Error(`нагадування ${id} не скасувалось - перечитай список`);
    }
    return { result: { id, text: before.text, cancelled: true } };
  }
  /** @type {{ id: string, text: string }[]} */
  const cancelled = [];
  /** @type {string[]} */
  const missed = [];
  for (const id of ids) {
    try {
      const before = await findActive(env, id);
      if (!(await cancelReminder(env, id))) throw new Error('не скасувалось');
      cancelled.push({ id, text: before.text });
    } catch {
      // Одне зникле нагадування не сміє загубити решту пачки; але й мовчати
      // про нього не можна - воно піде в `missed`, і модель скаже вголос.
      missed.push(id);
    }
  }
  if (cancelled.length === 0) {
    throw new Error(`жодне з нагадувань не скасувалось (${missed.join(', ')}) - перечитай список`);
  }
  return { result: { cancelled, missed } };
}

/**
 * Активні нагадування - щоб модель могла назвати id для update/cancel.
 * Окремого інструмента 07 §4 не передбачає: список віддає data.read(scope=
 * reminders), а це внутрішній помічник виконавців і undo.
 * @param {Env} env
 */
export async function readActiveReminders(env) {
  return listActiveReminders(env);
}

/** Знайти АКТИВНЕ нагадування або впасти з чесним текстом для моделі.
 *  @param {Env} env @param {string} id */
async function findActive(env, id) {
  const found = await getReminder(env, id);
  if (!found || (found.status !== 'pending' && found.status !== 'snoozed')) {
    throw new Error(`нагадування ${id} не знайдено серед активних - перечитай список`);
  }
  return found;
}
