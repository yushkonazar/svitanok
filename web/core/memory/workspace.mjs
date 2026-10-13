import {
  PERSONAL_FACT_KINDS,
  normalizeFactSource,
  runFactsGet,
  runFactsSet,
  runFactsDelete,
} from '../tools/facts.mjs';
import {
  readMemoryPreferences,
  validateMemoryPreferences,
  PERSONALIZATION_KEY,
} from './preferences.mjs';
import { personalValueAllowed, assertPersonalValue } from './safety.mjs';
import {
  assertMemoryRecord,
  isMemoryRecord,
  memorySemantics,
  memoryRecordText,
  MEMORY_TYPE_LABELS,
} from './semantics.mjs';
import { resolveProposal } from '../policy/proposals.mjs';

export class MemoryOperationError extends Error {
  /** @param {string} message @param {number} [status] */
  constructor(message, status = 409) {
    super(message);
    this.status = status;
  }
}

const LEGACY_KEYS = [
  'test_word',
  'setting.test_word',
  'test_reminder_word',
  'setting.test_reminder_word',
];
/** @type {Record<string,string>} */
const names = {
  profile: 'Про тебе',
  habit: 'Звичка',
  contact: 'Контакт',
  place: 'Місце',
  vehicle: 'Транспорт',
  inferred: 'Припущення',
};
/** @param {string} kind @param {string} key */
export function memoryAddressAllowed(kind, key) {
  return PERSONAL_FACT_KINDS.includes(kind) || (kind === 'setting' && LEGACY_KEYS.includes(key));
}
/** @param {string} kind @param {string} key */
function labelFor(kind, key) {
  const labels = /** @type {Record<string,string>} */ ({
    day_start: 'Початок дня',
    day_end: 'Завершення дня',
    lunch_at: 'Час обіду',
    reply_style: 'Стиль відповідей',
    reply_language: 'Мова відповідей',
  });
  return Object.hasOwn(labels, key)
    ? labels[key]
    : LEGACY_KEYS.includes(key)
      ? 'Тестове слово'
      : (names[kind] ?? 'Факт');
}
/** Bounded plain text only; React/Telegram handle escaping at the boundary.
 * @param {unknown} value @param {number} [depth] @returns {string} */
export function memoryValueText(value, depth = 0) {
  if (value == null) return 'Не задано';
  if (isMemoryRecord(value)) return memoryRecordText(value);
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'Так' : 'Ні';
  if (typeof value === 'number') return String(value);
  if (depth > 3) return 'Складений запис';
  if (Array.isArray(value)) return value.map((item) => memoryValueText(item, depth + 1)).join(', ');
  const object = /** @type {Record<string, unknown>} */ (value);
  if (typeof object.preference === 'string' && ['like', 'dislike'].includes(String(object.stance)))
    return `${object.stance === 'like' ? 'Подобається' : 'Не подобається'}: ${object.preference}`;
  return Object.entries(object)
    .slice(0, 12)
    .map(([key, item]) => `${key}: ${memoryValueText(item, depth + 1)}`)
    .join('\n');
}
/** @param {string} id */
function addressFromId(id) {
  const colon = id.indexOf(':');
  const kind = id.slice(0, colon),
    key = id.slice(colon + 1);
  if (colon < 1 || !key || id.length > 260 || !memoryAddressAllowed(kind, key))
    throw new Error('Цей запис не належить до персональної пам’яті.');
  return { kind, key };
}
/** @param {Record<string, any>} row @param {number} nowMs */
function entryFor(row, nowMs) {
  let value;
  try {
    value = JSON.parse(String(row.value_json));
  } catch {
    value = undefined;
  }
  const safe = personalValueAllowed(value);
  const due = (/** @type {unknown} */ time) =>
    typeof time === 'string' && Number.isFinite(Date.parse(time)) && Date.parse(time) <= nowMs;
  return {
    id: `${row.kind}:${row.key}`,
    label: isMemoryRecord(value)
      ? (MEMORY_TYPE_LABELS[value.type] ?? labelFor(row.kind, row.key))
      : labelFor(row.kind, row.key),
    semantics: memorySemantics(String(row.kind), String(row.key), value),
    value: safe ? value : null,
    text: safe
      ? memoryValueText(value)
      : 'Значення приховано: завелике, пошкоджене або схоже на дані доступу.',
    editable: safe,
    source: normalizeFactSource(row.source) ?? 'model_hypothesis',
    token: String(row.write_token ?? ''),
    updatedAt: String(row.updated_at),
    stale: due(row.expires_at),
    reviewDue: due(row.review_at),
    expiresAt: row.expires_at ?? null,
    reviewAt: row.review_at ?? null,
  };
}
/** Only allowlisted fields, no run inputs, prompts, notes or whole proposal payloads.
 * @param {Env} env @param {number} nowMs @param {number} [offset] */
export async function readMemoryWorkspace(
  env,
  nowMs,
  offset = 0,
  filter = { group: 'all', search: '' },
) {
  if (!env.DB) throw new Error('Memory database unavailable');
  const consent = await readMemoryPreferences(env, nowMs);
  const kinds = PERSONAL_FACT_KINDS.map(() => '?').join(','),
    keys = LEGACY_KEYS.map(() => '?').join(',');
  const rows =
    (
      await env.DB.prepare(
        `SELECT f.*, COALESCE((SELECT id FROM fact_ledger WHERE kind=f.kind AND key=f.key ORDER BY rowid DESC LIMIT 1), '') AS write_token FROM facts f WHERE f.kind IN (${kinds}) OR (f.kind='setting' AND f.key IN (${keys})) ORDER BY f.kind, f.key LIMIT 1001`,
      )
        .bind(...PERSONAL_FACT_KINDS, ...LEGACY_KEYS)
        .all()
    ).results ?? [];
  const pending =
    (
      await env.DB.prepare(
        "SELECT p.id, p.kind, p.payload_json, p.expires_at, p.context_json, COALESCE((SELECT id FROM fact_ledger WHERE kind=json_extract(p.payload_json,'$.kind') AND key=json_extract(p.payload_json,'$.key') ORDER BY rowid DESC LIMIT 1), '') AS current_token, (SELECT value_json FROM facts WHERE kind=json_extract(p.payload_json,'$.kind') AND key=json_extract(p.payload_json,'$.key')) AS current_value FROM proposals p WHERE p.status='open' AND p.level='T1' AND p.kind IN ('facts.set','facts.delete') AND json_valid(p.payload_json) AND p.expires_at > ? ORDER BY p.created_at DESC LIMIT 50",
      )
        .bind(new Date(nowMs).toISOString())
        .all()
    ).results ?? [];
  const candidates = [];
  for (const row of pending) {
    try {
      const payload = JSON.parse(String(row.payload_json));
      const context = JSON.parse(String(row.context_json ?? '{}'));
      if (
        typeof payload.kind !== 'string' ||
        typeof payload.key !== 'string' ||
        !memoryAddressAllowed(payload.kind, payload.key) ||
        typeof context.expectedEventId !== 'string'
      )
        continue;
      if (
        !personalValueAllowed(payload.key) ||
        (row.kind === 'facts.set' && !personalValueAllowed(payload.value))
      )
        continue;
      let currentValue;
      try {
        currentValue = JSON.parse(String(row.current_value));
      } catch {
        currentValue = null;
      }
      candidates.push({
        id: String(row.id),
        type: row.kind === 'facts.delete' ? 'remove' : 'save',
        label: isMemoryRecord(payload.value)
          ? (MEMORY_TYPE_LABELS[payload.value.type] ?? labelFor(payload.kind, payload.key))
          : labelFor(payload.kind, payload.key),
        text:
          row.kind === 'facts.delete'
            ? `Прибрати: ${personalValueAllowed(currentValue) ? memoryValueText(currentValue) : 'прихований запис'}?`
            : memoryValueText(payload.value),
        expiresAt: String(row.expires_at),
        stale: String(row.current_token) !== context.expectedEventId,
      });
    } catch {
      /* Malformed/old/private settings proposals are not memory cards. */
    }
  }
  const entries = rows
    .slice(0, 1000)
    .filter((row) => personalValueAllowed(row.key))
    .map((row) => entryFor(row, nowMs))
    .filter(
      (entry) =>
        (filter.group === 'all' ||
          (filter.group === 'review'
            ? entry.semantics.needsReview ||
              entry.stale ||
              entry.reviewDue ||
              entry.source === 'model_hypothesis'
            : entry.semantics.type === filter.group)) &&
        `${entry.label} ${entry.text}`
          .toLocaleLowerCase('uk-UA')
          .includes(filter.search.toLocaleLowerCase('uk-UA')),
    );
  return {
    preferences: consent.preferences,
    preferencesToken: consent.token,
    preferencesValid: consent.valid,
    entries: entries.slice(offset, offset + 25),
    truncated: rows.length > 1000,
    candidates,
    offset,
    nextOffset: entries.length > offset + 25 ? offset + 25 : null,
  };
}

/** @param {unknown} input */
export function validateMemoryCommand(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Неправильний запит пам’яті.');
  const body = /** @type {Record<string, any>} */ (input);
  const keys = {
    preferences: ['type', 'preferences', 'token', 'initData'],
    update: ['type', 'id', 'value', 'token', 'confirm', 'renew', 'initData'],
    remove: ['type', 'id', 'token', 'confirm', 'initData'],
    resolve: ['type', 'id', 'choice', 'initData'],
  };
  const allowed = /** @type {Record<string,string[]>} */ (keys)[body.type];
  if (
    typeof body.type !== 'string' ||
    !Object.hasOwn(keys, body.type) ||
    !allowed ||
    Object.keys(body).some((key) => !allowed.includes(key))
  )
    throw new Error('Запит містить непідтримувані поля.');
  if (body.type === 'resolve') {
    if (
      typeof body.id !== 'string' ||
      !body.id ||
      body.id.length > 64 ||
      !['ok', 'no'].includes(body.choice)
    )
      throw new Error('Обери рішення для пропозиції.');
  } else {
    if (typeof body.token !== 'string' || body.token.length > 64)
      throw new Error('Онови пам’ять перед зміною.');
    if (body.type === 'preferences') validateMemoryPreferences(body.preferences);
    else {
      if (typeof body.id !== 'string' || body.confirm !== true)
        throw new Error('Підтверди зміну цього факту.');
      addressFromId(body.id);
      if (body.type === 'update') {
        if (!Object.hasOwn(body, 'value') || typeof body.renew !== 'boolean')
          throw new Error('Немає нового значення або вибору актуальності.');
        assertPersonalValue(body.value);
        assertMemoryRecord(body.value);
      }
    }
  }
  return body;
}

/** Owner click is explicit consent; all writes share the chat's fact/ledger path.
 * @param {Env} env @param {Record<string,any>} body @param {number} nowMs */
export async function executeMemoryCommand(env, body, nowMs) {
  if (!env.DB) throw new Error('Memory database unavailable');
  if (body.type === 'preferences') {
    const preferences = validateMemoryPreferences(body.preferences);
    await runFactsSet(
      env,
      { kind: 'setting', key: PERSONALIZATION_KEY, value: preferences, source: 'owner_assertion' },
      nowMs,
      {
        actor: 'owner',
        expectedEventId: body.token,
        refreshValidity: true,
        why: 'Власник обрав режим пам’яті у Mini App',
      },
    );
    return { message: 'Режим пам’яті збережено.' };
  }
  if (body.type === 'resolve') {
    const rows =
      (
        await env.DB.prepare('SELECT kind, level, payload_json FROM proposals WHERE id=?')
          .bind(body.id)
          .all()
      ).results ?? [];
    if (!rows.length) throw new Error('Цієї пропозиції вже немає. Онови пам’ять.');
    let payload;
    try {
      payload = JSON.parse(String(rows[0]?.payload_json));
    } catch {
      throw new Error('Пропозиція пошкоджена. Надішли новий запит.');
    }
    if (
      !['facts.set', 'facts.delete'].includes(String(rows[0]?.kind)) ||
      rows[0]?.level !== 'T1' ||
      !memoryAddressAllowed(payload.kind, payload.key)
    )
      throw new Error('Цю дію не можна виконати через екран пам’яті.');
    if (rows[0]?.kind === 'facts.set' && body.choice === 'ok') assertPersonalValue(payload.value);
    const result = await resolveProposal(env, { id: body.id, choice: body.choice }, nowMs);
    if (!result.ok) throw new MemoryOperationError(result.error);
    if ('already' in result && !['approved', 'rejected'].includes(result.already))
      throw new Error('Пропозиція вже закрита. Надішли новий запит.');
    if ('status' in result && result.status === 'expired')
      throw new Error('Час підтвердження минув. Надішли новий запит.');
    return {
      message:
        'already' in result
          ? 'Рішення вже збережено.'
          : body.choice === 'ok'
            ? 'Рішення збережено.'
            : 'Пропозицію відхилено.',
    };
  }
  const address = addressFromId(body.id);
  const entry = (await runFactsGet(env, address)).result[0];
  if (!entry) {
    if (body.type === 'remove') return { message: 'Цього факту вже немає в поточній пам’яті.' };
    throw new Error('Факт уже прибрано. Онови пам’ять.');
  }
  if (body.type === 'remove') {
    await runFactsDelete(env, address, nowMs, {
      actor: 'owner',
      expectedEventId: body.token,
      why: 'Власник прибрав факт у Mini App',
    });
    return { message: 'Прибрано з поточної пам’яті. Історія зміни лишається.' };
  }
  if (
    address.kind === 'habit' &&
    ['day_start', 'day_end', 'lunch_at'].includes(address.key) &&
    (typeof body.value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(body.value))
  )
    throw new MemoryOperationError(
      'Час запиши у форматі 08:00. Плаваючу справу уточни в чаті.',
      400,
    );
  if (address.kind === 'profile' && /^preference\.[a-f0-9]{32}$/.test(address.key)) {
    const before = /** @type {Record<string, any>|null} */ (entry.value),
      after = body.value;
    if (
      !before ||
      !after ||
      typeof after !== 'object' ||
      (isMemoryRecord(after)
        ? after.type !== 'preference' || !['likes', 'dislikes'].includes(after.relation)
        : typeof after.preference !== 'string' || !['like', 'dislike'].includes(after.stance)) ||
      String(isMemoryRecord(before) ? before.subject : before.preference).toLocaleLowerCase(
        'uk-UA',
      ) !==
        String(isMemoryRecord(after) ? after.subject : after.preference).toLocaleLowerCase('uk-UA')
    )
      throw new MemoryOperationError(
        'Тут можна змінити ставлення до цього предмета. Нове вподобання додай у чаті, а старе за потреби прибери.',
        400,
      );
  }
  await runFactsSet(
    env,
    {
      ...address,
      value: body.value,
      source: 'owner_assertion',
      ...(body.renew ? { observed_at: new Date(nowMs).toISOString() } : {}),
    },
    nowMs,
    {
      actor: 'owner',
      expectedEventId: body.token,
      refreshValidity: body.renew,
      why: 'Власник виправив факт у Mini App',
    },
  );
  return { message: 'Факт оновлено.' };
}
