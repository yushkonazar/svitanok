// Worker: статика дашборда (ASSETS) + /briefing.json із KV + планувальник
// (вікно 08:00–12:00 Київ, спроба щоп'ять хвилин -> GitHub workflow_dispatch,
// рівно один успішний на добу) + DEAD-MAN'S-SWITCH (10:00 Київ) +
// НАГАДУВАННЯ (кожні ~5 хв, Блок P2a) + /api/vote, /api/event (запис подій —
// авторизація власника через Telegram WebApp initData), /api/stats (читання
// агрегату), /api/telegram (вебхук — Блок P0/P1/P4, авторизація через
// X-Telegram-Bot-Api-Secret-Token). KV namespace BRIEFING, ключі
// `latest`/`state`(+`reminders`)/`stats`/`briefing:<date>`.

import { recordEvent, aggregateStats, recordReliability, pageSaved } from './stats-core.mjs';
import { normalizeSettings, isQuietMinute, connectorStatus } from './settings-core.mjs';
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
  sentMessagesKey,
  recordSentMessage,
  lastSentMessages,
  parseClearCount,
  chunkArray,
  formatClearResult,
  briefCooldownRemainingMs,
  shouldAutoDispatchBrief,
  COMMANDS,
  REPLY_KEYBOARD,
} from './tg-core.mjs';
import {
  parseReminderTime,
  addReminder,
  dueReminders,
  markFired,
  snoozeReminder,
  cancelReminder,
  listActive,
  formatReminderConfirm,
  formatReminderFired,
  formatRemindersListMessage,
  buildRemindersKeyboard,
  parseReminderCancelCallbackData,
  LLM_REWRITE_SCHEMA,
  buildLlmRewriteSystemPrompt,
  extractLlmRewrite,
  isAmbiguousRewrite,
  addDaysToDateKey,
} from './reminders-core.mjs';
import {
  kyivRangeBoundsUtc,
  parseEvents,
  buildCreateEventBody,
  formatEventsForPrompt,
  formatRangeEventsForPrompt,
  isAccessTokenFresh,
} from './calendar-core.mjs';
import {
  ASSISTANT_ACTION_SCHEMA,
  ASSISTANT_FALLBACK_REPLY,
  assistantErrorReply,
  clipTranscript,
  buildAssistantSystemPrompt,
  extractAssistantAction,
  pickAssistantModel,
  sanitizeProposal,
  formatProposalMessage,
  buildProposalCallbackData,
  parseProposalCallbackData,
} from './agent-core.mjs';
import {
  buildOwnDataDigest,
  formatMailForPrompt,
  sanitizeMailQuery,
} from './assistant-data-core.mjs';
import { renderHistoryForPrompt, appendTurn } from './assistant-memory-core.mjs';
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
import { masteryHints, themeOfWeek, mockMaterials } from './mastery-core.mjs';

const REMINDER_CB_PREFIX = 'rm:'; // snooze; окремий простір від v1:<dateKey>:... (P1).
// 'rc:' (reminder-cancel, §C4) — окремий простір від rm:/pd:/rd:/v1:, живе в
// reminders-core.mjs (REMINDER_CANCEL_CB_PREFIX) — НЕ підпростір усередині
// 'rm:', бо resolveReminderSnooze бере ВЕСЬ залишок після 'rm:' як id.

// /clear (§C5): скільки deleteMessage-викликів паралельно за раз — компроміс
// між швидкістю (не повністю послідовно) і обережністю до rate-limit
// Telegram/Cloudflare (не бурст усіх 40 водночас).
const DELETE_CHUNK_SIZE = 10;

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

// votedUrls: чесний облік голосів per-url (C3, дзеркало applyUrlVote з news.ts —
// канонічна версія тестована в news.test.ts). Кожен url впливає на вагу максимум
// раз; повторний той самий голос знімає, зміна — переставляє. `delta` — реально
// застосований зсув (після clamp), щоб відкат був точним і на межі [0.5,2.0].
function bumpWeight(weights, category, step) {
  const before = weights[category] ?? 1.0;
  const after = clampWeight(before + step);
  return { weights: { ...weights, [category]: after }, delta: after - before };
}
function applyUrlVote(weights, votedUrls, url, category, clickedDir) {
  const vu = votedUrls && typeof votedUrls === 'object' ? { ...votedUrls } : {};
  const prev = vu[url];
  let w = weights ?? {};
  if (prev && typeof prev.delta === 'number' && prev.delta !== 0) {
    const cat = prev.category ?? category;
    w = { ...w, [cat]: clampWeight((w[cat] ?? 1.0) - prev.delta) };
  }
  const newDir = prev && prev.dir === clickedDir ? null : clickedDir;
  if (newDir) {
    const r = bumpWeight(w, category, newDir === 'up' ? WEIGHT_STEP : -WEIGHT_STEP);
    w = r.weights;
    vu[url] = { dir: newDir, category, delta: r.delta };
  } else {
    delete vu[url];
  }
  return {
    weights: w,
    votedUrls: vu,
    prevDir: prev?.dir ?? null,
    prevCategory: prev?.category ?? null,
    newDir,
  };
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

/** Хвилина київської доби (0..1439) — для вікна тихих годин (F2). */
function kyivMinuteOfDay(now = new Date()) {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Kyiv',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const h = Number(p.find((x) => x.type === 'hour')?.value);
  const m = Number(p.find((x) => x.type === 'minute')?.value);
  return h * 60 + m;
}

/** Налаштування власника (ключ `settings`, F2) — ОКРЕМИЙ блоб від 'state' (той
 *  ділять кілька писарів; тут пише лише власник із Mini App). Биття -> дефолти.
 *  Цей самий ключ читає оркестратор (src/core/settings-overrides.ts). */
async function loadSettings(env) {
  try {
    return normalizeSettings(JSON.parse((await env.BRIEFING.get('settings')) ?? '{}'));
  } catch {
    return normalizeSettings(null);
  }
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

/** Ring-buffer message_id надісланих ботом (§C5, /clear) — ОКРЕМИЙ KV-ключ
 *  від 'state', щоб трекінг на КОЖНУ відповідь бота не ділив гонку писарів
 *  з reminders/roadmapProgress/mockWeights/... (той самий блоб 'state'). */
async function loadSentMessages(env) {
  try {
    const parsed = JSON.parse((await env.BRIEFING.get('sentMessages')) ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Прочитати останній опублікований брифінг (ключ `latest`) — для own-data
 *  дайджесту асистента (CC4, dataScope "briefing"/"all"); биття -> {}. */
async function loadLatest(env) {
  try {
    const parsed = JSON.parse((await env.BRIEFING.get('latest')) ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Історія діалогу асистента per-thread (ключ `assistantHistory`, CM) — ОКРЕМИЙ
 *  KV-ключ від 'state' (як sentMessages: запис на кожен обмін не ділить гонку
 *  писарів state-блоба). Биття -> {}. */
async function loadAssistantHistory(env) {
  try {
    const parsed = JSON.parse((await env.BRIEFING.get('assistantHistory')) ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** POST /api/vote {category, dir, url?, initData} -> preferenceWeights + інтерес.
 *  url (C3): якщо переданий — голос дедуплюється per-url (повторний = зняти,
 *  зміна = переставити). Без url — стара поведінка (кожен клік зсуває вагу), щоб
 *  не ламати клієнтів, які url ще не шлють. */
async function handleVote(request, env) {
  if (!env.TELEGRAM_BOT_TOKEN) return json({ ok: false, error: 'no-token' }, 500);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'bad-json' }, 400);
  }
  const { category, dir, url, initData } = body ?? {};
  if (typeof category !== 'string' || !category || (dir !== 'up' && dir !== 'down')) {
    return json({ ok: false, error: 'bad-params' }, 400);
  }
  const auth = await checkOwner(initData, env);
  if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);

  const state = await loadState(env);
  let weight;
  let prevDir = null;
  let prevCategory = null;
  let newDir = dir;
  if (typeof url === 'string' && url) {
    // Чесний облік: кожен url впливає на вагу максимум раз (C3).
    const r = applyUrlVote(
      state.preferenceWeights ?? {},
      state.votedUrls ?? {},
      url,
      category,
      dir,
    );
    state.preferenceWeights = r.weights;
    state.votedUrls = r.votedUrls;
    prevDir = r.prevDir;
    prevCategory = r.prevCategory;
    newDir = r.newDir;
    weight = r.weights[category];
  } else {
    state.preferenceWeights = applyVote(state.preferenceWeights ?? {}, category, dir);
    weight = state.preferenceWeights[category];
  }
  await env.BRIEFING.put('state', JSON.stringify(state));
  // Інтерес у stats (таб «Статистика» → «твої інтереси»): знімаємо старий голос
  // з ЙОГО теми і додаємо новий до поточної (ревʼю C: той самий url може прийти
  // під іншою темою — інтерес мусить бути category-aware, як і ваги). prevCategory
  // null (без url / перший голос) -> recordEvent застосує лише новий напрямок.
  const stats = recordEvent(
    await loadStats(env),
    { type: 'vote', category, dir: newDir, prevDir, prevCategory },
    kyivDateKey(),
  );
  await env.BRIEFING.put('stats', JSON.stringify(stats));
  return json({ ok: true, category, weight, voted: newDir });
}

/**
 * Спільне ядро запису події — і /api/event (Mini App), і Telegram-callback
 * (Блок P1) проходять через ЦЕ, щоб jobPrefs/mockWeights/stats не дублювались
 * і не розходились між двома джерелами подій.
 */
async function applyEvent(env, body) {
  // jobPrefs: памʼять скорера з живої воронки (dismiss/applied→interview→offer).
  //
  // Термінальні стадії (F1: rejected/failed) сюди СВІДОМО не входять — падають у
  // null, тобто скорер їх не бачить. Це не недогляд: jobPrefs учить скорер, що
  // подобається ВЛАСНИКУ, а відмова — рішення роботодавця. Записати «відмову» як
  // dismiss означало б учити скорер уникати саме тих вакансій, які власник хотів
  // найбільше (він же на них подався). Провал співбесіди — так само не преференція.
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

/**
 * Статус конекторів БЕЗ мережі: наявність GOOGLE_*-секретів + скоупи з кешу
 * `googleToken` (googleAccessToken кладе туди `scope` при обміні). Свідомо НЕ
 * викликаємо googleAccessToken(): відкриття налаштувань не повинне тягнути
 * OAuth-обмін (зайва латентність + мережева залежність на екрані, який просто
 * показує стан). Кеш ще порожній -> віддаємо за наявністю секретів.
 */
async function googleConnectors(env) {
  const hasGoogleCreds = Boolean(
    env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN,
  );
  let scope = null;
  if (hasGoogleCreds) {
    try {
      scope = JSON.parse((await env.BRIEFING.get('googleToken')) ?? 'null')?.scope ?? null;
    } catch {
      /* биття кешу -> скоупи невідомі, фолбек за секретами */
    }
  }
  return connectorStatus({ hasGoogleCreds, scope });
}

/**
 * GET /api/settings -> налаштування власника + статус конекторів.
 * POST /api/settings {settings, initData} -> ЗАМІНИТИ блоб цілком (PUT-семантика).
 *
 * Свідомо БЕЗ read-modify-write. Спокуса «прочитати + накласти патч» тут
 * оманлива: KV не має ні CAS, ні гарантії read-your-writes (~до 60с), а екран
 * шле окрему мутацію НА КОЖЕН тумблер — два швидкі тапи, і обидва запити
 * читають той самий базовий блоб, після чого другий PUT тихо затирає перший.
 * Тому: єдиний писар (власник) шле ПОВНИЙ стан, який у нього вже є в кеші, а
 * сервер лише валідує й кладе. Клієнт серіалізує запити (scope у
 * useSaveSettings), тож останній тап = останній PUT.
 *
 * Тижнева ціль подач тут СВІДОМО відсутня: вона живе у блобі `stats`
 * (goal.weeklyTarget агрегується поруч із weeklyApplied) і виставляється подією
 * `set_goal` через /api/event, як решта мутацій дашборда.
 */
async function handleSettings(request, env) {
  if (!env.TELEGRAM_BOT_TOKEN) return json({ ok: false, error: 'no-token' }, 500);

  if (request.method === 'GET') {
    const auth = await checkOwnerRead(request, env);
    if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);
    const [settings, connectors] = await Promise.all([loadSettings(env), googleConnectors(env)]);
    return json({ ok: true, settings, connectors });
  }

  if (request.method !== 'POST') return json({ ok: false, error: 'method' }, 405);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'bad-json' }, 400);
  }
  const auth = await checkOwner(body?.initData, env);
  if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);

  // Вимагаємо ПОВНИЙ блоб: часткове тіло normalizeSettings мовчки добив би
  // дефолтами (тихі години злетіли б на 22:00–08:00 при перемиканні модуля).
  // Краще гучне 400, ніж тиха втрата налаштувань.
  const raw = body?.settings;
  if (!raw || typeof raw !== 'object' || !raw.quiet || !raw.modules) {
    return json({ ok: false, error: 'bad-params' }, 400);
  }
  const next = normalizeSettings(raw);
  await env.BRIEFING.put('settings', JSON.stringify(next));
  const connectors = await googleConnectors(env);
  return json({ ok: true, settings: next, connectors });
}

/**
 * GET /api/saved?offset=&limit= -> сторінка збереженого (F3).
 *
 * Окремий ендпоінт, а не поле в /api/stats: там savedList свідомо обрізаний до
 * 8 як прев'ю, і тягти повний архів (сотні записів) у КОЖНЕ відкриття апки
 * заради рядка «Ти зберіг N» — марно. Архів у KV не обрізаний ніколи; його лише
 * не показували.
 */
async function handleSaved(request, env) {
  const auth = await checkOwnerRead(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);
  const url = new URL(request.url);
  // Кламп і дефолти — у чистій pageSaved (там же й тести).
  const page = pageSaved(await loadStats(env), {
    offset: url.searchParams.get('offset'),
    limit: url.searchParams.get('limit'),
  });
  return json({ ok: true, ...page });
}

/** GET /api/stats -> агрегат для табу «Статистика». Auth власника (H1): стрік,
 *  воронка, інтереси — приватні; без initData -> 401/403 (фронт ховає таб). */
async function handleStats(request, env) {
  const auth = await checkOwnerRead(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);
  // Два незалежні KV-читання — паралельно (найгарячіший читальний шлях).
  const [store, state] = await Promise.all([loadStats(env), loadState(env)]);
  const stats = aggregateStats(store, kyivDateKey());
  // roadmap/mastery — окремий KV-блоб (state, не stats); aggregateStats лишається
  // чистим агрегатором stats-блоба, роадмеп-контент йому знати не треба.
  const progress = state.roadmapProgress ?? {};
  stats.roadmap = totalProgress(progress);
  // A4: звʼязка mock↔roadmap для дашборда — слабкі теми -> «куди вчитись»,
  // «тема тижня» -> фокус наступного mock-батчу.
  stats.mastery = {
    hints: masteryHints(stats.mock?.weakTopics ?? [], progress),
    themeOfWeek: themeOfWeek(progress, kyivDateKey()),
  };
  // F4: mock-тема -> куровані матеріали роадмепу («Вивчити» в картці питання).
  // Мапа стала й крихітна (13 тем × 2 посилання) — віддаємо цілком, щоб клієнт
  // не дублював у себе таблицю звʼязку mock↔roadmap.
  stats.mockMaterials = mockMaterials();
  // Голоси per-url (C3): дашборд гідратує підсвітку 👍/👎 з цього, щоб після
  // переоткриття Mini App повторний тап не «знімав» невидимо активний голос
  // (ревʼю C). Віддаємо компактно {url: 'up'|'down'}, без delta/category.
  stats.votes = Object.fromEntries(
    Object.entries(state.votedUrls ?? {})
      .filter(([, v]) => v && (v.dir === 'up' || v.dir === 'down'))
      .map(([url, v]) => [url, v.dir]),
  );
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
 * не платний API). Graceful degradation зберігається: жодна гілка не кидає.
 *
 * A1: замість глухого `null` на будь-який збій повертає ПРИЧИНУ —
 * {ok:false, status, error} (status: HTTP-код або 0 для мережі/таймауту/
 * ненала­штованості). Виклики, яким байдуже (reminder-rewrite), і далі просто
 * читають `res?.structured` -> undefined; асистент мапить причину в людський
 * текст (classifyLlmFailure/assistantErrorReply, agent-core.mjs). Тіло помилки
 * хоста — це фіксований енум ('usage-limit'/'rate-limited'/'timeout'/…) або
 * текст CLI, який хост уже пропустив через власну класифікацію.
 */
async function callLlmHost(env, { prompt, systemPrompt, jsonSchema, model }) {
  if (!env.LLM_HOST_URL || !env.LLM_HOST_SECRET) {
    return { ok: false, status: 0, error: 'not-configured' };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25_000); // менше за таймаут хоста (30с)
  try {
    const res = await fetch(env.LLM_HOST_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-llm-host-secret': env.LLM_HOST_SECRET },
      // model опційна — undefined випадає з JSON.stringify, хост тоді бере свій
      // DEFAULT_MODEL (haiku). Так reminder-rewrite лишається на haiku, а
      // асистент-агент передає 'sonnet' явно (CC2).
      body: JSON.stringify({ prompt, systemPrompt, jsonSchema, model }),
      signal: ctrl.signal,
    });
    // Тіло читаємо ОДИН раз (Response.body — стрім, .text() після .json() кине).
    const raw = await res.text().catch(() => '');
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch {
      /* не-JSON тіло (проксі/502-сторінка) -> data лишається null */
    }
    if (!res.ok || !data?.ok) {
      console.error('llm-host HTTP', res.status, raw.slice(0, 300));
      return {
        ok: false,
        status: res.status,
        error: typeof data?.error === 'string' ? data.error : `http-${res.status}`,
        ...(Number.isFinite(data?.resetAtMs) ? { resetAtMs: data.resetAtMs } : {}),
      };
    }
    return data;
  } catch (err) {
    // AbortError — це наш 25-секундний таймаут, не «хост лежить»: різні тексти.
    const aborted = err?.name === 'AbortError';
    console.error('llm-host call failed', err?.message);
    return { ok: false, status: 0, error: aborted ? 'timeout' : 'offline' };
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
  // Кеш access-токена в KV (SL3): N раундів агента (кожен читає календар) НЕ
  // роблять N окремих OAuth-обмінів. Токен короткоживучий (~1год), у власному
  // KV-namespace — прийнятно. Биття кешу -> перевидати.
  try {
    const cached = JSON.parse((await env.BRIEFING.get('googleToken')) ?? 'null');
    if (isAccessTokenFresh(cached, Date.now())) return cached.token;
  } catch {
    /* биття -> перевидати нижче */
  }
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
    const token = typeof json.access_token === 'string' ? json.access_token : null;
    if (token) {
      // Кеш — BEST-EFFORT (ревʼю SL): збій KV-запису (rate-limit 1/сек на ключ /
      // денний кап Free) НЕ сміє відкинути щойно виданий валідний токен, інакше
      // календар мовчки недоступний попри успішний OAuth. Тому окремий try.
      try {
        // expires_in (сек) мінус 60с запасу; фолбек 55хв, якщо поле відсутнє.
        const ttlSec = Number.isFinite(json.expires_in) ? Math.max(60, json.expires_in - 60) : 3300;
        // scope (F2): Google повертає перелік консентованих скоупів у самій
        // відповіді обміну, тож статус конекторів у Mini App дістається задарма —
        // без окремого виклику tokeninfo. Поле опційне; його відсутність
        // деградує до «обидва сервіси» (connectorStatus).
        await env.BRIEFING.put(
          'googleToken',
          JSON.stringify({
            token,
            expMs: Date.now() + ttlSec * 1000,
            ...(typeof json.scope === 'string' ? { scope: json.scope } : {}),
          }),
        );
      } catch (e) {
        console.error('googleToken cache write failed (best-effort, токен усе одно віддаємо)', e);
      }
    }
    return token;
  } catch (err) {
    console.error('google token failed', err.message);
    return null;
  }
}

// Gmail (B3, дія readMail). Той самий OAuth-токен, що й календар: скоуп
// gmail.readonly уже у GOOGLE_REFRESH_TOKEN (Блок P2c, ре-консент зроблено) —
// нового консенту НЕ потрібно. Читаємо ЛИШЕ метадані (format=metadata) + snippet:
// повні тіла листів не тягнемо ні в промпт, ні навіть у память Worker'а.
const MAIL_MAX_RESULTS = 5;
const MAIL_HEADERS = ['From', 'Subject', 'Date'];

/** Пошук у Gmail -> [{from,subject,date,snippet}] | [] (нічого) | null (немає доступу/збій). */
async function readMail(env, rawQuery) {
  const token = await googleAccessToken(env);
  if (!token) return null;
  const auth = { Authorization: `Bearer ${token}` };
  const listUrl = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
  listUrl.searchParams.set('q', sanitizeMailQuery(rawQuery));
  listUrl.searchParams.set('maxResults', String(MAIL_MAX_RESULTS));
  try {
    const res = await fetch(listUrl.toString(), { headers: auth });
    if (!res.ok) {
      console.error('gmail list HTTP', res.status, await res.text().catch(() => ''));
      return null;
    }
    const ids = ((await res.json()).messages ?? []).slice(0, MAIL_MAX_RESULTS).map((m) => m.id);
    if (ids.length === 0) return [];
    const msgs = await Promise.all(
      ids.map(async (id) => {
        // Try/catch НАВКОЛО кожного листа (ревʼю B): кинутий fetch (транзієнтна
        // мережева помилка/abort) інакше зронив би весь Promise.all -> null ->
        // «пошта недоступна», хоча акаунт авторизований і решта листів дістались.
        // Тепер один збій = мінус один лист, як і при !r.ok.
        try {
          const u = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`);
          u.searchParams.set('format', 'metadata');
          for (const h of MAIL_HEADERS) u.searchParams.append('metadataHeaders', h);
          const r = await fetch(u.toString(), { headers: auth });
          if (!r.ok) return null;
          const j = await r.json();
          const headers = j?.payload?.headers ?? [];
          const get = (name) =>
            headers.find((h) => String(h?.name).toLowerCase() === name)?.value ?? '';
          return {
            from: get('from'),
            subject: get('subject'),
            date: get('date'),
            snippet: j?.snippet ?? '',
          };
        } catch (e) {
          console.error('gmail message fetch failed (один лист пропущено)', e?.message);
          return null;
        }
      }),
    );
    return msgs.filter(Boolean);
  } catch (err) {
    console.error('gmail read failed', err.message);
    return null;
  }
}

/** Події діапазону [startKey..endKey] (Київ) через Google Calendar API (read, CC1 —
 *  один запит на весь діапазон, timeMin/timeMax). null при будь-якому збої. */
async function readCalendarRange(env, startKey, endKey) {
  const token = await googleAccessToken(env);
  if (!token) return null;
  const { timeMin, timeMax } = kyivRangeBoundsUtc(startKey, endKey);
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

// Фаза C3: /start (онбординг+keyboard) і /help (повний реєстр команд) розділено —
// раніше /start і показував список, і переспамлював reply-keyboard в одному.
const START_TEXT = [
  '👋 Привіт! Я асистент <b>Світанок</b>.',
  '',
  'Повний список команд — /help.',
  '',
  'Швидкі кнопки внизу завжди під рукою. Нагадати можна й без команди — просто',
  'напиши "нагадай ...". У темі 🤖Асистент можна й просто написати вільним',
  'текстом — календар, нагадування, план дня.',
].join('\n');

const HELP_TEXT = [
  '📋 <b>Команди</b>',
  '',
  '/brief — запустити ранковий брифінг',
  '/stats — стрік і статистика',
  '/jobs — активна воронка вакансій',
  '/save — збережене',
  '/remind — нагадування (напр. "через 20 хв ..." або "завтра о 10:00 ...")',
  '/reminders — список активних нагадувань (можна скасувати)',
  '/plan — план дня (LLM прочитає календар і запропонує таймлайн)',
  '/roadmap — IT-роадмеп (теми → підпункти, прогрес)',
  '/settings — тихі години, ціль, модулі брифінгу',
  '/clear [N] — видалити останні N повідомлень тут — мої та твої (за замовч. 20)',
  '/whereami — chat_id/thread_id цього чату',
].join('\n');

// Фаза B2: профіль бота (setMyDescription/setMyShortDescription) — те, що
// власник бачить ДО першого /start (порожній чат) і в прев'ю/шарінгу. Разом
// із розширеним REPLY_KEYBOARD (tg-core.mjs) компенсує видалену тему
// «Команди» (та ніколи не мала прив'язки в коді, суто організаційна).
const BOT_DESCRIPTION =
  'Персональний ранковий брифінг: погода, курс, новини, вакансії, IT-роадмеп. ' +
  'Плюс асистент — нагадування, календар, план дня. Напиши /help, щоб побачити всі команди.';
const BOT_SHORT_DESCRIPTION = 'Ранковий брифінг + асистент для пошуку роботи в IT.';

const UNKNOWN_REPLY =
  '🤖 Асистент-діалог ще не підключений (зʼявиться пізніше). Натисни /help, щоб побачити доступні команди.';
const REMINDER_HELP =
  '🤔 Не зрозумів час. Приклади: "через 20 хвилин", "завтра о 10:00", "о 15:30".';

// Обмежена кількість раундів агента (Блок P2b) — кожен раунд до 25с
// (callLlmHost-таймаут); readCalendar->рішення реалістично влазить у 3.
const MAX_ROUNDS = 3;
// Модель асистента обирає pickAssistantModel(userText) (SL1): дефолт haiku,
// sonnet лише для планувальних запитів — щоб не проїдати спільний пул підписки
// Pro (та сама, що дев-робота власника). Reminder-rewrite лишається на haiku.
// Кап тексту користувача в transcript (ревʼю CM): сума історія(≤500)+дайджест
// (≤1500)+календар(≤900)+пошта(≤900)+текст має лишатись під MAX_PROMPT_LEN хоста
// (6000 після B4); фінальний запобіжник — clipTranscript (agent-core.mjs).
const MAX_USER_TEXT = 500;
// ASSISTANT_FALLBACK_REPLY тепер живе в agent-core.mjs — поруч із рештою текстів
// відмов (assistantErrorReply), щоб «не зміг розібратись» лишався ОДНИМ із
// варіантів, а не єдиним (A1).
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

/**
 * Спільна логіка трекінгу для /clear (§C5): якщо sendMessage вдався, записати
 * message_id у ring buffer. Викликається і з sendTo() (webhook-контекст), і з
 * checkReminders() (cron-контекст, немає вхідного parsed) — тому приймає
 * chatId/threadId явно, а не через parsed. res.clone() перед .json(), щоб не
 * спожити тіло Response для можливих майбутніх консюмерів повернутого значення.
 */
async function trackSentMessage(env, res, chatId, threadId) {
  if (!res.ok) return;
  try {
    const json = await res.clone().json();
    const messageId = json?.result?.message_id;
    if (typeof messageId === 'number') {
      const sentMessages = recordSentMessage(
        await loadSentMessages(env),
        chatId,
        threadId,
        messageId,
      );
      await env.BRIEFING.put('sentMessages', JSON.stringify(sentMessages));
    }
  } catch (e) {
    console.error('sentMessages tracking failed (не блокує відповідь)', e);
  }
}

/** G1: записати message_id ВХІДНОГО повідомлення власника в той самий ring-buffer
 *  sentMessages, щоб /clear видаляв і його репліки, не лише відповіді бота (у
 *  супергрупі бот-адмін із can_delete_messages може; у DM Telegram не дає
 *  видаляти повідомлення користувача — тоді deleteMessage просто відмовить,
 *  оброблено як звичайну відмову). Merge-before-flush, як trackSentMessage. */
async function trackIncomingMessage(env, parsed) {
  if (typeof parsed.messageId !== 'number') return;
  try {
    const sentMessages = recordSentMessage(
      await loadSentMessages(env),
      parsed.chatId,
      parsed.threadId,
      parsed.messageId,
    );
    await env.BRIEFING.put('sentMessages', JSON.stringify(sentMessages));
  } catch (e) {
    console.error('incoming message tracking failed (не блокує обробку)', e);
  }
}

/** sendMessage-closure з chat_id/thread_id вже зашитими (спільна для 4 хендлерів нижче). */
function sendTo(env, parsed) {
  return async (text, extra) => {
    const res = await tgCall(env, 'sendMessage', {
      chat_id: parsed.chatId,
      message_thread_id: parsed.threadId ?? undefined,
      text,
      ...extra,
    });
    await trackSentMessage(env, res, parsed.chatId, parsed.threadId);
    return res;
  };
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
async function createReminderFromText(env, parsed, text, { agentFallback = false } = {}) {
  const sendText = sendTo(env, parsed);

  // Порожнє «/remind» без аргументів (ревʼю B): без цього гейта фраза йшла у
  // спінер + холостий callLlmHost(''), а далі в agentFallback -> агент бачив
  // порожній текст і віддавав СТАРУ заглушку «асистент ще не підключений».
  if (!text || !text.trim()) return sendText(REMINDER_HELP);

  let parsedTime = parseReminderTime(text, Date.now());
  if (!parsedTime && env.LLM_HOST_URL) {
    await sendText('🤔 Хвилинку, розбираюсь...');
    parsedTime = await tryLlmReminderRewrite(env, text);
  }
  if (!parsedTime) {
    if (agentFallback && env.LLM_HOST_URL) return runAssistantAgent(env, parsed, text);
    return sendText(REMINDER_HELP);
  }

  const state = await loadState(env);
  state.reminders = addReminder(state.reminders, {
    id: crypto.randomUUID(),
    text: parsedTime.remainder,
    whenMs: parsedTime.whenMs,
    nowMs: Date.now(),
  });
  await env.BRIEFING.put('state', JSON.stringify(state));
  return sendText(formatReminderConfirm(parsedTime.whenMs, parsedTime.remainder, Date.now()), {
    parse_mode: 'HTML',
  });
}

/**
 * Скасувати активне нагадування за описом (CM3, дія cancelReminder агента):
 * збіг по підрядку тексту серед активних. 0 -> не знайшов; 1 -> скасувати +
 * підтвердити; >1 -> уточнити (не вгадуємо, яке саме). Плоский текст (без
 * parse_mode) — текст нагадування довільний, Telegram не інтерпретує розмітку.
 */
async function cancelReminderByText(env, parsed, matchText) {
  const sendText = sendTo(env, parsed);
  const state = await loadState(env);
  const active = listActive(state.reminders);
  const q = matchText.toLowerCase();
  const matches = active.filter((r) => String(r.text).toLowerCase().includes(q));

  if (matches.length === 0) {
    return sendText(`🤔 Не знайшов активного нагадування «${matchText}». Список — /reminders.`);
  }
  if (matches.length > 1) {
    const list = matches.map((r, i) => `${i + 1}. ${r.text}`).join('\n');
    return sendText(`🤔 Кілька нагадувань підходять — уточни, яке саме:\n${list}`);
  }
  state.reminders = cancelReminder(state.reminders, matches[0].id);
  await env.BRIEFING.put('state', JSON.stringify(state));
  return sendText(`🗑 Скасував нагадування: ${matches[0].text}`);
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
  const priorContext = renderHistoryForPrompt(
    await loadAssistantHistory(env),
    parsed.chatId,
    parsed.threadId,
  );
  // Зберегти обмін у памʼять треду (CM): перечитуємо перед put (merge-before-flush,
  // той самий патерн, що /clear) — щоб конкурентний запис у ті ж секунди не
  // затерло. assistantSummary — короткий опис відповіді для контексту наступних
  // реплік (для reply — сам текст; для дій — маркер типу дії).
  const remember = async (assistantSummary) => {
    let h = await loadAssistantHistory(env);
    h = appendTurn(h, parsed.chatId, parsed.threadId, 'user', userText);
    h = appendTurn(h, parsed.chatId, parsed.threadId, 'assistant', assistantSummary);
    await env.BRIEFING.put('assistantHistory', JSON.stringify(h));
  };

  const userMsg = userText.length > MAX_USER_TEXT ? userText.slice(0, MAX_USER_TEXT) : userText;
  const model = pickAssistantModel(userText); // SL1: haiku за замовч., sonnet для планування
  let transcript = `${priorContext}Користувач написав: "${userMsg}"`;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await callLlmHost(env, {
      // clipTranscript — запобіжник бюджету (B3): за 3 раунди агент може дописати
      // календар + own-data + пошту; перевищення MAX_PROMPT_LEN хоста дало б 400 і
      // мовчазний фолбек замість відповіді.
      prompt: clipTranscript(transcript),
      systemPrompt: buildAssistantSystemPrompt(nowMs),
      jsonSchema: ASSISTANT_ACTION_SCHEMA,
      model,
    });
    const action = extractAssistantAction(res?.structured);
    // Хост недоступний/невалідна дія -> чесний фолбек. Тепер текст залежить від
    // ПРИЧИНИ (A1): вичерпані ліміти підписки / rate-limit / таймаут / хост лежить
    // / модель віддала дурню. Історію НЕ чіпаємо (ревʼю CM): провалений (часто
    // оверсайз) обмін інакше отруював би priorContext наступних повідомлень і
    // сузив би бюджет ще більше (компаундинг).
    if (!action) return sendText(assistantErrorReply(res, nowMs));

    if (action.action === 'reply') {
      const text = action.replyText || ASSISTANT_FALLBACK_REPLY;
      await remember(text);
      return sendText(text);
    }
    if (action.action === 'createReminder') {
      await remember('[поставив нагадування]');
      return createReminderFromText(env, parsed, action.reminderText);
    }
    if (action.action === 'cancelReminder') {
      await remember('[скасував нагадування]');
      return cancelReminderByText(env, parsed, action.reminderText);
    }
    if (action.action === 'proposeCalendarChanges') {
      await remember('[запропонував зміни календаря]');
      return proposeCalendarChanges(env, parsed, action.proposal);
    }
    if (action.action === 'readMail') {
      // Пошта (B3) — читаємо, стискаємо в дайджест, продовжуємо цикл (як
      // readCalendar/readOwnData). Вміст листів — ЛИШЕ ДАНІ (див. системний
      // промпт + плющення в assistant-data-core): у листі цілком може лежати
      // текст, що прикидається інструкцією.
      const mail = await readMail(env, action.mailQuery);
      transcript += `\n\n${formatMailForPrompt(mail)}`;
      continue;
    }
    if (action.action === 'readOwnData') {
      // Прочитати ВЛАСНІ дані користувача (CC4), стиснути в компактний дайджест,
      // дописати в transcript, продовжити цикл (як readCalendar). Читаємо всі три
      // блоби завжди (KV-читання дешеві; buildOwnDataDigest бере лише потрібне за
      // scope) — простіше за розгалуження по scope. Дайджест — ЛИШЕ ДАНІ для LLM
      // (плоский текст, prompt-injection застереження в системному промпті).
      const [state, stats, latest] = await Promise.all([
        loadState(env),
        loadStats(env),
        loadLatest(env),
      ]);
      const todayKey = kyivDateKey(new Date(nowMs));
      const digest = buildOwnDataDigest({
        scope: action.dataScope,
        reminders: state.reminders,
        agg: aggregateStats(stats, todayKey),
        roadmap: totalProgress(state.roadmapProgress ?? {}),
        latest,
        todayKey,
      });
      transcript += `\n\nТвої дані: ${digest}`;
      continue;
    }
    // readCalendar — дописати події діапазону [startDay,endDay] від сьогодні (CC1),
    // продовжити цикл. Y-M-D зсув через addDaysToDateKey (НЕ +N*86400000мс на
    // інстант — те ламається на DST-переході, коли зсув доби і +1год стрибок
    // комбінуються). Один день -> formatEventsForPrompt (без дати), діапазон ->
    // formatRangeEventsForPrompt (кожна подія з префіксом DD.MM).
    const today = kyivDateKey(new Date(nowMs));
    const startKey = addDaysToDateKey(today, action.startDay);
    const endKey = addDaysToDateKey(today, action.endDay);
    const events = await readCalendarRange(env, startKey, endKey);
    const single = action.startDay === action.endDay;
    const label = single ? startKey : `${startKey}…${endKey}`;
    const body = single
      ? formatEventsForPrompt(events ?? [])
      : formatRangeEventsForPrompt(events ?? []);
    transcript += `\n\nКалендар (${label}): ${body}`;
  }
  return sendText(ASSISTANT_FALLBACK_REPLY); // вичерпані раунди — не помилка (історію не чіпаємо)
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
    // Тригер нагадування (P2a) — першим, як і раніше. agentFallback (B2): якщо
    // час не розібрався — не глухе «не зрозумів», а розмова з агентом (памʼять
    // треду -> перепитав і зібрав відповідь).
    if (/нагад/i.test(parsed.text)) {
      return createReminderFromText(env, parsed, parsed.text, { agentFallback: true });
    }
    // Вільний текст у 🤖Асистент (чи DM, без тем) -> LLM tool-use агент (Блок
    // P2b). Інші теми (Роадмеп/Брифінг/Система) — тема-специфічна поведінка
    // там свідомо поза межами, лишається стара заглушка.
    if (parsed.threadId == null || String(parsed.threadId) === String(env.TOPIC_ASSISTANT)) {
      return runAssistantAgent(env, parsed, parsed.text);
    }
    return sendText(UNKNOWN_REPLY);
  }

  switch (cmd.cmd) {
    case 'start':
      return sendText(START_TEXT, {
        parse_mode: 'HTML',
        reply_markup: { keyboard: REPLY_KEYBOARD, resize_keyboard: true },
      });
    case 'help':
      return sendText(HELP_TEXT, { parse_mode: 'HTML' });
    case 'brief': {
      // Кулдаун 1 год (SL2): кожен /brief = повний workflow_dispatch (палить
      // хвилини Actions + квоту KV/новин), guard гасить лише подвійну відправку.
      const remainMs = briefCooldownRemainingMs(
        (await loadBriefDispatch(env)).lastMs,
        Date.now(),
        60 * 60_000,
      );
      if (remainMs > 0) {
        const mins = Math.ceil(remainMs / 60_000);
        return sendText(
          `⏳ Брифінг нещодавно запускався. Спробуй за ${mins} хв (або дочекайся щоденного о 08:00).`,
        );
      }
      // Мітку кулдауну сіємо ЛИШЕ після успішного dispatch (ревʼю SL): інакше
      // транзієнтний збій GitHub блокував би повтор на годину + брехливе «Запустив».
      const ok = await dispatchBrief(env);
      if (!ok) {
        return sendText(
          '⚠️ Не вдалося запустити генерацію (тимчасова помилка GitHub). Спробуй ще раз за хвилину.',
        );
      }
      await recordBriefDispatch(env);
      return sendText('🔄 Запустив генерацію брифінгу — прийде за кілька хвилин.');
    }
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
      return createReminderFromText(env, parsed, cmd.args, { agentFallback: true });
    case 'reminders': {
      const reminders = (await loadState(env)).reminders ?? [];
      const keyboard = buildRemindersKeyboard(reminders);
      return sendText(formatRemindersListMessage(reminders), {
        parse_mode: 'HTML',
        // reply_markup лише коли є що скасовувати — Telegram не любить порожній inline_keyboard.
        ...(keyboard.inline_keyboard.length ? { reply_markup: keyboard } : {}),
      });
    }
    case 'plan':
      // Префікс «Склади план дня» завжди присутній -> pickAssistantModel дає sonnet
      // (SL1), навіть якщо аргументи не містять планувальних слів.
      return runAssistantAgent(
        env,
        parsed,
        cmd.args ? `Склади план дня: ${cmd.args}` : 'Склади план дня',
      );
    case 'roadmap': {
      const progress = (await loadState(env)).roadmapProgress ?? {};
      return sendText(formatRootMessage(progress), {
        parse_mode: 'HTML',
        reply_markup: buildRootKeyboard(progress),
      });
    }
    case 'clear': {
      const n = parseClearCount(cmd.args);
      const ids = lastSentMessages(await loadSentMessages(env), parsed.chatId, parsed.threadId, n);
      let deleted = 0;
      const forget = []; // остаточно відмовлені id (>48г/без прав) — не пробувати знову
      // Пачками по DELETE_CHUNK_SIZE (не всі N одразу) — компроміс між швидкістю
      // (не повністю послідовно) і обережністю до rate-limit Telegram/Worker.
      for (const chunk of chunkArray(ids, DELETE_CHUNK_SIZE)) {
        const settled = await Promise.allSettled(
          chunk.map((id) =>
            tgCall(env, 'deleteMessage', { chat_id: parsed.chatId, message_id: id }),
          ),
        );
        settled.forEach((r, i) => {
          const id = chunk[i];
          if (r.status !== 'fulfilled') return; // мережева помилка -> ретрай наступного /clear
          if (r.value.ok) {
            deleted++;
            forget.push(id);
          } else if (r.value.status !== 429) {
            // Не rate-limit -> постійна відмова (найімовірніше >48г) -> не тримати id далі.
            forget.push(id);
          }
          // 429 -> НЕ forget: спробувати цей id ще раз наступного /clear.
        });
      }
      // Merge-before-flush (той самий патерн, що src/core/state-kv.ts): цикл
      // видалення міг тривати секунди — перечитуємо ЗАРАЗ і прибираємо ЛИШЕ
      // forget із ЦЬОГО ключа, а не перезаписуємо весь блоб застарілим
      // знімком (інакше конкурентний sendTo()/checkReminders() запис у ті ж
      // секунди був би мовчки затертий — саме той H2-клас гонки, заради
      // якого sentMessages узагалі живе в окремому ключі від 'state').
      const key = sentMessagesKey(parsed.chatId, parsed.threadId);
      const fresh = await loadSentMessages(env);
      fresh[key] = (fresh[key] ?? []).filter((id) => !forget.includes(id));
      await env.BRIEFING.put('sentMessages', JSON.stringify(fresh));
      return sendText(formatClearResult(deleted, ids.length));
    }
    case 'whereami': {
      // getMe -> can_read_all_group_messages: єдиний спосіб дізнатись, чи не
      // ріже Telegram вільний текст режимом приватності (див. formatWhereAmI).
      // Best-effort: діагностика не має падати через мережу.
      let me = null;
      try {
        const res = await tgCall(env, 'getMe', {});
        me = (await res.json())?.result ?? null;
      } catch {
        /* немає — просто не покажемо рядок про приватність */
      }
      return sendText(formatWhereAmI(parsed.chatId, parsed.threadId, me), { parse_mode: 'HTML' });
    }
    case 'settings':
      return sendText(
        // Кнопка веде на головну Mini App (Direct Link ?startapp без параметра —
        // deep-link у розділ вимагав би зміни спільної buildMiniAppButton, яка
        // дзеркалиться в src/core/telegram.ts). Тож просто кажемо, куди тиснути.
        '⚙️ Налаштування — у Mini App, шестерня вгорі праворуч: тихі години, тижнева ціль подач, модулі брифінгу, конектори.',
        {
          reply_markup: {
            // TELEGRAM_BOT_USERNAME (Direct Link Mini App) заданий -> initData
            // працює і в групі; інакше фолбек за parsed.chatId (web_app лише в
            // приватних чатах — BUTTON_TYPE_INVALID у групі/темі інакше, §core/telegram.ts).
            inline_keyboard: [
              [
                buildMiniAppButton(
                  '📊 Відкрити Mini App',
                  origin,
                  parsed.chatId,
                  env.TELEGRAM_BOT_USERNAME,
                ),
              ],
            ],
          },
        },
      );
    default:
      return sendText(UNKNOWN_REPLY);
  }
}

/**
 * Спільна логіка snooze/cancel (§C4): завантажити стан, перевірити існування
 * нагадування, мутувати (mutate — snoozeReminder чи cancelReminder), зберегти,
 * тікнути кнопку (markButtonDone+editMessageReplyMarkup — одноразовий статус-
 * тік, не перерендер усього повідомлення, на відміну від roadmap, де
 * editMessageText доречний для навігації меню). Розрізняються лише mutate-
 * функцією й текстом тосту.
 */
async function resolveReminderAction(env, parsed, reminderId, mutate, successToast) {
  const state = await loadState(env);
  const reminders = Array.isArray(state.reminders) ? state.reminders : [];
  if (!reminders.some((r) => r.id === reminderId)) return '⚠️ Це нагадування вже неактуальне.';

  state.reminders = mutate(reminders, reminderId, Date.now());
  await env.BRIEFING.put('state', JSON.stringify(state));
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
async function resolveReminderSnooze(env, parsed, reminderId) {
  return resolveReminderAction(env, parsed, reminderId, snoozeReminder, '😴 Відкладено на 10 хв');
}

/** Обробити cancel-callback (`rc:<id>`, §C4) — видалити нагадування назавжди. */
async function resolveReminderCancel(env, parsed, reminderId) {
  return resolveReminderAction(env, parsed, reminderId, cancelReminder, '🗑 Нагадування скасовано');
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

  // Тихі години (F2): не шлемо — і НЕ позначаємо спрацьованими. dueReminders —
  // чистий фільтр, що переобчислюється кожні 5 хв, тож прострочені просто
  // лишаються в черзі й підуть першим тіком після кінця вікна. Саме це й
  // означає «відкладаються на ранок»: нічого не губиться, лише зсувається.
  const settings = await loadSettings(env);
  if (isQuietMinute(settings, kyivMinuteOfDay(new Date(now)))) return;

  const chatId = env.TELEGRAM_CHAT_ID;
  const threadId = env.TOPIC_ASSISTANT ?? undefined;
  for (const r of due) {
    const res = await tgCall(env, 'sendMessage', {
      chat_id: chatId,
      message_thread_id: threadId,
      text: formatReminderFired(r.text),
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[{ text: '😴 +10 хв', callback_data: `${REMINDER_CB_PREFIX}${r.id}` }]],
      },
    });
    // §C5: трекаємо для /clear — cron-контекст, немає вхідного parsed, тож
    // chatId/threadId явні (той самий trackSentMessage, що й sendTo()).
    await trackSentMessage(env, res, chatId, threadId);
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
      const reminderCancelId = parseReminderCancelCallbackData(parsed.data); // 'rc:' — §C4
      const isReminderSnooze =
        typeof parsed.data === 'string' && parsed.data.startsWith(REMINDER_CB_PREFIX);
      const toast = proposalCb
        ? await resolveProposalCallback(env, parsed, proposalCb)
        : roadmapCb
          ? await resolveRoadmapCallback(env, parsed, roadmapCb)
          : reminderCancelId
            ? await resolveReminderCancel(env, parsed, reminderCancelId)
            : isReminderSnooze
              ? await resolveReminderSnooze(
                  env,
                  parsed,
                  parsed.data.slice(REMINDER_CB_PREFIX.length),
                )
              : await resolveCallbackToast(env, parsed);
      if (parsed.callbackId) {
        await tgCall(env, 'answerCallbackQuery', {
          callback_query_id: parsed.callbackId,
          text: toast,
        });
      }
    } else if (parsed.kind === 'message' && parsed.chatId != null) {
      // G1: спершу трекнути вхідне (перед handleCommand) — щоб уже цей-таки /clear
      // міг видалити й своє тригер-повідомлення разом із рештою.
      await trackIncomingMessage(env, parsed);
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
  // Фаза B2: профіль бота видно ДО /start (порожній чат) і в прев'ю — не
  // потребує окремої теми «Команди» для пояснення «що це».
  await tgCall(env, 'setMyDescription', { description: BOT_DESCRIPTION });
  await tgCall(env, 'setMyShortDescription', { short_description: BOT_SHORT_DESCRIPTION });
  await tgCall(env, 'setChatMenuButton', {
    menu_button: { type: 'web_app', text: 'Mini App', web_app: { url: url.origin } },
  });
  return json({ ok: res.ok, webhookUrl });
}

/** A4: перед ранковим dispatch зафіксувати «тему тижня» у state.masteryFocus —
 *  оркестратор (src/modules/mock.ts) читає її як готові рядки й СІДИТЬ наступний
 *  mock-батч темою з роадмепу (web-код у src/ не імпортується — межа src/↔web/).
 *  Ротація детермінована за тижнем, тож щоденний перезапис безпечний;
 *  оркестратор masteryFocus не пише -> merge-гонок класу H2 нема. */
async function updateMasteryFocus(env) {
  try {
    const state = await loadState(env);
    const focus = themeOfWeek(state.roadmapProgress ?? {}, kyivDateKey());
    // Тема детермінована на тиждень -> 6/7 щоденних записів були б ідентичні.
    // Пропускаємо no-op: кожен зайвий read-modify-write усього state-блоба —
    // дармове вікно клобберу конкурентних писарів (вебхук/події).
    const cur = state.masteryFocus;
    const same =
      (focus === null && cur === null) ||
      (focus && cur && cur.week === focus.week && cur.topicId === focus.topicId);
    if (same) return;
    state.masteryFocus = focus; // null коли роадмеп завершено — теж валідний стан
    await env.BRIEFING.put('state', JSON.stringify(state));
  } catch (e) {
    console.error('updateMasteryFocus failed', e); // не блокує dispatch
  }
}

/** Точний ранковий тригер: dispatch brief (без force -> нормальний guard).
 *  Повертає true, якщо workflow_dispatch прийнято (SL2 — /brief сіє кулдаун
 *  ЛИШЕ після успіху; ніколи не кидає — false при будь-якому збої). */
async function dispatchBrief(env) {
  if (!env.GH_DISPATCH_TOKEN) {
    console.error('GH_DISPATCH_TOKEN відсутній — dispatch пропущено');
    return false;
  }
  try {
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
      return false;
    }
    return true;
  } catch (e) {
    console.error('workflow_dispatch error', e?.message);
    return false;
  }
}

/**
 * Мітки dispatch брифінгу — ОКРЕМИЙ KV-ключ, не блоб 'state' (ревʼю A; той самий
 * привід, що й у sentMessages вище). Було: recordBriefDispatch робив
 * read-modify-write усього 'state', тож конкурентний писар того ж блоба
 * (checkReminders на тому ж тіку крону, вебхук, багатохвилинний flush
 * оркестратора) міг просто затерти щойно поставлену денну мітку — і наступний
 * 5-хвилинний тік вистрілив би ДРУГИЙ workflow_dispatch. Тепер мітки живуть самі:
 *   {lastMs: <коли будь-який dispatch>, lastAutoDate: 'YYYY-MM-DD' | null}
 * Після деплою ключа ще немає -> кулдаун /brief один раз стартує «з нуля»
 * (нешкідливо: максимум один зайвий ручний запуск).
 */
async function loadBriefDispatch(env) {
  try {
    const parsed = JSON.parse((await env.BRIEFING.get('briefDispatch')) ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Записати мітку dispatch — ЛИШЕ після підтвердженого workflow_dispatch (SL2).
 *  autoDate (A2) ставиться тільки з авто-гілки: ручний /brief може бути й поза
 *  вікном, тож «сьогодні вже диспатчили» — не про нього. Від дубля відразу після
 *  ручного /brief захищає lastMs (MIN_DISPATCH_GAP_MS, tg-core.mjs). */
async function recordBriefDispatch(env, autoDate) {
  const cur = await loadBriefDispatch(env);
  const next = { ...cur, lastMs: Date.now() };
  if (autoDate) next.lastAutoDate = autoDate;
  await env.BRIEFING.put('briefDispatch', JSON.stringify(next));
}

/**
 * A2: ранковий авто-dispatch із пʼятихвилинного крону, у вікні [08:00, 11:00)
 * Києва. Замінює єдину погодинну спробу (kyivHour()===8), яку 14.07 jitter крону
 * Cloudflare (Free) відсунув на ~50 хв — брифінг прийшов о 08:56 замість 08:0x.
 * Тепер до 36 спроб; помилка GitHub ретраїться за 15 хв, а не «завтра».
 * Умови дубля — shouldAutoDispatchBrief (tg-core.mjs, тестовано).
 */
async function autoBriefDispatch(env) {
  const today = kyivDateKey();
  const [state, dispatch] = await Promise.all([loadState(env), loadBriefDispatch(env)]);
  const due = shouldAutoDispatchBrief({
    kyivHour: kyivHour(),
    todayKey: today,
    nowMs: Date.now(),
    lastAutoDate: dispatch.lastAutoDate,
    lastDispatchMs: dispatch.lastMs,
    lastSentDate: state.lastSentDate,
  });
  if (!due) return;
  // masteryFocus — ДО dispatch: брифінг (і можливий mock-батч) читає свіжу
  // «тему тижня» цього ж ранку (важливо на межі тижня — понеділок).
  await updateMasteryFocus(env);
  if (await dispatchBrief(env)) await recordBriefDispatch(env, today);
}

// Dead-man перевіряє день ПІСЛЯ того, як вікно ретраїв закрилось (BRIEF_WINDOW_
// END_HOUR=11 + кілька хвилин на сам ран). Раніше стояв о 10:00 — тепер це було б
// усередині вікна ретраїв: збій GitHub, що минув об 10:30, дав би хибний алерт
// «не доставлено» й хибний промах у reliability за день, який зрештою доставили.
const DEAD_MAN_HOUR = 12;

/** Dead-man's-switch: KV не оновлено сьогодні -> алерт у Telegram.
 *  Веде й облік надійності (reliability у stats). Ідемпотентний за добу — та сама
 *  мітка reliability.lastCheckDate гейтить і алерт (ревʼю A: перевірку перенесено
 *  на пʼятихвилинний крон, бо погодинний із гейтом kyivHour()===10 гинув від того
 *  самого jitter'а, від якого ми щойно врятували dispatch — зсув на годину, і
 *  сторож просто мовчав би цілий день). */
async function deadMansCheck(env) {
  if (kyivHour() < DEAD_MAN_HOUR) return;
  const today = kyivDateKey();
  // Дешевий гейт «уже перевіряли сьогодні» ПЕРЕД будь-якою іншою роботою: без
  // нього алерт летів би на кожен 5-хвилинний тік до кінця доби.
  const store = await loadStats(env);
  if (store?.reliability?.lastCheckDate === today) return;

  const raw = await env.BRIEFING.get('latest');
  let fresh = false;
  try {
    const d = JSON.parse(raw ?? '{}');
    fresh = typeof d.generatedAt === 'string' && kyivDateKey(new Date(d.generatedAt)) === today;
  } catch {
    /* биття JSON -> вважаємо несвіжим -> алерт */
  }
  // Облік доставки — до гейта секретів (не потребує Telegram-крендів), але в
  // try/catch: транзієнтна KV-помилка НЕ сміє заблокувати алерт нижче (це його
  // день). Чесно про гонки: Worker — єдиний СЕРВІС-писар stats-блоба, проте
  // конкурентні інвокації (цей cron vs fetch /api/event) — усе одно
  // last-write-wins без CAS; вікно тут µs і раз на день, стратегічний фікс —
  // Durable Object (див. SPEC/аудит H2).
  try {
    await env.BRIEFING.put('stats', JSON.stringify(recordReliability(store, today, fresh)));
  } catch (e) {
    console.error('reliability write failed', e);
  }
  if (fresh) return;
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.error('TELEGRAM_* відсутні — dead-man пропущено');
    return;
  }

  const resp = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      // Фаза B: тема «⚠️ Система» (операційні алерти окремо від контенту
      // брифінгу). TOPIC_SYSTEM не заведено -> фолбек на стару поведінку
      // (TOPIC_BRIEFING), щоб алерт не «загубився» для власників, які ще
      // не створили нову тему. `||`, не `??` — порожній рядок (Cloudflare-
      // змінна заведена, але лишена пустою) теж має фолбечити, не «зʼїдати»
      // резервну тему мовчки.
      message_thread_id: env.TOPIC_SYSTEM || env.TOPIC_BRIEFING || undefined,
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
    if (url.pathname === '/api/settings') {
      return handleSettings(request, env);
    }
    if (url.pathname === '/api/saved') {
      return handleSaved(request, env);
    }
    if (url.pathname === '/api/telegram' && request.method === 'POST') {
      return handleTelegramWebhook(request, env, ctx);
    }
    if (url.pathname === '/api/telegram/setup' && request.method === 'POST') {
      return handleTelegramSetup(request, env);
    }
    // E4-final (роадмеп v3): корінь віддає React-дашборд (/app/index.html) — URL
    // лишається '/', ассети React абсолютні (/app/assets/*). React пройшов смоук
    // у реальному Telegram, старий index.html видалено, тож фолбек більше не
    // потрібен. Cloudflare build-команда (npm run build:web) гарантує /app у
    // задеплоєних ассетах.
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return env.ASSETS.fetch(new Request(new URL('/app/index.html', url.origin), request));
    }
    return env.ASSETS.fetch(request); // статичні ассети React (/app/*)
  },

  // Єдиний крон (кожні 5 хв) — три задачі, кожна сама себе гейтить за київською
  // годиною і сама ідемпотентна за добу. Жодних DST-костилів із набором погодинних
  // кронів: годину рахує kyivHour() у момент виконання, а не хвилина крону.
  //
  // ПОСЛІДОВНО (await, не два waitUntil — ревʼю A): checkReminders і решта роблять
  // read-modify-write KV без CAS, тож паралельні гілки в одному ізоляті вільно
  // перетинали б вікна GET->PUT і затирали одна одну (втрачений firedTs -> дубль
  // нагадування; втрачена мітка dispatch -> зайвий Actions-ран).
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        await checkReminders(env); // будь-яка хвилина
        await autoBriefDispatch(env); // [08:00, 11:00) Київ, раз на добу
        await deadMansCheck(env); // від 12:00 Київ, раз на добу
      })(),
    );
  },
};
