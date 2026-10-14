import { kyivDateKey } from '../../kyiv-time.mjs';
import { parseModelTelemetry } from './run-dashboard.mjs';
export const USAGE_FEATURES = [
  'assistant',
  'news',
  'translation',
  'content',
  'maps',
  'voice',
  'finance',
  'leisure',
  'memory',
  'learning',
  'media',
  'comparison',
  'other',
];
const PROVIDERS = ['openai', 'claude', 'google', 'gemini', 'deepgram', 'cloudflare', 'other'];
const LEGACY_LIMIT = 5000;
/** @param {unknown} value */
const count = (value) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
/** @param {unknown} value */
const number = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
/** @param {unknown} value @param {number} [max] */
const code = (value, max = 128) =>
  typeof value === 'string' && /^[A-Za-z0-9_.:@/-]+$/.test(value) ? value.slice(0, max) : null;
/** Never store prompts, response payloads, merchant names, chat IDs or URLs.
 * Idempotency is owned by the producer (run step ID or actual request attempt).
 * @param {Env} env @param {Record<string, any>} input */
export async function recordUsage(env, input) {
  if (!env.DB) return false;
  try {
    const id = code(input.id, 180) ?? `api:${crypto.randomUUID()}`;
    const at =
      typeof input.at === 'string' && Number.isFinite(Date.parse(input.at))
        ? new Date(input.at).toISOString()
        : new Date().toISOString();
    const cost = number(input.costUsd);
    const nano =
      cost == null || !Number.isSafeInteger(Math.round(cost * 1e9)) ? null : Math.round(cost * 1e9);
    await env.DB.prepare(
      `INSERT INTO usage_receipts (id,at,day,run_id,feature,provider,sku,basis,cost_nano_usd,quantity,unit,input_tokens,output_tokens,cached_tokens,cache_write_tokens,reasoning_tokens,api_attempts,model_responses,duration_ms,ok,price_version)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
    )
      .bind(
        id,
        at,
        kyivDateKey(new Date(at)),
        code(input.runId),
        USAGE_FEATURES.includes(input.feature) ? input.feature : 'other',
        PROVIDERS.includes(input.provider) ? input.provider : 'other',
        code(input.sku) ?? 'unknown',
        input.basis === 'api-equivalent' ? 'api-equivalent' : nano == null ? 'unknown' : 'estimate',
        nano,
        number(input.quantity),
        code(input.unit, 32),
        count(input.inputTokens),
        count(input.outputTokens),
        count(input.cachedTokens),
        count(input.cacheWriteTokens),
        count(input.reasoningTokens),
        count(input.apiAttempts),
        count(input.modelResponses),
        number(input.durationMs),
        input.ok === true ? 1 : input.ok === false ? 0 : null,
        code(input.priceVersion),
      )
      .run();
    return true;
  } catch {
    return false;
  } // Accounting must never discard an otherwise successful result.
}
/** @param {unknown} profile */
export function featureForProfile(profile) {
  const value = typeof profile === 'string' ? profile : '';
  if (/finance/.test(value)) return 'finance';
  if (/leisure|place-search/.test(value)) return 'leisure';
  if (/memory|summar/.test(value)) return 'memory';
  if (/tutor|learn/.test(value)) return 'learning';
  if (/news/.test(value)) return 'news';
  return 'assistant';
}
/** Normalize new structured model telemetry; legacy notes remain a rollback path.
 * @param {Env} env @param {string} runId @param {Record<string, any>} step @param {unknown} profile @param {number} n @param {number} nowMs */
export async function recordModelUsage(env, runId, step, profile, n, nowMs) {
  const match = String(step.name ?? '').match(/(?:^|:)(openai|claude):([A-Za-z0-9_.-]+)$/);
  if (step.kind !== 'model' || !match) return;
  const legacy = parseModelTelemetry(step.note);
  const t = step.telemetry && typeof step.telemetry === 'object' ? step.telemetry : null;
  const usage =
    t?.usage && typeof t.usage === 'object' && !Array.isArray(t.usage) ? t.usage : legacy.usage;
  await recordUsage(env, {
    id: `run:${runId}:${n}`,
    runId,
    at: step.at ?? new Date(nowMs).toISOString(),
    feature: String(step.name).startsWith('shadow:') ? 'comparison' : featureForProfile(profile),
    provider: match[1],
    sku: match[2],
    basis: match[1] === 'claude' ? 'api-equivalent' : 'estimate',
    costUsd: t ? t.estimatedCostUsd : legacy.estimated_cost_usd,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cachedTokens: usage.cached_input_tokens,
    cacheWriteTokens: usage.cache_write_tokens,
    reasoningTokens: usage.reasoning_tokens,
    apiAttempts: t ? t.apiAttempts : legacy.api_attempts,
    modelResponses: t ? t.modelResponses : legacy.model_responses,
    durationMs: t?.latencyUnknown || /latency_unknown=1/.test(String(step.note)) ? null : step.ms,
    ok: step.ok,
    priceVersion: t?.priceVersion ?? 'legacy-unversioned',
  });
}
/** @param {Env} env @param {{since:string,until:string}} period */
export async function readUsageLedger(env, period) {
  if (!env.DB) throw new Error('storage-unavailable');
  const args = [period.since, period.until];
  const columns = `COUNT(*) AS records,COUNT(cost_nano_usd) AS knownCosts,SUM(cost_nano_usd) AS nano,
    SUM(CASE WHEN basis='estimate' THEN cost_nano_usd ELSE NULL END) AS estimateNano,
    SUM(CASE WHEN basis='api-equivalent' THEN cost_nano_usd ELSE NULL END) AS equivalentNano,
    SUM(CASE WHEN basis='api-equivalent' THEN 1 ELSE 0 END) AS equivalents,
    SUM(input_tokens) AS inputTokens,SUM(output_tokens) AS outputTokens,
    SUM(cached_tokens) AS cachedTokens,SUM(cache_write_tokens) AS cacheWriteTokens,
    COUNT(input_tokens) AS knownInput,COUNT(output_tokens) AS knownOutput,
    SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END) AS failed`;
  const [groups, daily, legacyRows] = await Promise.all([
    env.DB.prepare(
      `SELECT feature,provider,sku,${columns} FROM usage_receipts WHERE at>=? AND at<? GROUP BY feature,provider,sku`,
    )
      .bind(...args)
      .all(),
    env.DB.prepare(
      `SELECT day,${columns} FROM usage_receipts WHERE at>=? AND at<? GROUP BY day ORDER BY day`,
    )
      .bind(...args)
      .all(),
    env.DB.prepare(
      `SELECT s.id,s.name,s.note,s.at,s.ok,r.profile FROM run_steps s LEFT JOIN runs r ON r.id=s.run_id
      WHERE s.kind='model' AND s.at>=? AND s.at<? AND NOT EXISTS(SELECT 1 FROM usage_receipts u WHERE u.id='run:'||s.run_id||':'||s.n)
      ORDER BY s.at DESC LIMIT ?`,
    )
      .bind(...args, LEGACY_LIMIT + 1)
      .all(),
  ]);
  const items = /** @type {any[]} */ (groups.results ?? []).map(shapeGroup);
  const trend = /** @type {any[]} */ (daily.results ?? []).map((row) => ({
    ...shapeGroup(row),
    day: row.day,
  }));
  for (const row of /** @type {any[]} */ (legacyRows.results ?? []).slice(0, LEGACY_LIMIT)) {
    const match = String(row.name).match(/(?:^|:)(openai|claude):([A-Za-z0-9_.-]+)$/);
    if (!match) continue;
    const t = parseModelTelemetry(row.note);
    const item = {
      feature: String(row.name).startsWith('shadow:')
        ? 'comparison'
        : featureForProfile(row.profile),
      provider: match[1],
      sku: match[2],
      records: 1,
      knownCosts: t.estimated_cost_usd == null ? 0 : 1,
      costUsd: t.estimated_cost_usd,
      estimatedUsd: match[1] === 'claude' ? null : t.estimated_cost_usd,
      equivalentUsd: match[1] === 'claude' ? t.estimated_cost_usd : null,
      equivalents: match[1] === 'claude' ? 1 : 0,
      inputTokens: t.usage.input_tokens,
      outputTokens: t.usage.output_tokens,
      cachedTokens: t.usage.cached_input_tokens,
      cacheWriteTokens: t.usage.cache_write_tokens,
      knownInput: t.usage.input_tokens == null ? 0 : 1,
      knownOutput: t.usage.output_tokens == null ? 0 : 1,
      failed: row.ok === 0 ? 1 : 0,
    };
    merge(items, item, ['feature', 'provider', 'sku']);
    merge(trend, { ...item, day: kyivDateKey(new Date(row.at)) }, ['day']);
  }
  /** @type {any[]} */ const features = [];
  /** @type {any[]} */ const providers = [];
  for (const item of items) {
    merge(features, item, ['feature']);
    merge(providers, item, ['provider']);
  }
  const total = items.reduce((sum, item) => add(sum, item), empty());
  const first = await env.DB.prepare('SELECT MIN(at) AS at FROM usage_receipts').bind().first();
  return {
    ...total,
    items,
    features,
    providers,
    daily: trend.sort((a, b) => a.day.localeCompare(b.day)),
    legacyTruncated: (legacyRows.results?.length ?? 0) > LEGACY_LIMIT,
    trackingSince: /** @type {any} */ (first)?.at ?? null,
    historicalCoverage: 'partial',
    retentionDays: 90,
  };
}
/** @param {any} row */
function shapeGroup(row) {
  return {
    feature: row.feature,
    provider: row.provider,
    sku: row.sku,
    records: Number(row.records),
    knownCosts: Number(row.knownCosts),
    costUsd: row.nano == null ? null : Number(row.nano) / 1e9,
    estimatedUsd: row.estimateNano == null ? null : Number(row.estimateNano) / 1e9,
    equivalentUsd: row.equivalentNano == null ? null : Number(row.equivalentNano) / 1e9,
    equivalents: Number(row.equivalents),
    inputTokens: row.inputTokens ?? null,
    outputTokens: row.outputTokens ?? null,
    cachedTokens: row.cachedTokens ?? null,
    cacheWriteTokens: row.cacheWriteTokens ?? null,
    knownInput: Number(row.knownInput),
    knownOutput: Number(row.knownOutput),
    failed: Number(row.failed),
  };
}
function empty() {
  return {
    records: 0,
    knownCosts: 0,
    costUsd: /** @type {number|null} */ (null),
    estimatedUsd: /** @type {number|null} */ (null),
    equivalentUsd: /** @type {number|null} */ (null),
    equivalents: 0,
    inputTokens: /** @type {number|null} */ (null),
    outputTokens: /** @type {number|null} */ (null),
    cachedTokens: /** @type {number|null} */ (null),
    cacheWriteTokens: /** @type {number|null} */ (null),
    knownInput: 0,
    knownOutput: 0,
    failed: 0,
  };
}
/** @param {any} target @param {any} source */
function add(target, source) {
  for (const key of Object.keys(empty())) {
    if (source[key] != null)
      target[key] = key.endsWith('Usd')
        ? (Math.round((target[key] ?? 0) * 1e9) + Math.round(source[key] * 1e9)) / 1e9
        : (target[key] ?? 0) + source[key];
  }
  return target;
}
/** @param {any[]} groups @param {any} item @param {string[]} keys */
function merge(groups, item, keys) {
  let group = groups.find((g) => keys.every((key) => g[key] === item[key]));
  if (!group) {
    group = { ...empty(), ...Object.fromEntries(keys.map((key) => [key, item[key]])) };
    groups.push(group);
  }
  add(group, item);
}
