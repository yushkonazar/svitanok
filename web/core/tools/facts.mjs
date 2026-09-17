// facts.get / facts.set (07-schema §4): локальні факти про власника в D1
// `facts` (07 §1). set - T0 (запис у ВЛАСНУ базу, не назовні; кнопка «↩» -
// справа policy у PR-8, тут лише дані). Обидва падають явно без привʼязки DB.

/** kind-и таблиці facts - дослівно 07 §1. */
export const FACT_KINDS = [
  'profile',
  'habit',
  'contact',
  'place',
  'vehicle',
  'setting',
  'inferred',
];

/** Canonical provenance classes. `owner`/`inferred` are compatibility aliases. */
export const FACT_SOURCES = ['owner_assertion', 'observed_event', 'model_hypothesis'];

/** @param {unknown} source */
export function normalizeFactSource(source) {
  if (source === 'owner' || source === 'owner_assertion') return 'owner_assertion';
  if (source === 'inferred' || source === 'model_hypothesis' || source == null)
    return 'model_hypothesis';
  if (source === 'observed_event') return 'observed_event';
  return null;
}

/** @param {unknown} source */
export function isOwnerAssertion(source) {
  return normalizeFactSource(source) === 'owner_assertion';
}

const MAX_FACTS_LIST = 100;

/** @param {Env} env */
function db(env) {
  if (!env.DB) throw new Error('привʼязки DB немає - facts недоступні');
  return env.DB;
}

/**
 * facts.get: за kind (усі ключі виду) або kind+key (один факт).
 * @param {Env} env
 * @param {{ kind?: string, key?: string }} args
 */
export async function runFactsGet(env, args) {
  if (args.kind != null && !FACT_KINDS.includes(args.kind)) {
    throw new Error(`невідомий kind "${args.kind}"`);
  }
  const where = [];
  const binds = [];
  if (args.kind != null) {
    where.push('kind = ?');
    binds.push(args.kind);
  }
  if (args.key != null) {
    if (!args.key) throw new Error('key не може бути порожнім');
    where.push('key = ?');
    binds.push(args.key);
  }
  const sql = `SELECT id, kind, key, value_json, source, confidence, observed_at, expires_at, review_at, supersedes, created_at, updated_at FROM facts
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY kind, key LIMIT ${MAX_FACTS_LIST}`;
  const rows =
    (
      await db(env)
        .prepare(sql)
        .bind(...binds)
        .all()
    ).results ?? [];
  return {
    result: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      key: r.key,
      value: safeParse(String(r.value_json)),
      source: normalizeFactSource(r.source) ?? 'model_hypothesis',
      confidence: r.confidence == null ? null : Number(r.confidence),
      observed_at: r.observed_at ?? null,
      expires_at: r.expires_at ?? null,
      review_at: r.review_at ?? null,
      supersedes: r.supersedes ?? null,
      created_at: r.created_at,
      updated_at: r.updated_at,
    })),
  };
}

/**
 * facts.set: upsert за (kind, key). value - будь-який JSON-сумісний; source
 * has canonical provenance. Legacy owner|inferred aliases are accepted only
 * for compatibility; model output defaults to model_hypothesis.
 * @param {Env} env
 * `confidence` and temporal fields are optional. Omitted metadata preserves an
 * existing fact's values, so legacy writers do not silently erase provenance.
 * The API deliberately has no "clear" sentinel yet: removal will be a ledgered
 * owner action, not an accidental `null` from a model/tool.
 * @param {{ kind: string, key: string, value: unknown, source?: string,
 *   confidence?: number, observed_at?: string, expires_at?: string,
 *   review_at?: string, supersedes?: string }} args
 * @param {number} nowMs
 */
export async function runFactsSet(env, args, nowMs) {
  if (!FACT_KINDS.includes(args.kind)) throw new Error(`невідомий kind "${args.kind}"`);
  if (!args.key) throw new Error('key не може бути порожнім');
  const source = normalizeFactSource(args.source);
  if (!source) throw new Error(`невідоме provenance source: "${String(args.source)}"`);
  const confidence = normalizeConfidence(args.confidence);
  const observedAt = normalizeTimestamp(args.observed_at, 'observed_at');
  const expiresAt = normalizeTimestamp(args.expires_at, 'expires_at');
  const reviewAt = normalizeTimestamp(args.review_at, 'review_at');
  const supersedes = normalizeSupersedes(args.supersedes);

  // A partial update inherits the older temporal contract. Validate the
  // effective values before writing; otherwise moving observed_at forward
  // could make an existing expiration precede the observation.
  let current = null;
  if (observedAt !== undefined || expiresAt !== undefined || reviewAt !== undefined) {
    current = (await runFactsGet(env, { kind: args.kind, key: args.key })).result[0] ?? null;
  }
  const existingObservedAt = typeof current?.observed_at === 'string' ? current.observed_at : null;
  const existingExpiresAt = typeof current?.expires_at === 'string' ? current.expires_at : null;
  const existingReviewAt = typeof current?.review_at === 'string' ? current.review_at : null;
  const effectiveObservedAt = observedAt ?? existingObservedAt;
  const effectiveExpiresAt = expiresAt ?? existingExpiresAt;
  const effectiveReviewAt = reviewAt ?? existingReviewAt;
  assertAfterObservation('expires_at', effectiveExpiresAt, effectiveObservedAt);
  assertAfterObservation('review_at', effectiveReviewAt, effectiveObservedAt);

  const iso = new Date(nowMs).toISOString();
  await db(env)
    .prepare(
      `INSERT INTO facts (
         id, kind, key, value_json, source, confidence, observed_at, expires_at, review_at, supersedes,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (kind, key) DO UPDATE SET
         value_json = excluded.value_json, source = excluded.source,
         confidence = COALESCE(excluded.confidence, facts.confidence),
         observed_at = COALESCE(excluded.observed_at, facts.observed_at),
         expires_at = COALESCE(excluded.expires_at, facts.expires_at),
         review_at = COALESCE(excluded.review_at, facts.review_at),
         supersedes = COALESCE(excluded.supersedes, facts.supersedes),
         updated_at = excluded.updated_at`,
    )
    .bind(
      crypto.randomUUID(),
      args.kind,
      args.key,
      JSON.stringify(args.value ?? null),
      source,
      confidence ?? null,
      observedAt ?? null,
      expiresAt ?? null,
      reviewAt ?? null,
      supersedes ?? null,
      iso,
      iso,
    )
    .run();
  return { result: { saved: true, kind: args.kind, key: args.key } };
}

/**
 * Restore one pre-policy snapshot exactly. This is intentionally separate from
 * `runFactsSet`: its public compatibility behaviour treats omitted metadata as
 * "preserve", whereas undo must also restore fields that were previously null.
 * Only the policy executor calls it with a snapshot it read from this module.
 * @param {Env} env
 * @param {{ id: string, kind: string, key: string, value: unknown, source: string,
 *   confidence: number | null, observed_at: string | null, expires_at: string | null,
 *   review_at: string | null, supersedes: string | null, created_at: string }} snapshot
 * @param {number} nowMs
 */
export async function restoreFactsSnapshot(env, snapshot, nowMs) {
  if (!FACT_KINDS.includes(snapshot.kind)) throw new Error(`невідомий kind "${snapshot.kind}"`);
  if (!snapshot.key) throw new Error('key не може бути порожнім');
  const source = normalizeFactSource(snapshot.source);
  if (!source) throw new Error('snapshot містить невідоме provenance source');
  const confidence = snapshot.confidence == null ? null : normalizeConfidence(snapshot.confidence);
  const observedAt = normalizeSnapshotTimestamp(snapshot.observed_at, 'observed_at') ?? null;
  const expiresAt = normalizeSnapshotTimestamp(snapshot.expires_at, 'expires_at') ?? null;
  const reviewAt = normalizeSnapshotTimestamp(snapshot.review_at, 'review_at') ?? null;
  const supersedes = normalizeSnapshotSupersedes(snapshot.supersedes);
  assertAfterObservation('expires_at', expiresAt, observedAt);
  assertAfterObservation('review_at', reviewAt, observedAt);
  const createdAt = normalizeTimestamp(snapshot.created_at, 'created_at');
  if (createdAt === undefined) throw new Error('snapshot не містить created_at');
  const iso = new Date(nowMs).toISOString();
  await db(env)
    .prepare(
      `INSERT INTO facts (
         id, kind, key, value_json, source, confidence, observed_at, expires_at, review_at, supersedes,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (kind, key) DO UPDATE SET
         value_json = excluded.value_json, source = excluded.source, confidence = excluded.confidence,
         observed_at = excluded.observed_at, expires_at = excluded.expires_at,
         review_at = excluded.review_at, supersedes = excluded.supersedes,
         updated_at = excluded.updated_at`,
    )
    .bind(
      snapshot.id,
      snapshot.kind,
      snapshot.key,
      JSON.stringify(snapshot.value ?? null),
      source,
      confidence ?? null,
      observedAt,
      expiresAt,
      reviewAt,
      supersedes,
      createdAt,
      iso,
    )
    .run();
}

/** @param {unknown} value */
function normalizeConfidence(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('confidence має бути числом від 0 до 1');
  }
  return value;
}

/** @param {unknown} value @param {'created_at' | 'observed_at' | 'expires_at' | 'review_at'} field */
function normalizeTimestamp(value, field) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > 40) {
    throw new Error(`${field} має бути ISO-8601 датою`);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`${field} має бути ISO-8601 датою`);
  return new Date(ms).toISOString();
}

/** @param {string | null} value @param {'observed_at' | 'expires_at' | 'review_at'} field */
function normalizeSnapshotTimestamp(value, field) {
  return value == null ? null : normalizeTimestamp(value, field);
}

/** @param {unknown} value */
function normalizeSupersedes(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 64) {
    throw new Error('supersedes має бути непорожнім id факту до 64 символів');
  }
  return value.trim();
}

/** @param {string | null} value */
function normalizeSnapshotSupersedes(value) {
  return value == null ? null : (normalizeSupersedes(value) ?? null);
}

/** @param {'expires_at' | 'review_at'} field @param {string | null} candidate @param {string | null} observed */
function assertAfterObservation(field, candidate, observed) {
  if (candidate != null && observed != null && Date.parse(candidate) < Date.parse(observed)) {
    throw new Error(`${field} не може бути раніше observed_at`);
  }
}

/** @param {string} raw */
function safeParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null; // бите value_json - чесний null, не виняток на читанні
  }
}
