import { checkPrimaryOwner, mutationInitData } from './auth-core.mjs';
import { json, readJsonBody } from './http-core.mjs';
import { executePlanCommand, readPlanWorkspace } from './core/motivation/store.mjs';
import { PlanError } from './core/motivation/model.mjs';
import { suggestPlanDraft } from './core/motivation/draft.mjs';
import { planDate } from './core/motivation/model.mjs';
import { readCalendarRange } from './google.mjs';

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
    const url = new URL(request.url);
    if (body?.op === 'suggest')
      return reply({ ok: true, draft: await suggestPlanDraft(env, body.payload) });
    if (!body && url.searchParams.get('view') === 'calendar') {
      const date = planDate(url.searchParams.get('date'));
      const events = await readCalendarRange(env, date, date);
      if (events == null)
        return reply(
          { ok: false, error: 'Календар зараз недоступний. Перевір підключення Google.' },
          503,
        );
      return reply({ ok: true, events });
    }
    if (body) receipt = await executePlanCommand(env, body);
    return reply({
      ok: true,
      receipt,
      workspace: await readPlanWorkspace(env, Date.now(), {
        cursor: url.searchParams.get('cursor') ?? undefined,
      }),
    });
  } catch (error) {
    if (receipt) return reply({ ok: true, receipt, refreshRequired: true });
    if (body?.op === 'task-save' && error instanceof PlanError && error.field)
      console.warn('plan.task-timing-rejected', {
        field: error.field,
        commandId: /^[a-zA-Z0-9_-]{8,80}$/.test(body.commandId ?? '') ? body.commandId : null,
      });
    return reply(
      {
        ok: false,
        error:
          error instanceof PlanError
            ? error.message
            : 'План зараз недоступний. Збережені дані залишаються на місці.',
        ...(error instanceof PlanError && error.field ? { field: error.field } : {}),
      },
      error instanceof PlanError ? error.status : 503,
    );
  }
}
