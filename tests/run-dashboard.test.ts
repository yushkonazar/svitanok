import { describe, expect, it } from 'vitest';
import { readRunDashboard } from '../web/core/ops/run-dashboard.mjs';
import { workerEnv } from './helpers/env.js';
import { d1FromSqlite } from './helpers/d1.js';

describe('run dashboard', () => {
  it('віддає terminal state та агрегати telemetry без thread, note або prompt text', async () => {
    const d1 = d1FromSqlite(['0003_telemetry.sql']);
    d1.db
      .prepare(
        `INSERT INTO runs (id, trigger, profile, thread_id, model, started_at, finished_at,
                          duration_ms, steps, error, cost_note)
         VALUES ('r-1', 'chat', 'chat', 'private-thread', 'claude-sonnet-5', ?, ?,
                 1200, 4, NULL, 'provider reported cost')`,
      )
      .run('2026-09-23T08:00:00.000Z', '2026-09-23T08:00:01.200Z');
    // Сумісність із забрудненими старими telemetry rows: SchedulerDO-тік не
    // є model/workflow run і не має витісняти реальний run з dashboard.
    d1.db
      .prepare(
        `INSERT INTO runs (id, trigger, started_at, finished_at)
         VALUES ('scheduler-tick', 'scheduler', '2026-09-23T09:00:00.000Z', '2026-09-23T09:00:00.000Z')`,
      )
      .run();
    const insertStep = d1.db.prepare(
      `INSERT INTO run_steps (id, run_id, n, at, kind, name, ms, ok, note)
       VALUES (?, 'r-1', ?, '2026-09-23T08:00:00.000Z', ?, ?, ?, 1, ?)`,
    );
    insertStep.run('r-1:queue', -2, 'queue', 'wait', 230, 'queue note must not leak');
    insertStep.run('r-1:retry', -1, 'retry', 'start', 1, 'retry note must not leak');
    insertStep.run('r-1:tool', 1, 'tool', 'calendar.read', 80, 'private tool output');
    insertStep.run('r-1:policy', 2, 'policy', 'proposed', 3, 'private policy explanation');

    const dashboard = await readRunDashboard(workerEnv({ DB: d1.stub }));
    expect(dashboard.summary).toEqual({ total: 1, active: 0, failed: 0, completed: 1 });
    expect(dashboard.recent[0]).toEqual(
      expect.objectContaining({
        id: 'r-1',
        terminal: 'completed',
        queue_wait_ms: 230,
        retries: 1,
        tools: { calls: 1, latency_total_ms: 80, latency_max_ms: 80 },
        policy_decision: 'proposed',
        model: 'claude-sonnet-5',
        model_version: null,
        cost: 'provider reported cost',
      }),
    );
    expect(JSON.stringify(dashboard)).not.toContain('private-thread');
    expect(JSON.stringify(dashboard)).not.toContain('private tool output');
    expect(JSON.stringify(dashboard)).not.toContain('private policy explanation');
  });

  it('залишає невідомі producer-поля null, а незавершений run називає running', async () => {
    const d1 = d1FromSqlite(['0003_telemetry.sql']);
    d1.db
      .prepare(
        `INSERT INTO runs (id, trigger, started_at) VALUES ('r-active', 'quick', '2026-09-23T08:00:00.000Z')`,
      )
      .run();

    const dashboard = await readRunDashboard(workerEnv({ DB: d1.stub }));
    expect(dashboard.recent[0]).toMatchObject({
      terminal: 'running',
      queue_wait_ms: null,
      model: null,
      cost: null,
    });
  });

  it('exposes only allowlisted OpenAI model telemetry, never a provider payload', async () => {
    const d1 = d1FromSqlite(['0003_telemetry.sql']);
    d1.db
      .prepare(
        `INSERT INTO runs (id, trigger, started_at) VALUES ('r-openai', 'chat', '2026-09-23T08:00:00.000Z')`,
      )
      .run();
    d1.db
      .prepare(
        `INSERT INTO run_steps (id, run_id, n, at, kind, name, ms, ok, note)
         VALUES ('r-openai:model', 'r-openai', 1, '2026-09-23T08:00:01.000Z', 'model',
                 'openai:gpt-6-astra-2026-09-03', 850, 1,
                 'response=resp_abc input_tokens=123 output_tokens=45 total_tokens=168 prompt=must-not-parse')`,
      )
      .run();

    const dashboard = await readRunDashboard(workerEnv({ DB: d1.stub }));
    expect(dashboard.recent[0]).toMatchObject({
      model: 'openai:gpt-6-astra-2026-09-03',
      model_version: 'openai:gpt-6-astra-2026-09-03',
      response_id: 'resp_abc',
      usage: { input_tokens: 123, output_tokens: 45, total_tokens: 168 },
    });
    expect(JSON.stringify(dashboard)).not.toContain('must-not-parse');
  });

  it('показує 30-денні метрики працівників та оцінки без текстів і thread id', async () => {
    const d1 = d1FromSqlite([
      '0001_base.sql',
      '0002_assistant.sql',
      '0003_telemetry.sql',
      '0007_instructions_plans.sql',
    ]);
    d1.db
      .prepare(
        `INSERT INTO runs (id, trigger, profile, started_at) VALUES ('r-worker', 'chat', 'chat', ?)`,
      )
      .run('2026-09-23T08:00:00.000Z');
    d1.db
      .prepare(
        `INSERT INTO run_steps (id, run_id, n, at, kind, name, ms, ok, note)
         VALUES ('w-1', 'r-worker', 1, ?, 'model', 'worker:planner:openai:gpt-6-sol', 800, 1, 'private output')`,
      )
      .run('2026-09-23T08:00:01.000Z');
    d1.db
      .prepare(
        `INSERT INTO reports (id, kind, text_md, created_at) VALUES ('rep-1', 'worker:planner', 'private report', ?)`,
      )
      .run('2026-09-23T08:00:00.000Z');
    d1.db
      .prepare(
        `INSERT INTO worker_card_actions (report_id, action_key, created_at) VALUES ('rep-1', 'quality:good', ?)`,
      )
      .run('2026-09-23T08:00:02.000Z');

    const dashboard = await readRunDashboard(workerEnv({ DB: d1.stub }));
    expect(dashboard.worker_quality).toEqual([
      expect.objectContaining({
        worker: 'planner',
        results: 1,
        sample_size: 1,
        succeeded: 1,
        failed: 0,
        success_rate_pct: 100,
        avg_latency_ms: 800,
        feedback: { good: 1, bad: 0 },
      }),
    ]);
    expect(JSON.stringify(dashboard.worker_quality)).not.toContain('private');
  });

  it('рахує збережені результати окремо від модельних викликів', async () => {
    const d1 = d1FromSqlite([
      '0001_base.sql',
      '0002_assistant.sql',
      '0003_telemetry.sql',
      '0007_instructions_plans.sql',
    ]);
    d1.db
      .prepare(
        `INSERT INTO reports (id, kind, text_md, created_at) VALUES ('rep-1', 'worker:editor', 'private report', ?)`,
      )
      .run('2026-09-23T08:00:00.000Z');

    const dashboard = await readRunDashboard(workerEnv({ DB: d1.stub }));
    expect(dashboard.worker_quality).toEqual([
      expect.objectContaining({
        worker: 'editor',
        results: 1,
        sample_size: 0,
        success_rate_pct: null,
        feedback: { good: 0, bad: 0 },
      }),
    ]);
  });
});
