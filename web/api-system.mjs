import { checkPrimaryOwner, mutationInitData } from './auth-core.mjs';
import { json } from './http-core.mjs';
import { readRunDashboard, parseModelTelemetry } from './core/ops/run-dashboard.mjs';
import { brainHealthSnapshot } from './core/brain/health.mjs';
import { readQuotas, quotaPeriod } from './core/quota/quota.mjs';
import { readDeliverySlo } from './core/ops/delivery-slo.mjs';
import { SCHEDULER_DO_NAME } from './core/scheduler/do.mjs';
import { RUN_REGISTRY_DO_NAME } from './core/run-registry/client.mjs';

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
  if (request.method !== 'GET') return reply({ ok: false, error: 'method-not-allowed' }, 405);
  const nowMs = Date.now();
  const [runs, models, quotas, delivery, scheduler, registry, brain] = await Promise.all([
    section(async () => {
      const data = await readRunDashboard(env);
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
    section(() => readModelUsage(env, nowMs)),
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
  ]);
  return reply({
    ok: true,
    generatedAt: new Date(nowMs).toISOString(),
    period: quotaPeriod(nowMs),
    mode: env.ASSISTANT_V2 ?? 'off',
    runs,
    models,
    quotas,
    delivery,
    scheduler,
    registry,
    brain,
    deployment: env.CF_VERSION_METADATA?.id ?? null,
    billing: { connected: false, balance: null },
  });
}
/** @param {() => Promise<unknown>} fn */
async function section(fn) {
  try {
    return { available: true, data: await fn() };
  } catch {
    return { available: false, data: null };
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
