// Маршрутизатор internal API (етап 1, PR-5 auth + PR-6 tools): інструменти
// /internal/tool/* виконуються з реєстру core/tools; deliver/status (PR-7) і
// runs-телеметрія мозку (етап 2) поки чесно відповідають 501 not-implemented.
//
// Порядок перевірок: прапорець → метод → розмір → підпис → run_id → nonce →
// контракт → виконання. Дешеве і зовнішнє - першим; жодна гілка не виконує
// роботи до підпису.

import { json, readCappedBody } from '../../http-core.mjs';
import { verifyInternalRequest, INTERNAL_SIG_TTL_MS } from './auth.mjs';
import { registryHas, registryConsumeNonce, registryRunInfo } from '../run-registry/client.mjs';
import { TOOLS } from '../tools/index.mjs';
import { enqueueOutbox, drainOutbox, dropPendingEdits } from '../tg/outbox.mjs';
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
    const name = /** @type {string} */ (toolMatch[1]);
    const tool = TOOLS[name];
    if (!tool) return json({ ok: false, error: 'tool-unknown', tool: name }, 404);
    const envelope = validateAgainst(TOOL_REQUEST_SCHEMA, body);
    if (!envelope.ok) return json({ ok: false, error: `contract: ${envelope.error}` }, 400);
    const args = /** @type {{ args: Record<string, unknown> }} */ (body).args;
    const contract = validateAgainst(tool.args, args);
    if (!contract.ok) return json({ ok: false, error: `contract: ${contract.error}` }, 400);

    /** @type {{ result: unknown }} */
    let out;
    try {
      out = await tool.run(env, args, nowMs);
    } catch (/** @type {any} */ e) {
      // Збій джерела - явний 502 із причиною, не тиха деградація і не 500-стек.
      console.error(`internal: інструмент ${name} впав`, e?.message);
      return json(
        { ok: false, error: 'tool-failed', tool: name, reason: String(e?.message ?? '') },
        502,
      );
    }

    // Подвійний барʼєр (01 §4.2), половина ядра: після tainting-інструмента
    // тред прогону позначається в sessions.tainted - навіть якщо хук мозку
    // обійдено, policy (PR-8) побачить прапорець тут. FAIL-CLOSED: якщо
    // прапорець НЕ вдалось персистувати, зовнішній вміст не віддається -
    // інакше транзієнтний збій DO/D1 давав би прогін із зовнішнім вмістом,
    // який policy вважатиме чистим.
    if (tool.tainting && !(await markRunThreadTainted(env, auth.runId, nowMs))) {
      return json({ ok: false, error: 'taint-not-persisted', tool: name }, 503);
    }

    return json({ ok: true, tool: name, tainted: Boolean(tool.tainting), result: out.result });
  }

  const route = path.match(/^\/internal\/(deliver|status|runs)$/)?.[1];
  if (route) {
    const schema = ROUTE_SCHEMAS[route];
    // Регекс розширили, а схему забули — гучний 500, не мовчазний пропуск
    // повз контракт (перманентний ?? {type:'object'} саме це й маскував би).
    if (!schema) return json({ ok: false, error: 'no-contract' }, 500);
    const contract = validateAgainst(schema, body);
    if (!contract.ok) return json({ ok: false, error: `contract: ${contract.error}` }, 400);
    if (route === 'deliver')
      return handleDeliver(env, auth.runId, /** @type {any} */ (body), nowMs);
    if (route === 'status') return handleStatus(env, /** @type {any} */ (body), nowMs);
    // runs-телеметрія мозку - етап 2 (RunRegistry вже вміє, бракує викликача).
    return json({ ok: false, error: 'not-implemented', route }, 501);
  }

  return json({ ok: false, error: 'not-found' }, 404);
}

/**
 * Фінальна відповідь прогону (07 §3): Rich message (HTML + кнопки) у тему
 * прогону через outbox. Довший за стелю Telegram текст розбивається на
 * частини ще в enqueue; кнопки їдуть на останній. Драйн - одразу (відповідь
 * мозку чекає доставки; пауза між частинами ~1 с - прийнятно), ретраї 429 -
 * sweeper планувальника.
 * @param {Env} env
 * @param {string} runId
 * @param {{ text: string, buttons?: { text: string, callback_data: string }[][] }} body
 * @param {number} nowMs
 */
async function handleDeliver(env, runId, body, nowMs) {
  if (!env.TELEGRAM_CHAT_ID) return json({ ok: false, error: 'chat-not-configured' }, 500);
  const info = await registryRunInfo(env, runId);
  const threadId = info?.threadId ?? env.TOPIC_ASSISTANT ?? null;
  const { queued } = await enqueueOutbox(
    env,
    {
      chatId: env.TELEGRAM_CHAT_ID,
      threadId,
      kind: 'send',
      payload: {
        text: body.text,
        parse_mode: 'HTML',
        ...(body.buttons ? { reply_markup: { inline_keyboard: body.buttons } } : {}),
      },
    },
    nowMs,
  );
  const drained = await drainOutbox(env, { nowMs });
  return json({ ok: true, queued, ...drained });
}

/**
 * Оновлення статус-повідомлення (07 §3): незіслані edit-и того ж message_id
 * заміняються новішим - це і є троттлінг до фактичної швидкості відправки.
 * @param {Env} env
 * @param {{ message_id: number, text: string }} body
 * @param {number} nowMs
 */
async function handleStatus(env, body, nowMs) {
  if (!env.TELEGRAM_CHAT_ID) return json({ ok: false, error: 'chat-not-configured' }, 500);
  await dropPendingEdits(env, env.TELEGRAM_CHAT_ID, body.message_id);
  const { queued } = await enqueueOutbox(
    env,
    {
      chatId: env.TELEGRAM_CHAT_ID,
      kind: 'edit',
      payload: { message_id: body.message_id, text: body.text },
    },
    nowMs,
  );
  const drained = await drainOutbox(env, { nowMs });
  return json({ ok: true, queued, ...drained });
}

/**
 * Половина подвійного барʼєра, що живе в ядрі (01 §4.2): тред прогону, який
 * прочитав зовнішнє, позначається в D1 sessions.tainted=1 - policy (PR-8)
 * дивитиметься СЮДИ, а не вірити хуку мозку. Повертає true лише коли прапорець
 * СПРАВДІ персистовано - викликач на false відмовляє у видачі зовнішнього
 * вмісту (fail-closed), тому кожен зрив тут і гучний, і не тихо-пропущений.
 * @param {Env} env
 * @param {string} runId
 * @param {number} nowMs
 */
async function markRunThreadTainted(env, runId, nowMs) {
  try {
    const info = await registryRunInfo(env, runId);
    const threadId = info?.threadId;
    if (threadId == null) {
      console.error(`internal: прогін ${runId} без threadId - taint не записано в sessions`);
      return false;
    }
    if (!env.DB) {
      console.error('internal: привʼязки DB немає - taint не записано в sessions');
      return false;
    }
    const iso = new Date(nowMs).toISOString();
    await env.DB.prepare(
      `INSERT INTO sessions (thread_id, started_at, last_at, tainted, turn_count)
       VALUES (?, ?, ?, 1, 0)
       ON CONFLICT (thread_id) DO UPDATE SET tainted = 1, last_at = excluded.last_at`,
    )
      .bind(String(threadId), iso, iso)
      .run();
    return true;
  } catch (/** @type {any} */ e) {
    console.error('internal: запис taint у sessions впав', e?.message);
    return false;
  }
}
