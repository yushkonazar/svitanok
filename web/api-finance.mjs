import { json, readJsonBody } from './http-core.mjs';
import { checkOwnerRead, checkPrimaryOwner, mutationInitData } from './auth-core.mjs';
import {
  readFinanceWorkspace,
  executeFinanceCommand,
  FinanceConflict,
  FinanceValidation,
} from './core/finance/workspace.mjs';

/** @param {Request} request @param {Env} env */
export async function handleFinance(request, env) {
  if (!['GET', 'POST'].includes(request.method))
    return json({ ok: false, error: 'method-not-allowed' }, 405);
  const read = request.method === 'POST' ? await readJsonBody(request) : null;
  if (read && !read.ok) return json({ ok: false, error: read.error }, read.status);
  const body = read?.ok ? read.body : null;
  const auth = body
    ? await checkPrimaryOwner(mutationInitData(request, body), env)
    : await checkOwnerRead(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);
  try {
    const result = body ? await executeFinanceCommand(env, body) : await readFinanceWorkspace(env);
    const response = json(result);
    response.headers.set('cache-control', 'private, no-store');
    return response;
  } catch (error) {
    if (error instanceof FinanceConflict) return json({ ok: false, error: error.message }, 409);
    if (
      error instanceof FinanceValidation ||
      (error instanceof Error && /Некорект|Сума|Частка/.test(error.message))
    )
      return json({ ok: false, error: error.message }, 400);
    console.error('finance workspace unavailable', error instanceof Error ? error.name : 'unknown');
    return json(
      {
        ok: false,
        error: 'Фінанси тимчасово недоступні. Перевір локальну міграцію та спробуй знову.',
      },
      503,
    );
  }
}
