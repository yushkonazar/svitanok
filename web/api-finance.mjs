import { refreshMonoAccount } from './core/finance/bank-refresh.mjs';
import { MonoTooSoonError } from './core/adapters/mono.mjs';
import { buildFinanceReport, validateReportRange } from './core/finance/reporting.mjs';
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
    const nowMs = Date.now();
    const url = new URL(request.url);
    const from = url.searchParams.get('from'),
      to = url.searchParams.get('to');
    let result;
    if (body?.type === 'bank-refresh') {
      await refreshMonoAccount(env, body.payload?.accountId, nowMs);
      result = await readFinanceWorkspace(env, nowMs);
    } else if (!body && (from != null || to != null)) {
      if (!from || !to) throw new FinanceValidation('Вкажи початок і кінець періоду');
      validateReportRange(from, to, nowMs);
      result = buildFinanceReport(
        await readFinanceWorkspace(env, nowMs, { from, to }),
        from,
        to,
        nowMs,
      );
    } else result = body ? await executeFinanceCommand(env, body) : await readFinanceWorkspace(env);
    const response = json(result);
    response.headers.set('cache-control', 'private, no-store');
    return response;
  } catch (error) {
    if (error instanceof MonoTooSoonError) {
      const response = json(
        {
          ok: false,
          error: 'Monobank дозволяє оновлення раз на хвилину. Спробуй через 60 секунд.',
        },
        429,
      );
      response.headers.set('Retry-After', '60');
      return response;
    }
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
