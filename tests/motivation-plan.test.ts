import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyPlanCommand,
  emptyPlan,
  planView,
  planWallet,
  planLocalTime,
  personalPlanDate,
  taskScore,
  type PlanState,
} from '../web/core/motivation/model.mjs';
import { executePlanCommand, readPlanWorkspace } from '../web/core/motivation/store.mjs';
import { handlePlan } from '../web/api-plan.mjs';
import {
  motivationTask,
  motivationCalendarTask,
  renderPlanNotice,
} from '../web/core/motivation/jobs.mjs';
import { planPathForStartParam } from '../web/core/motivation/links.mjs';
import { d1FromSqlite } from './helpers/d1.js';
import { workerEnv } from './helpers/env.js';
import { buildInitData } from './helpers/init-data.js';

const google = vi.hoisted(() => ({ create: vi.fn(), inspect: vi.fn() }));
vi.mock('../web/google.mjs', async (original) => ({
  ...(await original<object>()),
  createCalendarEvent: google.create,
  inspectCalendarEvent: google.inspect,
}));
const NOW = Date.parse('2026-10-16T07:00:00Z'),
  DUE = '2026-10-16T10:00:00.000Z',
  AFTER = Date.parse('2026-10-17T02:00:00Z');
const payload = (over: Record<string, unknown> = {}) => ({
  date: '2026-10-16',
  title: 'Практика SQL',
  criterion: '5 розв’язаних задач',
  target: 5,
  xp: 35,
  effort: 1,
  contribution: 1,
  deadlineKind: 'time',
  dueAt: DUE,
  ...over,
});
let serial = 0;
function reduce(
  state: PlanState,
  op: string,
  payload: Record<string, unknown> = {},
  id?: string,
  at = NOW,
) {
  return applyPlanCommand(state, { op, payload, id, commandId: `operation-${++serial}` }, at);
}
function prepared(balance = 100, over: Record<string, unknown> = {}) {
  let state = emptyPlan();
  state.balance = balance;
  state = reduce(state, 'settings', { enabled: true }).state;
  const draft = reduce(state, 'task-save', payload(over));
  state = draft.state;
  return { state: reduce(state, 'accept', { date: '2026-10-16' }).state, id: draft.receipt.id };
}
function task(state: PlanState, id: string) {
  return state.records[id];
}
function setup() {
  const d1 = d1FromSqlite(['0001_base.sql', '0002_assistant.sql', '0042_motivation_plan.sql'], {
    atomicBatch: true,
  });
  return {
    ...d1,
    env: workerEnv({
      DB: d1.stub,
      TELEGRAM_BOT_TOKEN: 'test-token',
      TELEGRAM_OWNER_USER_ID: '42',
      ASSISTANT_HOME: 'dm',
    }),
  };
}
beforeEach(() => {
  serial = 0;
  google.create.mockReset().mockResolvedValue({ ok: true, id: 'calendar' });
  google.inspect.mockReset();
});

describe('strict personal plan rules', () => {
  it.each(['settings', 'task-save'])(
    'recognizes legacy %s without relying on the recent journal',
    async (op) => {
      const { env, db } = setup();
      await executePlanCommand(
        env,
        {
          op,
          payload: op === 'settings' ? { enabled: false, penaltyPercent: 35 } : payload(),
          revision: 0,
          commandId: 'legacy-onboarding',
        },
        NOW,
      );
      const stored = JSON.parse(
        String(db.prepare('SELECT data_json FROM motivation_account').get()?.data_json),
      );
      expect(stored.settings.reviewedAt).toBe(
        op === 'settings' ? new Date(NOW).toISOString() : null,
      );
      // The released 0.11.0 account did not have a setup-completion marker.
      db.exec(
        "UPDATE motivation_account SET data_json=json_remove(data_json,'$.settings.reviewedAt')",
      );
      const later = new Date(AFTER).toISOString();
      db.prepare(
        `WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<101)
      INSERT INTO motivation_ledger(id,command_id,at,kind,delta,experience_delta,data_json)
      SELECT 'history-'||i,'history-command-'||i,?,'history',0,0,
        json_object('id','history-'||i,'at',?,'kind','history') FROM n`,
      ).run(later, later);
      const workspace = await readPlanWorkspace(env, AFTER + 1);
      expect(workspace.events).toHaveLength(100);
      expect(workspace.events.some((event) => event.kind === 'settings')).toBe(false);
      expect(workspace.settings.reviewedAt).toBe(
        op === 'settings' ? new Date(NOW).toISOString() : null,
      );
      expect(workspace.settings.enabled).toBe(false);
      expect(
        db
          .prepare(
            "SELECT json_extract(data_json,'$.settings.reviewedAt') AS reviewed FROM motivation_account",
          )
          .get()?.reviewed,
      ).toBeNull();
    },
  );
  it('never interprets a string false as permission to create a Calendar block', () => {
    expect(() =>
      reduce(
        emptyPlan(),
        'task-save',
        payload({
          calendar: 'false',
          startAt: '2026-10-16T08:00:00Z',
          endAt: '2026-10-16T09:00:00Z',
        }),
      ),
    ).toThrow('Прапорці');
    expect(() =>
      reduce(emptyPlan(), 'reward-save', { title: 'Винагорода', price: 100, repeatable: 'false' }),
    ).toThrow('Прапорці');
  });
  it('scores six transparent combinations and validates real Kyiv dates, DST and night boundaries', () => {
    expect([0, 1, 2].flatMap((e) => [0, 1].map((c) => taskScore(e, c)))).toEqual([
      10, 20, 20, 35, 35, 50,
    ]);
    expect(planLocalTime('2026-10-16', '04:00')).toBe('2026-10-16T01:00:00.000Z');
    expect(() => planLocalTime('2026-02-30', '04:00')).toThrow();
    expect(() => planLocalTime('2026-03-29', '03:30')).toThrow();
    expect(() => planLocalTime('2026-10-25', '03:30')).toThrow();
    expect(personalPlanDate(emptyPlan().settings, Date.parse('2026-10-16T00:30:00Z'))).toBe(
      '2026-10-15',
    );
  });
  it('leaves drafts without XP, risk or automatic failure', () => {
    const state = reduce(emptyPlan(), 'task-save', payload()).state;
    const later = reduce(state, '_settle', {}, undefined, AFTER).state;
    expect(planWallet(later)).toEqual({
      balance: 0,
      experience: 0,
      risk: 0,
      reserved: 0,
      available: 0,
    });
    expect(Object.values(later.records).find((r) => r.kind === 'task').status).toBe('draft');
  });
  it('credits partial and late useful work once, preserving deadline loss', () => {
    let { state } = prepared();
    const id = Object.values(state.records).find((r) => r.kind === 'task').id;
    state = reduce(state, 'report', { units: 3 }, id).state;
    expect(planWallet(state)).toMatchObject({ balance: 121, experience: 21, risk: 5 });
    expect(task(state, id).settledAt).toBeUndefined();
    state = reduce(state, '_settle', {}, undefined, AFTER).state;
    expect(state.balance).toBe(116);
    state = reduce(state, 'report', { units: 5 }, id, AFTER + 1).state;
    state = reduce(state, 'report', { units: 5 }, id, AFTER + 2).state;
    expect(state.balance).toBe(130);
    expect(state.experience).toBe(35);
    expect(task(state, id).penaltyApplied).toBe(5);
  });
  it('recognizes a late-reported on-time fact, refunding only loss actually collected', () => {
    let { state } = prepared(5, { target: 1, xp: 50 });
    const id = Object.values(state.records).find((r) => r.kind === 'task').id;
    state = reduce(state, '_settle', {}, undefined, AFTER).state;
    expect(state.balance).toBe(0);
    expect(task(state, id).penaltyRequested).toBe(15);
    expect(task(state, id).penaltyApplied).toBe(5);
    state = reduce(
      state,
      'report',
      { units: 1, actualAt: '2026-10-16T09:00:00Z' },
      id,
      AFTER + 1,
    ).state;
    expect(state.balance).toBe(55);
    expect(state.experience).toBe(50);
    expect(task(state, id).penaltyApplied).toBe(0);
  });
  it('does not cancel the consequence when late completion arrives before cron', () => {
    let { state } = prepared();
    const id = Object.values(state.records).find((r) => r.kind === 'task').id;
    state = reduce(state, 'report', { units: 5 }, id, Date.parse('2026-10-16T11:00:00Z')).state;
    expect(planWallet(state).risk).toBe(11);
    state = reduce(state, '_settle', {}, undefined, AFTER).state;
    expect(state.balance).toBe(124);
    state = reduce(
      state,
      'report',
      { units: 3, actualAt: '2026-10-16T09:00:00Z' },
      id,
      AFTER + 1,
    ).state;
    expect(state.balance).toBe(130);
    expect(state.experience).toBe(35);
  });
  it('settles missed work at zero before awarding future work, with no future arrears', () => {
    let { state } = prepared(0, { target: 1, xp: 50 });
    const id = Object.values(state.records).find((r) => r.kind === 'task').id;
    state = reduce(state, 'report', { units: 1 }, id, AFTER).state;
    expect(state.balance).toBe(50);
    expect(task(state, id).penaltyApplied).toBe(0);
    state = reduce(state, '_settle', {}, undefined, AFTER + 1).state;
    expect(state.balance).toBe(50);
  });
  it('keeps time itself part of a time-sensitive criterion', () => {
    let { state } = prepared(100, {
      target: 1,
      timeSensitive: true,
      criterion: 'Виїхати до 13:00',
    });
    const id = Object.values(state.records).find((r) => r.kind === 'task').id;
    state = reduce(state, 'report', { units: 1 }, id, Date.parse('2026-10-16T11:00:00Z')).state;
    expect(state.experience).toBe(0);
    expect(task(state, id).status).toBe('accepted');
    expect(planView(state, NOW).tasks[0].facts.done).toBe(false);
  });
  it('freezes accepted conditions, allows moving start and keeps genuine exceptions audited', () => {
    let { state } = prepared();
    const id = Object.values(state.records).find((r) => r.kind === 'task').id;
    expect(() => reduce(state, 'task-save', payload(), id)).toThrow();
    state = reduce(state, 'move-start', { startAt: '2026-10-16T08:00:00Z' }, id).state;
    expect(task(state, id).dueAt).toBe(DUE);
    state = reduce(state, 'exception', { reason: 'Зовнішній збій сервісу' }, id).state;
    expect(planWallet(state).risk).toBe(0);
    expect(task(state, id).exceptionReason).toContain('збій');
  });
  it('strictly settles every accepted task without a daily cap', () => {
    let state = emptyPlan();
    state.balance = 200;
    state = reduce(state, 'settings', { enabled: true }).state;
    for (const xp of [35, 35, 20, 10])
      state = reduce(state, 'task-save', payload({ xp, target: 1 })).state;
    state = reduce(state, 'accept', { date: '2026-10-16' }).state;
    const next = reduce(state, '_settle', {}, undefined, AFTER);
    expect(next.state.balance).toBe(169);
    expect(next.events.filter((e) => e.kind === 'deadline')).toHaveLength(4);
  });
  it('continues the same result on another day without paying XP twice', () => {
    let { state } = prepared();
    const id = Object.values(state.records).find((r) => r.kind === 'task').id;
    state = reduce(state, 'report', { units: 3 }, id).state;
    state = reduce(state, '_settle', {}, undefined, AFTER).state;
    const carry = reduce(state, 'recommit', { date: '2026-10-17' }, id, AFTER);
    state = carry.state;
    state = reduce(state, 'accept', { date: '2026-10-17' }, undefined, AFTER).state;
    state = reduce(state, 'report', { units: 5 }, carry.receipt.id, AFTER + 1).state;
    expect(state.experience).toBe(35);
    expect(state.balance).toBe(130);
  });
  it('undoes an accidental report and restores risk without duplicated experience', () => {
    let { state } = prepared();
    const id = Object.values(state.records).find((r) => r.kind === 'task').id;
    const report = reduce(state, 'report', { units: 5 }, id);
    state = report.state;
    state = reduce(
      state,
      'undo-report',
      { reportId: report.receipt.reportId },
      id,
      NOW + 1000,
    ).state;
    expect(planWallet(state)).toMatchObject({ balance: 100, experience: 0, risk: 11 });
    expect(() => reduce(state, 'undo-report', { reportId: report.receipt.reportId }, id)).toThrow();
  });
  it('reserves open consequences and protects redemption, coupons and purchase readiness', () => {
    let { state } = prepared(105);
    const reward = reduce(state, 'reward-save', {
      title: 'Кіно',
      price: 100,
      scale: 'near',
      repeatable: true,
    });
    state = reward.state;
    expect(() => reduce(state, 'redeem', {}, reward.receipt.id)).toThrow();
    const id = Object.values(state.records).find((r) => r.kind === 'task').id;
    state = reduce(state, 'report', { units: 5 }, id).state;
    const redemption = reduce(state, 'redeem', {}, reward.receipt.id);
    state = redemption.state;
    expect(state.balance).toBe(40);
    state = reduce(state, 'coupon-refund', {}, redemption.receipt.id).state;
    expect(state.balance).toBe(140);
    expect(() => reduce(state, 'coupon-refund', {}, redemption.receipt.id)).toThrow();
    const watch = reduce(state, 'reward-save', { title: 'Apple Watch', price: 1, scale: 'large' });
    state = watch.state;
    expect(() => reduce(state, 'redeem', {}, watch.receipt.id)).toThrow('підтвердь');
  });
  it('ties a night-shift outcome to real shift end instead of the 04:00 day boundary', () => {
    let { state } = prepared(100, { deadlineKind: 'shift', dueAt: '2026-10-17T09:00:00Z' });
    const id = Object.values(state.records).find((r) => r.kind === 'task').id;
    const shift = reduce(state, 'shift-open', { reviewAt: '2026-10-17T09:00:00Z' });
    state = shift.state;
    state = reduce(
      state,
      'shift-close',
      { endedAt: '2026-10-17T02:20:00Z' },
      shift.receipt.id,
      Date.parse('2026-10-17T02:21:00Z'),
    ).state;
    expect(task(state, id).dueAt).toBe('2026-10-17T02:20:00.000Z');
    state = reduce(
      state,
      'report',
      { units: 5, actualAt: '2026-10-17T02:20:00Z' },
      id,
      Date.parse('2026-10-17T02:22:00Z'),
    ).state;
    expect(task(state, id).penaltyApplied).toBeUndefined();
    expect(state.experience).toBe(35);
  });
});

describe('shared D1 boundary and delivery', () => {
  it('applies a late-reported earlier result to an already reaccepted remainder without a new risk', () => {
    const initial = prepared();
    let state = reduce(initial.state, '_settle', {}, undefined, AFTER).state;
    const next = reduce(state, 'recommit', { date: '2026-10-17' }, initial.id, AFTER);
    state = next.state;
    state = reduce(state, 'accept', { date: '2026-10-17' }, undefined, AFTER).state;
    state = reduce(
      state,
      'report',
      { units: 5, actualAt: '2026-10-16T09:00:00Z' },
      initial.id,
      AFTER + 1,
    ).state;
    expect(state.balance).toBe(135);
    expect(state.experience).toBe(35);
    expect(planWallet(state).risk).toBe(0);
    expect(
      planView(state, AFTER + 1).tasks.find((t) => t.id === next.receipt.id).facts.onTimeUnits,
    ).toBe(5);
  });
  it('rejects one of two competing account revisions without leaving a partial task or receipt', async () => {
    const { env, db } = setup();
    const commands = [0, 1].map(() => ({
      op: 'task-save',
      payload: payload(),
      revision: 0,
      commandId: crypto.randomUUID(),
    }));
    const results = await Promise.allSettled(
      commands.map((command) => executePlanCommand(env, command, NOW)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect((await readPlanWorkspace(env, NOW)).tasks).toHaveLength(1);
    expect(db.prepare('SELECT count(*) AS n FROM motivation_commands').get()?.n).toBe(1);
    expect(db.prepare('SELECT count(*) AS n FROM motivation_guards').get()?.n).toBe(0);
  });
  it('defers an already queued notice across quiet hours rather than consuming it', async () => {
    const { env } = setup();
    await executePlanCommand(
      env,
      { op: 'settings', payload: { enabled: true }, revision: 0, commandId: 'quiet-settings' },
      NOW,
    );
    await env.BRIEFING.put(
      'settings',
      JSON.stringify({
        quiet: { enabled: true, from: '09:00', to: '11:00' },
        modules: {},
        mutedTopics: [],
      }),
    );
    expect(await renderPlanNotice(env, { date: '2026-10-17' }, NOW)).toMatchObject({
      deferSeconds: 3660,
    });
  });
  it('atomically persists account, task, audit and retry receipt; rejects changed retries and stale writes', async () => {
    const { env, db } = setup();
    const command = {
      op: 'task-save',
      payload: payload(),
      revision: 0,
      commandId: 'first-command',
    };
    const receipt = await executePlanCommand(env, command, NOW);
    expect(await executePlanCommand(env, command, NOW + 1)).toEqual(receipt);
    expect((await readPlanWorkspace(env, NOW)).tasks).toHaveLength(1);
    await expect(
      executePlanCommand(env, { ...command, payload: payload({ title: 'Інше' }) }, NOW),
    ).rejects.toThrow('Ідентифікатор');
    await expect(
      executePlanCommand(env, { ...command, commandId: 'stale-command' }, NOW),
    ).rejects.toThrow('змінився');
    expect(db.prepare('SELECT count(*) AS n FROM motivation_ledger').get()?.n).toBe(1);
  });
  it('rolls back record and balance on a mid-transaction error', async () => {
    const { env, db } = setup();
    db.exec(
      "CREATE TRIGGER fail_ledger BEFORE INSERT ON motivation_ledger BEGIN SELECT RAISE(ABORT,'simulated storage failure'); END",
    );
    await expect(
      executePlanCommand(
        env,
        { op: 'task-save', payload: payload(), revision: 0, commandId: 'storage-fail' },
        NOW,
      ),
    ).rejects.toThrow();
    expect(db.prepare('SELECT count(*) AS n FROM motivation_records').get()?.n).toBe(0);
    expect(db.prepare('SELECT count(*) AS n FROM motivation_commands').get()?.n).toBe(0);
    expect((await readPlanWorkspace(env, NOW)).revision).toBe(0);
  });
  it('authenticates the primary owner and never accepts internal scheduler commands from Mini App', async () => {
    const { env } = setup();
    const denied = await handlePlan(new Request('https://test/api/plan'), env);
    expect(denied.status).toBe(401);
    const init = await buildInitData(42, env.TELEGRAM_BOT_TOKEN!);
    const response = await handlePlan(
      new Request('https://test/api/plan', {
        method: 'POST',
        headers: { 'X-Telegram-Init-Data': init, 'content-type': 'application/json' },
        body: JSON.stringify({ op: '_settle', revision: 0, commandId: 'forged-settle' }),
      }),
      env,
    );
    expect(response.status).toBe(400);
  });
  it('deduplicates scheduler notices and discards completed-task pings before sending', async () => {
    const { env, db } = setup();
    let rev = 0;
    const write = async (op: string, p: Record<string, unknown>, id?: string) => {
      const receipt = await executePlanCommand(
        env,
        { op, payload: p, id, revision: rev++, commandId: crypto.randomUUID() },
        NOW,
      );
      return receipt;
    };
    await write('settings', { enabled: true });
    const draft = await write(
      'task-save',
      payload({ target: 1, startAt: '2026-10-16T07:05:00Z', remindMinutes: 10 }),
    );
    await write('accept', { date: '2026-10-16' });
    await motivationTask(env, NOW);
    await motivationTask(env, NOW);
    expect(db.prepare('SELECT count(*) AS n FROM outbox').get()?.n).toBe(1);
    const notice = JSON.parse(
      String(db.prepare('SELECT payload_json FROM outbox').get()?.payload_json),
    ).plan_notice;
    expect(await renderPlanNotice(env, notice, NOW)).toMatchObject({
      text: expect.stringContaining('SQL'),
    });
    const current = await readPlanWorkspace(env, NOW);
    await executePlanCommand(
      env,
      {
        op: 'report',
        id: draft.id,
        payload: { units: 1 },
        revision: current.revision,
        commandId: 'complete-task',
      },
      NOW,
    );
    expect(await renderPlanNotice(env, notice, NOW)).toBeNull();
  });
  it('projects explicit calendar blocks with a stable provider id and preserves commitment timing', async () => {
    const { env } = setup();
    let rev = 0;
    for (const [op, p] of [
      ['settings', { enabled: true }],
      [
        'task-save',
        payload({ calendar: true, startAt: '2026-10-16T08:00:00Z', endAt: '2026-10-16T09:00:00Z' }),
      ],
      ['accept', { date: '2026-10-16' }],
    ] as const)
      await executePlanCommand(
        env,
        { op, payload: p, revision: rev++, commandId: crypto.randomUUID() },
        NOW,
      );
    await motivationCalendarTask(env, NOW);
    await motivationCalendarTask(env, NOW);
    expect(google.create).toHaveBeenCalledTimes(1);
    expect(google.create.mock.calls[0]![1].id).toMatch(/^svp[0-9a-f]{64}$/);
    const workspace = await readPlanWorkspace(env, NOW);
    expect(workspace.tasks[0].calendarState).toBe('synced');
    expect(workspace.tasks[0].dueAt).toBe(DUE);
  });
  it('only creates navigation from allowlisted plan links', () => {
    expect(planPathForStartParam('plan_date_2026-10-17')).toBe('/plan?date=2026-10-17');
    expect(planPathForStartParam('plan_task_task-abc')).toContain('task=task-abc');
    expect(planPathForStartParam('plan_task_<script>')).toBeNull();
  });
});
