// POST /internal/runs (дротування етапу 2 PR-2): кроки мозку в run_steps на
// СПРАВЖНІЙ міграції 0003 + закриття прогону в RunRegistry. Поля коерсяться
// дбайливо (контракт гарантує лише масив обʼєктів), kind='error' у кроках →
// finish з error='brain-error'.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { signInternal } from '../web/core/internal/auth.mjs';
import { handleInternal } from '../web/core/internal/router.mjs';
import { workerEnv } from './helpers/env.js';
import { d1WithInstructions } from './helpers/instructions.js';

const KEY = 'runs-test-key';
const NOW = Date.parse('2026-08-27T12:00:00.000Z');
const PATH = '/internal/runs';

let nonceSeq = 0;
const request = async (bodyObj: unknown) => {
  const body = JSON.stringify(bodyObj);
  nonceSeq += 1;
  const nonce = `rn-${nonceSeq}`;
  return new Request(`https://svitanok.test${PATH}`, {
    method: 'POST',
    headers: {
      'X-Internal-Timestamp': String(NOW),
      'X-Internal-Run': 'r1',
      'X-Internal-Nonce': nonce,
      'X-Internal-Signature': await signInternal(KEY, {
        method: 'POST',
        path: PATH,
        timestampMs: NOW,
        runId: 'r1',
        nonce,
        rawBody: body,
      }),
    },
    body,
  });
};

describe('POST /internal/runs', () => {
  let env: Env;
  let db: DatabaseSync;
  let finishes: { id: string; patch: Record<string, unknown> }[];

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const d1 = d1WithInstructions(['0001_base.sql', '0003_telemetry.sql']);
    db = d1.db;
    finishes = [];
    env = workerEnv({
      ASSISTANT_V2: 'shadow',
      INTERNAL_HMAC_KEY: KEY,
      DB: d1.stub,
      RUN_REGISTRY: {
        getByName: () => ({
          has: async (id: string) => id === 'r1',
          consumeNonce: async () => true,
          finish: async (id: string, patch: Record<string, unknown>) =>
            void finishes.push({ id, patch }),
        }),
      },
    });
  });

  it('кроки пишуться в run_steps як прийшли; finish зі steps-лічильником, без error', async () => {
    const res = await handleInternal(
      await request({
        steps: [
          { n: 1, at: '2026-08-27T11:59:00Z', kind: 'tool', name: 'data.read', ms: 120, ok: true },
          { n: 2, at: '2026-08-27T11:59:05Z', kind: 'reply', name: 'deliver', ms: 5000, ok: true },
        ],
      }),
      env,
      NOW,
    );
    expect(await res.json()).toMatchObject({ ok: true, steps: 2 });
    const rows = db.prepare('SELECT * FROM run_steps ORDER BY n').all() as Record<
      string,
      unknown
    >[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ run_id: 'r1', n: 1, kind: 'tool', name: 'data.read', ok: 1 });
    expect(rows[1]).toMatchObject({ kind: 'reply', ms: 5000 });
    expect(finishes).toEqual([{ id: 'r1', patch: { finishedMs: NOW, error: null, steps: 2 } }]);
  });

  it('kind=error серед кроків → finish з error=brain-error', async () => {
    await handleInternal(
      await request({ steps: [{ kind: 'error', name: 'chat', note: 'таймаут профілю' }] }),
      env,
      NOW,
    );
    expect(finishes[0]!.patch).toMatchObject({ error: 'brain-error' });
  });

  it('криві поля коерсяться, а не валять телеметрію: n з індексу, note ріжеться', async () => {
    const res = await handleInternal(
      await request({ steps: [{ ms: 'не число', note: 'х'.repeat(600), ok: 0 }] }),
      env,
      NOW,
    );
    expect(res.status).toBe(200);
    const row = db.prepare('SELECT * FROM run_steps').get() as Record<string, unknown>;
    expect(row).toMatchObject({ n: 1, kind: 'tool', ms: null, ok: 0 });
    expect(String(row.note)).toHaveLength(500);
  });

  it('збій D1 - явний 500 steps-not-persisted; порожні steps - ok, лише finish', async () => {
    const empty = await handleInternal(await request({ steps: [] }), env, NOW);
    expect(await empty.json()).toMatchObject({ ok: true, steps: 0 });
    expect(finishes).toHaveLength(1);

    (env as { DB?: unknown }).DB = {
      prepare: () => ({
        bind: () => ({
          run: async () => {
            throw new Error('D1 упав');
          },
        }),
      }),
    };
    const broken = await handleInternal(await request({ steps: [{ n: 1 }] }), env, NOW);
    expect(broken.status).toBe(500);
    expect(await broken.json()).toMatchObject({ error: 'steps-not-persisted' });
  });
});

// ── Продовження треду після прогону (ADR-039) ────────────────────────────────

describe('handleRuns: ескалація і черга треду', () => {
  const richEnv = () => {
    const d1 = d1WithInstructions(['0001_base.sql', '0003_telemetry.sql']);
    // Outbox для статус-редагувань продовження.
    d1.db.exec(
      readFileSync(
        join(__dirname, '..', 'web', 'core', 'migrations', '0002_assistant.sql'),
        'utf8',
      ),
    );
    const threads = new Map<string, Record<string, unknown>>();
    const tg: { method: string; body: Record<string, unknown> }[] = [];
    const brain: { path: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        const b = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        if (u.includes('api.telegram.org')) {
          tg.push({ method: u.split('/').pop() ?? '', body: b });
          return new Response(JSON.stringify({ ok: true, result: { message_id: 500 } }), {
            status: 200,
          });
        }
        brain.push({ path: new URL(u).pathname, body: b });
        return new Response(JSON.stringify({ ok: true }), { status: 202 });
      }),
    );
    const env = workerEnv({
      ASSISTANT_V2: 'on',
      INTERNAL_HMAC_KEY: KEY,
      BRAIN_URL: 'https://brain.example',
      TELEGRAM_BOT_TOKEN: 'bot-token',
      TELEGRAM_CHAT_ID: '555',
      DB: d1.stub,
      RUN_REGISTRY: {
        getByName: () => ({
          has: async (id: string) => id === 'r1',
          consumeNonce: async () => true,
          begin: async () => undefined,
          // finish повертає інфо прогону - на ньому тримається продовження.
          finish: async (id: string) => (id === 'r1' ? { threadId: 'dm', chatId: 999 } : null),
          runInfo: async (id: string) => (id === 'r1' ? { threadId: 'dm', chatId: 999 } : null),
          threadFinish: async (threadId: string) => {
            const t = threads.get(threadId);
            const queue = (t?.queue as Record<string, unknown>[]) ?? [];
            return { next: queue.shift() ?? null };
          },
          threadSetRun: async () => ({ claimed: true }),
        }),
      },
    });
    return { env, threads, tg, brain, db: d1.db };
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('outcome.escalate (контракт) працює і БЕЗ журнального кроку - телеметрія не транспорт', async () => {
    const { env, brain } = richEnv();
    const res = await handleInternal(
      await request({
        steps: [{ n: 1, kind: 'reply', name: 'deliver-skip', ok: true }],
        outcome: { escalate: { text: 'через outcome', status_message_id: 55 } },
      }),
      env,
      NOW,
    );
    expect(res.status).toBe(200);
    const runCall = brain.find((c) => c.path === '/run');
    expect(runCall?.body).toMatchObject({
      profile: 'chat',
      input: { text: 'через outcome' },
      status_message_id: 55,
    });
  });

  it('S-N3-6: крок escalate → «Думаю довше…» у ТОЙ САМИЙ статусник + chat-прогін з тим самим текстом', async () => {
    const { env, brain, tg } = richEnv();
    const res = await handleInternal(
      await request({
        steps: [
          { n: 1, kind: 'reply', name: 'escalate', note: 'складне питання', status_message_id: 42 },
        ],
      }),
      env,
      NOW,
    );
    expect(res.status).toBe(200);
    const runCall = brain.find((c) => c.path === '/run');
    expect(runCall?.body).toMatchObject({
      profile: 'chat',
      thread_id: 'dm',
      input: { text: 'складне питання' },
      status_message_id: 42,
    });
    // Нового статусника НЕ шлемо (reuse 42), був лише edit «Думаю довше».
    expect(tg.filter((c) => c.method === 'sendMessage')).toHaveLength(0);
    expect(
      tg.some((c) => c.method === 'editMessageText' && String(c.body.text).includes('Думаю довше')),
    ).toBe(true);
  });

  it('без escalate: наступний запис черги стартує (reuse його статусника)', async () => {
    const { env, threads, brain, tg } = richEnv();
    threads.set('dm', {
      queue: [
        { text: 'відкладене питання', route: 'chat', attempts: 0, atMs: NOW, statusMessageId: 88 },
      ],
    });
    await handleInternal(
      await request({ steps: [{ n: 1, kind: 'reply', name: 'deliver', ok: true }] }),
      env,
      NOW,
    );
    const runCall = brain.find((c) => c.path === '/run');
    expect(runCall?.body).toMatchObject({
      input: { text: 'відкладене питання' },
      status_message_id: 88,
    });
    expect(tg.filter((c) => c.method === 'sendMessage')).toHaveLength(0);
  });

  it('порожня черга: жодного нового прогону', async () => {
    const { env, brain } = richEnv();
    await handleInternal(
      await request({ steps: [{ n: 1, kind: 'reply', name: 'deliver', ok: true }] }),
      env,
      NOW,
    );
    expect(brain.filter((c) => c.path === '/run')).toHaveLength(0);
  });

  it('deliver DM-прогону йде в chatId прогону з thread_id NULL, не в супергрупу з "dm"', async () => {
    const { env, db } = richEnv();
    const bodyObj = { text: 'відповідь у приват' };
    const body = JSON.stringify(bodyObj);
    const nonce = `dm-${Math.random()}`;
    const req = new Request('https://svitanok.test/internal/deliver', {
      method: 'POST',
      headers: {
        'X-Internal-Timestamp': String(NOW),
        'X-Internal-Run': 'r1',
        'X-Internal-Nonce': nonce,
        'X-Internal-Signature': await signInternal(KEY, {
          method: 'POST',
          path: '/internal/deliver',
          timestampMs: NOW,
          runId: 'r1',
          nonce,
          rawBody: body,
        }),
      },
      body,
    });
    const res = await handleInternal(req, env, NOW);
    expect(res.status).toBe(200);
    const row = db
      .prepare(`SELECT chat_id, thread_id FROM outbox ORDER BY id DESC LIMIT 1`)
      .get() as Record<string, unknown>;
    expect(String(row.chat_id)).toBe('999');
    expect(row.thread_id).toBeNull();
  });
});
