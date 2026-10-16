import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyPlanCommand,
  emptyPlan,
  dayBoundaryAt,
  personalPlanDate,
  currentPlanDate,
  planRecords,
  taskFacts,
  type PlanState,
} from '../web/core/motivation/model.mjs';
import { XP_CATEGORIES, suggestTaskScore } from '../web/core/motivation/scoring.mjs';
import {
  executePlanCommand,
  readPlanState,
  readPlanWorkspace,
} from '../web/core/motivation/store.mjs';
import {
  synchronizePlanFinance,
  checkRewardMoney,
  annotatePlanRewards,
} from '../web/core/motivation/finance-link.mjs';
import { suggestPlanDraft } from '../web/core/motivation/draft.mjs';
import { financeSchema } from '../web/app/src/api/finance-schema.ts';
import { d1FromSqlite } from './helpers/d1.js';
import { workerEnv } from './helpers/env.js';
import { motivationTask, renderPlanNotice } from '../web/core/motivation/jobs.mjs';
import { handlePlan } from '../web/api-plan.mjs';
import { buildInitData } from './helpers/init-data.js';

const financeReader = vi.hoisted(() => vi.fn());
const calendarReader = vi.hoisted(() => vi.fn());
vi.mock('../web/google.mjs', async (original) => ({
  ...(await original<object>()),
  readCalendarRange: calendarReader,
}));
vi.mock('../web/core/finance/workspace.mjs', () => ({ readFinanceWorkspace: financeReader }));
const NOW = Date.parse('2026-10-17T07:00:00Z'),
  DATE = '2026-10-17';
let serial = 0;
function step(
  state: PlanState,
  op: string,
  payload: Record<string, unknown> = {},
  id?: string,
  at = NOW,
) {
  return applyPlanCommand(state, { op, payload, id, commandId: `ecosystem-${++serial}` }, at);
}
const taskPayload = (extra: Record<string, unknown> = {}) => ({
  date: DATE,
  title: 'Важливий результат',
  criterion: 'Отримано перевірний результат',
  target: 1,
  deadlineKind: 'day',
  scoringVersion: 2,
  ...extra,
});
function setup() {
  const { stub, db } = d1FromSqlite(
    ['0001_base.sql', '0002_assistant.sql', '0003_telemetry.sql', '0042_motivation_plan.sql'],
    { atomicBatch: true },
  );
  const env = workerEnv({
    DB: stub,
    OPENAI_API_KEY: 'local-test-key',
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_OWNER_USER_ID: '42',
    ASSISTANT_HOME: 'dm',
  });
  const write = async (op: string, payload: Record<string, unknown> = {}, id?: string, at = NOW) =>
    executePlanCommand(
      env,
      {
        op,
        payload,
        id,
        commandId: `db-ecosystem-${++serial}`,
        revision: (await readPlanState(env)).revision,
      },
      at,
    );
  return { env, db, write };
}
function finances(balance = 100000) {
  return financeSchema.parse({
    ok: true,
    version: 0,
    generatedAt: new Date(NOW).toISOString(),
    settings: { incomePeriod: 'week', taxiVisible: true },
    categories: [],
    accounts: [
      {
        id: 'cash',
        name: 'Кошти',
        kind: 'cash',
        currency: 'UAH',
        balanceMinor: balance,
        asOf: null,
        monoId: null,
        source: 'manual',
      },
    ],
    transactions: [],
    policies: [],
    taxiEntries: [],
    taxiWeeks: [],
    settlements: [],
    reserveMinor: 0,
    forecast: { incomes: [] },
    goals: [],
    goalMoves: [],
    budgets: [],
    payments: [],
    detectedSubscriptions: [],
  });
}
beforeEach(() => {
  serial = 0;
  financeReader.mockReset();
  calendarReader.mockReset();
});
afterEach(() => vi.unstubAllGlobals());
describe('transparent XP and personal day', () => {
  it('offers nine ordered categories, keeps routine microsteps small and distinguishes meaningful work', () => {
    expect(XP_CATEGORIES.map((c) => c.xp)).toEqual([5, 10, 15, 20, 30, 35, 50, 75, 100]);
    expect(suggestTaskScore({ effort: 0, contribution: 0, challenge: 0, routine: true }).xp).toBe(
      5,
    );
    expect(
      suggestTaskScore({
        effort: 2,
        contribution: 0,
        challenge: 2,
        routine: true,
        estimateMinutes: 120,
      }).xp,
    ).toBe(15);
    expect(
      suggestTaskScore({ effort: 2, contribution: 1, challenge: 2, estimateMinutes: 120 }).xp,
    ).toBe(100);
    const state = step(emptyPlan(), 'task-save', taskPayload({ effort: 0, routine: true })).state;
    expect(planRecords(state, 'task')[0].xp).toBe(5);
  });
  it('uses the first valid spring boundary and the later repeated autumn boundary', () => {
    const settings = emptyPlan().settings;
    expect(dayBoundaryAt('2026-03-29', settings)).toBe('2026-03-29T01:00:00.000Z');
    expect(dayBoundaryAt('2026-10-25', settings)).toBe('2026-10-25T01:00:00.000Z');
    expect(personalPlanDate(settings, Date.parse('2026-10-25T00:30:00Z'))).toBe('2026-10-24');
    expect(personalPlanDate(settings, Date.parse('2026-10-25T01:00:00Z'))).toBe('2026-10-25');
  });
  it('extends ordinary tasks once, keeps exact deadlines and preserves the current day until overtime ends', () => {
    let state = step(emptyPlan(), 'settings', { enabled: true }).state;
    state = step(state, 'task-save', taskPayload()).state;
    state = step(
      state,
      'task-save',
      taskPayload({ deadlineKind: 'time', dueAt: '2026-10-17T20:00:00Z' }),
    ).state;
    state = step(state, 'accept', { date: DATE }).state;
    const extended = step(state, 'day-extend', {
      date: DATE,
      until: '2026-10-18T02:00:00Z',
      reason: 'Довша зміна',
    }).state;
    expect(planRecords(extended, 'task').map((t) => t.dueAt)).toEqual([
      '2026-10-18T02:00:00.000Z',
      '2026-10-17T20:00:00.000Z',
    ]);
    expect(currentPlanDate(extended, Date.parse('2026-10-18T01:00:00Z'))).toBe(DATE);
    expect(currentPlanDate(extended, Date.parse('2026-10-18T02:00:00Z'))).toBe('2026-10-18');
    expect(() =>
      step(extended, 'day-extend', { date: DATE, until: '2026-10-18T03:00:00Z', reason: 'Ще' }),
    ).toThrow('один раз');
    expect(() =>
      step(
        state,
        'day-extend',
        { date: DATE, until: '2026-10-18T03:00:00Z', reason: 'Запізно' },
        undefined,
        Date.parse('2026-10-18T00:00:00Z'),
      ),
    ).toThrow('до його межі');
  });
});
describe('recurring drafts', () => {
  it('never duplicates the original day, requires acceptance and never regenerates a deleted occurrence', () => {
    const first = step(
      emptyPlan(),
      'task-save',
      taskPayload({ template: true, templateDays: [0, 1, 2, 3, 4, 5, 6] }),
    );
    let state = step(first.state, '_templates', { date: DATE }).state;
    expect(planRecords(state, 'task')).toHaveLength(1);
    state = step(state, '_templates', { date: '2026-10-18' }).state;
    const next = planRecords(state, 'task').find((t) => t.date === '2026-10-18');
    expect(next.status).toBe('draft');
    expect(state.balance).toBe(0);
    state = step(state, 'task-delete', {}, next.id).state;
    state = step(state, '_templates', { date: '2026-10-18' }).state;
    expect(planRecords(state, 'task')).toHaveLength(1);
  });
  it('preserves wall clocks across DST and isolates an invalid exact-time template', () => {
    let state = step(
      emptyPlan(),
      'task-save',
      taskPayload({
        date: '2026-10-23',
        deadlineKind: 'time',
        dueAt: '2026-10-23T00:30:00Z',
        template: true,
        templateDays: [0],
      }),
    ).state;
    state = step(
      state,
      'task-save',
      taskPayload({ date: '2026-10-23', template: true, templateDays: [0] }),
    ).state;
    state = step(state, '_templates', { date: '2026-10-25' }).state;
    expect(
      planRecords(state, 'template').filter((t) => t.lastErrorDate === '2026-10-25'),
    ).toHaveLength(1);
    expect(planRecords(state, 'task').filter((t) => t.date === '2026-10-25')).toHaveLength(1);
    state = step(state, '_templates', { date: '2026-11-01' }).state;
    expect(
      planRecords(state, 'task').find((t) => t.date === '2026-11-01' && t.deadlineKind === 'time')
        .dueAt,
    ).toBe('2026-11-01T01:30:00.000Z');
  });
  it('processes template 21 on a subsequent batch instead of starving it behind used templates', () => {
    let state = emptyPlan();
    for (let i = 0; i < 21; i++)
      state = step(state, 'task-save', taskPayload({ template: true, templateDays: [0] })).state;
    state = step(state, '_templates', { date: '2026-10-18' }).state;
    expect(planRecords(state, 'task').filter((t) => t.date === '2026-10-18')).toHaveLength(20);
    state = step(state, '_templates', { date: '2026-10-18' }).state;
    expect(planRecords(state, 'task').filter((t) => t.date === '2026-10-18')).toHaveLength(21);
  });
});
describe('finance facts and reward readiness', () => {
  it('synchronizes only facts after acceptance, corrects source edits and never remints spent XP', async () => {
    const { env, write } = setup();
    await write('settings', { enabled: true });
    const created = await write(
      'task-save',
      taskPayload({ target: 100, xp: 100, source: { kind: 'taxi', metric: 'net' } }),
    );
    await write('accept', { date: DATE });
    const entry = (id: string, netCashMinor: number, at = '2026-10-17T08:00:00Z') => ({
      id,
      at,
      netCashMinor,
      commissionMinor: 0,
      revision: 1,
      commissionReported: true,
    });
    const snapshot = {
      taxiEntries: [entry('before', 90000, '2026-10-17T06:00:00Z'), entry('actual', 10000)],
    };
    const later = NOW + 7200000;
    await synchronizePlanFinance(env, later, snapshot);
    let state = await readPlanState(env);
    expect(state.balance).toBe(100);
    expect(taskFacts(state, state.records[created.id]).done).toBe(true);
    await synchronizePlanFinance(env, later, snapshot);
    expect((await readPlanState(env)).balance).toBe(100);
    const reward = await write(
      'reward-save',
      { title: 'Дозвіл', price: 100, scale: 'near' },
      undefined,
      later,
    );
    await write('redeem', {}, reward.id, later);
    snapshot.taxiEntries = [entry('actual', 5000)];
    await synchronizePlanFinance(env, later, snapshot);
    state = await readPlanState(env);
    expect(state.balance).toBe(0);
    expect(state.experience).toBe(50);
    snapshot.taxiEntries = [entry('actual', 10000)];
    await synchronizePlanFinance(env, later, snapshot);
    state = await readPlanState(env);
    expect(state.balance).toBe(0);
    expect(state.experience).toBe(100);
    await expect(write('report', { units: 100 }, created.id, later)).rejects.toThrow('із фінансів');
    snapshot.taxiEntries = [];
    await synchronizePlanFinance(env, later, snapshot);
    expect(
      taskFacts(await readPlanState(env), (await readPlanState(env)).records[created.id]).units,
    ).toBe(0);
  });
  it('keeps the last confirmed gross fact when commission becomes unknown and refuses overlapping sources', async () => {
    const { env, write } = setup();
    await write('settings', { enabled: true });
    const created = await write(
      'task-save',
      taskPayload({ target: 200, xp: 50, source: { kind: 'taxi', metric: 'gross' } }),
    );
    await write('accept', { date: DATE });
    const snapshot = {
      taxiEntries: [
        {
          id: 'a',
          at: '2026-10-17T08:00:00Z',
          netCashMinor: 10000,
          commissionMinor: 5000,
          commissionReported: true,
        },
      ],
    };
    await synchronizePlanFinance(env, NOW + 7200000, snapshot);
    snapshot.taxiEntries[0]!.commissionReported = false;
    await synchronizePlanFinance(env, NOW + 7200000, snapshot);
    const task = (await readPlanState(env)).records[created.id];
    expect(task.source.warning).toContain('комісію');
    expect(taskFacts(await readPlanState(env), task).units).toBe(150);
    await write('task-save', taskPayload({ target: 100, source: { kind: 'taxi', metric: 'net' } }));
    await expect(write('accept', { date: DATE })).rejects.toThrow('подвійного XP');
    await expect(write('_source-sync', { proof: 'forged' }, created.id)).rejects.toThrow();
  });
  it('opens a permanent reward through experience without spending wallet XP', () => {
    let state = emptyPlan();
    state.experience = 100;
    state.balance = 20;
    const reward = step(state, 'reward-save', {
      title: 'Можливість',
      price: 100,
      mode: 'unlock',
      scale: 'near',
    });
    state = step(reward.state, 'redeem', {}, reward.receipt.id).state;
    expect(state.balance).toBe(20);
    expect(planRecords(state, 'coupon')[0].status).toBe('unlocked');
    expect(() => step(state, 'redeem', {}, reward.receipt.id)).toThrow('вже отримано');
  });
  it('requires actual money despite a large future income and reads one coherent snapshot for reward cards', async () => {
    const { env } = setup();
    const f = finances(10000);
    f.forecast.incomes = [
      {
        id: 'future',
        name: 'Прогноз',
        source: 'other',
        amountMinor: 1000000,
        nextDate: DATE,
        recurrence: 'once',
      },
    ];
    financeReader.mockResolvedValue(f);
    const reward = { purchase: { amountMinor: 20000, bufferMinor: 10000, horizonDays: 7 } };
    expect((await checkRewardMoney(env, reward, NOW)).ready).toBe(false);
    f.accounts[0]!.balanceMinor = 100000;
    expect((await checkRewardMoney(env, reward, NOW)).ready).toBe(true);
    financeReader.mockClear();
    expect(await annotatePlanRewards(env, [reward, reward], NOW)).toHaveLength(2);
    expect(financeReader).toHaveBeenCalledTimes(1);
  });
  it('rechecks financial readiness at redemption rather than trusting an earlier card', async () => {
    const { env, write, db } = setup();
    const state = emptyPlan();
    state.balance = 100;
    state.experience = 100;
    db.prepare('INSERT INTO motivation_account(id,revision,data_json) VALUES(1,0,?)').run(
      JSON.stringify(state),
    );
    financeReader.mockResolvedValue(finances(100000));
    const reward = await write('reward-save', {
      title: 'Покупка',
      price: 50,
      purchase: { amountMinor: 20000, bufferMinor: 0, horizonDays: 7 },
    });
    expect((await readPlanWorkspace(env, NOW)).rewards[0].affordability.ready).toBe(true);
    financeReader.mockResolvedValue(finances(100));
    await expect(write('redeem', {}, reward.id)).rejects.toThrow('недостатньо');
    expect((await readPlanState(env)).balance).toBe(100);
  });
});
describe('complete journal and reviewed assistant suggestions', () => {
  it('paginates over 100 events at exactly the same timestamp without skips or duplicates', async () => {
    const { env, db } = setup();
    for (let i = 0; i < 205; i++) {
      const id = `history-${String(i).padStart(3, '0')}`;
      db.prepare(
        'INSERT INTO motivation_ledger(id,command_id,at,kind,delta,experience_delta,data_json) VALUES(?,?,?,?,0,0,?)',
      ).run(
        id,
        'history',
        new Date(NOW).toISOString(),
        'settings',
        JSON.stringify({
          id,
          at: new Date(NOW).toISOString(),
          kind: 'settings',
          title: 'Подія',
          delta: 0,
          balance: 0,
        }),
      );
    }
    const first = await readPlanWorkspace(env, NOW),
      second = await readPlanWorkspace(env, NOW, { cursor: first.historyCursor }),
      third = await readPlanWorkspace(env, NOW, { cursor: second.historyCursor });
    expect([first.events.length, second.events.length, third.events.length]).toEqual([100, 100, 5]);
    expect(
      new Set([...first.events, ...second.events, ...third.events].map((e) => e.id)).size,
    ).toBe(205);
    expect(third.historyCursor).toBeNull();
    for (const cursor of ['null', '{}', 'bad'])
      await expect(readPlanWorkspace(env, NOW, { cursor })).rejects.toThrow('сторінка');
  });
  it('creates no task, uses structured output without tools/private profile, limits attempts to 15 per day', async () => {
    const { env, db } = setup();
    const draft = {
      title: 'Практика SQL',
      criterion: 'Розв’язано 5 задач',
      target: 5,
      unit: 'задач',
      area: 'learning',
      effort: 1,
      contribution: 1,
      challenge: 1,
      routine: false,
      estimateMinutes: 60,
      firstStep: 'Відкрити завдання',
      dueTime: null,
      startTime: null,
      timeSensitive: false,
      source: null,
      questions: [],
    };
    const call = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            status: 'completed',
            usage: { input_tokens: 10, output_tokens: 30 },
            output: [{ content: [{ type: 'output_text', text: JSON.stringify(draft) }] }],
          }),
        ),
    );
    for (let i = 0; i < 15; i++)
      expect(
        (await suggestPlanDraft(env, { date: DATE, text: 'Хочу практикувати SQL' }, NOW, call)).xp,
      ).toBe(suggestTaskScore(draft).xp);
    await expect(suggestPlanDraft(env, { date: DATE, text: 'Ще' }, NOW, call)).rejects.toThrow(
      '15',
    );
    expect(call).toHaveBeenCalledTimes(15);
    const request = JSON.parse(
      (call.mock.calls as unknown as [string, RequestInit][])[0]![1].body as string,
    );
    expect(request.store).toBe(false);
    expect(request.tools).toBeUndefined();
    expect(request.text.format.strict).toBe(true);
    expect(JSON.parse(request.input)).toEqual({ date: DATE, text: 'Хочу практикувати SQL' });
    expect(db.prepare('SELECT count(*) n FROM motivation_records').get()?.n).toBe(0);
  });
  it.each(['refusal', 'malformed', 'invalid-score'])(
    'fails a %s suggestion cleanly and never saves it',
    async (kind) => {
      const { env, db } = setup();
      const call = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              status: 'completed',
              output: [
                {
                  content: [
                    kind === 'refusal'
                      ? { type: 'refusal', refusal: 'No' }
                      : {
                          type: 'output_text',
                          text:
                            kind === 'malformed'
                              ? '{'
                              : JSON.stringify({
                                  title: 'x',
                                  criterion: 'x',
                                  unit: 'x',
                                  target: 1,
                                  firstStep: '',
                                  effort: 100,
                                }),
                        },
                  ],
                },
              ],
            }),
          ),
      );
      await expect(
        suggestPlanDraft(env, { date: DATE, text: 'Задача' }, NOW, call),
      ).rejects.toThrow('Не вдалося');
      expect(db.prepare('SELECT count(*) n FROM motivation_records').get()?.n).toBe(0);
    },
  );
});

describe('edge cases that must not silently change a promise', () => {
  it('starts tomorrow’s taxi window after today’s explicit overtime, for both existing and new drafts', () => {
    let state = step(emptyPlan(), 'settings', { enabled: true }).state;
    state = step(
      state,
      'task-save',
      taskPayload({ target: 200, source: { kind: 'taxi', metric: 'net' } }),
    ).state;
    state = step(state, 'accept', { date: DATE }).state;
    const next = step(
      state,
      'task-save',
      taskPayload({ date: '2026-10-18', target: 200, source: { kind: 'taxi', metric: 'net' } }),
    );
    state = step(next.state, 'day-extend', {
      date: DATE,
      until: '2026-10-18T02:00:00Z',
      reason: 'Довша зміна',
    }).state;
    expect(state.records[next.receipt.id].source.from).toBe('2026-10-18T02:00:00.000Z');
    expect(() => step(state, 'accept', { date: '2026-10-18' })).not.toThrow();
    state = step(state, 'task-delete', {}, next.receipt.id).state;
    const fresh = step(
      state,
      'task-save',
      taskPayload({ date: '2026-10-18', target: 200, source: { kind: 'taxi', metric: 'net' } }),
    );
    expect(fresh.state.records[fresh.receipt.id].source.from).toBe('2026-10-18T02:00:00.000Z');
  });
  it('keeps generated identifiers usable even when the original command id has maximum length', () => {
    let state = applyPlanCommand(
      emptyPlan(),
      {
        op: 'task-save',
        commandId: 'x'.repeat(80),
        payload: taskPayload({ template: true, templateDays: [0] }),
      },
      NOW,
    ).state;
    const template = planRecords(state, 'template')[0];
    state = step(state, 'template-use', { date: '2026-10-18' }, template.id).state;
    expect(planRecords(state, 'task').every((t) => t.id.length <= 100)).toBe(true);
    state = step(state, 'template-archive', {}, template.id).state;
    expect(step(state, '_templates', { date: '2026-10-25' }).state.records).toEqual(state.records);
  });
  it('rejects overtime that would make two accepted taxi windows overlap', () => {
    let state = step(emptyPlan(), 'settings', { enabled: true }).state;
    for (const date of [DATE, '2026-10-18']) {
      state = step(
        state,
        'task-save',
        taskPayload({ date, target: 200, source: { kind: 'taxi', metric: 'net' } }),
      ).state;
      state = step(state, 'accept', { date }).state;
    }
    expect(() =>
      step(state, 'day-extend', { date: DATE, until: '2026-10-18T02:00:00Z', reason: 'Довше' }),
    ).toThrow('перетнеться');
  });
  it('records late source work as late and penalizes only the part missing at the accepted deadline', async () => {
    const { env, write } = setup();
    await write('settings', { enabled: true });
    const made = await write(
      'task-save',
      taskPayload({
        deadlineKind: 'time',
        dueAt: '2026-10-17T10:00:00Z',
        xp: 50,
        target: 200,
        source: { kind: 'taxi', metric: 'net' },
      }),
    );
    await write('accept', { date: DATE });
    const entries = ['09', '11'].map((hour) => ({
      id: hour,
      at: `2026-10-17T${hour}:00:00Z`,
      netCashMinor: 10000,
      commissionMinor: 0,
      commissionReported: true,
    }));
    await synchronizePlanFinance(env, Date.parse('2026-10-17T13:00:00Z'), { taxiEntries: entries });
    let state = await readPlanState(env);
    expect(taskFacts(state, state.records[made.id])).toMatchObject({
      units: 200,
      onTimeUnits: 100,
      done: true,
      risk: 8,
    });
    await executePlanCommand(
      env,
      { op: '_settle', commandId: 'source-late-settle' },
      Date.parse('2026-10-17T22:00:00Z'),
      { internal: true },
    );
    state = await readPlanState(env);
    expect(state.balance).toBe(42);
    expect(state.records[made.id].penaltyApplied).toBe(8);
  });
  it('refuses incomplete or unavailable finance rather than granting a purchase permission', async () => {
    const { env } = setup(),
      reward = { purchase: { amountMinor: 100, bufferMinor: 0, horizonDays: 7 } };
    const f = finances();
    f.accounts[0]!.balanceMinor = null;
    expect(await checkRewardMoney(env, reward, NOW, f)).toMatchObject({
      ready: false,
      reason: expect.stringContaining('неповні'),
    });
    financeReader.mockRejectedValue(new Error('offline'));
    expect((await checkRewardMoney(env, reward, NOW)).ready).toBe(false);
    expect(await annotatePlanRewards(env, [reward, { title: 'Без грошей' }], NOW)).toEqual([
      expect.objectContaining({
        affordability: expect.objectContaining({ ready: false, checkedAt: expect.any(String) }),
      }),
      expect.objectContaining({ affordability: null }),
    ]);
  });
});

describe('server reminders revalidate the actual current plan', () => {
  it('groups an overdue report, emits a daily check-in once, and deduplicates every queued notice', async () => {
    const { env, db, write } = setup();
    await write('settings', { enabled: true });
    for (const hour of ['15', '16'])
      await write(
        'task-save',
        taskPayload({ deadlineKind: 'time', dueAt: `2026-10-17T${hour}:00:00Z` }),
      );
    await write('accept', { date: DATE });
    const later = Date.parse('2026-10-17T17:45:00Z');
    await motivationTask(env, later);
    const count = db.prepare('SELECT count(*) n FROM outbox').get()?.n;
    await motivationTask(env, later);
    expect(db.prepare('SELECT count(*) n FROM outbox').get()?.n).toBe(count);
    const payloads = db
      .prepare('SELECT payload_json FROM outbox')
      .all()
      .map((r) => JSON.parse(String(r.payload_json)).plan_notice);
    expect(payloads.filter((n) => n.kind === 'report-day')).toHaveLength(1);
    expect(payloads.filter((n) => n.kind === 'daily')).toHaveLength(1);
    expect(
      await renderPlanNotice(
        env,
        payloads.find((n) => n.kind === 'report-day'),
        later,
      ),
    ).toMatchObject({ text: expect.stringContaining('2 задач') });
    expect(await renderPlanNotice(env, { kind: 'daily', date: '2026-10-16' }, later)).toBeNull();
    expect(
      await renderPlanNotice(env, { kind: 'report-day', date: '2026-10-16' }, later),
    ).toBeNull();
    expect(
      await renderPlanNotice(env, { kind: 'evening', date: '2026-10-18' }, later),
    ).toMatchObject({ text: expect.stringContaining('Завтра') });
    expect(await renderPlanNotice(env, { kind: 'evening', date: '2026-10-19' }, later)).toBeNull();
  });
  it('sends a voluntary five-minute follow-up but discards early, obsolete and expired focus signals', async () => {
    const { env, db, write } = setup();
    await write('settings', { enabled: true });
    const made = await write(
      'task-save',
      taskPayload({ deadlineKind: 'time', dueAt: '2026-10-17T18:00:00Z', remindMinutes: 10 }),
    );
    await write('accept', { date: DATE });
    const start = Date.parse('2026-10-17T17:40:00Z');
    await write('focus-start', {}, made.id, start);
    const notice = { kind: 'focus', taskId: made.id, version: 1 };
    expect(await renderPlanNotice(env, notice, start)).toBeNull();
    expect(await renderPlanNotice(env, notice, start + 360000)).toMatchObject({
      text: expect.stringContaining('П’ять хвилин'),
    });
    expect(await renderPlanNotice(env, { ...notice, version: 0 }, start + 360000)).toBeNull();
    expect(await renderPlanNotice(env, notice, start + 1200001)).toBeNull();
    await motivationTask(env, start + 360000);
    expect(
      db
        .prepare(
          "SELECT count(*) n FROM outbox WHERE json_extract(payload_json,'$.plan_notice.kind')='focus'",
        )
        .get()?.n,
    ).toBe(1);
    expect(
      await renderPlanNotice(
        env,
        { ...notice, kind: 'deadline' },
        Date.parse('2026-10-17T18:01:00Z'),
      ),
    ).toBeNull();
    expect(await renderPlanNotice(env, { ...notice, kind: 'start' }, start + 360000)).toBeNull();
    expect(
      await renderPlanNotice(env, { ...notice, taskId: 'missing' }, start + 360000),
    ).toBeNull();
  });
  it('produces a single deadline notice and prepares selected recurring drafts without accepting them', async () => {
    const { env, db, write } = setup();
    await write('settings', { enabled: true });
    await write(
      'task-save',
      taskPayload({
        deadlineKind: 'time',
        dueAt: '2026-10-17T18:00:00Z',
        remindMinutes: 10,
        template: true,
        templateDays: [0],
      }),
    );
    await write('accept', { date: DATE });
    const at = Date.parse('2026-10-17T17:40:00Z');
    await motivationTask(env, at);
    await motivationTask(env, at + 60000);
    const notices = db
      .prepare('SELECT payload_json FROM outbox')
      .all()
      .map((r) => JSON.parse(String(r.payload_json)).plan_notice);
    expect(notices.filter((n) => n.kind === 'deadline')).toHaveLength(1);
    expect(
      await renderPlanNotice(
        env,
        notices.find((n) => n.kind === 'deadline'),
        at,
      ),
    ).toMatchObject({ text: expect.stringContaining('Наближається') });
    expect(
      planRecords(await readPlanState(env), 'task').find((t) => t.date === '2026-10-18').status,
    ).toBe('draft');
  });
});

describe('owner-only Mini App helper endpoints', () => {
  it('reads calendar events for the owner, reports an unavailable connector and blocks unsigned requests', async () => {
    const { env } = setup();
    const init = await buildInitData(42, env.TELEGRAM_BOT_TOKEN!);
    const request = () =>
      new Request(`https://test/api/plan?view=calendar&date=${DATE}`, {
        headers: { 'X-Telegram-Init-Data': init },
      });
    calendarReader.mockResolvedValue([]);
    expect(await (await handlePlan(request(), env)).json()).toMatchObject({ ok: true, events: [] });
    expect(calendarReader).toHaveBeenCalledWith(env, DATE, DATE);
    calendarReader.mockResolvedValue(null);
    expect((await handlePlan(request(), env)).status).toBe(503);
    expect((await handlePlan(new Request('https://test/api/plan?view=calendar'), env)).status).toBe(
      401,
    );
    const denied = await handlePlan(
      new Request('https://test/api/plan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'suggest', payload: { date: DATE, text: 'x' } }),
      }),
      env,
    );
    expect(denied.status).toBe(401);
    expect(
      (await handlePlan(new Request('https://test/api/plan', { method: 'DELETE' }), env)).status,
    ).toBe(405);
  });
});

const goodDraft = {
  title: 'Результат',
  criterion: 'Є результат',
  target: 1,
  unit: 'крок',
  area: 'life',
  effort: 1,
  contribution: 0,
  challenge: 0,
  routine: false,
  estimateMinutes: 0,
  firstStep: 'Почати',
  dueTime: null,
  startTime: null,
  timeSensitive: false,
  source: null,
  questions: [],
};
describe('assistant input and provider failures', () => {
  it('returns a successful owner-only form suggestion without writing a task or a commitment', async () => {
    const { env, db } = setup(),
      init = await buildInitData(42, env.TELEGRAM_BOT_TOKEN!);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              status: 'completed',
              output: [{ content: [{ type: 'output_text', text: JSON.stringify(goodDraft) }] }],
            }),
          ),
      ),
    );
    const response = await handlePlan(
      new Request('https://test/api/plan', {
        method: 'POST',
        headers: { 'X-Telegram-Init-Data': init, 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'suggest', payload: { date: DATE, text: 'Результат' } }),
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toMatchObject({
      ok: true,
      draft: { title: 'Результат', xp: 20 },
    });
    expect(db.prepare('SELECT count(*) n FROM motivation_records').get()?.n).toBe(0);
  });
  it('does not call a provider when local configuration or the owner description is missing', async () => {
    const { env } = setup();
    const fetcher = vi.fn();
    for (const input of [
      null,
      [],
      { date: DATE, text: '' },
      { date: DATE, text: 'x'.repeat(3001) },
    ])
      await expect(suggestPlanDraft(env, input, NOW, fetcher)).rejects.toThrow();
    await expect(
      suggestPlanDraft(
        { ...env, OPENAI_API_KEY: undefined },
        { date: DATE, text: 'x' },
        NOW,
        fetcher,
      ),
    ).rejects.toThrow('недоступний');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    { area: 'invented' },
    { routine: 'yes' },
    { timeSensitive: 'yes' },
    { target: 0 },
    { target: 1.5 },
    { unit: '' },
    { criterion: '' },
    { firstStep: 'x'.repeat(301) },
    { estimateMinutes: -1 },
    { dueTime: '25:00' },
    { questions: ['x'.repeat(501)] },
    { questions: ['1', '2', '3', '4', '5'] },
    { source: 'taxi-gross', target: 1 },
  ])('rejects an invalid suggestion %j without creating records', async (overrides) => {
    const { env, db } = setup();
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            status: 'completed',
            output: [
              {
                content: [
                  { type: 'output_text', text: JSON.stringify({ ...goodDraft, ...overrides }) },
                ],
              },
            ],
          }),
        ),
    );
    await expect(suggestPlanDraft(env, { date: DATE, text: 'x' }, NOW, fetcher)).rejects.toThrow(
      'Не вдалося',
    );
    expect(db.prepare('SELECT count(*) n FROM motivation_records').get()?.n).toBe(0);
  });
  it.each(['network', 'http', 'incomplete'])(
    'handles a provider %s failure without a false successful draft',
    async (kind) => {
      const { env } = setup();
      const fetcher = vi.fn(async () => {
        if (kind === 'network') throw new TypeError('offline');
        return new Response(JSON.stringify({ status: 'incomplete' }), {
          status: kind === 'http' ? 429 : 200,
        });
      });
      await expect(suggestPlanDraft(env, { date: DATE, text: 'x' }, NOW, fetcher)).rejects.toThrow(
        'Не вдалося',
      );
    },
  );
});
