import {
  bookmarkCommand,
  bookmarkHash,
  BookmarkError,
  ideaVersion,
  ideaSource,
  bookmarkMeta,
  changedBookmarkTags,
  briefDocuments,
  ideaGptPrompt,
} from './bookmark-model.mjs';
import { IDEA_STATUSES } from './registry.mjs';
import { ideaEcosystemContext } from './ecosystem.mjs';
import { kyivDateKey } from '../../kyiv-time.mjs';

/** @param {Env} env */
function db(env) {
  if (!env.DB) throw new BookmarkError('Закладки зараз недоступні.', 503);
  return env.DB;
}
const fields = [
  'title',
  'body_md',
  'domain',
  'status',
  'priority',
  'effort',
  'next_action',
  'tags_json',
  'analysis_md',
  'plan_md',
  'plan_approved_at',
  'repo',
  'head_sha',
  'artifact_drive_id',
  'updated_at',
];
/** Exact comparisons also detect legacy edits that share a millisecond timestamp.
 * @param {any} row */
function cas(row) {
  return {
    where: 'id = ? AND ' + fields.map((key) => `${key} IS ?`).join(' AND '),
    values: [row.id, ...fields.map((key) => row[key] ?? null)],
  };
}
/** @param {Env} env @param {string} id */
async function rowFor(env, id) {
  const row = await db(env)
    .prepare("SELECT * FROM ideas WHERE id=? AND domain='svitanok'")
    .bind(id)
    .first();
  if (!row) throw new BookmarkError('Цієї закладки вже немає.', 404);
  return row;
}
/** @param {any} row */
async function item(row) {
  return {
    id: row.id,
    number: row.number,
    title: row.title,
    body: row.body_md ?? '',
    status: row.status,
    priority: row.priority ?? 2,
    ...bookmarkMeta(row),
    version: await ideaVersion(row),
    sourceHash: await bookmarkHash(ideaSource(row)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    analysis: row.analysis_md ?? null,
    plan: row.plan_md ?? null,
  };
}
/** @param {any} row */
function formulation(row) {
  const result = row.result_json ? JSON.parse(row.result_json) : null,
    source = JSON.parse(row.source_json);
  return {
    id: row.id,
    ideaId: row.idea_id,
    sourceHash: row.source_hash,
    status: row.status,
    contextVersion: row.context_version,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    error: row.error,
    revision: row.revision,
    published: Boolean(row.published),
    result,
    source: { title: source.title, body: source.body_md ?? '' },
    prompt:
      row.custom_prompt ??
      (result
        ? ideaGptPrompt(
            { title: source.title, body: source.body_md ?? '' },
            result,
            row.context_version ?? '',
          )
        : null),
    customPrompt: row.custom_prompt != null,
  };
}
/** @param {Env} env @param {string} id @param {string|undefined} [before] */
export async function readBookmark(env, id, before) {
  const idea = await rowFor(env, id);
  let cursor;
  if (before) {
    try {
      cursor = JSON.parse(before);
    } catch {
      throw new BookmarkError('Некоректна сторінка версій.');
    }
    if (
      !cursor ||
      typeof cursor.at !== 'string' ||
      typeof cursor.id !== 'string' ||
      cursor.id.length > 100
    )
      throw new BookmarkError('Некоректна сторінка версій.');
  }
  const rows = await db(env)
    .prepare(
      'SELECT * FROM idea_formulations WHERE idea_id=? AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC,id DESC LIMIT 11',
    )
    .bind(id, cursor?.at ?? '9999', cursor?.at ?? '9999', cursor?.id ?? '\uffff')
    .all();
  const tail = rows.results[9];
  return {
    item: await item(idea),
    formulations: rows.results.slice(0, 10).map(formulation),
    historyCursor:
      rows.results.length > 10 && tail
        ? JSON.stringify({ at: tail.created_at, id: tail.id })
        : null,
  };
}
/** @param {Env} env @param {{q?:string,status?:string,cursor?:string}} [query] */
export async function readBookmarks(env, query = {}) {
  const q = query.q?.trim() ?? '',
    status = query.status ?? 'active';
  if (q.length > 120 || !['active', 'all', ...IDEA_STATUSES].includes(status))
    throw new BookmarkError('Некоректний фільтр закладок.');
  const where = ["domain='svitanok'"];
  /** @type {any[]} */ const binds = [];
  if (status === 'active') where.push("status NOT IN ('зроблено','відхилено')");
  else if (status !== 'all') {
    where.push('status=?');
    binds.push(status);
  }
  if (q) {
    const words = q
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 8)
      .map((word) => '"' + word.replaceAll('"', '') + '"')
      .join(' ');
    if (words) {
      where.push('id IN (SELECT id FROM ideas_fts WHERE ideas_fts MATCH ?)');
      binds.push(words);
    }
  }
  if (query.cursor) {
    let c;
    try {
      c = JSON.parse(query.cursor);
    } catch {
      throw new BookmarkError('Некоректна сторінка закладок.');
    }
    if (
      !c ||
      typeof c.at !== 'string' ||
      !Number.isFinite(Date.parse(c.at)) ||
      typeof c.id !== 'string' ||
      c.id.length > 100
    )
      throw new BookmarkError('Некоректна сторінка закладок.');
    where.push('(updated_at < ? OR (updated_at = ? AND id < ?))');
    binds.push(c.at, c.at, c.id);
  }
  const rows = await db(env)
    .prepare(
      `SELECT * FROM ideas WHERE ${where.join(' AND ')} ORDER BY updated_at DESC,id DESC LIMIT 31`,
    )
    .bind(...binds)
    .all();
  const items = await Promise.all(
    rows.results.slice(0, 30).map(async (row) => {
      const full = await item(row);
      return { ...full, body: full.body.slice(0, 280), analysis: undefined, plan: undefined };
    }),
  );
  const tail = rows.results[29];
  return {
    items,
    cursor:
      rows.results.length > 30 && tail
        ? JSON.stringify({ at: tail.updated_at, id: tail.id })
        : null,
    context: ideaEcosystemContext().version,
  };
}
/** @param {Env} env @param {any} raw @param {number} [nowMs] */
export async function changeBookmark(env, raw, nowMs = Date.now()) {
  const command = bookmarkCommand(raw),
    database = db(env),
    hash = await bookmarkHash(command),
    now = new Date(nowMs).toISOString();
  const prior = await database
    .prepare('SELECT fingerprint,receipt_json FROM idea_bookmark_commands WHERE id=?')
    .bind(command.commandId)
    .first();
  if (prior) {
    if (prior.fingerprint !== hash)
      throw new BookmarkError('Ця спроба вже використана для іншого запису.', 409);
    return JSON.parse(String(prior.receipt_json));
  }
  const p = command.payload;
  const idea = command.op === 'create' ? null : await rowFor(env, command.id);
  if (idea && (await ideaVersion(idea)) !== command.version)
    throw new BookmarkError(
      'Запис уже змінився. Твій текст залишився у формі; онови дані й перенеси уточнення.',
      409,
    );
  const id = idea?.id ?? `idea-${command.commandId}`,
    guard = () =>
      database
        .prepare(
          'INSERT INTO idea_bookmark_guards(id,valid) VALUES(?,CASE WHEN changes()=1 THEN 1 ELSE 0 END)',
        )
        .bind(command.commandId);
  /** @type {D1PreparedStatement[]} */ const batch = [];
  const receipt = {
    id,
    message: 'Закладку збережено.',
    formulationId: /** @type {string|null} */ (null),
  };
  if (command.op === 'create') {
    batch.push(
      database.prepare("UPDATE counters SET value=value+1 WHERE name='ideas'").bind(),
      guard(),
    );
    batch.push(
      database
        .prepare(
          "INSERT INTO ideas(id,number,title,body_md,domain,status,priority,tags_json,created_at,updated_at) VALUES(?,(SELECT value FROM counters WHERE name='ideas'),?,?,'svitanok','нова',2,?,?,?)",
        )
        .bind(id, p.title, p.body, changedBookmarkTags({}, p), now, now),
    );
    batch.push(
      database
        .prepare('INSERT INTO ideas_fts(id,title,body_md) VALUES(?,?,?)')
        .bind(id, p.title, p.body),
    );
  } else if (command.op === 'edit' || command.op === 'status') {
    const lock = cas(idea);
    batch.push(
      command.op === 'edit'
        ? database
            .prepare(
              `UPDATE ideas SET title=?,body_md=?,tags_json=?,updated_at=? WHERE ${lock.where}`,
            )
            .bind(p.title, p.body, changedBookmarkTags(idea, p), now, ...lock.values)
        : database
            .prepare(
              `UPDATE ideas SET status=?,plan_approved_at=?,updated_at=? WHERE ${lock.where}`,
            )
            .bind(
              p.status,
              p.status === 'погоджено' ? now : idea?.plan_approved_at,
              now,
              ...lock.values,
            ),
      guard(),
    );
    if (command.op === 'edit')
      batch.push(
        database.prepare('DELETE FROM ideas_fts WHERE id=?').bind(id),
        database
          .prepare('INSERT INTO ideas_fts(id,title,body_md) VALUES(?,?,?)')
          .bind(id, p.title, p.body),
      );
  } else if (command.op === 'formulate') {
    if (!env.OPENAI_API_KEY || !env.IDEA_FORMULATION)
      throw new BookmarkError(
        'Формування помічником зараз недоступне. Запис можна зберігати та копіювати вручну.',
        503,
      );
    if (idea?.status === 'в аналізі')
      throw new BookmarkError(
        'Ідея вже аналізується асистентом. Дочекайся результату або явно зміни її статус.',
        409,
      );
    const active = await database
      .prepare(
        "SELECT id FROM idea_formulations WHERE idea_id=? AND status IN ('queued','running')",
      )
      .bind(id)
      .first();
    if (active)
      throw new BookmarkError('Ця закладка вже формується. Результат з’явиться тут.', 409);
    const lock = cas(idea);
    batch.push(
      database
        .prepare(`UPDATE ideas SET updated_at=updated_at WHERE ${lock.where}`)
        .bind(...lock.values),
      guard(),
    );
    const day = kyivDateKey(new Date(nowMs));
    batch.push(
      database
        .prepare(
          'INSERT INTO quota_counters(key,period,value,limit_value,updated_at) VALUES(?,?,1,15,?) ON CONFLICT(key,period) DO UPDATE SET value=quota_counters.value+1,updated_at=excluded.updated_at WHERE quota_counters.value<15',
        )
        .bind(`idea_formulations:${day}`, day.slice(0, 7), now),
      database
        .prepare(
          'INSERT INTO idea_bookmark_guards(id,valid) VALUES(?,CASE WHEN changes()=1 THEN 1 ELSE 0 END)',
        )
        .bind(command.commandId + '-quota'),
    );
    receipt.formulationId = command.commandId;
    receipt.message = 'Запит прийнято. Можна закрити сторінку — результат залишиться у закладці.';
    batch.push(
      database
        .prepare(
          "INSERT INTO idea_formulations(id,idea_id,source_hash,source_json,source_version,status,created_at) VALUES(?,?,?,?,?,'queued',?)",
        )
        .bind(
          command.commandId,
          id,
          await bookmarkHash(ideaSource(idea)),
          JSON.stringify(idea),
          command.version,
          now,
        ),
    );
  } else if (command.op === 'save-prompt') {
    batch.push(
      database
        .prepare(
          "UPDATE idea_formulations SET custom_prompt=?,revision=revision+1 WHERE id=? AND idea_id=? AND status='ready' AND revision=?",
        )
        .bind(p.prompt, p.formulationId, id, p.revision),
      guard(),
    );
    receipt.message = 'Текст для GPT збережено.';
  }
  batch.push(
    database
      .prepare('INSERT INTO idea_events(id,idea_id,at,kind,note) VALUES(?,?,?,?,?)')
      .bind(
        command.commandId,
        id,
        now,
        command.op === 'formulate'
          ? 'analysis'
          : command.op === 'status'
            ? 'status'
            : command.op === 'create'
              ? 'created'
              : 'edit',
        `Закладки Mini App: ${command.op}`,
      ),
  );
  batch.push(
    database
      .prepare(
        'INSERT INTO idea_bookmark_commands(id,fingerprint,receipt_json,created_at) VALUES(?,?,?,?)',
      )
      .bind(command.commandId, hash, JSON.stringify(receipt), now),
    database
      .prepare('DELETE FROM idea_bookmark_guards WHERE id IN (?,?)')
      .bind(command.commandId, command.commandId + '-quota'),
  );
  try {
    await database.batch(batch);
  } catch (error) {
    const saved = await database
      .prepare('SELECT fingerprint,receipt_json FROM idea_bookmark_commands WHERE id=?')
      .bind(command.commandId)
      .first();
    if (saved?.fingerprint === hash) return JSON.parse(String(saved.receipt_json));
    if (
      /idea_formulations_active|UNIQUE constraint.*idea_formulations.idea_id/i.test(String(error))
    )
      throw new BookmarkError('Ця закладка вже формується.', 409);
    if (/idea_bookmark_guards|CHECK constraint/i.test(String(error))) {
      const day = kyivDateKey(new Date(nowMs));
      const quota = await database
        .prepare('SELECT value FROM quota_counters WHERE key=? AND period=?')
        .bind(`idea_formulations:${day}`, day.slice(0, 7))
        .first();
      if (command.op === 'formulate' && Number(quota?.value) >= 15)
        throw new BookmarkError(
          'Сьогодні вже використано 15 формувань. Збереження й ручне редагування доступні.',
          429,
        );
      throw new BookmarkError('Запис уже змінився. Онови його перед повтором.', 409);
    }
    throw error;
  }
  return receipt;
}
/** A failed/uncertain dispatch is terminal unless the workflow already claimed it.
 * @param {Env} env @param {string} id */
export async function startBookmarkFormulation(env, id) {
  const row = await db(env)
    .prepare('SELECT status FROM idea_formulations WHERE id=?')
    .bind(id)
    .first();
  if (!row || row.status !== 'queued') return;
  try {
    await env.IDEA_FORMULATION?.create({ id, params: { requestId: id } });
  } catch {
    try {
      const instance = await env.IDEA_FORMULATION?.get(id);
      if (instance) {
        await instance.status();
        return;
      }
    } catch {
      /* Confirmed neither way: no duplicate model request. */
    }
    await db(env)
      .prepare(
        "UPDATE idea_formulations SET status='failed',error=?,finished_at=? WHERE id=? AND status='queued'",
      )
      .bind(
        'Не вдалося запустити формування. Запис збережено; можна повторити.',
        new Date().toISOString(),
        id,
      )
      .run();
  }
}
/** @param {Env} env @param {string} id @param {any} brief @param {number} [nowMs] */
export async function finishBookmarkFormulation(env, id, brief, nowMs = Date.now()) {
  const database = db(env),
    row = await database.prepare('SELECT * FROM idea_formulations WHERE id=?').bind(id).first();
  if (!row || row.status === 'ready') return;
  if (row.status !== 'running') throw new BookmarkError('Це формування вже не активне.', 409);
  const source = JSON.parse(String(row.source_json)),
    lock = cas(source),
    docs = briefDocuments(brief),
    now = new Date(nowMs).toISOString(),
    publish = ['нова', 'план готовий', 'відкладено'].includes(source.status);
  const batch = [
    database
      .prepare(
        "UPDATE idea_formulations SET status='ready',result_json=?,context_version=?,finished_at=?,revision=revision+1 WHERE id=? AND status='running'",
      )
      .bind(JSON.stringify(brief), ideaEcosystemContext().version, now, id),
    database
      .prepare(
        'INSERT INTO idea_bookmark_guards(id,valid) VALUES(?,CASE WHEN changes()=1 THEN 1 ELSE 0 END)',
      )
      .bind(id + '-finish'),
  ];
  batch.push(
    database
      .prepare(
        `UPDATE ideas SET analysis_md=?,plan_md=?,status=?,updated_at=? WHERE ${lock.where} AND ?=1`,
      )
      .bind(
        docs.analysis,
        docs.plan,
        source.status === 'відкладено' ? 'відкладено' : 'план готовий',
        now,
        ...lock.values,
        Number(publish),
      ),
  );
  batch.push(
    database
      .prepare(
        'UPDATE idea_formulations SET published=CASE WHEN changes()=1 THEN 1 ELSE 0 END WHERE id=?',
      )
      .bind(id),
    database
      .prepare('INSERT OR IGNORE INTO idea_events(id,idea_id,at,kind,note) VALUES(?,?,?,?,?)')
      .bind(id + '-ready', row.idea_id, now, 'plan', 'Сформовано пропозицію в закладках Mini App'),
    database.prepare('DELETE FROM idea_bookmark_guards WHERE id=?').bind(id + '-finish'),
  );
  await database.batch(batch);
}
