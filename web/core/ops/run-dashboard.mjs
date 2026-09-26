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
       FROM runs ORDER BY started_at DESC LIMIT ?`,
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
  return {
    recent,
    summary: {
      total: recent.length,
      active: recent.filter((run) => run.terminal === 'running').length,
      failed: recent.filter((run) => run.terminal === 'failed').length,
      completed: recent.filter((run) => run.terminal === 'completed').length,
    },
  };
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

/** @param {unknown} value @param {number} max */
function compact(value, max) {
  return typeof value === 'string' && value ? value.replace(/\s+/g, ' ').slice(0, max) : null;
}
