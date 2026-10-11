export const MEMORY_VALUE_LIMIT = 2000;
export const MEMORY_VALUE_ERROR =
  'Паролі, ключі доступу й коди підтвердження в пам’ять не зберігаю.';

/** Bounded, JSON-only private facts. Never return suspicious legacy values.
 * @param {unknown} value */
export function personalValueAllowed(value) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return false;
  }
  if (typeof encoded !== 'string' || encoded.length > MEMORY_VALUE_LIMIT) return false;
  return !/(?:\bsk-(?:proj-|svcacct-)?[a-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:password|passwd|access[_ -]?token|refresh[_ -]?token|api[_ -]?key|client[_ -]?secret)|\b(?:otp|cvv|cvc)\b|(?:парол|api[ -]?ключ|код[ау]? підтвердження))/iu.test(
    encoded,
  );
}
/** @param {unknown} value */
export function assertPersonalValue(value) {
  if (!personalValueAllowed(value)) throw new Error(MEMORY_VALUE_ERROR);
}
