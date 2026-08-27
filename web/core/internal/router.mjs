// Маршрутизатор internal API (етап 1, PR-5): автентифікація + контракти.
// Самі виконавці приходять пізніше (tools - PR-6, deliver/status - PR-7,
// runs-телеметрія мозку - етап 2), тому валідні запити зараз чесно отримують
// 501 not-implemented - НЕ 404: сходинка «401 без підпису → 403 невідомий
// прогін → 501 валідний виклик» і є приймальною перевіркою цього PR.
//
// Порядок перевірок: прапорець → метод → розмір → підпис → run_id → контракт.
// Дешеве і зовнішнє - першим; жодна гілка не виконує роботи до підпису.

import { json, readCappedBody } from '../../http-core.mjs';
import { verifyInternalRequest, INTERNAL_SIG_TTL_MS } from './auth.mjs';
import { registryHas, registryConsumeNonce } from '../run-registry/client.mjs';
import {
  TOOL_REQUEST_SCHEMA,
  DELIVER_SCHEMA,
  STATUS_SCHEMA,
  RUNS_SCHEMA,
  validateAgainst,
} from './schemas.mjs';

/** Кап тіла: найбільше з контрактів - deliver ≤ 64К тексту; з запасом на JSON.
 *  Публічний ендпоїнт без ліміту розміру - відкриті двері, тож кап ДО читання. */
export const MAX_INTERNAL_BODY_BYTES = 128 * 1024;

/** @type {Record<string, import('./schemas.mjs').InternalSchema>} */
const ROUTE_SCHEMAS = {
  deliver: DELIVER_SCHEMA,
  status: STATUS_SCHEMA,
  runs: RUNS_SCHEMA,
};

/**
 * POST /internal/* - усі відповіді JSON, помилки з явною причиною.
 * @param {Request} request
 * @param {Env} env
 * @param {number} [nowMs]
 */
export async function handleInternal(request, env, nowMs = Date.now()) {
  // off: коду «не існує» - та сама відповідь, що на будь-який невідомий шлях.
  if (env.ASSISTANT_V2 !== 'shadow' && env.ASSISTANT_V2 !== 'on') {
    return json({ ok: false, error: 'not-found' }, 404);
  }
  if (request.method !== 'POST') return json({ ok: false, error: 'method-not-allowed' }, 405);

  // Кап розміру: content-length — дешевий ранній відсів, але вірити йому не
  // можна (на chunked/HTTP2 його просто немає), тож читання — ЛИШЕ потоком зі
  // стелею (readCappedBody рве стрім на першому байті понад кап). Інакше
  // atacker без підпису змушував би матеріалізувати мегабайти ДО криптографії.
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_INTERNAL_BODY_BYTES) {
    return json({ ok: false, error: 'body-too-large' }, 413);
  }
  const read = await readCappedBody(request, MAX_INTERNAL_BODY_BYTES);
  if (!read.ok) {
    return read.tooLarge
      ? json({ ok: false, error: 'body-too-large' }, 413)
      : json({ ok: false, error: 'no-body' }, 400);
  }
  const bodyText = read.raw;

  const path = new URL(request.url).pathname;
  const auth = await verifyInternalRequest({
    method: request.method,
    path,
    headers: request.headers,
    bodyText,
    nowMs,
    env,
  });
  if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);

  // Прогін мусить бути живим у RunRegistry (07 §3): підпис доводить «хто»,
  // run_id - «навіщо саме зараз». Збій реєстру = відмова, не пропуск.
  if (!(await registryHas(env, auth.runId))) {
    return json({ ok: false, error: 'run-unknown' }, 403);
  }
  // Nonce споживається ПІСЛЯ підпису й run_id (інакше атакер без ключа міг би
  // «випалювати» чужі nonce) і ПЕРЕД будь-якою роботою: повтор підписаного
  // запиту в вікні TTL — реплей, а не друга дія. Памʼять — 2×TTL: доки підпис
  // узагалі міг би пройти, память про nonce мусить жити.
  if (!(await registryConsumeNonce(env, auth.runId, auth.nonce, nowMs, 2 * INTERNAL_SIG_TTL_MS))) {
    return json({ ok: false, error: 'replayed' }, 401);
  }

  /** @type {unknown} */
  let body;
  try {
    body = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    return json({ ok: false, error: 'bad-json' }, 400);
  }

  const toolMatch = path.match(/^\/internal\/tool\/([a-z0-9._-]+)$/);
  if (toolMatch) {
    const contract = validateAgainst(TOOL_REQUEST_SCHEMA, body);
    if (!contract.ok) return json({ ok: false, error: `contract: ${contract.error}` }, 400);
    // Виконавці інструментів - PR-6; контракт і auth уже бойові.
    return json({ ok: false, error: 'not-implemented', tool: toolMatch[1] }, 501);
  }

  const route = path.match(/^\/internal\/(deliver|status|runs)$/)?.[1];
  if (route) {
    const schema = ROUTE_SCHEMAS[route];
    // Регекс розширили, а схему забули — гучний 500, не мовчазний пропуск
    // повз контракт (перманентний ?? {type:'object'} саме це й маскував би).
    if (!schema) return json({ ok: false, error: 'no-contract' }, 500);
    const contract = validateAgainst(schema, body);
    if (!contract.ok) return json({ ok: false, error: `contract: ${contract.error}` }, 400);
    return json({ ok: false, error: 'not-implemented', route }, 501);
  }

  return json({ ok: false, error: 'not-found' }, 404);
}
