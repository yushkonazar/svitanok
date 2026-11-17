import { STATEMENT_PAGE, MonoApiError, MonoTooSoonError } from '../adapters/mono.mjs';
import {
  ledgerMonoId,
  readMonoAccounts,
  writeMonoClientAccounts,
  ingestTransaction,
} from './store.mjs';
import { readMonoStatement, readMonoClientInfo } from './bank-refresh.mjs';
export const BANK_SYNC_KEY = 'mono_bank_refresh';
const WINDOW = 31 * 86400;
export class BankAccountUnlisted extends Error {
  constructor() {
    super('Monobank не повернув цей рахунок у списку доступних рахунків.');
  }
}

/** Resolve a saved reference independently of the cached bank roster.
 * @param {Env} env @param {unknown} accountId */
export async function bankRefreshTarget(env, accountId) {
  if (!env.DB) throw new Error('Finance DB unavailable');
  if (accountId === 'all') return null;
  if (typeof accountId !== 'string' || accountId.length > 150)
    throw new Error('Некоректний рахунок Monobank');
  const row = await env.DB.prepare(
    "SELECT mono_id FROM finance_accounts WHERE id=? AND kind='mono'",
  )
    .bind(accountId)
    .first();
  const id = ledgerMonoId(accountId, row?.mono_id);
  if (!id) throw new Error('Некоректний рахунок Monobank');
  return id;
}

/** @param {Env} env @param {unknown} accountId @param {unknown} transactionId @param {number} nowMs */
export async function bankRefreshTasks(env, accountId, transactionId, nowMs) {
  if (!env.DB) throw new Error('Finance DB unavailable');
  const targetId = await bankRefreshTarget(env, accountId);
  const accounts = await readMonoAccounts(env);
  const selected = targetId === null ? accounts : accounts.filter((a) => a.id === targetId);
  if (!selected.length && targetId !== null) throw new BankAccountUnlisted();
  const toS = Math.floor(nowMs / 1000);
  const target = transactionId
    ? await env.DB.prepare('SELECT at,raw_json FROM transactions WHERE id=?')
        .bind(transactionId)
        .first()
    : null;
  const raw = target ? JSON.parse(String(target.raw_json ?? '{}')) : null;
  if (transactionId && (!target || !selected.some((a) => a.id === raw?.account)))
    throw new Error('Некоректна операція обраної картки');
  const tasks = selected.map((account) => ({ account, fromS: toS - WINDOW, toS }));
  for (const account of selected) {
    const old = await env.DB.prepare(
      "SELECT MIN(at) AS oldest FROM transactions WHERE json_extract(raw_json,'$.account')=? AND json_extract(raw_json,'$.hold')=1 AND COALESCE(json_extract(raw_json,'$.test'),0)<>1",
    )
      .bind(account.id)
      .first();
    const oldest = Math.min(
      old?.oldest ? Date.parse(String(old.oldest)) / 1000 : toS,
      raw?.account === account.id ? Date.parse(String(target?.at)) / 1000 : toS,
    );
    for (let end = toS - WINDOW; Number.isFinite(oldest) && end >= oldest; end -= WINDOW)
      tasks.push({ account, fromS: Math.max(1, end - WINDOW), toS: end });
  }
  return tasks;
}
/** @param {Env} env @param {any} job */
export async function publishBankSync(env, job) {
  if (!env.DB) throw new Error('Finance DB unavailable');
  const status = {
    id: job.id,
    active: job.active,
    phase: job.phase,
    done: job.index + (job.accountsDone ? 1 : 0),
    total: job.tasks.length + (job.accountId ? 1 : 0),
    accountId: job.tasks[job.index]?.account.id ?? null,
    statementAccounts: [...new Set(job.tasks.map((/** @type {any} */ task) => task.account.id))],
    balancesOnly: Boolean(job.balancesOnly),
    verificationAccountId: job.verificationAccountId ?? null,
    imported: job.imported,
    updated: job.updated,
    requestedAt: job.requestedAt,
    balanceUpdatedAt: job.balanceUpdatedAt ?? null,
    completedAt: job.completedAt ?? null,
    message: job.message ?? null,
  };
  await env.DB.prepare(
    "INSERT INTO facts(id,kind,key,value_json,source,confidence,created_at,updated_at) VALUES('mono-bank-refresh-status','setting',?,?,'observed_event',1,?,?) ON CONFLICT(kind,key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
  )
    .bind(BANK_SYNC_KEY, JSON.stringify(status), new Date().toISOString(), new Date().toISOString())
    .run();
}
/** Public operational metadata only; job pages stay in temporary DO storage.
 * @param {any} ctx @param {Env} env @param {any} job @param {number} nowMs */
export async function advanceBankSync(ctx, env, job, nowMs) {
  if (!job) return;
  if (!job.active) {
    await publishBankSync(env, job);
    return;
  }
  if (!env.DB) throw new Error('Finance DB unavailable');
  const database = env.DB;
  if (job.phase === 'accounts') {
    try {
      const info = await readMonoClientInfo(env, nowMs);
      const observedMs = Date.now();
      const accounts = await writeMonoClientAccounts(env, info, observedMs);
      job.accountsDone = true;
      job.balanceUpdatedAt = new Date(observedMs).toISOString();
      if (job.verificationAccountId) {
        const target = job.verificationTarget;
        job.verificationMessage =
          target == null
            ? 'Список Monobank звірено.'
            : accounts.some((a) => a.id === target)
              ? 'Monobank підтвердив цей рахунок.'
              : job.verificationIsJar && !info.jarsReported
                ? 'Monobank не передав список банок.'
                : 'Цього рахунку немає у списку Monobank.';
      }
      if (!job.balancesOnly && job.index === 0 && !job.chunks && job.accountId) {
        job.tasks = await bankRefreshTasks(env, job.accountId, job.transactionId, nowMs);
      } else
        for (const task of job.tasks) {
          const fresh = accounts.find((a) => a.id === task.account.id);
          if (fresh) task.account = fresh;
        }
      job.phase = job.resumePhase ?? 'fetch';
      delete job.resumePhase;
      job.message = null;
      job.failures = 0;
    } catch (error) {
      if (error instanceof BankAccountUnlisted) {
        job.tasks = [];
        job.active = false;
        job.phase = 'error';
        job.message = error.message;
        job.completedAt = new Date(nowMs).toISOString();
        await ctx.storage.put('bank-refresh', job);
        await publishBankSync(env, job);
        return;
      }
      if (error instanceof MonoTooSoonError) {
        job.message = 'Чекаємо дозволеного банком проміжку для оновлення залишків рахунків.';
        await ctx.storage.put('bank-refresh', job);
        await ctx.storage.setAlarm(Date.now() + error.retryAfterMs + 1000);
        await publishBankSync(env, job);
        return;
      }
      throw error; // The DO retries transient failures and publishes a recoverable error.
    }
    await ctx.storage.put('bank-refresh', job);
    await ctx.storage.setAlarm(Date.now() + 50);
    await publishBankSync(env, job);
    return;
  }
  const task = job.tasks[job.index];
  if (!task) {
    job.active = false;
    job.phase = 'done';
    job.completedAt = new Date(nowMs).toISOString();
    job.message = job.balancesOnly
      ? (job.verificationMessage ?? 'Список Monobank звірено.')
      : job.skippedUnlisted
        ? 'Доступні виписки оновлено. Частини рахунків уже немає у списку Monobank.'
        : 'Дані Monobank оновлено.';
    await ctx.storage.put('bank-refresh', job);
    await publishBankSync(env, job);
    return;
  }
  if (job.phase === 'ingest') {
    const key = `bank-page-${job.chunk}`,
      items = (await ctx.storage.get(key)) ?? [];
    for (const item of items) {
      const result = await ingestTransaction(env, {
        item,
        account: task.account.id,
        accountCurrency: task.account.currency,
        bankKind: task.account.bankKind,
        silent: true,
        versioned: true,
        checkedAt: job.pageObservedAt ?? new Date(nowMs).toISOString(),
        checkSource: 'statement',
      });
      if (result.inserted) job.imported++;
      if (result.updated) job.updated++;
    }
    await ctx.storage.delete(key);
    job.chunk++;
    if (job.chunk >= job.chunks) {
      if (job.nextToS != null) {
        task.cursor = job.nextToS;
        job.phase = 'fetch';
      } else {
        const missing = env.DB.prepare(
          "UPDATE transactions SET raw_json=json_patch(COALESCE(raw_json,'{}'),?) WHERE json_extract(raw_json,'$.account')=? AND json_extract(raw_json,'$.hold')=1 AND at>=? AND at<=? AND COALESCE(json_extract(raw_json,'$.bankCheckedAt'),'')<? AND COALESCE(json_extract(raw_json,'$.test'),0)<>1 AND COALESCE(json_extract(raw_json,'$.bankMissingFromStatement'),0)=0",
        ).bind(
          JSON.stringify({
            bankMissingFromStatement: true,
            bankCheckedAt: new Date(nowMs).toISOString(),
            bankCheckSource: 'statement',
          }),
          task.account.id,
          new Date(task.fromS * 1000).toISOString(),
          new Date(task.toS * 1000).toISOString(),
          job.windowStartedAt,
        );
        await env.DB.batch([
          missing,
          database.prepare(
            "UPDATE finance_settings SET version=version+1 WHERE id='owner' AND changes()>0",
          ),
        ]);
        job.index++;
        job.phase = 'fetch';
        delete job.windowStartedAt;
      }
    }
    job.failures = 0;
    await ctx.storage.put('bank-refresh', job);
    await ctx.storage.setAlarm(Date.now() + 50);
    await publishBankSync(env, job);
    return;
  }
  try {
    if (!(await readMonoAccounts(env)).some((account) => account.id === task.account.id)) {
      job.skippedUnlisted = true;
      job.index++;
      delete job.windowStartedAt;
      await ctx.storage.put('bank-refresh', job);
      await ctx.storage.setAlarm(Date.now() + 50);
      await publishBankSync(env, job);
      return;
    }
    const end = task.cursor ?? task.toS;
    if (!job.windowStartedAt) job.windowStartedAt = new Date(nowMs).toISOString();
    const items = await readMonoStatement(
      env,
      { account: task.account.id, fromS: task.fromS, toS: end },
      nowMs,
    );
    job.pageObservedAt = new Date(nowMs).toISOString();
    const oldest = items.length ? Math.min(...items.map((i) => i.timeS)) : null;
    if (items.length >= STATEMENT_PAGE && (oldest === end || oldest === task.fromS))
      throw new Error(
        'Виписка заповнила сторінку на часовій межі. Банк не дає підтвердити повноту цього відрізка.',
      );
    job.nextToS =
      items.length >= STATEMENT_PAGE && oldest != null && oldest > task.fromS ? oldest : null;
    const chunks = [];
    let chunk = [],
      size = 0;
    for (const item of items) {
      const bytes = new TextEncoder().encode(JSON.stringify(item)).length;
      if (bytes > 90000) throw new Error('Банк повернув надто великий запис операції.');
      if (chunk.length >= 30 || size + bytes > 90000) {
        chunks.push(chunk);
        chunk = [];
        size = 0;
      }
      chunk.push(item);
      size += bytes;
    }
    if (chunk.length) chunks.push(chunk);
    if (!chunks.length) chunks.push([]);
    await ctx.storage.put(Object.fromEntries(chunks.map((chunk, n) => [`bank-page-${n}`, chunk])));
    job.chunk = 0;
    job.chunks = chunks.length;
    job.phase = 'ingest';
    job.message = null;
    job.failures = 0;
    await ctx.storage.put('bank-refresh', job);
    await ctx.storage.setAlarm(Date.now() + 50);
    await publishBankSync(env, job);
  } catch (error) {
    if (error instanceof MonoTooSoonError) {
      job.message = 'Чекаємо дозволеного банком проміжку між запитами.';
      await ctx.storage.put('bank-refresh', job);
      await ctx.storage.setAlarm(Date.now() + error.retryAfterMs + 1000);
      await publishBankSync(env, job);
      return;
    }
    if (error instanceof MonoApiError && error.retryable) throw error;
    if (job.chunks)
      await ctx.storage.delete(Array.from({ length: job.chunks }, (_, n) => `bank-page-${n}`));
    job.active = false;
    job.phase = 'error';
    job.message = 'Не вдалося повністю звірити виписку. Спробуй оновити ще раз.';
    job.completedAt = new Date(nowMs).toISOString();
    await ctx.storage.put('bank-refresh', job);
    await publishBankSync(env, job);
  }
}
