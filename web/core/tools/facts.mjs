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
  const sql = `SELECT kind, key, value_json, source, confidence, updated_at FROM facts
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
      kind: r.kind,
      key: r.key,
      value: safeParse(String(r.value_json)),
      source: r.source,
      updated_at: r.updated_at,
    })),
  };
}

/**
 * facts.set: upsert за (kind, key). value - будь-який JSON-сумісний; source
 * лише owner|inferred (07 §4: вивід моделі - тільки inferred; це правило
 * дотисне policy у PR-8, контракт поля - вже тут).
 * @param {Env} env
 * @param {{ kind: string, key: string, value: unknown, source?: string }} args
 * @param {number} nowMs
 */
export async function runFactsSet(env, args, nowMs) {
  if (!FACT_KINDS.includes(args.kind)) throw new Error(`невідомий kind "${args.kind}"`);
  if (!args.key) throw new Error('key не може бути порожнім');
  // Дефолт - inferred, НЕ owner: викликач цього інструмента - модель, а канон
  // 07 §4 дозволяє її виводу лише source=inferred. owner - явний opt-in, який
  // policy (PR-8) гейтитиме; без цього промпт-інʼєкція з листа записувала б
  // факт від імені власника, і він пережив би прогін.
  const source = args.source ?? 'inferred';
  if (source !== 'owner' && source !== 'inferred') {
    throw new Error(`source лише owner|inferred, не "${source}"`);
  }
  const iso = new Date(nowMs).toISOString();
  await db(env)
    .prepare(
      `INSERT INTO facts (id, kind, key, value_json, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (kind, key) DO UPDATE SET
         value_json = excluded.value_json, source = excluded.source,
         updated_at = excluded.updated_at`,
    )
    .bind(
      crypto.randomUUID(),
      args.kind,
      args.key,
      JSON.stringify(args.value ?? null),
      source,
      iso,
      iso,
    )
    .run();
  return { result: { saved: true, kind: args.kind, key: args.key } };
}

/** @param {string} raw */
function safeParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null; // бите value_json - чесний null, не виняток на читанні
  }
}
