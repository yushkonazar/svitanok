import { MonoTooSoonError, statement, STATEMENT_PAGE } from '../adapters/mono.mjs';
import { ingestTransaction, readMonoAccounts } from './store.mjs';

/** Shared per-endpoint cooldown for buttons and nightly reconciliation.
 * @param {Env} env @param {number} nowMs @param {'statement'|'client'} endpoint */
async function claimMonoRefresh(env, nowMs, endpoint) {
  if (!env.DB) throw new Error('Finance DB unavailable');
  const now = new Date(nowMs).toISOString(),
    cutoff = new Date(nowMs - 60000).toISOString();
  const result = await env.DB.prepare(
    `INSERT INTO facts(id,kind,key,value_json,source,confidence,created_at,updated_at)
    VALUES(?,'setting',?,'{}','observed_event',1,?,?)
    ON CONFLICT(kind,key) DO UPDATE SET updated_at=excluded.updated_at WHERE facts.updated_at<=?`,
  )
    .bind(`mono-${endpoint}-refresh-gate`, `mono_${endpoint}_refresh_gate`, now, now, cutoff)
    .run();
  if (!result.meta?.changes)
    throw new MonoTooSoonError(endpoint === 'client' ? 'Залишки карток' : 'Оновлення виписки');
}
/** @param {Env} env @param {number} nowMs */
export const claimMonoStatementRefresh = (env, nowMs) => claimMonoRefresh(env, nowMs, 'statement');
/** @param {Env} env @param {number} nowMs */
export const claimMonoClientRefresh = (env, nowMs) => claimMonoRefresh(env, nowMs, 'client');

/** Reads one connected card and preserves IDs and existing finance links.
 * @param {Env} env @param {unknown} accountId @param {number} [nowMs] */
export async function refreshMonoAccount(env, accountId, nowMs = Date.now()) {
  const accounts = await readMonoAccounts(env);
  const account = accounts.find((a) => `mono:${a.id}` === accountId);
  if (!account) throw new Error('Некоректний рахунок Monobank');
  await claimMonoStatementRefresh(env, nowMs);
  const toS = Math.floor(nowMs / 1000);
  const items = await statement(env, { account: account.id, fromS: toS - 31 * 86400, toS });
  if (items.length >= STATEMENT_PAGE)
    throw new Error('Виписка завелика для одного оновлення. Потрібна звірка частинами.');
  let updated = 0;
  let imported = 0;
  for (const item of [...items].reverse()) {
    const result = await ingestTransaction(env, {
      item,
      account: account.id,
      accountCurrency: account.currency,
      silent: true,
    });
    if (result.updated) updated++;
    if (result.inserted) imported++;
  }
  return { updated, imported };
}
