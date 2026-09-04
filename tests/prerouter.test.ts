// Prerouter (ADR-039, етап 2 PR-3): класифікація N3, режими off/shadow/on,
// нові команди 07 §10, черга треду, «стоп», старт прогону з сесією з D1,
// ретраї при недоступному мозку (S-0-7), «підняття» черг. Реальні міграції
// (sessions/outbox), стаб RUN_REGISTRY (DO-логіка окремо в thread-queue.test),
// стаб fetch (Telegram + мозок).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  classifyRoute,
  parseNewCommand,
  prerouteMessage,
  handleBrainCallback,
  startClaimedRun,
  kickPendingThreads,
  dayPlanChoiceEvent,
} from '../web/core/prerouter.mjs';
import { workerEnv } from './helpers/env.js';
import { d1FromSqlite } from './helpers/d1.js';
import { d1WithInstructions, syncInstructionHash, TEST_PERSONA } from './helpers/instructions.js';

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

describe('інструкція профілю в /run (PR-5)', () => {
  it('chat несе persona, quick несе quick - з тіла D1 і його ж хешем', async () => {
    // Окремі реєстри: один тред тримає один активний прогін, і друге
    // повідомлення в тому ж треді пішло б у чергу, а не в мозок.
    const runInstruction = async (text: string) => {
      const reg = makeRegistryStub();
      const { brain } = makeFetchStub();
      const d1 = d1WithInstructions(['0001_base.sql', '0002_assistant.sql']);
      await prerouteMessage(makeEnv(reg, d1.stub), parsedMsg(text), NOW);
      return brain[0]!.body.instruction as {
        name: string;
        body_md: string;
        version_hash: string;
      };
    };

    const chat = await runInstruction('нагадай про зустріч'); // якір N3 → chat
    expect(chat.name).toBe('persona');
    expect(chat.body_md).toBe(TEST_PERSONA);
    expect(chat.version_hash).toBe(syncInstructionHash(TEST_PERSONA));

    const quick = await runInstruction('скільки 2+2');
    expect(quick.name).toBe('quick');
  });

  // S-9-5 (етап 3 PR-3): «звіт зараз» - профіль weekly-review тим самим
  // шляхом; вхід прогону будує ядро (§0 інструкції), а не текст власника.
  it('«звіт зараз» → /run з profile=weekly-review, інструкцією weekly-review і входом §0', async () => {
    const reg = makeRegistryStub();
    const { brain } = makeFetchStub();
    const d1 = d1WithInstructions(['0001_base.sql', '0002_assistant.sql']);
    const body = '# Тижневий звіт';
    d1.db
      .prepare(
        `INSERT INTO instructions (name, kind, version_hash, body_md, max_chars, deployed_at)
         VALUES ('weekly-review', 'profile', ?, ?, 12000, '2026-09-01T00:00:00Z')`,
      )
      .run(syncInstructionHash(body), body);
    expect(await prerouteMessage(makeEnv(reg, d1.stub), parsedMsg('звіт зараз'), NOW)).toBe(true);
    expect(brain).toHaveLength(1);
    const sent = brain[0]!.body as {
      profile: string;
      instruction: { name: string };
      input: { text: string };
    };
    expect(sent.profile).toBe('weekly-review');
    expect(sent.instruction.name).toBe('weekly-review');
    expect(sent.input.text).toContain('period_from: 2026-08-24');
    expect(sent.input.text).toContain(`instruction_hash: ${syncInstructionHash(body)}`);
    expect(reg.begins[0]).toMatchObject({ profile: 'weekly-review', model: 'claude-sonnet-5' });
  });

  it('немає рядка в D1 - прогін НЕ стартує, запис у черзі, прогону не заведено', async () => {
    const reg = makeRegistryStub();
    const { tg, brain } = makeFetchStub();
    // База БЕЗ сіду інструкцій - як у вікні між деплоєм і синком.
    const d1 = d1FromSqlite(['0001_base.sql', '0002_assistant.sql', '0007_instructions_plans.sql']);
    const env = makeEnv(reg, d1.stub);

    expect(await prerouteMessage(env, parsedMsg('привіт'), NOW)).toBe(true);
    expect(brain).toHaveLength(0);
    // Вікно між деплоєм і синком самозагоюється, тож запис чекає, а не гине.
    expect(
      tg.some((c) => String(c.body.text ?? '').includes('Інструкції ще синхронізуються')),
    ).toBe(true);
    expect(reg.retries).toHaveLength(1);
    expect(reg.retries[0]!.entry).toMatchObject({ attempts: 1, text: 'привіт' });
    // Прогін не заводився взагалі: перевірка стоїть ДО begin (ревʼю PR-5).
    expect(reg.begins).toHaveLength(0);
    expect(reg.finishes).toHaveLength(0);
  });

  it('вичерпані спроби - тред очищено, без рекурсивного підйому черги', async () => {
    const reg = makeRegistryStub();
    const { tg, brain } = makeFetchStub();
    const d1 = d1FromSqlite(['0001_base.sql', '0002_assistant.sql', '0007_instructions_plans.sql']);
    const env = makeEnv(reg, d1.stub);
    reg.threads.set('dm', { activeRunId: 'pending', statusMessageId: 42, queue: [] });

    await startClaimedRun(
      env,
      { chatId: 555, threadId: null },
      'dm',
      { text: 'привіт', route: 'chat', attempts: 2, atMs: NOW },
      NOW,
      42,
    );

    expect(brain).toHaveLength(0);
    expect(reg.retries).toHaveLength(0); // стеля вичерпана - без нового ретраю
    expect(reg.threads.get('dm')).toBeUndefined(); // тред віддано
    expect(
      tg.some((c) => String(c.body.text ?? '').includes('Інструкції асистента не синхронізовані')),
    ).toBe(true);
  });
});

describe('prerouteMessage: режими', () => {
  it('off → false, нічого не робиться', async () => {
    const reg = makeRegistryStub();
    const { tg } = makeFetchStub();
    const env = makeEnv(
      reg,
      d1WithInstructions(['0001_base.sql', '0002_assistant.sql']).stub,
      'off',
    );
    expect(await prerouteMessage(env, parsedMsg('привіт'), NOW)).toBe(false);
    expect(tg).toHaveLength(0);
    expect(reg.begins).toHaveLength(0);
  });

  it('shadow без v2: класифікує, пише runs з trigger=shadow і віддає легасі', async () => {
    const reg = makeRegistryStub();
    const { tg, brain } = makeFetchStub();
    const env = makeEnv(
      reg,
      d1WithInstructions(['0001_base.sql', '0002_assistant.sql']).stub,
      'shadow',
    );
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
    const d1 = d1WithInstructions(['0001_base.sql', '0002_assistant.sql']);
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
    const env = makeEnv(reg, d1WithInstructions(['0001_base.sql', '0002_assistant.sql']).stub);
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
    const env = makeEnv(reg, d1WithInstructions(['0001_base.sql', '0002_assistant.sql']).stub);
    expect(await prerouteMessage(env, parsedMsg('привіт', { threadId: 123 }), NOW)).toBe(false);
    expect(await prerouteMessage(env, parsedMsg('/stats'), NOW)).toBe(false);
  });

  it('СПІВВЛАСНИК не отримує новий шлях (security-ревʼю PR-3): false і жодних ефектів', async () => {
    const reg = makeRegistryStub();
    const { tg, brain } = makeFetchStub();
    const env = makeEnv(reg, d1WithInstructions(['0001_base.sql', '0002_assistant.sql']).stub);
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
    const d1 = d1WithInstructions(['0001_base.sql', '0002_assistant.sql']);
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

  it('підказки R26 і /status відповідають; /forget без колекцій - чесно порожньо', async () => {
    const reg = makeRegistryStub();
    const { tg, brain } = makeFetchStub();
    const env = makeEnv(
      reg,
      d1WithInstructions(['0001_base.sql', '0002_assistant.sql', '0006_inbox_collections.sql'])
        .stub,
    );
    await prerouteMessage(env, parsedMsg('/idea'), NOW);
    await prerouteMessage(env, parsedMsg('/status'), NOW);
    await prerouteMessage(env, parsedMsg('/forget'), NOW);
    expect(tg.some((c) => String(c.body.text).includes('збережи ідею'))).toBe(true);
    expect(tg.some((c) => String(c.body.text).includes('Режим: on'))).toBe(true);
    expect(tg.some((c) => String(c.body.text).includes('Забувати поки нічого'))).toBe(true);
    expect(brain).toHaveLength(0);
  });

  // S-0-16 (етап 3 PR-7): «не нагадуй про X» - детерміновано у facts, без прогону.
  it('«не нагадуй про ideas» → hint_mute_json у facts, відповідь із «↩», мозок не кликано', async () => {
    const reg = makeRegistryStub();
    const { tg, brain } = makeFetchStub();
    const d1 = d1WithInstructions(['0001_base.sql', '0002_assistant.sql']);
    const env = makeEnv(reg, d1.stub);
    expect(await prerouteMessage(env, parsedMsg('Більше не нагадуй про ideas'), NOW)).toBe(true);
    expect(brain).toHaveLength(0);
    const fact = d1.db
      .prepare(`SELECT value_json FROM facts WHERE kind = 'setting' AND key = 'hint_mute_json'`)
      .get() as { value_json: string };
    expect(JSON.parse(fact.value_json)).toEqual({ topics: ['ideas'] });
    const msg = tg.find((c) => String(c.body.text).includes('Вимкнув підказки про ideas'));
    expect(msg).toBeDefined();
    expect(JSON.stringify(msg?.body.reply_markup)).toContain('"u:');
    // Невідома тема - звичайне повідомлення в мозок.
    expect(await prerouteMessage(env, parsedMsg('не нагадуй про погоду'), NOW + 1)).toBe(true);
    expect(brain).toHaveLength(1);
  });

  // S-P-9/S-P-10 (етап 3 PR-8): ланцюг плану чекає слова власника в темі
  // «Асистент» - текст іде подією у Workflow, не в мозок; в іншій темі - як
  // завжди, у мозок.
  it('ланцюг плану awaiting=intent: текст у темі «Асистент» → подія intent {text}, мозок не кликано; інша тема → мозок', async () => {
    const reg = makeRegistryStub();
    const { brain } = makeFetchStub();
    const d1 = d1WithInstructions(['0001_base.sql', '0002_assistant.sql']);
    const events: { id: string; ev: unknown }[] = [];
    const env = makeEnv(reg, d1.stub);
    (env as { DAY_PLAN?: unknown }).DAY_PLAN = {
      create: async () => undefined,
      get: async (id: string) => ({
        sendEvent: async (ev: unknown) => void events.push({ id, ev }),
      }),
    };
    d1.db
      .prepare(
        `INSERT INTO chains (id, kind, workflow_id, state_json, status, created_at, updated_at)
         VALUES ('ch-1', 'day-plan', 'ch-1', '{"date":"2026-09-07","awaiting":"intent"}', 'waiting', '2026-09-06T17:30:00Z', '2026-09-06T17:30:00Z')`,
      )
      .run();
    expect(await prerouteMessage(env, parsedMsg('презентація і банк', { threadId: 99 }), NOW)).toBe(
      true,
    );
    expect(events).toEqual([
      { id: 'ch-1', ev: { type: 'intent', payload: { text: 'презентація і банк' } } },
    ]);
    expect(brain).toHaveLength(0);
    // Той самий текст у DM (не тема «Асистент») - звичайний прогін.
    expect(await prerouteMessage(env, parsedMsg('презентація і банк'), NOW + 1)).toBe(true);
    expect(brain).toHaveLength(1);
    expect(events).toHaveLength(1);
    // Ланцюг уже не чекає слова - текст у темі теж іде в мозок.
    d1.db.prepare(`UPDATE chains SET state_json = '{"awaiting":"accept"}'`).run();
    expect(await prerouteMessage(env, parsedMsg('ще текст', { threadId: 99 }), NOW + 2)).toBe(true);
    expect(events).toHaveLength(1);
  });

  // S-0-5 (етап 3 PR-5): /forget → кнопки колекцій → тап m:fg → пропозиція T2
  // зі словом → слово текстом → «Стерто: …».
  it('/forget з колекцією: меню → m:fg → слово → колекцію стерто (S-0-5, S-N4-5)', async () => {
    const reg = makeRegistryStub();
    const { tg, brain } = makeFetchStub();
    const d1 = d1WithInstructions([
      '0001_base.sql',
      '0002_assistant.sql',
      '0006_inbox_collections.sql',
      '0008_fts.sql',
    ]);
    d1.db
      .prepare(
        `INSERT INTO collections (id, name, fields_json, created_at) VALUES ('col-1', 'Сервіси', '[{"name":"назва","type":"text"}]', '2026-08-27T00:00:00Z')`,
      )
      .run();
    const env = makeEnv(reg, d1.stub);
    await prerouteMessage(env, parsedMsg('/forget'), NOW);
    const menu = tg.find((c) => String(c.body.text).includes('Що забути'));
    const keyboard = (menu?.body.reply_markup as { inline_keyboard: { callback_data: string }[][] })
      .inline_keyboard;
    expect(keyboard[0]?.[0]?.callback_data).toBe('m:fg:col-1');

    const toast = await handleBrainCallback(
      env,
      { data: 'm:fg:col-1', chatId: 555, messageId: 42, threadId: null },
      NOW,
    );
    expect(toast).toBe('Чекаю слово');
    const ask = tg.find((c) => String(c.body.text).includes('напиши слово'));
    const word = /слово: ([А-ЯІЇЄҐ-]+)/u.exec(String(ask?.body.text))?.[1];
    expect(word).toBeTruthy();

    // Чуже слово - звичайне повідомлення (їде в мозок), не рішення.
    expect(await prerouteMessage(env, parsedMsg('ПРИВІТ'), NOW + 1)).toBe(true);
    expect(d1.db.prepare(`SELECT COUNT(*) AS n FROM collections`).get()).toEqual({ n: 1 });
    // Слово - рішення: колекцію стерто, у чат «Стерто: …», мозок не кликано.
    const brainBefore = brain.length;
    expect(await prerouteMessage(env, parsedMsg(String(word).toLowerCase()), NOW + 2)).toBe(true);
    expect(brain).toHaveLength(brainBefore);
    expect(tg.some((c) => String(c.body.text).includes('Стерто: колекція «Сервіси»'))).toBe(true);
    expect(d1.db.prepare(`SELECT COUNT(*) AS n FROM collections`).get()).toEqual({ n: 0 });
  });
});

describe('«стоп» (S-0-3)', () => {
  it('активний прогін: /abort мозку, finish stopped, статусник «Зупинив.», черга очищена', async () => {
    const reg = makeRegistryStub();
    const { tg, brain } = makeFetchStub();
    const env = makeEnv(reg, d1WithInstructions(['0001_base.sql', '0002_assistant.sql']).stub);
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
    const env = makeEnv(reg, d1WithInstructions(['0001_base.sql', '0002_assistant.sql']).stub);
    await prerouteMessage(env, parsedMsg('Стоп!'), NOW);
    expect(tg.some((c) => String(c.body.text).includes('Нема чого'))).toBe(true);
  });
});

describe('S-0-7: мозок недоступний', () => {
  it('невдалий старт: retry у чергу (attempts+1) + статус «спробую ще раз», finish з brain-start', async () => {
    const reg = makeRegistryStub();
    const { tg } = makeFetchStub(502);
    const env = makeEnv(reg, d1WithInstructions(['0001_base.sql', '0002_assistant.sql']).stub);
    await prerouteMessage(env, parsedMsg('питання про мої справи'), NOW);
    expect(reg.retries).toHaveLength(1);
    expect(reg.retries[0]!.entry).toMatchObject({ attempts: 1, statusMessageId: 101 });
    expect(reg.finishes[0]!.patch.error).toBe('brain-start: 502');
    expect(tg.some((c) => String(c.body.text).includes('спробую ще раз'))).toBe(true);
  });

  it('третя невдача - «Не вдалося…», без retry', async () => {
    const reg = makeRegistryStub();
    const { tg } = makeFetchStub(502);
    const env = makeEnv(reg, d1WithInstructions(['0001_base.sql', '0002_assistant.sql']).stub);
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
    const env = makeEnv(reg, d1WithInstructions(['0001_base.sql', '0002_assistant.sql']).stub);
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
    const env = makeEnv(reg, d1WithInstructions(['0001_base.sql', '0002_assistant.sql']).stub);
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
    const env = makeEnv(reg, d1WithInstructions(['0001_base.sql', '0002_assistant.sql']).stub);
    await prerouteMessage(env, parsedMsg('питання про мої плани'), NOW);
    expect(reg.finishes).toHaveLength(0);
    expect(reg.retries).toHaveLength(0);
    expect(reg.threads.get('dm')?.activeRunId).not.toBeNull();
    expect(tgLog.some((c) => String(c.body.text).includes('повільний'))).toBe(true);
  });
});

describe('handleBrainCallback (p:/u: - борг PR-8; реальна policy на міграціях)', () => {
  const cbEnv = () => {
    const d1 = d1WithInstructions(['0001_base.sql', '0002_assistant.sql']);
    const { tg } = makeFetchStub();
    const env = makeEnv(makeRegistryStub(), d1.stub);
    return { env, db: d1.db, tg };
  };
  const seedProposal = (
    db: InstanceType<typeof import('node:sqlite').DatabaseSync>,
    over: Record<string, unknown> = {},
  ) => {
    const row = {
      id: 'prop1',
      level: 'T1',
      kind: 'facts.set',
      payload_json: JSON.stringify({ kind: 'setting', key: 'k', value: 1 }),
      thread_id: 'dm',
      word: null,
      expires_at: new Date(NOW + 60_000).toISOString(),
      status: 'open',
      created_at: new Date(NOW).toISOString(),
      ...over,
    };
    db.prepare(
      `INSERT INTO proposals (id, level, kind, payload_json, thread_id, word, expires_at, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      ...[
        row.id,
        row.level,
        row.kind,
        row.payload_json,
        row.thread_id,
        row.word,
        row.expires_at,
        row.status,
        row.created_at,
      ],
    );
  };

  it('p:ok виконує пропозицію (facts.set у D1), тост «Підтверджено ✅», клавіатура знята', async () => {
    const { env, db, tg } = cbEnv();
    seedProposal(db);
    const toast = await handleBrainCallback(
      env,
      { data: 'p:prop1:ok', chatId: 555, messageId: 42 },
      NOW,
    );
    expect(toast).toBe('Підтверджено ✅');
    const fact = db.prepare(`SELECT * FROM facts WHERE key='k'`).get() as Record<string, unknown>;
    expect(fact).toBeDefined();
    expect(tg.some((c) => c.method === 'editMessageReplyMarkup')).toBe(true);
  });

  it('p:no - «Відхилено.»; повторний тап - «Вже вирішено»; прострочена - «Прострочено»', async () => {
    const { env, db } = cbEnv();
    seedProposal(db);
    expect(await handleBrainCallback(env, { data: 'p:prop1:no', chatId: 555 }, NOW)).toBe(
      'Відхилено.',
    );
    expect(
      String(await handleBrainCallback(env, { data: 'p:prop1:ok', chatId: 555 }, NOW)),
    ).toContain('Вже вирішено');
    seedProposal(db, { id: 'prop2', expires_at: new Date(NOW - 1000).toISOString() });
    expect(
      String(await handleBrainCallback(env, { data: 'p:prop2:ok', chatId: 555 }, NOW)),
    ).toContain('Прострочено');
  });

  it('T2 без слова - чесний тост про слово; невідомий id - «Не вийшло»', async () => {
    const { env, db } = cbEnv();
    seedProposal(db, { id: 'prop3', level: 'T2', word: 'ЗАБУТИ' });
    expect(
      String(await handleBrainCallback(env, { data: 'p:prop3:ok', chatId: 555 }, NOW)),
    ).toContain('слово');
    expect(
      String(await handleBrainCallback(env, { data: 'p:nope:ok', chatId: 555 }, NOW)),
    ).toContain('Не вийшло');
  });

  // Етап 3 PR-8: c:<chainId>:<choice> - кнопки ланцюга плану → подія у Workflow.
  it('c:<id>:<choice> → sendEvent за мапою choice→type, клавіатура знята; збій Workflow - чесний тост', async () => {
    const { env, tg } = cbEnv();
    const events: { id: string; ev: unknown }[] = [];
    (env as { DAY_PLAN?: unknown }).DAY_PLAN = {
      create: async () => undefined,
      get: async (id: string) => ({
        sendEvent: async (ev: unknown) => {
          if (id === 'dead') throw new Error('instance not found');
          events.push({ id, ev });
        },
      }),
    };
    const tap = (data: string) =>
      handleBrainCallback(env, { data, chatId: 555, messageId: 7, threadId: 99 }, NOW);
    expect(await tap('c:ch-1:accept')).toBe('Прийняв.');
    expect(await tap('c:ch-1:a1_0')).toBe('Прийняв.');
    expect(await tap('c:ch-1:carry_none')).toBe('Прийняв.');
    expect(await tap('c:ch-1:skip')).toBe('Прийняв.');
    expect(events.map((e) => e.ev)).toEqual([
      { type: 'accept', payload: { choice: 'accept' } },
      { type: 'answer', payload: { item: 1, option: 0 } },
      { type: 'carry', payload: { choice: 'carry_none' } },
      { type: 'intent', payload: { choice: 'skip' } },
    ]);
    expect(tg.filter((c) => c.method === 'editMessageReplyMarkup')).toHaveLength(4);
    expect(await tap('c:dead:accept')).toContain('не відповідає');
    expect(await tap('c:ch-1:go')).toBe('Невідома кнопка плану.');
    expect(events).toHaveLength(4);

    expect(dayPlanChoiceEvent('none')).toEqual({ type: 'intent', payload: { choice: 'none' } });
    expect(dayPlanChoiceEvent('edit')).toEqual({ type: 'accept', payload: { choice: 'edit' } });
    expect(dayPlanChoiceEvent('calendar')).toEqual({
      type: 'accept',
      payload: { choice: 'calendar' },
    });
    expect(dayPlanChoiceEvent('carry_all')).toEqual({
      type: 'carry',
      payload: { choice: 'carry_all' },
    });
    expect(dayPlanChoiceEvent('a0_3')).toEqual({ type: 'answer', payload: { item: 0, option: 3 } });
    expect(dayPlanChoiceEvent('ok')).toBeNull();
  });

  it('заглушки r:/a:/m: чесні; невідома кнопка c: - чесна відмова; чужі префікси (rc:, v1:) і off-режим - null (легасі)', async () => {
    const { env } = cbEnv();
    expect(String(await handleBrainCallback(env, { data: 'c:x:go', chatId: 555 }, NOW))).toContain(
      'Невідома кнопка плану',
    );
    // c: не за форматом (без choice) - та сама чесна відмова, не легасі «Застаріла кнопка».
    expect(await handleBrainCallback(env, { data: 'c:bad', chatId: 555 }, NOW)).toBe(
      'Невідома кнопка плану.',
    );
    expect(await handleBrainCallback(env, { data: 'rc:123', chatId: 555 }, NOW)).toBeNull();
    expect(
      await handleBrainCallback(env, { data: 'v1:2026-08-27:up', chatId: 555 }, NOW),
    ).toBeNull();
    const offEnv = makeEnv(makeRegistryStub(), d1FromSqlite(['0001_base.sql']).stub, 'off');
    expect(await handleBrainCallback(offEnv, { data: 'p:prop1:ok', chatId: 555 }, NOW)).toBeNull();
  });
});
