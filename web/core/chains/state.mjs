// Спільне для ланцюгів (07 §6): стан рядка `chains` і очікування події з
// таймаутом. Жили в day-plan/chain.mjs; другий ланцюг (аналіз ідеї, етап 4)
// скопіював би їх байт у байт - тепер один модуль без платформних імпортів.

/** @param {Env} env */
function db(env) {
  if (!env.DB) throw new Error('привʼязки DB немає');
  return env.DB;
}

/**
 * Стан ланцюга: статус + `$.awaiting` у state_json (що саме чекає від
 * власника; null - нічого).
 * @param {Env} env @param {string} chainId
 * @param {{ status: 'running' | 'waiting' | 'done' | 'failed' | 'cancelled', awaiting: string | null }} state
 */
export async function setChainState(env, chainId, state) {
  await db(env)
    .prepare(
      `UPDATE chains SET status = ?, state_json = json_set(COALESCE(state_json, '{}'), '$.awaiting', ?), updated_at = ? WHERE id = ?`,
    )
    .bind(state.status, state.awaiting, new Date().toISOString(), chainId)
    .run();
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
