// Worker: статика дашборда (ASSETS) + /briefing.json із KV + ТОЧНИЙ планувальник
// (08:00 Київ -> GitHub workflow_dispatch) + DEAD-MAN'S-SWITCH (10:00 Київ) +
// НАГАДУВАННЯ (кожні ~5 хв, Блок P2a) + /api/vote, /api/event (запис подій —
// авторизація власника через Telegram WebApp initData), /api/stats (читання
// агрегату), /api/telegram (вебхук — Блок P0/P1/P4, авторизація через
// X-Telegram-Bot-Api-Secret-Token). KV namespace BRIEFING, ключі
// `latest`/`state`(+`reminders`)/`stats`/`briefing:<date>`.

import { recordEvent, aggregateStats } from './stats-core.mjs';
import {
  verifyWebhookSecret,
  parseUpdate,
  isOwner,
  isDuplicate,
  parseCallbackData,
  resolveCallback,
  markButtonDone,
  parseCommand,
  formatStatsMessage,
  formatJobsMessage,
  formatSavedMessage,
  COMMANDS,
  REPLY_KEYBOARD,
} from './tg-core.mjs';
import {
  parseReminderTime,
  addReminder,
  dueReminders,
  markFired,
  snoozeReminder,
  formatReminderConfirm,
  formatReminderFired,
} from './reminders-core.mjs';

const REMINDER_CB_PREFIX = 'rm:'; // окремий простір callback_data від v1:<dateKey>:... (P1)

const GH_DISPATCH_URL =
  'https://api.github.com/repos/yushkonazar/svitanok/actions/workflows/brief.yml/dispatches';

// preferenceWeights (дзеркало src/modules/news.ts — Worker не імпортує TS).
const WEIGHT_MIN = 0.5;
const WEIGHT_MAX = 2.0;
const WEIGHT_STEP = 0.15;
const clampWeight = (w) => Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, w));
function applyVote(weights, category, dir) {
  const cur = weights[category] ?? 1.0;
  return { ...weights, [category]: clampWeight(cur + (dir === 'up' ? WEIGHT_STEP : -WEIGHT_STEP)) };
}

// jobPrefs (дзеркало src/modules/jobs.ts — Worker не імпортує TS).
const JOB_PREFS_CAP = 20;
const JOB_STOP_WORDS = new Set([
  'job',
  'jobs',
  'vacancy',
  'вакансія',
  'вакансии',
  'developer',
  'розробник',
  'engineer',
  'інженер',
  'junior',
  'trainee',
  'intern',
  'стажист',
  'джуніор',
  'full',
  'part',
  'time',
  'remote',
  'hybrid',
  'офіс',
  'дистанційно',
  'stack',
]);
function titleTokens(title) {
  return (title.toLowerCase().match(/[a-zа-яїієґ0-9+#.]{3,}/gi) ?? []).filter(
    (t) => !JOB_STOP_WORDS.has(t),
  );
}
function updateJobPrefs(prefs, signal, title) {
  const tokens = titleTokens(title);
  if (tokens.length === 0) return prefs;
  const toAdd = signal === 'dismiss' ? 'disliked' : 'liked';
  const toRemove = toAdd === 'liked' ? 'disliked' : 'liked';
  const merged = [...tokens, ...prefs[toAdd].filter((t) => !tokens.includes(t))].slice(
    0,
    JOB_PREFS_CAP,
  );
  const filtered = prefs[toRemove].filter((t) => !tokens.includes(t));
  return { ...prefs, [toAdd]: merged, [toRemove]: filtered };
}

// mockWeights (дзеркало src/modules/mock.ts — Worker не імпортує TS).
const MOCK_WEIGHT_MIN = 0.5;
const MOCK_WEIGHT_MAX = 2.0;
const MOCK_WEIGHT_STEP = 0.2;
const clampMockWeight = (w) => Math.min(MOCK_WEIGHT_MAX, Math.max(MOCK_WEIGHT_MIN, w));
function updateMockWeight(weights, topic, rating) {
  if (!topic) return weights;
  const cur = weights[topic] ?? 1.0;
  const next = clampMockWeight(cur + (rating === 'hard' ? MOCK_WEIGHT_STEP : -MOCK_WEIGHT_STEP));
  return { ...weights, [topic]: next };
}

/** Київська година (0..23) зараз, з урахуванням DST через Intl. */
function kyivHour(now = new Date()) {
  const h = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Kyiv',
    hour: '2-digit',
    hour12: false,
  }).format(now);
  return Number(h);
}

/** Київська дата "YYYY-MM-DD" (для порівняння «свіжості» брифінгу). */
function kyivDateKey(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

// --- Telegram WebApp initData validation (HMAC-SHA256, WebCrypto) ---
async function hmac(keyBytes, msgBytes) {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, msgBytes));
}
const toHex = (buf) => [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Перевіряє initData за алгоритмом Telegram; повертає {user} або null. */
async function validateInitData(initData, botToken) {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dataCheck = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');
  const enc = new TextEncoder();
  const secret = await hmac(enc.encode('WebAppData'), enc.encode(botToken));
  const computed = toHex(await hmac(secret, enc.encode(dataCheck)));
  if (computed !== hash) return null;
  const authDate = Number(params.get('auth_date') ?? 0);
  if (!authDate || Date.now() / 1000 - authDate > 86400) return null; // старіше 24 год
  try {
    return { user: JSON.parse(params.get('user') ?? 'null') };
  } catch {
    return { user: null };
  }
}

/** Валідація initData + власник. -> {ok:true,user} або {ok:false,status,error}. */
async function checkOwner(initData, env) {
  const v = await validateInitData(initData, env.TELEGRAM_BOT_TOKEN);
  if (!v) return { ok: false, status: 401, error: 'auth' };
  if (env.TELEGRAM_CHAT_ID && v.user && String(v.user.id) !== String(env.TELEGRAM_CHAT_ID)) {
    return { ok: false, status: 403, error: 'forbidden' };
  }
  return { ok: true, user: v.user };
}

/** Хвилини після 08:00 Київ зараз (метрика «час до відкриття»); поза ранком -> null. */
function kyivMinAfter8(now = new Date()) {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Kyiv',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const h = Number(p.find((x) => x.type === 'hour')?.value);
  const m = Number(p.find((x) => x.type === 'minute')?.value);
  const mins = h * 60 + m - 480;
  return mins >= 0 && mins <= 720 ? mins : null;
}

/** Прочитати стор статистики з KV (ключ `stats`); биття -> {}. */
async function loadStats(env) {
  try {
    return JSON.parse((await env.BRIEFING.get('stats')) ?? '{}');
  } catch {
    return {};
  }
}

async function loadState(env) {
  try {
    const parsed = JSON.parse((await env.BRIEFING.get('state')) ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {}; // биття JSON -> порожній стан
  }
}

/** POST /api/vote {category, dir, url, initData} -> preferenceWeights + інтерес. */
async function handleVote(request, env) {
  if (!env.TELEGRAM_BOT_TOKEN) return json({ ok: false, error: 'no-token' }, 500);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'bad-json' }, 400);
  }
  const { category, dir, initData } = body ?? {};
  if (typeof category !== 'string' || !category || (dir !== 'up' && dir !== 'down')) {
    return json({ ok: false, error: 'bad-params' }, 400);
  }
  const auth = await checkOwner(initData, env);
  if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);

  const state = await loadState(env);
  const weights = applyVote(state.preferenceWeights ?? {}, category, dir);
  state.preferenceWeights = weights;
  await env.BRIEFING.put('state', JSON.stringify(state));
  // Інтерес у stats (для табу «Статистика» → «твої інтереси»).
  const stats = recordEvent(await loadStats(env), { type: 'vote', category, dir }, kyivDateKey());
  await env.BRIEFING.put('stats', JSON.stringify(stats));
  return json({ ok: true, category, weight: weights[category] });
}

/**
 * Спільне ядро запису події — і /api/event (Mini App), і Telegram-callback
 * (Блок P1) проходять через ЦЕ, щоб jobPrefs/mockWeights/stats не дублювались
 * і не розходились між двома джерелами подій.
 */
async function applyEvent(env, body) {
  // jobPrefs: памʼять скорера з живої воронки (dismiss/applied→interview→offer).
  const jobSignal =
    body.type === 'job_dismiss'
      ? 'dismiss'
      : body.type === 'job_stage' && ['applied', 'interview', 'offer'].includes(body.stage)
        ? body.stage
        : null;
  if (jobSignal && typeof body.title === 'string' && body.title) {
    const state = await loadState(env);
    const prefs = state.jobPrefs ?? { liked: [], disliked: [] };
    state.jobPrefs = updateJobPrefs(prefs, jobSignal, body.title);
    await env.BRIEFING.put('state', JSON.stringify(state));
  }

  // mockWeights: слабкі теми самооцінки (Блок F) -> частіше в наступному батчі.
  if (
    body.type === 'mock_answer' &&
    typeof body.topic === 'string' &&
    body.topic &&
    (body.rating === 'easy' || body.rating === 'hard')
  ) {
    const state = await loadState(env);
    const weights = state.mockWeights ?? {};
    state.mockWeights = updateMockWeight(weights, body.topic, body.rating);
    await env.BRIEFING.put('state', JSON.stringify(state));
  }

  const nowMin = body.type === 'open' ? kyivMinAfter8() : null;
  const stats = recordEvent(await loadStats(env), body, kyivDateKey(), nowMin);
  await env.BRIEFING.put('stats', JSON.stringify(stats));
}

/** POST /api/event {type, …, initData} -> записати подію у стор статистики. */
async function handleEvent(request, env) {
  if (!env.TELEGRAM_BOT_TOKEN) return json({ ok: false, error: 'no-token' }, 500);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'bad-json' }, 400);
  }
  if (typeof body?.type !== 'string') return json({ ok: false, error: 'bad-params' }, 400);
  const auth = await checkOwner(body.initData, env);
  if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);

  await applyEvent(env, body);
  return json({ ok: true });
}

/** GET /api/stats -> агрегат для табу «Статистика» (читання, без auth). */
async function handleStats(env) {
  return json(aggregateStats(await loadStats(env), kyivDateKey()));
}

/* ══════════════════════════════════════════════════════════════════════
   TELEGRAM-ВЕБХУК (Блок P0+P1) — прийом callback-кнопок з брифінгу.
   ══════════════════════════════════════════════════════════════════════ */

/** Тонкий клієнт Telegram Bot API (порт src/core/telegram.ts:call — Worker не імпортує TS). */
async function tgCall(env, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error(`Telegram ${method} HTTP ${res.status}`, await res.text().catch(() => ''));
  }
  return res;
}

/** Прочитати ІСТОРИЧНИЙ (не latest!) снапшот дня — callback завжди резолвиться
 *  проти того самого брифінгу, що бачив власник, навіть через кілька днів. */
async function loadBriefingForDate(env, dateKey) {
  try {
    return JSON.parse((await env.BRIEFING.get(`briefing:${dateKey}`)) ?? '{}');
  } catch {
    return {};
  }
}

/** Обробити callback: застосувати подію (якщо валідна) + позначити кнопку ✓;
 *  повертає текст тосту для answerCallbackQuery (успіх/застаріло/невідомо). */
async function resolveCallbackToast(env, parsed) {
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

/* ══════════════════════════════════════════════════════════════════════
   Команди / Налаштування (Блок P4) — маршрутизація текстових повідомлень.
   ══════════════════════════════════════════════════════════════════════ */

const START_TEXT = [
  '👋 Привіт! Я асистент <b>Світанок</b>.',
  '',
  'Команди:',
  '/brief — запустити ранковий брифінг',
  '/stats — стрік і статистика',
  '/jobs — активна воронка вакансій',
  '/save — збережене',
  '/remind — нагадування (напр. "через 20 хв ..." або "завтра о 10:00 ...")',
  '/settings — відкрити Mini App',
  '',
  '🚧 У розробці: /mock /plan /roadmap — прийдуть у наступних фазах.',
  '',
  'Кнопки під ранковим брифінгом (💾 ✅ 🔖) теж працюють. Нагадати можна й без',
  'команди — просто напиши "нагадай ...".',
].join('\n');

const STUB_COMMANDS = new Set(['mock', 'plan', 'roadmap']);
const STUB_REPLY = '🚧 Ще в розробці — зʼявиться в наступних фазах (асистент/роадмеп).';
const UNKNOWN_REPLY =
  '🤖 Асистент-діалог ще не підключений (зʼявиться пізніше). Натисни /start, щоб побачити доступні команди.';
const REMINDER_HELP =
  '🤔 Не зрозумів час. Приклади: "через 20 хвилин", "завтра о 10:00", "о 15:30".';

/** Розібрати текст на час+нагадування, зберегти в state.reminders, підтвердити. */
async function createReminderFromText(env, parsed, text) {
  const sendText = (t, extra) =>
    tgCall(env, 'sendMessage', { chat_id: parsed.chatId, text: t, ...extra });

  const parsedTime = parseReminderTime(text, Date.now());
  if (!parsedTime) return sendText(REMINDER_HELP);

  const state = await loadState(env);
  state.reminders = addReminder(state.reminders, {
    id: crypto.randomUUID(),
    text: parsedTime.remainder,
    whenMs: parsedTime.whenMs,
    nowMs: Date.now(),
  });
  await env.BRIEFING.put('state', JSON.stringify(state));
  return sendText(formatReminderConfirm(parsedTime.whenMs, parsedTime.remainder), {
    parse_mode: 'HTML',
  });
}

/** Обробити текстове повідомлення (slash-команда/reply-keyboard) -> sendMessage. */
async function handleCommand(env, parsed, origin) {
  const sendText = (text, extra) =>
    tgCall(env, 'sendMessage', { chat_id: parsed.chatId, text, ...extra });

  const cmd = parseCommand(parsed.text);
  if (!cmd) {
    // Вільний текст (майбутній асистент, P2) — крім тригера нагадування (P2a).
    if (/нагад/i.test(parsed.text)) return createReminderFromText(env, parsed, parsed.text);
    return sendText(UNKNOWN_REPLY);
  }
  if (STUB_COMMANDS.has(cmd.cmd)) return sendText(STUB_REPLY);

  switch (cmd.cmd) {
    case 'start':
      return sendText(START_TEXT, {
        parse_mode: 'HTML',
        reply_markup: { keyboard: REPLY_KEYBOARD, resize_keyboard: true },
      });
    case 'brief':
      await dispatchBrief(env);
      return sendText(
        '🔄 Запустив генерацію брифінгу — якщо сьогодні ще не надсилався, прийде за кілька хвилин.',
      );
    case 'stats':
      return sendText(formatStatsMessage(aggregateStats(await loadStats(env), kyivDateKey())), {
        parse_mode: 'HTML',
      });
    case 'jobs':
      return sendText(
        formatJobsMessage(aggregateStats(await loadStats(env), kyivDateKey()).funnelList),
        { parse_mode: 'HTML' },
      );
    case 'save':
      return sendText(
        formatSavedMessage(aggregateStats(await loadStats(env), kyivDateKey()).savedList),
        { parse_mode: 'HTML' },
      );
    case 'remind':
      return createReminderFromText(env, parsed, cmd.args);
    case 'settings':
      return sendText(
        '⚙️ Налаштування (тихі/робочі години, конектори) зʼявляться в Mini App разом із нагадуваннями й календарем. Поки що — сам дашборд:',
        {
          reply_markup: {
            inline_keyboard: [[{ text: '📊 Відкрити Mini App', web_app: { url: origin } }]],
          },
        },
      );
    default:
      return sendText(UNKNOWN_REPLY);
  }
}

/** Обробити snooze-callback (`rm:<id>`, окремий простір від v1:<dateKey>:... з P1). */
async function resolveReminderSnooze(env, parsed, reminderId) {
  const state = await loadState(env);
  const reminders = Array.isArray(state.reminders) ? state.reminders : [];
  if (!reminders.some((r) => r.id === reminderId)) return '⚠️ Це нагадування вже неактуальне.';

  state.reminders = snoozeReminder(reminders, reminderId, Date.now());
  await env.BRIEFING.put('state', JSON.stringify(state));
  if (parsed.chatId != null && parsed.messageId != null && parsed.replyMarkup) {
    await tgCall(env, 'editMessageReplyMarkup', {
      chat_id: parsed.chatId,
      message_id: parsed.messageId,
      reply_markup: markButtonDone(parsed.replyMarkup, parsed.data),
    });
  }
  return '😴 Відкладено на 10 хв';
}

/**
 * Знайти прострочені нагадування, надіслати + позначити спрацьованими.
 * Пише KV ПІСЛЯ КОЖНОГО надісланого — якщо tgCall впаде посеред циклу (мережа),
 * уже надіслані не втратять firedTs і не задублюються наступним тіком.
 */
async function checkReminders(env) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  const now = Date.now();
  const due = dueReminders((await loadState(env)).reminders, now);
  if (due.length === 0) return;

  for (const r of due) {
    await tgCall(env, 'sendMessage', {
      chat_id: env.TELEGRAM_CHAT_ID,
      text: formatReminderFired(r.text),
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[{ text: '😴 +10 хв', callback_data: `${REMINDER_CB_PREFIX}${r.id}` }]],
      },
    });
    const fresh = await loadState(env); // перечитати — попередня ітерація вже писала
    fresh.reminders = markFired(fresh.reminders, r.id, now);
    await env.BRIEFING.put('state', JSON.stringify(fresh));
  }
}

/** POST /api/telegram — Telegram Bot API webhook. Secret-token + owner + дедуп. */
async function handleTelegramWebhook(request, env) {
  if (!env.TELEGRAM_WEBHOOK_SECRET || !env.TELEGRAM_BOT_TOKEN) {
    return json({ ok: false, error: 'no-webhook-secret' }, 500);
  }
  const header = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
  if (!verifyWebhookSecret(header, env.TELEGRAM_WEBHOOK_SECRET)) {
    return json({ ok: false, error: 'bad-secret' }, 401);
  }

  let update;
  try {
    update = await request.json();
  } catch {
    return json({ ok: false, error: 'bad-json' }, 400);
  }
  const parsed = parseUpdate(update);

  if (!isOwner(parsed, env.TELEGRAM_CHAT_ID)) {
    // Не власник — тихо ігноруємо (бот однокористувацький; не палимо деталі стороннім).
    return json({ ok: true });
  }

  const preState = await loadState(env); // лише для дедуп-перевірки (read-only)
  if (isDuplicate(preState.lastUpdateId, parsed.updateId)) {
    return json({ ok: true }); // Telegram передоставляє апдейти — не обробляємо двічі.
  }

  if (parsed.kind === 'callback') {
    const isReminderSnooze =
      typeof parsed.data === 'string' && parsed.data.startsWith(REMINDER_CB_PREFIX);
    const toast = isReminderSnooze
      ? await resolveReminderSnooze(env, parsed, parsed.data.slice(REMINDER_CB_PREFIX.length))
      : await resolveCallbackToast(env, parsed);
    if (parsed.callbackId) {
      await tgCall(env, 'answerCallbackQuery', {
        callback_query_id: parsed.callbackId,
        text: toast,
      });
    }
  } else if (parsed.kind === 'message' && parsed.chatId != null) {
    // Асистент (LLM-діалог, вільний текст) — повна версія в наступній фазі
    // (P2); команди+нагадування (P2a) — тут.
    await handleCommand(env, parsed, new URL(request.url).origin);
  }

  if (typeof parsed.updateId === 'number') {
    // Перечитати ПІСЛЯ applyEvent — той міг оновити jobPrefs/mockWeights у 'state'.
    const state = await loadState(env);
    state.lastUpdateId = parsed.updateId;
    await env.BRIEFING.put('state', JSON.stringify(state));
  }
  return json({ ok: true });
}

/** POST /api/telegram/setup -> одноразовий setWebhook. Auth тим самим заголовком,
 *  що й вебхук (X-Telegram-Bot-Api-Secret-Token) — не query-param (не осідає в логах). */
async function handleTelegramSetup(request, env) {
  if (!env.TELEGRAM_WEBHOOK_SECRET || !env.TELEGRAM_BOT_TOKEN) {
    return json({ ok: false, error: 'no-webhook-secret' }, 500);
  }
  const header = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
  if (!verifyWebhookSecret(header, env.TELEGRAM_WEBHOOK_SECRET)) {
    return json({ ok: false, error: 'bad-secret' }, 401);
  }
  const url = new URL(request.url);
  const webhookUrl = `${url.origin}/api/telegram`;
  const res = await tgCall(env, 'setWebhook', {
    url: webhookUrl,
    secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ['message', 'callback_query', 'my_chat_member'],
  });
  // "/" меню команд + menu-button (кнопка біля поля вводу) -> запуск Mini App (Блок P4).
  await tgCall(env, 'setMyCommands', { commands: COMMANDS });
  await tgCall(env, 'setChatMenuButton', {
    menu_button: { type: 'web_app', text: 'Mini App', web_app: { url: url.origin } },
  });
  return json({ ok: res.ok, webhookUrl });
}

/** Точний ранковий тригер: dispatch brief (без force -> нормальний guard). */
async function dispatchBrief(env) {
  if (!env.GH_DISPATCH_TOKEN) {
    console.error('GH_DISPATCH_TOKEN відсутній — dispatch пропущено');
    return;
  }
  const resp = await fetch(GH_DISPATCH_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'svitanok-scheduler',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ ref: 'main' }), // без inputs.force -> нормальний guard
  });
  if (!resp.ok) {
    console.error('workflow_dispatch failed', resp.status, await resp.text());
  }
}

/** Dead-man's-switch: KV не оновлено сьогодні -> алерт у Telegram. */
async function deadMansCheck(env) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.error('TELEGRAM_* відсутні — dead-man пропущено');
    return;
  }
  const raw = await env.BRIEFING.get('latest');
  const today = kyivDateKey();
  let fresh = false;
  try {
    const d = JSON.parse(raw ?? '{}');
    fresh = typeof d.generatedAt === 'string' && kyivDateKey(new Date(d.generatedAt)) === today;
  } catch {
    /* биття JSON -> вважаємо несвіжим -> алерт */
  }
  if (fresh) return;

  const resp = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text: '⚠️ Свiтанок: ранковий брифінг сьогодні не доставлено (KV не оновлено). Перевір GitHub Actions → workflow «brief».',
    }),
  });
  if (!resp.ok) {
    console.error('dead-man alert failed', resp.status, await resp.text());
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/briefing.json') {
      // ?date=YYYY-MM-DD -> історичний брифінг; інакше — latest.
      const date = url.searchParams.get('date');
      const key = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? `briefing:${date}` : 'latest';
      const data = await env.BRIEFING.get(key);
      return new Response(data ?? '{}', {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'access-control-allow-origin': '*',
        },
      });
    }
    if (url.pathname === '/api/history') {
      // Список наявних дат (для гортання в Mini App), новіші перші.
      const list = await env.BRIEFING.list({ prefix: 'briefing:' });
      const dates = list.keys
        .map((k) => k.name.slice('briefing:'.length))
        .sort()
        .reverse();
      return json({ dates });
    }
    if (url.pathname === '/api/vote' && request.method === 'POST') {
      return handleVote(request, env);
    }
    if (url.pathname === '/api/event' && request.method === 'POST') {
      return handleEvent(request, env);
    }
    if (url.pathname === '/api/stats') {
      return handleStats(env);
    }
    if (url.pathname === '/api/telegram' && request.method === 'POST') {
      return handleTelegramWebhook(request, env);
    }
    if (url.pathname === '/api/telegram/setup' && request.method === 'POST') {
      return handleTelegramSetup(request, env);
    }
    return env.ASSETS.fetch(request); // статичні файли (дашборд)
  },

  // Cron у UTC покриває обидва DST-зсуви; за київською годиною обираємо дію:
  //   08:00 -> точний dispatch брифінгу;  10:00 -> dead-man-перевірка.
  // Нагадування (P2a) -> лише за event.cron "*/5 * * * *": ці й погодинні
  // крони інколи збігаються по хвилині (05:00/06:00/07:00/08:00 УТС кратні 5) —
  // без цієї умови checkReminders викликався б ДВІЧІ в ту саму мить (два окремі
  // спрацювання scheduled()), надсилаючи дубль нагадування.
  async scheduled(event, env, ctx) {
    const h = kyivHour();
    if (h === 8) ctx.waitUntil(dispatchBrief(env));
    else if (h === 10) ctx.waitUntil(deadMansCheck(env));
    if (event.cron === '*/5 * * * *') ctx.waitUntil(checkReminders(env));
  },
};
