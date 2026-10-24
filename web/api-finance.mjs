import { MONO_RECONCILE_DO_NAME } from './core/mono-reconcile/contract.mjs';
import { refreshMonoAccount } from './core/finance/bank-refresh.mjs';
import { MonoTooSoonError } from './core/adapters/mono.mjs';
import { buildFinanceReport, validateReportRange } from './core/finance/reporting.mjs';
import {
  readFinanceAnalytics,
  readAnalyticsOperations,
  readAnalyticsMerchants,
} from './core/finance/analytics-store.mjs';
import { json, readJsonBody } from './http-core.mjs';
import { checkOwnerRead, checkPrimaryOwner, mutationInitData } from './auth-core.mjs';
import { synchronizePlanFinance } from './core/motivation/finance-link.mjs';
import { projectFinances } from './core/finance/projection.mjs';
import { MODEL_VERSION } from './core/finance/adaptive-model.mjs';
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
    if (!body && url.searchParams.get('view') === 'forecast') {
      const db = env.DB;
      if (!db) throw new Error('Finance database unavailable');
      const days = Number(url.searchParams.get('days') ?? 7);
      if (!Number.isInteger(days) || days < 1 || days > 93)
        throw new FinanceValidation('Обери від 1 до 93 днів прогнозу');
      const finance = await readFinanceWorkspace(env, nowMs);
      const bytes = new TextEncoder().encode(
        JSON.stringify([
          finance.version,
          finance.display,
          finance.forecast,
          finance.reserveMinor,
          finance.policies,
          finance.settlements,
          finance.accounts,
          finance.transactions,
          finance.taxiEntries,
          finance.goals,
          finance.goalMoves,
          finance.budgets,
          finance.payments,
        ]),
      );
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const source = Array.from(new Uint8Array(digest), (n) =>
        n.toString(16).padStart(2, '0'),
      ).join('');
      const key = `${MODEL_VERSION}:${source}:${days}:${Math.floor(nowMs / 3600000)}`;
      const cached = await db
        .prepare('SELECT result_json FROM finance_forecast_runs WHERE id = ?')
        .bind(key)
        .first();
      result = cached
        ? JSON.parse(String(cached.result_json))
        : projectFinances(finance, days, nowMs);
      if (!cached) {
        await db.batch([
          db
            .prepare(
              'INSERT INTO finance_forecast_runs(id,as_of,source_key,algorithm_version,horizon_days,result_json) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING',
            )
            .bind(
              key,
              new Date(nowMs).toISOString(),
              source,
              result.algorithmVersion,
              days,
              JSON.stringify(result),
            ),
          db
            .prepare(
              'DELETE FROM finance_forecast_runs WHERE id NOT IN (SELECT id FROM finance_forecast_runs ORDER BY as_of DESC LIMIT 5000)',
            )
            .bind(),
        ]);
      }
    } else if (
      !body &&
      ['analytics', 'analytics-operations', 'analytics-merchants'].includes(
        url.searchParams.get('view') ?? '',
      )
    ) {
      result =
        url.searchParams.get('view') === 'analytics'
          ? await readFinanceAnalytics(env, url.searchParams, nowMs)
          : url.searchParams.get('view') === 'analytics-merchants'
            ? await readAnalyticsMerchants(env, url.searchParams, nowMs)
            : await readAnalyticsOperations(env, url.searchParams, nowMs);
    } else if (body?.type === 'bank-refresh') {
      if (request.headers.get('X-Finance-Sync') === '2' && env.MONO_RECONCILE)
        await env.MONO_RECONCILE.getByName(MONO_RECONCILE_DO_NAME).requestRefresh(
          body.payload?.accountId,
          body.payload?.transactionId,
          nowMs,
        );
      else await refreshMonoAccount(env, body.payload?.accountId, nowMs);
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
    } else {
      result = body ? await executeFinanceCommand(env, body) : await readFinanceWorkspace(env);
      if (body?.type === 'credit-limit' && env.MONO_RECONCILE) {
        // The setting is saved even if starting its refresh fails; the response stays a success.
        try {
          await env.MONO_RECONCILE.getByName(MONO_RECONCILE_DO_NAME).requestRefresh(
            body.payload?.accountId,
            undefined,
            nowMs,
            true,
          );
        } catch {
          console.error('mono credit limit: refresh could not be started');
        }
        result = await readFinanceWorkspace(env, nowMs);
      }
    }
    if (body && ['taxi-entry', 'taxi-edit', 'taxi-delete'].includes(body.type)) {
      try {
        await synchronizePlanFinance(env, Date.now());
      } catch {
        console.error('plan finance reconciliation deferred');
      }
    }
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
      (error instanceof Error && /Некорект|Сума|Частка|Забагато операцій/.test(error.message))
    )
      return json({ ok: false, error: error.message }, 400);
    console.error('finance workspace unavailable', error instanceof Error ? error.name : 'unknown');
    return json(
      {
        ok: false,
        error: 'Фінанси тимчасово недоступні. Спробуй пізніше.',
      },
      503,
    );
  }
}
