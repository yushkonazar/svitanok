// GET /api/deletions — приватний read-only звіт T2 «забудь усе».
//
// Це НЕ частина публічного /api/status: квитанції розкривають часовий слід
// особистих операцій. Віддаємо вузький нормалізований зріз без id, URL, stack
// або вмісту видалених даних; деталі для інженерного розбору лишаються в
// контрольованих runtime-логах, а не в Mini App.

import { json } from './http-core.mjs';
import { checkOwnerRead } from './auth-core.mjs';
import {
  readDeletionReceiptHistory,
  DELETION_RECEIPT_RETENTION_DAYS,
} from './core/export/forget-all.mjs';

/** @param {Env} env @param {{ ok?: unknown, status?: number, error?: string }|null|undefined} auth */
export async function handleDeletions(env, auth) {
  if (!auth?.ok) return json({ ok: false, error: auth?.error ?? 'auth' }, auth?.status ?? 401);
  const receipts = await readDeletionReceiptHistory(env);
  return new Response(
    JSON.stringify({ receipts, retentionDays: DELETION_RECEIPT_RETENTION_DAYS }),
    {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    },
  );
}

/** @param {Request} request @param {Env} env */
export async function handleDeletionsRequest(request, env) {
  if (request.method !== 'GET') return json({ ok: false, error: 'method' }, 405);
  return handleDeletions(env, await checkOwnerRead(request, env));
}
