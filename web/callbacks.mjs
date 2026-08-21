// Обробники inline-кнопок (Фаза 5, модуляризація worker.js, план A2 §5).
//
// Кожна кнопка бота приходить сюди як `callback_data` у власному просторі
// префіксів: `v1:` (кнопки брифінгу), `rm:`/`rs:`/`rc:`/`rk:`/`ru:` (нагадування),
// `sl:` (ліг спати), `ev:` (події з /agenda), `rd:` (роадмеп), `pd:`
// (пропозиції — вони в proposals.mjs).
//
// ⚠️ ПРОСТОРИ НЕ МОЖУТЬ БУТИ ПРЕФІКСАМИ ОДИН ОДНОГО. `rm:` бере ВЕСЬ залишок
// як id (без внутрішнього split), тож підпростір усередині нього зламав би
// snooze-парсинг — саме тому скасування дістало окреме `rc:`, а «виконано» —
// `rk:` (бо `rd:` уже зайняв роадмеп). Додаючи новий простір, звіряйся з цим
// списком, а не з інтуїцією.
//
// ІНВАРІАНТ ВІДПОВІДІ: кожен обробник повертає ТЕКСТ ТОСТУ. Telegram чекає на
// answerCallbackQuery, і мовчазна кнопка виглядає як зависла — тому навіть
// «застаріло» й «не вдалось» мають свій текст.

import { parseCallbackData, resolveCallback, markButtonDone, escapeHtml } from './tg-core.mjs';
import {
  cancelReminder,
  listActive,
  snoozeReminder,
  snoozeReminderPreset,
  SNOOZE_MINUTES,
  formatReminderDone,
  buildRemindersKeyboard,
  formatRemindersListMessage,
  addDaysToDateKey,
} from './reminders-core.mjs';
import {
  toggleProgress,
  progressKey,
  findTopic,
  findSubtopic,
  formatTopicMessage,
  buildTopicKeyboard,
  formatRootMessage,
  buildRootKeyboard,
} from './roadmap-core.mjs';
import {
  formatAgendaMessage,
  buildAgendaKeyboard,
  buildAgendaCallbackData,
  buildMapsUrl,
} from './calendar-core.mjs';
import { kyivDateKey } from './kyiv-time.mjs';
import { loadState, updateState } from './kv-store.mjs';
import { applyEvent } from './api-dashboard.mjs';
import { readCalendarRange, getCalendarEvent } from './google.mjs';
import { tgCall, sendTo } from './telegram-client.mjs';
import { rememberAssistantQuestion } from './assistant-memory.mjs';
import { stageItemEdit, stageItemDelete } from './proposals.mjs';
import { ID_RE } from './agent-core.mjs';
import { loadBriefingForDate } from './kv-store.mjs';

/** snooze; окремий простір від v1:<dateKey>:... (P1). */
export const REMINDER_CB_PREFIX = 'rm:';

/** Обробити callback: застосувати подію (якщо валідна) + позначити кнопку ✓;
 *  повертає текст тосту для answerCallbackQuery (успіх/застаріло/невідомо). */
export async function resolveCallbackToast(/** @type {Env} */ env, /** @type {KvBlob} */ parsed) {
  const cb = parseCallbackData(parsed.data);
  if (!cb) return '⚠️ Застаріла кнопка.';

  const briefing = await loadBriefingForDate(env, cb.dateKey);
  const resolved = resolveCallback(briefing, cb.code, cb.idx);
  if (resolved.error === 'stale') return '⚠️ Ця кнопка вже застаріла.';
  if (resolved.error) return '⚠️ Невідома дія.';

  // applyEvent сам читає/пише 'state' (jobPrefs/mockWeights) — виклик тут не
  // конфліктує з lastUpdateId-записом у handleTelegramWebhook (той перечитує
  // 'state' ПІСЛЯ цього виклику, а не переносить сюди свою стару копію).
  await applyEvent(env, resolved.event);
  if (parsed.chatId != null && parsed.messageId != null && parsed.replyMarkup) {
    await tgCall(env, 'editMessageReplyMarkup', {
      chat_id: parsed.chatId,
      message_id: parsed.messageId,
      reply_markup: markButtonDone(parsed.replyMarkup, parsed.data),
    });
  }
  return resolved.toast;
}

/**
 * Спільна логіка snooze/cancel (§C4): завантажити стан, перевірити існування
 * нагадування, мутувати (mutate — snoozeReminder чи cancelReminder), зберегти,
 * тікнути кнопку (markButtonDone+editMessageReplyMarkup — одноразовий статус-
 * тік, не перерендер усього повідомлення, на відміну від roadmap, де
 * editMessageText доречний для навігації меню). Розрізняються лише mutate-
 * функцією й текстом тосту.
 */
/**
 * @param {Env} env
 * @param {KvBlob} parsed
 * @param {string} reminderId
 * @param {(reminders: any[], id: string, nowMs: number) => any[]} mutate
 * @param {string} successToast
 */
async function resolveReminderAction(env, parsed, reminderId, mutate, successToast) {
  const state = await loadState(env);
  const reminders = Array.isArray(state.reminders) ? state.reminders : [];
  if (!reminders.some((/** @type {KvBlob} */ r) => r.id === reminderId))
    return '⚠️ Це нагадування вже неактуальне.';

  const nowMs = Date.now();
  await updateState(env, (s) => ({
    ...s,
    reminders: mutate(Array.isArray(s.reminders) ? s.reminders : [], reminderId, nowMs),
  }));
  if (parsed.chatId != null && parsed.messageId != null && parsed.replyMarkup) {
    await tgCall(env, 'editMessageReplyMarkup', {
      chat_id: parsed.chatId,
      message_id: parsed.messageId,
      reply_markup: markButtonDone(parsed.replyMarkup, parsed.data),
    });
  }
  return successToast;
}

/** Обробити snooze-callback (`rm:<id>`, окремий простір від v1:<dateKey>:... з P1). */
export async function resolveReminderSnooze(
  /** @type {Env} */ env,
  /** @type {KvBlob} */ parsed,
  /** @type {string} */ reminderId,
) {
  // ⚠️ РЯДОК ВІД КОНСТАНТИ, не літерал. Доти тут стояло жорстке «10 хв», не
  // звʼязане зі SNOOZE_MINUTES нічим: зміни константу — і бот щовечора
  // писатиме користувачеві число, якого не робить. Сюїт цього не ловив
  // (tests/reminders-core.test.ts рахував очікування з тієї самої константи),
  // тобто це була нетестована брехня в інтерфейсі, що чекала свого дня.
  return resolveReminderAction(
    env,
    parsed,
    reminderId,
    snoozeReminder,
    `😴 Відкладено на ${SNOOZE_MINUTES} хв`,
  );
}

/** Обробити `rs:<presetIdx>:<id>` (extra b) — snooze за одним із трьох пресетів. */
export async function resolveReminderSnoozePreset(
  /** @type {Env} */ env,
  /** @type {KvBlob} */ parsed,
  /** @type {number} */ presetIdx,
  /** @type {string} */ reminderId,
) {
  return resolveReminderAction(
    env,
    parsed,
    reminderId,
    (/** @type {any[]} */ reminders, /** @type {string} */ id, /** @type {number} */ nowMs) =>
      snoozeReminderPreset(reminders, id, presetIdx, nowMs),
    '😴 Відкладено',
  );
}

/** Обробити cancel-callback (`rc:<id>`, §C4) — видалити нагадування назавжди. */
export async function resolveReminderCancel(
  /** @type {Env} */ env,
  /** @type {KvBlob} */ parsed,
  /** @type {string} */ reminderId,
) {
  return resolveReminderAction(env, parsed, reminderId, cancelReminder, '🗑 Нагадування скасовано');
}

/**
 * Обробити `sl:1` (тап «🌙 Ліг спати», Блок «Сон») — той самий applyEvent, що
 * /api/event і решта callback-подій (jobPrefs/mockWeights/stats не
 * розходяться між джерелами). Той самий стиль редагування, що rk: («✅
 * Виконано») — переписуємо повідомлення й прибираємо кнопку повністю: другий
 * тап на ту саму ніч і так нічого не змінить (recordEvent ідемпотентний), але
 * бачити стару кнопку після підтвердження нема сенсу.
 */
export async function resolveSleepStart(/** @type {Env} */ env, /** @type {KvBlob} */ parsed) {
  await applyEvent(env, { type: 'sleepStart' });
  if (parsed.chatId != null && parsed.messageId != null) {
    await tgCall(env, 'editMessageText', {
      chat_id: parsed.chatId,
      message_id: parsed.messageId,
      text: '🌙 <b>Ліг спати</b> — записав.',
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [] },
    });
  }
  return '🌙 Записав';
}

/**
 * Обробити `rk:<id>` («✅ Виконано», фідбек власника) — на відміну від
 * snooze/cancel (лише тік кнопки, resolveReminderAction) тут ПЕРЕПИСУЄМО ВСЕ
 * повідомлення (editMessageText) і прибираємо клавіатуру ПОВНІСТЮ (порожній
 * inline_keyboard) — вимога явно каже «всі кнопки прибираються, статус видно
 * одразу», а не просто тік однієї з них. Мутація — те саме справжнє видалення,
 * що cancelReminder (нема окремого поля done — статус лише через видалення,
 * той самий інваріант, що вже задокументовано в reminders-core.mjs).
 */
export async function resolveReminderDone(
  /** @type {Env} */ env,
  /** @type {KvBlob} */ parsed,
  /** @type {string} */ reminderId,
) {
  const state = await loadState(env);
  const reminders = Array.isArray(state.reminders) ? state.reminders : [];
  const reminder = reminders.find((r) => r.id === reminderId);
  if (!reminder) return '⚠️ Це нагадування вже неактуальне.';

  await updateState(env, (s) => ({
    ...s,
    reminders: cancelReminder(Array.isArray(s.reminders) ? s.reminders : [], reminderId),
  }));
  if (parsed.chatId != null && parsed.messageId != null) {
    await tgCall(env, 'editMessageText', {
      chat_id: parsed.chatId,
      message_id: parsed.messageId,
      text: formatReminderDone(reminder.text),
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [] },
    });
  }
  return '✅ Виконано';
}

/**
 * Обробити `rc:all` (extra c, пакетне скасування) — на відміну від решти
 * reminder-дій, тут ціле повідомлення переписується (editMessageText), не
 * лише тік кнопки: список активних змінюється ПОВНІСТЮ, старий текст одразу
 * зробився б неправдивим (усе ще показував би скасовані пункти).
 */
export async function resolveReminderCancelAll(
  /** @type {Env} */ env,
  /** @type {KvBlob} */ parsed,
) {
  const state = await loadState(env);
  const active = listActive(state.reminders);
  if (active.length === 0) return 'Нема що скасовувати.';

  // Скасовуємо ПОІМЕННО, а не «перезаписуємо список»: на свіжішій копії міг
  // зʼявитись новий пункт, і пакетне скасування не має його зачепити.
  const ids = active.map((/** @type {KvBlob} */ r) => r.id);
  const next = await updateState(env, (s) => ({
    ...s,
    reminders: ids.reduce(
      (rs, id) => cancelReminder(rs, id),
      Array.isArray(s.reminders) ? s.reminders : [],
    ),
  }));

  if (parsed.chatId != null && parsed.messageId != null) {
    const keyboard = buildRemindersKeyboard(next.reminders);
    await tgCall(env, 'editMessageText', {
      chat_id: parsed.chatId,
      message_id: parsed.messageId,
      text: formatRemindersListMessage(next.reminders),
      parse_mode: 'HTML',
      ...(keyboard.inline_keyboard.length ? { reply_markup: keyboard } : {}),
    });
  }
  return `🗑 Скасовано ${active.length}`;
}

/** Київський DD.MM HH:MM — для питань редагування нагадування (людський час,
 *  не epoch). */
function kyivWhen(/** @type {number} */ ms) {
  return new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ms));
}

/**
 * Обробити `ru:<id>` — «✏️ Редагувати» на нагадуванні: питання + синтетична
 * репліка історії (та сама механіка, що `pd:o` для подій, БЕЗ
 * assistantPending — reminder-мутації прямі/без confirm, той самий мотив, що
 * createReminder/cancelReminder/updateReminder). Наступна вільна репліка
 * власника піде через runAssistantAgent -> updateReminder action
 * (reminderText — сам текст нагадування, природний пошуковий ключ, той
 * самий, що cancelReminderByText уже використовує — жодного id не треба).
 */
export async function resolveReminderEditPrompt(
  /** @type {Env} */ env,
  /** @type {KvBlob} */ parsed,
  /** @type {string} */ reminderId,
) {
  const state = await loadState(env);
  const reminders = Array.isArray(state.reminders) ? state.reminders : [];
  const r = reminders.find((x) => x.id === reminderId && !x.firedTs);
  if (!r) return '⚠️ Це нагадування вже неактуальне.';

  if (parsed.chatId != null && parsed.messageId != null && parsed.replyMarkup) {
    await tgCall(env, 'editMessageReplyMarkup', {
      chat_id: parsed.chatId,
      message_id: parsed.messageId,
      reply_markup: markButtonDone(parsed.replyMarkup, parsed.data),
    });
  }
  const question = `✏️ Що змінити в нагадуванні «${r.text}» (${kyivWhen(r.whenMs)})? Напиши новий текст і/або час.`;
  await sendTo(env, parsed)(question);
  await rememberAssistantQuestion(env, parsed, question);
  return '✍️ Напиши, що змінити';
}

/** Прочитати найближчий тиждень і повернути {events}|null (null -> читання впало). */
export async function readUpcomingWeek(/** @type {Env} */ env) {
  const today = kyivDateKey();
  return readCalendarRange(env, today, addDaysToDateKey(today, 7));
}

/**
 * Обробити `ev:<action>:<id>` — /agenda: v (деталі пункту), e (стейджити
 * редагування), d (стейджити видалення), b (назад до списку). Той самий
 * ID_RE-гард, що mailId/eventId у sanitizeProposal — id іде в шлях URL
 * Google Calendar API, callback_data теоретично може бути підроблений
 * (хоч webhook уже гейтить не-власника раніше в ланцюжку).
 */
export async function resolveAgendaCallback(
  /** @type {Env} */ env,
  /** @type {KvBlob} */ parsed,
  /** @type {KvBlob} */ cb,
) {
  if (cb.action === 'b') {
    const events = await readUpcomingWeek(env);
    if (!events) return '🔌 Не вдалось прочитати календар.';
    const now = Date.now();
    if (parsed.chatId != null && parsed.messageId != null) {
      await tgCall(env, 'editMessageText', {
        chat_id: parsed.chatId,
        message_id: parsed.messageId,
        text: formatAgendaMessage(events, now),
        parse_mode: 'HTML',
        reply_markup: buildAgendaKeyboard(events, now),
      });
    }
    return '';
  }

  if (!ID_RE.test(cb.id)) return '⚠️ Некоректний id.';

  if (cb.action === 'e') return stageItemEdit(env, parsed, cb.id);
  if (cb.action === 'd') return stageItemDelete(env, parsed, cb.id);

  // 'v' — деталі одного пункту: назва/час + Редагувати/Видалити/Назад.
  const fresh = await getCalendarEvent(env, cb.id);
  if (!fresh) return '🤔 Цю подію вже не знайти — можливо, видалено.';
  const editCb = buildAgendaCallbackData('e', cb.id);
  const delCb = buildAgendaCallbackData('d', cb.id);
  const backCb = buildAgendaCallbackData('b', cb.id); // id 'b' ігнорує — лише формальність guard'а
  if (parsed.chatId != null && parsed.messageId != null && editCb && delCb && backCb) {
    const mapsUrl = buildMapsUrl(fresh.location);
    const locLine = mapsUrl ? `\n📍 <a href="${mapsUrl}">${escapeHtml(fresh.location)}</a>` : '';
    await tgCall(env, 'editMessageText', {
      chat_id: parsed.chatId,
      message_id: parsed.messageId,
      text: `📅 <b>${escapeHtml(fresh.title)}</b>\n${kyivWhen(fresh.startMs ?? 0)}${locLine}`,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✏️ Редагувати', callback_data: editCb },
            { text: '🗑 Видалити', callback_data: delCb },
          ],
          [{ text: '⬅️ Назад', callback_data: backCb }],
        ],
      },
    });
  }
  return '';
}

/**
 * Обробити rd:r / rd:t:<topicId> / rd:s:<topicId>:<subtopicId> — навігація
 * теми→підпункти→toggle (Блок P3, 🗺Роадмеп). editMessageText В ОДНОМУ
 * виклику з reply_markup у тому самому тілі (не два окремих API-виклики) —
 * ре-рендерить те саме повідомлення на місці замість нового. root/topic —
 * лише ре-рендер (без KV-запису); toggle — ОДИН запис state.roadmapProgress,
 * тоді ре-рендер тієї самої теми. Невідомий topicId/subtopicId (застарілий
 * контент) -> toast замість крашу.
 */
export async function resolveRoadmapCallback(
  /** @type {Env} */ env,
  /** @type {KvBlob} */ parsed,
  /** @type {KvBlob} */ cb,
) {
  if (parsed.chatId == null || parsed.messageId == null) return '';
  const editText = (/** @type {string} */ text, /** @type {KvBlob} */ replyMarkup) =>
    tgCall(env, 'editMessageText', {
      chat_id: parsed.chatId,
      message_id: parsed.messageId,
      text,
      parse_mode: 'HTML',
      reply_markup: replyMarkup,
    });

  if (cb.kind === 'root') {
    const progress = (await loadState(env)).roadmapProgress ?? {};
    await editText(formatRootMessage(progress), buildRootKeyboard(progress));
    return '';
  }

  if (cb.kind === 'topic') {
    const topic = findTopic(cb.topicId);
    if (!topic) return '⚠️ Ця тема більше не існує.';
    const progress = (await loadState(env)).roadmapProgress ?? {};
    await editText(formatTopicMessage(topic, progress), buildTopicKeyboard(topic, progress));
    return '';
  }

  // toggle
  const topic = findTopic(cb.topicId);
  const subtopic = findSubtopic(topic, cb.subtopicId);
  if (!topic || !subtopic) return '⚠️ Цей підпункт більше не існує.';

  const state = await loadState(env);
  const key = progressKey(cb.topicId, cb.subtopicId);
  const wasDone = key in (state.roadmapProgress ?? {});
  const toggledAt = new Date().toISOString();
  // Тут перемикач — це і є намір власника, тож патч ЦІЛИТЬСЯ в результат, а не
  // повторює toggle наосліп: інакше на свіжішій копії, де прапорець уже такий,
  // як ми хочемо, другий виклик перевернув би його назад.
  const next = await updateState(env, (s) => {
    const progress = s.roadmapProgress ?? {};
    if (key in progress === !wasDone) return s; // копія вже в цільовому стані
    return {
      ...s,
      roadmapProgress: toggleProgress(progress, cb.topicId, cb.subtopicId, toggledAt),
    };
  });

  await editText(
    formatTopicMessage(topic, next.roadmapProgress),
    buildTopicKeyboard(topic, next.roadmapProgress),
  );
  return wasDone ? '↩️ Знято позначку' : '✅ Позначено';
}
