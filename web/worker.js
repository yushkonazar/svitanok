// Worker: статика дашборда (ASSETS) + /briefing.json із KV + планувальник
// (вікно 08:00–12:00 Київ, спроба щоп'ять хвилин -> GitHub workflow_dispatch,
// рівно один успішний на добу) + DEAD-MAN'S-SWITCH (10:00 Київ) +
// НАГАДУВАННЯ (кожні ~5 хв, Блок P2a) + /api/vote, /api/event (запис подій —
// авторизація власника через Telegram WebApp initData), /api/stats (читання
// агрегату), /api/telegram (вебхук — Блок P0/P1/P4, авторизація через
// X-Telegram-Bot-Api-Secret-Token). KV namespace BRIEFING, ключі
// `latest`/`state`(+`reminders`)/`stats`/`briefing:<date>`.

import {
  recordEvent,
  aggregateStats,
  recordReliability,
  pageSaved,
  checkinSlot,
  checkinDateKey,
  matchCheckinNudgeWindow,
  shouldSendCheckinNudge,
  inSleepNudgeWindow,
  SLEEP_NUDGE_TEXT,
  shouldSendSleepNudge,
  staleSleepNudges,
} from './stats-core.mjs';
import { normalizeSettings, isQuietMinute, connectorStatus } from './settings-core.mjs';
import {
  verifyWebhookSecret,
  constantTimeEqual,
  parseUpdate,
  isOwner,
  isDuplicate,
  parseCallbackData,
  resolveCallback,
  markButtonDone,
  escapeHtml,
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
  LOCATE_CANCEL_LABEL,
} from './tg-core.mjs';
import {
  parseReminderTime,
  addReminder,
  dueReminders,
  markFired,
  snoozeReminder,
  cancelReminder,
  updateReminder,
  listActive,
  formatReminderConfirm,
  formatReminderFired,
  formatRemindersListMessage,
  buildRemindersKeyboard,
  buildReminderCancelCallbackData,
  parseReminderCancelCallbackData,
  buildReminderEditCallbackData,
  parseReminderEditCallbackData,
  parseReminderDoneCallbackData,
  formatReminderDone,
  snoozeReminderPreset,
  parseReminderSnoozeCallbackData,
  buildSnoozeRow,
  LLM_REWRITE_SCHEMA,
  buildLlmRewriteSystemPrompt,
  extractLlmRewrite,
  isAmbiguousRewrite,
  addDaysToDateKey,
  matchDayPartRange,
  pickDayPartSlot,
} from './reminders-core.mjs';
import {
  kyivRangeBoundsUtc,
  parseEvents,
  buildCreateEventBody,
  buildUpdateEventBody,
  findOverlaps,
  formatEventsForPrompt,
  formatRangeEventsForPrompt,
  formatAgendaMessage,
  buildAgendaKeyboard,
  buildAgendaCallbackData,
  parseAgendaCallbackData,
  isAccessTokenFresh,
  buildMapsUrl,
} from './calendar-core.mjs';
import {
  ASSISTANT_ACTION_SCHEMA,
  ASSISTANT_MODEL,
  ASSISTANT_ROUNDS_REPLY,
  ASSISTANT_EMPTY_REPLY,
  ASSISTANT_STALLED_REPLY,
  ASSISTANT_WORKING_REPLY,
  ASSISTANT_FALLBACK_REPLY,
  assistantErrorReply,
  assistantStepLabel,
  clipTranscript,
  buildAssistantSystemPrompt,
  extractAssistantAction,
  sanitizeProposal,
  formatProposalMessage,
  formatProposalResult,
  formatEventEditQuestion,
  parseProposalCallbackData,
  buildProposalKeyboard,
  cycleProposalDuration,
  cycleProposalLead,
  cycleEventShift,
  formatDurationLabel,
  formatLeadLabel,
  formatShiftLabel,
  proposalMode,
  ID_RE,
  classifyHostProbe,
  hostHealthTransition,
  HOST_DESYNC_ALERT,
  HOST_RECOVERED_ALERT,
} from './agent-core.mjs';
import {
  AGENT_MAX_STEPS,
  AGENT_RUN_TTL_MS,
  mintRunToken,
  verifyRunToken,
  nextRunToken,
} from './agent-run-core.mjs';
import {
  buildOwnDataDigest,
  formatMailForPrompt,
  formatMailBodyForPrompt,
  formatDriveForPrompt,
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
  roadmapWeekly,
  formatRootMessage,
  formatTopicMessage,
  buildRootKeyboard,
  buildTopicKeyboard,
} from './roadmap-core.mjs';
import { masteryHints, themeOfWeek, mockMaterials } from './mastery-core.mjs';
import { parseOneCall, mergeAqi } from './weather-core.mjs';

const REMINDER_CB_PREFIX = 'rm:'; // snooze; окремий простір від v1:<dateKey>:... (P1).
// 'rc:' (reminder-cancel, §C4) — окремий простір від rm:/pd:/rd:/v1:, живе в
// reminders-core.mjs (REMINDER_CANCEL_CB_PREFIX) — НЕ підпростір усередині
// 'rm:', бо resolveReminderSnooze бере ВЕСЬ залишок після 'rm:' як id.

// Сон (Блок «Сон») — кнопка «🌙 Ліг спати» на проактивному нагадуванні.
// Без id/аргументів (одна кнопка на все повідомлення) — сама наявність
// префікса вже достатня, дату/ніч рахує сервер (checkinDateKey), як і чек-ін.
const SLEEP_START_CB_PREFIX = 'sl:';
const buildSleepStartCallbackData = () => `${SLEEP_START_CB_PREFIX}1`;
const isSleepStartCallback = (data) =>
  typeof data === 'string' && data.startsWith(SLEEP_START_CB_PREFIX);

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
  // ⚠️ Без цієї перевірки: enc.encode(undefined) -> порожній масив байтів,
  // тож секрет вироджується у HMAC("WebAppData", "") — публічну константу,
  // яку може порахувати БУДЬ-ХТО без знання токена. Не заданий токен (вікно
  // ротації секрету, битий конфіг) тоді тихо перетворює misconfig на fail-open
  // авторизацію, а не на fail-closed відмову.
  if (!initData || !botToken) return null;
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
  // Константночасно (не `!==`): звіряємо HMAC, тож не зливаємо позицію першого
  // розбіжного байта — той самий інваріант, що verifyWebhookSecret/timingSafeEqual.
  if (!constantTimeEqual(computed, hash)) return null;
  const authDate = Number(params.get('auth_date') ?? 0);
  if (!authDate || Date.now() / 1000 - authDate > 86400) return null; // старіше 24 год
  try {
    return { user: JSON.parse(params.get('user') ?? 'null') };
  } catch {
    return { user: null };
  }
}

/**
 * Власник + опційно ще учасники супергрупи (TELEGRAM_ALLOWED_USER_IDS, через
 * кому) -> Set рядкових id. Порожній Set (обидві змінні не задані) — навмисно:
 * і checkOwner, і вебхук тоді фейлять closed (нікому не довіряємо), а не open.
 */
function allowedUserIds(env) {
  const ids = new Set();
  if (env.TELEGRAM_OWNER_USER_ID) ids.add(String(env.TELEGRAM_OWNER_USER_ID));
  for (const raw of String(env.TELEGRAM_ALLOWED_USER_IDS ?? '').split(',')) {
    const id = raw.trim();
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * Валідація initData + дозволений учасник. -> {ok:true,user} або
 * {ok:false,status,error}. Звіряємо з allowedUserIds (персональні user id, НЕ
 * TELEGRAM_CHAT_ID — той тепер лише «куди слати», в супергрупі це вже
 * груповий id, ніколи не рівний user id людини). Fail-closed: жодного
 * дозволеного id не задано -> forbidden, не fail-open.
 */
async function checkOwner(initData, env) {
  const v = await validateInitData(initData, env.TELEGRAM_BOT_TOKEN);
  if (!v) return { ok: false, status: 401, error: 'auth' };
  const allowed = allowedUserIds(env);
  if (!allowed.size || !v.user || !allowed.has(String(v.user.id))) {
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

/** Бакет "О котрій ліг?" (той самий enum, що BEDTIME_BUCKETS/CHECKIN_FIELDS.
 *  morning.bedtime) із київської ГОДИНИ тапу «Ліг спати».
 *
 * ⚠️ Регресія, знайдена реальним HTTP-тестом (worker-sleep-wake.test.ts):
 * стара умова `h < 23` стояла ПЕРШОЮ й ловила ВСІ години 0-22 (0<23 і 1<23
 * теж істинні), тож гілки `h===0`/`h===1` і фолбек 'late' були мертвим кодом
 * — тап після півночі (01:15, 03:00…) завжди писав 'e23' («лягли раніше
 * 23:00») замість коректного пізнього бакета. Підтверджено на прод-KV: запис
 * від 2026-08-04T22:56:40Z (01:56 Київ) мав bedtimeBucket:"e23". Порядок
 * перевірок тепер — точні години СПЕРШУ, `h<23` — лише фолбек для 20-22. */
function bedtimeBucketForHour(h) {
  if (h === 23) return 'e00';
  if (h === 0) return 'e01';
  if (h === 1) return 'e02';
  if (h >= 2 && h <= 5) return 'late';
  return 'e23'; // 20, 21, 22 (і будь-що поза реалістичним діапазоном тапу)
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

/**
 * Безпечний read-modify-write для 'stats' (оптимістична конкуренція, один
 * retry). KV не має вбудованого CAS, а незалежних писарів у цей ключ кілька:
 * Mini App-події (open/checkin/sleepStart), голосування за новину з чату,
 * і три 5-хвилинні крони (checkinNudgeCheck, sleepNudgeCheck, deadMansCheck).
 * Без цього кожен тихо втрачав зміни іншого (last-write-wins): реальний
 * кейс — власник тапнув «Ліг спати», вранці відкрив застосунок, авто-
 * заповнення sleepH/bedtime відбулось (recordEvent — чиста функція,
 * перевірено ізольовано на реальних даних), але крон, який стартував
 * читання ДО цього відкриття, а дописав у KV ПІСЛЯ (його власні Telegram-
 * виклики — секунди), переписав усе своєю застарілою до-заповнення копією.
 *
 * `patch` — ЧИСТА трансформація (store) -> store (той самий контракт, що
 * вже мають recordEvent/recordReliability, і вони теж уже ідемпотентні
 * всередині — case 'checkin' ігнорує confirmed, recordReliability ігнорує
 * повторний lastCheckDate). Якщо між першим і другим читанням хтось інший
 * встиг записати — застосовуємо ТОЙ САМИЙ patch ще раз до свіжішої копії,
 * замість того щоб мовчки затерти чужі зміни. НІКОЛИ не кладіть сюди
 * побічні ефекти (Telegram-виклики тощо) — вони виконались би двічі при
 * ретраї; лише саму мутацію стану, ПІСЛЯ того як side-effects уже сталися.
 */
async function updateStats(env, patch) {
  const raw1 = (await env.BRIEFING.get('stats')) ?? '{}';
  let parsed1;
  try {
    parsed1 = JSON.parse(raw1);
  } catch {
    parsed1 = {};
  }
  const result1 = patch(parsed1);
  const json1 = JSON.stringify(result1);
  const raw2 = (await env.BRIEFING.get('stats')) ?? '{}';
  if (raw2 === raw1) {
    await env.BRIEFING.put('stats', json1);
    return result1;
  }
  let parsed2;
  try {
    parsed2 = JSON.parse(raw2);
  } catch {
    parsed2 = {};
  }
  const result2 = patch(parsed2);
  await env.BRIEFING.put('stats', JSON.stringify(result2));
  return result2;
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

/** POST /api/vote {category, dir:'up', url?, initData} -> preferenceWeights + інтерес.
 *  url (C3): якщо переданий — голос дедуплюється per-url (повторний = зняти).
 *  Без url — стара поведінка (кожен клік зсуває вагу), щоб не ламати клієнтів,
 *  які url ще не шлють.
 *
 *  ⚠️ Межа «створити» vs «прочитати» (фідбек власника, п.5 — ❤️ замість 👍/👎):
 *  НОВИЙ дизлайк створити вже не можна (нижче 400 на будь-що, крім 'up'), але
 *  applyUrlVote/applyVote та recordEvent('vote') мусять і далі РОЗУМІТИ 'down' —
 *  у KV лежать старі голоси, і саме їх треба коректно відкотити, коли власник
 *  лайкне раніше дизлайкнуту новину. Викинеш 'down' із читання — відкотиш не
 *  ту дельту й тихо зіпсуєш вагу теми назавжди. */
async function handleVote(request, env) {
  if (!env.TELEGRAM_BOT_TOKEN) return json({ ok: false, error: 'no-token' }, 500);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'bad-json' }, 400);
  }
  const { category, dir, url, initData } = body ?? {};
  if (typeof category !== 'string' || !category || dir !== 'up') {
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
  // Сон (wokeAt, case 'open') і тап «Ліг спати» (startedAt, case 'sleepStart')
  // обидва потребують ТОЧНОГО часу — recordEvent чистий (без Date.now() всередині),
  // тож рахуємо тут і передаємо явним аргументом, як і nowMin.
  const nowIso = new Date().toISOString();

  let ev = body;
  let dateKey = kyivDateKey();
  if (body.type === 'checkin') {
    // Слот і добу визначає СЕРВЕР, а не клієнт: інакше «ранковий» чек-ін можна
    // надіслати опівночі, перевівши годинник на телефоні. Клієнтський body.slot
    // ігноруємо свідомо — він тут лише підказка для UI.
    const h = kyivHour();
    const slot = checkinSlot(h);
    // Тиха зона (02:00–07:59) — жоден блок не відкритий, писати нічого.
    if (!slot) return;
    ev = { ...body, slot };
    dateKey = checkinDateKey(dateKey, h);
  } else if (body.type === 'sleepStart') {
    // Той самий зсув, що вечірній чек-ін: тап о 00:47 належить учорашньому
    // вечору, не сьогоднішній календарній добі.
    dateKey = checkinDateKey(dateKey, kyivHour());
    // Бакет "О котрій ліг?" рахуємо ТУТ (маємо kyivHour), не в stats-core —
    // recordEvent лишається без часових поясів, лише зберігає готове значення.
    ev = { ...body, bedtimeBucket: bedtimeBucketForHour(kyivHour()) };
  }

  const loaded = await loadStats(env);
  // Підтверджений блок (recordEvent, case 'checkin') ігнорує ВСІ подальші
  // правки — рахуємо це ДО запису, щоб викликач (агент, runRecordAction;
  // Mini App, handleEvent) міг чесно сказати «нічого не змінилось», а не
  // збрехати про успіх. Це лише швидкий fast-path на щойно прочитаному
  // знімку — САМА безпека (навіть якщо стан зміниться між цим читанням і
  // updateStats) лежить у recordEvent (case 'checkin' сам ігнорує confirmed).
  const checkinLocked =
    body.type === 'checkin' && !!loaded.checkins?.[dateKey]?.[ev.slot]?.confirmed;
  if (checkinLocked) return { locked: true }; // нічого не зміниться — не палимо KV-запис даремно
  await updateStats(env, (curStore) => recordEvent(curStore, ev, dateKey, nowMin, nowIso));
  if (body.type === 'checkin') return { locked: false };
}

/** POST /api/event {type, …, initData} -> записати подію у стор статистики.
 *  locked (checkin, вже підтверджений блок) — сурфейсимо чесно, той самий
 *  контракт, що runRecordAction (агент): {ok:true} саме по собі не каже,
 *  чи запис реально відбувся. */
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

  const result = await applyEvent(env, body);
  return json({ ok: true, locked: result?.locked ?? false });
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

// Ті самі локації, що config.yml locations (оркестратор) — Worker НЕ читає
// config.yml (окремий деплой, без збірки з src/), тож хардкодимо дзеркалом.
// ⚠️ Зміниш локації в config.yml -> онови й тут.
const WEATHER_LOCATIONS = [
  { lat: 49.8397, lon: 24.0297, name: 'Львів' },
  { lat: 51.12, lon: 26.46, name: 'Немовичі' },
];
const WEATHER_LIVE_TTL_MS = 30 * 60_000; // 30 хв — реальна свіжість, не «застигле» з брифінгу
// Захисний лічильник — та сама причина, що DAILY_REQUEST_LIMIT в src/modules/
// weather.ts (спільний OpenWeather-ключ/квота, реальний бюджет акаунта —
// 1000/добу), менший ліміт: тут це «скільки РАЗІВ на добу Mini App може
// оновити кеш», не «скільки запитів на локацію». Піднято з 50 (регресія,
// знайдена фідбеком власника 06.08: лічильник дійшов до 54 за звичайний
// день тестування ручної локації — кожна зміна геопозиції інвалідує кеш і
// коштує ~4 запити (2 локації × onecall+aqi), і денний ліміт вигорав
// набагато швидше, ніж закладалось при першій оцінці). 150 лишає щедрий
// запас під спільним бюджетом навіть із частими змінами локації.
const WEATHER_LIVE_DAILY_LIMIT = 150;
// ~0.02° ≈ 1-2км на широті України — навмисно грубіше за старий клієнтський
// GPS-поріг (0.01°): IP-геолокація (MaxMind через Cloudflare) сама по собі
// точна лише до міста/індексу, тож два послідовні запити з ОДНІЄЇ реальної
// точки можуть дати трохи різні координати без жодного реального переїзду —
// тонший поріг спричиняв би зайві «геопозиції відрізняються» і зайві KV-записи.
const GEO_MATCH_TOLERANCE = 0.02;

function roundGeo(n) {
  return Math.round(n * 100) / 100;
}

/** true, якщо обидві точки «та сама позиція» (з допуском) АБО обидві null
 *  (немає жодного сигналу — трактуємо як «нічого не змінилось»). */
function sameGeo(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (
    Math.abs(a.lat - b.lat) < GEO_MATCH_TOLERANCE && Math.abs(a.lon - b.lon) < GEO_MATCH_TOLERANCE
  );
}

/**
 * Геопозиція власника з Cloudflare-заголовків запиту (request.cf) — жоден
 * клієнтський дозвіл не потрібен: WebView Mini App шле HTTP-запити НАПРЯМУ з
 * пристрою власника на цей Worker (Telegram нічого не проксує), тож
 * Cloudflare бачить реальну мережу власника й на кожному запиті сам додає
 * приблизну геопозицію (по IP, рівень міста/індексу — MaxMind). Ані дозволу,
 * ані JS Geolocation/Telegram LocationManager — обидва виявились НЕНАДІЙНИМИ
 * в самому Telegram-клієнті (задокументований, невирішений баг Telegram на
 * iOS/Desktop, підтверджено власником на обох платформах), тож геолокацію
 * винесено сюди повністю: на боці Worker, поза Telegram API взагалі.
 *
 * request.cf.latitude/longitude — РЯДКИ (`string | null`), НЕ Number(null)/
 * Number('') напряму: та сама пастка, що вже задокументована в
 * checkinDateKey/kyivMinAfter8 — Number(null)===0 АЛЕ Й Number('')===0 дали б
 * хибну (0,0) на кожен запит без cf/з порожнім рядком замість null. request.cf
 * може бути ВІДСУТНІМ узагалі (локальний dev без --remote, деякі внутрішні
 * типи запитів) — null тоді, graceful.
 */
function requestGeo(request) {
  const cf = request.cf;
  if (!cf) return null;
  const latRaw = cf.latitude;
  const lonRaw = cf.longitude;
  const lat = typeof latRaw === 'string' && latRaw !== '' ? Number(latRaw) : NaN;
  const lon = typeof lonRaw === 'string' && lonRaw !== '' ? Number(lonRaw) : NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat: roundGeo(lat), lon: roundGeo(lon) };
}

/** Зворотне геокодування (OpenWeather Geocoding API — окремий безкоштовний
 *  тір від One Call 3.0, той самий WEATHER_API_KEY). Українська назва
 *  (local_names.uk), якщо є, інакше — що дав API. null на будь-який збій —
 *  виклик graceful-деградує до дефолтного підпису, не валить живу погоду. */
async function reverseGeocodeCity(lat, lon, apiKey) {
  try {
    const url = new URL('https://api.openweathermap.org/geo/1.0/reverse');
    url.searchParams.set('lat', String(lat));
    url.searchParams.set('lon', String(lon));
    url.searchParams.set('limit', '1');
    url.searchParams.set('appid', apiKey);
    const res = await fetch(url.toString());
    if (!res.ok) return null;
    const data = await res.json();
    const first = Array.isArray(data) ? data[0] : null;
    return first?.local_names?.uk ?? first?.name ?? null;
  } catch {
    return null;
  }
}

/** Пряме геокодування (та сама OpenWeather Geocoding API, інший ендпоінт) —
 *  назва міста -> координати. Фолбек-шлях для POST /api/weather/location,
 *  коли власник ввів назву руками без вибору з автозаповнення (те тепер
 *  працює з локального web/app/public/settlements.json — фідбек власника:
 *  «звичайна пошукова логіка» без мережевого запиту на кожен keystroke, див.
 *  web/scripts/gen-settlements.mjs). null на збій/порожній результат —
 *  виклик сам поверне власнику чесну 404, не впаде мовчки. */
async function geocodeCity(query, apiKey) {
  try {
    const url = new URL('https://api.openweathermap.org/geo/1.0/direct');
    url.searchParams.set('q', query);
    url.searchParams.set('limit', '1');
    url.searchParams.set('appid', apiKey);
    const res = await fetch(url.toString());
    if (!res.ok) return null;
    const data = await res.json();
    const first = Array.isArray(data) ? data[0] : null;
    if (!first || !Number.isFinite(first.lat) || !Number.isFinite(first.lon)) return null;
    return { lat: first.lat, lon: first.lon, name: first.local_names?.uk ?? first.name ?? query };
  } catch {
    return null;
  }
}

/**
 * GET /api/weather -> жива погода (PR-7, фідбек власника: статична температура
 * з ранкового брифінгу вже за обідом не відповідала дійсності). Owner-gated,
 * кешовано в KV (weatherLive, ~30 хв) — той самий OpenWeather-ключ ділиться з
 * оркестратором, тож живий фетч НЕ на кожне відкриття Mini App.
 *
 * Геопозиція (Блок «Погода», фідбек власника): на КОЖЕН запит перевіряємо
 * requestGeo() і звіряємо зі збереженою (KV ownerGeo) — «сходяться» (в межах
 * ~1-2км) -> нічого не міняємо; «відрізняються» -> переписуємо на поточну й
 * зберігаємо. Це единий власник (не мультитенантний застосунок), тож його
 * геопозиція — стабільне значення, яке МОЖНА кешувати так само, як дефолтну
 * пару: кеш зберігає, ЯКА позиція в ньому лежить (weatherLive.geo), і
 * інвалідується, коли ефективна позиція змінюється, — не лише по TTL.
 */
async function handleLiveWeather(request, env) {
  const auth = await checkOwnerRead(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);

  const nowMs = Date.now();
  const currentGeo = requestGeo(request);
  let storedGeo;
  try {
    storedGeo = JSON.parse((await env.BRIEFING.get('ownerGeo')) ?? 'null');
  } catch {
    storedGeo = null;
  }
  // «Перевірка чи сходяться геопозиції» (фідбек власника): є свіжий сигнал і
  // він ВІДРІЗНЯЄТЬСЯ від збереженого -> переписуємо й зберігаємо. Сходиться
  // (або свіжого сигналу взагалі немає, напр. локальний dev) -> лишаємо
  // збережене як є, жодного зайвого KV-запису. Пишемо ОКРЕМО від ручного
  // перевизначення нижче — авто-детекція йде своїм ходом навіть під час
  // manual override, щоб було на що впасти назад, коли власник його прибере.
  let effectiveGeo = storedGeo;
  if (currentGeo && !sameGeo(currentGeo, storedGeo)) {
    effectiveGeo = currentGeo;
    await env.BRIEFING.put('ownerGeo', JSON.stringify(currentGeo));
  }

  // Ручне перевизначення (фідбек власника): IP-геолокація (MaxMind через
  // Cloudflare) не встигає за реальним переміщенням на мобільній мережі — тож
  // коли воно є, ПОВНІСТЮ переважає авто-детекцію, незалежно від request.cf.
  let manualGeo;
  try {
    manualGeo = JSON.parse((await env.BRIEFING.get('ownerGeoManual')) ?? 'null');
  } catch {
    manualGeo = null;
  }
  if (manualGeo) effectiveGeo = { lat: manualGeo.lat, lon: manualGeo.lon };
  // Фронту для стану кнопки перевизначення потрібна лише назва — не координати.
  const manualGeoOut = manualGeo ? { name: manualGeo.name } : null;

  const hasGeo = !!effectiveGeo;

  let cached;
  try {
    cached = JSON.parse((await env.BRIEFING.get('weatherLive')) ?? 'null');
  } catch {
    cached = null;
  }
  // Кеш валідний лише якщо TTL не протух І позиція в ньому — та сама, що
  // ефективна зараз (інакше свіжий переїзд показував би застиглу погоду
  // старого міста до 30 хв).
  if (
    cached &&
    sameGeo(cached.geo ?? null, effectiveGeo) &&
    Number.isFinite(cached.fetchedAtMs) &&
    nowMs - cached.fetchedAtMs < WEATHER_LIVE_TTL_MS
  ) {
    return json({
      ok: true,
      locations: cached.locations,
      fetchedAtMs: cached.fetchedAtMs,
      manualGeo: manualGeoOut,
    });
  }

  if (!env.WEATHER_API_KEY) {
    // Немає ключа на Worker-боці (лише в GH Actions secrets, окремий деплой) —
    // graceful: фронт фолбекає на снапшот брифінгу, не показує помилку.
    return json({ ok: false, error: 'not-configured' }, 503);
  }

  const today = kyivDateKey();
  let counter;
  try {
    counter = JSON.parse((await env.BRIEFING.get('weatherLiveCounter')) ?? 'null');
  } catch {
    counter = null;
  }
  if (!counter || counter.date !== today) counter = { date: today, count: 0 };
  if (counter.count >= WEATHER_LIVE_DAILY_LIMIT) {
    // Ліміт вичерпано -> віддати наявний кеш, АЛЕ ЛИШЕ якщо він усе ще під
    // ТУ САМУ позицію (протухлий за TTL — можна, іншої позиції — ні).
    //
    // ⚠️ Регресія, знайдена фідбеком власника (06.08): обрав нову ручну
    // локацію (Рівне замість Сарни), POST успішно зберіг ownerGeoManual —
    // але денний лічильник тоді вже був вичерпаний, і цей блок віддавав
    // СТАРИЙ кеш Сарни як є, без перевірки geo. Виглядало як «нічого не
    // змінилось»: інтерфейс показував чужу погоду під виглядом свіжої.
    // Позиція розійшлась -> чесна 429, клієнт фолбекає на снапшот брифінгу
    // (WeatherBlock), а не бреше живими на вигляд даними чужого міста.
    if (cached && sameGeo(cached.geo ?? null, effectiveGeo))
      return json({
        ok: true,
        locations: cached.locations,
        fetchedAtMs: cached.fetchedAtMs,
        manualGeo: manualGeoOut,
      });
    return json({ ok: false, error: 'rate-limited' }, 429);
  }

  const todayKey = today;
  const fetchLocation = async (loc) => {
    counter.count++;
    const oneCallUrl = new URL('https://api.openweathermap.org/data/3.0/onecall');
    oneCallUrl.searchParams.set('lat', String(loc.lat));
    oneCallUrl.searchParams.set('lon', String(loc.lon));
    oneCallUrl.searchParams.set('units', 'metric');
    oneCallUrl.searchParams.set('lang', 'ua');
    oneCallUrl.searchParams.set('exclude', 'minutely');
    oneCallUrl.searchParams.set('appid', env.WEATHER_API_KEY);
    const res = await fetch(oneCallUrl.toString());
    if (!res.ok) throw new Error(`OpenWeather HTTP ${res.status}`);
    const parsed = parseOneCall(await res.json(), loc.name, todayKey);
    if (!parsed) throw new Error(`порожній onecall для ${loc.name}`);

    counter.count++;
    try {
      const aqiUrl = new URL('https://api.openweathermap.org/data/2.5/air_pollution');
      aqiUrl.searchParams.set('lat', String(loc.lat));
      aqiUrl.searchParams.set('lon', String(loc.lon));
      aqiUrl.searchParams.set('appid', env.WEATHER_API_KEY);
      const aqiRes = await fetch(aqiUrl.toString());
      if (aqiRes.ok) {
        const aqi = mergeAqi(await aqiRes.json());
        if (aqi !== undefined) parsed.aqi = aqi;
      }
    } catch {
      /* AQI — довантаження понад основне; збій не валить локацію */
    }
    return parsed;
  };

  let targetLocations = WEATHER_LOCATIONS;
  if (hasGeo) {
    // Ручне перевизначення вже несе назву, яку власник підтвердив при
    // встановленні (geocodeCity) — зворотне геокодування тут зайве й може
    // повернути ІНШУ назву (напр. район замість міста), ніж очікує власник.
    let name = manualGeo?.name ?? null;
    if (!name) {
      counter.count++; // геокодування — теж запит проти спільної OpenWeather-квоти
      name = await reverseGeocodeCity(effectiveGeo.lat, effectiveGeo.lon, env.WEATHER_API_KEY);
    }
    // Львів (WEATHER_LOCATIONS[0]) зсувається у другий слот замість Немовичів —
    // той самий 2-слотовий UI (головна температура + рядок біля UV/AQI), лише
    // інший вміст масиву.
    targetLocations = [
      { lat: effectiveGeo.lat, lon: effectiveGeo.lon, name: name ?? 'Твоя локація' },
      WEATHER_LOCATIONS[0],
    ];
  }

  const results = await Promise.allSettled(targetLocations.map(fetchLocation));
  await env.BRIEFING.put('weatherLiveCounter', JSON.stringify(counter));

  const locations = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') locations.push(r.value);
    else console.error(`жива погода для ${targetLocations[i].name} впала:`, r.reason?.message);
  });

  if (locations.length === 0) {
    // Усі локації впали -> віддати старий кеш, якщо є, інакше чесна відмова
    // (клієнт фолбекає на снапшот брифінгу).
    if (cached)
      return json({
        ok: true,
        locations: cached.locations,
        fetchedAtMs: cached.fetchedAtMs,
        manualGeo: manualGeoOut,
      });
    return json({ ok: false, error: 'upstream-failed' }, 502);
  }

  await env.BRIEFING.put(
    'weatherLive',
    JSON.stringify({ locations, fetchedAtMs: nowMs, geo: effectiveGeo }),
  );
  return json({ ok: true, locations, fetchedAtMs: nowMs, manualGeo: manualGeoOut });
}

/**
 * POST /api/weather/location {city, initData} -> ручне перевизначення геопозиції
 * (фідбек власника, продовження PR-7: IP-геолокація фізично не встигає за
 * реальним переміщенням на мобільній мережі — оператор мапить IP на місто
 * приблизно й не в реальному часі). Пряме геокодування (geocodeCity) введеної
 * назви -> {lat, lon, name} у ownerGeoManual, і ВІД ЦЬОГО МОМЕНТУ
 * handleLiveWeather повністю ігнорує request.cf, доки власник сам не прибере.
 *
 * АБО {lat, lon, name, initData} -> явний вибір з автозаповнення (клієнт
 * шукає по web/app/public/settlements.json, координати вже відомі) —
 * геокодування пропускаємо, інакше повторний запит по одній лише назві міг
 * би повернути ІНШЕ місто, ніж власник візуально обрав (однойменні населені
 * пункти в різних областях/країнах).
 *
 * DELETE /api/weather/location {initData} -> прибрати перевизначення,
 * повернутись до авто-детекції по IP (ownerGeo лишався живим весь час).
 */
async function handleWeatherLocation(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  if (request.method === 'DELETE') {
    const auth = await checkOwner(body?.initData, env);
    if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);
    await env.BRIEFING.delete('ownerGeoManual');
    return json({ ok: true, manualGeo: null });
  }

  if (request.method !== 'POST') return json({ ok: false, error: 'method' }, 405);
  const auth = await checkOwner(body?.initData, env);
  if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);

  const hasExactPick =
    Number.isFinite(body?.lat) &&
    Number.isFinite(body?.lon) &&
    typeof body?.name === 'string' &&
    body.name.trim();

  let resolved;
  if (hasExactPick) {
    resolved = { lat: body.lat, lon: body.lon, name: body.name.trim() };
  } else {
    const city = typeof body?.city === 'string' ? body.city.trim() : '';
    if (!city) return json({ ok: false, error: 'bad-params' }, 400);
    if (!env.WEATHER_API_KEY) return json({ ok: false, error: 'not-configured' }, 503);
    resolved = await geocodeCity(city, env.WEATHER_API_KEY);
    if (!resolved) return json({ ok: false, error: 'not-found' }, 404);
  }

  const manual = {
    lat: roundGeo(resolved.lat),
    lon: roundGeo(resolved.lon),
    name: resolved.name,
    setAtMs: Date.now(),
  };
  await env.BRIEFING.put('ownerGeoManual', JSON.stringify(manual));
  return json({ ok: true, manualGeo: { name: manual.name } });
}

/**
 * POST /api/weather/locate-prompt {initData} -> тригер /locate-промпту
 * (кнопка request_location), ІНІЦІЙОВАНИЙ З MINI APP (фідбек власника:
 * «можна зробити цю кнопку тригер у самій апці?»). WebView не вміє показати
 * нативну кнопку геолокації сама — request_location існує ВИКЛЮЧНО як
 * властивість KeyboardButton у ЧАТІ (Bot API), Mini App цього не обходить.
 * Натомість Mini App просить БОТА проактивно надіслати ТОЙ САМИЙ промпт, що
 * й команда /locate (locateKeyboard, worker.js:handleCommand) — власник
 * тапає кнопку вже в чаті, Mini App лише скорочує шлях «не пам'ятати
 * команду», сам факт тапу все одно лишається в чаті, не тут.
 *
 * env.TELEGRAM_CHAT_ID/env.TOPIC_ASSISTANT — той самий проактивний шлях
 * (не parsed.chatId — тут немає вхідного апдейту), що вже шле нагадування/
 * dead-man-перевірку.
 */
async function handleWeatherLocatePrompt(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const auth = await checkOwner(body?.initData, env);
  if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);
  if (!env.TELEGRAM_CHAT_ID) return json({ ok: false, error: 'not-configured' }, 503);

  const res = await tgCall(env, 'sendMessage', {
    chat_id: env.TELEGRAM_CHAT_ID,
    message_thread_id: env.TOPIC_ASSISTANT ?? undefined,
    text: 'Тисни кнопку нижче, щоб надіслати поточну GPS-позицію 📍',
    reply_markup: locateKeyboard(),
  });
  if (!res.ok) return json({ ok: false, error: 'telegram-failed' }, 502);
  return json({ ok: true });
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
  // Ріст роадмепу по тижнях — сурфейс уже наявних ISO-таймстемпів у progress
  // (toggleProgress їх і так пише), Майстерність показує не лише поточний %.
  stats.roadmapWeekly = roadmapWeekly(progress, kyivDateKey());
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
  // Голоси per-url (C3): дашборд гідратує підсвітку ❤️ з цього, щоб після
  // переоткриття Mini App повторний тап не «знімав» невидимо активний голос
  // (ревʼю C). Віддаємо компактно {url: 'up'}, без delta/category.
  //
  // Фільтр саме на 'up' (фідбек власника, п.5): у KV лежать старі дизлайки, і
  // віддавати їх клієнту вже нема кому — кнопки 👎 не існує. Мовчки ховаємо їх
  // із READ, а не чистимо запис: votedUrls досі потрібен, щоб лайк по раніше
  // дизлайкнутій новині відкотив саме той delta, який колись застосували.
  stats.votes = Object.fromEntries(
    Object.entries(state.votedUrls ?? {})
      .filter(([, v]) => v && v.dir === 'up')
      .map(([url, v]) => [url, v.dir]),
  );
  // Активний блок чек-іну — рахує СЕРВЕР (клієнтському годиннику не віримо:
  // інакше «ранковий» блок відкривався б опівночі). Не в aggregateStats, бо той
  // чистий і години не знає; тут же — щоб клієнт не мав власної копії меж.
  const h = kyivHour();
  stats.checkinSlot = checkinSlot(h);
  // ⚠️ checkinToday мусить читатись за КЛЮЧЕМ ЧЕК-ІНУ (як пише applyEvent через
  // checkinDateKey), а не за сирим календарним днем. aggregateStats не знає
  // години, тож дає checkins[kyivDateKey()]; але о 00:00–01:59 вечірній блок
  // ще належить УЧОРАШНЬОМУ чек-ін-дню (checkinDateKey зсуває ніч до 6-ї на
  // попередню дату). Без цієї правки о 00:43 екран читав порожній новий
  // календарний день -> «ЗАПОВНЕНО 0 З 3», ранок/післяобід «пропущено», хоча
  // всі три заповнені (Статистика показує правильно — вона сканує вікно днів).
  // Удень (h>=6) ключі збігаються, тож поведінка не міняється.
  stats.checkinToday = store.checkins?.[checkinDateKey(kyivDateKey(), h)] ?? null;
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
async function callLlmHost(env, { prompt, systemPrompt, jsonSchema, model, timeoutMs }) {
  if (!env.LLM_HOST_URL || !env.LLM_HOST_SECRET) {
    return { ok: false, status: 0, error: 'not-configured' };
  }
  const ctrl = new AbortController();
  // 25с — стеля (менше за таймаут хоста 30с). Агент передає МЕНШЕ: у нього свій
  // бюджет на весь ланцюжок, і один повільний виклик не сміє зʼїсти його весь.
  const ms = Number.isFinite(timeoutMs) ? Math.max(1000, Math.min(25_000, timeoutMs)) : 25_000;
  const timer = setTimeout(() => ctrl.abort(), ms);
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
            id,
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

/* ── Повне тіло одного листа (дія readMailBody) ───────────────────────────
   Власник дозволив тіла листів у контексті агента (18.07.2026). Читаємо рівно
   ОДИН лист за id, який модель узяла зі списку readMail — не тіла всіх п'яти
   наосліп: бюджет промпту лишається передбачуваним, а найненадійніше джерело
   даних (текст пише хтось чужий) потрапляє в контекст дозовано. */

/** Рекурсивно знайти перше text/plain-тіло в дереві частин MIME (fallback — text/html). */
function pickMailPart(payload) {
  const walk = (node, mime) => {
    if (!node) return null;
    if (node.mimeType === mime && node.body?.data) return node.body.data;
    for (const part of node.parts ?? []) {
      const found = walk(part, mime);
      if (found) return found;
    }
    return null;
  };
  return { plain: walk(payload, 'text/plain'), html: walk(payload, 'text/html') };
}

/** base64url (Gmail) -> текст; биття -> ''. */
function decodeMailData(data) {
  try {
    const bin = atob(String(data).replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes); // листи бувають у UTF-8, не latin1
  } catch {
    return '';
  }
}

/** Грубо зняти теги з HTML-листа, коли text/plain-частини немає. */
function stripHtml(html) {
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** Повний лист за id -> {from,subject,date,body} | null (немає доступу/не знайдено). */
async function readMailBody(env, messageId) {
  const token = await googleAccessToken(env);
  if (!token) return null;
  try {
    // messageId уже провалідовано в extractAssistantAction (^[A-Za-z0-9_-]{1,128}$),
    // але encodeURIComponent тут усе одно — інваріант, а не подвійна робота.
    const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      console.error('gmail body HTTP', res.status, await res.text().catch(() => ''));
      return null;
    }
    const j = await res.json();
    const headers = j?.payload?.headers ?? [];
    const get = (name) => headers.find((h) => String(h?.name).toLowerCase() === name)?.value ?? '';
    const { plain, html } = pickMailPart(j?.payload);
    const raw = plain
      ? decodeMailData(plain)
      : html
        ? stripHtml(decodeMailData(html))
        : decodeMailData(j?.payload?.body?.data ?? '');
    return {
      from: get('from'),
      subject: get('subject'),
      date: get('date'),
      body: raw,
    };
  } catch (err) {
    console.error('gmail body read failed', err.message);
    return null;
  }
}

/* ── Гості на подіях (PR-10): резолюція імені в email через Google People API ──
   ТОЙ САМИЙ access-токен, що Calendar/Gmail (googleAccessToken) — People API
   ділить консент із рештою Google-інтеграції, потрібен ЛИШЕ ширший скоуп
   (contacts.readonly) на тому самому GOOGLE_REFRESH_TOKEN. До ре-консенту
   власником People API повертає 403 -> searchContact тихо віддає [] (як
   googleAccessToken=null на решті інтеграцій), LLM просто не резолвить
   імена — не крашить і не блокує решту пропозиції. */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Пошук контакту за іменем -> [email,...] (0 -> нема скоупу/збігів, обидва
 *  випадки трактуємо однаково — розрізняти нема сенсу, дія однакова: не резолвити). */
async function searchContact(env, name) {
  const token = await googleAccessToken(env);
  if (!token) return [];
  try {
    const url = new URL('https://people.googleapis.com/v1/people:searchContacts');
    url.searchParams.set('query', name);
    url.searchParams.set('readMask', 'names,emailAddresses');
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      // 403 без contacts.readonly-скоупу — ОЧІКУВАНО до ре-консенту, не помилка.
      if (res.status !== 403) {
        console.error('people search HTTP', res.status, await res.text().catch(() => ''));
      }
      return [];
    }
    const results = (await res.json())?.results;
    const emails = [];
    for (const r of Array.isArray(results) ? results : []) {
      const email = r?.person?.emailAddresses?.[0]?.value;
      if (typeof email === 'string' && email) emails.push(email);
    }
    return emails;
  } catch (err) {
    console.error('people search failed', err.message);
    return [];
  }
}

/**
 * Резолвити список "ім'я або email" -> {emails, notes}. Уже готовий email
 * (EMAIL_RE) пропускається без пошуку — модель могла отримати його напряму
 * з розмови. Ім'я: 0 збігів -> НЕ додаємо гостя (notes пояснює, власник
 * бачить у пропозиції ДО підтвердження); 1 -> додаємо; 2+ -> теж НЕ додаємо
 * (не вгадуємо котрий) — обидва граничні випадки віддаємо як notes, не як
 * помилку: решта пропозиції (час/назва/інші гості) не має через це провалитись.
 */
async function resolveAttendees(env, names) {
  const emails = [];
  const notes = [];
  for (const raw of Array.isArray(names) ? names : []) {
    const name = String(raw ?? '').trim();
    if (!name) continue;
    if (EMAIL_RE.test(name)) {
      emails.push(name);
      continue;
    }
    const found = await searchContact(env, name);
    if (found.length === 1) {
      emails.push(found[0]);
    } else if (found.length === 0) {
      notes.push(`«${name}» не знайдено в контактах — додай email вручну, якщо треба`);
    } else {
      notes.push(`«${name}»: кілька збігів (${found.slice(0, 3).join(', ')}) — уточни email`);
    }
  }
  return { emails, notes };
}

/**
 * Створити новий контакт (write-scope, PR-13). Ніколи не кидає — {ok:false}
 * при збої (403 без contacts-скоупу — той самий "тихо не резолвили" мотив,
 * що searchContact, ЛИШЕ тут це вже TERMінальна дія в accept-циклі, тож
 * помилку показуємо власнику текстом, не мовчки ігноруємо).
 */
async function createContact(env, { name, email }) {
  const token = await googleAccessToken(env);
  if (!token) return { ok: false };
  try {
    const res = await fetch('https://people.googleapis.com/v1/people:createContact', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        names: [{ givenName: name }],
        emailAddresses: [{ value: email }],
      }),
    });
    if (!res.ok) {
      console.error('people createContact HTTP', res.status, await res.text().catch(() => ''));
      return { ok: false };
    }
    return { ok: true };
  } catch (err) {
    console.error('people createContact failed', err.message);
    return { ok: false };
  }
}

const DRIVE_MAX_RESULTS = 5;

/**
 * Пошук файлів у Drive за назвою (PR-14, дія readDrive). МЕТА-ДАНІ ЛИШЕ:
 * назва+посилання, БЕЗ читання вмісту (резюме реально PDF/Word — розбір
 * тексту звідти окремий, більший шматок роботи, свідомо відкладено).
 * [{name,webViewLink}] | [] (нема збігів) | null (немає доступу/збій —
 * ТОЙ САМИЙ контракт, що readMail: formatDriveForPrompt різнить тексти).
 */
async function searchDrive(env, rawQuery) {
  const token = await googleAccessToken(env);
  if (!token) return null;
  const query = String(rawQuery ?? '')
    .trim()
    .slice(0, 120);
  if (!query) return [];
  try {
    const url = new URL('https://www.googleapis.com/drive/v3/files');
    // Екранувати одинарні лапки — Drive query-мова, сирий текст користувача
    // не має ламати структуру запиту (той самий мотив, що SQL-параметризація).
    const escaped = query.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    url.searchParams.set('q', `name contains '${escaped}' and trashed = false`);
    url.searchParams.set('fields', 'files(id,name,webViewLink,modifiedTime)');
    url.searchParams.set('pageSize', String(DRIVE_MAX_RESULTS));
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      // 403 без drive.readonly-скоупу — очікувано до ре-консенту, не помилка.
      if (res.status !== 403) {
        console.error('drive search HTTP', res.status, await res.text().catch(() => ''));
      }
      return null;
    }
    const json = await res.json();
    return Array.isArray(json.files) ? json.files : [];
  } catch (err) {
    console.error('drive search failed', err.message);
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

/**
 * Створити подію в календарі (write-scope, Блок P2b). Ніколи не кидає —
 * {ok:false} при збої. `sendUpdates=all`, коли є гості (PR-10) — інакше Google
 * НЕ шле запрошення (дефолт `none`), а сенс attendees саме в сповіщенні;
 * без гостей лишаємо старий тихий шлях (жоден лист нікому не піде).
 */
async function createCalendarEvent(
  env,
  { title, startIso, endIso, reminderMinutes, location, attendees },
) {
  const token = await googleAccessToken(env);
  if (!token) return { ok: false };
  try {
    const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
    if (attendees?.length) url.searchParams.set('sendUpdates', 'all');
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(
        buildCreateEventBody({ title, startIso, endIso, reminderMinutes, location, attendees }),
      ),
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

/** URL одного events.get/patch/delete — eventId ВАЛІДУЄ викликач (той самий
 *  мотив, що mailId: рядок іде в шлях URL). */
function calendarEventUrl(eventId) {
  return `https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`;
}

/**
 * Прочитати ОДНУ подію за id (CRUD: свіжий title/startMs/endMs перед
 * update/delete — список міг бути застарілим на момент тапу). `null` при
 * будь-якому збої, включно з 404 (подію вже видалено). Реюзає parseEvents
 * (той самий title/час-парсинг, що читання діапазону) — обгортаємо єдиний
 * обʼєкт у {items:[...]} замість дублювати нормалізацію.
 */
async function getCalendarEvent(env, eventId) {
  const token = await googleAccessToken(env);
  if (!token) return null;
  try {
    const res = await fetch(calendarEventUrl(eventId), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      if (res.status !== 404) {
        console.error('google calendar get HTTP', res.status, await res.text().catch(() => ''));
      }
      return null;
    }
    const json = await res.json();
    return parseEvents({ items: [json] })[0] ?? null;
  } catch (err) {
    console.error('google calendar get failed', err.message);
    return null;
  }
}

/** Частково оновити подію (write-scope, CRUD). Ніколи не кидає — {ok:false} при збої.
 *  `sendUpdates=all`, коли патч зачіпає attendees (PR-10) — той самий мотив, що create. */
async function updateCalendarEvent(env, { eventId, patch }) {
  const token = await googleAccessToken(env);
  if (!token) return { ok: false };
  try {
    const url = new URL(calendarEventUrl(eventId));
    if (Array.isArray(patch?.attendees) && patch.attendees.length) {
      url.searchParams.set('sendUpdates', 'all');
    }
    const res = await fetch(url.toString(), {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      console.error('google calendar update HTTP', res.status, await res.text().catch(() => ''));
      return { ok: false };
    }
    return { ok: true };
  } catch (err) {
    console.error('google calendar update failed', err.message);
    return { ok: false };
  }
}

/**
 * Видалити подію (write-scope, CRUD). 404/410 (уже видалено — власник
 * прибрав з іншого пристрою, чи подвійний тап) рахуємо УСПІХОМ: мета
 * («події більше немає») уже досягнута, показувати «⚠️ не вдалось» тут
 * оманливо.
 */
async function deleteCalendarEvent(env, { eventId }) {
  const token = await googleAccessToken(env);
  if (!token) return { ok: false };
  try {
    const res = await fetch(calendarEventUrl(eventId), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok && res.status !== 404 && res.status !== 410) {
      console.error('google calendar delete HTTP', res.status, await res.text().catch(() => ''));
      return { ok: false };
    }
    return { ok: true };
  } catch (err) {
    console.error('google calendar delete failed', err.message);
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
  // Один суцільний абзац: конкатенація (не array+join('\n')) — інакше жорсткі
  // розриви джерела ламали б рядок ще ДО клієнтського word-wrap Telegram і
  // давали подвійне, непередбачуване перенесення посеред речення (саме це
  // бачив власник на скріні — "...просто\nнапиши" замість природного потоку).
  'Швидкі кнопки внизу завжди під рукою. Нагадати можна й без команди — просто ' +
    'напиши "нагадай ...". У темі 🤖Асистент можна й просто написати вільним ' +
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
  '/agenda — найближчі події календаря, тиждень наперед',
  '/agent — що вміє асистент (вільний текст) — повний перелік',
  '/plan — план дня (LLM прочитає календар і запропонує таймлайн)',
  '/roadmap — IT-роадмеп (теми → підпункти, прогрес)',
  '/settings — тихі години, ціль, модулі брифінгу',
  '/clear [N] — видалити останні N повідомлень тут — мої та твої (за замовч. 20)',
  '/whereami — chat_id/thread_id цього чату',
  '/locate — оновити позицію за GPS (точна погода в Mini App, замість IP-приблизності)',
].join('\n');

/**
 * Перелік можливостей асистента (🤖Асистент, вільний текст) — окремо від
 * HELP_TEXT (той — slash-команди бота, це — що можна написати текстом
 * LLM-агенту). Рукописний, не згенерований зі схеми: ASSISTANT_ACTION_SCHEMA
 * (agent-core.mjs) — контракт для моделі, тут потрібні людські приклади фраз.
 */
const AGENT_TEXT = [
  '🤖 <b>Що вміє асистент</b> (пиши в цій темі вільним текстом)',
  '',
  '📅 <b>Календар</b> — створити/перенести/скасувати подію, гості (імена — резолвимо ' +
    'в email, чи одразу email) і місце. «Заплануй кафе з Олексієм завтра о 15:00 в ' +
    '«Аромакава»» — завжди питає підтвердження кнопкою.',
  '⏰ <b>Нагадування</b> — створити/змінити/скасувати, одразу, без підтвердження. ' +
    '«Нагадай через 20 хв подзвонити в клініку».',
  '📧 <b>Пошта</b> — пошук і читання Gmail (лише читання, нічого не відправляє).',
  '✅ <b>Чек-ін</b> — «хочу зробити чек-ін» — заповнить поля активного часу доби ' +
    '(ранок/день/вечір) з розмови.',
  '❤️ <b>Новини</b> — «лайкни цю новину про...» (з того, що щойно показав).',
  '💼 <b>Вакансії</b> — «познач вакансію X як співбесіда» (з того, що щойно показав).',
  '📚 <b>Роадмеп</b> — «познач Docker вивченим».',
  '⚙️ <b>Налаштування</b> — тихі години, модулі брифінгу, заглушені теми — теж через ' +
    'підтвердження (повна заміна, тому діф «було → стане» перед ✅).',
  '👤 <b>Контакти</b> — «збережи Олексія як контакт, email x@y.com» — через підтвердження.',
  '📁 <b>Drive</b> — «знайди моє резюме» — пошук за назвою, лише посилання (без читання ' +
    'вмісту файлу).',
  '📊 <b>Твої дані</b> — «що я зберіг цього тижня?», «як мій стрік?», «які в мене ' +
    'нагадування?» — брифінг/вакансії/прогрес/нагадування/чек-іни/збережене/новини/налаштування.',
].join('\n');

// Фаза B2: профіль бота (setMyDescription/setMyShortDescription) — те, що
// власник бачить ДО першого /start (порожній чат) і в прев'ю/шарінгу. Разом
// із розширеним REPLY_KEYBOARD (tg-core.mjs) компенсує видалену тему
// «Команди» (та ніколи не мала прив'язки в коді, суто організаційна).
const BOT_DESCRIPTION =
  'Персональний ранковий брифінг: погода, курс, новини, вакансії, IT-роадмеп. ' +
  'Плюс асистент — нагадування, календар, план дня. Напиши /help, щоб побачити всі команди.';
const BOT_SHORT_DESCRIPTION = 'Ранковий брифінг + асистент для пошуку роботи в IT.';

// Одноразове закріплене вітальне повідомлення (фідбек власника, п.2) — «одна
// стала точка входу» в Mini App у форум-супергрупі. Раніше цю роль намагався
// грати ЩОДЕННИЙ брифінг (unpin учорашнього -> pin сьогоднішнього), але сам
// брифінг більше не несе кнопку (вона — тут), тож churn був без сенсу: щодня
// відкріпити й закріпити ТЕ САМЕ повідомлення про наявність апки. Тепер —
// один текст, закріплений один раз, ensureAppWelcomePin (нижче) лише
// підтверджує/відновлює закріплення на кожен /api/telegram/setup.
const APP_WELCOME_TEXT =
  '🌅 <b>Світанок</b> — твій персональний Mini App.\n\n' +
  'Погода, курс, новини, вакансії, чек-ін, статистика, IT-роадмеп — усе в ' +
  'одному місці. Це повідомлення закріплене, щоб кнопка нижче завжди була ' +
  'під рукою.';

const UNKNOWN_REPLY =
  '🤖 Асистент-діалог ще не підключений (зʼявиться пізніше). Натисни /help, щоб побачити доступні команди.';
const REMINDER_HELP =
  '🤔 Не зрозумів час. Приклади: "через 20 хвилин", "завтра о 10:00", "о 15:30".';

// Раундів і дедлайну агента більше немає: цикл переїхав на хост (варіант Б), де
// час не обмежений. Запобіжники тепер — AGENT_MAX_STEPS і AGENT_RUN_TTL_MS
// (agent-run-core.mjs), обидва зашиті в підписаний ран-токен.
//
// Кап тексту користувача: іде і в промпт, і в ран-токен (той їздить у кожному
// зворотному виклику хоста, тож роздувати його нічим).
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
async function proposeDayPartReminder(env, parsed, dayPart) {
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
async function createReminderFromText(env, parsed, text, { agentFallback = false } = {}) {
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
 * Обробити updateReminder (CRUD, прямий термінал — той самий мотив, що
 * createReminder/cancelReminder: локальний KV, дешево відкотити, підтвердження
 * зайве). Знайти за текстом (як cancelReminderByText), застосувати патч —
 * "when" РЕ-ПАРСИМО тут (LLM подала лише канонічну фразу, час рахує код,
 * той самий інваріант, що createReminderFromText/proposeCalendarChanges).
 */
async function updateReminderByText(
  env,
  parsed,
  { reminderText: matchText, reminderNewText, when },
) {
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

  const patch = {};
  if (reminderNewText) patch.text = reminderNewText;
  if (when) {
    const parsedTime = parseReminderTime(when, Date.now());
    if (!parsedTime) {
      return sendText('🤔 Не зрозумів новий час — спробуй точніше (напр. "завтра о 15:00").');
    }
    patch.whenMs = parsedTime.whenMs;
  }

  state.reminders = updateReminder(state.reminders, matches[0].id, patch);
  await env.BRIEFING.put('state', JSON.stringify(state));
  return sendText(`✏️ Оновив нагадування: ${patch.text ?? matches[0].text}`);
}

const RECORD_CHECKIN_SLOT_LABEL = { morning: 'ранок', afternoon: 'день', evening: 'вечір' };

/**
 * Обробити recordAction (PR-8, Категорія A) — прямий термінал, як createReminder/
 * updateReminder: локальні дані, дешево відкотити, підтвердження зайве. Кожен kind
 * повторно використовує ТОЙ САМИЙ примітив запису, що й Mini App/Telegram-кнопки
 * (applyEvent/applyUrlVote/toggleProgress) — жодної нової логіки стору тут.
 *
 * newsIndex/jobIndex — індекс у СВІЖОМУ (не з дайджесту, який модель бачила
 * кроків тому) читанні latest/funnelList: те, на що вказував дайджест, могло
 * зникнути чи зсунутись між readOwnData і цим кроком.
 */
async function runRecordAction(env, parsed, action) {
  const sendText = sendTo(env, parsed);

  if (action.kind === 'checkin') {
    const slot = checkinSlot(kyivHour());
    if (!slot) return sendText('🌙 Зараз тиха зона (02:00–08:00) — чек-ін не пишемо.');
    const result = await applyEvent(env, { type: 'checkin', ...action.checkin });
    if (result?.locked) {
      return sendText(`🔒 ${RECORD_CHECKIN_SLOT_LABEL[slot]} уже підтверджено — змінити не можна.`);
    }
    return sendText(`✅ Записав чек-ін (${RECORD_CHECKIN_SLOT_LABEL[slot]}).`);
  }

  if (action.kind === 'voteNews') {
    const latest = await loadLatest(env);
    const groups = latest?.blocks?.find((b) => b?.id === 'news')?.data?.groups;
    const flat = [];
    for (const g of Array.isArray(groups) ? groups : []) {
      for (const it of Array.isArray(g?.items) ? g.items : []) {
        flat.push({ url: it?.url, topic: g.topic, title: it?.title });
      }
    }
    const item = flat[action.newsIndex - 1];
    if (!item?.url)
      return sendText('🤔 Не знайшов цю новину — спробуй readOwnData(scope=news) ще раз.');
    const state = await loadState(env);
    const r = applyUrlVote(
      state.preferenceWeights ?? {},
      state.votedUrls ?? {},
      item.url,
      item.topic,
      'up',
    );
    state.preferenceWeights = r.weights;
    state.votedUrls = r.votedUrls;
    await env.BRIEFING.put('state', JSON.stringify(state));
    const voteDateKey = kyivDateKey();
    await updateStats(env, (curStore) =>
      recordEvent(
        curStore,
        {
          type: 'vote',
          category: item.topic,
          dir: r.newDir,
          prevDir: r.prevDir,
          prevCategory: r.prevCategory,
        },
        voteDateKey,
      ),
    );
    return sendText(`❤️ Голос за «${item.title ?? '?'}» зараховано.`);
  }

  if (action.kind === 'jobStage') {
    const agg = aggregateStats(await loadStats(env), kyivDateKey());
    const item = (agg.funnelList ?? [])[action.jobIndex - 1];
    if (!item?.url)
      return sendText('🤔 Не знайшов цю вакансію — спробуй readOwnData(scope=jobs) ще раз.');
    await applyEvent(env, {
      type: 'job_stage',
      url: item.url,
      stage: action.jobStage,
      title: item.title,
    });
    return sendText(`✅ «${item.title || item.url}» → ${action.jobStage}.`);
  }

  // roadmapDone
  const state = await loadState(env);
  const key = progressKey(action.roadmapTopicId, action.roadmapSubtopicId);
  if (state.roadmapProgress?.[key]) return sendText('✅ Уже позначено вивченим.');
  state.roadmapProgress = toggleProgress(
    state.roadmapProgress ?? {},
    action.roadmapTopicId,
    action.roadmapSubtopicId,
    new Date().toISOString(),
  );
  await env.BRIEFING.put('state', JSON.stringify(state));
  return sendText('✅ Позначив у роадмепі вивченим.');
}

/* ══ Агент: цикл живе на ХОСТІ (варіант Б) ═══════════════════════════════════
   Доти Worker сам крутив цикл раундів у ctx.waitUntil — і впирався в стелю
   платформи: Cloudflare убиває фонову роботу МОВЧКИ на ~25-30с (бісект власника:
   2 раунди відповідають, 3 дають повну тишу). Паліатив AGENT_DEADLINE_MS=18с
   прибрав мовчанку, але ланцюжок «знайди лист І заплануй» лишався неможливим.

   Тепер:
     1. Worker шле «⏳ Працюю…», мінтить ран-токен і робить ОДИН POST на хост,
        який одразу віддає 202 -> waitUntil завершується за ~300мс, евікшену немає.
     2. Хост крутить цикл біля claude CLI без обмеження часу. Потрібен
        інструмент -> POST назад у /api/agent-step -> Worker виконує (секрети є
        лише в нього) і повертає текст для транскрипту + токен наступного кроку.
     3. Термінальна дія -> Worker виконує її, прибирає «⏳» і відповідає власнику.

   ⚠️ Хост НЕ знає переліку дій: системний промпт і JSON-схему йому дає Worker у
   тому ж POST. Тому додати агентові вміння = правка ЛИШЕ Worker'а, без редеплою
   VPS, і скомпрометований хост не отримує ширших повноважень, ніж модель мала
   й до переходу (`extractAssistantAction` — той самий allowlist, що й раніше). */

/** Марки активних прогонів (сторож у scheduled()). Окремий KV-ключ від `state`
 *  з того самого мотиву, що sentMessages: писар на кожен запит не має ділити
 *  гонку з reminders/roadmapProgress. */
const AGENT_RUNS_KEY = 'agentRuns';
/** Прогін вважається обірваним, коли токен уже мертвий, а фінішу так і не було. */
const AGENT_RUN_STALE_MS = AGENT_RUN_TTL_MS + 60_000;
/** Скільки тримати «надгробки» завершених прогонів (щоб не тарабанити алерт). */
const AGENT_RUN_KEEP_MS = 60 * 60_000;
const MAX_TRACKED_RUNS = 12;

async function loadAgentRuns(env) {
  try {
    const parsed = JSON.parse((await env.BRIEFING.get(AGENT_RUNS_KEY)) ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Прибрати старе + втримати кап (найсвіжіші за startedMs/finishedMs). */
function pruneAgentRuns(runs, nowMs) {
  const entries = Object.entries(runs).filter(([, r]) => {
    const t = Number(r?.finishedMs ?? r?.startedMs);
    return Number.isFinite(t) && nowMs - t < AGENT_RUN_KEEP_MS;
  });
  entries.sort((a, b) => Number(b[1]?.startedMs ?? 0) - Number(a[1]?.startedMs ?? 0));
  return Object.fromEntries(entries.slice(0, MAX_TRACKED_RUNS));
}

async function markRunStarted(env, runId, info) {
  try {
    const runs = await loadAgentRuns(env);
    runs[runId] = info;
    await env.BRIEFING.put(AGENT_RUNS_KEY, JSON.stringify(pruneAgentRuns(runs, info.startedMs)));
  } catch (e) {
    // Best-effort: марка потрібна лише сторожу. Збій KV не сміє зірвати запит.
    console.error('agentRuns mark start failed (не блокує прогін)', e);
  }
}

/**
 * Позначити прогін завершеним.
 *
 * ⚠️ НЕ видаляємо запис, а ставимо `finishedMs`-надгробок. KV не має
 * read-your-writes: читання тут цілком може ще не бачити марки, покладеної
 * 5 секунд тому на старті. Видалення в такому разі було б no-op -> марка
 * лишалась би «незавершеною» -> сторож через 6 хвилин слав би ХИБНИЙ алерт про
 * обірваний запит. Надгробок же виживає в обох порядках: навіть якщо запис
 * старту загубився, сторож бачить finishedMs і мовчить.
 */
async function markRunFinished(env, runId, nowMs = Date.now()) {
  if (!runId) return;
  try {
    const runs = await loadAgentRuns(env);
    runs[runId] = { ...(runs[runId] ?? {}), finishedMs: nowMs };
    await env.BRIEFING.put(AGENT_RUNS_KEY, JSON.stringify(pruneAgentRuns(runs, nowMs)));
  } catch (e) {
    console.error('agentRuns mark finish failed', e);
  }
}

/**
 * URL роуту циклу на хості. LLM_HOST_URL указує на `/llm` (одноразовий виклик),
 * цикл живе поруч на `/agent`. Виводимо з наявного секрету, щоб перехід не
 * вимагав від власника заводити ще один; LLM_HOST_AGENT_URL — явний обхід, якщо
 * колись знадобиться інша адреса.
 */
function agentHostUrl(env) {
  if (env.LLM_HOST_AGENT_URL) return env.LLM_HOST_AGENT_URL;
  if (!env.LLM_HOST_URL) return null;
  return /\/llm\/?$/.test(env.LLM_HOST_URL)
    ? env.LLM_HOST_URL.replace(/\/llm\/?$/, '/agent')
    : `${env.LLM_HOST_URL.replace(/\/$/, '')}/agent`;
}

/**
 * Запустити прогін на хості: POST і одразу назад. Хост мусить відповісти 202 ДО
 * того, як почне думати — інакше ми знову чекали б у waitUntil і повернулись би
 * до тієї самої мовчанки. Форма відповіді при збої — як у callLlmHost, щоб
 * assistantErrorReply класифікувала причину тим самим кодом.
 */
async function startAgentRun(env, payload) {
  const url = agentHostUrl(env);
  if (!url || !env.LLM_HOST_SECRET) return { ok: false, status: 0, error: 'not-configured' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-llm-host-secret': env.LLM_HOST_SECRET },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const raw = await res.text().catch(() => '');
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch {
      /* не-JSON (проксі/502-сторінка) */
    }
    if (!res.ok || !data?.ok) {
      console.error('agent start HTTP', res.status, raw.slice(0, 300));
      return {
        ok: false,
        status: res.status,
        error: typeof data?.error === 'string' ? data.error : `http-${res.status}`,
      };
    }
    return { ok: true };
  } catch (err) {
    console.error('agent start failed', err?.message);
    return { ok: false, status: 0, error: err?.name === 'AbortError' ? 'timeout' : 'offline' };
  } finally {
    clearTimeout(timer);
  }
}

/** message_id щойно надісланого повідомлення; null, якщо Telegram не дав. */
async function messageIdOf(res) {
  try {
    const j = await res.clone().json();
    const id = j?.result?.message_id;
    return typeof id === 'number' ? id : null;
  } catch {
    return null;
  }
}

/** Тихо прибрати повідомлення «⏳ Працюю…» — його відмова нічого не ламає. */
async function deleteProgressMessage(env, chatId, messageId) {
  if (typeof messageId !== 'number') return;
  try {
    await tgCall(env, 'deleteMessage', { chat_id: chatId, message_id: messageId });
  } catch (e) {
    console.error('progress delete failed (не блокує відповідь)', e?.message);
  }
}

/** Переписати «⏳ Працюю…» під поточний крок (проміжний прогрес). Best-effort:
 *  збій редагування (мережа чи «message is not modified» на повторній дії) не
 *  блокує прогін — тут лише косметика. */
async function editProgressMessage(env, chatId, messageId, text) {
  if (typeof messageId !== 'number') return;
  try {
    await tgCall(env, 'editMessageText', { chat_id: chatId, message_id: messageId, text });
  } catch (e) {
    console.error('progress edit failed (не блокує прогін)', e?.message);
  }
}

/**
 * Записати обмін у памʼять треду. Викликається ЛИШЕ на успішному фініші — як і
 * до переходу: провалений (часто оверсайз) обмін інакше отруював би контекст
 * наступних повідомлень. Текст користувача приїхав у підписаному токені, тож
 * KV-розсинхрон не може його загубити.
 */
async function rememberExchange(env, claims, assistantSummary) {
  try {
    let h = await loadAssistantHistory(env);
    h = appendTurn(h, claims.chatId, claims.threadId, 'user', claims.userText);
    h = appendTurn(h, claims.chatId, claims.threadId, 'assistant', assistantSummary);
    await env.BRIEFING.put('assistantHistory', JSON.stringify(h));
  } catch (e) {
    console.error('assistantHistory write failed (не блокує відповідь)', e);
  }
}

/**
 * Записати ЛИШЕ репліку асистента (без user-репліки) — гібридне «✏️
 * Інше»/«✏️ Редагувати»: тригер тут кнопка, не повідомлення власника, тож
 * user-репліки просто немає. Наступне СПРАВЖНЄ повідомлення власника ляже
 * поверх — «ПРОДОВЖЕННЯ РОЗМОВИ» у системному промпті (agent-core.mjs) вже
 * навчена трактувати його як відповідь на щойно задане питання.
 */
async function rememberAssistantQuestion(env, parsed, text) {
  try {
    let h = await loadAssistantHistory(env);
    h = appendTurn(h, parsed.chatId, parsed.threadId, 'assistant', text);
    await env.BRIEFING.put('assistantHistory', JSON.stringify(h));
  } catch (e) {
    console.error('assistantHistory (question) write failed (не блокує відповідь)', e);
  }
}

/**
 * Новий вхід у агента: жодного циклу — надіслати «⏳», віддати роботу хосту.
 * Уся тривала частина живе на VPS, тож ця функція завершується за ~300мс.
 */
async function runAssistantAgent(env, parsed, userText) {
  const sendText = sendTo(env, parsed);
  if (!userText || !userText.trim()) return sendText(UNKNOWN_REPLY); // стікер/фото/порожнє — не LLM
  if (!agentHostUrl(env) || !env.LLM_HOST_SECRET) return sendText(UNKNOWN_REPLY); // хост не налаштований
  // Без цього секрету нічим підписати ран-токен — а без токена зворотні виклики
  // хоста не мали б доказу, що прогін почав Worker. Краще чесна заглушка.
  if (!env.TELEGRAM_WEBHOOK_SECRET) {
    console.error('assistant: немає TELEGRAM_WEBHOOK_SECRET — ран-токен не підписати');
    return sendText(UNKNOWN_REPLY);
  }

  const nowMs = Date.now();
  const priorContext = renderHistoryForPrompt(
    await loadAssistantHistory(env),
    parsed.chatId,
    parsed.threadId,
  );
  const userMsg = userText.length > MAX_USER_TEXT ? userText.slice(0, MAX_USER_TEXT) : userText;
  const transcript = clipTranscript(`${priorContext}Користувач написав: "${userMsg}"`);

  // «⏳» ПЕРЕД стартом: ланцюжок може тривати десятки секунд, і мовчазний чат у
  // цей час читається як «зламалось». message_id запамʼятовуємо в токені, щоб
  // прибрати повідомлення, коли прийде справжня відповідь.
  const progressMsgId = await messageIdOf(await sendText(ASSISTANT_WORKING_REPLY));

  const runId = crypto.randomUUID().slice(0, 8);
  const token = await mintRunToken(env.TELEGRAM_WEBHOOK_SECRET, {
    runId,
    chatId: parsed.chatId,
    threadId: parsed.threadId ?? null,
    progressMsgId,
    userText: userMsg,
    nowMs,
  });

  await markRunStarted(env, runId, {
    startedMs: nowMs,
    chatId: parsed.chatId,
    threadId: parsed.threadId ?? null,
    progressMsgId,
  });

  const started = await startAgentRun(env, {
    token,
    transcript,
    systemPrompt: buildAssistantSystemPrompt(nowMs),
    jsonSchema: ASSISTANT_ACTION_SCHEMA,
    model: ASSISTANT_MODEL,
  });
  if (started.ok) return; // далі веде хост — відповідь прийде через /api/agent-step

  // Хост не взяв запит: марку знімаємо самі (сторожу нема чого чекати), а «⏳»
  // переписуємо на чесну причину замість того, щоб лишити його висіти.
  await markRunFinished(env, runId);
  const text = assistantErrorReply(started, nowMs);
  if (typeof progressMsgId === 'number') {
    const res = await tgCall(env, 'editMessageText', {
      chat_id: parsed.chatId,
      message_id: progressMsgId,
      text,
    });
    if (res.ok) return res;
  }
  return sendText(text);
}

/**
 * Виконати ЧИТАЛЬНУ дію -> текст для транскрипту. Усі три джерела (календар,
 * власні дані, пошта) — ЛИШЕ ДАНІ для моделі: вміст плющиться в один рядок у
 * assistant-data-core (щоб не підробив розділювачі транскрипту), а системний
 * промпт окремо попереджає не виконувати команди звідти.
 */
async function runReadAction(env, action, nowMs) {
  if (action.action === 'readMail') {
    return formatMailForPrompt(await readMail(env, action.mailQuery));
  }
  if (action.action === 'readMailBody') {
    return formatMailBodyForPrompt(await readMailBody(env, action.mailId));
  }
  if (action.action === 'readDrive') {
    return formatDriveForPrompt(await searchDrive(env, action.driveQuery));
  }
  if (action.action === 'readOwnData') {
    // Читаємо всі чотири блоби завжди (KV-читання дешеві; buildOwnDataDigest бере
    // лише потрібне за scope) — простіше за розгалуження по scope.
    const [state, stats, latest, settings] = await Promise.all([
      loadState(env),
      loadStats(env),
      loadLatest(env),
      loadSettings(env),
    ]);
    const todayKey = kyivDateKey(new Date(nowMs));
    const digest = buildOwnDataDigest({
      scope: action.dataScope,
      reminders: state.reminders,
      agg: aggregateStats(stats, todayKey),
      roadmap: totalProgress(state.roadmapProgress ?? {}),
      latest,
      todayKey,
      settings,
    });
    return `Твої дані: ${digest}`;
  }
  // readCalendar — Y-M-D зсув через addDaysToDateKey (НЕ +N*86400000мс на
  // інстант — те ламається на DST-переході). Один день -> formatEventsForPrompt
  // (без дати), діапазон -> formatRangeEventsForPrompt (кожна подія з DD.MM).
  const today = kyivDateKey(new Date(nowMs));
  const startKey = addDaysToDateKey(today, action.startDay);
  const endKey = addDaysToDateKey(today, action.endDay);
  const events = await readCalendarRange(env, startKey, endKey);
  const single = action.startDay === action.endDay;
  const label = single ? startKey : `${startKey}…${endKey}`;
  const body = single
    ? formatEventsForPrompt(events ?? [])
    : formatRangeEventsForPrompt(events ?? []);
  return `Календар (${label}): ${body}`;
}

/** На передостанньому кроці прямо кажемо, що читань більше не буде — інакше
 *  зайве читання зʼїдає останній крок і вбиває весь запит. */
const AGENT_LAST_STEP_NUDGE =
  '\n\nЦе ОСТАННІЙ крок: більше читати не можна. Дай ФІНАЛЬНУ дію ' +
  '(proposeCalendarChanges / createReminder / reply) з тим, що вже маєш.';

/**
 * POST /api/agent-step — зворотний виклик хоста (варіант Б).
 *
 * ДВА незалежні докази потрібні, щоб цей ендпоінт щось зробив:
 *   1. `X-Llm-Host-Secret` — «запит справді від нашого хоста»;
 *   2. ран-токен, підписаний worker-only ключем — «крок належить прогонові, який
 *      Worker сам почав у відповідь на повідомлення власника».
 * Другий доказ і є межею: без нього скомпрометований хост міг би сам заводити
 * прогони й, скажімо, качати пошту (відповідь-бо йде йому ж).
 *
 * Тіло: {token, structured} — дія від моделі, або {token, failure} — хост здався.
 * Відповідь: {done:true} | {done:false, append, token} (текст у транскрипт + токен
 * наступного кроку).
 */
async function handleAgentStep(request, env) {
  if (!env.LLM_HOST_SECRET || !env.TELEGRAM_WEBHOOK_SECRET) {
    return json({ ok: false, error: 'not-configured' }, 503);
  }
  if (!verifyWebhookSecret(request.headers.get('X-Llm-Host-Secret'), env.LLM_HOST_SECRET)) {
    return json({ ok: false, error: 'bad-secret' }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'bad-json' }, 400);
  }

  const nowMs = Date.now();
  const verified = await verifyRunToken(env.TELEGRAM_WEBHOOK_SECRET, body?.token, nowMs);
  if (!verified.ok) {
    // Протухлий/переступлений токен — не аварія: сторож дожене прогін і сам
    // відзвітує власнику. Хосту кажемо зупинитись.
    console.error('agent-step: токен відхилено —', verified.error);
    return json({ ok: false, error: verified.error, done: true }, 401);
  }
  const claims = verified.claims;

  /* ── Реплей завершеного прогону ────────────────────────────────────────
     Токен самодостатній, тож той самий крок можна надіслати двічі — а кожен
     виклик виконує інструмент і повертає результат ВИКЛИКАЧЕВІ. Найгидкіший
     варіант — коли обмін для власника вже візуально завершився («⏳» зникло,
     відповідь прийшла), а хтось і далі качає цим токеном пошту. Тут ми цей
     шлях закриваємо.

     ⚠️ Best-effort, і це чесно: KV не має read-your-writes, тож надгробок,
     покладений секунду тому, може бути ще не видним. Вікно звужує коротке
     життя кроку (AGENT_STEP_TTL_MS). Повне рішення — тримати лічильник кроків
     у Durable Object (заодно прибрало б і KV-розсинхрон); поки прогонів
     одиниці на добу, ця пара запобіжників пропорційна. */
  const knownRun = (await loadAgentRuns(env))[claims.runId];
  if (knownRun?.finishedMs) {
    console.error(`agent-step: крок для вже завершеного прогону ${claims.runId} — відхилено`);
    return json({ ok: false, error: 'run-finished', done: true }, 409);
  }

  const parsed = { chatId: claims.chatId, threadId: claims.threadId };

  /** Спільний фінал: прибрати «⏳», віддати відповідь, записати памʼять, зняти марку. */
  const finish = async (send, assistantSummary) => {
    await deleteProgressMessage(env, claims.chatId, claims.progressMsgId);
    await send();
    if (assistantSummary) await rememberExchange(env, claims, assistantSummary);
    await markRunFinished(env, claims.runId, nowMs);
    return json({ ok: true, done: true });
  };

  const sendText = sendTo(env, parsed);

  // Хост здався сам: ліміт підписки, CLI впав, мережа. Текст залежить від
  // ПРИЧИНИ — той самий класифікатор, що й до переходу.
  if (body.failure) {
    const f = body.failure;
    const text = assistantErrorReply(
      {
        ok: false,
        status: Number(f?.status) || 0,
        error: typeof f?.error === 'string' ? f.error : '',
        ...(Number.isFinite(f?.resetAtMs) ? { resetAtMs: f.resetAtMs } : {}),
      },
      nowMs,
    );
    console.error('agent-step: хост здався —', String(f?.error).slice(0, 200));
    return finish(() => sendText(text), null); // невдачу в памʼять не пишемо
  }

  const action = extractAssistantAction(body?.structured);
  if (!action) {
    console.error('agent-step: невалідна дія від моделі');
    return finish(() => sendText(ASSISTANT_FALLBACK_REPLY), null);
  }

  /* ── Термінальні дії ─────────────────────────────────────────────────── */
  if (action.action === 'reply') {
    if (!action.replyText) console.error('assistant: reply без replyText');
    const text = action.replyText || ASSISTANT_EMPTY_REPLY;
    return finish(() => sendText(text), text);
  }
  if (action.action === 'createReminder') {
    return finish(
      () => createReminderFromText(env, parsed, action.reminderText),
      '[поставив нагадування]',
    );
  }
  if (action.action === 'cancelReminder') {
    return finish(
      () => cancelReminderByText(env, parsed, action.reminderText),
      '[скасував нагадування]',
    );
  }
  if (action.action === 'updateReminder') {
    return finish(() => updateReminderByText(env, parsed, action), '[оновив нагадування]');
  }
  if (action.action === 'recordAction') {
    return finish(() => runRecordAction(env, parsed, action), `[recordAction:${action.kind}]`);
  }
  if (action.action === 'proposeCalendarChanges') {
    return finish(
      () => proposeCalendarChanges(env, parsed, action.proposal),
      '[запропонував зміни календаря]',
    );
  }

  /* ── Читальні дії: віддати текст у транскрипт і токен наступного кроку ── */
  const nextToken = await nextRunToken(env.TELEGRAM_WEBHOOK_SECRET, claims);
  if (!nextToken) {
    // Кроки вичерпано, а фінальної дії так і немає. Не помилка моделі — свій
    // текст і свій лог, щоб цей шлях було видно окремо.
    console.error(`assistant: вичерпано ${AGENT_MAX_STEPS} кроків без фінальної дії`);
    return finish(() => sendText(ASSISTANT_ROUNDS_REPLY), null);
  }

  // Проміжний прогрес: перепишемо «⏳» під дію, яку зараз виконуємо (best-effort,
  // після guard'а — на «заплутався» вище цього робити ні до чого).
  const stepLabel = assistantStepLabel(action.action);
  if (stepLabel) await editProgressMessage(env, claims.chatId, claims.progressMsgId, stepLabel);

  let append;
  try {
    append = await runReadAction(env, action, nowMs);
  } catch (e) {
    // Збій інструмента НЕ валить прогін: кажемо моделі про невдачу й даємо
    // дійти до фінальної дії з тим, що вже є.
    console.error('agent-step: читальна дія впала', e?.message);
    append = 'Інструмент не спрацював — відповідай тим, що вже маєш.';
  }
  if (claims.step + 1 === AGENT_MAX_STEPS - 1) append += AGENT_LAST_STEP_NUDGE;

  return json({ ok: true, done: false, append, token: nextToken });
}

/**
 * Сторож обірваних прогонів (крон, кожні 5 хв). Хост міг померти посеред циклу —
 * OOM, рестарт systemd, впав VPS — і тоді власник лишився б із вічним «⏳
 * Працюю…». Саме тією мовчанкою, заради усунення якої й робився перехід.
 *
 * Алармуємо лише на записах зі `startedMs` без `finishedMs`, старших за
 * AGENT_RUN_STALE_MS (тобто вже й токен мертвий — прогін не міг би продовжитись).
 */
async function agentRunWatchdog(env) {
  const nowMs = Date.now();
  const runs = await loadAgentRuns(env);
  const stale = Object.entries(runs).filter(
    ([, r]) =>
      Number.isFinite(r?.startedMs) && !r?.finishedMs && nowMs - r.startedMs > AGENT_RUN_STALE_MS,
  );
  if (stale.length === 0) return;

  for (const [runId, r] of stale) {
    console.error(
      `assistant: прогін ${runId} обірвався (${Math.round((nowMs - r.startedMs) / 1000)}с)`,
    );
    await deleteProgressMessage(env, r.chatId, r.progressMsgId);
    await tgCall(env, 'sendMessage', {
      chat_id: r.chatId,
      message_thread_id: r.threadId ?? undefined,
      text: ASSISTANT_STALLED_REPLY,
    });
    runs[runId] = { ...r, finishedMs: nowMs };
  }
  try {
    await env.BRIEFING.put(AGENT_RUNS_KEY, JSON.stringify(pruneAgentRuns(runs, nowMs)));
  } catch (e) {
    console.error('agentRuns watchdog write failed', e);
  }
}

/** KV-марка останнього відомого стану здоров'я хоста (для дедуплікації алертів). */
const AGENT_HOST_HEALTH_KEY = 'agentHostHealth';

/**
 * Health-check хоста (крон, кожні 5 хв). Ловить НАЙТИХІШУ пастку деплою: новий
 * Worker + старий хост -> /agent віддає 404, асистент мовчки не працює, а /llm
 * (нагадування) живий, тож здається, ніби все ок (host/README, розділ «Оновлення
 * коду хоста»). Пінгуємо /agent і сигналимо власнику САМЕ про цей стан — і про
 * повернення до норми.
 *
 * Алармуємо лише на ЗМІНАХ стану (у нормі 'ok'->'ok' -> тиша) і лише на
 * детермінованому 404. Мережевий збій/таймаут -> 'unknown', стану не міняє:
 * лежачий хост власник і так бачить на першому ж запиті («недоступний»), а
 * флапаючий VPS не має спамити тему «Система».
 */
async function agentHostHealthCheck(env) {
  const url = agentHostUrl(env);
  // Без URL/секрету асистент свідомо вимкнений — стежити нема за чим. Без
  // TELEGRAM_CHAT_ID нема куди слати алерт.
  if (!url || !env.LLM_HOST_SECRET || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;

  let probe = { reached: false, status: 0 };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8_000);
  try {
    // Порожнє тіло НАВМИСНО: новий хост валідує й віддає 400 (маршрут /agent є),
    // старий — 404 (маршруту немає). Прогін НЕ стартує (немає токена), claude не
    // спавниться — проба дешева.
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-llm-host-secret': env.LLM_HOST_SECRET },
      body: '{}',
      signal: ctrl.signal,
    });
    probe = { reached: true, status: res.status };
  } catch (e) {
    console.error('host health probe failed (не аварія)', e?.message);
  } finally {
    clearTimeout(timer);
  }

  const current = classifyHostProbe(probe);
  let prev = 'ok';
  try {
    prev = JSON.parse((await env.BRIEFING.get(AGENT_HOST_HEALTH_KEY)) ?? '{}')?.state ?? 'ok';
  } catch {
    /* биття JSON -> 'ok' (щоб перший справжній 404 дав алерт) */
  }

  const { next, alert } = hostHealthTransition(prev, current);
  if (alert) {
    console.error(`host health: ${prev} -> ${current} (${alert})`);
    await tgCall(env, 'sendMessage', {
      chat_id: env.TELEGRAM_CHAT_ID,
      message_thread_id: env.TOPIC_SYSTEM || env.TOPIC_BRIEFING || undefined,
      text: alert === 'warn' ? HOST_DESYNC_ALERT : HOST_RECOVERED_ALERT,
    });
  }
  if (next !== prev) {
    try {
      await env.BRIEFING.put(
        AGENT_HOST_HEALTH_KEY,
        JSON.stringify({ state: next, atMs: Date.now() }),
      );
    } catch (e) {
      console.error('host health state write failed', e);
    }
  }
}

/** ВЛАСНИЙ KV-ключ пропозиції — НЕ в блобі 'state'. Причина: блоб 'state' пишуть
 *  наївні read-modify-write писарі (lastUpdateId у вебхуку, крон checkReminders,
 *  дашборд applyEvent) БЕЗ merge-before-flush; KV не має read-your-writes, тож
 *  писар, що прочитав блоб за мить до запису пропозиції, затирає її назад — і
 *  кожен ✅ падає в «Застаріла пропозиція» (баг, знайдений на проді 19.07). Той
 *  самий мотив, що [sentMessages]/[agentRuns]/[assistantHistory] — окремий ключ. */
const ASSISTANT_PENDING_KEY = 'assistantPending';

/**
 * Прочитати активну пропозицію -> pending|null.
 * Брифінг (src/orchestrator, mail.ts) тепер теж пише СЮДИ напряму (writeKvJson
 * на assistantPending, не в блоб `state`) — legacy-фолбек на `state.assistantPending`
 * прибрано разом із самим записом на тому боці.
 */
async function loadAssistantPending(env) {
  try {
    const own = JSON.parse((await env.BRIEFING.get(ASSISTANT_PENDING_KEY)) ?? 'null');
    return own && typeof own === 'object' ? own : null;
  } catch {
    return null; // биття ключа -> як «нема пропозиції», не крашимо
  }
}

/**
 * Списати пропозицію (double-tap-safe): лише якщо це ДОСІ той самий id.
 * Put-null тумбстоун (не delete: KV без read-your-writes, і delete немає в
 * частині тест-моків — той самий мотив, що markRunFinished). Повертає true,
 * якщо саме цей виклик списав.
 */
async function claimAssistantPending(env, id) {
  const pending = await loadAssistantPending(env);
  if (!pending || pending.id !== id) return false;
  await env.BRIEFING.put(ASSISTANT_PENDING_KEY, 'null');
  return true;
}

/**
 * Домалювати `base` (свіже title/whenMs/durationMin) на updateEvent/
 * deleteEvent пунктах — ОБОВʼЯЗКОВИЙ інваріант перед показом/accept: без
 * нього formatProposalMessage не мав би з чим рахувати діф, а видалення
 * показувало б голий id. Той самий крок і для LLM-пропозиції (тут), і для
 * button-staged (stageItemEdit/stageItemDelete) — обидва канали віддають
 * REST accept-loop СТРУКТУРНО ОДНАКОВІ пункти. Пункт, чий eventId уже не
 * резолвиться (подію видалено між readCalendar і пропозицією) — дропається,
 * не падає весь пакет.
 */
async function enrichEventItems(env, items) {
  const out = [];
  for (const item of items) {
    if (item.kind === 'settings') {
      // base = ПОТОЧНИЙ блоб — потрібен formatProposalMessage для діфу
      // «було -> стане» (той самий інваріант, що base на updateEvent).
      out.push({ ...item, base: await loadSettings(env) });
      continue;
    }

    // Гості (PR-10): event/updateEvent можуть нести "attendees" (сирі
    // імена/email від sanitizeProposal) — резолвимо в email ЩЕ ДО показу
    // пропозиції (People API), щоб текст показував «Гості: ...»/notes ще до
    // підтвердження, а не сюрпризом після ✅.
    let attendeeFields;
    if ((item.kind === 'event' || item.kind === 'updateEvent') && item.attendees?.length) {
      const { emails, notes } = await resolveAttendees(env, item.attendees);
      attendeeFields = { resolvedAttendees: emails, attendeeNotes: notes };
    }

    if (item.kind !== 'updateEvent' && item.kind !== 'deleteEvent') {
      out.push({ ...item, ...attendeeFields });
      continue;
    }
    if (item.kind === 'deleteEvent') {
      const fresh = await getCalendarEvent(env, item.eventId);
      if (!fresh) continue; // подія зникла — тихо дропаємо пункт, не весь пакет
      out.push({
        ...item,
        base: {
          title: fresh.title,
          whenMs: fresh.startMs,
          durationMin: (fresh.endMs - fresh.startMs) / 60_000,
        },
      });
      continue;
    }
    const fresh = await getCalendarEvent(env, item.eventId);
    if (!fresh) continue; // подія зникла — тихо дропаємо пункт, не весь пакет
    out.push({
      ...item,
      ...attendeeFields,
      base: {
        title: fresh.title,
        whenMs: fresh.startMs,
        durationMin: (fresh.endMs - fresh.startMs) / 60_000,
      },
    });
  }
  return out;
}

/**
 * Попередження про накладку часу (extra a, схвалено власником) для create-
 * подій і update-пунктів, що МІНЯЮТЬ час. ОДИН читальний виклик на весь
 * пакет (вікно від найранішого до найпізнішого кандидата), не по пункту —
 * дешевше й достатньо для типового пакета (≤MAX_PROPOSAL_ITEMS). Інформативно,
 * НЕ блокує пропозицію; збій читання -> тихо без попереджень (не критично).
 */
async function computeOverlapWarnings(env, items) {
  const warnings = new Map();
  const spans = items
    .map((item, index) => {
      if (item.kind === 'event' && Number.isFinite(item.whenMs)) {
        return { index, eventId: null, start: item.whenMs, dur: item.durationMin ?? 60 };
      }
      if (item.kind === 'updateEvent' && Number.isFinite(item.whenMs)) {
        return {
          index,
          eventId: item.eventId,
          start: item.whenMs,
          dur: item.durationMin ?? item.base?.durationMin ?? 60,
        };
      }
      return null;
    })
    .filter(Boolean);
  if (spans.length === 0) return warnings;

  const minMs = Math.min(...spans.map((s) => s.start));
  const maxMs = Math.max(...spans.map((s) => s.start + s.dur * 60_000));
  const events = await readCalendarRange(
    env,
    kyivDateKey(new Date(minMs)),
    kyivDateKey(new Date(maxMs)),
  );
  if (!events) return warnings;

  for (const span of spans) {
    const overlaps = findOverlaps(events, span.start, span.start + span.dur * 60_000, span.eventId);
    if (overlaps.length > 0) {
      warnings.set(
        span.index,
        overlaps.map((e) => (e.time ? `${e.title} ${e.time}` : e.title)),
      );
    }
  }
  return warnings;
}

/** Зберегти пропозицію (власний KV-ключ, ОДИН слот) + кнопки ✅/❌ підтвердження. */
async function proposeCalendarChanges(env, parsed, rawProposal) {
  const sendText = sendTo(env, parsed);

  const { items: rawItems, droppedCount } = sanitizeProposal(rawProposal, Date.now());
  const items = await enrichEventItems(env, rawItems);
  if (items.length === 0) {
    return sendText(
      '🤔 Не зрозумів час жодного пункту — спробуй точніше (напр. "завтра о 15:00").',
    );
  }

  const id = crypto.randomUUID().slice(0, 8);
  // cfg = доналаштування (циклери ⏳/⏰, create-режим). null = «як є»: тривалість
  // від моделі, сповіщення за дефолтом календаря (поведінка до цієї фічі).
  const cfg = { durMin: null, leadMin: null };
  await env.BRIEFING.put(
    ASSISTANT_PENDING_KEY,
    JSON.stringify({ id, items, createdMs: Date.now(), cfg }),
  );

  const warnings = await computeOverlapWarnings(env, items);
  const droppedNote = droppedCount > 0 ? `\n\n⚠️ пропущено ${droppedCount} — незрозумілий час` : '';
  return sendText(formatProposalMessage(items, warnings) + droppedNote, {
    parse_mode: 'HTML',
    reply_markup: buildProposalKeyboard(id, items, cfg),
  });
}

// Клавіатура, що чекає на GPS-позицію (/locate) — request_location доступний
// ЛИШЕ як властивість KeyboardButton, inline-кнопки цього не вміють (Bot
// API). Скасування — окремий рядок нижче: без нього власник лишався б із
// однокнопковою клавіатурою, якщо передумав ділитись позицією.
function locateKeyboard() {
  return {
    keyboard: [[{ text: '📍 Надіслати позицію', request_location: true }], [LOCATE_CANCEL_LABEL]],
    resize_keyboard: true,
  };
}

function normalKeyboard() {
  return { keyboard: REPLY_KEYBOARD, resize_keyboard: true, is_persistent: true };
}

/**
 * Обробити GPS-позицію з /locate (фідбек власника: IP-геолокація не
 * встигає за реальним рухом; Live Location відкинуто — фоновий дозвіл ОС +
 * 8-годинний ліміт Telegram занадто нав'язливо для одноразової звірки).
 * Той самий ownerGeoManual, що ручний пошук у Mini App (WeatherBlock) —
 * єдине джерело правди для «власник сам сказав, де він», байдуже, звідки
 * прийшла назва (тап у чаті чи вибір зі списку).
 *
 * lat/lon гарантовано скінченні числа — parseUpdate (tg-core.mjs) вже
 * відфільтрував биті координати до null ДО того, як handleCommand
 * викликає це (parsed.location взагалі не було б truthy інакше).
 */
async function handleLocationShare(env, parsed, sendText) {
  const { latitude: lat, longitude: lon } = parsed.location;
  const name = env.WEATHER_API_KEY
    ? ((await reverseGeocodeCity(lat, lon, env.WEATHER_API_KEY)) ?? 'Твоя локація')
    : 'Твоя локація';
  const manual = { lat: roundGeo(lat), lon: roundGeo(lon), name, setAtMs: Date.now() };
  await env.BRIEFING.put('ownerGeoManual', JSON.stringify(manual));
  return sendText(`📍 Позицію оновлено: ${name}. Погода в Mini App підхопить за кілька секунд.`, {
    reply_markup: normalKeyboard(),
  });
}

/** Обробити текстове повідомлення (slash-команда/reply-keyboard) -> sendMessage. */
async function handleCommand(env, parsed, origin) {
  const sendText = sendTo(env, parsed);

  // GPS-позиція (відповідь на /locate) і скасування тимчасової клавіатури —
  // ОБИДВА поза звичайним parseCommand: перше не має тексту взагалі, друге —
  // не команда й не reply-keyboard alias з KEYBOARD_ALIASES.
  if (parsed.location) return handleLocationShare(env, parsed, sendText);
  if (parsed.text === LOCATE_CANCEL_LABEL) {
    return sendText('Гаразд, без змін.', { reply_markup: normalKeyboard() });
  }

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
        reply_markup: {
          keyboard: REPLY_KEYBOARD,
          resize_keyboard: true,
          // is_persistent: клавіатура лишається розгорнутою замість того, щоб
          // ховатись за перемикачем ⊞ — на мобільному прибирає зайвий тап
          // (Bot API 6.4). input_field_placeholder — підказка в порожньому полі
          // вводу: бот розуміє вільний текст («нагадай...»), про що ніде не
          // сказано, поки людина саме дивиться на порожнє поле.
          is_persistent: true,
          input_field_placeholder: 'Команда або "нагадай..."',
        },
      });
    case 'help':
      return sendText(HELP_TEXT, { parse_mode: 'HTML' });
    case 'agent':
      return sendText(AGENT_TEXT, { parse_mode: 'HTML' });
    case 'locate':
      return sendText('Тисни кнопку нижче, щоб надіслати поточну GPS-позицію 📍', {
        reply_markup: locateKeyboard(),
      });
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
      // force: ручний /brief — явний намір «хочу зараз», а не ще одна спроба
      // крону. Без нього команда після ранкової доставки мовчки не робила
      // нічого (див. коментар над dispatchBrief).
      const ok = await dispatchBrief(env, { force: true });
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
    case 'agenda': {
      const events = await readUpcomingWeek(env);
      if (!events) return sendText('🔌 Не вдалось прочитати календар — спробуй пізніше.');
      const now = Date.now();
      const keyboard = buildAgendaKeyboard(events, now);
      return sendText(formatAgendaMessage(events, now), {
        parse_mode: 'HTML',
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
      return sendText(
        formatWhereAmI(parsed.chatId, parsed.threadId, me, env.TOPIC_ASSISTANT ?? null),
        {
          parse_mode: 'HTML',
        },
      );
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

/** Обробити `rs:<presetIdx>:<id>` (extra b) — snooze за одним із трьох пресетів. */
async function resolveReminderSnoozePreset(env, parsed, presetIdx, reminderId) {
  return resolveReminderAction(
    env,
    parsed,
    reminderId,
    (reminders, id, nowMs) => snoozeReminderPreset(reminders, id, presetIdx, nowMs),
    '😴 Відкладено',
  );
}

/** Обробити cancel-callback (`rc:<id>`, §C4) — видалити нагадування назавжди. */
async function resolveReminderCancel(env, parsed, reminderId) {
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
async function resolveSleepStart(env, parsed) {
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
async function resolveReminderDone(env, parsed, reminderId) {
  const state = await loadState(env);
  const reminders = Array.isArray(state.reminders) ? state.reminders : [];
  const reminder = reminders.find((r) => r.id === reminderId);
  if (!reminder) return '⚠️ Це нагадування вже неактуальне.';

  state.reminders = cancelReminder(reminders, reminderId);
  await env.BRIEFING.put('state', JSON.stringify(state));
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
async function resolveReminderCancelAll(env, parsed) {
  const state = await loadState(env);
  const active = listActive(state.reminders);
  if (active.length === 0) return 'Нема що скасовувати.';

  state.reminders = active.reduce((rs, r) => cancelReminder(rs, r.id), state.reminders);
  await env.BRIEFING.put('state', JSON.stringify(state));

  if (parsed.chatId != null && parsed.messageId != null) {
    const keyboard = buildRemindersKeyboard(state.reminders);
    await tgCall(env, 'editMessageText', {
      chat_id: parsed.chatId,
      message_id: parsed.messageId,
      text: formatRemindersListMessage(state.reminders),
      parse_mode: 'HTML',
      ...(keyboard.inline_keyboard.length ? { reply_markup: keyboard } : {}),
    });
  }
  return `🗑 Скасовано ${active.length}`;
}

/**
 * Клавіатура ПІСЛЯ accept — Edit/Delete на кожен УСПІШНИЙ пункт (create-
 * режим), одне 🗑 (edit-режим успіх — Видалити щойно оновлену подію), або
 * нічого (delete-режим/провал). Глеїть простори ДВОХ модулів (ev: із
 * calendar-core, rc:/ru: із reminders-core) — тому тут, у worker.js, не в
 * agent-core.mjs (той жодного з них не знає, лишається чистим від Worker-
 * специфічних callback-неймспейсів).
 */
function buildResultKeyboard(items, results) {
  const mode = proposalMode(items);

  if (mode === 'edit') {
    if (!results[0]?.ok) return { inline_keyboard: [] };
    const d = buildAgendaCallbackData('d', items[0].eventId);
    return d
      ? { inline_keyboard: [[{ text: '🗑 Видалити', callback_data: d }]] }
      : { inline_keyboard: [] };
  }
  if (mode === 'delete') return { inline_keyboard: [] };

  const rows = [];
  items.forEach((it, i) => {
    const r = results[i];
    if (!r?.ok || !r.id) return;
    if (it.kind === 'event') {
      const e = buildAgendaCallbackData('e', r.id);
      const d = buildAgendaCallbackData('d', r.id);
      if (e && d) {
        rows.push([
          { text: `✏️ ${i + 1}`, callback_data: e },
          { text: `🗑 ${i + 1}`, callback_data: d },
        ]);
      }
    } else if (it.kind === 'reminder') {
      const e = buildReminderEditCallbackData(r.id);
      const c = buildReminderCancelCallbackData(r.id);
      if (e && c) {
        rows.push([
          { text: `✏️ ${i + 1}`, callback_data: e },
          { text: `🗑 ${i + 1}`, callback_data: c },
        ]);
      }
    }
  });
  return { inline_keyboard: rows };
}

/**
 * Обробити pd:<action>:<id> — весь життєвий цикл пропозиції асистента
 * (`assistantPending`, ОКРЕМИЙ KV-ключ, ОДИН слот): create (a/c/d/l), edit (a/c/s/o),
 * delete (a/c). "Claim" (списати зі стану) ОДРАЗУ після перевірки, ще ДО
 * повільного циклу запису — інакше подвійний тап на ✅ (чи паралельна нова
 * пропозиція, що перезаписала слот, поки ця ще оброблялась) встигає
 * задублювати нагадування/події (createCalendarEvent — зовнішній незворотний
 * запис, не KV-стан), або стирає ЧУЖУ (новішу) пропозицію непроконтрольовано.
 *
 * ✅/❌ ЗАВЖДИ переписують повідомлення (editMessageText) — не лише тік
 * кнопки: власник має бачити результат (успіх/провал) і, для щойно
 * створених/оновлених подій-нагадувань, кнопки Edit/Delete НА МІСЦІ.
 */
async function resolveProposalCallback(env, parsed, cb) {
  const pending = await loadAssistantPending(env);
  const stale = !pending || pending.id !== cb.id || Date.now() - pending.createdMs > PENDING_TTL_MS;
  if (stale) return '⚠️ Застаріла пропозиція.';
  const cfg = pending.cfg ?? { durMin: null, leadMin: null };
  const mode = proposalMode(pending.items);

  /* ── Циклери create-режиму (d=тривалість, l=lead-time) ──────────────────
     НЕ споживають пропозицію: циклимо значення, перемальовуємо клавіатуру на
     місці. Текст тут від cfg не залежить -> досить editMessageReplyMarkup. */
  if (cb.action === 'd' || cb.action === 'l') {
    if (mode !== 'create') return '⚠️ Застаріла пропозиція.';
    const next =
      cb.action === 'd'
        ? { ...cfg, durMin: cycleProposalDuration(cfg.durMin) }
        : { ...cfg, leadMin: cycleProposalLead(cfg.leadMin) };
    await env.BRIEFING.put(ASSISTANT_PENDING_KEY, JSON.stringify({ ...pending, cfg: next }));
    if (parsed.chatId != null && parsed.messageId != null) {
      await tgCall(env, 'editMessageReplyMarkup', {
        chat_id: parsed.chatId,
        message_id: parsed.messageId,
        reply_markup: buildProposalKeyboard(cb.id, pending.items, next),
      });
    }
    return cb.action === 'd'
      ? `⏳ Тривалість: ${formatDurationLabel(next.durMin)}`
      : `⏰ Нагадати ${formatLeadLabel(next.leadMin)}`;
  }

  /* ── Цикл зсуву часу (s) — edit-режим АБО create-режим з ОДНИМ нагадуванням ─
     Текст ТЕЖ міняється (діф/час рахується від whenMs) -> тут editMessageText,
     не лише reply_markup. Анкер різний: edit зсуває від base.whenMs (ІСНУЮЧА
     подія), create-нагадування — від baseWhenMs (перший запропонований час;
     нової сутності ще не існує, «було» нема) — buildProposalKeyboard показує
     цей циклер лише для рівно одного пункту kind:'reminder' у create-режимі. */
  if (cb.action === 's') {
    const isCreateReminder =
      mode === 'create' && pending.items.length === 1 && pending.items[0]?.kind === 'reminder';
    if (mode !== 'edit' && !isCreateReminder) return '⚠️ Застаріла пропозиція.';
    const item = pending.items[0];
    const anchorMs = isCreateReminder
      ? (item.baseWhenMs ?? item.whenMs ?? 0)
      : (item.base?.whenMs ?? 0);
    const nextShift = cycleEventShift(item.shiftMin ?? 0);
    const nextItems = [{ ...item, shiftMin: nextShift, whenMs: anchorMs + nextShift * 60_000 }];
    await env.BRIEFING.put(ASSISTANT_PENDING_KEY, JSON.stringify({ ...pending, items: nextItems }));
    if (parsed.chatId != null && parsed.messageId != null) {
      await tgCall(env, 'editMessageText', {
        chat_id: parsed.chatId,
        message_id: parsed.messageId,
        text: formatProposalMessage(nextItems),
        parse_mode: 'HTML',
        reply_markup: buildProposalKeyboard(cb.id, nextItems, cfg),
      });
    }
    return `🕐 ${formatShiftLabel(nextShift)}`;
  }

  /* ── «✏️ Інше» (o) — гібрид: claim + питання + синтетична репліка ────────
     СПИСУЄ пропозицію (не циклер): «Інше» замінює подальший тап ✅/❌ на
     звичайну розмову — власник відповість вільним текстом, асистент сам
     побудує НОВУ proposeCalendarChanges(kind:'updateEvent') із eventId,
     скопійованим із позначки [id:...] (buildAssistantSystemPrompt). */
  if (cb.action === 'o') {
    if (mode !== 'edit') return '⚠️ Застаріла пропозиція.';
    const item = pending.items[0];
    const b = item.base ?? {};
    if (parsed.chatId != null && parsed.messageId != null && parsed.replyMarkup) {
      await tgCall(env, 'editMessageReplyMarkup', {
        chat_id: parsed.chatId,
        message_id: parsed.messageId,
        reply_markup: markButtonDone(parsed.replyMarkup, parsed.data),
      });
    }
    if (!(await claimAssistantPending(env, cb.id))) return '⚠️ Застаріла пропозиція.';
    const { historyText, displayText } = formatEventEditQuestion(
      item.eventId,
      item.title ?? b.title,
      item.whenMs ?? b.whenMs,
    );
    await sendTo(env, parsed)(displayText);
    await rememberAssistantQuestion(env, parsed, historyText);
    return '✍️ Напиши, що змінити';
  }

  // ── ✅/❌ (a/c) — термінальні: claim ОДРАЗУ, тоді перепис повідомлення ───
  if (!(await claimAssistantPending(env, cb.id))) return '⚠️ Застаріла пропозиція.';

  if (cb.action === 'c') {
    if (parsed.chatId != null && parsed.messageId != null) {
      await tgCall(env, 'editMessageText', {
        chat_id: parsed.chatId,
        message_id: parsed.messageId,
        text: '❌ Скасовано.',
      });
    }
    return '❌ Скасовано';
  }

  const results = [];
  for (const item of pending.items) {
    if (item.kind === 'reminder') {
      const newId = crypto.randomUUID();
      const fresh = await loadState(env);
      fresh.reminders = addReminder(fresh.reminders, {
        id: newId,
        text: item.title,
        whenMs: item.whenMs,
        nowMs: Date.now(),
      });
      await env.BRIEFING.put('state', JSON.stringify(fresh));
      results.push({ ok: true, id: newId });
    } else if (item.kind === 'event') {
      // Доналаштування: глобальний durMin/leadMin перекриває дефолти (null -> «як є»).
      const durMin = cfg.durMin ?? item.durationMin ?? 60;
      const startIso = new Date(item.whenMs).toISOString();
      const endIso = new Date(item.whenMs + durMin * 60_000).toISOString();
      const res = await createCalendarEvent(env, {
        title: item.title,
        startIso,
        endIso,
        reminderMinutes: cfg.leadMin ?? undefined,
        location: item.location,
        attendees: item.resolvedAttendees, // РЕЗОЛЬВЛЕНІ email (enrichEventItems), не сирі імена
      });
      results.push(res.ok ? { ok: true, id: res.id } : { ok: false });
    } else if (item.kind === 'updateEvent') {
      // Поля, які циклер/"Інше" НЕ чіпали (undefined) -> беремо з base
      // (свіжопрочитана подія при стейджингу) — часткове оновлення.
      const b = item.base ?? {};
      const title = item.title ?? b.title;
      const whenMs = item.whenMs ?? b.whenMs;
      const durationMin = item.durationMin ?? b.durationMin ?? 60;
      const startIso = new Date(whenMs).toISOString();
      const endIso = new Date(whenMs + durationMin * 60_000).toISOString();
      const res = await updateCalendarEvent(env, {
        eventId: item.eventId,
        patch: buildUpdateEventBody({
          title,
          startIso,
          endIso,
          location: item.location,
          attendees: item.resolvedAttendees,
        }),
      });
      results.push(res.ok ? { ok: true, id: item.eventId } : { ok: false });
    } else if (item.kind === 'deleteEvent') {
      const res = await deleteCalendarEvent(env, { eventId: item.eventId });
      results.push(res.ok ? { ok: true } : { ok: false });
    } else if (item.kind === 'settings') {
      // Повторна нормалізація тут НАВМИСНО (item.settings уже нормалізований у
      // sanitizeProposal) — той самий "не довіряй нічому, що пролежало в KV/
      // пройшло через мережу" рефлекс, що й решта accept-циклу.
      await env.BRIEFING.put('settings', JSON.stringify(normalizeSettings(item.settings)));
      results.push({ ok: true });
    } else if (item.kind === 'contact') {
      const res = await createContact(env, { name: item.title, email: item.email });
      results.push(res.ok ? { ok: true } : { ok: false });
    } else {
      results.push({ ok: false });
    }
  }

  if (parsed.chatId != null && parsed.messageId != null) {
    const resultKeyboard = buildResultKeyboard(pending.items, results);
    await tgCall(env, 'editMessageText', {
      chat_id: parsed.chatId,
      message_id: parsed.messageId,
      text: formatProposalResult(pending.items, results),
      parse_mode: 'HTML',
      // reply_markup лише коли є що показати — Telegram не любить порожній inline_keyboard.
      ...(resultKeyboard.inline_keyboard.length ? { reply_markup: resultKeyboard } : {}),
    });
  }

  if (mode === 'delete') return results[0]?.ok ? '🗑 Видалено' : '⚠️ Не вдалось видалити';
  if (mode === 'edit') return results[0]?.ok ? '✅ Оновлено' : '⚠️ Не вдалось оновити';
  if (mode === 'settings') return results[0]?.ok ? '⚙️ Застосовано' : '⚠️ Не вдалось застосувати';
  if (mode === 'contact') return results[0]?.ok ? '👤 Збережено' : '⚠️ Не вдалось зберегти';
  const ok = results.filter((r) => r.ok).length;
  const fail = results.length - ok;
  return fail > 0 ? `✅ Додано ${ok}, ⚠️ не вдалось ${fail}` : `✅ Додано ${ok}`;
}

/** Стейджити РЕДАГУВАННЯ існуючої події (`ev:e:<id>` — з /agenda чи
 *  пост-accept кнопки): читає СВІЖУ подію (список/попередній accept міг бути
 *  застарілим), будує single-item updateEvent-пропозицію (shiftMin=0 -> «як
 *  заплановано») і шле тим самим шляхом, що звичайна пропозиція (той самий
 *  keyboard/accept-цикл, що LLM-шлях, resolveProposalCallback). */
async function stageItemEdit(env, parsed, eventId) {
  const fresh = await getCalendarEvent(env, eventId);
  if (!fresh) return '🤔 Цю подію вже не знайти — можливо, видалено.';

  const base = {
    title: fresh.title,
    whenMs: fresh.startMs,
    durationMin:
      Number.isFinite(fresh.endMs) && Number.isFinite(fresh.startMs)
        ? (fresh.endMs - fresh.startMs) / 60_000
        : 60,
  };
  const item = { kind: 'updateEvent', eventId, shiftMin: 0, whenMs: base.whenMs, base };
  const id = crypto.randomUUID().slice(0, 8);
  await env.BRIEFING.put(
    ASSISTANT_PENDING_KEY,
    JSON.stringify({ id, items: [item], createdMs: Date.now() }),
  );
  await sendTo(env, parsed)(formatProposalMessage([item]), {
    parse_mode: 'HTML',
    reply_markup: buildProposalKeyboard(id, [item], {}),
  });
  return '✏️ Онови час чи напиши, що змінити';
}

/** Стейджити ВИДАЛЕННЯ існуючої події (`ev:d:<id>`) — той самий підтверджувальний
 *  цикл, що create/update (✅/❌, delete-режим клавіатури — лише Так/Ні). */
async function stageItemDelete(env, parsed, eventId) {
  const fresh = await getCalendarEvent(env, eventId);
  if (!fresh) return '🤔 Цю подію вже не знайти — можливо, видалено.';

  const base = { title: fresh.title, whenMs: fresh.startMs };
  const item = { kind: 'deleteEvent', eventId, base };
  const id = crypto.randomUUID().slice(0, 8);
  await env.BRIEFING.put(
    ASSISTANT_PENDING_KEY,
    JSON.stringify({ id, items: [item], createdMs: Date.now() }),
  );
  await sendTo(env, parsed)(formatProposalMessage([item]), {
    parse_mode: 'HTML',
    reply_markup: buildProposalKeyboard(id, [item], {}),
  });
  return '🗑 Підтверди видалення';
}

/** Київський DD.MM HH:MM — для питань редагування нагадування (людський час,
 *  не epoch). */
function kyivWhen(ms) {
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
async function resolveReminderEditPrompt(env, parsed, reminderId) {
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
async function readUpcomingWeek(env) {
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
async function resolveAgendaCallback(env, parsed, cb) {
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
      text: `📅 <b>${escapeHtml(fresh.title)}</b>\n${kyivWhen(fresh.startMs)}${locLine}`,
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
      // Розширений snooze (extra b): рядок пресетів, не одна фіксована +10 хв.
      // Старий rm:<id> (одна кнопка) лишається ЖИВИМ обробником — уже надіслані
      // повідомлення з ним не можна переписати заднім числом.
      reply_markup: { inline_keyboard: [buildSnoozeRow(r.id)] },
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
      const agendaCb = parseAgendaCallbackData(parsed.data); // 'ev:' — CRUD /agenda
      const roadmapCb = parseRoadmapCallbackData(parsed.data);
      const reminderCancelId = parseReminderCancelCallbackData(parsed.data); // 'rc:' — §C4
      const reminderEditId = parseReminderEditCallbackData(parsed.data); // 'ru:' — CRUD
      const reminderDoneId = parseReminderDoneCallbackData(parsed.data); // 'rk:' — «✅ Виконано»
      const snoozePreset = parseReminderSnoozeCallbackData(parsed.data); // 'rs:' — extra b
      const isReminderSnooze =
        typeof parsed.data === 'string' && parsed.data.startsWith(REMINDER_CB_PREFIX);
      const isSleepStart = isSleepStartCallback(parsed.data); // 'sl:' — «🌙 Ліг спати»
      const toast = proposalCb
        ? await resolveProposalCallback(env, parsed, proposalCb)
        : agendaCb
          ? await resolveAgendaCallback(env, parsed, agendaCb)
          : roadmapCb
            ? await resolveRoadmapCallback(env, parsed, roadmapCb)
            : reminderCancelId === 'all'
              ? await resolveReminderCancelAll(env, parsed)
              : reminderCancelId
                ? await resolveReminderCancel(env, parsed, reminderCancelId)
                : reminderEditId
                  ? await resolveReminderEditPrompt(env, parsed, reminderEditId)
                  : reminderDoneId
                    ? await resolveReminderDone(env, parsed, reminderDoneId)
                    : snoozePreset
                      ? await resolveReminderSnoozePreset(
                          env,
                          parsed,
                          snoozePreset.presetIdx,
                          snoozePreset.id,
                        )
                      : isReminderSnooze
                        ? await resolveReminderSnooze(
                            env,
                            parsed,
                            parsed.data.slice(REMINDER_CB_PREFIX.length),
                          )
                        : isSleepStart
                          ? await resolveSleepStart(env, parsed)
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

  if (!isOwner(parsed, allowedUserIds(env))) {
    // Не власник/не в списку дозволених — тихо ігноруємо, не палимо деталі стороннім.
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

/**
 * Ядро реєстрації бота (вебхук + меню команд + профіль + кнопка-меню +
 * вітальний пін) — спільне для ручного POST /api/telegram/setup і автоматичного
 * щоденного самозапуску (autoTelegramSetup, нижче). origin — БЕЗ кінцевого
 * слеша (URL.origin це гарантує; env.MINI_APP_URL перевіряємо явно, бо туди
 * значення вводить власник руками).
 */
async function runTelegramSetup(env, origin) {
  const res = await tgCall(env, 'setWebhook', {
    url: `${origin}/api/telegram`,
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
    menu_button: { type: 'web_app', text: 'Mini App', web_app: { url: origin } },
  });
  await ensureAppWelcomePin(env, origin);
  return res.ok;
}

/** POST /api/telegram/setup -> ручний виклик runTelegramSetup. Auth тим самим
 *  заголовком, що й вебхук (X-Telegram-Bot-Api-Secret-Token) — не query-param
 *  (не осідає в логах). Лишається як фолбек/діагностика — щоденний
 *  autoTelegramSetup (нижче) робить те саме без ручного curl. */
async function handleTelegramSetup(request, env) {
  if (!env.TELEGRAM_WEBHOOK_SECRET || !env.TELEGRAM_BOT_TOKEN) {
    return json({ ok: false, error: 'no-webhook-secret' }, 500);
  }
  const header = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
  if (!verifyWebhookSecret(header, env.TELEGRAM_WEBHOOK_SECRET)) {
    return json({ ok: false, error: 'bad-secret' }, 401);
  }
  const url = new URL(request.url);
  const ok = await runTelegramSetup(env, url.origin);
  return json({ ok, webhookUrl: `${url.origin}/api/telegram` });
}

/**
 * Щоденний самозапуск runTelegramSetup — власник більше НЕ мусить руками
 * викликати curl після зміни команд/опису/кнопки-меню чи якщо вебхук/пін
 * загубився. Усі кроки runTelegramSetup — ідемпотентні виклики Telegram API
 * (перевстановлюють те саме значення), тож щоденний повтор безпечний і сам є
 * формою self-healing (той самий мотив, що ensureAppWelcomePin усередині).
 *
 * Гейт на MINI_APP_URL — Worker-секрет (wrangler secret put), ТЕ САМЕ значення,
 * що вже є в оркестраторі (.env.example): поза HTTP-запитом (тут — крон) немає
 * request.url, з якого можна взяти origin. Без секрету функція тихо
 * пропускається — ручний curl (README) лишається робочим фолбеком.
 *
 * Раз на добу — той самий "остання дата" ідіом, що dispatch.lastAutoDate.
 */
async function autoTelegramSetup(env) {
  if (!env.MINI_APP_URL || !env.TELEGRAM_WEBHOOK_SECRET || !env.TELEGRAM_BOT_TOKEN) return;
  const today = kyivDateKey();
  const state = await loadState(env);
  if (state.telegramSetupDate === today) return;
  const origin = env.MINI_APP_URL.replace(/\/+$/, '');
  await runTelegramSetup(env, origin);
  const fresh = await loadState(env); // перечитати — попередні кроки могли писати state (пін)
  fresh.telegramSetupDate = today;
  await env.BRIEFING.put('state', JSON.stringify(fresh));
}

/**
 * Одноразове закріплене вітальне повідомлення з кнопкою Mini App (фідбек
 * власника, п.2) — «одна стала точка входу», не залежна від того, куди
 * прогорнута стрічка чату. Ідемпотентно: getChat каже, яке повідомлення
 * закріплене ЗАРАЗ — якщо це вже наше (id збігається зі стором) -> no-op,
 * повторний /api/telegram/setup нічого не дублює. Якщо власник зняв
 * закріплення вручну чи видалив повідомлення (pinnedId не збігається/відсутній)
 * -> шлемо нове й закріплюємо знову (self-healing замість «закріпилось один
 * раз і забули»).
 */
async function ensureAppWelcomePin(env, miniAppUrl) {
  if (!env.TELEGRAM_CHAT_ID) return;
  const chatId = env.TELEGRAM_CHAT_ID;

  // Резонний-за-замовчуванням: пересилаємо/переприкріплюємо ЛИШЕ якщо getChat
  // ПОЗИТИВНО підтвердив, що поточний пін не наш (не збігається зі стором) чи
  // взагалі відсутній. Транзієнтний збій getChat (мережа/таймаут) НЕ повинен
  // тлумачитись як «пін загублено» — інакше одна флуктуація що дня давала б
  // ще один дубль вітального повідомлення (крон викликає це раз на добу
  // безумовно). Замість цього просто пропускаємо цикл: завтрашній getChat
  // або підтвердить пін (no-op), або справді покаже втрату (і полагодить).
  let pinnedId;
  try {
    const chatRes = await tgCall(env, 'getChat', { chat_id: chatId });
    const chatJson = await chatRes.json();
    pinnedId = chatJson?.result?.pinned_message?.message_id;
  } catch (e) {
    console.error('ensureAppWelcomePin: getChat не вдався — пропускаємо цикл', e?.message);
    return;
  }
  const state = await loadState(env);
  if (typeof state.appWelcomePinMsgId === 'number' && pinnedId === state.appWelcomePinMsgId) {
    return;
  }

  const button = buildMiniAppButton(
    '📊 Відкрити Mini App',
    miniAppUrl,
    chatId,
    env.TELEGRAM_BOT_USERNAME,
  );
  const sendRes = await tgCall(env, 'sendMessage', {
    chat_id: chatId,
    message_thread_id: env.TOPIC_BRIEFING ?? undefined,
    text: APP_WELCOME_TEXT,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[button]] },
  });
  const sendJson = await sendRes.json().catch(() => null);
  const newId = sendJson?.result?.message_id;
  if (typeof newId !== 'number') return;

  await tgCall(env, 'pinChatMessage', {
    chat_id: chatId,
    message_id: newId,
    disable_notification: true,
  });
  // Перечитати — між першим loadState (вище) і тепер минуло 2 await Telegram-
  // виклики, конкурентний писар того ж блоба (checkReminders/вебхук на тому
  // самому 5-хвилинному тіку) міг оновити щось інше в 'state' за цей час.
  const fresh = await loadState(env);
  fresh.appWelcomePinMsgId = newId;
  await env.BRIEFING.put('state', JSON.stringify(fresh));
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

/**
 * Тригер brief-воркфлоу. Повертає true, якщо workflow_dispatch прийнято (SL2 —
 * /brief сіє кулдаун ЛИШЕ після успіху; ніколи не кидає — false при збої).
 *
 * force розділяє два РІЗНІ виклики, які доти йшли однаковим шляхом:
 *   • автоматичний (autoBriefDispatch, крон) — force=false, бо guard-
 *     ідемпотентність тут і є захистом: у вікні 08:00–12:00 крон стукає що
 *     5 хв, і без неї власник отримав би 48 брифінгів;
 *   • ручний /brief — force=true. Доти він теж ішов без force, тож УСЯ команда
 *     після ранкової доставки була тихим no-op: guard бачив lastSent===today,
 *     писав «send=false» і завершував воркфлоу успіхом, а бот уже відрапортував
 *     «Запустив генерацію — прийде за кілька хвилин». Ніщо не приходило й
 *     ніде не було помилки. Ручний виклик — це явний намір «хочу ЗАРАЗ», його
 *     квоту стереже власний годинний кулдаун (briefCooldownRemainingMs), а не
 *     добова ідемпотентність.
 */
async function dispatchBrief(env, { force = false } = {}) {
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
      // inputs у workflow_dispatch — РЯДКИ, навіть для `type: boolean` (REST
      // API приймає лише string-значення, GitHub сам приводить до boolean перед
      // обчисленням `inputs.force` у brief.yml). Ключ узагалі не шлемо, коли
      // force=false, — тоді працює default: false з опису воркфлоу.
      body: JSON.stringify({ ref: 'main', ...(force ? { inputs: { force: 'true' } } : {}) }),
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

/**
 * П'ятихвилинний крон-гейт: вікно слоту (matchCheckinNudgeWindow) -> зібрати
 * три прапорці з KV (тихі години/вже нагадали/слот заповнено) -> чиста
 * shouldSendCheckinNudge (stats-core.mjs, тестована без KV/fetch) вирішує.
 * Ідемпотентно за добу — store.checkinNudgeDates[slot] (той самий "останню
 * дату записав" ідіом, що dispatch.lastAutoDate/reliability.lastCheckDate —
 * не зростаючий журнал, один рядок на слот).
 */
async function checkinNudgeCheck(env) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  const minuteOfDay = kyivMinuteOfDay(new Date());
  const win = matchCheckinNudgeWindow(minuteOfDay);
  if (!win) return;

  const [settings, store] = await Promise.all([loadSettings(env), loadStats(env)]);
  const today = kyivDateKey();
  const dateKey = checkinDateKey(today, kyivHour());
  const due = shouldSendCheckinNudge({
    quiet: isQuietMinute(settings, minuteOfDay),
    alreadyNudgedToday: store.checkinNudgeDates?.[win.slot] === today,
    slotFilled: Boolean(store.checkins?.[dateKey]?.[win.slot]),
  });
  if (!due) return;

  await tgCall(env, 'sendMessage', {
    chat_id: env.TELEGRAM_CHAT_ID,
    message_thread_id: env.TOPIC_ASSISTANT ?? undefined,
    text: win.text,
  });

  // Позначаємо ПІСЛЯ надсилання, окремим безпечним patch на свіжий stats —
  // не тим самим `store`, що читали для рішення `due` (той міг устигнути
  // застаріти, поки лист Telegram); sendMessage (побічний ефект) уже
  // стався РАЗ вище, тож сам patch — чиста, спокійно повторювана мутація.
  // НЕ normalize() тут — воно не знає про checkinNudgeDates (ad-hoc поле
  // поза emptyStore-схемою) і мовчки прибрало б його; той самий контракт,
  // що мав ОРИГІНАЛЬНИЙ код (прямий спред store, без normalize).
  await updateStats(env, (curStore) => ({
    ...curStore,
    checkinNudgeDates: { ...(curStore.checkinNudgeDates ?? {}), [win.slot]: today },
  }));
}

/**
 * П'ятихвилинний крон-гейт для Блоку «Сон»: те саме вікно-мисливство, що
 * checkinNudgeCheck, ПЛЮС прибирання завислих кнопок з МИНУЛИХ ночей —
 * власник прямо попросив: сповіщення не мусить просто висіти, якщо тап так і
 * не стався. Обидва кроки в одній функції — обидва читають/пишуть один і той
 * самий store, зайвий проліт у KV не потрібен.
 */
async function sleepNudgeCheck(env) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  const minuteOfDay = kyivMinuteOfDay(new Date());
  const store = await loadStats(env);
  const nightKey = checkinDateKey(kyivDateKey(), kyivHour());

  // Побічні ефекти (editMessageText/sendMessage) збираємо як ЧИСТІ дані
  // (dateKey-и/msgId), не мутуємо `store` напряму тут — сам запис у KV
  // робимо ОКРЕМО, нижче, через updateStats на свіжому знімку. Інакше цей
  // крон (мережеві виклики Telegram — секунди) переписав би своєю
  // застарілою до-заповнення копією щойно записане авто-заповнення сну з
  // ранкового 'open' (реальний кейс, що й привів до цього фіксу).
  const clearedDateKeys = [];

  // 1) Ночі з надісланим, але НЕ натиснутим нагадуванням — уже не поточна ніч
  // (checkinDateKey тримає ТУ САМУ ніч стабільною аж до 06:00, тож «минула» тут
  // означає справді минула, а не просто «перейшли за північ»).
  for (const { dateKey, nudgeMsgId } of staleSleepNudges(store.sleepLog, nightKey)) {
    await tgCall(env, 'editMessageText', {
      chat_id: env.TELEGRAM_CHAT_ID,
      message_id: nudgeMsgId,
      text: '🌙 Не встиг зафіксувати — нічого, вранці вкажеш час сну вручну.',
      reply_markup: { inline_keyboard: [] },
    });
    clearedDateKeys.push(dateKey);
  }

  // 2) Нове нагадування — лише у вікні (23:00–02:00) і лише раз за ніч.
  let newNudge = null;
  if (inSleepNudgeWindow(minuteOfDay)) {
    const settings = await loadSettings(env);
    const due = shouldSendSleepNudge({
      quiet: isQuietMinute(settings, minuteOfDay),
      alreadySentTonight: store.sleepLog?.[nightKey]?.nudgeMsgId != null,
    });
    if (due) {
      const res = await tgCall(env, 'sendMessage', {
        chat_id: env.TELEGRAM_CHAT_ID,
        message_thread_id: env.TOPIC_ASSISTANT ?? undefined,
        text: SLEEP_NUDGE_TEXT,
        reply_markup: {
          inline_keyboard: [
            [{ text: '🌙 Ліг спати', callback_data: buildSleepStartCallbackData() }],
          ],
        },
      });
      const sent = await res.json().catch(() => null);
      const msgId = sent?.result?.message_id;
      if (typeof msgId === 'number') newNudge = { nightKey, msgId };
    }
  }

  if (clearedDateKeys.length === 0 && !newNudge) return;

  // Усі Telegram-виклики вже сталися РАЗ вище; сам patch на sleepLog —
  // чиста, безпечно повторювана мутація (не normalize() — те саме
  // застереження, що в checkinNudgeCheck: ad-hoc поля поза emptyStore не
  // мають зникати).
  await updateStats(env, (curStore) => {
    const next = { ...curStore, sleepLog: { ...(curStore.sleepLog ?? {}) } };
    for (const dateKey of clearedDateKeys) {
      next.sleepLog[dateKey] = { ...next.sleepLog[dateKey], nudgeCleared: true };
    }
    if (newNudge) {
      next.sleepLog[newNudge.nightKey] = {
        ...next.sleepLog[newNudge.nightKey],
        nudgeMsgId: newNudge.msgId,
      };
    }
    return next;
  });
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
  // день). updateStats — той самий безпечний read-modify-write, що й решта
  // писарів stats-блоба (recordReliability і так уже ідемпотентний за
  // lastCheckDate, тож повторне застосування при конфлікті — безпечне).
  try {
    await updateStats(env, (curStore) => recordReliability(curStore, today, fresh));
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
    if (url.pathname === '/api/weather') {
      return handleLiveWeather(request, env);
    }
    if (url.pathname === '/api/weather/location') {
      return handleWeatherLocation(request, env);
    }
    if (url.pathname === '/api/weather/locate-prompt') {
      return handleWeatherLocatePrompt(request, env);
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
    // Зворотний виклик LLM-хоста: цикл агента живе там, інструменти — тут
    // (варіант Б). Авторизація подвійна: спільний секрет хоста + підписаний
    // ран-токен. Свідомо БЕЗ CORS — це міжсерверний роут, не для браузера.
    if (url.pathname === '/api/agent-step' && request.method === 'POST') {
      return handleAgentStep(request, env);
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
        await agentRunWatchdog(env); // обірвані прогони агента, будь-яка хвилина
        await agentHostHealthCheck(env); // розсинхрон версій хоста, будь-яка хвилина
        await autoBriefDispatch(env); // [08:00, 11:00) Київ, раз на добу
        await deadMansCheck(env); // від 12:00 Київ, раз на добу
        await checkinNudgeCheck(env); // вікна нагадувань про чек-ін, раз на слот/добу
        await sleepNudgeCheck(env); // «Ліг спати» 23:00–02:00 + прибирання завислих кнопок
        await autoTelegramSetup(env); // самозапуск setup (вебхук/меню/пін), раз на добу
      })(),
    );
  },
};
