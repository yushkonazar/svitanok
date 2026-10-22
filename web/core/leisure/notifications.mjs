import { readLeisureWorkspace, leisureSettings, leisureDb } from './store.mjs';
import { leisureWeek, leisureId } from './model.mjs';
import { leisureIdentity, leisureReactionHidden } from './identity.mjs';
import { assistantHomeTarget } from '../tg/home.mjs';
import { kyivHour, kyivDateKey } from '../../kyiv-time.mjs';
import { selectLeisureHighlights } from './selection.mjs';
/** @param {Env} env @param {number} chatId */
function button(env, chatId) {
  const text = 'Відкрити дозвілля',
    name = String(env.TELEGRAM_BOT_USERNAME ?? '').replace(/^@/, '');
  if (/^[A-Za-z0-9_]{5,32}$/.test(name))
    return { text, url: 'https://t.me/' + name + '?startapp=leisure' };
  if (!env.MINI_APP_URL || chatId <= 0) return null;
  try {
    const url = new URL(env.MINI_APP_URL);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    url.hash = '/leisure';
    return { text, web_app: { url: url.href } };
  } catch {
    return null;
  }
}
/** A deterministic outbox ID makes weekly collection retries one delivery.
 * @param {Env} env @param {number} nowMs */
export async function queueLeisureDigest(env, nowMs) {
  const settings = await leisureSettings(env),
    target = assistantHomeTarget(env);
  if (
    !settings.enabled ||
    !settings.telegram ||
    !target ||
    kyivHour(new Date(nowMs)) < settings.updateHour
  )
    return false;
  const workspace = await readLeisureWorkspace(env, nowMs, true),
    week = leisureWeek(nowMs);
  if (workspace.edition?.week !== week) return false;
  const decisions = new Set(
    workspace.records.flatMap((r) =>
      r.itemId &&
      (r.kind === 'visit' ||
        (r.kind === 'familiarity' && !r.cleared) ||
        (r.kind === 'reaction' && (r.verdict === 'interested' || leisureReactionHidden(r, nowMs))))
        ? [r.itemId]
        : [],
    ),
  );
  const oldKeys = new Set(
    workspace.items
      .filter((i) => decisions.has(i.id))
      .map((i) => i.identityKey ?? leisureIdentity(i)),
  );
  const fresh = selectLeisureHighlights(
    workspace.items.filter(
      (i) =>
        (!workspace.edition?.highlightIds?.length ||
          workspace.edition.highlightIds.includes(i.id)) &&
        !oldKeys.has(i.identityKey ?? leisureIdentity(i)) &&
        kyivDateKey(new Date(i.firstDiscoveredAt ?? i.checkedAt)) >= week &&
        (workspace.edition?.ids.includes(i.id) || workspace.edition?.futureIds.includes(i.id)),
    ),
    [
      ...(workspace.discoveryDecisions ?? []).map((/** @type {any} */ r) => ({
        ...r,
        kind: 'discovery',
      })),
      ...workspace.records,
    ],
    workspace.settings,
    nowMs,
  );
  if (!fresh.length) return false;
  const counts = /** @type {Record<string,number>} */ ({});
  const labels = /** @type {Record<string,string>} */ ({
    food: 'заклади',
    place: 'місця й музеї',
    trip: 'прогулянки й поїздки',
    cinema: 'кіно',
    podcast: 'подкасти',
  });
  for (const item of fresh) {
    const family = labels[item.category] ?? 'події';
    counts[family] = (counts[family] ?? 0) + 1;
  }
  const text = [
    'Нове для тебе · дозвілля',
    '',
    ...Object.entries(counts).map(([label, n]) => label + ': ' + n),
    '',
    'Коротка добірка нових ідей. Заклади доступні окремим каталогом; обери бажане й сплануй час разом.',
  ].join('\n');
  const link = button(env, target.chatId),
    id = 'leisure-digest-' + week;
  const payload = {
    text,
    leisure_digest: { week },
    delivery_safety: 'at-most-once',
    ...(link ? { reply_markup: { inline_keyboard: [[link]] } } : {}),
  };
  return enqueueLeisureNotice(env, id, payload, { week }, nowMs, target);
}
/** @param {Env} env @param {string} id @param {any} payload @param {any} marker @param {number} nowMs @param {any} target */
async function enqueueLeisureNotice(env, id, payload, marker, nowMs, target) {
  const db = leisureDb(env),
    at = new Date(nowMs).toISOString();
  const results = await db.batch([
    db
      .prepare(
        "INSERT INTO outbox(id,chat_id,thread_id,kind,payload_json,attempts,next_at,status) SELECT ?,?,?,'send',?,0,?,'pending' WHERE NOT EXISTS(SELECT 1 FROM leisure_records WHERE id=?) ON CONFLICT(id) DO NOTHING",
      )
      .bind(
        id,
        String(target.chatId),
        target.threadId == null ? null : String(target.threadId),
        JSON.stringify(payload),
        at,
        id,
      ),
    db
      .prepare(
        "INSERT INTO leisure_records(id,kind,data_json,updated_at) SELECT ?,'system',?,? WHERE EXISTS(SELECT 1 FROM outbox WHERE id=?) ON CONFLICT(id) DO NOTHING",
      )
      .bind(id, JSON.stringify({ ...marker, queuedAt: at }), at, id),
  ]);
  return Number(results[0]?.meta?.changes ?? 0) > 0;
}
/** @param {Env} env @param {any} notice @param {number} nowMs */
export async function leisureDigestCurrent(env, notice, nowMs) {
  const settings = await leisureSettings(env);
  if (!settings.enabled || !settings.telegram || notice?.week !== leisureWeek(nowMs)) return false;
  return !!(await leisureDb(env)
    .prepare('SELECT week FROM leisure_editions WHERE week=?')
    .bind(notice.week)
    .first());
}
/** @param {Env} env @param {number} nowMs */
export async function queueLeisurePlanAlerts(env, nowMs) {
  const settings = await leisureSettings(env),
    target = assistantHomeTarget(env);
  if (!settings.enabled || !settings.planAlerts || !target) return 0;
  const workspace = await readLeisureWorkspace(env, nowMs, true);
  let queued = 0;
  for (const plan of workspace.records
    .filter((r) => r.kind === 'plan' && r.status === 'planned' && r.alerts?.length)
    .slice(0, 10)) {
    const signature = await leisureId('change', JSON.stringify(plan.alerts)),
      id = 'leisure-plan-alert-' + plan.id + '-' + plan.revision + '-' + signature;
    const link = button(env, target.chatId),
      notice = { planId: plan.id, revision: plan.revision, signature };
    const payload = {
      text: [
        'Змінився твій план дозвілля',
        '',
        plan.title,
        ...plan.alerts,
        '',
        'Відкрий план і звір актуальні умови. Збережений план і календар автоматично не змінювалися.',
      ].join('\n'),
      leisure_plan_alert: notice,
      delivery_safety: 'at-most-once',
      ...(link ? { reply_markup: { inline_keyboard: [[link]] } } : {}),
    };
    if (await enqueueLeisureNotice(env, id, payload, notice, nowMs, target)) queued++;
  }
  return queued;
}
/** @param {Env} env @param {any} notice @param {number} nowMs */
export async function leisurePlanAlertCurrent(env, notice, nowMs) {
  const workspace = await readLeisureWorkspace(env, nowMs, true);
  if (!workspace.settings.enabled || !workspace.settings.planAlerts) return false;
  const plan = workspace.records.find(
    (r) => r.id === notice?.planId && r.kind === 'plan' && r.status === 'planned',
  );
  return (
    !!plan &&
    plan.revision === notice.revision &&
    plan.alerts.length > 0 &&
    (await leisureId('change', JSON.stringify(plan.alerts))) === notice.signature
  );
}
