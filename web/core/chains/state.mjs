// Спільне для ланцюгів (07 §6): стан рядка `chains`, очікування події з
// таймаутом, адреса доставки і відправка повідомлення власнику.
//
// Жили в day-plan/chain.mjs; другий ланцюг (аналіз ідеї, етап 4) скопіював би
// їх байт у байт. Етап 5 додав ще три ланцюги, і `chainTarget`, `class
// Cancelled`, `db(env)` та пара «enqueue + драйн» розповзлися по table/price/
// trip копіями. Етап 6 зводить їх сюди: різні ланцюги - однакова адресація,
// однакова доставка, однакова відмова.
//
// Єдиний записувач state_json - patchChainState (json_patch: null у патчі
// стирає ключ), setChainState виражено через нього.

import { enqueueOutbox, drainOutbox } from '../tg/outbox.mjs';

/** @param {Env} env */
export function db(env) {
  if (!env.DB) throw new Error('привʼязки DB немає');
  return env.DB;
}

/**
 * Скасування ланцюга зсередини машини станів. Один клас на всі ланцюги: у
 * table і trip лежали дві однакові порожні заглушки, і `instanceof` між ними
 * не працював би, якби крок одного ланцюга колись покликав інший.
 */
export class Cancelled extends Error {}

/**
 * Адреса доставки ланцюга: чат/тред старту (стан), DM - особистий чат
 * власника. Один розрахунок для машини станів і chain-nudge.
 * @param {Env} env @param {{ chat_id?: number | string | null, thread_id?: string | null }} state
 * @returns {{ chatId: string, threadId: string | null }}
 */
export function chainTarget(env, state) {
  const isDm = state.thread_id === 'dm';
  const chatId =
    state.chat_id ?? (isDm ? (env.TELEGRAM_OWNER_USER_ID ?? null) : (env.TELEGRAM_CHAT_ID ?? null));
  if (chatId == null)
    throw new Error('немає чату для ланцюга (TELEGRAM_CHAT_ID / контекст старту)');
  const threadId = isDm ? null : (state.thread_id ?? env.TOPIC_ASSISTANT ?? null);
  return { chatId: String(chatId), threadId: threadId == null ? null : String(threadId) };
}

/**
 * Покласти повідомлення ланцюга в чергу і одразу драйнити. Драйн - best-effort:
 * його збій не має валити крок Workflow (черга лишається, добере sweeper), і
 * саме тому він тут, а не в кожному io окремо.
 * @param {Env} env
 * @param {{ chatId: string, threadId: string | null }} target
 * @param {{ kind: 'send' | 'contact' | 'venue' | 'document', payload: Record<string, unknown>,
 *   buttons?: unknown, parts?: import('../tg/markdown.mjs').MdPart[], label?: string }} msg
 */
export async function postChainMessage(env, target, msg) {
  await enqueueOutbox(
    env,
    {
      chatId: target.chatId,
      threadId: target.threadId,
      kind: msg.kind,
      payload: {
        ...msg.payload,
        ...(msg.buttons ? { reply_markup: { inline_keyboard: msg.buttons } } : {}),
      },
      ...(msg.parts ? { parts: msg.parts } : {}),
    },
    Date.now(),
  );
  await drainOutbox(env, { nowMs: Date.now() }).catch((/** @type {any} */ e) => {
    console.error(`${msg.label ?? 'chain'}: драйн outbox впав, доставить sweeper`, e?.message);
  });
}

/**
 * Часткове оновлення state_json (json_patch) + статус одним UPDATE, щоб
 * паралельний записувач (chain-nudge) не затер поле. `unlessCancelled` -
 * не чіпати рядок, який уже cancelled (chain.cancel без доставленої події):
 * тоді повертає false, і машина станів зобовʼязана зупинитись.
 * @param {Env} env @param {string} chainId
 * @param {'running' | 'waiting' | 'done' | 'failed' | 'cancelled'} status
 * @param {Record<string, unknown>} patch
 * @param {{ unlessCancelled?: boolean, nowMs?: number }} [opts]
 * @returns {Promise<boolean>} true - рядок оновлено
 */
export async function patchChainState(env, chainId, status, patch, opts = {}) {
  const { meta } = await db(env)
    .prepare(
      `UPDATE chains SET status = ?, state_json = json_patch(COALESCE(state_json, '{}'), ?), updated_at = ?
       WHERE id = ?${opts.unlessCancelled ? " AND status != 'cancelled'" : ''}`,
    )
    .bind(status, JSON.stringify(patch), new Date(opts.nowMs ?? Date.now()).toISOString(), chainId)
    .run();
  return Boolean(meta?.changes);
}

/**
 * Стан ланцюга: статус + `$.awaiting` у state_json (що саме чекає від
 * власника; null - нічого) і `$.awaiting_since` - коли почав чекати (реєстр
 * ланцюгів віддає текст власника тому, хто спитав останнім).
 * @param {Env} env @param {string} chainId
 * @param {{ status: 'running' | 'waiting' | 'done' | 'failed' | 'cancelled', awaiting: string | null }} state
 */
export async function setChainState(env, chainId, state) {
  const nowMs = Date.now();
  await patchChainState(
    env,
    chainId,
    state.status,
    {
      awaiting: state.awaiting,
      awaiting_since: state.awaiting == null ? null : new Date(nowMs).toISOString(),
    },
    { nowMs },
  );
}

/**
 * Статус і розібраний state_json ланцюга; null - рядка немає.
 * @param {Env} env @param {string} chainId
 * @returns {Promise<{ status: string, state: Record<string, any> } | null>}
 */
export async function readChainState(env, chainId) {
  const row = /** @type {{ status: string, state_json: string | null } | null} */ (
    await db(env)
      .prepare('SELECT status, state_json FROM chains WHERE id = ?')
      .bind(chainId)
      .first()
  );
  if (!row) return null;
  /** @type {Record<string, any>} */
  let state;
  try {
    state = row.state_json ? JSON.parse(row.state_json) : {};
  } catch {
    state = {};
  }
  return { status: String(row.status), state };
}

/**
 * Очікування події з таймаутом: у Workflows таймаут кидає - тут це чесний
 * null (тиша - штатний шлях сценарію, не збій).
 * @param {{ waitForEvent: (name: string, opts: { type: string, timeout: string }) => Promise<{ payload: any }> }} step
 * @param {string} name @param {string} type @param {number} ms
 */
export async function waitOrNull(step, name, type, ms) {
  try {
    const ev = await step.waitForEvent(name, {
      type,
      timeout: `${Math.max(1, Math.ceil(ms / 1000))} seconds`,
    });
    return ev?.payload ?? null;
  } catch {
    return null;
  }
}
