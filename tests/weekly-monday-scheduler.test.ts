import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  weeklyReviewTask,
  WEEKLY_REVIEW_STATE_KEY,
} from '../web/core/brain/weekly-review-task.mjs';
import { startOrQueueThreadText } from '../web/core/prerouter.mjs';
import * as readTools from '../web/core/tools/read.mjs';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';
import { d1FromSqlite } from './helpers/d1.js';

vi.mock('../web/core/prerouter.mjs', async (original) => ({
  ...(await original<typeof import('../web/core/prerouter.mjs')>()),
  startOrQueueThreadText: vi.fn(async () => 'run-w2'),
}));
const MORNING = Date.parse('2026-10-26T06:10:00Z');
const NOON = Date.parse('2026-10-26T10:10:00Z');
const AFTER = Date.parse('2026-10-26T11:10:00Z');
const TEXT = '📊 Тиждень 19.10 — 25.10\n• Справи: Завершено один результат.';
const migrations = [
  '0001_base.sql',
  '0002_assistant.sql',
  '0003_telemetry.sql',
  '0007_instructions_plans.sql',
];
const start = vi.mocked(startOrQueueThreadText);
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
function setup(
  options: {
    report?: 'ready' | 'partial' | 'failed';
    retryable?: string[];
    error?: string | null;
    running?: boolean;
    attempts?: number;
    state?: boolean;
  } = {},
) {
  const d1 = d1FromSqlite(migrations);
  if (options.state !== false)
    d1.db
      .prepare(
        `INSERT INTO runs(id,trigger,profile,started_at,finished_at,error) VALUES('run-w1','chat','weekly-review','2026-10-26T06:10:00Z',?,?)`,
      )
      .run(options.running ? null : '2026-10-26T06:12:00Z', options.error ?? null);
  if (options.report)
    d1.db
      .prepare(
        `INSERT INTO reports(id,kind,period_from,period_to,text_md,status,created_at,as_of,quality_json)
    VALUES('report','weekly','2026-10-19','2026-10-25',?,?,'2026-10-26T06:20:00Z','2026-10-26T06:10:00Z',?)`,
      )
      .run(
        TEXT,
        options.report,
        JSON.stringify({
          retryable: options.retryable ?? [],
          missing: options.retryable ?? ['system-cost-coverage'],
        }),
      );
  const kv = new Map<string, string>();
  if (options.state !== false)
    kv.set(
      WEEKLY_REVIEW_STATE_KEY,
      JSON.stringify({
        date: '2026-10-19',
        attempts: options.attempts ?? 1,
        runIds: options.attempts === 2 ? ['run-w1', 'run-w2'] : ['run-w1'],
        alerted: false,
      }),
    );
  const fetch = vi.fn(async () => Response.json({ ok: true, result: { message_id: 1 } }));
  vi.stubGlobal('fetch', fetch);
  return {
    d1,
    kv,
    fetch,
    env: workerEnv({
      DB: d1.stub,
      BRIEFING: memoryKv(kv),
      TELEGRAM_CHAT_ID: '100',
      TELEGRAM_BOT_TOKEN: 'tok',
      TOPIC_ASSISTANT: '6',
      TOPIC_SYSTEM: '7',
    }),
  };
}
describe('Monday overview scheduling and recoverable evidence', () => {
  it('starts only Monday 08:00–08:59 and does not catch up missed primary runs at noon', async () => {
    const s = setup({ state: false });
    expect(await weeklyReviewTask(s.env, MORNING - 86400000)).toEqual({ skipped: 'not-monday' });
    expect(await weeklyReviewTask(s.env, MORNING - 3600000)).toEqual({ skipped: 'hour' });
    expect(await weeklyReviewTask(s.env, NOON)).toEqual({ skipped: 'outside-window' });
    expect(start).not.toHaveBeenCalled();
    expect(await weeklyReviewTask(s.env, MORNING)).toEqual({ started: true, queued: false });
    expect(start).toHaveBeenCalledWith(
      s.env,
      { chatId: 100, threadId: 6 },
      '6',
      'звіт зараз',
      'weekly-review',
      MORNING,
    );
    expect(JSON.parse(s.kv.get(WEEKLY_REVIEW_STATE_KEY)!)).toMatchObject({
      date: '2026-10-19',
      attempts: 1,
    });
  });
  it('does not retry a complete report or an unchanged historical price warning', async () => {
    const complete = setup({ report: 'ready' }),
      partial = setup({ report: 'partial' });
    expect(await weeklyReviewTask(complete.env, NOON)).toEqual({ skipped: 'ok' });
    expect(await weeklyReviewTask(partial.env, NOON)).toEqual({ skipped: 'non-retryable-gaps' });
    expect(await weeklyReviewTask(partial.env, AFTER)).toEqual({ skipped: 'done' });
    expect(start).not.toHaveBeenCalled();
    expect(partial.d1.db.prepare('SELECT COUNT(*) n FROM outbox').get()?.n).toBe(0);
  });
  it('a manually saved overview suppresses the scheduled duplicate for the same period', async () => {
    const s = setup({ report: 'partial', state: false });
    expect(await weeklyReviewTask(s.env, MORNING)).toEqual({ skipped: 'period-already-reviewed' });
    expect(start).not.toHaveBeenCalled();
  });
  it('checks actual recovery before spending another model run, and stops quietly if still missing', async () => {
    const s = setup({ report: 'partial', retryable: ['finance'] });
    const read = vi.spyOn(readTools, 'runDataRead').mockResolvedValue({
      result: JSON.stringify({ sources: { finance: { status: 'unavailable' } } }),
    });
    expect(await weeklyReviewTask(s.env, NOON)).toEqual({ skipped: 'sources-not-recovered' });
    expect(read).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
    expect(s.d1.db.prepare('SELECT COUNT(*) n FROM outbox').get()?.n).toBe(0);
  });
  it('allows one quiet retry after a core source recovered, including at 12:59', async () => {
    const s = setup({ report: 'partial', retryable: ['finance'] });
    vi.spyOn(readTools, 'runDataRead').mockResolvedValue({
      result: JSON.stringify({
        sources: { finance: { status: 'available' } },
        finance: { summary: { expenseMinor: 100 }, comparison: { complete: true } },
      }),
    });
    expect(await weeklyReviewTask(s.env, NOON + 49 * 60000)).toEqual({
      started: true,
      queued: false,
    });
    expect(start).toHaveBeenCalledOnce();
    expect(JSON.parse(s.kv.get(WEEKLY_REVIEW_STATE_KEY)!)).toMatchObject({ attempts: 2 });
    expect(await weeklyReviewTask(s.env, AFTER)).toEqual({ skipped: 'done' });
    expect(s.d1.db.prepare('SELECT COUNT(*) n FROM outbox').get()?.n).toBe(0);
  });
  it('does not run a missed recovery retry after 13:00', async () => {
    const s = setup({ report: 'partial', retryable: ['finance'] });
    const read = vi.spyOn(readTools, 'runDataRead');
    expect(await weeklyReviewTask(s.env, AFTER)).toEqual({ skipped: 'retry-window-missed' });
    expect(read).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
  it('does not start a second run while the first is running or queued', async () => {
    const s = setup({ running: true });
    expect(await weeklyReviewTask(s.env, NOON)).toEqual({ skipped: 'running' });
    const queued = setup({ state: false });
    start.mockResolvedValueOnce(null);
    await weeklyReviewTask(queued.env, MORNING);
    expect(await weeklyReviewTask(queued.env, NOON)).toEqual({ skipped: 'queued' });
    expect(start).toHaveBeenCalledOnce();
  });
  it('reconciles queued IDs and lost state from durable runs before any new generation', async () => {
    const s = setup({ state: false });
    start.mockResolvedValueOnce(null);
    await weeklyReviewTask(s.env, MORNING);
    s.d1.db
      .prepare(
        `INSERT INTO runs(id,trigger,profile,started_at,finished_at,error) VALUES('actual','chat','weekly-review','2026-10-26T06:15:00Z','2026-10-26T06:16:00Z','timeout')`,
      )
      .run();
    expect(await weeklyReviewTask(s.env, NOON)).toEqual({ skipped: 'state-reconciled' });
    expect(JSON.parse(s.kv.get(WEEKLY_REVIEW_STATE_KEY)!)).toMatchObject({
      runIds: ['actual'],
      attempts: 1,
    });
    s.kv.delete(WEEKLY_REVIEW_STATE_KEY);
    s.d1.db
      .prepare(
        `INSERT INTO runs(id,trigger,profile,started_at,finished_at,error) VALUES('second','chat','weekly-review','2026-10-26T10:00:00Z','2026-10-26T10:01:00Z','timeout')`,
      )
      .run();
    expect(await weeklyReviewTask(s.env, NOON)).toEqual({ skipped: 'state-reconciled' });
    expect(JSON.parse(s.kv.get(WEEKLY_REVIEW_STATE_KEY)!)).toMatchObject({ attempts: 2 });
    expect(start).toHaveBeenCalledOnce();
  });
  it('keeps the DO lease until the asynchronous start and state commit are complete', async () => {
    const s = setup({ state: false }),
      calls: string[] = [];
    let finished = false;
    const complete = vi.fn(async () => {
      expect(finished).toBe(true);
      calls.push('complete');
      return true;
    });
    const release = vi.fn(async () => {
      calls.push('release');
      return true;
    });
    start.mockImplementationOnce(async () => {
      await Promise.resolve();
      finished = true;
      calls.push('start');
      return 'started';
    });
    const env = workerEnv({
      ...s.env,
      WEEKLY_REVIEW_STATE: {
        getByName: () => ({
          claim: async () => ({ ok: true, token: 'lease', state: null }),
          complete,
          release,
        }),
      },
    });
    expect(await weeklyReviewTask(env, MORNING)).toEqual({ started: true, queued: false });
    expect(calls).toEqual(['start', 'complete']);
    expect(release).not.toHaveBeenCalled();
  });
  it('retries a transient generation timeout once but not a permanent access failure', async () => {
    const timeout = setup({ error: 'timeout' });
    expect(await weeklyReviewTask(timeout.env, NOON)).toEqual({ started: true, queued: false });
    const access = setup({ error: 'brain-error' });
    access.d1.db
      .prepare(
        `INSERT INTO run_steps(id,run_id,n,at,kind,name,note) VALUES('error','run-w1',1,'2026-10-26T06:12:00Z','error','weekly-review','Your organization has disabled Claude subscription access')`,
      )
      .run();
    expect(await weeklyReviewTask(access.env, NOON)).toEqual({ skipped: 'model-access-disabled' });
    expect(JSON.parse(access.kv.get(WEEKLY_REVIEW_STATE_KEY)!)).toMatchObject({ alerted: true });
    expect(start).toHaveBeenCalledOnce();
  });
});
