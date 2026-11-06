// A stable period, frozen evidence fingerprint and the bot's own delivery receipt.
// No user task, bank entry, message from another sender or schema is rewritten.
/** @param {any} value @returns {any} */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
/** @param {any} quality */
export async function weeklyEvidenceFingerprint(quality) {
  const d = quality.details;
  const tasks = (/** @type {any} */ list) =>
    list?.map((/** @type {any} */ t) => ({
      id: t.id,
      title: t.title,
      lifecycle: t.lifecycle,
      units: t.units,
      dueAt: t.dueAt,
    }));
  const personal = (/** @type {any} */ period) => ({
    legacy: period?.legacy,
    observationsV2: period?.observationsV2,
    observationsV3: period?.observationsV3,
    weekHighlights: period?.weekHighlights,
  });
  // Operational costs, collection timestamps, model prose and optional warnings are
  // deliberately excluded: another generation is not a new event in the owner's week.
  const data = {
    period: [quality.periodFrom, quality.periodTo],
    status: quality.status === 'failed' ? 'failed' : 'usable',
    plan: d?.plan
      ? {
          summary: d.plan.summary,
          tasks: tasks(d.plan.tasks),
          upcoming: tasks(d.plan.upcomingOutsidePeriod?.tasks),
          overdue: tasks(d.plan.overdueBeforePeriod?.tasks),
        }
      : null,
    personal: d?.personalPeriods
      ? {
          current: personal(d.personalPeriods.current),
          previousWeeks: d.personalPeriods.previousWeeks?.map(personal),
        }
      : null,
    finance: d?.finance
      ? {
          summary: d.finance.summary,
          sourceTotals: d.finance.sourceTotals,
          categories: d.finance.categoryBreakdown,
          upcoming: d.finance.context?.upcoming,
          comparison: {
            complete: d.finance.comparison?.complete,
            averageExpenseMinor: d.finance.comparison?.averageExpenseMinor,
            previousWeek: d.finance.comparison?.previousWeek,
          },
        }
      : null,
    missingCore: [...(quality.overviewMissing ?? [])].sort(),
  };
  return [
    ...new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(JSON.stringify(canonical(data))),
      ),
    ),
  ]
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('');
}
/** @param {unknown} raw */
function parse(raw) {
  try {
    return JSON.parse(String(raw ?? '{}'));
  } catch {
    return {};
  }
}
/** @param {Env} env @param {string} from @param {string} to @param {string} chatId @param {string|null} threadId @param {boolean} [onlyActive] */
async function periodReports(env, from, to, chatId, threadId, onlyActive = false) {
  if (!env.DB) throw new Error('Weekly report storage unavailable');
  const result = await env.DB.prepare(
    `SELECT id,text_md,quality_json FROM reports WHERE kind='weekly'
    AND period_from=? AND period_to=? AND json_extract(CASE WHEN json_valid(quality_json) THEN quality_json ELSE '{}' END,'$.delivery.chatId')=?
    AND COALESCE(json_extract(CASE WHEN json_valid(quality_json) THEN quality_json ELSE '{}' END,'$.delivery.threadId'),'')=?
    AND (?=0 OR COALESCE(json_extract(CASE WHEN json_valid(quality_json) THEN quality_json ELSE '{}' END,'$.delivery.suppressed'),0)=0)
    ORDER BY created_at DESC,id DESC LIMIT 20`,
  )
    .bind(from, to, chatId, threadId ?? '', onlyActive ? 1 : 0)
    .all();
  return (result.results ?? []).map((row) => ({
    id: String(row.id),
    text_md: String(row.text_md ?? ''),
    quality: parse(row.quality_json),
  }));
}
/** @param {Env} env @param {string} runId @param {{chatId:string|number,threadId?:string|number|null}} target @param {any} quality */
export async function prepareWeeklyDelivery(env, runId, target, quality) {
  if (!env.DB) throw new Error('Weekly report storage unavailable');
  const chatId = String(target.chatId),
    threadId = target.threadId == null ? null : String(target.threadId);
  const existing = await env.DB.prepare(
    "SELECT id,text_md,quality_json FROM reports WHERE id=? AND kind='weekly'",
  )
    .bind(`weekly:${runId}`)
    .first();
  const sameRun = existing
    ? {
        id: String(existing.id),
        text_md: String(existing.text_md),
        quality: parse(existing.quality_json),
      }
    : null;
  const active = await periodReports(
    env,
    quality.periodFrom,
    quality.periodTo,
    chatId,
    threadId,
    true,
  );
  const fingerprint = await weeklyEvidenceFingerprint(quality);
  // Compare with the current displayed state, not any matching state in history.
  // A correction A→B→A still needs to update the card displaying B.
  const current =
    active.find((row) => ['ready', 'partial'].includes(row.quality.status)) ?? active[0];
  const matching =
    sameRun ?? (current?.quality.delivery?.fingerprint === fingerprint ? current : undefined);
  let same = null;
  if (matching) {
    const queued = await env.DB.prepare('SELECT status FROM outbox WHERE id=?')
      .bind(`${matching.id}:0`)
      .first();
    // Saving evidence and accepting an outbox item are separate writes. A
    // retry must resume the immutable saved text if the second write failed.
    // A new generation may recover a terminally failed delivery; a repeat of
    // the same run retains its stable outbox identity.
    if (
      matching.quality.delivery?.suppressed ||
      matching.quality.delivery?.delivered ||
      (queued && (sameRun || queued.status !== 'failed'))
    )
      same = matching;
  }
  const failedUpdate =
    quality.status === 'failed' &&
    active.some((row) => ['ready', 'partial'].includes(row.quality.status));
  const receipt = active.find((row) => Number.isSafeInteger(row.quality.delivery?.messageId));
  return {
    suppressed: Boolean(same || failedUpdate),
    previousText: sameRun?.text_md ?? same?.text_md,
    delivery: {
      chatId,
      threadId,
      fingerprint: sameRun?.quality.delivery?.fingerprint ?? fingerprint,
      suppressed: Boolean(same || failedUpdate),
      ...(receipt ? { messageId: receipt.quality.delivery.messageId } : {}),
    },
  };
}
/** At dispatch time, obsolete queued revisions disappear. If a previous revision
 * was sent while this one waited for 429/backoff, update that message instead.
 * @param {Env} env @param {string} id @param {string} chatId @param {string|null} threadId */
export async function weeklyDispatch(env, id, chatId, threadId) {
  if (!env.DB) throw new Error('Weekly report storage unavailable');
  const row = await env.DB.prepare(
    `SELECT period_from,period_to,quality_json FROM reports WHERE id=? AND kind='weekly'`,
  )
    .bind(id)
    .first();
  const quality = parse(row?.quality_json);
  if (
    !row ||
    quality.delivery?.chatId !== chatId ||
    (quality.delivery?.threadId ?? null) !== threadId
  )
    return null;
  const reports = await periodReports(
    env,
    String(row.period_from),
    String(row.period_to),
    chatId,
    threadId,
    true,
  );
  if (reports.find((r) => !r.quality.delivery?.suppressed)?.id !== id) return null;
  const receipt = reports.find((r) => Number.isSafeInteger(r.quality.delivery?.messageId));
  return { messageId: receipt?.quality.delivery.messageId ?? null };
}
/** @param {Env} env @param {string} id @param {number} messageId @param {string} chatId @param {string|null} threadId */
export async function recordWeeklyDelivery(env, id, messageId, chatId, threadId) {
  if (!env.DB) throw new Error('Weekly report storage unavailable');
  await env.DB.prepare(
    `UPDATE reports SET quality_json=json_set(quality_json,
    '$.delivery.messageId',?,'$.delivery.chatId',?,'$.delivery.threadId',?,
    '$.delivery.delivered',json('true')) WHERE id=? AND kind='weekly'`,
  )
    .bind(messageId, chatId, threadId, id)
    .run();
}
