import { MonoTooSoonError, statement, STATEMENT_PAGE } from '../adapters/mono.mjs';
import { ingestTransaction, NOT_TEST_SQL, readMonoAccounts } from './store.mjs';

const PENDING_RECHECK_INTERVAL_MS = 3_600_000;
const PENDING_RECHECK_WINDOW_MS = 7 * 86_400_000;
// Keep ingestion bounded even if the statement has hundreds of rows.
const PENDING_RECHECK_BATCH = 8;

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

/** Revisit a small batch of recent holds on one verified account. Only exact
 * statement matches can change settlement status. A missing row may be outside
 * the returned page, so record the attempt separately from bank evidence.
 * @param {Env} env @param {import('./store.mjs').StoredAccount[]} accounts @param {number} nowMs */
export async function recheckRecentMonoHolds(env, accounts, nowMs) {
  if (!env.DB || !accounts.length) return null;
  const cutoff = new Date(nowMs - PENDING_RECHECK_INTERVAL_MS).toISOString();
  const { results = [] } = await env.DB.prepare(
    `SELECT id, at, json_extract(raw_json,'$.account') AS account FROM transactions
     WHERE at>=? AND at<=? AND json_valid(raw_json) AND json_extract(raw_json,'$.hold')=1
       AND ${NOT_TEST_SQL}
       AND json_extract(raw_json,'$.account') IN (SELECT value FROM json_each(?))
       AND max(COALESCE(json_extract(raw_json,'$.bankCheckedAt'),at),
               COALESCE(json_extract(raw_json,'$.bankRecheckedAt'),at))<=?
     ORDER BY COALESCE(json_extract(raw_json,'$.bankRecheckedAt'),at), at, id
     LIMIT ${PENDING_RECHECK_BATCH}`,
  )
    .bind(
      new Date(nowMs - PENDING_RECHECK_WINDOW_MS).toISOString(),
      cutoff,
      JSON.stringify(accounts.map((a) => a.id)),
      cutoff,
    )
    .all();
  const account = accounts.find((a) => a.id === results[0]?.account);
  if (!account) return null;
  const targets = results.filter((row) => row.account === account.id);
  await claimMonoStatementRefresh(env, nowMs);
  const checkedAt = new Date(nowMs).toISOString();
  await env.DB.prepare(
    "UPDATE transactions SET raw_json=json_set(raw_json,'$.bankRecheckedAt',?) WHERE id IN (SELECT value FROM json_each(?)) AND json_extract(raw_json,'$.hold')=1",
  )
    .bind(checkedAt, JSON.stringify(targets.map((row) => row.id)))
    .run();
  const items = await statement(env, {
    account: account.id,
    fromS: Math.floor(Math.min(...targets.map((row) => Date.parse(String(row.at)))) / 1000) - 1,
    toS: Math.floor(nowMs / 1000),
  });
  const byId = new Map(items.map((item) => [item.id, item]));
  let checked = 0;
  let posted = 0;
  for (const row of targets) {
    const item = byId.get(String(row.id));
    if (!item) continue;
    const result = await ingestTransaction(env, {
      item,
      account: account.id,
      accountCurrency: account.currency,
      bankKind: account.bankKind,
      silent: true,
      checkedAt,
      checkSource: 'statement',
    });
    checked++;
    if (result.updated && !item.hold) posted++;
  }
  return { pendingChecked: checked, pendingPosted: posted };
}

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
      bankKind: account.bankKind,
      silent: true,
      checkedAt: new Date(nowMs).toISOString(),
      checkSource: 'statement',
    });
    if (result.updated) updated++;
    if (result.inserted) imported++;
  }
  return { updated, imported };
}
