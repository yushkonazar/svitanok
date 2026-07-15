// Чиста логіка Telegram-вебхука (P0/P1): парсинг апдейтів, перевірка secret-token,
// власник, дедуп, callback_data (кодування/декодування), резолв callback → подія
// для recordEvent. Без I/O — щоб покрити тестами (worker.js імпортує це, KV/HTTP
// робить Worker). Дзеркалить кілька примітивів дашборда (textHash) — щоб чат і
// Mini App домовлялись про ідентичність збереженого.

export const CB_VERSION = 'v1';

// Дзеркало textHash з web/public/index.html — стабільний ID для обраного без url
// (факт/цитата). МАЄ збігатися символ-у-символ, інакше чат і дашборд дедуплять
// збереження по-різному.
export function textHash(s) {
  let h = 0;
  for (let i = 0; i < String(s).length; i++) h = (h * 31 + String(s).charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// Дзеркало escapeHtml з src/core/telegram.ts — Worker не імпортує TS.
// Екранує й `"` (атрибут-безпека href, як у TS-оригіналі).
export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Дзеркало link() з src/core/telegram.ts — url і text екрануються ОКРЕМО
 *  (не конкатенувати перед екрануванням — інакше лапка в url ламає href). */
export function link(url, text) {
  return `<a href="${escapeHtml(url)}">${escapeHtml(text)}</a>`;
}

/** Константний-час порівняння secret-token (X-Telegram-Bot-Api-Secret-Token). */
export function verifyWebhookSecret(header, secret) {
  if (typeof header !== 'string' || typeof secret !== 'string' || !secret) return false;
  if (header.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < header.length; i++) diff |= header.charCodeAt(i) ^ secret.charCodeAt(i);
  return diff === 0;
}

/** Нормалізувати апдейт: тип + ключові поля. Невідоме -> kind:'other'. */
export function parseUpdate(update) {
  if (!update || typeof update !== 'object') return { kind: 'other', updateId: null };
  const updateId = typeof update.update_id === 'number' ? update.update_id : null;
  if (update.callback_query) {
    const cq = update.callback_query;
    return {
      kind: 'callback',
      updateId,
      callbackId: cq.id ?? null,
      fromId: cq.from?.id ?? null,
      chatId: cq.message?.chat?.id ?? null,
      messageId: cq.message?.message_id ?? null,
      threadId: cq.message?.message_thread_id ?? null,
      data: typeof cq.data === 'string' ? cq.data : '',
      replyMarkup: cq.message?.reply_markup ?? null,
    };
  }
  if (update.message) {
    const m = update.message;
    return {
      kind: 'message',
      updateId,
      fromId: m.from?.id ?? null,
      chatId: m.chat?.id ?? null,
      threadId: m.message_thread_id ?? null,
      text: typeof m.text === 'string' ? m.text : '',
    };
  }
  return { kind: 'other', updateId };
}

/** Власник? Порівнюємо from.id з дозволеним chatId (single-user бот). */
export function isOwner(parsed, ownerChatId) {
  if (parsed?.fromId == null || ownerChatId == null) return false;
  return String(parsed.fromId) === String(ownerChatId);
}

/** Дедуп: апдейт уже оброблений, якщо update_id <= lastUpdateId (Telegram передоставляє). */
export function isDuplicate(lastUpdateId, updateId) {
  if (typeof updateId !== 'number') return false; // без id не дедупимо (не блокуємо)
  if (typeof lastUpdateId !== 'number') return false;
  return updateId <= lastUpdateId;
}

/** callback_data: `v1:<dateKey>:<code>[:<idx>]`. Модуль дає `code[:idx]`, дату — render. */
export function buildCallbackData(dateKey, action) {
  const s = `${CB_VERSION}:${dateKey}:${action}`;
  // Telegram-ліміт callback_data — 1..64 байти (UTF-8).
  if (new TextEncoder().encode(s).length > 64) return null;
  return s;
}

/** Розібрати callback_data -> {v,dateKey,code,idx}|null. idx — число або null. */
export function parseCallbackData(data) {
  if (typeof data !== 'string') return null;
  const parts = data.split(':');
  if (parts.length < 3 || parts[0] !== CB_VERSION) return null;
  const [, dateKey, code, idxRaw] = parts;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return null;
  if (!code) return null;
  const idx = idxRaw === undefined ? null : Number(idxRaw);
  if (idxRaw !== undefined && !Number.isInteger(idx)) return null;
  return { v: parts[0], dateKey, code, idx };
}

/**
 * Резолв callback у подію для recordEvent, за опублікованим briefing (той самий,
 * що читає дашборд). Повертає {event, toast} або {error}. Ідентичність айтема —
 * індекс у block.data.items (jobs) або сам блок-сінглтон (fact/stoic).
 */
export function resolveCallback(briefing, code, idx) {
  const blocks = Array.isArray(briefing?.blocks) ? briefing.blocks : [];
  const find = (id) => blocks.find((b) => b && b.id === id);
  switch (code) {
    case 'js':
    case 'ja': {
      const items = find('jobs')?.data?.items;
      const it = Array.isArray(items) ? items[idx] : null;
      if (!it || !it.url) return { error: 'stale' };
      const stage = code === 'js' ? 'saved' : 'applied';
      const event = { type: 'job_stage', url: it.url, title: it.title || '', stage };
      if (code === 'ja' && typeof it.score === 'number' && it.score >= 0) event.fit = it.score;
      return { event, toast: stage === 'saved' ? '💾 Збережено' : '✅ Позначено «подав»' };
    }
    case 'sf': {
      const text = find('fact')?.data?.fact;
      if (!text) return { error: 'stale' };
      return {
        event: { type: 'save_item', kind: 'fact', id: textHash(text), title: text },
        toast: '🔖 Факт збережено',
      };
    }
    case 'sq': {
      const d = find('stoic')?.data;
      if (!d?.text) return { error: 'stale' };
      const title = `«${d.text}» — ${d.author}`;
      return {
        event: { type: 'save_item', kind: 'quote', id: textHash(title), title },
        toast: '🔖 Цитату збережено',
      };
    }
    default:
      return { error: 'unknown' };
  }
}

/**
 * Дзеркало buildMiniAppButton з src/core/telegram.ts. Пріоритет:
 * 1. botUsername заданий -> Direct Link Mini App (t.me/<username>?startapp) —
 *    завжди launch-ить повноцінний Mini App з initData, і з групи, і з
 *    приватного чату (обходить обмеження web_app-кнопки нижче). Потребує
 *    одноразового owner-кроку в @BotFather (Configure Mini App).
 * 2. botUsername не заданий -> фолбек за chatId (стандартна конвенція
 *    Telegram: групи/супергрупи від'ємні): chatId < 0 -> звичайна url-кнопка
 *    (без initData, дашборд деградує на SAMPLE, §H1); інакше -> web_app
 *    (Telegram Bot API дозволяє web_app ЛИШЕ в приватних чатах —
 *    BUTTON_TYPE_INVALID у групі інакше).
 */
export function buildMiniAppButton(text, url, chatId, botUsername) {
  const username = botUsername ? String(botUsername).trim().replace(/^@/, '') : '';
  if (username) return { text, url: `https://t.me/${username}?startapp` };
  const isGroup = chatId != null && Number(chatId) < 0;
  return isGroup ? { text, url } : { text, web_app: { url } };
}

/** Позначити натиснуту кнопку галкою (✓) у reply_markup — легкий зворотний звʼязок. */
export function markButtonDone(replyMarkup, tappedData) {
  const rows = replyMarkup?.inline_keyboard;
  if (!Array.isArray(rows)) return replyMarkup;
  return {
    inline_keyboard: rows.map((row) =>
      Array.isArray(row)
        ? row.map((btn) =>
            btn && btn.callback_data === tappedData && !String(btn.text).startsWith('✓')
              ? { ...btn, text: `✓ ${btn.text}` }
              : btn,
          )
        : row,
    ),
  };
}

/* ══════════════════════════════════════════════════════════════════════
   /clear (§C5) — ring-buffer message_id надісланих БОТОМ повідомлень, per
   чат+тема. Дозволяє видалити N останніх, не читаючи всю історію чату
   (Telegram Bot API не дає прочитати/перелічити чужу історію взагалі —
   бот пам'ятає лише те, що сам надіслав). Зберігається в ОКРЕМОМУ KV-
   ключі ('sentMessages', worker.js), не в 'state' — щоб не додавати
   зайвий read-modify-write (і вікно гонки) на КОЖНУ відповідь бота до
   блоба, який і так ділять reminders/roadmapProgress/mockWeights/...
   ══════════════════════════════════════════════════════════════════════ */

// На чат+тему; більш ніж достатньо для будь-якого розумного /clear N (max 50).
const SENT_MESSAGES_CAP = 50;

/** Ключ ring-buffer-а в об'єкті sentMessages: один на чат+тему. */
export function sentMessagesKey(chatId, threadId) {
  return `${chatId}:${threadId ?? ''}`;
}

/** Додати message_id у ring buffer (чиста — повертає новий об'єкт, капнутий). */
export function recordSentMessage(sentMessages, chatId, threadId, messageId) {
  const key = sentMessagesKey(chatId, threadId);
  const store = sentMessages && typeof sentMessages === 'object' ? sentMessages : {};
  const list = Array.isArray(store[key]) ? store[key] : [];
  return { ...store, [key]: [...list, messageId].slice(-SENT_MESSAGES_CAP) };
}

/** Останні N message_id для чат+теми (найновіші останні) — кандидати на /clear. */
export function lastSentMessages(sentMessages, chatId, threadId, n) {
  const list = sentMessages?.[sentMessagesKey(chatId, threadId)];
  return Array.isArray(list) ? list.slice(-n) : [];
}

/** Розібрати аргумент /clear -> клампована кількість [1,maxN]; невалідне/відсутнє -> defaultN.
 *  maxN=40 (не 50) — запас перед типовим лімітом ~50 subrequests/інвокацію
 *  Cloudflare Worker: /clear ще й читає+пише sentMessages (±2) і шле
 *  підсумкове повідомлення (ще ±2) поверх самих deleteMessage-викликів. */
export function parseClearCount(args, defaultN = 20, maxN = 40) {
  const n = parseInt(args, 10);
  if (!Number.isFinite(n) || n <= 0) return defaultN;
  return Math.min(maxN, n);
}

/** Розбити масив на шматки розміром size (останній може бути коротшим) —
 *  для /clear: видаляти пачками, не всі N одразу (обережність до rate-limit
 *  Telegram) і не повністю послідовно (менше wall-clock часу в ctx.waitUntil). */
export function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Підсумкове повідомлення після спроби видалення (Telegram не дає видалити
 *  повідомлення старші за 48 год — deleted може бути менше за attempted). */
export function formatClearResult(deleted, attempted) {
  if (attempted === 0) return 'Нема що очищати — я ще не памʼятаю своїх повідомлень тут.';
  return `🗑 Видалено ${deleted} із ${attempted} повідомлень (старші за 48 год Telegram не дає видалити).`;
}

/**
 * Скільки мс кулдауну /brief ще лишилось (0 = можна запускати) — SL2. Захищає
 * від спаму `workflow_dispatch` (палить хвилини Actions + квоту KV/новин), бо
 * guard гасить лише подвійну ВІДПРАВКУ, а джоба однаково стартує. Некоректний
 * lastMs (не число / ≤0) -> 0 (дозволити, перший запуск).
 */
export function briefCooldownRemainingMs(lastMs, nowMs, cooldownMs) {
  if (typeof lastMs !== 'number' || !(lastMs > 0)) return 0;
  const elapsed = nowMs - lastMs;
  return elapsed >= cooldownMs ? 0 : cooldownMs - elapsed;
}

// Вікно ранкового авто-dispatch (київські години, кінець НЕвключний).
// sendGuard оркестратора має вікно [8,12) (config.sendHour/sendWindowHours), але
// наше вікно закривається НА ГОДИНУ РАНІШЕ (ревʼю A): між workflow_dispatch і
// самим sendGuard стоїть черга Actions + завантаження раннера + npm ci + install
// claude CLI — хвилини. Спроба об 11:57 доїхала б до guard'а вже о 12:0x
// («after window») і скіпнулась би, а мітка dispatch була б поставлена -> день
// БЕЗ брифінгу взагалі. Остання спроба о 10:55 лишає guard'у ~годину запасу.
export const BRIEF_WINDOW_START_HOUR = 8;
export const BRIEF_WINDOW_END_HOUR = 11;
// Мінімальний проміжок між двома dispatch (ревʼю A): ручний /brief не ставить
// денну мітку (він може бути й поза вікном), тож без цього гейта авто-спроба за
// 5 хв після /brief вистрілила б ДРУГИЙ workflow_dispatch — холостий Actions-ран.
// Водночас це НЕ вбиває ретрай: якщо dispatch впав, наступна спроба буде за 15 хв.
export const MIN_DISPATCH_GAP_MS = 15 * 60_000;

/**
 * A2: чи має цей тік пʼятихвилинного крону вистрілити workflow_dispatch брифінгу.
 *
 * Раніше dispatch висів на ЄДИНІЙ спробі (погодинний крон, kyivHour()===8).
 * 14.07 jitter крону Cloudflare (Free) відсунув її на ~50 хв — брифінг прийшов
 * о 08:56. Тепер спроб до 36 у вікні, а від дублів тримають три умови:
 *   lastSentDate  — оркестратор уже надіслав брифінг сьогодні (нема чого диспатчити);
 *   lastAutoDate  — ми вже успішно диспатчили сьогодні (мітка ставиться ЛИШЕ
 *                   після підтвердження GitHub, тож збій ретраїться наступним тіком);
 *   lastDispatchMs — БУДЬ-ЯКИЙ dispatch (у т.ч. ручний /brief) свіжіший за 15 хв.
 */
export function shouldAutoDispatchBrief({
  kyivHour,
  todayKey,
  nowMs,
  lastAutoDate,
  lastDispatchMs,
  lastSentDate,
}) {
  if (!Number.isFinite(kyivHour)) return false;
  if (kyivHour < BRIEF_WINDOW_START_HOUR || kyivHour >= BRIEF_WINDOW_END_HOUR) return false;
  if (typeof todayKey !== 'string' || !todayKey) return false;
  if (lastSentDate === todayKey) return false;
  if (lastAutoDate === todayKey) return false;
  if (
    Number.isFinite(nowMs) &&
    Number.isFinite(lastDispatchMs) &&
    lastDispatchMs > 0 &&
    nowMs - lastDispatchMs < MIN_DISPATCH_GAP_MS
  ) {
    return false;
  }
  return true;
}

/* ══════════════════════════════════════════════════════════════════════
   Команди / Налаштування (Блок P4) — parseCommand + текстові форматери.
   ══════════════════════════════════════════════════════════════════════ */

// Реєстр для Telegram "/" меню (setMyCommands) — команда без "/" + короткий опис.
// Фаза C: /mock прибрано (був літеральним STUB_REPLY, обіцяв неготову функцію);
// /help відокремлено від /start (§C3); /reminders (список+скасувати, §C4) і
// /clear (§C5) додано за рекомендацією аудиту команд vs Mini App.
export const COMMANDS = [
  { command: 'start', description: 'Почати роботу з ботом' },
  { command: 'help', description: 'Список усіх команд' },
  { command: 'brief', description: 'Запустити ранковий брифінг' },
  { command: 'stats', description: 'Стрік і статистика' },
  { command: 'jobs', description: 'Активна воронка вакансій' },
  { command: 'save', description: 'Збережене (факти/цитати/новини)' },
  { command: 'settings', description: 'Відкрити Mini App' },
  { command: 'remind', description: 'Нагадування (напр. через 20 хв ...)' },
  { command: 'reminders', description: 'Список активних нагадувань' },
  { command: 'plan', description: 'План дня (LLM читає календар, пропонує таймлайн)' },
  { command: 'roadmap', description: 'IT-роадмеп (теми, прогрес)' },
  { command: 'clear', description: 'Видалити останні N моїх повідомлень (за замовч. 20)' },
  { command: 'whereami', description: 'chat_id/thread_id цього чату (для налаштування тем)' },
];

// Reply-keyboard «пад» швидких дій (персистентний, шлеться раз на /start).
// Фаза B2: 3-й рядок (Налаштування/Роадмеп) — компенсація видаленої теми
// «Команди» (та ніколи не мала прив'язки в коді — команди топік-агностичні,
// forum-тема була суто організаційною), щоб більше команд лишалось під рукою
// без окремої теми.
export const REPLY_KEYBOARD = [
  ['📋 Статистика', '💼 Вакансії'],
  ['🔖 Збережене', '🔄 Брифінг'],
  ['⚙️ Налаштування', '🗺 Роадмеп'],
];

// Лейбл reply-keyboard кнопки -> та сама команда, що й відповідний "/xxx".
const KEYBOARD_ALIASES = {
  '📋 Статистика': 'stats',
  '💼 Вакансії': 'jobs',
  '🔖 Збережене': 'save',
  '🔄 Брифінг': 'brief',
  '⚙️ Налаштування': 'settings',
  '🗺 Роадмеп': 'roadmap',
};

/**
 * Розібрати вхідне повідомлення на команду: slash-команда (з опційним
 * "@botname" у групових чатах) АБО лейбл reply-keyboard — обидва мапляться
 * в один канонічний {cmd, args}. Звичайний текст (майбутній асистент, P2) -> null.
 */
export function parseCommand(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (KEYBOARD_ALIASES[trimmed]) return { cmd: KEYBOARD_ALIASES[trimmed], args: '' };
  if (!trimmed.startsWith('/')) return null;
  const [head, ...rest] = trimmed.slice(1).split(/\s+/);
  const cmd = head ? head.split('@')[0].toLowerCase() : '';
  if (!cmd) return null;
  return { cmd, args: rest.join(' ') };
}

/**
 * Unicode прогрес-бар (█ заповнено/░ порожньо), фіксована ширина. total<=0 -> ''
 * (немає сенсу малювати бар без знаменника).
 *
 * Обгорнутий у `[...]`+`<code>` (моноширинний, візуально відмежований пілюлею
 * в клієнтах Telegram) НАВМИСНО: 10 підряд символів ░/█ без меж у звичайному
 * пропорційному шрифті чату зливаються в суцільну «хатчовану» пляму — на
 * практиці виглядає як зіпсоване/зафарбоване зображення, а не як індикатор
 * прогресу (баг, знайдений на живому скріншоті). Дужки+код-блок дають чітку
 * межу й моноширинність незалежно від клієнта/шрифту.
 */
export function progressBar(done, total, width = 10) {
  if (!(total > 0)) return '';
  const filled = Math.max(0, Math.min(width, Math.round((done / total) * width)));
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  return `<code>[${bar}]</code>`;
}

const STAGE_LABEL = {
  saved: '💾 Збережено',
  applied: '✅ Подано',
  interview: '🗣 Співбесіда',
  offer: '🎉 Офер',
};
const STAGE_ORDER = ['saved', 'applied', 'interview', 'offer'];

/** /jobs — активна воронка вакансій, згрупована за стадією (з /api/stats.funnelList). */
export function formatJobsMessage(funnelList) {
  const list = Array.isArray(funnelList) ? funnelList : [];
  if (list.length === 0) {
    return '💼 <b>Воронка вакансій</b>\n\nПоки порожньо — тисни 💾/✅ під вакансіями в брифінгу.';
  }
  const byStage = new Map(STAGE_ORDER.map((st) => [st, []]));
  for (const it of list) if (byStage.has(it.stage)) byStage.get(it.stage).push(it);

  const lines = ['💼 <b>Воронка вакансій</b>', ''];
  for (const st of STAGE_ORDER) {
    const items = byStage.get(st);
    if (items.length === 0) continue;
    lines.push(STAGE_LABEL[st]);
    for (const it of items) lines.push(`• ${escapeHtml(it.title || it.url || '?')}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

const KIND_ICON = { news: '🗞', fact: '🧠', quote: '🏛', question: '🎤' };

/** /save — останнє збережене (факти/цитати/новини/питання), з /api/stats.savedList.
 *  Фаза C2: news-записи мають url (Mini App-версія лінкує) — тепер клікабельні
 *  й тут; fact/quote/question url не мають (dedup по id=textHash), лишаються
 *  плейн-текстом, як і раніше. */
export function formatSavedMessage(savedList) {
  const list = Array.isArray(savedList) ? savedList : [];
  if (list.length === 0) {
    return '🔖 <b>Збережене</b>\n\nПоки нічого — тисни 🔖/💾 в брифінгу.';
  }
  const lines = ['🔖 <b>Збережене</b>', ''];
  for (const it of list) {
    const icon = KIND_ICON[it.kind] || '🔖';
    const label = it.title || '?';
    lines.push(it.url ? `${icon} ${link(it.url, label)}` : `${icon} ${escapeHtml(label)}`);
  }
  return lines.join('\n');
}

/** /stats — стрік+ціль+воронка+слабкі mock-теми, з /api/stats (aggregateStats). */
export function formatStatsMessage(stats) {
  const s = stats || {};
  const streaks = s.streaks || {};
  const funnel = s.funnel || {};
  const goal = s.goal || {};
  const goalBar = progressBar(goal.weeklyApplied ?? 0, goal.weeklyTarget ?? 0);
  const lines = [
    '📊 <b>Статистика</b>',
    '',
    `🔥 Стрік відкриттів: ${streaks.openDays ?? 0} дн. (рекорд ${streaks.bestOpenDays ?? 0})`,
    `🎯 Тижнева ціль: ${goalBar ? goalBar + ' ' : ''}${goal.weeklyApplied ?? 0}/${goal.weeklyTarget ?? 0} подано`,
    `💼 Воронка: ${funnel.saved ?? 0} збережено · ${funnel.applied ?? 0} подано · ` +
      `${funnel.interview ?? 0} співбесід · ${funnel.offer ?? 0} офер(и)`,
    `🎤 Mock-стрік: ${streaks.mockDays ?? 0} дн.`,
  ];
  if (typeof s.avgFitApplied === 'number') {
    lines.push(`📈 Середній fit поданих: ${s.avgFitApplied}%`);
  }
  const weak = (s.mock?.weakTopics ?? []).filter((t) => t.value > 0).slice(0, 3);
  if (weak.length > 0) {
    lines.push(`⚠️ Слабкі теми: ${weak.map((t) => escapeHtml(t.name)).join(', ')}`);
  }
  return lines.join('\n');
}

/**
 * /whereami — chat_id + thread_id ПОТОЧНОГО чату/теми. Головний спосіб
 * знайти реальні id тем після створення forum-супергрупи (натиснути в
 * кожній темі, скопіювати значення для TOPIC_*-секретів) — без потреби
 * грепати логи Worker'а.
 */
export function formatWhereAmI(chatId, threadId) {
  const lines = [
    '📍 <b>Де я</b>',
    '',
    `chat_id: <code>${escapeHtml(String(chatId ?? '?'))}</code>`,
    `thread_id: <code>${threadId == null ? 'немає (не тема форуму)' : escapeHtml(String(threadId))}</code>`,
  ];
  return lines.join('\n');
}
