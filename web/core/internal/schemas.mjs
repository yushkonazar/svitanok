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
 *   minLength?: number,
 *   enum?: readonly string[],
 *   minimum?: number,
 *   maximum?: number,
 * }} InternalSchema
 */

/** POST /internal/tool/:name — виклик інструмента (07 §4; імена — етап PR-6). */
export const TOOL_REQUEST_SCHEMA = /** @type {InternalSchema} */ ({
  type: 'object',
  required: ['args'],
  properties: { args: { type: 'object' } },
});

/** POST /internal/deliver — фінальна відповідь прогону в тему. Кнопки —
 *  inline-клавіатура рядами; callback_data ≤ 64 байт (07 §9). */
export const DELIVER_SCHEMA = /** @type {InternalSchema} */ ({
  type: 'object',
  required: ['text'],
  properties: {
    text: { type: 'string', maxLength: 65_536 },
    buttons: {
      type: 'array',
      items: {
        type: 'array',
        items: {
          type: 'object',
          required: ['text', 'callback_data'],
          properties: {
            text: { type: 'string', maxLength: 64 },
            callback_data: { type: 'string', maxLength: 64 },
          },
        },
      },
    },
    // Результат останнього працівника (етап 4, S-7-1): ядро кладе в reports
    // і додає кнопки «Коротше / Інший тон / .md»; понад 3 500 - файл + Drive.
    worker: {
      type: 'object',
      required: ['name', 'text'],
      properties: {
        name: { type: 'string', maxLength: 32 },
        text: { type: 'string', maxLength: 20_000 },
      },
    },
  },
});

/** POST /internal/instruction - інструкція працівника з D1 для delegate
 *  (етап 4): мозок не має D1, тіло їде з хешем, як персона в /run. */
export const INSTRUCTION_SCHEMA = /** @type {InternalSchema} */ ({
  type: 'object',
  required: ['name'],
  properties: { name: { type: 'string', minLength: 1, maxLength: 64 } },
});

/** POST /internal/taint - позначити тред прогону tainted (01 §4.2: вихід
 *  працівника з tainted_output - зовнішній вміст; source - хто саме). */
export const TAINT_SCHEMA = /** @type {InternalSchema} */ ({
  type: 'object',
  required: ['source'],
  properties: { source: { type: 'string', minLength: 1, maxLength: 64 } },
});

/** POST /internal/status — оновлення статус-повідомлення (ядро троттлить,
 *  застарілі незіслані edit-и того ж message_id заміняються новішим). */
export const STATUS_SCHEMA = /** @type {InternalSchema} */ ({
  type: 'object',
  required: ['message_id', 'text'],
  properties: {
    message_id: { type: 'number', minimum: 1 },
    text: { type: 'string', maxLength: 4_096 },
  },
});

/** POST /internal/runs — телеметрія кроків прогону + опційний КЕРІВНИЙ
 *  outcome (ревʼю PR-3: ескалація - контракт, не поле журнального кроку;
 *  крок escalate лишається слідом у run_steps, рішення ядро читає звідси). */
export const RUNS_SCHEMA = /** @type {InternalSchema} */ ({
  type: 'object',
  required: ['steps'],
  properties: {
    steps: { type: 'array', items: { type: 'object' } },
    outcome: {
      type: 'object',
      properties: {
        escalate: {
          type: 'object',
          required: ['text'],
          properties: {
            text: { type: 'string', maxLength: 4096 },
            status_message_id: { type: 'number', minimum: 1 },
          },
        },
        // Подія в ланцюг від працівника (етап 3 PR-8, DayPlanChain): ядро
        // шле її у Workflow через sendEvent; payload - вихід працівника.
        chain: {
          type: 'object',
          required: ['id', 'event'],
          properties: {
            id: { type: 'string', maxLength: 40 },
            event: { type: 'string', maxLength: 32 },
            payload: { type: 'object' },
          },
        },
      },
    },
  },
});

/** POST /internal/artifact - результат idea-analysis.yml (07 §3, етап 4 PR-2):
 *  status ok (md - звіт, кап у байтах тримає скрипт) або failed (reason).
 *  run_id - у підписі; idea_id звіряється зі станом ланцюга. */
export const ARTIFACT_SCHEMA = /** @type {InternalSchema} */ ({
  type: 'object',
  required: ['idea_id', 'status'],
  properties: {
    idea_id: { type: 'string', maxLength: 64 },
    status: { type: 'string', maxLength: 16 },
    repo: { type: 'string', maxLength: 64 },
    sha: { type: 'string', maxLength: 64 },
    md: { type: 'string', maxLength: 100_000 },
    reason: { type: 'string', maxLength: 500 },
    meta: { type: 'object' },
  },
});

/** POST /internal/session — сесійний стан від мозку (ADR-038): sdk_session_id
 *  після прогону chat, summary_md від профілю summarize, turns_inc - інкремент
 *  лічильника ходів. Єдиний канал, яким мозок оновлює sessions. */
export const SESSION_SCHEMA = /** @type {InternalSchema} */ ({
  type: 'object',
  required: ['thread_id'],
  properties: {
    thread_id: { type: 'string', maxLength: 64 },
    sdk_session_id: { type: 'string', maxLength: 128 },
    summary_md: { type: 'string', maxLength: 20_000 },
    // First-party OpenAI transcript: only chat input/output, capped again by
    // the DB writer. It is not a provider response id or tool payload.
    transcript_append: { type: 'string', maxLength: 6_000 },
    clear_transcript: { type: 'boolean' },
    turns_inc: { type: 'number', minimum: 0, maximum: 1000 },
  },
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
  if (schema.type === 'string' && schema.minLength != null) {
    if (/** @type {string} */ (value).length < schema.minLength) {
      return fail(`коротше за ${schema.minLength}`);
    }
  }
  if (
    schema.type === 'string' &&
    schema.enum != null &&
    !schema.enum.includes(/** @type {string} */ (value))
  ) {
    return fail(`має бути одним із ${schema.enum.join(', ')}`);
  }
  if (schema.type === 'number') {
    const n = /** @type {number} */ (value);
    if (!Number.isFinite(n)) return fail('очікується скінченне число');
    if (schema.minimum != null && n < schema.minimum) return fail(`менше за ${schema.minimum}`);
    if (schema.maximum != null && n > schema.maximum) return fail(`більше за ${schema.maximum}`);
  }
  return { ok: true };
}
