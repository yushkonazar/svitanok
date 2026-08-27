// Prerouter (ADR-039, етап 2 PR-3): класифікація N3, режими off/shadow/on,
// нові команди 07 §10, черга треду, «стоп», старт прогону з сесією з D1,
// ретраї при недоступному мозку (S-0-7), «підняття» черг. Реальні міграції
// (sessions/outbox), стаб RUN_REGISTRY (DO-логіка окремо в thread-queue.test),
// стаб fetch (Telegram + мозок).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  classifyRoute,
  parseNewCommand,
  prerouteMessage,
  startClaimedRun,
  kickPendingThreads,
} from '../web/core/prerouter.mjs';
import { workerEnv } from './helpers/env.js';

const NOW = Date.parse('2026-08-27T12:00:00.000Z');
const KEY = 'prerouter-test-key';

// ── Класифікатор N3 ──────────────────────────────────────────────────────────

describe('classifyRoute (N3)', () => {
  it('S-N3-1: «скільки 17 % від 4 200» → quick', () => {
    expect(classifyRoute('скільки 17 % від 4 200')).toBe('quick');
  });
  it('S-N3-2: «якого року заснували Львів» → quick', () => {
    expect(classifyRoute('якого року заснували Львів')).toBe('quick');
  });
  it('S-N3-3: «коли в мене зустріч» → якір → chat', () => {
    expect(classifyRoute('коли в мене зустріч')).toBe('chat');
  });
  it('S-N3-4: > 120 символів → chat навіть без якорів', () => {
    expect(classifyRoute('що таке Durable Object простими словами'.padEnd(140, '?'))).toBe('chat');
  });
  it('S-N3-5: «скільки я витратив учора» → якір витрат → chat', () => {
    expect(classifyRoute('скільки я витратив учора')).toBe('chat');
  });
  it('URL → chat; без числа і питального слова → chat', () => {
    expect(classifyRoute('скільки коштує https://example.com')).toBe('chat');
    expect(classifyRoute('привіт')).toBe('chat');
  });
});

describe('parseNewCommand', () => {
  it('нові команди ловляться (і з @botname), легасі - ні', () => {
    expect(parseNewCommand('/new')).toBe('new');
    expect(parseNewCommand('/status@svitanok_bot')).toBe('status');
    expect(parseNewCommand('/idea щось')).toBe('idea');
    expect(parseNewCommand('/stats')).toBeNull();
    expect(parseNewCommand('текст /new усередині')).toBeNull();
  });
});

// ── Обвʼязка потоків ─────────────────────────────────────────────────────────

const d1FromSqlite = () => {
  const db = new DatabaseSync(':memory:');
  for (const f of ['0001_base.sql', '0002_assistant.sql']) {
    db.exec(readFileSync(join(__dirname, '..', 'web', 'core', 'migrations', f), 'utf8'));
  }
  return {
    db,
    stub: {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          run: async () => {
            // @ts-expect-error варіативні біндинги node:sqlite
            const info = db.prepare(sql).run(...args);
            // Драйн outbox звіряє meta.changes (claim конкурентного драйну).
            return { meta: { changes: Number(info.changes) } };
          },
          all: async () => ({
            // @ts-expect-error те саме
            results: db.prepare(sql).all(...args),
          }),
          first: async () => {
            // @ts-expect-error те саме
            return db.prepare(sql).get(...args) ?? null;
          },
        }),
      }),
    },
  };
};

type ThreadState = {
  activeRunId: string | null;
  statusMessageId: number | null;
  queue: Record<string, unknown>[];
};

function makeRegistryStub() {
  const begins: Record<string, unknown>[] = [];
  const finishes: { id: string; patch: Record<string, unknown> }[] = [];
  const retries: { threadId: string; entry: Record<string, unknown> }[] = [];
  const threads = new Map<string, ThreadState>();
  const stub = {
    begin: async (run: Record<string, unknown>) => void begins.push(run),
    finish: async (id: string, patch: Record<string, unknown>) => void finishes.push({ id, patch }),
    threadClaim: async (threadId: string, entry: Record<string, unknown>) => {
      const t = threads.get(threadId) ?? { activeRunId: null, statusMessageId: null, queue: [] };
      if (t.activeRunId != null || t.queue.length > 0) {
        t.queue.push(entry);
        threads.set(threadId, t);
        return { queued: t.queue.length };
      }
      t.activeRunId = 'pending';
      threads.set(threadId, t);
      return { start: true };
    },
    threadSetRun: async (threadId: string, runId: string, statusMessageId: number | null) => {
      const t = threads.get(threadId);
      if (!t) return { claimed: false };
      t.activeRunId = runId;
      t.statusMessageId = statusMessageId;
      return { claimed: true };
    },
    threadFinish: async (threadId: string, runId: string | null) => {
      const t = threads.get(threadId);
      if (!t) return { next: null };
      if (runId != null && t.activeRunId !== runId) return { next: null, notOwner: true };
      const next = t.queue.shift() ?? null;
      if (next) t.activeRunId = 'pending';
      else threads.delete(threadId);
      return { next };
    },
    sweepStale: async () => [],
    threadSweep: async () => [],
    threadClear: async (threadId: string) => {
      const t = threads.get(threadId);
      threads.delete(threadId);
      if (!t) return { activeRunId: null, statusMessageId: null, cleared: 0 };
      return {
        activeRunId: t.activeRunId === 'pending' ? null : t.activeRunId,
        statusMessageId: t.statusMessageId,
        cleared: t.queue.length,
      };
    },
    threadRetry: async (threadId: string, entry: Record<string, unknown>) => {
      const t = threads.get(threadId) ?? { activeRunId: null, statusMessageId: null, queue: [] };
      t.queue.unshift(entry);
      t.activeRunId = null;
      threads.set(threadId, t);
      retries.push({ threadId, entry });
    },
    threadKickNext: async (threadId: string) => {
      const t = threads.get(threadId);
      if (!t || t.activeRunId != null) return { next: null };
      const next = t.queue.shift() ?? null;
      if (next) t.activeRunId = 'pending';
      else threads.delete(threadId);
      return { next };
    },
    threadsSnapshot: async () => Object.fromEntries(threads),
  };
  return { begins, finishes, retries, threads, ns: { getByName: () => stub } };
}

/** Стаб fetch: Telegram API + мозок. Журналює виклики за методом/шляхом. */
function makeFetchStub(brainStatus = 202) {
  const tg: { method: string; body: Record<string, unknown> }[] = [];
  const brain: { path: string; body: Record<string, unknown> }[] = [];
  let msgSeq = 100;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      if (u.includes('api.telegram.org')) {
        const method = u.split('/').pop() ?? '';
        tg.push({ method, body });
        msgSeq += 1;
        return new Response(JSON.stringify({ ok: true, result: { message_id: msgSeq } }), {
          status: 200,
        });
      }
      if (u.includes('brain.example')) {
        brain.push({ path: new URL(u).pathname, body });
        return new Response(JSON.stringify({ ok: brainStatus === 202 }), { status: brainStatus });
      }
      throw new Error(`несподіваний fetch: ${u}`);
    }),
  );
  return { tg, brain };
}

const parsedMsg = (text: string, over: Record<string, unknown> = {}) => ({
  kind: 'message',
  chatId: 555,
  threadId: null,
  messageId: 1,
  fromId: 777,
  text,
  ...over,
});

function makeEnv(reg: ReturnType<typeof makeRegistryStub>, db: unknown, mode = 'on') {
  return workerEnv({
    ASSISTANT_V2: mode,
    INTERNAL_HMAC_KEY: KEY,
    BRAIN_URL: 'https://brain.example',
    TELEGRAM_BOT_TOKEN: 'bot-token',
    TELEGRAM_CHAT_ID: '555',
    TELEGRAM_OWNER_USER_ID: '777',
    TOPIC_ASSISTANT: '99',
    RUN_REGISTRY: reg.ns,
    DB: db,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('prerouteMessage: режими', () => {
  it('off → false, нічого не робиться', async () => {
    const reg = makeRegistryStub();
    const { tg } = makeFetchStub();
    const env = makeEnv(reg, d1FromSqlite().stub, 'off');
    expect(await prerouteMessage(env, parsedMsg('привіт'), NOW)).toBe(false);
    expect(tg).toHaveLength(0);
    expect(reg.begins).toHaveLength(0);
  });

  it('shadow без v2: класифікує, пише runs з trigger=shadow і віддає легасі', async () => {
    const reg = makeRegistryStub();
    const { tg, brain } = makeFetchStub();
    const env = makeEnv(reg, d1FromSqlite().stub, 'shadow');
    expect(await prerouteMessage(env, parsedMsg('скільки 2+2'), NOW)).toBe(false);
    // trigger='shadow' (ревʼю PR-3): класифікація відрізняється від бойових.
    expect(reg.begins[0]).toMatchObject({ trigger: 'shadow', profile: 'quick', threadId: 'dm' });
    expect(reg.finishes).toHaveLength(1);
    expect(tg).toHaveLength(0);
    expect(brain).toHaveLength(0);
  });

  it('shadow з v2: - повний шлях (статусник, begin, /run мозку з сесією)', async () => {
    const reg = makeRegistryStub();
    const { tg, brain } = makeFetchStub();
    const d1 = d1FromSqlite();
    d1.db
      .prepare(
        `INSERT INTO sessions (thread_id, sdk_session_id, started_at, last_at, tainted, summary_md, turn_count)
         VALUES ('dm', 'sess-9', '2026-08-27T00:00:00Z', '2026-08-27T00:00:00Z', 0, 'Згортка', 3)`,
      )
      .run();
    const env = makeEnv(reg, d1.stub, 'shadow');

    expect(await prerouteMessage(env, parsedMsg('v2: привіт, як справи?'), NOW)).toBe(true);
    expect(tg[0]!.method).toBe('sendMessage');
    expect(tg[0]!.body.text).toBe('▸ Думаю…');
    expect(brain).toHaveLength(1);
    expect(brain[0]!.path).toBe('/run');
    expect(brain[0]!.body).toMatchObject({
      profile: 'chat',
      thread_id: 'dm',
      input: { text: 'привіт, як справи?' },
      session: { sdk_session_id: 'sess-9', summary_md: 'Згортка' },
      status_message_id: 101,
    });
    expect(reg.threads.get('dm')?.statusMessageId).toBe(101);
  });

  it('on: два повідомлення - друге дістає СТАТУСНИК «▸ Черга: 1» (S-0-2, редагований), мозок кликаний раз', async () => {
    const reg = makeRegistryStub();
    const { tg, brain } = makeFetchStub();
    const env = makeEnv(reg, d1FromSqlite().stub);
    await prerouteMessage(env, parsedMsg('перше питання про мій день'), NOW);
    await prerouteMessage(env, parsedMsg('друге питання про мої плани'), NOW + 1000);
    expect(brain).toHaveLength(1);
    // Черга - це EDIT статусника (не вічне повідомлення-сирота, ревʼю PR-3).
    const queueEdit = tg.find(
      (c) => c.method === 'editMessageText' && String(c.body.text).includes('Черга: 1'),
    );
    expect(queueEdit).toBeDefined();
    // Його id збережено в queue-entry для reuse при підйомі.
    expect(reg.threads.get('dm')?.queue[0]).toMatchObject({ statusMessageId: 102 });
  });

  it('інша тема - false; легасі-команда /stats - false', async () => {
    const reg = makeRegistryStub();
    makeFetchStub();
    const env = makeEnv(reg, d1FromSqlite().stub);
    expect(await prerouteMessage(env, parsedMsg('привіт', { threadId: 123 }), NOW)).toBe(false);
    expect(await prerouteMessage(env, parsedMsg('/stats'), NOW)).toBe(false);
  });

  it('СПІВВЛАСНИК не отримує новий шлях (security-ревʼю PR-3): false і жодних ефектів', async () => {
    const reg = makeRegistryStub();
    const { tg, brain } = makeFetchStub();
    const env = makeEnv(reg, d1FromSqlite().stub);
    for (const text of ['привіт', 'v2: привіт', 'стоп', '/new', '/status']) {
      expect(await prerouteMessage(env, parsedMsg(text, { fromId: 888 }), NOW)).toBe(false);
    }
    expect(tg).toHaveLength(0);
    expect(brain).toHaveLength(0);
    expect(reg.begins).toHaveLength(0);
    expect(reg.threads.size).toBe(0);
  });
});

describe('prerouteMessage: нові команди', () => {
  it('/new: sdk-сесія скинута, taint 0, згортка ЛИШАЄТЬСЯ (S-0-4)', async () => {
    const reg = makeRegistryStub();
    const { tg } = makeFetchStub();
    const d1 = d1FromSqlite();
    d1.db
      .prepare(
        `INSERT INTO sessions (thread_id, sdk_session_id, started_at, last_at, tainted, summary_md, turn_count)
         VALUES ('dm', 'sess-1', '2026-08-27T00:00:00Z', '2026-08-27T00:00:00Z', 1, 'Згортка', 5)`,
      )
      .run();
    const env = makeEnv(reg, d1.stub);
    expect(await prerouteMessage(env, parsedMsg('/new'), NOW)).toBe(true);
    const row = d1.db.prepare(`SELECT * FROM sessions WHERE thread_id='dm'`).get() as Record<
      string,
      unknown
    >;
    expect(row).toMatchObject({ sdk_session_id: null, tainted: 0, summary_md: 'Згортка' });
    expect(tg.some((c) => String(c.body.text).includes('чистого аркуша'))).toBe(true);
  });

  it('підказки R26 і /status відповідають; /forget - чесна заглушка', async () => {
    const reg = makeRegistryStub();
    const { tg, brain } = makeFetchStub();
    const env = makeEnv(reg, d1FromSqlite().stub);
    await prerouteMessage(env, parsedMsg('/idea'), NOW);
    await prerouteMessage(env, parsedMsg('/status'), NOW);
    await prerouteMessage(env, parsedMsg('/forget'), NOW);
    expect(tg.some((c) => String(c.body.text).includes('збережи ідею'))).toBe(true);
    expect(tg.some((c) => String(c.body.text).includes('Режим: on'))).toBe(true);
    expect(tg.some((c) => String(c.body.text).includes('етап 3'))).toBe(true);
    expect(brain).toHaveLength(0);
  });
});

describe('«стоп» (S-0-3)', () => {
  it('активний прогін: /abort мозку, finish stopped, статусник «Зупинив.», черга очищена', async () => {
    const reg = makeRegistryStub();
    const { tg, brain } = makeFetchStub();
    const env = makeEnv(reg, d1FromSqlite().stub);
    reg.threads.set('dm', {
      activeRunId: 'run-active',
      statusMessageId: 77,
      queue: [{ text: 'у черзі', route: 'chat', attempts: 0, atMs: NOW }],
    });

    expect(await prerouteMessage(env, parsedMsg('стоп'), NOW)).toBe(true);
    expect(brain[0]).toMatchObject({ path: '/abort', body: { run_id: 'run-active' } });
    expect(reg.finishes[0]).toMatchObject({ id: 'run-active', patch: { error: 'stopped' } });
    const edit = tg.find((c) => c.method === 'editMessageText');
    expect(edit?.body).toMatchObject({ message_id: 77, text: 'Зупинив.' });
    expect(reg.threads.has('dm')).toBe(false);
  });

  it('нема активного - «Нема чого зупиняти.»', async () => {
    const reg = makeRegistryStub();
    const { tg } = makeFetchStub();
    const env = makeEnv(reg, d1FromSqlite().stub);
    await prerouteMessage(env, parsedMsg('Стоп!'), NOW);
    expect(tg.some((c) => String(c.body.text).includes('Нема чого'))).toBe(true);
  });
});

describe('S-0-7: мозок недоступний', () => {
  it('невдалий старт: retry у чергу (attempts+1) + статус «спробую ще раз», finish з brain-start', async () => {
    const reg = makeRegistryStub();
    const { tg } = makeFetchStub(502);
    const env = makeEnv(reg, d1FromSqlite().stub);
    await prerouteMessage(env, parsedMsg('питання про мої справи'), NOW);
    expect(reg.retries).toHaveLength(1);
    expect(reg.retries[0]!.entry).toMatchObject({ attempts: 1, statusMessageId: 101 });
    expect(reg.finishes[0]!.patch.error).toBe('brain-start: 502');
    expect(tg.some((c) => String(c.body.text).includes('спробую ще раз'))).toBe(true);
  });

  it('третя невдача - «Не вдалося…», без retry', async () => {
    const reg = makeRegistryStub();
    const { tg } = makeFetchStub(502);
    const env = makeEnv(reg, d1FromSqlite().stub);
    reg.threads.set('dm', { activeRunId: 'pending', statusMessageId: null, queue: [] });
    await startClaimedRun(
      env,
      { chatId: 555, threadId: null },
      'dm',
      { text: 'питання', route: 'chat', attempts: 2, atMs: NOW },
      NOW,
    );
    expect(reg.retries).toHaveLength(0);
    expect(tg.some((c) => String(c.body.text).includes('Не вдалося'))).toBe(true);
  });

  it('kickPendingThreads піднімає вільний тред із чергою, REUSE статусника', async () => {
    const reg = makeRegistryStub();
    const { tg, brain } = makeFetchStub(202);
    const env = makeEnv(reg, d1FromSqlite().stub);
    reg.threads.set('dm', {
      activeRunId: null,
      statusMessageId: null,
      queue: [{ text: 'відкладене', route: 'chat', attempts: 1, atMs: NOW, statusMessageId: 88 }],
    });
    const res = await kickPendingThreads(env, NOW);
    expect(res).toEqual({ kicked: 1 });
    expect(brain[0]!.body).toMatchObject({ input: { text: 'відкладене' }, status_message_id: 88 });
    // Нового статусника НЕ шлемо - редагуватиметься 88.
    expect(tg.filter((c) => c.method === 'sendMessage')).toHaveLength(0);
  });
});

describe('ревʼю PR-3: класифікатор, стоп-вікно, транспортна невизначеність', () => {
  it('дефіс - не оператор: дати/діапазони/топ-N лишаються chat; « - » з пробілами - quick', () => {
    expect(classifyRoute('підсумуй розмову за 2026-08-27')).toBe('chat');
    expect(classifyRoute('топ-5 фільмів десятиліття назви')).toBe('chat');
    expect(classifyRoute('о 18-30 підходить?')).toBe('chat');
    expect(classifyRoute('скільки буде 100 - 37')).toBe('quick');
    expect(classifyRoute('скільки 17 % від 4 200')).toBe('quick');
  });

  it('claimed:false від setRun («стоп» у вікні pending): мозок НЕ кличеться, прогін cancelled, статусник видалено', async () => {
    const reg = makeRegistryStub();
    const { tg, brain } = makeFetchStub();
    const env = makeEnv(reg, d1FromSqlite().stub);
    // Тред зник ДО setRun - стаб поверне claimed:false (треду немає в мапі).
    await startClaimedRun(
      env,
      { chatId: 555, threadId: null },
      'dm',
      { text: 'запізніле', route: 'chat', attempts: 0, atMs: NOW },
      NOW,
    );
    expect(brain).toHaveLength(0);
    expect(reg.finishes[0]).toMatchObject({ patch: { error: 'cancelled' } });
    expect(tg.some((c) => c.method === 'deleteMessage')).toBe(true);
  });

  it('транспортний збій /run (status 0): прогін НЕ закривається і НЕ ретраїться - чекаємо/сторож', async () => {
    const reg = makeRegistryStub();
    const tgLog: { method: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        if (u.includes('api.telegram.org')) {
          tgLog.push({ method: u.split('/').pop() ?? '', body });
          return new Response(JSON.stringify({ ok: true, result: { message_id: 300 } }), {
            status: 200,
          });
        }
        throw new Error('tunnel мовчить');
      }),
    );
    const env = makeEnv(reg, d1FromSqlite().stub);
    await prerouteMessage(env, parsedMsg('питання про мої плани'), NOW);
    expect(reg.finishes).toHaveLength(0);
    expect(reg.retries).toHaveLength(0);
    expect(reg.threads.get('dm')?.activeRunId).not.toBeNull();
    expect(tgLog.some((c) => String(c.body.text).includes('повільний'))).toBe(true);
  });
});
