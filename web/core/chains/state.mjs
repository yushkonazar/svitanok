// Спільне для ланцюгів (07 §6): стан рядка `chains` і очікування події з
// таймаутом. Жили в day-plan/chain.mjs; другий ланцюг (аналіз ідеї, етап 4)
// скопіював би їх байт у байт - тепер один модуль без платформних імпортів.
// Етап 5: єдиний записувач state_json - patchChainState (json_patch: null у
// патчі стирає ключ), setChainState виражено через нього.

/** @param {Env} env */
function db(env) {
  if (!env.DB) throw new Error('привʼязки DB немає');
  return env.DB;
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
