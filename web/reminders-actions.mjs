// Дії з нагадуваннями (Фаза 5, модуляризація worker.js, план A2 §5).
//
// Шар МІЖ чистим reminders-core (парсер часу, примітиви списку) і двома
// викликачами — Telegram-командами й агентом. Тут живе те, що не є ні чистою
// логікою, ні транспортом: знайти потрібне нагадування за описом, вирішити,
// створювати одразу чи питати підтвердження, відповісти власнику.
//
// ТРИ ІНВАРІАНТИ.
//   1. **Час рахує код, не модель.** Фраза -> parseReminderTime; якщо не
//      впізнав — LLM лише ПЕРЕПИСУЄ її в канонічний патерн, і той знову йде
//      через той самий парсер. LLM ніколи не називає остаточний час.
//   2. **Мутації — під ✅** (S2). Створення лишається прямим (додати дешево
//      відкотити), а скасувати/перенести чуже нагадування власник має
//      підтвердити: він не побачить зникле нагадування, він просто НЕ отримає
//      його вчасно.
//   3. **Не вгадуємо, яке саме.** Нуль збігів за описом -> чесна відмова,
//      кілька -> перепит зі списком. Мовчазний вибір «першого-ліпшого» тут
//      коштує занадто дорого.
//
// ⚠️ ЗАЛЕЖНІСТЬ ВІД АГЕНТА ІНВЕРТОВАНА. `createReminderFromText` уміє віддати
// нерозпізнану фразу агентові — але НЕ імпортує його: інакше agent-runtime
// (який сам кличе ці дії) замкнув би цикл. Замість цього викликач передає
// `onUnparsed`; поведінка та сама, напрямок залежності — один.

import {
  parseReminderTime,
  addReminder,
  listActive,
  matchDayPartRange,
  pickDayPartSlot,
  formatReminderConfirm,
  buildLlmRewriteSystemPrompt,
  LLM_REWRITE_SCHEMA,
  extractLlmRewrite,
  isAmbiguousRewrite,
  addDaysToDateKey,
} from './reminders-core.mjs';
import { loadState } from './kv-store.mjs';
import { readCalendarRange } from './google.mjs';
import { callLlmHost } from './llm-host.mjs';
import { sendTo } from './telegram-client.mjs';
import { stageProposalItem, proposeCalendarChanges } from './proposals.mjs';
import { kyivDateKey } from './kyiv-time.mjs';

/** Відповідь, коли час у фразі не розпізнано ЖОДНИМ шляхом (парсер -> LLM-рерайт
 *  -> знову парсер). Приклади в тексті — це не прикраса: вони показують саме ті
 *  форми, які парсер гарантовано розуміє. */
const REMINDER_HELP =
  '🤔 Не зрозумів час. Приклади: "через 20 хвилин", "завтра о 10:00", "о 15:30".';

/** Мінімальна довжина опису для пошуку нагадування (S2) — див. cancelReminderByText:
 *  збіг іде по ПІДРЯДКУ, тож «о» чи «на» підходить майже під будь-яке нагадування. */
const MIN_CANCEL_MATCH_LEN = 4;

/**
 * LLM-фолбек, коли rule-based parseReminderTime не впізнав фразу: питаємо
 * VPS-хост ПЕРЕПИСАТИ її в канонічний патерн (LLM НЕ рахує час сам — ненадійна
 * арифметика дат), тоді прогонюємо результат через ТОЙ САМИЙ parseReminderTime.
 * Хост недоступний/не налаштований -> callLlmHost сам поверне null, тихо.
 * isAmbiguousRewrite — захист від ненадійного rewrite (модель не завжди
 * до кінця виконує інструкцію «прибери слово частини доби») — якщо лишилось
 * "ввечері"/"вранці" тощо, НЕ довіряємо, а не мовчки ставимо хибний час.
 */
export async function tryLlmReminderRewrite(/** @type {Env} */ env, /** @type {string} */ text) {
  const now = Date.now();
  const res = await callLlmHost(env, {
    prompt: text,
    systemPrompt: buildLlmRewriteSystemPrompt(now),
    jsonSchema: LLM_REWRITE_SCHEMA,
  });
  const rewritten = extractLlmRewrite(res?.structured);
  if (!rewritten || isAmbiguousRewrite(rewritten)) return null;
  return parseReminderTime(rewritten, now);
}

/**
 * Нагадування з фрази частини доби («після обіду», «вранці» тощо, day-part —
 * reminders-core.matchDayPartRange) — БЕЗ прямого створення: точна година
 * невідома, доки не глянемо календар. Читаємо сьогодні+завтра (чи лише один
 * із них, якщо текст явно каже «завтра»/«сьогодні» — dayPart.forcedDay),
 * обираємо вільну годину (pickDayPartSlot) і СТЕЙДЖИМО як звичайну пропозицію
 * нагадування (kind:'reminder', proposeCalendarChanges) — той самий
 * confirm-флоу, що й LLM-пропозиції, тож власник бачить запропонований час і
 * може підправити його циклером 🕐 (buildProposalKeyboard) ДО підтвердження,
 * замість негайного, неперевіреного створення.
 *
 * Немає доступу до календаря (readCalendarRange -> null) — трактуємо як
 * «подій немає» (той самий graceful-degrade мотив, що computeOverlapWarnings):
 * пропозиція все одно йде, просто без реальної перевірки зайнятості.
 */
export async function proposeDayPartReminder(
  /** @type {Env} */ env,
  /** @type {KvBlob} */ parsed,
  /** @type {KvBlob} */ dayPart,
) {
  const nowMs = Date.now();
  const todayKey = kyivDateKey(new Date(nowMs));
  const tomorrowKey = addDaysToDateKey(todayKey, 1);

  let days;
  if (dayPart.forcedDay === 'tomorrow') {
    const events = await readCalendarRange(env, tomorrowKey, tomorrowKey);
    days = [{ dateKey: tomorrowKey, events, nowMs: 0, isToday: false }];
  } else if (dayPart.forcedDay === 'today') {
    const events = await readCalendarRange(env, todayKey, todayKey);
    days = [{ dateKey: todayKey, events, nowMs, isToday: true }];
  } else {
    const [todayEvents, tomorrowEvents] = await Promise.all([
      readCalendarRange(env, todayKey, todayKey),
      readCalendarRange(env, tomorrowKey, tomorrowKey),
    ]);
    days = [
      { dateKey: todayKey, events: todayEvents, nowMs, isToday: true },
      { dateKey: tomorrowKey, events: tomorrowEvents, nowMs: 0, isToday: false },
    ];
  }

  const slot = pickDayPartSlot(days, dayPart.startHour, dayPart.endHour);
  const hh = String(slot.hour).padStart(2, '0');
  const when = `${slot.isToday ? 'сьогодні' : 'завтра'} о ${hh}:00`;
  return proposeCalendarChanges(env, parsed, [
    { kind: 'reminder', title: dayPart.remainder, when },
  ]);
}

/**
 * Розібрати текст на час+нагадування, зберегти в state.reminders, підтвердити.
 *
 * agentFallback (B2): коли фразу написав КОРИСТУВАЧ («нагадай ...», /remind) і
 * ні rule-based парсер, ні LLM-рерайт її не взяли — передаємо розмову агентові
 * замість глухого REMINDER_HELP. Агент має памʼять треду, тож може перепитати
 * деталі й ЗІБРАТИ їх із наступної репліки (саме тут ламався сценарій із fix.md:
 * бот питав «Що тебе запланувати на 24 липня?», а відповідь трактував як новий
 * запит). Для дії createReminder САМОГО агента fallback вимкнено — інакше
 * непарсибельний reminderText крутив би агента по колу.
 */
/**
 * @param {Env} env
 * @param {KvBlob} parsed
 * @param {string} text
 * @param {{ onUnparsed?: (() => any)|null }} [opts]
 */
export async function createReminderFromText(env, parsed, text, { onUnparsed = null } = {}) {
  const sendText = sendTo(env, parsed);

  // Порожнє «/remind» без аргументів (ревʼю B): без цього гейта фраза йшла у
  // спінер + холостий callLlmHost(''), а далі в agentFallback -> агент бачив
  // порожній текст і віддавав СТАРУ заглушку «асистент ще не підключений».
  if (!text || !text.trim()) return sendText(REMINDER_HELP);

  let parsedTime = parseReminderTime(text, Date.now());

  // День-частина («після обіду», «вранці» тощо) БЕЗ явної години — рахуємо
  // вільний час через календар і йдемо в staged-confirm, а не пряме створення
  // (див. doc-коментар proposeDayPartReminder). ПЕРЕД LLM-рерайтом: це
  // дешевший і точніший шлях для рівно цього класу фраз, LLM тут не потрібен.
  if (!parsedTime) {
    const dayPart = matchDayPartRange(text);
    if (dayPart) return proposeDayPartReminder(env, parsed, dayPart);
  }

  if (!parsedTime && env.LLM_HOST_URL) {
    await sendText('🤔 Хвилинку, розбираюсь...');
    parsedTime = await tryLlmReminderRewrite(env, text);
  }
  if (!parsedTime) {
    if (onUnparsed && env.LLM_HOST_URL) return onUnparsed();
    return sendText(REMINDER_HELP);
  }

  const state = await loadState(env);
  state.reminders = addReminder(state.reminders, {
    id: crypto.randomUUID(),
    text: parsedTime.remainder,
    whenMs: parsedTime.whenMs,
    nowMs: Date.now(),
    // Куди відповідати, коли час настане (B12) — туди ж, де попросили.
    chatId: parsed.chatId,
    threadId: parsed.threadId,
  });
  await env.BRIEFING.put('state', JSON.stringify(state));
  return sendText(formatReminderConfirm(parsedTime.whenMs, parsedTime.remainder, Date.now()), {
    parse_mode: 'HTML',
  });
}

/**
 * Знайти РІВНО одне активне нагадування за описом -> {reminder} | {reply}.
 *
 * Спільне для cancelReminder і updateReminder: збіг по підрядку серед активних.
 * 0 -> не знайшов; >1 -> уточнити (не вгадуємо, яке саме — ціна помилки тут не
 * симетрична: скасоване нагадування власник просто не отримає й не дізнається
 * про це). Плоский текст відповіді (без parse_mode) — текст нагадування
 * довільний, Telegram не має інтерпретувати в ньому розмітку.
 */
/**
 * Знайти рівно одне активне нагадування за описом.
 *
 * Форма результату — пара «або-або» з явними `undefined`: саме так викликач
 * після `if (found.reply) return …` дістає `found.reminder` без зайвої
 * перевірки, і саме так tsc це бачить.
 * @param {Env} env
 * @param {unknown} matchText
 * @returns {Promise<{ reply: string, reminder?: undefined }
 *   | { reply?: undefined, reminder: import('./reminders-core.mjs').Reminder }>}
 */
export async function findReminderByText(env, matchText) {
  const state = await loadState(env);
  const q = String(matchText ?? '')
    .trim()
    .toLowerCase();
  const matches = listActive(state.reminders).filter((/** @type {KvBlob} */ r) =>
    String(r.text).toLowerCase().includes(q),
  );
  if (matches.length === 0) {
    return { reply: `🤔 Не знайшов активного нагадування «${matchText}». Список — /reminders.` };
  }
  if (matches.length > 1) {
    const list = matches
      .map((/** @type {KvBlob} */ r, /** @type {number} */ i) => `${i + 1}. ${r.text}`)
      .join('\n');
    return { reply: `🤔 Кілька нагадувань підходять — уточни, яке саме:\n${list}` };
  }
  // Приведення: гілки length===0 і length>1 уже повернули, отже елемент є.
  return { reminder: /** @type {import('./reminders-core.mjs').Reminder} */ (matches[0]) };
}

/**
 * Дія агента cancelReminder -> ПРОПОЗИЦІЯ скасування під ✅ (S2, залишок).
 *
 * Доти це був прямий запис у KV із мотивом «локальний стан, дешево відкотити».
 * Мотив не тримається: власник не побачить, що нагадування зникло, — він просто
 * НЕ отримає його в потрібний момент, і відкочувати буде нічого. Це рівно та
 * дія, якої домагалась би інʼєкція з листа, тож вона йде тим самим шляхом, що
 * й видалення події: показ того, що зникне, і кнопка.
 *
 * Taint-гейт (TAINT_BLOCKED_ACTIONS) НЕ послаблюємо: ✅ — це другий рубіж, а не
 * заміна першому. Після читання пошти дія і далі просто не доходить сюди.
 */
export async function cancelReminderByText(
  /** @type {Env} */ env,
  /** @type {KvBlob} */ parsed,
  /** @type {string} */ matchText,
) {
  const sendText = sendTo(env, parsed);
  // Поріг довжини (S2): збіг іде по ПІДРЯДКУ, тож «о» чи «на» підходить майже
  // під будь-яке нагадування — і коли активне лишається одне, воно тихо
  // скасовується. Для власника такий опис і так безглуздий, а для інʼєкції в
  // тілі листа це найдешевший спосіб щось знищити.
  const q = String(matchText ?? '')
    .trim()
    .toLowerCase();
  if (q.length < MIN_CANCEL_MATCH_LEN) {
    return sendText(
      `🤔 Опис «${matchText}» надто короткий — скажи конкретніше, яке нагадування скасувати. Список — /reminders.`,
    );
  }
  const found = await findReminderByText(env, matchText);
  if (found.reply) return sendText(found.reply);
  // Приведення, а не `!== undefined` у гілці вище: `reply` — рядок, тож перевірка
  // на істинність союз не розрізняє, а міняти умову на нерівність означало б
  // міняти поведінку заради компілятора.
  const reminder = /** @type {import('./reminders-core.mjs').Reminder} */ (found.reminder);
  return stageProposalItem(env, parsed, {
    kind: 'deleteReminder',
    reminderId: reminder.id,
    base: { title: reminder.text, whenMs: reminder.whenMs },
  });
}

/**
 * Дія агента updateReminder -> ПРОПОЗИЦІЯ переносу/перейменування під ✅ (S2).
 *
 * Той самий мотив, що cancelReminderByText: змінений час нагадування власник
 * помітить лише тоді, коли воно не прийде вчасно. Тепер він бачить діф
 * «було → стане» ДО того, як щось змінилось.
 *
 * "when" РЕ-ПАРСИМО тут (LLM подала лише канонічну фразу, час рахує код — той
 * самий інваріант, що createReminderFromText/proposeCalendarChanges), і робимо
 * це ДО показу: непарсибельний час має давати чесну відповідь, а не пропозицію
 * «без змін».
 */
/**
 * @param {Env} env
 * @param {KvBlob} parsed
 * @param {{ reminderText?: unknown, reminderNewText?: unknown, when?: unknown }} opts
 */
export async function updateReminderByText(
  env,
  parsed,
  { reminderText: matchText, reminderNewText, when },
) {
  const sendText = sendTo(env, parsed);
  const found = await findReminderByText(env, matchText);
  if (found.reply) return sendText(found.reply);
  const reminder = /** @type {import('./reminders-core.mjs').Reminder} */ (found.reminder);

  /** @type {KvBlob} */
  const item = {
    kind: 'updateReminder',
    reminderId: reminder.id,
    base: { title: reminder.text, whenMs: reminder.whenMs },
  };
  if (reminderNewText) item.title = reminderNewText;
  if (when) {
    const parsedTime = parseReminderTime(when, Date.now());
    if (!parsedTime) {
      return sendText('🤔 Не зрозумів новий час — спробуй точніше (напр. "завтра о 15:00").');
    }
    item.whenMs = parsedTime.whenMs;
  }
  return stageProposalItem(env, parsed, item);
}
