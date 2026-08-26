// Маршрутизатор internal API (етап 1, PR-5): автентифікація + контракти.
// Самі виконавці приходять пізніше (tools - PR-6, deliver/status - PR-7,
// runs-телеметрія мозку - етап 2), тому валідні запити зараз чесно отримують
// 501 not-implemented - НЕ 404: сходинка «401 без підпису → 403 невідомий
// прогін → 501 валідний виклик» і є приймальною перевіркою цього PR.
//
// Порядок перевірок: прапорець → метод → розмір → підпис → run_id → контракт.
// Дешеве і зовнішнє - першим; жодна гілка не виконує роботи до підпису.

import { json } from '../../http-core.mjs';
import { verifyInternalRequest } from './auth.mjs';
import { registryHas } from '../run-registry/client.mjs';
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

  // Кап розміру ПЕРЕД читанням у памʼять: content-length бреше лише в менший
  // бік (Cloudflare звіряє), а фактичну довжину звіряємо ще раз після читання.
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_INTERNAL_BODY_BYTES) return json({ ok: false, error: 'body-too-large' }, 413);
  const bodyBytes = await request.arrayBuffer();
  if (bodyBytes.byteLength > MAX_INTERNAL_BODY_BYTES) {
    return json({ ok: false, error: 'body-too-large' }, 413);
  }
  const bodyText = new TextDecoder().decode(bodyBytes);

  const auth = await verifyInternalRequest({ headers: request.headers, bodyText, nowMs, env });
  if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);

  // Прогін мусить бути живим у RunRegistry (07 §3): підпис доводить «хто»,
  // run_id - «навіщо саме зараз». Збій реєстру = відмова, не пропуск.
  if (!(await registryHas(env, auth.runId))) {
    return json({ ok: false, error: 'run-unknown' }, 403);
  }

  /** @type {unknown} */
  let body;
  try {
    body = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    return json({ ok: false, error: 'bad-json' }, 400);
  }

  const path = new URL(request.url).pathname;
  const toolMatch = path.match(/^\/internal\/tool\/([a-z0-9._-]+)$/);
  if (toolMatch) {
    const contract = validateAgainst(TOOL_REQUEST_SCHEMA, body);
    if (!contract.ok) return json({ ok: false, error: `contract: ${contract.error}` }, 400);
    // Виконавці інструментів - PR-6; контракт і auth уже бойові.
    return json({ ok: false, error: 'not-implemented', tool: toolMatch[1] }, 501);
  }

  const route = path.match(/^\/internal\/(deliver|status|runs)$/)?.[1];
  if (route) {
    const contract = validateAgainst(ROUTE_SCHEMAS[route] ?? { type: 'object' }, body);
    if (!contract.ok) return json({ ok: false, error: `contract: ${contract.error}` }, 400);
    return json({ ok: false, error: 'not-implemented', route }, 501);
  }

  return json({ ok: false, error: 'not-found' }, 404);
}
