// GET /api/assistant-status (етап 1, PR-10): стан планувальника, активні
// прогони і квоти одним запитом - те, чим проходиться приймальний чеклист
// етапу («/status показує планувальник і задачі з часом останнього тіку»).
// Auth - той самий initData власника, що в решти приватних /api/*; при
// ASSISTANT_V2=off - 404, як і весь новий шлях.

import { json } from '../http-core.mjs';
import { checkOwnerRead } from '../auth-core.mjs';
import { SCHEDULER_DO_NAME } from './scheduler/do.mjs';
import { RUN_REGISTRY_DO_NAME } from './run-registry/client.mjs';
import { readQuotas } from './quota/quota.mjs';
import { readRunDashboard } from './ops/run-dashboard.mjs';
import { readDeliverySlo } from './ops/delivery-slo.mjs';

/**
 * @param {Request} request
 * @param {Env} env
 */
export async function handleAssistantStatus(request, env) {
  if (env.ASSISTANT_V2 !== 'shadow' && env.ASSISTANT_V2 !== 'on') {
    return json({ ok: false, error: 'not-found' }, 404);
  }
  const auth = await checkOwnerRead(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);

  // Кожен блок збирається окремо: відсутня привʼязка чи збій одного не має
  // ховати решту картини - у блоці буде явний error замість даних.
  const [scheduler, registry, quotas, dashboard, delivery] = await Promise.all([
    section(() => {
      const ns = env.SCHEDULER;
      if (typeof ns?.getByName !== 'function') throw new Error('SCHEDULER не привʼязано');
      return ns.getByName(SCHEDULER_DO_NAME).status();
    }),
    section(() => {
      const ns = env.RUN_REGISTRY;
      if (typeof ns?.getByName !== 'function') throw new Error('RUN_REGISTRY не привʼязано');
      return ns.getByName(RUN_REGISTRY_DO_NAME).snapshot();
    }),
    section(() => readQuotas(env)),
    section(() => readRunDashboard(env)),
    section(() => readDeliverySlo(env)),
  ]);

  return json({
    ok: true,
    mode: env.ASSISTANT_V2,
    scheduler,
    registry,
    quotas,
    dashboard,
    delivery,
  });
}

/** @param {() => Promise<unknown> | unknown} fn */
async function section(fn) {
  try {
    return await fn();
  } catch (/** @type {any} */ e) {
    return { error: String(e?.message ?? 'збій') };
  }
}
