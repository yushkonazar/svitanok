// Реєстр секретів і строків ротації (05-ops §2, docs/ops/secrets.md,
// етап 7 PR-5) - чиста частина: перелік, розрахунок дати закінчення й тексти.
//
// ⚠️ ДЖЕРЕЛО ДАТ - НЕ ПАМʼЯТЬ І НЕ ЗДОГАД. Дата останньої ротації живе рівно
// в одному місці: `facts.setting.secret_rotated_<NAME>`, куди її кладе
// власник командою «секрет X оновлено» (T0 з «↩»). Немає запису - асистент
// каже «дати не знаю», а не рахує від дня деплою чи від сьогодні: вигадане
// нагадування гірше за відсутнє, бо йому вірять.
//
// Список тут - ДАНІ, і той самий список читає docs/ops/secrets.md; парність
// тримає тест: розійдуться - runbook почне брехати про те, що в системі є.

/**
 * @typedef {{ name: string, where: string, periodDays: number | null, note?: string }} SecretDef
 */

/** Префікс факту з датою ротації. */
export const ROTATED_KEY_PREFIX = 'secret_rotated_';
/** Ключ стану нагадувань (щоб 30 і 7 днів не повторювались щодня). */
export const EXPIRY_STATE_KEY = 'secret_expiry_state';
/** Ключ мітки «уже казав про секрети без дати». */
export const UNKNOWN_MARK_KEY = 'secret_expiry_unknown_at';
/** Пороги нагадувань (05-ops §3: «за 30 і 7 днів»). */
export const REMIND_STAGES = /** @type {[number, number]} */ ([30, 7]);
/** Найширший поріг - межа, за якою нагадування вважається неактуальним. */
export const WIDEST_STAGE = REMIND_STAGES[0];
/** Як часто нагадувати про секрети БЕЗ дати ротації: раз на 30 діб. */
export const UNKNOWN_REPEAT_DAYS = 30;

/**
 * Секрети системи. `periodDays: null` - строку немає: такий секрет міняють за
 * подією (компрометація, зміна пароля), і рахувати йому «залишилось днів»
 * означало б вигадувати.
 * @type {SecretDef[]}
 */
export const SECRETS = [
  { name: 'TELEGRAM_BOT_TOKEN', where: 'CF', periodDays: null, note: 'за подією (BotFather)' },
  { name: 'TELEGRAM_WEBHOOK_SECRET', where: 'CF', periodDays: 365 },
  { name: 'GOOGLE_CLIENT_SECRET', where: 'CF', periodDays: 365 },
  {
    name: 'GOOGLE_REFRESH_TOKEN',
    where: 'CF',
    periodDays: null,
    note: 'гине при зміні пароля Google - перевидати за runbook',
  },
  { name: 'MAPS_API_KEY', where: 'CF', periodDays: 365 },
  { name: 'GEMINI_API_KEY', where: 'CF', periodDays: 365 },
  { name: 'DEEPGRAM_API_KEY', where: 'CF', periodDays: 365 },
  { name: 'ITAD_API_KEY', where: 'CF', periodDays: 365 },
  { name: 'MONO_TOKEN', where: 'CF', periodDays: null, note: 'за подією (кабінет Mono)' },
  { name: 'MONO_WEBHOOK_SECRET', where: 'CF', periodDays: 365 },
  { name: 'BRAIN_ACCESS_CLIENT_SECRET', where: 'CF', periodDays: 365 },
  { name: 'INTERNAL_HMAC_KEY', where: 'CF + brain/.env', periodDays: 365 },
  {
    name: 'BACKUP_ENC_KEY',
    where: 'CF + офлайн-копія',
    periodDays: null,
    note: 'не ротується без перешифрування бекапів; втрата = бекапи нечитабельні',
  },
  {
    name: 'CLAUDE_CODE_OAUTH_TOKEN',
    where: 'brain/.env + GitHub Secrets',
    periodDays: 365,
    note: 'один токен на всі місця - оновлювати скрізь за один раз',
  },
  { name: 'REPO_READ_PAT', where: 'GitHub Secrets', periodDays: 365 },
  { name: 'CF_API_TOKEN', where: 'GitHub Secrets', periodDays: 365 },
  { name: 'VPS_DEPLOY_KEY', where: 'GitHub Secrets', periodDays: null, note: 'за подією' },
  { name: 'GH_DISPATCH_TOKEN', where: 'CF', periodDays: 365 },
];

/** Секрети зі строком - лише вони можуть «закінчитись». */
export const DATED_SECRETS = SECRETS.filter((s) => s.periodDays != null);

const DAY = 86_400_000;

/**
 * Скільки діб лишилось. `null` - дата ротації невідома або строку немає.
 * @param {SecretDef} secret @param {string | null | undefined} rotatedAtIso @param {number} nowMs
 * @returns {number | null}
 */
export function daysLeft(secret, rotatedAtIso, nowMs) {
  if (secret.periodDays == null) return null;
  const at = rotatedAtIso ? Date.parse(rotatedAtIso) : NaN;
  if (!Number.isFinite(at)) return null;
  return Math.floor((at + secret.periodDays * DAY - nowMs) / DAY);
}

/**
 * Який поріг спрацював. Повертає 30, 7 або null. Не «рівно 30»: якщо задача
 * пропустила добу (деплой, збій), точний збіг втратив би нагадування назавжди
 * - тому поріг вважається пройденим від першого дня, коли залишок менший.
 * @param {number | null} left @param {number | null} lastStage
 */
export function stageFor(left, lastStage) {
  if (left == null) return null;
  for (const stage of REMIND_STAGES) {
    if (left <= stage && (lastStage == null || stage < lastStage)) return stage;
  }
  return null;
}

/**
 * Текст нагадування власнику.
 * @param {SecretDef} secret @param {number} left @param {number} stage
 */
export function expiryText(secret, left, stage) {
  const when =
    left < 0
      ? `строк вийшов ${Math.abs(left)} дн. тому`
      : left === 0
        ? 'строк виходить сьогодні'
        : `лишилось ${left} дн.`;
  return `🔑 ${secret.name} (${secret.where}): ${when} - поріг ${stage} дн. Онови за docs/ops/secrets.md і скажи «секрет ${secret.name} оновлено».`;
}

/** Текст про секрети, чиєї дати ротації система не знає.
 *  @param {string[]} names */
export function unknownText(names) {
  return `🔑 Не знаю дати ротації: ${names.join(', ')}. Коли оновиш - скажи «секрет <назва> оновлено», і я рахуватиму строк. Вигадувати дату не буду.`;
}
