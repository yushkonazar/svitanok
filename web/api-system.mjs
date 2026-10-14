import { checkPrimaryOwner, mutationInitData } from './auth-core.mjs';
import { json, readJsonBody } from './http-core.mjs';
import { readRunDashboard, parseModelTelemetry } from './core/ops/run-dashboard.mjs';
import { brainHealthSnapshot } from './core/brain/health.mjs';
import { readQuotas, quotaPeriod } from './core/quota/quota.mjs';
import { readDeliverySlo } from './core/ops/delivery-slo.mjs';
import { SCHEDULER_DO_NAME } from './core/scheduler/do.mjs';
import { RUN_REGISTRY_DO_NAME } from './core/run-registry/client.mjs';
import { systemPeriod } from './core/ops/system-period.mjs';
import { readUsageLedger } from './core/ops/usage-ledger.mjs';
import { readSystemServices } from './core/ops/system-services.mjs';
import { readSystemBilling, refreshSystemBilling } from './core/ops/system-billing.mjs';
import { readSystemPreferences, saveSystemPreferences } from './core/ops/system-preferences.mjs';

/** Private primary-owner administrative view. Opening it makes no model/API
 * billing calls. Section failures are isolated; raw provider errors and payloads
 * never reach the client. @param {Request} request @param {Env} env */
export async function handleSystem(request, env) {
  const reply = (/** @type {unknown} */ data, status = 200) => {
    const response = json(data, status);
    response.headers.set('cache-control', 'private, no-store');
    return response;
  };
  const auth = await checkPrimaryOwner(mutationInitData(request, null), env);
  if (!auth.ok) return reply({ ok: false, error: auth.error }, auth.status);
  const nowMs = Date.now();
  const url = new URL(request.url);
  let period;
  try {
    period = systemPeriod(url.searchParams, nowMs);
  } catch {
    return reply({ ok: false, error: 'invalid-period' }, 400);
  }
  if (request.method === 'POST') {
    const body = await readJsonBody(request);
    if (!body.ok) return reply({ ok: false, error: 'invalid-body' }, 400);
    if (body.body?.action === 'billing-refresh' && typeof body.body.provider === 'string') {
      const result = await refreshSystemBilling(env, body.body.provider, period, nowMs);
      return reply(result, result.ok ? 200 : result.error === 'cooldown' ? 429 : 400);
    }
    if (body.body?.action === 'budgets') {
      const result = await saveSystemPreferences(env, body.body, nowMs);
      return reply(result, result.ok ? 200 : result.error === 'conflict' ? 409 : 400);
    }
    return reply({ ok: false, error: 'invalid-action' }, 400);
  }
  if (request.method !== 'GET') return reply({ ok: false, error: 'method-not-allowed' }, 405);
  const before = url.searchParams.get('before');
  if (before && !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\|[A-Za-z0-9:_-]{1,80}$/.test(before))
    return reply({ ok: false, error: 'invalid-cursor' }, 400);
  const legacy = !url.searchParams.has('range');
  const cacheKey = `systemSnapshot:v2:${legacy ? 'legacy' : period.range}:${period.from}:${period.to}:${before ?? ''}`;
  /** @type {any} */ let previous = null;
  try {
    const raw = await env.BRIEFING.get(cacheKey);
    previous = raw ? JSON.parse(raw) : null;
  } catch {
    /* Read current metadata instead. */
  }
  if (
    url.searchParams.get('refresh') !== '1' &&
    previous &&
    nowMs - Date.parse(previous.generatedAt) < 45000
  )
    return reply(previous);
  const [
    runs,
    usage,
    quotas,
    delivery,
    scheduler,
    registry,
    brain,
    services,
    billing,
    preferences,
    legacyModels,
  ] = await Promise.all([
    section(async () => {
      const data = await readRunDashboard(env, { ...period, ...(before ? { before } : {}) });
      return {
        ...data,
        recent: data.recent.map((run) => ({
          ...run,
          error: run.error ? 'Технічний збій; деталі перевір у журналi адміністратора.' : null,
          cost: null,
          response_id: null,
        })),
      };
    }),
    section(() => readUsageLedger(env, period)),
    section(() => readQuotas(env, nowMs)),
    section(() => readDeliverySlo(env, nowMs)),
    section(async () => {
      if (!env.SCHEDULER) throw new Error('unavailable');
      const data = await env.SCHEDULER.getByName(SCHEDULER_DO_NAME).status();
      return {
        lastTick: data.lastTick,
        scheduled: data.jobs.length,
        watchdogRescues: data.watchdogRescues,
      };
    }),
    section(async () => {
      if (!env.RUN_REGISTRY) throw new Error('unavailable');
      const data = await env.RUN_REGISTRY.getByName(RUN_REGISTRY_DO_NAME).snapshot();
      return {
        active: Array.isArray(data.active)
          ? data.active.length
          : Object.keys(data.active ?? {}).length,
      };
    }),
    section(async () => {
      const observed = await brainHealthSnapshot(env, nowMs);
      return {
        state: observed.state,
        checkedAtMs: 'checkedAtMs' in observed ? (observed.checkedAtMs ?? null) : null,
        modelState: observed.modelReadiness?.state ?? 'unknown',
      };
    }),
    section(() => readSystemServices(env, nowMs)),
    readSystemBilling(env, period),
    section(() => readSystemPreferences(env)),
    legacy ? section(() => readModelUsage(env, nowMs)) : null,
  ]);
  const snapshot = {
    ok: true,
    generatedAt: new Date(nowMs).toISOString(),
    period: quotaPeriod(nowMs),
    mode: env.ASSISTANT_V2 ?? 'off',
    runs,
    // Preserve rolling 30-day model totals for clients predating selected periods.
    models: legacyModels ?? {
      available: usage.available,
      data: usage.data
        ? {
            since: period.since,
            truncated: usage.data.legacyTruncated,
            items: modelsFromUsage(usage.data.items),
          }
        : null,
    },
    selection: period,
    usage,
    services,
    preferences,
    quotas,
    delivery,
    scheduler,
    registry,
    brain,
    deployment: env.CF_VERSION_METADATA?.id ?? null,
    billing,
  };
  for (const key of [
    'runs',
    'usage',
    'models',
    'quotas',
    'delivery',
    'scheduler',
    'registry',
    'brain',
    'services',
    'preferences',
  ]) {
    const current = /** @type {any} */ (snapshot)[key];
    if (!current.available && previous?.[key]?.data != null) {
      Object.assign(current, {
        data: previous[key].data,
        cached: true,
        checkedAt: previous[key].checkedAt ?? previous.generatedAt,
      });
    } else if (current.available) current.checkedAt = snapshot.generatedAt;
  }
  try {
    await env.BRIEFING.put(cacheKey, JSON.stringify(snapshot), { expirationTtl: 3600 });
  } catch {
    /* Cache does not affect availability. */
  }
  return reply(snapshot);
}
/** Compatibility projection has one row per model (and separate shadow calls),
 * even when several features use the same model. @param {any[]} items */
function modelsFromUsage(items) {
  /** @type {Map<string, any>} */ const groups = new Map();
  for (const item of items) {
    if (!['openai', 'claude'].includes(item.provider)) continue;
    const shadow = item.feature === 'comparison';
    const model = `${shadow ? 'shadow:' : ''}${item.provider}:${item.sku}`;
    const row = groups.get(model) ?? {
      model,
      calls: 0,
      knownCostCalls: 0,
      knownUsageCalls: 0,
      costUsd: null,
      inputTokens: null,
      outputTokens: null,
      shadow,
    };
    row.calls += item.records;
    row.knownCostCalls += item.knownCosts;
    row.knownUsageCalls += Math.min(item.knownInput, item.knownOutput);
    for (const key of ['costUsd', 'inputTokens', 'outputTokens'])
      if (item[key] != null) row[key] = (row[key] ?? 0) + item[key];
    groups.set(model, row);
  }
  return [...groups.values()].sort((a, b) => b.calls - a.calls);
}
/** @template T @param {() => Promise<T>} fn */
async function section(fn) {
  try {
    return { available: true, data: await fn() };
  } catch {
    return { available: false, data: null, reason: 'read-failed' };
  }
}
/** @param {Env} env @param {number} nowMs */
export async function readModelUsage(env, nowMs) {
  if (!env.DB) throw new Error('unavailable');
  const since = new Date(nowMs - 30 * 86400000).toISOString();
  const rows =
    (
      await env.DB.prepare(
        "SELECT name, note, ok FROM run_steps WHERE kind='model' AND at >= ? AND (name LIKE 'openai:%' OR name LIKE 'claude:%' OR name LIKE 'worker:%:openai:%' OR name LIKE 'worker:%:claude:%' OR name LIKE 'shadow:openai:%') ORDER BY at DESC LIMIT 5001",
      )
        .bind(since)
        .all()
    ).results ?? [];
  /** @type {Map<string, {model:string,calls:number,knownCostCalls:number,knownUsageCalls:number,costUsd:number|null,inputTokens:number|null,outputTokens:number|null,shadow:boolean}>} */
  const groups = new Map();
  for (const row of rows.slice(0, 5000)) {
    const name = String(row.name);
    const match = name.match(/(?:^|:)(openai|claude):([A-Za-z0-9_.-]+)$/);
    if (!match) continue;
    const shadow = name.startsWith('shadow:');
    const key = `${shadow ? 'shadow:' : ''}${match[1]}:${match[2]}`;
    const item = groups.get(key) ?? {
      model: key,
      calls: 0,
      knownCostCalls: 0,
      knownUsageCalls: 0,
      costUsd: null,
      inputTokens: null,
      outputTokens: null,
      shadow,
    };
    const parsed = parseModelTelemetry(row.note);
    item.calls++;
    if (parsed.estimated_cost_usd != null) {
      item.knownCostCalls++;
      item.costUsd = (item.costUsd ?? 0) + parsed.estimated_cost_usd;
    }
    if (
      parsed.usage_complete === true &&
      parsed.usage.input_tokens != null &&
      parsed.usage.output_tokens != null
    ) {
      item.knownUsageCalls++;
      item.inputTokens = (item.inputTokens ?? 0) + parsed.usage.input_tokens;
      item.outputTokens = (item.outputTokens ?? 0) + parsed.usage.output_tokens;
    }
    groups.set(key, item);
  }
  return {
    since,
    truncated: rows.length > 5000,
    items: [...groups.values()].sort((a, b) => b.calls - a.calls),
  };
}
