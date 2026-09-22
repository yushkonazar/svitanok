// Профіль weekly-review (етап 3 PR-3, S-9-1…5): профіль мозку і парність із
// front-matter інструкції, вхід прогону за §0 (період, перша неділя,
// попередній звіт, хеш), задача планувальника (неділя 09:00, повтор 12:00 при
// збої, алерт), «звіт зараз» у prerouter, deliver → reports у D1.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROFILES, INSTRUCTION_NAME_BY_PROFILE, buildSystemPrompt } from '../brain/src/profiles.js';
import { RUN_REQUEST_SCHEMA } from '../brain/src/server.js';
import { makeRunner, type EngineOutcome, type EngineRunOptions } from '../brain/src/agent.js';
import { instructionHash } from '../brain/src/instructions.js';
import { TOOL_BY_CORE_NAME } from '../brain/src/tools/schemas.js';
import { parseInstruction } from '../web/core/instructions.mjs';
import {
  WEEKLY_NOW_RE,
  buildWeeklyReviewInput,
  saveWeeklyReport,
  readRunProfile,
} from '../web/core/brain/weekly-review.mjs';
import {
  weeklyReviewTask,
  WEEKLY_REVIEW_STATE_KEY,
} from '../web/core/brain/weekly-review-task.mjs';
import { startOrQueueThreadText } from '../web/core/prerouter.mjs';
import { handleInternal } from '../web/core/internal/router.mjs';
import { signInternal } from '../web/core/internal/auth.mjs';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';
import { d1FromSqlite } from './helpers/d1.js';

vi.mock('../web/core/prerouter.mjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/core/prerouter.mjs')>();
  return { ...actual, startOrQueueThreadText: vi.fn(async () => 'run-w1') };
});

const ALL_MIGRATIONS = [
  '0001_base.sql',
  '0002_assistant.sql',
  '0003_telemetry.sql',
  '0004_ideas_travel.sql',
  '0005_finance.sql',
  '0006_inbox_collections.sql',
  '0007_instructions_plans.sql',
  '0008_fts.sql',
  '0009_voice.sql',
  '0010_reminders_address.sql',
];

// Неділя 06.09.2026: 09:10 Києва = 06:10Z (літній час, UTC+3).
const SUNDAY_0910 = Date.parse('2026-09-06T06:10:00.000Z');
const SUNDAY_1210 = Date.parse('2026-09-06T09:10:00.000Z');
const SUNDAY_1310 = Date.parse('2026-09-06T10:10:00.000Z');
const WEDNESDAY = Date.parse('2026-09-02T09:00:00.000Z');

const WEEKLY_FILE = readFileSync(
  join(__dirname, '..', 'docs', 'assistant', 'weekly-review.md'),
  'utf8',
);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('профіль weekly-review у мозку', () => {
  it('Sonnet, 6 інструментів, 6 хв, інструменти = front-matter файлу ∩ описані в мозку', () => {
    const p = PROFILES['weekly-review'];
    expect(p.model).toBe('claude-sonnet-5');
    expect(p.maxToolCalls).toBe(6);
    expect(p.timeoutMs).toBe(6 * 60_000);
    const parsed = parseInstruction(WEEKLY_FILE);
    if (!parsed.ok) throw new Error(parsed.error);
    const fromFile = (parsed.front.tools as string[]).map((t) => t.replaceAll('.', '_'));
    const described = fromFile.filter((n) => TOOL_BY_CORE_NAME.has(n.replaceAll('_', '.')));
    expect(p.toolNames).toEqual(described);
    // Усі три з front-matter описані з етапу 6: блок «Гроші» тижневого звіту
    // читає finance.query напряму, а не переказує Фінансиста.
    expect(p.toolNames).toEqual(['data_read', 'finance_query', 'runs_query']);
  });

  it('контракт /run приймає profile=weekly-review; інструкція - weekly-review; промпт із датою, без згортки', () => {
    expect(RUN_REQUEST_SCHEMA.shape.profile.options).toContain('weekly-review');
    expect(INSTRUCTION_NAME_BY_PROFILE['weekly-review']).toBe('weekly-review');
    const prompt = buildSystemPrompt(PROFILES['weekly-review'], SUNDAY_0910, {
      instruction: '# Тижневий звіт',
      summary: 'згортка, якої тут не має бути',
    });
    expect(prompt).toContain('# Тижневий звіт');
    expect(prompt).toContain('Зараз у Києві');
    expect(prompt).not.toContain('згортка');
  });

  it('прогін: інструкція weekly-review проходить, чужа (persona) - відмова без запуску рушія', async () => {
    const body = '# Тижневий звіт\nПиши звіт.';
    const deliver = vi.fn(async () => undefined);
    const engineRun = vi.fn(
      async (_opts: EngineRunOptions, _input: string): Promise<EngineOutcome> => ({
        finalText: '📊 Тиждень 31.08 - 06.09\n\nГРОШІ\n• нема\n\n· weekly-review@abc',
        sessionId: 'sess-w',
      }),
    );
    const client = {
      callTool: vi.fn(async () => ({ ok: true as const, tool: 't', tainted: false, result: '{}' })),
      deliver,
      status: vi.fn(async () => undefined),
      reportRuns: vi.fn(async () => undefined),
      session: vi.fn(async () => true),
      instruction: vi.fn(async () => ({
        ok: false as const,
        status: 404,
        error: 'instruction-missing',
      })),
      taint: vi.fn(async () => true),
    };
    const run = makeRunner({
      client,
      engine: { run: engineRun, readTranscript: async () => null },
    });
    await run({
      run_id: 'run-w',
      profile: 'weekly-review',
      thread_id: '6',
      input: { text: 'period_from: 2026-08-31' },
      instruction: { name: 'weekly-review', version_hash: instructionHash(body), body_md: body },
    });
    expect(engineRun).toHaveBeenCalledTimes(1);
    const opts = engineRun.mock.calls[0]?.[0];
    expect(opts?.resumeSessionId).toBeNull();
    expect(opts?.toolNames).toEqual(PROFILES['weekly-review'].toolNames);
    expect(deliver).toHaveBeenCalledWith('run-w', expect.stringContaining('📊 Тиждень'));
    // Сесія НЕ оновлюється: звіт не продовжує розмову власника.
    expect(client.session).not.toHaveBeenCalled();

    await run({
      run_id: 'run-x',
      profile: 'weekly-review',
      thread_id: '6',
      input: { text: 'x' },
      instruction: { name: 'persona', version_hash: instructionHash(body), body_md: body },
    });
    expect(engineRun).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenLastCalledWith('run-x', expect.stringContaining('не на місці'));
  });
});

describe('вхід прогону (§0) і reports', () => {
  function withDb() {
    const d1 = d1FromSqlite(ALL_MIGRATIONS);
    return { d1, env: workerEnv({ DB: d1.stub, BRIEFING: memoryKv(new Map()) }) };
  }

  it('«звіт зараз» - лише точна фраза', () => {
    expect(WEEKLY_NOW_RE.test('звіт зараз')).toBe(true);
    expect(WEEKLY_NOW_RE.test('Звіт  зараз!')).toBe(true);
    expect(WEEKLY_NOW_RE.test('зроби звіт зараз')).toBe(false);
    expect(WEEKLY_NOW_RE.test('звіт')).toBe(false);
  });

  it('період пн-нд за Києвом, перша неділя місяця, попередній звіт; хеша у вході НЕМА', async () => {
    const { d1, env } = withDb();
    const first = await buildWeeklyReviewInput(env, SUNDAY_0910);
    expect(first).toMatchObject({
      periodFrom: '2026-08-31',
      periodTo: '2026-09-06',
      firstSunday: true,
    });
    expect(first.text).toContain('first_sunday_of_month: true');
    // ⚠️ Хеша у вході бути НЕ має: модель ставила його в підпис звіту, і
    // власник бачив у чаті «weekly-review@849bfbb…» (прогін 08.09). У D1 його
    // пише ядро саме - див. saveWeeklyReport нижче.
    expect(first.text).not.toContain('instruction_hash');

    expect(first.text).toContain('Попереднього тижневого звіту немає');

    d1.db
      .prepare(
        `INSERT INTO reports (id, kind, period_from, period_to, text_md, instruction_hash, created_at)
         VALUES ('rep-1', 'weekly', '2026-08-24', '2026-08-30', 'минулий звіт про сон', 'h', '2026-08-30T06:00:00Z')`,
      )
      .run();
    const second = await buildWeeklyReviewInput(env, WEDNESDAY);
    expect(second).toMatchObject({
      periodFrom: '2026-08-31',
      periodTo: '2026-09-06',
      firstSunday: false,
    });
    expect(second.text).toContain('2026-08-24 - 2026-08-30');
    expect(second.text).toContain('минулий звіт про сон');

    // Звіт ПОТОЧНОГО тижня (недільний) - не «попередній» для «звіт зараз» у
    // середу: порівняння «до минулого тижня» інакше рахувалось би від себе.
    d1.db
      .prepare(
        `INSERT INTO reports (id, kind, period_from, period_to, text_md, instruction_hash, created_at)
         VALUES ('rep-2', 'weekly', '2026-08-31', '2026-09-06', 'цьоготижневий', 'h', '2026-09-06T06:00:00Z')`,
      )
      .run();
    const third = await buildWeeklyReviewInput(env, WEDNESDAY);
    expect(third.text).toContain('минулий звіт про сон');
    expect(third.text).not.toContain('цьоготижневий');
  });

  it('saveWeeklyReport: рядок kind=weekly з періодом і хешем інструкції з D1; readRunProfile читає runs', async () => {
    const { d1, env } = withDb();
    const body = '# Тижневий звіт';
    d1.db
      .prepare(
        `INSERT INTO instructions (name, kind, version_hash, body_md, max_chars, deployed_at)
         VALUES ('weekly-review', 'profile', 'stale', ?, 12000, '2026-09-01T00:00:00Z')`,
      )
      .run(body);
    const saved = await saveWeeklyReport(env, 'текст звіту', SUNDAY_0910);
    expect(saved).toMatchObject({ periodFrom: '2026-08-31', periodTo: '2026-09-06' });
    expect(saved.instructionHash).toBe(instructionHash(body));
    const row = d1.db.prepare('SELECT kind, text_md, instruction_hash FROM reports').get() as {
      kind: string;
      text_md: string;
      instruction_hash: string;
    };
    expect(row).toEqual({
      kind: 'weekly',
      text_md: 'текст звіту',
      instruction_hash: saved.instructionHash,
    });

    d1.db
      .prepare(
        `INSERT INTO runs (id, trigger, profile, started_at) VALUES ('r-w', 'chat', 'weekly-review', '2026-09-06T06:10:00Z')`,
      )
      .run();
    expect(await readRunProfile(env, 'r-w')).toBe('weekly-review');
    expect(await readRunProfile(env, 'nope')).toBeNull();
  });

  it('deliver прогону weekly-review кладе текст у reports; звичайного chat - ні', async () => {
    const { d1, env: base } = withDb();
    d1.db
      .prepare(
        `INSERT INTO runs (id, trigger, profile, started_at) VALUES ('r-w', 'chat', 'weekly-review', '2026-09-06T06:10:00Z')`,
      )
      .run();
    d1.db
      .prepare(
        `INSERT INTO runs (id, trigger, profile, started_at) VALUES ('r-c', 'chat', 'chat', '2026-09-06T06:10:00Z')`,
      )
      .run();
    /** @type {Record<string, unknown>[]} */
    const sends: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).endsWith('/sendMessage') && init?.body) {
          sends.push(JSON.parse(String(init.body)));
        }
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
          status: 200,
        });
      }),
    );
    const env = workerEnv({
      ...base,
      ASSISTANT_V2: 'on',
      INTERNAL_HMAC_KEY: 'k',
      TELEGRAM_CHAT_ID: '100',
      TELEGRAM_BOT_TOKEN: 'tok',
      TOPIC_ASSISTANT: '6',
      RUN_REGISTRY: {
        getByName: () => ({
          has: async () => true,
          consumeNonce: async () => true,
          runInfo: async (id: string) => ({
            threadId: '6',
            chatId: 100,
            statusMessageId: null,
            id,
          }),
        }),
      },
    });
    const post = async (runId: string, text: string, nonce: string) => {
      const rawBody = JSON.stringify({ text });
      const signature = await signInternal('k', {
        method: 'POST',
        path: '/internal/deliver',
        timestampMs: SUNDAY_0910,
        runId,
        nonce,
        rawBody,
      });
      return handleInternal(
        new Request('https://svitanok.test/internal/deliver', {
          method: 'POST',
          headers: {
            'X-Internal-Timestamp': String(SUNDAY_0910),
            'X-Internal-Run': runId,
            'X-Internal-Nonce': nonce,
            'X-Internal-Signature': signature,
          },
          body: rawBody,
        }),
        env,
        SUNDAY_0910,
      );
    };
    const w = await post('r-w', '📊 Тиждень 31.08 - 06.09', 'n1');
    expect(w.status).toBe(200);
    expect(await w.json()).toMatchObject({ ok: true, report_id: expect.any(String) });
    const c = await post('r-c', 'звичайна відповідь', 'n2');
    expect(await c.json()).not.toHaveProperty('report_id');
    const rows = d1.db.prepare('SELECT text_md FROM reports').all() as { text_md: string }[];
    expect(rows.map((r) => r.text_md)).toEqual(['📊 Тиждень 31.08 - 06.09']);
    // ⚠️ Під звітом - кнопки «що з цим робити» (PR-6 §2.5): блок «ЩО ЗРОБИТИ»
    // без жодної кнопки лишав би дії на памʼять власника. Під звичайною
    // відповіддю їх бути не має.
    const weekly = sends.find((b) => String(b.text ?? '').includes('Тиждень'))!;
    expect(JSON.stringify(weekly.reply_markup)).toContain('m:wr:carry');
    const plain = sends.find((b) => String(b.text ?? '').includes('звичайна відповідь'))!;
    expect(JSON.stringify(plain.reply_markup ?? null)).not.toContain('m:wr:');
  });
});

describe('задача weekly-review (нд 09:00, повтор 12:00, алерт)', () => {
  const start = vi.mocked(startOrQueueThreadText);

  function taskEnv(
    runRows: { id: string; error: string | null; finished: boolean }[] = [],
    reportToday = false,
  ) {
    const d1 = d1FromSqlite([
      '0003_telemetry.sql',
      '0002_assistant.sql',
      '0007_instructions_plans.sql',
    ]);
    if (reportToday) {
      d1.db
        .prepare(
          `INSERT INTO reports (id, kind, period_from, period_to, text_md, instruction_hash, created_at)
           VALUES ('rep-today', 'weekly', '2026-08-31', '2026-09-06', 'звіт', 'h', '2026-09-06T06:20:00Z')`,
        )
        .run();
    }
    for (const r of runRows) {
      d1.db
        .prepare(
          `INSERT INTO runs (id, trigger, profile, started_at, finished_at, error) VALUES (?, 'chat', 'weekly-review', '2026-09-06T06:10:00Z', ?, ?)`,
        )
        .run(r.id, r.finished ? '2026-09-06T06:12:00Z' : null, r.error);
    }
    const kv = new Map<string, string>();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 }),
      ),
    );
    return {
      kv,
      d1,
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

  it('не неділя або до 09:00 - пропуск без старту', async () => {
    const { env } = taskEnv();
    expect(await weeklyReviewTask(env, WEDNESDAY)).toEqual({ skipped: 'not-sunday' });
    expect(await weeklyReviewTask(env, SUNDAY_0910 - 2 * 3_600_000)).toEqual({ skipped: 'hour' });
    expect(start).not.toHaveBeenCalled();
  });

  it('09:10 - старт «звіт зараз» у тему з маршрутом weekly-review; друга поява того ж дня - без старту', async () => {
    const { env, kv } = taskEnv();
    expect(await weeklyReviewTask(env, SUNDAY_0910)).toEqual({ started: true, queued: false });
    expect(start).toHaveBeenCalledWith(
      env,
      { chatId: 100, threadId: 6 },
      '6',
      'звіт зараз',
      'weekly-review',
      SUNDAY_0910,
    );
    expect(JSON.parse(kv.get(WEEKLY_REVIEW_STATE_KEY) ?? '{}')).toMatchObject({
      date: '2026-09-06',
      attempts: 1,
      runIds: ['run-w1'],
    });
    expect(await weeklyReviewTask(env, SUNDAY_0910 + 5 * 60_000)).toEqual({
      skipped: 'wait-first',
    });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('12:10 - звіт уже в reports → нічого; звіту нема → алерт у TOPIC_SYSTEM і повтор; 13:10 після невдалого повтору - алерт, більше спроб немає', async () => {
    // Успіх - доставлений звіт (рядок у reports), а не «прогін без помилки».
    const okCase = taskEnv([{ id: 'run-w1', error: null, finished: true }], true);
    okCase.kv.set(
      WEEKLY_REVIEW_STATE_KEY,
      JSON.stringify({ date: '2026-09-06', attempts: 1, runIds: ['run-w1'], alerted: false }),
    );
    expect(await weeklyReviewTask(okCase.env, SUNDAY_1210)).toEqual({ skipped: 'ok' });
    expect(start).not.toHaveBeenCalled();

    const failCase = taskEnv([{ id: 'run-w1', error: 'brain-error', finished: true }]);
    failCase.kv.set(
      WEEKLY_REVIEW_STATE_KEY,
      JSON.stringify({ date: '2026-09-06', attempts: 1, runIds: ['run-w1'], alerted: false }),
    );
    expect(await weeklyReviewTask(failCase.env, SUNDAY_1210)).toEqual({
      started: true,
      queued: false,
    });
    expect(start).toHaveBeenCalledTimes(1);
    const alerts = failCase.d1.db.prepare('SELECT thread_id, payload_json FROM outbox').all() as {
      thread_id: string;
      payload_json: string;
    }[];
    expect(
      alerts.some((a) => a.thread_id === '7' && a.payload_json.includes('повторюю о 12:00')),
    ).toBe(true);

    // Повтор теж упав: після 12:00 - алерт «не вдався двічі», стан alerted.
    const twice = taskEnv([
      { id: 'run-w1', error: 'brain-error', finished: true },
      { id: 'run-w2', error: 'timeout', finished: true },
    ]);
    twice.kv.set(
      WEEKLY_REVIEW_STATE_KEY,
      JSON.stringify({
        date: '2026-09-06',
        attempts: 2,
        runIds: ['run-w1', 'run-w2'],
        alerted: false,
      }),
    );
    expect(await weeklyReviewTask(twice.env, SUNDAY_1310)).toEqual({ alerted: true });
    const rows = twice.d1.db.prepare('SELECT payload_json FROM outbox').all() as {
      payload_json: string;
    }[];
    expect(rows.some((r) => r.payload_json.includes('не вдався двічі'))).toBe(true);
    expect(await weeklyReviewTask(twice.env, SUNDAY_1310 + 60_000)).toEqual({ skipped: 'done' });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('втрата стану weekly-review не перетворює кожен 5-хвилинний тік на новий запуск', async () => {
    // Реальний захист від циклу: state могло не зберегтися, але два запуски
    // дня вже незворотно є в D1. Без звіряння з runs третя помилка Claude
    // приходила б через наступні п'ять хвилин.
    const { env, kv } = taskEnv([
      { id: 'run-w1', error: 'brain-error', finished: true },
      { id: 'run-w2', error: 'brain-error', finished: true },
    ]);
    expect(await weeklyReviewTask(env, SUNDAY_1210)).toEqual({ skipped: 'state-reconciled' });
    expect(start).not.toHaveBeenCalled();
    expect(JSON.parse(kv.get(WEEKLY_REVIEW_STATE_KEY) ?? '{}')).toMatchObject({
      date: '2026-09-06',
      attempts: 2,
      runIds: ['run-w1', 'run-w2'],
    });
  });

  it('вимкнений доступ Claude Code не ретраїться о 12:00', async () => {
    const { env, kv, d1 } = taskEnv([{ id: 'run-w1', error: 'brain-error', finished: true }]);
    d1.db
      .prepare(
        `INSERT INTO run_steps (id, run_id, n, at, kind, name, note)
         VALUES ('run-w1:1', 'run-w1', 1, '2026-09-06T06:12:00Z', 'error', 'weekly-review', ?)`,
      )
      .run(
        'Claude Code returned an error result: Your organization has disabled Claude subscription access for Claude Code',
      );
    kv.set(
      WEEKLY_REVIEW_STATE_KEY,
      JSON.stringify({ date: '2026-09-06', attempts: 1, runIds: ['run-w1'], alerted: false }),
    );

    expect(await weeklyReviewTask(env, SUNDAY_1210)).toEqual({ skipped: 'model-access-disabled' });
    expect(start).not.toHaveBeenCalled();
    expect(JSON.parse(kv.get(WEEKLY_REVIEW_STATE_KEY) ?? '{}')).toMatchObject({
      attempts: 2,
      alerted: true,
    });
  });

  it('прогін у черзі треду (runId null): звіту о 12:00 нема - повтор; звіт з черги ДОСТАВЛЕНО - без повтору (ревʼю: дубль звіту)', async () => {
    start.mockResolvedValueOnce(null);
    const { env, kv } = taskEnv();
    expect(await weeklyReviewTask(env, SUNDAY_0910)).toEqual({ started: false, queued: true });
    expect(JSON.parse(kv.get(WEEKLY_REVIEW_STATE_KEY) ?? '{}').runIds).toEqual(['queued']);
    expect(await weeklyReviewTask(env, SUNDAY_1210)).toEqual({ started: true, queued: false });

    // Той самий старт із черги, але прогін із черги встиг доставити звіт:
    // reports має рядок за сьогодні - другий звіт НЕ стартує.
    start.mockResolvedValueOnce(null);
    const delivered = taskEnv([], true);
    await weeklyReviewTask(delivered.env, SUNDAY_0910);
    expect(await weeklyReviewTask(delivered.env, SUNDAY_1210)).toEqual({ skipped: 'ok' });
    expect(await weeklyReviewTask(delivered.env, SUNDAY_1310)).toEqual({ skipped: 'ok' });
    // Три старти на два середовища: 09:10 + повтор 12:10 у першому, лише
    // 09:10 у другому - повтору після доставленого звіту немає.
    expect(start).toHaveBeenCalledTimes(3);
  });
});
