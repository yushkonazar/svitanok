// GET /api/analytics — прозорий read-only зріз 4D.
//
// Це свідомо не частина /api/stats: frozen Mini App його не читає, а analytics
// може розвиватися як окремий контракт для асистента/майбутнього екрана без
// непомітної зміни payload чинного застосунку.

import { json } from './http-core.mjs';
import { checkOwnerRead } from './auth-core.mjs';
import { loadLevers, loadStats } from './kv-store.mjs';
import { kyivDateKey } from './kyiv-time.mjs';
import { aggregateStats } from './stats-core.mjs';
import { buildAnalyticsSnapshot } from './analytics-core.mjs';

/** @param {Env} env @param {{ ok?: unknown, status?: number, error?: string }|null|undefined} auth */
export async function handleAnalytics(env, auth) {
  if (!auth?.ok) return json({ ok: false, error: auth?.error ?? 'auth' }, auth?.status ?? 401);
  const [stats, levers] = await Promise.all([loadStats(env), loadLevers(env)]);
  const analytics = buildAnalyticsSnapshot({
    agg: aggregateStats(stats, kyivDateKey()),
    levers,
  });
  return new Response(JSON.stringify(analytics), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** @param {Request} request @param {Env} env */
export async function handleAnalyticsRequest(request, env) {
  if (request.method !== 'GET') return json({ ok: false, error: 'method' }, 405);
  return handleAnalytics(env, await checkOwnerRead(request, env));
}
