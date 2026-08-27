// Клієнт ядро→мозок (callBrainRun) і задача memory-summarize (ADR-038).
// Наскрізна парність: запит, підписаний ЯДРОМ, проходить перевірку МОЗКУ
// (brain/src/sign.ts verifySignedRequest) - дзеркальний бік до тестів PR-1,
// де підпис мозку перевіряло ядро. Задача: гейт годиною 04:00 Києва, добова
// мітка, вибірка тредів з sdk-сесією, registryBegin ДО виклику.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { callBrainRun } from '../web/core/brain/run-client.mjs';
import { memorySummarize, SUMMARIZE_MAX_THREADS } from '../web/core/brain/summarize.mjs';
import { verifySignedRequest } from '../brain/src/sign.js';
import { RUN_REQUEST_SCHEMA } from '../brain/src/server.js';
import { workerEnv } from './helpers/env.js';

// 04:10 Києва (01:10 UTC у серпні, UTC+3).
const NOW_04 = Date.parse('2026-08-27T01:10:00.000Z');
const KEY = 'core-to-brain-key';

const kvStub = () => {
  const kv = new Map<string, string>();
  return {
    kv,
    stub: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => void kv.set(k, v),
      delete: async (k: string) => void kv.delete(k),
      list: async () => ({ keys: [] }),
    },
  };
};

const captureFetch = (status = 202, body: unknown = { ok: true }) => {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify(body), { status });
    }),
  );
  return calls;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('callBrainRun', () => {
  const env = () =>
    workerEnv({
      BRAIN_URL: 'https://brain.example',
      INTERNAL_HMAC_KEY: KEY,
      BRAIN_ACCESS_CLIENT_ID: 'acc-id',
      BRAIN_ACCESS_CLIENT_SECRET: 'acc-secret',
    });

  it('шле підписаний POST /run з Access-парою; підпис ядра проходить перевірку МОЗКУ, тіло - контракт мозку', async () => {
    const calls = captureFetch();
    const res = await callBrainRun(
      env(),
      {
        runId: 'run-9',
        profile: 'summarize',
        threadId: 'dm',
        inputText: 'згорни розмову',
        session: { sdk_session_id: 'sess-1', summary_md: null },
      },
      NOW_04,
    );
    expect(res).toEqual({ ok: true });
    const call = calls[0]!;
    expect(call.url).toBe('https://brain.example/run');
    const headers = new Headers(call.init.headers as Record<string, string>);
    expect(headers.get('CF-Access-Client-Id')).toBe('acc-id');
    const rawBody = String(call.init.body);

    // Дзеркальний бік наскрізної парності: перевіряє КОД МОЗКУ.
    const verdict = verifySignedRequest({
      method: 'POST',
      path: '/run',
      getHeader: (n) => headers.get(n),
      bodyText: rawBody,
      nowMs: NOW_04,
      keys: [KEY],
    });
    expect(verdict).toMatchObject({ ok: true, runId: 'run-9' });

    // Тіло, яке шле ЯДРО, парситься СХЕМОЮ МОЗКУ - контракт /run наскрізь.
    const parsed = RUN_REQUEST_SCHEMA.safeParse(JSON.parse(rawBody));
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toMatchObject({
      run_id: 'run-9',
      profile: 'summarize',
      thread_id: 'dm',
      input: { text: 'згорни розмову' },
      session: { sdk_session_id: 'sess-1', summary_md: null },
    });
  });

  it('без BRAIN_URL або ключа - явна відмова; не-202 і мережа - {ok:false} з деталлю', async () => {
    expect(
      await callBrainRun(
        workerEnv({ INTERNAL_HMAC_KEY: KEY }),
        { runId: 'r', profile: 'chat', threadId: 'dm', inputText: 'x' },
        NOW_04,
      ),
    ).toMatchObject({ ok: false, detail: /BRAIN_URL/ });
    expect(
      await callBrainRun(
        workerEnv({ BRAIN_URL: 'https://brain.example' }),
        { runId: 'r', profile: 'chat', threadId: 'dm', inputText: 'x' },
        NOW_04,
      ),
    ).toMatchObject({ ok: false, detail: /INTERNAL_HMAC_KEY/ });

    captureFetch(429, { ok: false, error: 'busy' });
    expect(
      await callBrainRun(
        env(),
        { runId: 'r', profile: 'chat', threadId: 'dm', inputText: 'x' },
        NOW_04,
      ),
    ).toEqual({ ok: false, status: 429, detail: 'busy' });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('tunnel down');
      }),
    );
    expect(
      await callBrainRun(
        env(),
        { runId: 'r', profile: 'chat', threadId: 'dm', inputText: 'x' },
        NOW_04,
      ),
    ).toMatchObject({ ok: false, status: 0, detail: /недосяжний/ });
  });
});

describe('memorySummarize', () => {
  let db: DatabaseSync;
  let begins: Record<string, unknown>[];
  let env: Env;
  let kv: Map<string, string>;

  const seedSession = (threadId: string, lastAt: string, sid: string | null, tainted = 0) => {
    db.prepare(
      `INSERT INTO sessions (thread_id, sdk_session_id, started_at, last_at, tainted, turn_count)
       VALUES (?, ?, ?, ?, ?, 1)`,
    ).run(threadId, sid, lastAt, lastAt, tainted);
  };

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(
      readFileSync(join(__dirname, '..', 'web', 'core', 'migrations', '0001_base.sql'), 'utf8'),
    );
    begins = [];
    const k = kvStub();
    kv = k.kv;
    env = workerEnv({
      ASSISTANT_V2: 'on',
      BRIEFING: k.stub,
      BRAIN_URL: 'https://brain.example',
      INTERNAL_HMAC_KEY: KEY,
      DB: {
        prepare: (sql: string) => ({
          bind: (...args: unknown[]) => ({
            all: async () => ({
              // @ts-expect-error node:sqlite приймає біндинги варіативно
              results: db.prepare(sql).all(...args),
            }),
            run: async () => {
              // @ts-expect-error те саме для run
              db.prepare(sql).run(...args);
            },
          }),
        }),
      },
      RUN_REGISTRY: {
        getByName: () => ({
          begin: async (run: Record<string, unknown>) => void begins.push(run),
        }),
      },
    });
  });

  it('поза 04:00 Києва - skipped:hour, нічого не робиться', async () => {
    captureFetch();
    const res = await memorySummarize(env, Date.parse('2026-08-27T12:00:00Z'));
    expect(res).toEqual({ skipped: 'hour' });
    expect(begins).toHaveLength(0);
  });

  it('о 04:xx: тред з активністю і сесією → begin ДО виклику /run; мітка ставиться; удруге - skipped:done', async () => {
    const calls = captureFetch();
    seedSession('dm', new Date(NOW_04 - 3_600_000).toISOString(), 'sess-1');
    seedSession('старий', new Date(NOW_04 - 48 * 3_600_000).toISOString(), 'sess-2');
    seedSession('без-сесії', new Date(NOW_04 - 3_600_000).toISOString(), null);

    seedSession('брудний', new Date(NOW_04 - 3_600_000).toISOString(), 'sess-3', 1);

    const res = await memorySummarize(env, NOW_04);
    // Брудний тред НЕ згортається (security-ревʼю: інакше зовнішній вміст
    // відмився б у памʼять); лишається лише чистий 'dm'.
    expect(res).toEqual({ started: 1, threads: 1 });
    expect(begins).toHaveLength(1);
    expect(begins[0]).toMatchObject({ trigger: 'scheduler', profile: 'summarize', threadId: 'dm' });
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      profile: 'summarize',
      thread_id: 'dm',
      session: { sdk_session_id: 'sess-1', summary_md: null },
    });
    expect(String(body.run_id)).toBe(String(begins[0]!.id));
    expect(kv.get('memorySummarizedDay')).toBe('2026-08-27');

    const again = await memorySummarize(env, NOW_04 + 5 * 60_000);
    expect(again).toEqual({ skipped: 'done' });
    expect(begins).toHaveLength(1);
  });

  it('відмова мозку логувалась, але мітка ставиться (дубль дешевший за втрачений день)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    captureFetch(429, { ok: false, error: 'busy' });
    seedSession('dm', new Date(NOW_04 - 3_600_000).toISOString(), 'sess-1');
    const res = await memorySummarize(env, NOW_04);
    expect(res).toEqual({ started: 0, threads: 1 });
    expect(kv.get('memorySummarizedDay')).toBe('2026-08-27');
  });

  it('стеля тредів на добу тримається', async () => {
    captureFetch();
    for (let i = 0; i < SUMMARIZE_MAX_THREADS + 3; i += 1) {
      seedSession(`t${i}`, new Date(NOW_04 - 60_000 * (i + 1)).toISOString(), `s${i}`);
    }
    const res = await memorySummarize(env, NOW_04);
    expect(res).toEqual({ started: SUMMARIZE_MAX_THREADS, threads: SUMMARIZE_MAX_THREADS });
  });
});
