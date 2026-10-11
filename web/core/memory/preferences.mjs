import { factWriteToken, isOwnerAssertion, runFactsGet } from '../tools/facts.mjs';
export const PERSONALIZATION_KEY = 'personalization';
export const MEMORY_CATEGORIES = ['preferences', 'schedule', 'style'];
/** @returns {{version: 1, mode: 'confirm'|'explicit', categories: string[]}} */
export function defaultMemoryPreferences() {
  return { version: 1, mode: 'confirm', categories: [] };
}
/** Full configuration, never a partial/implicit expansion of consent.
 * @param {unknown} value */
export function validateMemoryPreferences(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Обери режим пам’яті.');
  const config = /** @type {Record<string, any>} */ (value);
  if (
    Object.keys(config).some((key) => !['version', 'mode', 'categories'].includes(key)) ||
    config.version !== 1 ||
    !['confirm', 'explicit'].includes(config.mode)
  )
    throw new Error('Налаштування пам’яті мають неправильний формат.');
  if (
    !Array.isArray(config.categories) ||
    config.categories.some((category) => !MEMORY_CATEGORIES.includes(category)) ||
    new Set(config.categories).size !== config.categories.length
  )
    throw new Error('Обери підтримувані категорії пам’яті.');
  if (config.mode === 'explicit' && !config.categories.length)
    throw new Error('Обери хоча б одну категорію автоматичного запису.');
  return /** @type {ReturnType<typeof defaultMemoryPreferences>} */ ({
    version: 1,
    mode: config.mode,
    categories: [...config.categories].sort(),
  });
}
/** A model-produced setting is not permission to enable automatic collection.
 * @param {Env} env @param {number} [nowMs] */
export async function readMemoryPreferences(env, nowMs = Date.now()) {
  const address = { kind: 'setting', key: PERSONALIZATION_KEY };
  const token = await factWriteToken(env, address);
  const entry = (await runFactsGet(env, address, nowMs)).result[0];
  if (!entry)
    return { preferences: defaultMemoryPreferences(), token, configured: false, valid: true };
  try {
    if (!isOwnerAssertion(entry.source) || entry.stale || entry.review_due)
      throw new Error('Unconfirmed or expired consent');
    return {
      preferences: validateMemoryPreferences(entry.value),
      token,
      configured: true,
      valid: true,
    };
  } catch {
    return { preferences: defaultMemoryPreferences(), token, configured: true, valid: false };
  }
}
