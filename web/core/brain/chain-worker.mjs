// Прогін працівника ланцюгу в мозку (етап 3 day-planner, етап 5 price-check):
// інструкція з D1, прогін у RunRegistry (trigger workflow), /run профілю з
// JSON-задачею; результат повертається подією `worker` у Workflow через
// /internal/runs outcome.chain. Спільне місце замість копій у кожному ланцюзі.
// Інструкції немає або мозок відмовив - false і лог; ланцюг сам вирішує, що
// робити без працівника (резерв або пропуск дня), тиші не буває.

import { registryBegin, registryFinish } from '../run-registry/client.mjs';
import { callBrainRun } from './run-client.mjs';
import { loadInstruction } from '../instructions.mjs';

/**
 * @param {Env} env
 * @param {{ profile: 'day-planner' | 'price-check', instruction: string, model: string,
 *   input: Record<string, unknown>, staleMs?: number, log: string }} req
 * @param {number} nowMs
 */
export async function startChainWorkerRun(env, req, nowMs) {
  let instruction;
  try {
    const loaded = await loadInstruction(env, req.instruction);
    instruction = { name: loaded.name, version_hash: loaded.hash, body_md: loaded.body };
  } catch (/** @type {any} */ e) {
    console.error(`${req.log}: інструкція ${req.instruction} недоступна`, e?.message);
    return false;
  }
  const runId = crypto.randomUUID();
  const threadId = env.TOPIC_ASSISTANT ? String(env.TOPIC_ASSISTANT) : 'dm';
  const registered = await registryBegin(env, {
    id: runId,
    trigger: 'workflow',
    profile: req.profile,
    threadId,
    chatId: env.TELEGRAM_CHAT_ID ? Number(env.TELEGRAM_CHAT_ID) : null,
    model: req.model,
    startedMs: nowMs,
    ...(req.staleMs ? { staleMs: req.staleMs } : {}),
  });
  if (!registered) {
    console.error(`${req.log}: RunRegistry недоступний — працівник не стартував`);
    return false;
  }
  const res = await callBrainRun(
    env,
    {
      instruction,
      runId,
      profile: req.profile,
      threadId,
      chatId: env.TELEGRAM_CHAT_ID ?? null,
      inputText: JSON.stringify(req.input),
    },
    nowMs,
  );
  if (res.ok) return true;
  console.error(`${req.log}: працівник не стартував (${res.status} ${res.detail})`);
  await registryFinish(env, runId, { finishedMs: nowMs, error: `brain-start: ${res.status}` });
  return false;
}
