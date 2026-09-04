// DayPlanChain (етап 3 PR-8, ADR-035, S-P-9…15): машина станів на фейкових
// step/io. Пінимо: вечірнє питання з кнопками і awaiting=intent; намір →
// працівник (intent) → уточнення кнопками → розкладка ядром → пояснення
// працівником або резерв formatDraft → кнопки прийняття → нагадування →
// ранковий план → вечірній огляд → перенос; резерви на тишу власника й
// відсутність працівника; кнопка «Не питай» → skipped; helpers старту/подій.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  runDayPlanChain,
  startDayPlanChain,
  sendDayPlanEvent,
  findAwaitingDayPlan,
  startDayPlannerRun,
  setChainState,
  normalizeIntent,
  parseDurationMin,
  applyAnswer,
  replanChanges,
  hhmmToMin,
  CHAIN_KIND,
  REPLAN_MAX_CHANGES,
} from '../web/core/day-plan/chain.mjs';
import { getDayPlan, listItems } from '../web/core/day-plan/store.mjs';
import { syncInstructionHash } from './helpers/instructions.js';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';
import { d1FromSqlite } from './helpers/d1.js';

const MIGRATIONS = [
  '0001_base.sql',
  '0002_assistant.sql',
  '0003_telemetry.sql',
  '0004_ideas_travel.sql',
  '0007_instructions_plans.sql',
  '0010_reminders_address.sql',
];
// Неділя 06.09.2026 18:00 Києва; план на понеділок 07.09.
const NOW = Date.parse('2026-09-06T15:00:00.000Z');
const DATE = '2026-09-07';

type Step = Parameters<typeof runDayPlanChain>[2];
type Io = Parameters<typeof runDayPlanChain>[3];
type Sent = { text: string; buttons: string[]; awaiting: string | null; status: string | null };

afterEach(() => {
  vi.unstubAllGlobals();
});

function fakeWorkflow() {
  const created: { id: string; params: unknown }[] = [];
  const events: { id: string; ev: unknown }[] = [];
  return {
    created,
    events,
    binding: {
      create: async (o: { id: string; params: unknown }) => void created.push(o),
      get: async (id: string) => ({
        sendEvent: async (ev: unknown) => void events.push({ id, ev }),
      }),
    } as unknown as Env['DAY_PLAN'],
  };
}

function setup() {
  const d1 = d1FromSqlite(MIGRATIONS);
  const wf = fakeWorkflow();
  const env = workerEnv({
    DB: d1.stub,
    BRIEFING: memoryKv(new Map()),
    TELEGRAM_CHAT_ID: '555',
    TOPIC_ASSISTANT: '99',
    DAY_PLAN: wf.binding,
  });
  return { d1, db: d1.db, env, wf };
}

/** Кроки Workflow: do виконує одразу, sleepUntil лише логує, події - з черг за типом. */
function fakeStep(queues: Record<string, ({ payload: unknown } | Error)[]>) {
  const log: string[] = [];
  const step: Step = {
    do: async (name, fn) => {
      log.push(`do:${name}`);
      return fn();
    },
    sleepUntil: async (name) => {
      log.push(`sleep:${name}`);
    },
    waitForEvent: async (name, { type }) => {
      log.push(`wait:${name}:${type}`);
      const next = queues[type]?.shift();
      if (!next) throw new Error(`timeout ${type}`);
      if (next instanceof Error) throw next;
      return next as { payload: unknown };
    },
  };
  return { step, log };
}

function fakeIo(
  db: ReturnType<typeof setup>['db'],
  chainId: string,
  over: Partial<Io> & { workerOk?: boolean } = {},
) {
  const sent: Sent[] = [];
  const startWorker = vi.fn<Io['startWorker']>(async () => over.workerOk ?? true);
  const io: Io = {
    now: () => NOW,
    send: async (text, buttons) => {
      const st = db
        .prepare(
          `SELECT status, json_extract(state_json, '$.awaiting') AS a FROM chains WHERE id = ?`,
        )
        .get(chainId) as { status: string; a: string | null } | undefined;
      sent.push({
        text,
        buttons: (buttons ?? []).flat().map((b) => b.callback_data),
        awaiting: st?.a ?? null,
        status: st?.status ?? null,
      });
    },
    startWorker,
    readCalendar: async () => [{ title: 'Зустріч', startMin: 10 * 60, endMin: 11 * 60 }],
    readEnergy: async () => null,
    ...over,
  };
  return { io, sent, startWorker };
}

const WORKER_INTENT = {
  payload: {
    mode: 'intent',
    output: {
      items: [
        { title: 'Презентація', kind: 'deep', est_min: 120 },
        { title: 'Банк', kind: 'errand', place: 'Центр' },
        { title: 'Зателефонувати Олені', kind: 'call' },
      ],
      questions: [{ q: 'Скільки на банк?', item: 1, options: ['30 хв', '1 год'] }],
    },
  },
};
const WORKER_EXPLAIN = { payload: { mode: 'explain', output: 'Пояснення дня від Денного' } };

describe('runDayPlanChain', () => {
  it('повний шлях: питання → намір → уточнення → чернетка з поясненням → ✅ → ранок → огляд → перенос', async () => {
    const { db, env } = setup();
    const chainId = await startDayPlanChain(env, DATE, NOW);
    const { step, log } = fakeStep({
      intent: [{ payload: { text: 'презентація 2 год, банк, зателефонувати Олені' } }],
      worker: [WORKER_INTENT, WORKER_EXPLAIN],
      answer: [{ payload: { item: 0, option: 1 } }],
      accept: [{ payload: { choice: 'accept' } }],
      carry: [{ payload: { choice: 'carry_all' } }],
    });
    const { io, sent, startWorker } = fakeIo(db, chainId);

    expect(await runDayPlanChain(env, { chainId, date: DATE }, step, io)).toEqual({
      outcome: 'done',
      items: 3,
    });

    // 1. Вечірнє питання - зі станом waiting/intent і двома кнопками c:.
    expect(sent[0]).toMatchObject({
      text: 'Що завтра (07.09)? 1-6 речей текстом або голосом; «нічого особливого» - теж відповідь.',
      buttons: [`c:${chainId}:none`, `c:${chainId}:skip`],
      awaiting: 'intent',
      status: 'waiting',
    });
    expect(log.slice(0, 4)).toEqual([
      'do:config',
      'sleep:intent-at',
      'do:ask-intent',
      'wait:wait-intent:intent',
    ]);
    // 2. Працівник intent з текстом і датою; уточнення - кнопки a<i>_<j>.
    expect(startWorker.mock.calls[0]).toEqual([
      'intent',
      { text: 'презентація 2 год, банк, зателефонувати Олені', date: DATE },
    ]);
    expect(sent[1]).toMatchObject({
      text: 'Скільки на банк?',
      buttons: [`c:${chainId}:a0_0`, `c:${chainId}:a0_1`],
      awaiting: 'answer',
    });
    expect((await getDayPlan(env, DATE))?.intent_text).toBe(
      'презентація 2 год, банк, зателефонувати Олені',
    );
    // 3. Розкладка ядром: відповідь «1 год» → Банк est_min 60 (сира оцінка),
    //    блок із запасом 60 × 1,3 = 80 хв у вікні; explain - працівником.
    const items = await listItems(env, DATE);
    const bank = items.find((i) => i.title === 'Банк');
    expect(bank).toMatchObject({ est_min: 60, kind: 'errand' });
    expect((hhmmToMin(bank?.window_end) ?? 0) - (hhmmToMin(bank?.window_start) ?? 0)).toBe(80);
    expect(items.filter((i) => i.window_start)).toHaveLength(3);
    expect(startWorker.mock.calls[1]?.[0]).toBe('explain');
    expect(startWorker.mock.calls[1]?.[1]).toMatchObject({ date: DATE });
    expect(sent[2]).toMatchObject({
      text: 'Пояснення дня від Денного',
      buttons: [`c:${chainId}:accept`, `c:${chainId}:edit`, `c:${chainId}:calendar`],
      awaiting: 'accept',
    });
    // 4. ✅ → нагадування на кожен блок із часом, ранковий план.
    expect(
      db.prepare(`SELECT count(*) AS n FROM reminders WHERE status = 'pending'`).get(),
    ).toEqual({
      n: 3,
    });
    expect(sent[3]?.text).toContain('Презентація');
    expect(sent[3]?.awaiting).toBeNull();
    // 5. Огляд: нічого не зроблено → питання про перенос → carry_all.
    expect(sent[4]).toMatchObject({
      buttons: [`c:${chainId}:carry_all`, `c:${chainId}:carry_none`],
      awaiting: 'carry',
    });
    expect(sent[4]?.text).toContain('З плану 0/3 ✅ · перенести');
    expect(sent).toHaveLength(5);
    const nextDay = await listItems(env, '2026-09-08');
    expect(nextDay.map((i) => i.carried_from)).toEqual([DATE, DATE, DATE]);
    expect((await listItems(env, DATE)).every((i) => i.status === 'carried')).toBe(true);
    expect(await getDayPlan(env, DATE)).toMatchObject({ status: 'reviewed', workflow_id: chainId });
    expect(
      db.prepare(`SELECT status, json_extract(state_json, '$.awaiting') AS a FROM chains`).get(),
    ).toEqual({
      status: 'done',
      a: null,
    });
  });

  it('без працівника: наївний розбір наміру, чернетка resеrve formatDraft; тиша власника = прийнято і перенесено', async () => {
    const { db, env } = setup();
    const chainId = await startDayPlanChain(env, DATE, NOW);
    const { step } = fakeStep({ intent: [{ payload: { text: 'презентація, банк' } }] });
    const { io, sent, startWorker } = fakeIo(db, chainId, { workerOk: false });

    await runDayPlanChain(env, { chainId, date: DATE }, step, io);

    expect(startWorker.mock.calls.map((c) => c[0])).toEqual(['intent', 'explain']);
    // Без уточнень - одразу чернетка.
    expect(sent[1]?.text.split('\n')[0]).toBe('План на 07.09');
    expect(sent[1]?.text).toContain('• 08:00-08:40 презентація · routine · за порядком');
    expect(sent[1]?.text).toContain('• 10:00 Зустріч (календар)');
    // accept без відповіді - план прийнято за замовчуванням: нагадування є.
    expect(db.prepare(`SELECT count(*) AS n FROM reminders`).get()).toEqual({ n: 2 });
    // carry без відповіді за 2 год - перенесено.
    expect(await listItems(env, '2026-09-08')).toHaveLength(2);
    expect((await getDayPlan(env, DATE))?.status).toBe('reviewed');
  });

  it('✏️ Змінити: питання «що змінити», текст → працівник replan, план прийнято', async () => {
    const { db, env } = setup();
    const chainId = await startDayPlanChain(env, DATE, NOW);
    const noQuestions = {
      payload: { mode: 'intent', output: { items: [{ title: 'Банк', kind: 'errand' }] } },
    };
    const { step } = fakeStep({
      intent: [{ payload: { text: 'банк' } }],
      worker: [
        noQuestions,
        WORKER_EXPLAIN,
        // Працівник replan повертає зміни за назвою; ланцюг застосовує їх ДО
        // прийняття - нагадування стає на новий час.
        { payload: { mode: 'replan', output: { moves: [{ id: 'Банк', to: '16:00' }] } } },
      ],
      accept: [{ payload: { choice: 'edit' } }],
      answer: [{ payload: { text: 'банк на 16:00' } }],
      carry: [{ payload: { choice: 'carry_none' } }],
    });
    const { io, sent, startWorker } = fakeIo(db, chainId);

    await runDayPlanChain(env, { chainId, date: DATE }, step, io);

    expect(sent.map((s) => s.text)).toContain(
      'Напиши, що змінити (наприклад: «презентацію на 16:00», «забери банк»).',
    );
    expect(startWorker.mock.calls.map((c) => c[0])).toEqual(['intent', 'explain', 'replan']);
    expect(startWorker.mock.calls[2]?.[1]).toMatchObject({ text: 'банк на 16:00', date: DATE });
    const bank = (await listItems(env, DATE)).find((i) => i.title === 'Банк');
    expect(bank).toMatchObject({ window_start: '16:00', flexible: 0 });
    const rem = db.prepare(`SELECT due_at FROM reminders`).all() as { due_at: string }[];
    expect(rem).toHaveLength(1);
    expect(Date.parse(rem[0]!.due_at)).toBe(Date.parse('2026-09-07T13:00:00.000Z'));
    // «Ні» на перенос - нічого не переїхало, день reviewed.
    expect(await listItems(env, '2026-09-08')).toHaveLength(0);
    expect((await getDayPlan(env, DATE))?.status).toBe('reviewed');
  });

  it('«Не питай сьогодні» - день skipped, ланцюг done, більше нічого не шле', async () => {
    const { db, env } = setup();
    const chainId = await startDayPlanChain(env, DATE, NOW);
    const { step } = fakeStep({ intent: [{ payload: { choice: 'skip' } }] });
    const { io, sent, startWorker } = fakeIo(db, chainId);
    expect(await runDayPlanChain(env, { chainId, date: DATE }, step, io)).toEqual({
      outcome: 'skipped',
    });
    expect(sent).toHaveLength(1);
    expect(startWorker).not.toHaveBeenCalled();
    expect((await getDayPlan(env, DATE))?.status).toBe('skipped');
    expect(db.prepare(`SELECT status FROM chains`).get()).toEqual({ status: 'done' });
  });

  it('тиша на вечірнє питання: план лише з перенесеного/календаря; без відкритих - «усе закрито», без кнопок', async () => {
    const { db, env } = setup();
    const chainId = await startDayPlanChain(env, DATE, NOW);
    const { step } = fakeStep({});
    const { io, sent, startWorker } = fakeIo(db, chainId);
    await runDayPlanChain(env, { chainId, date: DATE }, step, io);
    expect(startWorker.mock.calls.map((c) => c[0])).toEqual(['explain']);
    expect(sent.at(-1)).toMatchObject({ text: 'З плану 0/0 ✅ - усе закрито.', buttons: [] });
    expect((await getDayPlan(env, DATE))?.status).toBe('reviewed');
  });
});

describe('helpers ланцюга', () => {
  it('startDayPlanChain: рядок chains + Workflow.create(id=chainId); без привʼязки - помилка', async () => {
    const { db, env, wf } = setup();
    const chainId = await startDayPlanChain(env, DATE, NOW);
    expect(wf.created).toEqual([{ id: chainId, params: { chainId, date: DATE } }]);
    expect(db.prepare(`SELECT kind, workflow_id, status FROM chains`).get()).toEqual({
      kind: CHAIN_KIND,
      workflow_id: chainId,
      status: 'running',
    });
    (env as { DAY_PLAN?: unknown }).DAY_PLAN = undefined;
    await expect(startDayPlanChain(env, '2026-09-08', NOW)).rejects.toThrow('DAY_PLAN');
  });

  it('findAwaitingDayPlan бачить лише waiting intent/answer; sendDayPlanEvent іде в інстанс за id', async () => {
    const { env, wf } = setup();
    const chainId = await startDayPlanChain(env, DATE, NOW);
    expect(await findAwaitingDayPlan(env)).toBeNull();
    await setChainState(env, chainId, { status: 'waiting', awaiting: 'intent' });
    expect(await findAwaitingDayPlan(env)).toEqual({ id: chainId, awaiting: 'intent' });
    await setChainState(env, chainId, { status: 'waiting', awaiting: 'accept' });
    expect(await findAwaitingDayPlan(env)).toBeNull();
    await sendDayPlanEvent(env, chainId, 'accept', { choice: 'accept' });
    expect(wf.events).toEqual([
      { id: chainId, ev: { type: 'accept', payload: { choice: 'accept' } } },
    ]);
  });

  it('normalizeIntent: JSON працівника або наївний розбір; parseDurationMin', () => {
    const fromWorker = normalizeIntent(
      { items: [{ title: 'Банк', kind: 'errand', est_min: 45 }] },
      'x',
    );
    expect(fromWorker).toHaveLength(1);
    expect(fromWorker[0]).toMatchObject({ title: 'Банк', kind: 'errand', est_min: 45 });
    // id від працівника не приймається: ядро видає свій (INSERT OR REPLACE за id).
    const spoofed = normalizeIntent({ items: [{ id: 'keep', title: 'Чужий рядок' }] }, '');
    expect(spoofed[0]?.id).not.toBe('keep');
    const naive = normalizeIntent(null, 'презентація; банк і пошта\nдзвінок');
    expect(naive.map((i) => i.title)).toEqual(['презентація', 'банк', 'пошта', 'дзвінок']);
    expect(naive.every((i) => i.kind === 'routine' && i.est_min === null)).toBe(true);
    expect(parseDurationMin('1 год')).toBe(60);
    expect(parseDurationMin('1,5 год')).toBe(90);
    expect(parseDurationMin('30 хв')).toBe(30);
    expect(parseDurationMin('не знаю')).toBeNull();
  });

  it('applyAnswer: кнопка {item, option} або текст {text} для питання, що чекає (qiDefault)', () => {
    const questions = [{ q: 'Скільки?', item: 1, options: ['30 хв', '1 год'] }];
    const mk = () =>
      normalizeIntent({ items: [{ title: 'A' }, { title: 'Банк', kind: 'errand' }] }, '');
    expect(applyAnswer(mk(), questions, { item: 0, option: 1 })[1]?.est_min).toBe(60);
    // Текст із prerouter не несе item - пункт береться з поточного питання.
    expect(applyAnswer(mk(), questions, { text: '2 год' }, 0)[1]?.est_min).toBe(120);
    const dunno = applyAnswer(mk(), questions, { text: 'не знаю' }, 0)[1];
    expect(dunno).toMatchObject({ est_min: null, flexible: true });
    expect(applyAnswer(mk(), questions, null, 0)[1]?.est_min).toBeNull();
  });

  it('replanChanges: лише done/moves/drop з відомою формою, ≤ 3 зміни', () => {
    expect(
      replanChanges({
        done: ['a', 7],
        moves: [{ id: 'b', to: '16:00' }, { id: 'x' }, 'junk'],
        drop: ['c', 'd', 'e'],
        extra: 'ignored',
      }),
    ).toEqual({ done: ['a'], moves: [{ id: 'b', to: '16:00' }], drop: ['c'] });
    expect(REPLAN_MAX_CHANGES).toBe(3);
    expect(replanChanges({})).toEqual({ done: [], moves: [], drop: [] });
  });

  it('startDayPlannerRun: інструкція day-planner з D1 → /run профілю day-planner із JSON-задачею; без інструкції - false і без мережі', async () => {
    const { db, env } = setup();
    const begins: Record<string, unknown>[] = [];
    (env as { RUN_REGISTRY?: unknown }).RUN_REGISTRY = {
      getByName: () => ({
        begin: async (r: Record<string, unknown>) => void begins.push(r),
        finish: async () => null,
      }),
    };
    (env as { BRAIN_URL?: string }).BRAIN_URL = 'https://brain.example';
    (env as { ASSISTANT_V2?: string }).ASSISTANT_V2 = 'on';
    (env as { INTERNAL_HMAC_KEY?: string }).INTERNAL_HMAC_KEY = 'k';
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
        return new Response(JSON.stringify({ ok: true }), { status: 202 });
      }),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(
      await startDayPlannerRun(
        env,
        { chainId: 'ch1', date: DATE, mode: 'intent', task: { text: 'банк' } },
        NOW,
      ),
    ).toBe(false);
    expect(calls).toHaveLength(0);

    const body = '# Денний\nРозбери намір.';
    db.prepare(
      `INSERT INTO instructions (name, kind, version_hash, body_md, max_chars, deployed_at) VALUES ('day-planner', 'agent', ?, ?, 7500, '2026-09-01T00:00:00Z')`,
    ).run(syncInstructionHash(body), body);
    expect(
      await startDayPlannerRun(
        env,
        { chainId: 'ch1', date: DATE, mode: 'intent', task: { text: 'банк' } },
        NOW,
      ),
    ).toBe(true);
    expect(calls[0]?.url).toBe('https://brain.example/run');
    expect(calls[0]?.body).toMatchObject({ profile: 'day-planner', thread_id: '99' });
    expect((calls[0]?.body.instruction as { name: string }).name).toBe('day-planner');
    expect(JSON.parse(String((calls[0]?.body.input as { text: string }).text))).toEqual({
      chain_id: 'ch1',
      mode: 'intent',
      date: DATE,
      task: { text: 'банк' },
      format: 'json',
    });
    expect(begins[0]).toMatchObject({
      profile: 'day-planner',
      trigger: 'workflow',
      threadId: '99',
    });

    await startDayPlannerRun(env, { chainId: 'ch1', date: DATE, mode: 'explain', task: {} }, NOW);
    expect(JSON.parse(String((calls[1]?.body.input as { text: string }).text)).format).toBe('chat');
  });
});
