import { statement, STATEMENT_PAGE, MonoTooSoonError } from '../adapters/mono.mjs';
import { readMonoAccounts, ingestTransaction } from './store.mjs';
import { claimMonoStatementRefresh } from './bank-refresh.mjs';
export const BANK_SYNC_KEY = 'mono_bank_refresh';
const WINDOW = 31 * 86400;
/** @param {Env} env @param {unknown} accountId @param {unknown} transactionId @param {number} nowMs */
export async function bankRefreshTasks(env, accountId, transactionId, nowMs) {
  if (!env.DB) throw new Error('Finance DB unavailable');
  const accounts = await readMonoAccounts(env);
  let selected = accounts.filter((a) => accountId === 'all' || `mono:${a.id}` === accountId);
  if (!selected.length && typeof accountId === 'string') {
    const row = await env.DB.prepare('SELECT mono_id FROM finance_accounts WHERE id=?')
      .bind(accountId)
      .first();
    selected = accounts.filter((a) => row?.mono_id === a.id);
  }
  if (!selected.length) throw new Error('Некоректний рахунок Monobank');
  const toS = Math.floor(nowMs / 1000);
  const target = transactionId
    ? await env.DB.prepare('SELECT at,raw_json FROM transactions WHERE id=?')
        .bind(transactionId)
        .first()
    : null;
  const raw = target ? JSON.parse(String(target.raw_json ?? '{}')) : null;
  if (transactionId && (!target || !selected.some((a) => a.id === raw?.account)))
    throw new Error('Некоректна операція обраної картки');
  const tasks = [];
  for (const account of selected) {
    tasks.push({ account, fromS: toS - WINDOW, toS });
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
    done: job.index,
    total: job.tasks.length,
    accountId: job.tasks[job.index]?.account.id ?? null,
    imported: job.imported,
    updated: job.updated,
    requestedAt: job.requestedAt,
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
  const task = job.tasks[job.index];
  if (!task) {
    job.active = false;
    job.phase = 'done';
    job.completedAt = new Date(nowMs).toISOString();
    job.message = 'Виписки звірено з банком.';
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
        silent: true,
        versioned: true,
      });
      if (result.inserted) job.imported++;
      if (result.updated) job.updated++;
    }
    if (items.length) {
      await env.DB.batch(
        items.map((/** @type {any} */ item) =>
          database
            .prepare(
              "UPDATE transactions SET raw_json=json_patch(COALESCE(raw_json,'{}'),?) WHERE id=?",
            )
            .bind(
              JSON.stringify({
                bankCheckedAt: new Date(nowMs).toISOString(),
                bankMissingFromStatement: false,
              }),
              item.id,
            ),
        ),
      );
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
    await ctx.storage.put('bank-refresh', job);
    await ctx.storage.setAlarm(Date.now() + 50);
    await publishBankSync(env, job);
    return;
  }
  try {
    await claimMonoStatementRefresh(env, nowMs);
    const end = task.cursor ?? task.toS;
    if (!job.windowStartedAt) job.windowStartedAt = new Date(nowMs).toISOString();
    const items = await statement(env, { account: task.account.id, fromS: task.fromS, toS: end });
    const oldest = items.length ? Math.min(...items.map((i) => i.timeS)) : null;
    if (items.length >= STATEMENT_PAGE && oldest === end)
      throw new Error(
        'Виписка містить понад 500 операцій за одну секунду. Банк не дає повністю прочитати цей відрізок.',
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
    await ctx.storage.put('bank-refresh', job);
    await ctx.storage.setAlarm(Date.now() + 50);
    await publishBankSync(env, job);
  } catch (error) {
    if (error instanceof MonoTooSoonError) {
      job.message = 'Чекаємо дозволеного банком проміжку між запитами.';
      await ctx.storage.put('bank-refresh', job);
      await ctx.storage.setAlarm(Date.now() + 61000);
      await publishBankSync(env, job);
      return;
    }
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
