import { SECRETS, ROTATED_KEY_PREFIX } from './secrets.mjs';
import { kyivInstant, kyivParts, shiftDate } from '../finance/planning.mjs';

const DAY = 86400000;
/** Canonical, code-derived locations; equal env names are not equal key values. */
export const CREDENTIALS = SECRETS.flatMap((secret) => {
  const locations = secret.where.includes('CF') ? ['cloudflare'] : [];
  if (secret.where.includes('brain')) locations.push('vps');
  if (secret.where.includes('GitHub')) locations.push('github');
  if (secret.name === 'BACKUP_ENC_KEY') locations.push('offline');
  return locations.map((location) => ({
    id: `${secret.name}:${location}`,
    name: secret.name,
    location,
    label: credentialLabel(secret.name),
    recommendedRotationDays: secret.recommendedRotationDays,
    legacy: secret.note?.includes('legacy') ?? false,
  }));
});
/** @param {string} name */
function credentialLabel(name) {
  const labels = {
    TELEGRAM_BOT_TOKEN: 'Telegram-бот',
    TELEGRAM_WEBHOOK_SECRET: 'Захист повідомлень Telegram',
    GOOGLE_CLIENT_SECRET: 'Підключення Google',
    GOOGLE_REFRESH_TOKEN: 'Доступ до Google',
    MAPS_API_KEY: 'Карти й маршрути',
    WEATHER_API_KEY: 'Погода',
    NEWSDATA_API_KEY: 'Старий сервіс новин',
    GOOGLE_TRANSLATE_API_KEY: 'Переклад новин',
    GEMINI_API_KEY: 'Генерація зображень',
    DEEPGRAM_API_KEY: 'Розпізнавання голосу',
    ITAD_API_KEY: 'Ціни ігор',
    MONO_TOKEN: 'Monobank',
    MONO_WEBHOOK_SECRET: 'Захист повідомлень Monobank',
    BRAIN_ACCESS_CLIENT_SECRET: 'Доступ до сервера асистента',
    INTERNAL_HMAC_KEY: 'Захист внутрішніх запитів',
    INTERNAL_HMAC_KEY_NEXT: 'Наступний ключ внутрішніх запитів',
    OPENAI_API_KEY: 'OpenAI',
    BACKUP_ENC_KEY: 'Шифрування резервних копій',
    CLAUDE_CODE_OAUTH_TOKEN: 'Старий AI-рушій',
    REPO_READ_PAT: 'Читання репозиторію',
    CF_API_TOKEN: 'Керування Cloudflare',
    VPS_DEPLOY_KEY: 'Оновлення сервера',
    GH_DISPATCH_TOKEN: 'Запуск автоматизацій',
    LLM_HOST_SECRET: 'Старий сервер асистента',
  };
  return /** @type {Record<string,string>} */ (labels)[name] ?? name;
}
/** @param {Env} env */
export async function credentialStoreAvailable(env) {
  return Boolean(
    env.DB &&
    (await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='credential_metadata'",
    )
      .bind()
      .first()),
  );
}
/** @param {unknown} value */
function dayString(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw new Error('Вкажи дату у форматі РРРР-ММ-ДД.');
  shiftDate(value, 0);
  return value;
}
/** Full, strictly allowlisted metadata command. Reject pasted secret fields.
 * @param {any} body @param {number} nowMs */
export function validateCredentialMetadata(body, nowMs) {
  if (
    !body ||
    Object.keys(body).some(
      (key) =>
        !['id', 'version', 'rotatedAt', 'expiresAt', 'rotateAfterDays', 'initData'].includes(key),
    )
  )
    throw new Error('Надсилай лише дати й нагадування, не значення ключів.');
  if (!['rotatedAt', 'expiresAt', 'rotateAfterDays'].every((key) => Object.hasOwn(body, key)))
    throw new Error('Потрібні повні дані дат і нагадування. Онови форму.');
  if (!CREDENTIALS.some((entry) => entry.id === body.id))
    throw new Error('Цей доступ не входить до реєстру.');
  if (!Number.isSafeInteger(body.version) || body.version < 0)
    throw new Error('Онови реєстр перед збереженням.');
  const rotatedAt = dayString(body.rotatedAt),
    expiresAt = dayString(body.expiresAt);
  if (rotatedAt && kyivInstant(rotatedAt, 0) > nowMs)
    throw new Error('Дата оновлення не може бути в майбутньому.');
  if (rotatedAt && expiresAt && expiresAt < rotatedAt)
    throw new Error('Строк дії не може передувати даті оновлення.');
  const rotateAfterDays =
    body.rotateAfterDays == null || body.rotateAfterDays === '' ? null : body.rotateAfterDays;
  if (
    rotateAfterDays != null &&
    (!Number.isInteger(rotateAfterDays) || rotateAfterDays < 1 || rotateAfterDays > 3650)
  )
    throw new Error('Інтервал ротації: від 1 до 3650 днів.');
  if (rotateAfterDays != null && !rotatedAt)
    throw new Error('Для нагадування про ротацію вкажи дату останнього оновлення.');
  return { id: String(body.id), version: body.version, rotatedAt, expiresAt, rotateAfterDays };
}
/** @param {Env} env @param {number} [nowMs] */
export async function readCredentials(env, nowMs = Date.now()) {
  const today = kyivParts(nowMs).date;
  const available = await credentialStoreAvailable(env);
  const rows =
    available && env.DB
      ? (await env.DB.prepare('SELECT * FROM credential_metadata').bind().all()).results
      : [];
  const legacy = env.DB
    ? (
        await env.DB.prepare(
          "SELECT key,value_json FROM facts WHERE kind='setting' AND key LIKE 'secret_rotated_%'",
        )
          .bind()
          .all()
      ).results
    : [];
  return {
    available,
    entries: CREDENTIALS.map((definition) => {
      const row = rows.find((row) => row.id === definition.id);
      let legacyRotationAt = null;
      const old = legacy.find((record) => record.key === `${ROTATED_KEY_PREFIX}${definition.name}`);
      try {
        const value = old ? JSON.parse(String(old.value_json)) : null;
        if (typeof value === 'string' && Number.isFinite(Date.parse(value)))
          legacyRotationAt = value;
      } catch {
        /* unknown metadata is not an expiry */
      }
      const expiresAt = row?.expires_at ? String(row.expires_at) : null;
      const rotatedAt = row?.rotated_at ? String(row.rotated_at) : null;
      const rotateAfterDays = row?.rotate_after_days == null ? null : Number(row.rotate_after_days);
      const expiryDaysLeft = expiresAt
        ? (Date.parse(`${shiftDate(expiresAt, 0)}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) /
          DAY
        : null;
      const rotationMs =
        rotatedAt && rotateAfterDays ? kyivInstant(shiftDate(rotatedAt, rotateAfterDays), 0) : null;
      return {
        ...definition,
        version: Number(row?.version ?? 0),
        rotatedAt,
        expiresAt,
        rotateAfterDays,
        legacyRotationAt,
        configured:
          definition.location === 'cloudflare'
            ? Boolean(env[/** @type {keyof Env} */ (definition.name)])
            : null,
        expiryDaysLeft,
        rotationDaysLeft: rotationMs == null ? null : Math.ceil((rotationMs - nowMs) / DAY),
      };
    }),
  };
}
/** @param {Env} env @param {any} body @param {number} nowMs */
export async function saveCredentialMetadata(env, body, nowMs) {
  const value = validateCredentialMetadata(body, nowMs);
  if (!env.DB || !(await credentialStoreAvailable(env)))
    throw new Error('Реєстр поки доступний лише для перегляду.');
  const result = await env.DB.prepare(
    `INSERT INTO credential_metadata(id,rotated_at,expires_at,rotate_after_days,version,updated_at)
    SELECT ?,?,?,?,1,? WHERE (?=0 AND NOT EXISTS(SELECT 1 FROM credential_metadata WHERE id=?))
      OR EXISTS(SELECT 1 FROM credential_metadata WHERE id=? AND version=?)
    ON CONFLICT(id) DO UPDATE SET rotated_at=excluded.rotated_at,expires_at=excluded.expires_at,
      rotate_after_days=excluded.rotate_after_days,version=credential_metadata.version+1,updated_at=excluded.updated_at
    WHERE credential_metadata.version=?`,
  )
    .bind(
      value.id,
      value.rotatedAt,
      value.expiresAt,
      value.rotateAfterDays,
      new Date(nowMs).toISOString(),
      value.version,
      value.id,
      value.id,
      value.version,
      value.version,
    )
    .run();
  return { saved: Number(result.meta.changes) === 1 };
}
