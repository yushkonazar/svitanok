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
});
