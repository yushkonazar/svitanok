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
import { findAwaitingChain, sendChainEvent } from '../web/core/chains/registry.mjs';
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
  '0012_reminders_recurrence.sql',
  '0020_plan_item_time_constraints.sql',
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
  // План після схвалення записується в календар; тести ніколи не звертаються
  // до реального Google навіть за наявності тестового OAuth-токена.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ id: 'ev-test' }), { status: 200 })),
  );
  const d1 = d1FromSqlite(MIGRATIONS);
  const wf = fakeWorkflow();
  const env = workerEnv({
    DB: d1.stub,
    // Свіжий токен (Date.now(), не NOW): блоки в календар тепер створюються
    // одразу, і без нього тест міряв би лише відмову OAuth.
    BRIEFING: memoryKv(
      new Map([['googleToken', JSON.stringify({ token: 'tok', expMs: Date.now() + 3_600_000 })]]),
    ),
    GOOGLE_CLIENT_ID: 'c',
    GOOGLE_CLIENT_SECRET: 's',
    GOOGLE_REFRESH_TOKEN: 'r',
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
describe('runDayPlanChain', () => {
  it('повний шлях: питання → намір → уточнення → чернетка → ✅ з календарем → ранок → огляд', async () => {
    const { db, env } = setup();
    const chainId = await startDayPlanChain(env, DATE, NOW);
    const { step, log } = fakeStep({
      intent: [{ payload: { text: 'презентація 2 год, банк, зателефонувати Олені' } }],
      worker: [WORKER_INTENT],
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
      text: 'Що завтра (07.09)? Назви всі справи, роботу й відомі часи текстом або голосом. «Нічого особливого» — теж відповідь.',
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
    //    названі 60 хв не множаться на запас; чернетку формує ядро.
    const items = await listItems(env, DATE);
    const bank = items.find((i) => i.title === 'Банк');
    expect(bank).toMatchObject({ est_min: 60, kind: 'errand' });
    expect((hhmmToMin(bank?.window_end) ?? 0) - (hhmmToMin(bank?.window_start) ?? 0)).toBe(60);
    expect(items.filter((i) => i.window_start)).toHaveLength(3);
    expect(sent[2]).toMatchObject({
      buttons: [`c:${chainId}:accept`, `c:${chainId}:edit`, `c:${chainId}:later`],
      awaiting: 'accept',
    });
    expect(sent[2]?.text).toContain('План на 07.09');
    // 4. ✅ → блоки в календар, але без навʼязаних нагадувань.
    expect(
      db.prepare(`SELECT count(*) AS n FROM reminders WHERE status = 'pending'`).get(),
    ).toEqual({
      n: 0,
    });
    expect(sent[3]?.text).toContain('План погоджено. У календарі: 3 блоків');
    expect(sent[4]?.text).toContain('Презентація');
    // 5. Огляд: нічого не зроблено → питання про перенос → carry_all.
    expect(sent[5]).toMatchObject({
      buttons: [`c:${chainId}:carry_all`, `c:${chainId}:carry_none`],
      awaiting: 'carry',
    });
    expect(sent[5]?.text).toContain('З плану 0/3 ✅ · перенести');
    expect(sent).toHaveLength(6);
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

  it('без працівника: резервний розбір, тиша залишає чернетку без запису', async () => {
    const { db, env } = setup();
    const chainId = await startDayPlanChain(env, DATE, NOW);
    const { step } = fakeStep({ intent: [{ payload: { text: 'презентація, банк' } }] });
    const { io, sent, startWorker } = fakeIo(db, chainId, { workerOk: false });

    expect(await runDayPlanChain(env, { chainId, date: DATE }, step, io)).toMatchObject({
      outcome: 'draft-left-for-later',
    });

    expect(startWorker.mock.calls.map((c) => c[0])).toEqual(['intent']);
    // Без уточнень - одразу чернетка.
    expect(sent[1]?.text.split('\n')[0]).toBe('План на 07.09');
    expect(sent[1]?.text).toContain('• 08:00-08:40 презентація · за порядком');
    expect(sent[1]?.text).toContain('• 10:00 Зустріч (календар)');
    expect(db.prepare(`SELECT count(*) AS n FROM reminders`).get()).toEqual({ n: 0 });
    expect(await listItems(env, '2026-09-08')).toHaveLength(0);
    expect((await getDayPlan(env, DATE))?.status).toBe('draft');
  });

  it('відкладений план відкривається повторно без нового опитування й записується лише після ✅', async () => {
    const { db, env } = setup();
    const firstId = await startDayPlanChain(env, DATE, NOW, {
      oneShot: true,
      initialIntent: 'пошта',
    });
    await expect(startDayPlanChain(env, DATE, NOW, { oneShot: true })).rejects.toThrow(
      'уже відкритий',
    );
    const firstStep = fakeStep({});
    const firstIo = fakeIo(db, firstId, { workerOk: false });
    expect(
      await runDayPlanChain(
        env,
        { chainId: firstId, date: DATE, oneShot: true, initialIntent: 'пошта' },
        firstStep.step,
        firstIo.io,
      ),
    ).toMatchObject({ outcome: 'draft-left-for-later' });
    const resumedId = await startDayPlanChain(env, DATE, NOW, { oneShot: true, resumeDraft: true });
    const resumedStep = fakeStep({ accept: [{ payload: { choice: 'accept' } }] });
    const resumedIo = fakeIo(db, resumedId);
    expect(
      await runDayPlanChain(
        env,
        { chainId: resumedId, date: DATE, oneShot: true, resumeDraft: true },
        resumedStep.step,
        resumedIo.io,
      ),
    ).toMatchObject({ outcome: 'accepted' });
    expect(resumedIo.startWorker).not.toHaveBeenCalled();
    expect(resumedIo.sent[0]?.text).toContain('пошта');
    expect((await getDayPlan(env, DATE))?.status).toBe('accepted');
    expect(db.prepare('SELECT count(*) AS n FROM reminders').get()).toEqual({ n: 0 });
    await expect(
      startDayPlanChain(env, DATE, NOW, { oneShot: true, initialIntent: 'новий план' }),
    ).rejects.toThrow('Не створюю дубль');
  });

  it('схвалює роботу без розриву, сніданок поверх неї та дві вечірні справи; Google не надсилає нагадування', async () => {
    const { db, env } = setup();
    const chainId = await startDayPlanChain(env, DATE, NOW, {
      oneShot: true,
      initialIntent: 'робота 7–19, сніданок під час роботи, курс і книжка ввечері',
    });
    const { step } = fakeStep({
      worker: [
        {
          payload: {
            output: {
              items: [
                { title: 'Робота', hard_at: '07:00', hard_end: '19:00' },
                { title: 'Сніданок', est_min: 25, floating: true, parallel_with: 0 },
                { title: 'Курс', kind: 'deep', est_min: 45, after: 0 },
                { title: 'Книжка', est_min: 30, after: 2 },
              ],
            },
          },
        },
      ],
      accept: [{ payload: { choice: 'accept' } }],
    });
    const { io, sent } = fakeIo(db, chainId, { readCalendar: async () => [] });
    expect(
      await runDayPlanChain(
        env,
        {
          chainId,
          date: DATE,
          oneShot: true,
          initialIntent: 'робота 7–19, сніданок під час роботи, курс і книжка ввечері',
        },
        step,
        io,
      ),
    ).toMatchObject({ outcome: 'accepted', items: 4 });
    const rows = await listItems(env, DATE);
    expect(rows.find((r) => r.title === 'Робота')).toMatchObject({
      window_start: '07:00',
      window_end: '19:00',
    });
    expect(rows.find((r) => r.title === 'Сніданок')).toMatchObject({
      floating: 1,
      window_start: '08:00',
      window_end: '11:00',
    });
    expect(sent[0]?.text).toContain('≈08:00-11:00 Сніданок');
    const requests = vi
      .mocked(fetch)
      .mock.calls.map(
        ([, init]) => JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      );
    expect(requests).toHaveLength(4);
    const meal = requests.find((body) => String(body.summary).startsWith('Сніданок · ≈25 хв'));
    expect(meal).toMatchObject({ transparency: 'transparent', reminders: { useDefault: false } });
    expect(db.prepare('SELECT count(*) AS n FROM reminders').get()).toEqual({ n: 0 });
  });

  it('«проєкт або курс» питає вибір і не записує відхилений варіант', async () => {
    const { db, env } = setup();
    const chainId = await startDayPlanChain(env, DATE, NOW, {
      oneShot: true,
      initialIntent: 'проєкт або курс',
    });
    const { step } = fakeStep({
      worker: [
        {
          payload: {
            output: {
              items: [
                { title: 'Проєкт', kind: 'deep', est_min: 45 },
                { title: 'Курс', kind: 'deep', est_min: 45 },
              ],
              questions: [
                {
                  field: 'choice',
                  item: 0,
                  q: 'Що обрати?',
                  choices: [
                    { label: 'Проєкт', items: [0] },
                    { label: 'Курс', items: [1] },
                    { label: 'Обидва', items: [0, 1] },
                  ],
                },
              ],
            },
          },
        },
      ],
      answer: [{ payload: { item: 0, option: 1 } }],
      accept: [{ payload: { choice: 'accept' } }],
    });
    const { io, sent } = fakeIo(db, chainId, { readCalendar: async () => [] });
    expect(
      await runDayPlanChain(
        env,
        { chainId, date: DATE, oneShot: true, initialIntent: 'проєкт або курс' },
        step,
        io,
      ),
    ).toMatchObject({ items: 1, outcome: 'accepted' });
    expect(sent[0]?.buttons).toHaveLength(3);
    expect((await listItems(env, DATE)).map((r) => r.title)).toEqual(['Курс']);
  });

  it('✏️ Змінити: нова чернетка й друге явне підтвердження', async () => {
    const { db, env } = setup();
    const chainId = await startDayPlanChain(env, DATE, NOW);
    const noQuestions = {
      payload: { mode: 'intent', output: { items: [{ title: 'Банк', kind: 'errand' }] } },
    };
    const { step } = fakeStep({
      intent: [{ payload: { text: 'банк' } }],
      worker: [
        noQuestions,
        // Працівник replan повертає зміни за назвою; ланцюг застосовує їх ДО
        // прийняття - нагадування стає на новий час.
        { payload: { mode: 'replan', output: { moves: [{ id: 'Банк', to: '16:00' }] } } },
      ],
      accept: [{ payload: { choice: 'edit' } }, { payload: { choice: 'accept' } }],
      answer: [{ payload: { text: 'не знаю' } }, { payload: { text: 'банк на 16:00' } }],
      carry: [{ payload: { choice: 'carry_none' } }],
    });
    const { io, sent, startWorker } = fakeIo(db, chainId);

    await runDayPlanChain(env, { chainId, date: DATE }, step, io);

    expect(sent.map((s) => s.text)).toContain(
      'Що змінити? Можеш пересунути, додати або прибрати кілька справ одним повідомленням.',
    );
    expect(startWorker.mock.calls.map((c) => c[0])).toEqual(['intent', 'replan']);
    expect(startWorker.mock.calls[1]?.[1]).toMatchObject({ text: 'банк на 16:00', date: DATE });
    const bank = (await listItems(env, DATE)).find((i) => i.title === 'Банк');
    expect(bank).toMatchObject({ window_start: '16:00', flexible: 0 });
    expect(sent.filter((s) => s.text.startsWith('План на 07.09'))).toHaveLength(2);
    expect(db.prepare(`SELECT count(*) AS n FROM reminders`).get()).toEqual({ n: 0 });
    // «Ні» на перенос - нічого не переїхало, день reviewed.
    expect(await listItems(env, '2026-09-08')).toHaveLength(0);
    expect((await getDayPlan(env, DATE))?.status).toBe('reviewed');
  });

  // Приймання 05.09, B2: «🗓 У календар» створює пропозиції T1 - і ланцюг сам
  // шле кожну з кнопками ✅/❌, інакше вони лежать open без сліду в чаті.
  it('«🗓 У календар»: план прийнято, кожен блок іде в календар із «↩» у треді', async () => {
    const { db, env } = setup();
    const chainId = await startDayPlanChain(env, DATE, NOW);
    const noQuestions = {
      payload: {
        mode: 'intent',
        output: { items: [{ title: 'Банк', kind: 'errand', est_min: 60 }] },
      },
    };
    const { step } = fakeStep({
      intent: [{ payload: { text: 'банк' } }],
      worker: [noQuestions],
      accept: [{ payload: { choice: 'calendar' } }],
      carry: [{ payload: { choice: 'carry_none' } }],
    });
    const { io, sent } = fakeIo(db, chainId);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ id: 'ev-1' }), { status: 200 })),
    );
    await runDayPlanChain(env, { chainId, date: DATE }, step, io);
    const cal = sent.find((s) => s.text.startsWith('🗓 План погоджено.'));
    expect(cal?.text).toContain('У календарі: 1 блоків');
    expect(
      db
        .prepare(`SELECT kind, level, status FROM proposals WHERE kind = 'undo:calendar.event'`)
        .all(),
    ).toEqual([{ kind: 'undo:calendar.event', level: 'T0', status: 'open' }]);
    expect((await getDayPlan(env, DATE))?.status).toBe('reviewed');
    vi.unstubAllGlobals();
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

  it('тиша на вечірнє питання: без небажаного порожнього плану, ланцюг чесно закрито', async () => {
    const { db, env } = setup();
    const chainId = await startDayPlanChain(env, DATE, NOW);
    const { step } = fakeStep({});
    const { io, sent, startWorker } = fakeIo(db, chainId);
    expect(await runDayPlanChain(env, { chainId, date: DATE }, step, io)).toEqual({
      outcome: 'no-input',
    });
    expect(startWorker).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect((await getDayPlan(env, DATE))?.status).toBe('skipped');
    expect(db.prepare(`SELECT status FROM chains WHERE id = ?`).get(chainId)).toEqual({
      status: 'done',
    });
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

  it('може стартувати одноразовий план одразу в приватному чаті', async () => {
    const { env, wf } = setup();
    const chainId = await startDayPlanChain(env, DATE, NOW, {
      oneShot: true,
      initialIntent: 'робота до 17:00, потім навчання',
      target: { chatId: 806352792, threadId: 'dm' },
    });
    expect(wf.created).toEqual([
      {
        id: chainId,
        params: {
          chainId,
          date: DATE,
          oneShot: true,
          initialIntent: 'робота до 17:00, потім навчання',
        },
      },
    ]);
    const row = (await env
      .DB!.prepare('SELECT state_json FROM chains WHERE id = ?')
      .bind(chainId)
      .first()) as {
      state_json: string;
    };
    expect(JSON.parse(row.state_json)).toMatchObject({
      chat_id: 806352792,
      thread_id: 'dm',
      one_shot: true,
    });
  });

  it('ядро саме уточнює невідому тривалість навчання й не ставить вигаданий вечірній блок', async () => {
    const { env, db } = setup();
    const chainId = await startDayPlanChain(env, DATE, NOW, {
      oneShot: true,
      initialIntent: 'робота до 17:00, потім навчання',
      target: { chatId: 806352792, threadId: 'dm' },
    });
    const { step } = fakeStep({
      worker: [
        {
          payload: {
            output: {
              items: [
                { title: 'Робота', kind: 'routine', hard_end: '17:00' },
                { title: 'Навчання', kind: 'deep', not_before: '17:00', after: 0 },
              ],
              questions: [],
            },
          },
        },
      ],
      answer: [{ payload: { text: 'не знаю' } }],
    });
    const { io, sent } = fakeIo(db, chainId);
    await runDayPlanChain(
      env,
      {
        chainId,
        date: DATE,
        oneShot: true,
        initialIntent: 'робота до 17:00, потім навчання',
      },
      step,
      io,
    );

    expect(sent[0]).toMatchObject({
      text: 'Скільки часу закласти на «Навчання»?',
      buttons: [`c:${chainId}:a0_0`, `c:${chainId}:a0_1`, `c:${chainId}:a0_2`, `c:${chainId}:a0_3`],
      awaiting: 'answer',
    });
    const study = (await listItems(env, DATE)).find((item) => item.title === 'Навчання');
    expect(study).toMatchObject({ est_min: null, flexible: 1 });
    expect(study?.window_start).toBeNull();
  });

  it('реєстр ланцюгів бачить план лише в waiting intent/answer; подія іде в інстанс DAY_PLAN за id', async () => {
    const { env, wf } = setup();
    const chainId = await startDayPlanChain(env, DATE, NOW);
    expect(await findAwaitingChain(env)).toBeNull();
    await setChainState(env, chainId, { status: 'waiting', awaiting: 'intent' });
    expect(await findAwaitingChain(env)).toEqual({
      id: chainId,
      kind: 'day-plan',
      awaiting: 'intent',
    });
    await setChainState(env, chainId, { status: 'waiting', awaiting: 'accept' });
    expect(await findAwaitingChain(env)).toBeNull();
    await sendChainEvent(env, chainId, 'accept', { choice: 'accept' });
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
    expect(applyAnswer(mk(), questions, null, 0)[1]).toMatchObject({
      est_min: null,
      flexible: true,
    });
  });

  it('replanChanges: done/moves/drop/add з відомою формою, ≤ 20 змін', () => {
    expect(
      replanChanges({
        done: ['a', 7],
        moves: [{ id: 'b', to: '16:00' }, { id: 'x' }, 'junk'],
        drop: ['c', 'd', 'e'],
        extra: 'ignored',
      }),
    ).toEqual({ done: ['a'], moves: [{ id: 'b', to: '16:00' }], drop: ['c', 'd', 'e'], add: [] });
    expect(REPLAN_MAX_CHANGES).toBe(20);
    expect(replanChanges({})).toEqual({ done: [], moves: [], drop: [], add: [] });
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
