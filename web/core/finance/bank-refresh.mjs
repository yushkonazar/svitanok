import { clientInfo, MonoTooSoonError, statement, STATEMENT_PAGE } from '../adapters/mono.mjs';
import { ingestTransaction, NOT_TEST_SQL, readMonoAccounts } from './store.mjs';

const PENDING_RECHECK_INTERVAL_MS = 3_600_000;
const RECENT_HOLD_MS = 7 * 86_400_000;
const OLDER_HOLD_INTERVAL_MS = 86_400_000;
const STATEMENT_WINDOW_S = 31 * 86_400;
// Keep ingestion bounded even if the statement has hundreds of rows.
const PENDING_RECHECK_BATCH = 8;

/** Shared per-endpoint cooldown for buttons and nightly reconciliation.
 * @param {Env} env @param {number} nowMs @param {'statement'|'client'} endpoint */
async function claimMonoRefresh(env, nowMs, endpoint) {
  if (!env.DB) throw new Error('Finance DB unavailable');
  const now = new Date(nowMs).toISOString(),
    cutoff = new Date(nowMs - 60000).toISOString();
  const key = `mono_${endpoint}_refresh_gate`;
  const result = await env.DB.prepare(
    `INSERT INTO facts(id,kind,key,value_json,source,confidence,created_at,updated_at)
    VALUES(?,'setting',?,'{}','observed_event',1,?,?)
    ON CONFLICT(kind,key) DO UPDATE SET updated_at=excluded.updated_at,value_json='{}'
    WHERE facts.updated_at<=? AND COALESCE(json_extract(facts.value_json,'$.retryAt'),'')<=?`,
  )
    .bind(`mono-${endpoint}-refresh-gate`, key, now, now, cutoff, now)
    .run();
  if (!result.meta?.changes) {
    const gate = await env.DB.prepare(
      "SELECT updated_at,json_extract(value_json,'$.retryAt') AS retry_at FROM facts WHERE kind='setting' AND key=?",
    )
      .bind(key)
      .first();
    const nextAt = Math.max(
      (Date.parse(String(gate?.updated_at)) || nowMs) + 60000,
      Date.parse(String(gate?.retry_at)) || 0,
    );
    throw new MonoTooSoonError(
      endpoint === 'client' ? 'Залишки рахунків' : 'Оновлення виписки',
      Math.max(1000, nextAt - nowMs),
    );
  }
}
/** @param {Env} env @param {number} nowMs */
export const claimMonoStatementRefresh = (env, nowMs) => claimMonoRefresh(env, nowMs, 'statement');
/** @param {Env} env @param {number} nowMs */
export const claimMonoClientRefresh = (env, nowMs) => claimMonoRefresh(env, nowMs, 'client');

/** @template T @param {Env} env @param {'statement'|'client'} endpoint @param {number} nowMs @param {() => Promise<T>} read */
async function gatedBankRead(env, endpoint, nowMs, read) {
  await claimMonoRefresh(env, nowMs, endpoint);
  const startedAt = Date.now();
  try {
    return await read();
  } catch (error) {
    if (error instanceof MonoTooSoonError && env.DB) {
      const retryAt = new Date(
        Math.min(
          8_640_000_000_000_000,
          nowMs + Math.max(0, Date.now() - startedAt) + error.retryAfterMs,
        ),
      ).toISOString();
      await env.DB.prepare(
        "UPDATE facts SET value_json=json_set(value_json,'$.retryAt',?) WHERE kind='setting' AND key=? AND COALESCE(json_extract(value_json,'$.retryAt'),'')<?",
      )
        .bind(retryAt, `mono_${endpoint}_refresh_gate`, retryAt)
        .run();
    }
    throw error;
  }
}

/** @param {Env} env @param {number} nowMs */
export const readMonoClientInfo = (env, nowMs) =>
  gatedBankRead(env, 'client', nowMs, () => clientInfo(env));
/** @param {Env} env @param {Parameters<typeof statement>[1]} window @param {number} nowMs */
export const readMonoStatement = (env, window, nowMs) =>
  gatedBankRead(env, 'statement', nowMs, () => statement(env, window));

/** Revisit recent holds hourly and older holds daily. Only exact
 * statement matches can change settlement status. A missing row may be outside
 * the returned page, so record the attempt separately from bank evidence.
 * @param {Env} env @param {import('./store.mjs').StoredAccount[]} accounts @param {number} nowMs */
export async function recheckMonoHolds(env, accounts, nowMs) {
  if (!env.DB || !accounts.length) return null;
  const hourlyCutoff = new Date(nowMs - PENDING_RECHECK_INTERVAL_MS).toISOString();
  const { results = [] } = await env.DB.prepare(
    `SELECT id, at, json_extract(raw_json,'$.account') AS account FROM transactions
     WHERE at<=? AND json_valid(raw_json) AND json_extract(raw_json,'$.hold')=1
       AND ${NOT_TEST_SQL}
       AND json_extract(raw_json,'$.account') IN (SELECT value FROM json_each(?))
       AND max(COALESCE(json_extract(raw_json,'$.bankCheckedAt'),at),
               COALESCE(json_extract(raw_json,'$.bankRecheckedAt'),at))<=CASE WHEN at>=? THEN ? ELSE ? END
     ORDER BY COALESCE(json_extract(raw_json,'$.bankRecheckedAt'),json_extract(raw_json,'$.bankCheckedAt'),at), at, id
     LIMIT ${PENDING_RECHECK_BATCH}`,
  )
    .bind(
      hourlyCutoff,
      JSON.stringify(accounts.map((a) => a.id)),
      new Date(nowMs - RECENT_HOLD_MS).toISOString(),
      hourlyCutoff,
      new Date(nowMs - OLDER_HOLD_INTERVAL_MS).toISOString(),
    )
    .all();
  const account = accounts.find((a) => a.id === results[0]?.account);
  if (!account) return null;
  const sameAccount = results.filter((row) => row.account === account.id);
  const fromS =
    Math.floor(Math.min(...sameAccount.map((row) => Date.parse(String(row.at)))) / 1000) - 1;
  const toS = Math.min(Math.floor(nowMs / 1000), fromS + STATEMENT_WINDOW_S);
  const targets = sameAccount.filter((row) => Date.parse(String(row.at)) / 1000 <= toS);
  const checkedAt = new Date(nowMs).toISOString();
  const items = await readMonoStatement(env, { account: account.id, fromS, toS }, nowMs);
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
  await env.DB.prepare(
    "UPDATE transactions SET raw_json=json_set(raw_json,'$.bankRecheckedAt',?) WHERE id IN (SELECT value FROM json_each(?)) AND json_extract(raw_json,'$.hold')=1",
  )
    .bind(checkedAt, JSON.stringify(targets.map((row) => row.id)))
    .run();
  return { pendingChecked: checked, pendingPosted: posted };
}

/** Reads one connected card and preserves IDs and existing finance links.
 * @param {Env} env @param {unknown} accountId @param {number} [nowMs] */
export async function refreshMonoAccount(env, accountId, nowMs = Date.now()) {
  const accounts = await readMonoAccounts(env);
  const account = accounts.find((a) => `mono:${a.id}` === accountId);
  if (!account) throw new Error('Некоректний рахунок Monobank');
  const toS = Math.floor(nowMs / 1000);
  const items = await readMonoStatement(
    env,
    { account: account.id, fromS: toS - STATEMENT_WINDOW_S, toS },
    nowMs,
  );
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
