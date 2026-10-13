// Безпечний зріз телеметрії для owner-facing run dashboard. Це не журнал
// промптів: повертаємо лише технічні поля, уже наявні у runs/run_steps, без
// input/output, note та будь-якого тексту користувача.

export const RUN_DASHBOARD_LIMIT = 50;

/** @param {Env} env */
function db(env) {
  if (!env.DB) throw new Error('привʼязки DB немає — run dashboard недоступний');
  return env.DB;
}

/**
 * Останні прогони та їхні безпечні агрегати. `null` не означає нуль: поле ще
 * не відоме старому producer-у telemetry, і UI має показати «немає даних», а
 * не вигадати успішність чи вартість.
 * @param {Env} env
 * @param {{since?:string,until?:string,before?:string}} [period]
 */
export async function readRunDashboard(env, period = {}) {
  const bounds = period.since && period.until ? ' AND started_at >= ? AND started_at < ?' : '';
  const args = bounds ? [period.since, period.until] : [];
  const cursor = period.before ? " AND (started_at || '|' || id) < ?" : '';
  const { results } = await db(env)
    .prepare(
      `SELECT id, trigger, profile, thread_id, model, started_at, finished_at,
              duration_ms, steps, error, cost_note
       FROM runs
       -- До цього тік SchedulerDO помилково писав сюди unprofiled рядки.
       -- Зберігаємо сумісність зі старими даними, але не даємо їм витіснити
       -- реальні model/workflow runs з owner-facing dashboard.
       WHERE NOT (trigger = 'scheduler' AND profile IS NULL)${bounds}${cursor}
       ORDER BY started_at DESC, id DESC LIMIT ?`,
    )
    .bind(...args, ...(period.before ? [period.before] : []), RUN_DASHBOARD_LIMIT)
    .all();
  const rows = /** @type {Record<string, unknown>[]} */ (results ?? []);
  const ids = rows.map((row) => String(row.id ?? '')).filter(Boolean);
  /** @type {Map<string, Record<string, unknown>[]>} */
  const stepsByRun = new Map();
  if (ids.length) {
    const marks = ids.map(() => '?').join(', ');
    const { results: stepRows } = await db(env)
      .prepare(
        `SELECT run_id, n, kind, name, ms, ok, note FROM run_steps
         WHERE run_id IN (${marks}) ORDER BY run_id, n`,
      )
      .bind(...ids)
      .all();
    for (const step of /** @type {Record<string, unknown>[]} */ (stepRows ?? [])) {
      const runId = String(step.run_id ?? '');
      const list = stepsByRun.get(runId) ?? [];
      list.push(step);
      stepsByRun.set(runId, list);
    }
  }

  const recent = rows.map((row) => shapeRun(row, stepsByRun.get(String(row.id ?? '')) ?? []));
  const workerQuality = await readWorkerQuality(env, period);
  const summary = bounds
    ? await db(env)
        .prepare(
          `SELECT COUNT(*) AS total,
    SUM(CASE WHEN finished_at IS NULL THEN 1 ELSE 0 END) AS active,
    SUM(CASE WHEN finished_at IS NOT NULL AND error IS NOT NULL AND error<>'' THEN 1 ELSE 0 END) AS failed,
    SUM(CASE WHEN finished_at IS NOT NULL AND (error IS NULL OR error='') THEN 1 ELSE 0 END) AS completed
    FROM runs WHERE NOT (trigger='scheduler' AND profile IS NULL)${bounds}`,
        )
        .bind(...args)
        .first()
    : null;
  const last = rows.at(-1);
  return {
    recent,
    nextCursor:
      rows.length === RUN_DASHBOARD_LIMIT && last ? `${last.started_at}|${last.id}` : null,
    summary: summary
      ? {
          total: integer(summary.total),
          active: integer(summary.active),
          failed: integer(summary.failed),
          completed: integer(summary.completed),
        }
      : {
          total: recent.length,
          active: recent.filter((run) => run.terminal === 'running').length,
          failed: recent.filter((run) => run.terminal === 'failed').length,
          completed: recent.filter((run) => run.terminal === 'completed').length,
        },
    worker_quality: workerQuality,
  };
}

/** Aggregate only allowlisted worker model-step metadata and explicit votes. */
/** @param {Env} env */
async function readWorkerQuality(env, /** @type {{since?:string,until?:string}} */ period = {}) {
  const since = period.since ?? new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString();
  const until = period.until ?? new Date(Date.now() + 86400000).toISOString();
  const { results } = await db(env)
    .prepare(
      `SELECT name, COUNT(*) AS calls,
              SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS succeeded,
              SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failed,
              AVG(CASE WHEN note LIKE '%latency_unknown=1%' THEN NULL ELSE ms END) AS avg_ms, MAX(CASE WHEN note LIKE '%latency_unknown=1%' THEN NULL ELSE ms END) AS max_ms,
              COUNT(CASE WHEN note LIKE '%latency_unknown=1%' THEN NULL ELSE ms END) AS latency_samples
       FROM run_steps
       WHERE kind = 'model' AND (name GLOB 'worker:*:openai:*' OR name GLOB 'worker:*:claude:*') AND at >= ? AND at < ?
       GROUP BY name`,
    )
    .bind(since, until)
    .all();
  /** @type {Map<string, {calls:number,succeeded:number,failed:number,totalMs:number,latencySamples:number,maxMs:number|null,results:number}>} */
  const totals = new Map();
  for (const row of /** @type {Record<string, unknown>[]} */ (results ?? [])) {
    const name = String(row.name ?? '');
    const match = name.match(/^worker:([a-z][a-z0-9-]{1,31}):(?:openai|claude):/);
    if (!match?.[1]) continue;
    const worker = match[1];
    const calls = integer(row.calls);
    const item = totals.get(worker) ?? {
      calls: 0,
      succeeded: 0,
      failed: 0,
      totalMs: 0,
      latencySamples: 0,
      maxMs: null,
      results: 0,
    };
    item.calls += calls;
    item.succeeded += integer(row.succeeded);
    item.failed += integer(row.failed);
    const avgMs = finite(row.avg_ms);
    const maxMs = finite(row.max_ms);
    const latencySamples = row.latency_samples == null ? calls : integer(row.latency_samples);
    if (avgMs != null) {
      item.totalMs += avgMs * latencySamples;
      item.latencySamples += latencySamples;
    }
    if (maxMs != null) item.maxMs = Math.max(item.maxMs ?? 0, maxMs);
    totals.set(worker, item);
  }
  // Кількість збережених відповідей — окремий знаменник від викликів моделі:
  // один результат може містити кілька кроків або не викликати модель узагалі.
  /** @type {Record<string, unknown>[]} */
  let reportRows = [];
  try {
    const { results } = await db(env)
      .prepare(
        `SELECT kind, COUNT(*) AS results
         FROM reports
         WHERE kind GLOB 'worker:*' AND created_at >= ? AND created_at < ?
         GROUP BY kind`,
      )
      .bind(since, until)
      .all();
    reportRows = /** @type {Record<string, unknown>[]} */ (results ?? []);
  } catch {
    // Старі/відновлені схеми без reports усе одно мають показати telemetry.
  }
  for (const row of reportRows) {
    const match = String(row.kind ?? '').match(/^worker:([a-z][a-z0-9-]{1,31})$/);
    if (!match?.[1]) continue;
    const worker = match[1];
    const item = totals.get(worker) ?? {
      calls: 0,
      succeeded: 0,
      failed: 0,
      totalMs: 0,
      latencySamples: 0,
      maxMs: null,
      results: 0,
    };
    item.results = integer(row.results);
    totals.set(worker, item);
  }
  /** @type {Record<string, unknown>[]} */
  let votes = [];
  try {
    const { results: voteRows } = await db(env)
      .prepare(
        `SELECT r.kind, a.action_key, COUNT(*) AS votes
         FROM worker_card_actions a JOIN reports r ON r.id = a.report_id
         WHERE r.kind LIKE 'worker:%' AND a.action_key IN ('quality:good','quality:bad')
           AND a.created_at >= ? AND a.created_at < ?
         GROUP BY r.kind, a.action_key`,
      )
      .bind(since, until)
      .all();
    votes = /** @type {Record<string, unknown>[]} */ (voteRows ?? []);
  } catch {
    // Older/rollback schemas may not have the optional feedback table contract.
  }
  /** @type {Map<string, { good: number, bad: number }>} */
  const ratings = new Map();
  for (const row of votes) {
    const worker = String(row.kind ?? '').replace(/^worker:/, '');
    if (!/^[a-z][a-z0-9-]{1,31}$/.test(worker)) continue;
    const rating = ratings.get(worker) ?? { good: 0, bad: 0 };
    if (row.action_key === 'quality:good') rating.good += integer(row.votes);
    if (row.action_key === 'quality:bad') rating.bad += integer(row.votes);
    ratings.set(worker, rating);
  }
  return [...totals.entries()]
    .map(([worker, item]) => ({
      worker,
      results: item.results,
      sample_size: item.calls,
      succeeded: item.succeeded,
      failed: item.failed,
      success_rate_pct:
        item.succeeded + item.failed
          ? Math.round((100 * item.succeeded) / (item.succeeded + item.failed))
          : null,
      avg_latency_ms: item.latencySamples ? Math.round(item.totalMs / item.latencySamples) : null,
      max_latency_ms: item.maxMs,
      feedback: ratings.get(worker) ?? { good: 0, bad: 0 },
    }))
    .sort((a, b) => b.sample_size - a.sample_size || a.worker.localeCompare(b.worker));
}

/** @param {Record<string, unknown>} row @param {Record<string, unknown>[]} steps */
function shapeRun(row, steps) {
  const toolSteps = steps.filter((step) => step.kind === 'tool');
  const toolMs = toolSteps.map((step) => finite(step.ms)).filter((value) => value != null);
  const queue = steps.find((step) => step.kind === 'queue');
  const retries = steps.filter((step) => step.kind === 'retry').length;
  const policy = steps.find((step) => step.kind === 'policy');
  const modelSteps = steps.filter((step) => step.kind === 'model');
  const modelStep =
    modelSteps.find(
      (step) =>
        !String(step.name).startsWith('worker:') && !String(step.name).startsWith('shadow:'),
    ) ?? modelSteps[0];
  const modelTelemetry = parseModelTelemetry(modelStep?.note);
  const finished = typeof row.finished_at === 'string' && row.finished_at.length > 0;
  const error = compact(row.error, 120);
  return {
    id: compact(row.id, 80),
    trigger: compact(row.trigger, 40),
    profile: compact(row.profile, 64),
    // Тред навмисно не повертаємо: ідентифікатор чату - зайва персональна
    // копія для dashboard, а діагностиці він не потрібен.
    terminal: finished ? (error ? 'failed' : 'completed') : 'running',
    started_at: compact(row.started_at, 40),
    finished_at: compact(row.finished_at, 40),
    duration_ms: finite(row.duration_ms),
    queue_wait_ms: queue ? finite(queue.ms) : null,
    retries,
    tools: {
      calls: toolSteps.length,
      latency_total_ms: toolMs.length ? toolMs.reduce((sum, value) => sum + value, 0) : null,
      latency_max_ms: toolMs.length ? Math.max(...toolMs) : null,
    },
    policy_decision: policy ? compact(policy.name, 80) : null,
    model: modelStep ? compact(modelStep.name, 120) : compact(row.model, 120),
    model_version: modelStep ? compact(modelStep.name, 120) : null,
    response_id: modelTelemetry.response_id,
    usage: modelTelemetry.usage,
    usage_complete: modelTelemetry.usage_complete,
    model_responses: modelTelemetry.model_responses,
    api_attempts: modelTelemetry.api_attempts,
    estimated_cost_usd: modelTelemetry.estimated_cost_usd,
    models: modelSteps.map((step) => ({
      name: safeStepName(step.name),
      ...parseModelTelemetry(step.note),
      response_id: null,
      duration_ms: /latency_unknown=1/.test(String(step.note)) ? null : finite(step.ms),
      ok: step.ok === 1 ? true : step.ok === 0 ? false : null,
    })),
    steps: steps.slice(0, 200).map((step) => ({
      kind: ['model', 'tool', 'queue', 'retry', 'policy', 'reply', 'error', 'subagent'].includes(
        String(step.kind),
      )
        ? String(step.kind)
        : 'other',
      name: safeStepName(step.name),
      ms:
        step.kind === 'model' && /latency_unknown=1/.test(String(step.note))
          ? null
          : finite(step.ms),
      ok: step.ok === 1 ? true : step.ok === 0 ? false : null,
    })),
    steps_truncated: steps.length > 200,
    error_class: errorClass(row.error),
    // cost_note - лише заздалегідь санітизований технічний cost producer-а;
    // якщо producer не звітує вартість, `null`, не «$0».
    cost: compact(row.cost_note, 160),
    error,
  };
}

/** @param {unknown} name */
function safeStepName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9_.:/-]{1,128}$/.test(name) ? name : 'unknown';
}
/** @param {unknown} error */
export function errorClass(error) {
  if (!error) return null;
  const text = String(error).toLowerCase();
  if (/timeout|timed.out|deadline/.test(text)) return 'timeout';
  if (/401|403|auth|credential/.test(text)) return 'access';
  if (/429|quota|limit/.test(text)) return 'quota';
  if (/network|fetch|connection/.test(text)) return 'network';
  return 'execution';
}

/** Малі allowlisted token-метрики з model step, без читання довільної note. */
/** @param {unknown} note */
export function parseModelTelemetry(note) {
  const text = typeof note === 'string' ? note : '';
  /** @param {string} key */
  const field = (key) => {
    const match = new RegExp(`(?:^|\\s)${key}=([A-Za-z0-9_.:-]+)`).exec(text);
    return match?.[1] ?? null;
  };
  /** @param {string} key */
  const count = (key) => {
    const raw = field(key);
    if (raw == null) return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  };
  /** @param {string} key */
  const decimal = (key) => {
    const raw = field(key);
    if (raw == null) return null;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : null;
  };
  return {
    response_id: field('response'),
    usage: {
      input_tokens: count('input_tokens'),
      output_tokens: count('output_tokens'),
      total_tokens: count('total_tokens'),
      cached_input_tokens: count('cached_input_tokens'),
      cache_write_tokens: count('cache_write_tokens'),
      reasoning_tokens: count('reasoning_tokens'),
    },
    usage_complete:
      field('usage_complete') === '1' ? true : field('usage_complete') === '0' ? false : null,
    model_responses: count('model_responses'),
    api_attempts: count('api_attempts'),
    estimated_cost_usd: decimal('cost_usd'),
  };
}

/** @param {unknown} value */
function finite(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** @param {unknown} value */
function integer(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

/** @param {unknown} value @param {number} max */
function compact(value, max) {
  return typeof value === 'string' && value ? value.replace(/\s+/g, ' ').slice(0, max) : null;
}
