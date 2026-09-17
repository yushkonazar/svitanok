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
const MAX_FACT_LEDGER_LIST = 50;

/** @param {Env} env */
function db(env) {
  if (!env.DB) throw new Error('привʼязки DB немає - facts недоступні');
  return env.DB;
}

/**
 * facts.get: за kind (усі ключі виду) або kind+key (один факт).
 * @param {Env} env
 * @param {{ kind?: string, key?: string }} args
 * @param {number} [nowMs]
 */
export async function runFactsGet(env, args, nowMs = Date.now()) {
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
    result: rows.map((r) => {
      const expiresAt = r.expires_at ?? null;
      const reviewAt = r.review_at ?? null;
      return {
        id: r.id,
        kind: r.kind,
        key: r.key,
        value: safeParse(String(r.value_json)),
        source: normalizeFactSource(r.source) ?? 'model_hypothesis',
        confidence: r.confidence == null ? null : Number(r.confidence),
        observed_at: r.observed_at ?? null,
        expires_at: expiresAt,
        review_at: reviewAt,
        // A stale/review-due fact remains visible for correction and ledger
        // history, but the caller can no longer present it as current truth.
        stale: isDue(expiresAt, nowMs),
        review_due: isDue(reviewAt, nowMs),
        supersedes: r.supersedes ?? null,
        created_at: r.created_at,
        updated_at: r.updated_at,
      };
    }),
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
 *   review_at?: string, supersedes?: string, why?: string }} args
 * @param {number} nowMs
 * @param {{ actor?: 'model' | 'owner' | 'trusted_server' | 'undo', tainted?: boolean,
 *   why?: string, operation?: 'created' | 'updated' | 'restored' }} [ledgerContext]
 */
export async function runFactsSet(env, args, nowMs, ledgerContext = undefined) {
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
  // Читаємо завжди: і для успадкування часових полів, і щоб факт зберігав
  // сталий id у ledger після кожної правки (UNIQUE(kind,key) сам id не вертає).
  const current = (await runFactsGet(env, { kind: args.kind, key: args.key })).result[0] ?? null;
  if (current) {
    current.id = await ensureFactId(env, { id: current.id, kind: args.kind, key: args.key });
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
  const factId = current?.id ?? crypto.randomUUID();
  const factWrite = db(env)
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
      factId,
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
    );
  const operation = ledgerContext?.operation ?? (current ? 'updated' : 'created');
  const ledgerWrite = factLedgerStatement(db(env), {
    id: crypto.randomUUID(),
    fact_id: factId,
    resolve_fact_id: true,
    kind: args.kind,
    key: args.key,
    operation,
    value: args.value ?? null,
    source,
    confidence: confidence ?? current?.confidence ?? null,
    observed_at: effectiveObservedAt,
    expires_at: effectiveExpiresAt,
    review_at: effectiveReviewAt,
    supersedes: supersedes ?? current?.supersedes ?? null,
    ...ledgerDetails(ledgerContext, args.why),
    created_at: iso,
  });
  await runWrites(env, [factWrite, ledgerWrite]);
  return { result: { saved: true, kind: args.kind, key: args.key } };
}

/**
 * Owner-facing append-only history. The ledger deliberately includes deleted
 * snapshots, while facts.get exposes only current truth.
 * @param {Env} env
 * @param {{ kind?: string, key?: string, limit?: number }} args
 */
export async function runFactsLedger(env, args) {
  if (args.kind != null && !FACT_KINDS.includes(args.kind)) {
    throw new Error(`невідомий kind "${args.kind}"`);
  }
  if (args.key != null && !args.key) throw new Error('key не може бути порожнім');
  const limit = normalizeLedgerLimit(args.limit);
  const where = [];
  const binds = [];
  if (args.kind != null) {
    where.push('kind = ?');
    binds.push(args.kind);
  }
  if (args.key != null) {
    where.push('key = ?');
    binds.push(args.key);
  }
  const { results } = await db(env)
    .prepare(
      `SELECT id, fact_id, kind, key, operation, value_json, source, confidence,
              observed_at, expires_at, review_at, supersedes, actor, tainted, why, created_at
       FROM fact_ledger ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY created_at DESC, id DESC LIMIT ${limit}`,
    )
    .bind(...binds)
    .all();
  return {
    result: (results ?? []).map((row) => ({
      id: row.id,
      fact_id: row.fact_id,
      kind: row.kind,
      key: row.key,
      operation: row.operation,
      value: safeParse(String(row.value_json)),
      source: row.source == null ? null : normalizeFactSource(row.source),
      confidence: row.confidence == null ? null : Number(row.confidence),
      observed_at: row.observed_at ?? null,
      expires_at: row.expires_at ?? null,
      review_at: row.review_at ?? null,
      supersedes: row.supersedes ?? null,
      actor: row.actor,
      tainted: Number(row.tainted) > 0,
      why: row.why ?? null,
      created_at: row.created_at,
    })),
  };
}

/**
 * Delete is intentionally separate from set: `null` is a fact value, never a
 * hidden deletion. Policy exposes this only as facts.delete (T1).
 * @param {Env} env
 * @param {{ kind: string, key: string, why?: string }} args
 * @param {number} nowMs
 * @param {{ actor?: 'model' | 'owner' | 'trusted_server' | 'undo', tainted?: boolean,
 *   why?: string, operation?: 'deleted' }} [ledgerContext]
 */
export async function runFactsDelete(env, args, nowMs, ledgerContext = undefined) {
  if (!FACT_KINDS.includes(args.kind)) throw new Error(`невідомий kind "${args.kind}"`);
  if (!args.key) throw new Error('key не може бути порожнім');
  const current = (await runFactsGet(env, { kind: args.kind, key: args.key })).result[0] ?? null;
  if (!current) return { result: { deleted: false, kind: args.kind, key: args.key } };
  current.id = await ensureFactId(env, { id: current.id, kind: args.kind, key: args.key });
  const iso = new Date(nowMs).toISOString();
  const deleteWrite = db(env)
    .prepare('DELETE FROM facts WHERE id = ? AND kind = ? AND key = ?')
    .bind(current.id, args.kind, args.key);
  const ledgerWrite = factLedgerStatement(db(env), {
    id: crypto.randomUUID(),
    fact_id: current.id,
    kind: current.kind,
    key: current.key,
    operation: ledgerContext?.operation ?? 'deleted',
    value: current.value,
    source: current.source,
    confidence: current.confidence,
    observed_at: current.observed_at,
    expires_at: current.expires_at,
    review_at: current.review_at,
    supersedes: current.supersedes,
    ...ledgerDetails(ledgerContext, args.why),
    created_at: iso,
  });
  await runWrites(env, [deleteWrite, ledgerWrite]);
  return { result: { deleted: true, id: current.id, kind: current.kind, key: current.key } };
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
  const factWrite = db(env)
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
    );
  const ledgerWrite = factLedgerStatement(db(env), {
    id: crypto.randomUUID(),
    fact_id: snapshot.id,
    kind: snapshot.kind,
    key: snapshot.key,
    operation: 'restored',
    value: snapshot.value,
    source,
    confidence,
    observed_at: observedAt,
    expires_at: expiresAt,
    review_at: reviewAt,
    supersedes,
    ...ledgerDetails({ actor: 'undo' }),
    created_at: iso,
  });
  await runWrites(env, [factWrite, ledgerWrite]);
}

/** Build a ledger insert from data already normalized by the fact writer.
 * @param {any} database
 * @param {Record<string, any>} row
 */
function factLedgerStatement(database, row) {
  // Two first writers of the same (kind,key) can both read "no fact" before
  // one wins the UNIQUE race. Resolve the id inside the same D1 batch, after
  // the upsert, so the event cannot point at the losing random id.
  const resolveFactId = row.resolve_fact_id === true;
  const factIdValue = resolveFactId ? '(SELECT id FROM facts WHERE kind = ? AND key = ?)' : '?';
  return database
    .prepare(
      `INSERT INTO fact_ledger (
         id, fact_id, kind, key, operation, value_json, source, confidence,
         observed_at, expires_at, review_at, supersedes, actor, tainted, why, created_at
       ) VALUES (?, ${factIdValue}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      ...(resolveFactId ? [row.kind, row.key] : [row.fact_id]),
      row.kind,
      row.key,
      row.operation,
      JSON.stringify(row.value ?? null),
      row.source ?? null,
      row.confidence ?? null,
      row.observed_at ?? null,
      row.expires_at ?? null,
      row.review_at ?? null,
      row.supersedes ?? null,
      row.actor,
      row.tainted ? 1 : 0,
      row.why,
      row.created_at,
    );
}

/** @param {Env} env @param {any[]} statements */
async function runWrites(env, statements) {
  const database = db(env);
  // D1 batch is transactional. Small legacy/local stubs without batch retain
  // compatibility, while production never reports a successful write until
  // both current truth and its ledger event were accepted together.
  if (typeof database.batch === 'function') {
    await database.batch(statements);
    return;
  }
  for (const statement of statements) await statement.run();
}

/**
 * Production rows always have an id. Some old local data/fixtures created a
 * nullable TEXT PK, though; repair it once before a ledger event references
 * the row so undo/delete cannot create an orphan event with NULL fact_id.
 * @param {Env} env
 * @param {{ id?: unknown, kind: string, key: string }} fact
 */
async function ensureFactId(env, fact) {
  if (typeof fact.id === 'string' && fact.id) return fact.id;
  const id = crypto.randomUUID();
  await db(env)
    .prepare('UPDATE facts SET id = ? WHERE kind = ? AND key = ? AND id IS NULL')
    .bind(id, fact.kind, fact.key)
    .run();
  return id;
}

/**
 * Model strings do not control actor or taint. The router/policy passes those
 * fields out-of-band; direct server writers default to trusted_server.
 * @param {{ actor?: string, tainted?: boolean, why?: string } | undefined} context
 * @param {unknown} requestedWhy
 */
function ledgerDetails(context, requestedWhy = undefined) {
  const actor = ['model', 'owner', 'trusted_server', 'undo'].includes(String(context?.actor))
    ? String(context?.actor)
    : 'trusted_server';
  const tainted = context?.tainted === true;
  const supplied = context?.why ?? requestedWhy;
  const why = normalizeWhy(supplied) ?? defaultLedgerWhy(actor, tainted);
  return { actor, tainted, why };
}

/** @param {unknown} value */
function normalizeWhy(value) {
  if (value == null) return null;
  if (typeof value !== 'string') throw new Error('why має бути коротким текстом');
  const text = value.trim();
  if (text.length > 500) throw new Error('why не може бути довшим за 500 символів');
  return text || null;
}

/** @param {string} actor @param {boolean} tainted */
function defaultLedgerWhy(actor, tainted) {
  if (actor === 'owner') return 'Підтверджено власником';
  if (actor === 'undo') return 'Відкат власником';
  if (actor === 'model') {
    return tainted
      ? 'Виклик моделі після зовнішнього вмісту, підтверджений policy'
      : 'Виклик моделі в чистій сесії';
  }
  return 'Trusted server-side запис';
}

/** @param {unknown} value */
function normalizeLedgerLimit(value) {
  if (value == null) return 20;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_FACT_LEDGER_LIST) {
    throw new Error(`limit має бути цілим від 1 до ${MAX_FACT_LEDGER_LIST}`);
  }
  return limit;
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

/** @param {unknown} iso @param {number} nowMs */
function isDue(iso, nowMs) {
  if (typeof iso !== 'string') return false;
  const at = Date.parse(iso);
  return Number.isFinite(at) && at <= nowMs;
}

/** @param {string} raw */
function safeParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null; // бите value_json - чесний null, не виняток на читанні
  }
}
