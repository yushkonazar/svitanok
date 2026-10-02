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
 */
export async function readRunDashboard(env) {
  const { results } = await db(env)
    .prepare(
      `SELECT id, trigger, profile, thread_id, model, started_at, finished_at,
              duration_ms, steps, error, cost_note
       FROM runs
       -- До цього тік SchedulerDO помилково писав сюди unprofiled рядки.
       -- Зберігаємо сумісність зі старими даними, але не даємо їм витіснити
       -- реальні model/workflow runs з owner-facing dashboard.
       WHERE NOT (trigger = 'scheduler' AND profile IS NULL)
       ORDER BY started_at DESC LIMIT ?`,
    )
    .bind(RUN_DASHBOARD_LIMIT)
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
  const workerQuality = await readWorkerQuality(env);
  return {
    recent,
    summary: {
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
async function readWorkerQuality(env) {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString();
  const { results } = await db(env)
    .prepare(
      `SELECT name, COUNT(*) AS calls,
              SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS succeeded,
              SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failed,
              AVG(ms) AS avg_ms, MAX(ms) AS max_ms
       FROM run_steps
       WHERE kind = 'model' AND name GLOB 'worker:*:openai:*' AND at >= ?
       GROUP BY name`,
    )
    .bind(since)
    .all();
  /** @type {Map<string, {calls:number,succeeded:number,failed:number,totalMs:number,maxMs:number|null,results:number}>} */
  const totals = new Map();
  for (const row of /** @type {Record<string, unknown>[]} */ (results ?? [])) {
    const name = String(row.name ?? '');
    const match = name.match(/^worker:([a-z][a-z0-9-]{1,31}):openai:/);
    if (!match?.[1]) continue;
    const worker = match[1];
    const calls = integer(row.calls);
    const item = totals.get(worker) ?? {
      calls: 0,
      succeeded: 0,
      failed: 0,
      totalMs: 0,
      maxMs: null,
      results: 0,
    };
    item.calls += calls;
    item.succeeded += integer(row.succeeded);
    item.failed += integer(row.failed);
    const avgMs = finite(row.avg_ms);
    const maxMs = finite(row.max_ms);
    if (avgMs != null) item.totalMs += avgMs * calls;
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
         WHERE kind GLOB 'worker:*' AND created_at >= ?
         GROUP BY kind`,
      )
      .bind(since)
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
           AND a.created_at >= ?
         GROUP BY r.kind, a.action_key`,
      )
      .bind(since)
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
      success_rate_pct: item.calls ? Math.round((100 * item.succeeded) / item.calls) : null,
      avg_latency_ms: item.calls ? Math.round(item.totalMs / item.calls) : null,
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
  const modelStep = steps.find((step) => step.kind === 'model');
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
    estimated_cost_usd: modelTelemetry.estimated_cost_usd,
    // cost_note - лише заздалегідь санітизований технічний cost producer-а;
    // якщо producer не звітує вартість, `null`, не «$0».
    cost: compact(row.cost_note, 160),
    error,
  };
}

/** Малі allowlisted token-метрики з model step, без читання довільної note. */
/** @param {unknown} note */
function parseModelTelemetry(note) {
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
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : null;
  };
  return {
    response_id: field('response'),
    usage: {
      input_tokens: count('input_tokens'),
      output_tokens: count('output_tokens'),
      total_tokens: count('total_tokens'),
    },
    estimated_cost_usd: decimal('cost_usd'),
  };
}

/** @param {unknown} value */
function finite(value) {
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
