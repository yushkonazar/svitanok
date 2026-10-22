import { tripScopeKey } from '../tools/trip.mjs';
import { tripWorkspaceView } from '../tools/trip-workspace.mjs';

/** The API authenticates the primary owner and checks the stored record's chat first.
 * Delete the exact record in one D1 transaction; delayed writers only UPDATE existing rows.
 * @param {Env} env @param {any} row @param {'draft'|'trip'} kind
 * @param {number|undefined} revision @param {{chatId:string,threadId:string|null}} ctx
 */
export async function deleteTravelRecord(env, row, kind, revision, ctx) {
  const db = env.DB;
  if (!db) throw new Error('Сховище подорожей недоступне.');
  if (kind === 'draft') {
    const answers = JSON.parse(String(row.answers_json));
    if (revision !== Number(answers._meta?.revision ?? 0))
      throw new Error('Чернетка змінилася. Онови список перед видаленням.');
    const result = await db
      .prepare(
        `DELETE FROM trip_briefs WHERE id=? AND scope_key=? AND answers_json=? AND status=?
         AND NOT EXISTS (SELECT 1 FROM trips t JOIN chains c ON c.id=t.workflow_id
           WHERE c.kind='trip' AND json_extract(c.state_json,'$.brief_id')=trip_briefs.id)`,
      )
      .bind(row.id, row.scope_key, row.answers_json, row.status)
      .run();
    if (!result.meta?.changes)
      throw new Error('Чернетка змінилася або вже стала поїздкою. Онови список.');
    return { deleted_id: String(row.id), kind };
  }

  const costs = JSON.parse(String(row.cost_json ?? '{}'));
  if (revision !== tripWorkspaceView(costs).revision)
    throw new Error('Поїздка змінилася. Онови список перед видаленням.');
  const state = JSON.parse(String(row.state_json));
  const chainId = String(row.workflow_id);
  const absent = 'NOT EXISTS (SELECT 1 FROM trips WHERE id=?)';
  const outboxJson = "CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END";
  const callbackPrefix = `c:${chainId}:`;
  const statements = [
    db
      .prepare('DELETE FROM trips WHERE id=? AND cost_json IS ? AND status IS ? AND workflow_id=?')
      .bind(row.id, row.cost_json, row.status, chainId),
    db.prepare(`DELETE FROM reminders WHERE chain_id=? AND ${absent}`).bind(chainId, row.id),
    db
      .prepare(
        `DELETE FROM outbox WHERE ${absent} AND (
          json_extract(${outboxJson},'$.trip_notice.trip_id')=? OR
          json_extract(${outboxJson},'$.trip_monitor_notice.trip_id')=? OR
          json_extract(${outboxJson},'$.trip_chain_notice.trip_id')=? OR
          EXISTS (SELECT 1 FROM json_tree(${outboxJson})
            WHERE key='callback_data' AND type='text' AND substr(value,1,?)=?))`,
      )
      .bind(row.id, row.id, row.id, row.id, callbackPrefix.length, callbackPrefix),
    db
      .prepare(
        `DELETE FROM trip_briefs WHERE id=? AND scope_key=? AND ${absent}
         AND NOT EXISTS (SELECT 1 FROM trips t JOIN chains c ON c.id=t.workflow_id
           WHERE c.kind='trip' AND json_extract(c.state_json,'$.brief_id')=trip_briefs.id)`,
      )
      .bind(state.brief_id ?? null, tripScopeKey(ctx), row.id),
    db
      .prepare(
        `DELETE FROM chains WHERE id=? AND kind='trip' AND ${absent}
         AND NOT EXISTS (SELECT 1 FROM trips WHERE workflow_id=chains.id)`,
      )
      .bind(chainId, row.id),
    db
      .prepare(
        `DELETE FROM price_points WHERE wish_id IN (SELECT id FROM wishes WHERE id=?
          AND type='trip' AND json_extract(payload_json,'$.trip_id')=?) AND ${absent}
          AND NOT EXISTS (SELECT 1 FROM trips WHERE wish_id=price_points.wish_id)`,
      )
      .bind(row.wish_id ?? null, row.id, row.id),
    db
      .prepare(
        `DELETE FROM wishes WHERE id=? AND type='trip' AND json_extract(payload_json,'$.trip_id')=?
         AND ${absent} AND NOT EXISTS (SELECT 1 FROM trips WHERE wish_id=wishes.id)`,
      )
      .bind(row.wish_id ?? null, row.id, row.id),
  ];
  const result = await db.batch(statements);
  if (!result[0]?.meta?.changes)
    throw new Error('Поїздка змінилася. Онови список перед видаленням.');

  // The missing rows block delivery even if a completed/unavailable Workflow cannot terminate.
  try {
    const instance = await env.TRIP_CHAIN?.get(String(row.chain_workflow_id ?? chainId));
    await instance?.terminate?.();
  } catch {
    console.error(`trip deletion: Workflow ${chainId} could not be terminated; record is deleted`);
  }
  return { deleted_id: String(row.id), kind };
}

/** Recheck at Telegram delivery time, including messages queued before deletion.
 * @param {Env} env @param {any} notice
 */
export async function tripChainNoticeCurrent(env, notice) {
  if (!env.DB || typeof notice?.trip_id !== 'string' || typeof notice?.chain_id !== 'string')
    return false;
  const row = await env.DB.prepare(
    `SELECT t.cost_json FROM trips t JOIN chains c ON c.id=t.workflow_id
     WHERE t.id=? AND c.id=? AND c.kind='trip'`,
  )
    .bind(notice.trip_id, notice.chain_id)
    .first();
  if (!row) return false;
  const prefs = JSON.parse(String(row.cost_json ?? '{}')).travel?.preferences;
  return !prefs?.paused && prefs?.support_level !== 'plan';
}
