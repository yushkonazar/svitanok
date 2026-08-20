// @ts-check
// Чиста логіка налаштувань власника (роадмеп v3, F2) — блоб KV `settings`.
// Worker (web/worker.js) читає/пише його через /api/settings; оркестратор
// (src/orchestrator.ts) читає ТОЙ САМИЙ ключ, щоб застосувати тумблери модулів
// до config.yml. Тут — лише чисті функції: валідація, мердж, тихі години.
//
// Блоб СВІДОМО окремий ключ, не всередині `state`: state — грабл-бег із частими
// писарями (нагадування, голоси, roadmap), і KV не має CAS. Налаштування пише
// лише власник із Mini App, тож окремий ключ прибирає гонку (той самий мотив,
// що в sentMessages/assistantHistory/briefDispatch).
//
// Форма:
//   { quiet: { enabled: bool, from: "HH:MM", to: "HH:MM" },
//     modules: { <id>: bool, … },    // лише явні оверрайди
//     mutedTopics: [ "<тема>", … ] }  // приглушені теми новин

/**
 * Модулі брифінгу, які власник може вмикати/вимикати з Mini App.
 * Свідомо НЕ всі 11: calendar/mail керуються наявністю GOOGLE_*-секретів, а
 * weeklyReview — тижневий і не входить у щоденний брифінг.
 * Відсутність id у settings.modules = дефолт config.yml (для цих восьми там
 * enabled:true — інваріант закріплено тестом у tests/config.test.ts).
 */
export const TOGGLEABLE_MODULE_IDS = [
  'weather',
  'currency',
  'mock',
  'fact',
  'stoic',
  'onthisday',
  'news',
  'jobs',
];

/**
 * Форма блоба `settings`.
 * @typedef {{ enabled: boolean, from: string, to: string }} QuietHours
 * @typedef {{ quiet: QuietHours, modules: Record<string, boolean>,
 *             mutedTopics: string[] }} Settings
 */

const DEFAULT_QUIET = { enabled: false, from: '22:00', to: '08:00' };

/**
 * Дефолт: тихі години ВИМКНЕНІ. Макет показує їх увімкненими, але вмикати їх
 * мовчки на боці сервера — значить почати глушити нічні нагадування власнику,
 * який про це не просив. Вмикається явним перемиканням.
 * @returns {Settings}
 */
export function emptySettings() {
  return { quiet: { ...DEFAULT_QUIET }, modules: {}, mutedTopics: [] };
}

/** Стеля списку приглушених тем — блоб налаштувань не має рости безмежно. */
const MUTED_TOPICS_CAP = 40;

/** "HH:MM" -> хвилини від опівночі (0..1439); невалідне -> null.
 *  @param {unknown} v
 *  @returns {number|null} */
export function parseHhmm(v) {
  if (typeof v !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Хвилини від опівночі -> канонічне "HH:MM" (з обгортанням через добу).
 *  @param {number} mins */
export function fmtHhmm(mins) {
  const m = ((Math.round(mins) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Нормалізувати частковий/битий блоб до повної форми (як normalize у stats-core).
 *  @param {KvBlob|null|undefined} raw
 *  @returns {Settings} */
export function normalizeSettings(raw) {
  const e = emptySettings();
  if (!raw || typeof raw !== 'object') return e;

  const q = raw.quiet && typeof raw.quiet === 'object' ? raw.quiet : {};
  const from = parseHhmm(q.from);
  const to = parseHhmm(q.to);

  const rawMods = raw.modules && typeof raw.modules === 'object' ? raw.modules : {};
  /** @type {Record<string, boolean>} */
  const modules = {};
  for (const id of TOGGLEABLE_MODULE_IDS) {
    if (typeof rawMods[id] === 'boolean') modules[id] = rawMods[id];
  }

  // Приглушені теми новин: лише непорожні рядки, без дублів, із капом. Імена тем
  // приходять із config.yml (display-назва), тож перелік ТУТ не зашитий — інакше
  // кожна нова тема вимагала б правки ще й цього файлу.
  /** @type {unknown[]} */
  const rawMuted = Array.isArray(raw.mutedTopics) ? raw.mutedTopics : [];
  const mutedTopics = [
    ...new Set(
      rawMuted.filter((t) => typeof t === 'string' && t.trim()).map((t) => String(t).trim()),
    ),
  ].slice(0, MUTED_TOPICS_CAP);

  return {
    quiet: {
      enabled: q.enabled === true,
      from: from === null ? e.quiet.from : fmtHhmm(from),
      to: to === null ? e.quiet.to : fmtHhmm(to),
    },
    modules,
    mutedTopics,
  };
}

/**
 * Чи зараз тихі години (minuteOfDay — хвилина київської доби, 0..1439).
 * Вікно може перетинати північ (22:00 -> 08:00). Межі: from включно, to НЕ
 * включно (о 08:00 нагадування вже йдуть). from === to -> вікно порожнє, а не
 * ціла доба: інакше випадковий однаковий час глушив би нагадування назавжди.
 * @param {KvBlob|null|undefined} settings
 * @param {number} minuteOfDay
 */
export function isQuietMinute(settings, minuteOfDay) {
  const s = normalizeSettings(settings);
  if (!s.quiet.enabled) return false;
  const from = parseHhmm(s.quiet.from);
  const to = parseHhmm(s.quiet.to);
  if (from === null || to === null || from === to) return false;
  return from < to
    ? minuteOfDay >= from && minuteOfDay < to
    : minuteOfDay >= from || minuteOfDay < to;
}

/**
 * Статус конекторів для Mini App — БЕЗ мережевих викликів: наявність секретів +
 * скоупи з кешованого access-токена (googleAccessToken кладе `scope` у KV).
 * Calendar і Gmail ділять ОДИН refresh token (спільний консент, див.
 * src/core/google-auth.ts), тож поки скоупи ще не закешовані, обидва
 * репортимо за наявністю секретів — так було історично.
 * @param {{ hasGoogleCreds: unknown, scope?: unknown }} opts
 */
export function connectorStatus({ hasGoogleCreds, scope }) {
  if (!hasGoogleCreds) return { google: false, calendar: false, gmail: false, contacts: false };
  if (typeof scope !== 'string' || !scope.trim()) {
    // contacts (PR-10, гості на подіях) — НОВИЙ скоуп, на відміну від
    // calendar/gmail тут порожній scope НЕ означає «є»: до першого
    // кешованого обміну з ре-консентом власника дефолт має бути false,
    // інакше Mini App брехав би, що резолюція гостей уже працює.
    return { google: true, calendar: true, gmail: true, contacts: false };
  }
  const scopes = scope.toLowerCase();
  return {
    google: true,
    calendar: scopes.includes('/auth/calendar'),
    gmail: scopes.includes('/auth/gmail'),
    contacts: scopes.includes('/auth/contacts'),
  };
}
