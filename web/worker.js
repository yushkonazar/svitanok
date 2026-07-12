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
  formatWhereAmI,
  buildMiniAppButton,
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
  LLM_REWRITE_SCHEMA,
  buildLlmRewriteSystemPrompt,
  extractLlmRewrite,
  isAmbiguousRewrite,
  addDaysToDateKey,
} from './reminders-core.mjs';
import {
  kyivDayBoundsUtc,
  parseEvents,
  buildCreateEventBody,
  formatEventsForPrompt,
} from './calendar-core.mjs';
import {
  ASSISTANT_ACTION_SCHEMA,
  buildAssistantSystemPrompt,
  extractAssistantAction,
  sanitizeProposal,
  formatProposalMessage,
  buildProposalCallbackData,
  parseProposalCallbackData,
} from './agent-core.mjs';
import {
  findTopic,
  findSubtopic,
  progressKey,
  parseRoadmapCallbackData,
  toggleProgress,
  totalProgress,
  formatRootMessage,
  formatTopicMessage,
  buildRootKeyboard,
  buildTopicKeyboard,
} from './roadmap-core.mjs';

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

/**
 * Валідація initData + власник. -> {ok:true,user} або {ok:false,status,error}.
 * Звіряємо з TELEGRAM_OWNER_USER_ID (персональний user id, НЕ TELEGRAM_CHAT_ID —
 * той тепер лише «куди слати», в супергрупі це вже груповий id, ніколи не рівний
 * user id власника). Fail-closed: не задано -> forbidden, не fail-open.
 */
async function checkOwner(initData, env) {
  const v = await validateInitData(initData, env.TELEGRAM_BOT_TOKEN);
  if (!v) return { ok: false, status: 401, error: 'auth' };
  if (
    !env.TELEGRAM_OWNER_USER_ID ||
    !v.user ||
    String(v.user.id) !== String(env.TELEGRAM_OWNER_USER_ID)
  ) {
    return { ok: false, status: 403, error: 'forbidden' };
  }
  return { ok: true, user: v.user };
}

/**
 * Auth для GET-читань дашборда: initData з заголовка X-Telegram-Init-Data
 * (НЕ query-param — персональні дані власника й hash не осідають у логах/URL).
 * Той самий власник-чек, що й POST-и (/api/vote|/api/event). Дашборд — дані
 * одного власника (події календаря, воронка вакансій, збережене), тож
 * читання НЕ публічне: без валідного initData -> 401/403, фронт деградує на SAMPLE.
 */
async function checkOwnerRead(request, env) {
  return checkOwner(request.headers.get('X-Telegram-Init-Data'), env);
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

/** GET /api/stats -> агрегат для табу «Статистика». Auth власника (H1): стрік,
 *  воронка, інтереси — приватні; без initData -> 401/403 (фронт ховає таб). */
async function handleStats(request, env) {
  const auth = await checkOwnerRead(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);
  const stats = aggregateStats(await loadStats(env), kyivDateKey());
  // roadmap — окремий KV-блоб (state, не stats); aggregateStats лишається
  // чистим агрегатором stats-блоба, роадмеп-контент йому знати не треба.
  stats.roadmap = totalProgress((await loadState(env)).roadmapProgress ?? {});
  return json(stats);
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

/**
 * Тонкий клієнт власного LLM-хоста (host/, VPS на claude CLI — Блок P2, підписка,
 * не платний API). Graceful degradation: без LLM_HOST_URL/LLM_HOST_SECRET, або
 * при будь-якій мережевій/таймаут-помилці — просто null, виклик іде далі без LLM
 * (rule-based фолбек не блокується на доступності хоста).
 */
async function callLlmHost(env, { prompt, systemPrompt, jsonSchema }) {
  if (!env.LLM_HOST_URL || !env.LLM_HOST_SECRET) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25_000); // менше за таймаут хоста (30с)
  try {
    const res = await fetch(env.LLM_HOST_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-llm-host-secret': env.LLM_HOST_SECRET },
      body: JSON.stringify({ prompt, systemPrompt, jsonSchema }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.error('llm-host HTTP', res.status, await res.text().catch(() => ''));
      return null;
    }
    const data = await res.json();
    return data.ok ? data : null;
  } catch (err) {
    console.error('llm-host call failed', err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * OAuth access token через refresh_token grant (Google) — порт
 * src/modules/calendar.ts:93-115 під Worker-секрети GOOGLE_CLIENT_ID/
 * GOOGLE_CLIENT_SECRET/GOOGLE_REFRESH_TOKEN (Блок P2b). Відсутні секрети або
 * будь-яка мережева помилка -> null (graceful, той самий стиль що calendar.ts
 * і callLlmHost — виклик іде далі без календаря, не валить обробку апдейту).
 */
async function googleAccessToken(env) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REFRESH_TOKEN) return null;
  const body = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: env.GOOGLE_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  });
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) {
      console.error('google token HTTP', res.status, await res.text().catch(() => ''));
      return null;
    }
    const json = await res.json();
    return typeof json.access_token === 'string' ? json.access_token : null;
  } catch (err) {
    console.error('google token failed', err.message);
    return null;
  }
}

/** Події дня dateKey (Київ) через Google Calendar API (read). null при будь-якому збої. */
async function readCalendarEvents(env, dateKey) {
  const token = await googleAccessToken(env);
  if (!token) return null;
  const { timeMin, timeMax } = kyivDayBoundsUtc(dateKey);
  const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
  url.searchParams.set('timeMin', timeMin);
  url.searchParams.set('timeMax', timeMax);
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('orderBy', 'startTime');
  url.searchParams.set('timeZone', 'Europe/Kyiv');
  try {
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      console.error('google calendar read HTTP', res.status, await res.text().catch(() => ''));
      return null;
    }
    return parseEvents(await res.json());
  } catch (err) {
    console.error('google calendar read failed', err.message);
    return null;
  }
}

/** Створити подію в календарі (write-scope, Блок P2b). Ніколи не кидає — {ok:false} при збої. */
async function createCalendarEvent(env, { title, startIso, endIso }) {
  const token = await googleAccessToken(env);
  if (!token) return { ok: false };
  try {
    const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(buildCreateEventBody({ title, startIso, endIso })),
    });
    if (!res.ok) {
      console.error('google calendar create HTTP', res.status, await res.text().catch(() => ''));
      return { ok: false };
    }
    const json = await res.json();
    return { ok: true, id: typeof json.id === 'string' ? json.id : null };
  } catch (err) {
    console.error('google calendar create failed', err.message);
    return { ok: false };
  }
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
  '/plan — план дня (LLM прочитає календар і запропонує таймлайн)',
  '/roadmap — IT-роадмеп (теми → підпункти, прогрес)',
  '/settings — відкрити Mini App',
  '',
  '🚧 У розробці: /mock — прийде в наступній фазі.',
  '',
  'Кнопки під ранковим брифінгом (💾 ✅ 🔖) теж працюють. Нагадати можна й без',
  'команди — просто напиши "нагадай ...". У темі 🤖Асистент можна й просто',
  'написати вільним текстом — календар, нагадування, план дня.',
].join('\n');

const STUB_COMMANDS = new Set(['mock']);
const STUB_REPLY = '🚧 Ще в розробці — зʼявиться в наступній фазі.';
const UNKNOWN_REPLY =
  '🤖 Асистент-діалог ще не підключений (зʼявиться пізніше). Натисни /start, щоб побачити доступні команди.';
const REMINDER_HELP =
  '🤔 Не зрозумів час. Приклади: "через 20 хвилин", "завтра о 10:00", "о 15:30".';

// Обмежена кількість раундів агента (Блок P2b) — кожен раунд до 25с
// (callLlmHost-таймаут); readCalendar->рішення реалістично влазить у 3.
const MAX_ROUNDS = 3;
const ASSISTANT_FALLBACK_REPLY = '🤔 Не зміг розібратись до кінця — спробуй сформулювати простіше.';
const PENDING_TTL_MS = 30 * 60_000; // застаріла кнопка ✅/❌ під пропозицією

/**
 * LLM-фолбек, коли rule-based parseReminderTime не впізнав фразу: питаємо
 * VPS-хост ПЕРЕПИСАТИ її в канонічний патерн (LLM НЕ рахує час сам — ненадійна
 * арифметика дат), тоді прогонюємо результат через ТОЙ САМИЙ parseReminderTime.
 * Хост недоступний/не налаштований -> callLlmHost сам поверне null, тихо.
 * isAmbiguousRewrite — захист від ненадійного rewrite (модель не завжди
 * до кінця виконує інструкцію «прибери слово частини доби») — якщо лишилось
 * "ввечері"/"вранці" тощо, НЕ довіряємо, а не мовчки ставимо хибний час.
 */
async function tryLlmReminderRewrite(env, text) {
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

/** sendMessage-closure з chat_id/thread_id вже зашитими (спільна для 4 хендлерів нижче). */
function sendTo(env, parsed) {
  return (text, extra) =>
    tgCall(env, 'sendMessage', {
      chat_id: parsed.chatId,
      message_thread_id: parsed.threadId ?? undefined,
      text,
      ...extra,
    });
}

/** Розібрати текст на час+нагадування, зберегти в state.reminders, підтвердити. */
async function createReminderFromText(env, parsed, text) {
  const sendText = sendTo(env, parsed);

  let parsedTime = parseReminderTime(text, Date.now());
  if (!parsedTime && env.LLM_HOST_URL) {
    await sendText('🤔 Хвилинку, розбираюсь...');
    parsedTime = await tryLlmReminderRewrite(env, text);
  }
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

/**
 * LLM tool-use агент (Блок P2b, 🤖Асистент): Worker сам оркеструє обмежений
 * цикл раундів callLlmHost — host/ навмисно stateless, без справжнього
 * tool-calling усередині CLI (`--tools ''` — задокументована найважливіша
 * межа безпеки хоста, host/llm-host-core.mjs) — тому кожен раунд модель
 * обирає РІВНО ОДНУ дію зі схеми ASSISTANT_ACTION_SCHEMA, Worker виконує її
 * детерміновано. readCalendar дописує результат у transcript і триває цикл;
 * решта дій (createReminder/proposeCalendarChanges/reply) — термінальні.
 */
async function runAssistantAgent(env, parsed, userText) {
  const sendText = sendTo(env, parsed);
  if (!userText || !userText.trim()) return sendText(UNKNOWN_REPLY); // стікер/фото/порожнє — не LLM
  if (!env.LLM_HOST_URL) return sendText(UNKNOWN_REPLY); // хост не налаштований — graceful

  const nowMs = Date.now();
  let transcript = `Користувач написав: "${userText}"`;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await callLlmHost(env, {
      prompt: transcript,
      systemPrompt: buildAssistantSystemPrompt(nowMs),
      jsonSchema: ASSISTANT_ACTION_SCHEMA,
    });
    const action = extractAssistantAction(res?.structured);
    if (!action) return sendText(ASSISTANT_FALLBACK_REPLY);

    if (action.action === 'reply') return sendText(action.replyText || ASSISTANT_FALLBACK_REPLY);
    if (action.action === 'createReminder') {
      return createReminderFromText(env, parsed, action.reminderText);
    }
    if (action.action === 'proposeCalendarChanges') {
      return proposeCalendarChanges(env, parsed, action.proposal);
    }
    // readCalendar — дописати результат дня nowMs+calendarRangeDays, продовжити цикл.
    // Y-M-D зсув через addDaysToDateKey (НЕ +N*86400000мс на інстант — те
    // ламається на DST-переході, коли зсув доби і +1год стрибок комбінуються).
    const dateKey = addDaysToDateKey(kyivDateKey(new Date(nowMs)), action.calendarRangeDays);
    const events = await readCalendarEvents(env, dateKey);
    transcript += `\n\nКалендар (${dateKey}): ${formatEventsForPrompt(events ?? [])}`;
  }
  return sendText(ASSISTANT_FALLBACK_REPLY); // вичерпані раунди — не помилка, чесний фолбек
}

/** Зберегти пропозицію (state.assistantPending, ОДИН слот) + кнопки ✅/❌ підтвердження. */
async function proposeCalendarChanges(env, parsed, rawProposal) {
  const sendText = sendTo(env, parsed);

  const { items, droppedCount } = sanitizeProposal(rawProposal, Date.now());
  if (items.length === 0) {
    return sendText(
      '🤔 Не зрозумів час жодного пункту — спробуй точніше (напр. "завтра о 15:00").',
    );
  }

  const id = crypto.randomUUID().slice(0, 8);
  const state = await loadState(env);
  state.assistantPending = { id, items, createdMs: Date.now() };
  await env.BRIEFING.put('state', JSON.stringify(state));

  const warn = droppedCount > 0 ? `\n\n⚠️ пропущено ${droppedCount} — незрозумілий час` : '';
  return sendText(formatProposalMessage(items) + warn, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ Прийняти', callback_data: buildProposalCallbackData('a', id) },
          { text: '❌ Скасувати', callback_data: buildProposalCallbackData('c', id) },
        ],
      ],
    },
  });
}

/** Обробити текстове повідомлення (slash-команда/reply-keyboard) -> sendMessage. */
async function handleCommand(env, parsed, origin) {
  const sendText = sendTo(env, parsed);

  const cmd = parseCommand(parsed.text);
  if (!cmd) {
    // Тригер нагадування (P2a) — першим, як і раніше.
    if (/нагад/i.test(parsed.text)) return createReminderFromText(env, parsed, parsed.text);
    // Вільний текст у 🤖Асистент (чи DM, без тем) -> LLM tool-use агент (Блок
    // P2b). Інші теми (Роадмеп/Брифінг/Команди) — тема-специфічна поведінка
    // там свідомо поза межами, лишається стара заглушка.
    if (parsed.threadId == null || String(parsed.threadId) === String(env.TOPIC_ASSISTANT)) {
      return runAssistantAgent(env, parsed, parsed.text);
    }
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
    case 'plan':
      return runAssistantAgent(env, parsed, cmd.args || 'Склади план дня');
    case 'roadmap': {
      const progress = (await loadState(env)).roadmapProgress ?? {};
      return sendText(formatRootMessage(progress), {
        parse_mode: 'HTML',
        reply_markup: buildRootKeyboard(progress),
      });
    }
    case 'whereami':
      return sendText(formatWhereAmI(parsed.chatId, parsed.threadId), { parse_mode: 'HTML' });
    case 'settings':
      return sendText(
        '⚙️ Налаштування (тихі/робочі години, конектори) зʼявляться в Mini App разом із нагадуваннями й календарем. Поки що — сам дашборд:',
        {
          reply_markup: {
            // web_app лише в приватних чатах (Telegram Bot API) — у групі/темі
            // (parsed.chatId<0) buildMiniAppButton деградує на url (BUTTON_TYPE_INVALID
            // інакше, §core/telegram.ts).
            inline_keyboard: [[buildMiniAppButton('📊 Відкрити Mini App', origin, parsed.chatId)]],
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
 * Обробити pd:a:<id>/pd:c:<id> — прийняти чи скасувати пропозицію асистента
 * (`state.assistantPending`, ОДИН слот). "Claim" (видалити зі стану) ОДРАЗУ
 * після перевірки, ще ДО повільного циклу запису — інакше подвійний тап на
 * ✅ (чи паралельна нова пропозиція, що перезаписала слот, поки ця ще
 * оброблялась — цикл тепер може тривати довше через ctx.waitUntil) або
 * встигає задублювати нагадування/події (createCalendarEvent — зовнішній
 * незворотний запис, не KV-стан), або стирає ЧУЖУ (новішу) пропозицію
 * непроконтрольовано. Прийняти -> записати кожен пункт; KV після КОЖНОГО
 * нагадування (crash-safe, той самий патерн, що checkReminders); часткові
 * провали -> комбінований toast, не тихе ковтання.
 */
async function resolveProposalCallback(env, parsed, cb) {
  const state = await loadState(env);
  const pending = state.assistantPending;
  const stale = !pending || pending.id !== cb.id || Date.now() - pending.createdMs > PENDING_TTL_MS;
  if (stale) return '⚠️ Застаріла пропозиція.';

  if (parsed.chatId != null && parsed.messageId != null && parsed.replyMarkup) {
    await tgCall(env, 'editMessageReplyMarkup', {
      chat_id: parsed.chatId,
      message_id: parsed.messageId,
      reply_markup: markButtonDone(parsed.replyMarkup, parsed.data),
    });
  }

  // Claim: видалити ЛИШЕ якщо це досі той самий id (не чужа новіша пропозиція),
  // ОДРАЗУ, до будь-якого повільного запису — звужує вікно подвійного тапу.
  const claim = await loadState(env);
  if (claim.assistantPending?.id !== cb.id) return '⚠️ Застаріла пропозиція.';
  delete claim.assistantPending;
  await env.BRIEFING.put('state', JSON.stringify(claim));

  if (cb.action === 'c') return '❌ Скасовано';

  let ok = 0;
  let fail = 0;
  for (const item of pending.items) {
    if (item.kind === 'reminder') {
      const fresh = await loadState(env);
      fresh.reminders = addReminder(fresh.reminders, {
        id: crypto.randomUUID(),
        text: item.title,
        whenMs: item.whenMs,
        nowMs: Date.now(),
      });
      await env.BRIEFING.put('state', JSON.stringify(fresh));
      ok++;
    } else {
      const startIso = new Date(item.whenMs).toISOString();
      const endIso = new Date(item.whenMs + item.durationMin * 60_000).toISOString();
      const res = await createCalendarEvent(env, { title: item.title, startIso, endIso });
      if (res.ok) ok++;
      else fail++;
    }
  }
  return fail > 0 ? `✅ Додано ${ok}, ⚠️ не вдалось ${fail}` : `✅ Додано ${ok}`;
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
async function resolveRoadmapCallback(env, parsed, cb) {
  if (parsed.chatId == null || parsed.messageId == null) return '';
  const editText = (text, replyMarkup) =>
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
  const before = state.roadmapProgress ?? {};
  const wasDone = progressKey(cb.topicId, cb.subtopicId) in before;
  state.roadmapProgress = toggleProgress(
    before,
    cb.topicId,
    cb.subtopicId,
    new Date().toISOString(),
  );
  await env.BRIEFING.put('state', JSON.stringify(state));

  await editText(
    formatTopicMessage(topic, state.roadmapProgress),
    buildTopicKeyboard(topic, state.roadmapProgress),
  );
  return wasDone ? '↩️ Знято позначку' : '✅ Позначено';
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
      message_thread_id: env.TOPIC_ASSISTANT ?? undefined,
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

/**
 * Фактична обробка апдейту (callback-резолв або handleCommand) + запис
 * lastUpdateId — викликається через ctx.waitUntil (Блок P2b): agent-цикл
 * (runAssistantAgent) може тривати до ~75с (3×25с callLlmHost-таймаут),
 * задовго для синхронної відповіді на вебхук (ризик Telegram-ретраю того
 * самого апдейту). Порядок дій ІДЕНТИЧНИЙ попередньому синхронному коду —
 * lastUpdateId пишеться ОСТАННІМ (не раніше!), щоб не затерти
 * jobPrefs/mockWeights, які міг оновити applyEvent усередині обробки.
 * Try/catch — waitUntil мовчки ковтає необроблені reject, лишаючи слід лише
 * в логах.
 */
async function processTelegramUpdate(env, parsed, origin) {
  try {
    if (parsed.kind === 'callback') {
      const proposalCb = parseProposalCallbackData(parsed.data);
      const roadmapCb = parseRoadmapCallbackData(parsed.data);
      const isReminderSnooze =
        typeof parsed.data === 'string' && parsed.data.startsWith(REMINDER_CB_PREFIX);
      const toast = proposalCb
        ? await resolveProposalCallback(env, parsed, proposalCb)
        : roadmapCb
          ? await resolveRoadmapCallback(env, parsed, roadmapCb)
          : isReminderSnooze
            ? await resolveReminderSnooze(env, parsed, parsed.data.slice(REMINDER_CB_PREFIX.length))
            : await resolveCallbackToast(env, parsed);
      if (parsed.callbackId) {
        await tgCall(env, 'answerCallbackQuery', {
          callback_query_id: parsed.callbackId,
          text: toast,
        });
      }
    } else if (parsed.kind === 'message' && parsed.chatId != null) {
      await handleCommand(env, parsed, origin);
    }

    if (typeof parsed.updateId === 'number') {
      // Перечитати ПІСЛЯ applyEvent — той міг оновити jobPrefs/mockWeights у 'state'.
      const state = await loadState(env);
      state.lastUpdateId = parsed.updateId;
      await env.BRIEFING.put('state', JSON.stringify(state));
    }
  } catch (err) {
    console.error('processTelegramUpdate failed', err);
  }
}

/** POST /api/telegram — Telegram Bot API webhook. Secret-token + owner + дедуп. */
async function handleTelegramWebhook(request, env, ctx) {
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

  if (!isOwner(parsed, env.TELEGRAM_OWNER_USER_ID)) {
    // Не власник — тихо ігноруємо (бот однокористувацький; не палимо деталі стороннім).
    return json({ ok: true });
  }

  const preState = await loadState(env); // лише для дедуп-перевірки (read-only)
  if (isDuplicate(preState.lastUpdateId, parsed.updateId)) {
    return json({ ok: true }); // Telegram передоставляє апдейти — не обробляємо двічі.
  }

  // Ack одразу, обробка (може бути повільною — agent-цикл) — у фоні.
  ctx.waitUntil(processTelegramUpdate(env, parsed, new URL(request.url).origin));
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
      message_thread_id: env.TOPIC_BRIEFING ?? undefined,
      text: '⚠️ Свiтанок: ранковий брифінг сьогодні не доставлено (KV не оновлено). Перевір GitHub Actions → workflow «brief».',
    }),
  });
  if (!resp.ok) {
    console.error('dead-man alert failed', resp.status, await resp.text());
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/briefing.json') {
      // Приватні дані власника (події календаря, воронка, збережене) — лише
      // власнику через initData; без нього фронт деградує на SAMPLE (H1).
      const auth = await checkOwnerRead(request, env);
      if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);
      // ?date=YYYY-MM-DD -> історичний брифінг; інакше — latest.
      const date = url.searchParams.get('date');
      const key = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? `briefing:${date}` : 'latest';
      const data = await env.BRIEFING.get(key);
      return new Response(data ?? '{}', {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        },
      });
    }
    if (url.pathname === '/api/history') {
      const auth = await checkOwnerRead(request, env);
      if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);
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
      return handleStats(request, env);
    }
    if (url.pathname === '/api/telegram' && request.method === 'POST') {
      return handleTelegramWebhook(request, env, ctx);
    }
    if (url.pathname === '/api/telegram/setup' && request.method === 'POST') {
      return handleTelegramSetup(request, env);
    }
    return env.ASSETS.fetch(request); // статичні файли (дашборд)
  },

  // Cron у UTC покриває обидва DST-зсуви; за київською годиною обираємо дію:
  //   08:00 -> точний dispatch брифінгу;  10:00 -> dead-man-перевірка.
  // dispatch/dead-man — ЛИШЕ на погодинних кронах (0 5/6/7/8), НЕ на "*/5":
  // kyivHour()===8 істинна ВЕСЬ 08:00–08:59 київський, тож без цього гейта
  // кожен 5-хвилинний тік у ту годину (12 на день) вистрілював би зайвий
  // workflow_dispatch (guard-ідемпотентність не дає дубля брифінгу, але це
  // ~12 холостих Actions-ранів/день). "*/5" резервуємо суто під нагадування —
  // погодинні й 5-хв крони інколи збігаються по хвилині (мит. 05/06/07/08:00),
  // тож і checkReminders прив'язуємо саме до "*/5", щоб не спрацював двічі.
  async scheduled(event, env, ctx) {
    if (event.cron === '*/5 * * * *') {
      ctx.waitUntil(checkReminders(env));
      return;
    }
    const h = kyivHour();
    if (h === 8) ctx.waitUntil(dispatchBrief(env));
    else if (h === 10) ctx.waitUntil(deadMansCheck(env));
  },
};
