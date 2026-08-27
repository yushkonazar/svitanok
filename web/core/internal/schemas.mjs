// Контракти тіл internal API (07-schema §3) як JSON-схеми-дані + мінімальний
// структурний валідатор. Схеми — джерело істини для парності Zod ↔ JSON на
// боці мозку (етап 2, тест парності); валідатор навмисно вузький: type,
// required, properties, без ключових слів, яких контракти не вживають, — усе,
// що прилетіло через межу процесу, звіряється ЗІ СХЕМОЮ до виконання.

/**
 * @typedef {{
 *   type: 'object' | 'string' | 'number' | 'boolean' | 'array',
 *   required?: string[],
 *   properties?: Record<string, InternalSchema>,
 *   items?: InternalSchema,
 *   maxLength?: number,
 * }} InternalSchema
 */

/** POST /internal/tool/:name — виклик інструмента (07 §4; імена — етап PR-6). */
export const TOOL_REQUEST_SCHEMA = /** @type {InternalSchema} */ ({
  type: 'object',
  required: ['args'],
  properties: { args: { type: 'object' } },
});

/** POST /internal/deliver — фінальна відповідь прогону в тему. */
export const DELIVER_SCHEMA = /** @type {InternalSchema} */ ({
  type: 'object',
  required: ['text'],
  properties: { text: { type: 'string', maxLength: 65_536 } },
});

/** POST /internal/status — оновлення статус-повідомлення (ядро троттлить). */
export const STATUS_SCHEMA = /** @type {InternalSchema} */ ({
  type: 'object',
  required: ['text'],
  properties: { text: { type: 'string', maxLength: 4_096 } },
});

/** POST /internal/runs — телеметрія кроків прогону. */
export const RUNS_SCHEMA = /** @type {InternalSchema} */ ({
  type: 'object',
  required: ['steps'],
  properties: { steps: { type: 'array', items: { type: 'object' } } },
});

/**
 * Структурна звірка значення зі схемою. Перша розбіжність — назад зі шляхом:
 * помилка контракту має називати поле, а не «щось не так».
 * @param {InternalSchema} schema
 * @param {unknown} value
 * @param {string} [path]
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function validateAgainst(schema, value, path = '$') {
  const fail = (/** @type {string} */ why) => ({ ok: false, error: `${path}: ${why}` });
  if (schema.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return fail('очікується обʼєкт');
    }
    const record = /** @type {Record<string, unknown>} */ (value);
    for (const key of schema.required ?? []) {
      if (!(key in record)) return fail(`бракує поля "${key}"`);
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in record) {
        const res = validateAgainst(sub, record[key], `${path}.${key}`);
        if (!res.ok) return res;
      }
    }
    return { ok: true };
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return fail('очікується масив');
    if (schema.items) {
      for (let i = 0; i < value.length; i += 1) {
        const res = validateAgainst(schema.items, value[i], `${path}[${i}]`);
        if (!res.ok) return res;
      }
    }
    return { ok: true };
  }
  if (typeof value !== schema.type) return fail(`очікується ${schema.type}`);
  if (schema.type === 'string' && schema.maxLength != null) {
    if (/** @type {string} */ (value).length > schema.maxLength) {
      return fail(`довше за ${schema.maxLength}`);
    }
  }
  return { ok: true };
}
