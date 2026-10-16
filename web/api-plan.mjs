import { checkPrimaryOwner, mutationInitData } from './auth-core.mjs';
import { json, readJsonBody } from './http-core.mjs';
import { executePlanCommand, readPlanWorkspace } from './core/motivation/store.mjs';
import { PlanError } from './core/motivation/model.mjs';

/** @param {Request} request @param {Env} env */
export async function handlePlan(request, env) {
  const reply = (/** @type {unknown} */ body, status = 200) => {
    const response = json(body, status);
    response.headers.set('cache-control', 'private, no-store');
    return response;
  };
  if (!['GET', 'POST'].includes(request.method))
    return reply({ ok: false, error: 'method-not-allowed' }, 405);
  const parsed = request.method === 'POST' ? await readJsonBody(request) : null;
  if (parsed && !parsed.ok) return reply({ ok: false, error: parsed.error }, parsed.status);
  const body = parsed?.ok ? parsed.body : null;
  const auth = await checkPrimaryOwner(mutationInitData(request, body), env);
  if (!auth.ok) return reply({ ok: false, error: auth.error }, auth.status);
  let receipt;
  try {
    if (body) receipt = await executePlanCommand(env, body);
    return reply({ ok: true, receipt, workspace: await readPlanWorkspace(env) });
  } catch (error) {
    if (receipt) return reply({ ok: true, receipt, refreshRequired: true });
    return reply(
      {
        ok: false,
        error:
          error instanceof PlanError
            ? error.message
            : 'План зараз недоступний. Збережені дані залишаються на місці.',
      },
      error instanceof PlanError ? error.status : 503,
    );
  }
}
