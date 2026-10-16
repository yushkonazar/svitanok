import { applyPlanCommand, emptyPlan, PlanError, PLAN_OPERATIONS, planView } from './model.mjs';

/** @param {Env} env */
export function planDb(env) {
  if (!env.DB) throw new PlanError('Сховище плану тимчасово недоступне.', 503);
  return env.DB.withSession ? env.DB.withSession('first-primary') : env.DB;
}
/** @param {any} db @returns {Promise<import('./model.mjs').PlanState>} */
async function load(db) {
  const snapshot = await db.batch([
    db.prepare('SELECT revision,data_json FROM motivation_account WHERE id=1').bind(),
    db.prepare('SELECT data_json FROM motivation_records').bind(),
  ]);
  const row = snapshot[0].results[0],
    defaults = emptyPlan(),
    saved = row ? JSON.parse(row.data_json) : {},
    settings = { ...defaults.settings, ...saved.settings };
  // 0.11.0 already recorded settings saves, including saves while disabled.
  // Use the full ledger, not the last 100 visible events; reads stay read-only.
  if (row && saved.settings?.reviewedAt === undefined) {
    const reviewed = await db
      .prepare("SELECT at FROM motivation_ledger WHERE kind='settings' ORDER BY at,id LIMIT 1")
      .bind()
      .first();
    settings.reviewedAt = reviewed?.at ?? null;
  }
  return {
    ...defaults,
    ...saved,
    settings,
    revision: Number(row?.revision ?? 0),
    records: Object.fromEntries(
      snapshot[1].results.map((/** @type {any} */ r) => {
        const item = JSON.parse(r.data_json);
        return [item.id, item];
      }),
    ),
  };
}
/** @param {any} value @returns {string} */
function canonical(value) {
  return JSON.stringify(
    value && typeof value === 'object'
      ? Array.isArray(value)
        ? value.map((v) => JSON.parse(canonical(v)))
        : Object.fromEntries(
            Object.keys(value)
              .sort()
              .filter((k) => value[k] !== undefined)
              .map((k) => [k, JSON.parse(canonical(value[k]))]),
          )
      : value,
  );
}
/** @param {string} value */
async function fingerprint(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
/** @param {any} raw @param {boolean} internal */
function validateCommand(raw, internal) {
  if (
    !raw ||
    typeof raw !== 'object' ||
    typeof raw.commandId !== 'string' ||
    !/^[a-zA-Z0-9_-]{8,80}$/.test(raw.commandId ?? '') ||
    (!PLAN_OPERATIONS.includes(raw.op) &&
      !(internal && ['_settle', '_calendar', '_notice'].includes(raw.op)))
  )
    throw new PlanError('Онови застосунок і повтори дію.');
  if (!internal && (!Number.isSafeInteger(raw.revision) || raw.revision < 0))
    throw new PlanError('Потрібна актуальна версія плану.', 409);
  return {
    op: raw.op,
    id: raw.id,
    commandId: raw.commandId,
    payload: raw.payload ?? {},
    revision: raw.revision,
  };
}

/** All effects, ledger and retry receipt commit together. Outbox is optional and internal only.
 * @param {Env} env @param {any} raw @param {number} [nowMs] @param {{internal?:boolean,outbox?:any[]}} [options] */
export async function executePlanCommand(env, raw, nowMs = Date.now(), options = {}) {
  const command = validateCommand(raw, Boolean(options.internal)),
    db = planDb(env),
    hash = await fingerprint(canonical(command));
  const prior = await db
    .prepare('SELECT fingerprint,receipt_json FROM motivation_commands WHERE id=?')
    .bind(command.commandId)
    .first();
  if (prior) {
    if (prior.fingerprint !== hash)
      throw new PlanError('Ідентифікатор уже використано для іншої дії.', 409);
    return JSON.parse(String(prior.receipt_json));
  }
  const state = await load(db);
  if (!options.internal && state.revision !== command.revision)
    throw new PlanError('План уже змінився. Онови його й повтори дію.', 409);
  const next = applyPlanCommand(state, command, nowMs);
  const account = { ...next.state, records: undefined };
  const statements = [
    db
      .prepare(
        'INSERT INTO motivation_account(id,revision,data_json) VALUES(1,0,?) ON CONFLICT(id) DO NOTHING',
      )
      .bind(JSON.stringify({ ...emptyPlan(), records: undefined })),
    db
      .prepare('UPDATE motivation_account SET revision=?,data_json=? WHERE id=1 AND revision=?')
      .bind(next.state.revision, JSON.stringify(account), state.revision),
    db
      .prepare(
        'INSERT INTO motivation_guards(id,valid) VALUES(?,CASE WHEN changes()=1 THEN 1 ELSE 0 END)',
      )
      .bind(command.commandId),
  ];
  const changed = Object.values(next.state.records).filter(
    (record) => JSON.stringify(record) !== JSON.stringify(state.records[record.id]),
  );
  if (changed.length)
    statements.push(
      db
        .prepare(
          "INSERT INTO motivation_records(id,kind,date,data_json) SELECT json_extract(value,'$.id'),json_extract(value,'$.kind'),json_extract(value,'$.date'),value FROM json_each(?) WHERE true ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,date=excluded.date,data_json=excluded.data_json",
        )
        .bind(JSON.stringify(changed)),
    );
  const removed = Object.keys(state.records).filter((id) => !next.state.records[id]);
  if (removed.length)
    statements.push(
      db
        .prepare('DELETE FROM motivation_records WHERE id IN (SELECT value FROM json_each(?))')
        .bind(JSON.stringify(removed)),
    );
  if (next.events.length)
    statements.push(
      db
        .prepare(
          "INSERT INTO motivation_ledger(id,command_id,at,kind,delta,experience_delta,data_json) SELECT json_extract(value,'$.id'),?,json_extract(value,'$.at'),json_extract(value,'$.kind'),json_extract(value,'$.delta'),json_extract(value,'$.experienceDelta'),value FROM json_each(?)",
        )
        .bind(command.commandId, JSON.stringify(next.events)),
    );
  for (const item of options.outbox ?? [])
    statements.push(
      db
        .prepare(
          "INSERT INTO outbox(id,chat_id,thread_id,kind,payload_json,attempts,next_at,status) VALUES(?,?,?,'send',?,0,?,'pending')",
        )
        .bind(
          item.id,
          String(item.chatId),
          item.threadId == null ? null : String(item.threadId),
          JSON.stringify(item.payload),
          new Date(nowMs).toISOString(),
        ),
    );
  statements.push(
    db
      .prepare(
        'INSERT INTO motivation_commands(id,fingerprint,receipt_json,created_at) VALUES(?,?,?,?)',
      )
      .bind(command.commandId, hash, JSON.stringify(next.receipt), new Date(nowMs).toISOString()),
  );
  statements.push(db.prepare('DELETE FROM motivation_guards WHERE id=?').bind(command.commandId));
  try {
    await db.batch(statements);
  } catch (error) {
    const saved = await db
      .prepare('SELECT fingerprint,receipt_json FROM motivation_commands WHERE id=?')
      .bind(command.commandId)
      .first();
    if (saved?.fingerprint === hash) return JSON.parse(String(saved.receipt_json));
    if (/motivation_guards|CHECK constraint|UNIQUE constraint/i.test(String(error)))
      throw new PlanError('План уже змінився. Онови його й повтори дію.', 409);
    throw error;
  }
  return next.receipt;
}

/** @param {Env} env @param {number} [nowMs] @param {{from?:string,to?:string,before?:string}} [range] */
export async function readPlanWorkspace(env, nowMs = Date.now(), range = {}) {
  const db = planDb(env),
    state = await load(db);
  const before = range.before ?? new Date(nowMs + 1).toISOString();
  const rows = await db
    .prepare(
      'SELECT data_json FROM motivation_ledger WHERE at <= ? ORDER BY at DESC,id DESC LIMIT 101',
    )
    .bind(before)
    .all();
  const events = rows.results.slice(0, 100).map((r) => JSON.parse(String(r.data_json)));
  // Cursor contains timestamp + id in a subsequent version; all events from a
  // command share a timestamp, so include the complete timestamp boundary here.
  return planView(state, nowMs, events);
}
/** @param {Env} env */
export async function readPlanState(env) {
  return load(planDb(env));
}

/** Calendar I/O never overwrites account, ledger, or commitment fields.
 * @param {Env} env @param {string} id @param {any} patch */
export async function updatePlanCalendar(env, id, patch) {
  return executePlanCommand(
    env,
    { op: '_calendar', id, payload: patch, commandId: crypto.randomUUID() },
    Date.now(),
    { internal: true },
  );
}
