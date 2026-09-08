// Імпорт експорту чату, ранковий дайджест, «забудь чат» (T2) і ретенція
// (етап 6 PR-4, S-2-5…S-2-9, 07 §1 «Ретенція», 07 §6 InboxExport).

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseExport,
  flattenText,
  runInboxExport,
  tooBig,
  FILE_MAX_BYTES,
  IMPORT_MAX,
  MESSAGES_PER_STEP,
  HINT_WRONG_FORMAT,
} from '../web/core/chains/inbox-export.mjs';
import {
  digestTime,
  inboxDigestTask,
  saveInboxDigest,
  DIGEST_MARKER_KEY,
  DIGEST_SETTING_KEY,
  NOTHING_RE,
} from '../web/core/inbox/digest.mjs';
import {
  retentionCleanupTask,
  applyRule,
  RETENTION,
  CLEANUP_MARKER_KEY,
} from '../web/core/retention/cleanup.mjs';
import { saveInboxMessage, saveInboxBatch, listInboxChats } from '../web/core/inbox/store.mjs';
import { handleBusinessConnection } from '../web/core/inbox/connection.mjs';
import { applyPolicy, resolveProposal } from '../web/core/policy/proposals.mjs';
import { runFactsSet } from '../web/core/tools/facts.mjs';
import { parseUpdate } from '../web/tg-core.mjs';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';
import { d1FromSqlite } from './helpers/d1.js';

const MIGRATIONS = [
  '0001_base.sql',
  '0002_assistant.sql',
  '0003_telemetry.sql',
  '0004_ideas_travel.sql',
  '0005_finance.sql',
  '0006_inbox_collections.sql',
  '0007_instructions_plans.sql',
  '0008_fts.sql',
  '0009_voice.sql',
];

const CONN = 'conn-abc';
const OWNER = '42';
/** Понеділок 07.09.2026, 12:00 Києва. */
const NOON = Date.parse('2026-09-07T09:00:00.000Z');
/** Того ж дня 08:35 Києва - вікно дайджесту. */
const MORNING = Date.parse('2026-09-07T05:35:00.000Z');
/** Того ж дня 04:10 Києва - вікно ретенції. */
const NIGHT = Date.parse('2026-09-07T01:10:00.000Z');

function setup(kv: Record<string, string> = {}) {
  const d1 = d1FromSqlite(MIGRATIONS);
  const env = workerEnv({
    DB: d1.stub,
    BRIEFING: memoryKv(new Map(Object.entries(kv))),
    ASSISTANT_V2: 'on',
    TELEGRAM_CHAT_ID: '555',
    TOPIC_ASSISTANT: '99',
    TOPIC_SYSTEM: '77',
    TELEGRAM_OWNER_USER_ID: OWNER,
  });
  return { d1, db: d1.db, env };
}

function exportFile(over: Record<string, unknown> = {}) {
  return {
    name: 'Робота',
    type: 'private_supergroup',
    id: 1234,
    messages: [
      {
        id: 1,
        type: 'message',
        date: '2024-05-01T12:00:00',
        date_unixtime: String(Math.floor(Date.parse('2024-05-01T12:00:00Z') / 1000)),
        from: 'Оля',
        from_id: 'user777',
        text: 'домовились на четвер',
      },
      {
        // Службове повідомлення з ТЕКСТОМ: інакше воно й так відсіялось би за
        // порожнім вмістом, і фільтр за type лишався б неперевіреним.
        id: 2,
        type: 'service',
        date_unixtime: '1714560000',
        action: 'edit_group_title',
        from: 'Оля',
        text: 'змінила назву групи',
      },
      {
        id: 3,
        type: 'message',
        date_unixtime: String(Math.floor(Date.parse('2026-01-10T09:00:00Z') / 1000)),
        from: 'Іван',
        text: ['ось ', { type: 'link', text: 'посилання' }, ' на файл'],
      },
    ],
    ...over,
  };
}

function fakeIo(overrides: Partial<Record<string, unknown>> = {}) {
  const sent: string[] = [];
  const saved: unknown[] = [];
  return {
    sent,
    saved,
    io: {
      now: () => NOON,
      download: async () => exportFile(),
      saveMany: async (msgs: unknown[]) => {
        saved.push(...msgs);
        return { inserted: msgs.length, present: 0 };
      },
      send: async (text: string) => {
        sent.push(text);
      },
      ...overrides,
    },
  };
}

const step = { do: async (_name: string, fn: () => Promise<unknown>) => fn() };

function outboxTexts(db: ReturnType<typeof setup>['db']) {
  return (
    db.prepare('SELECT payload_json FROM outbox ORDER BY rowid').all() as { payload_json: string }[]
  ).map((r) => JSON.parse(r.payload_json) as { text: string });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('розбір експорту Telegram Desktop (S-2-6, S-2-7)', () => {
  it('службові повідомлення пропускаються, масив text зводиться в рядок', () => {
    const parsed = parseExport(exportFile());
    expect(parsed).not.toBeNull();
    expect(parsed!.title).toBe('Робота');
    expect(parsed!.messages).toHaveLength(2);
    expect(parsed!.messages[1]!.text).toBe('ось посилання на файл');
    expect(parsed!.messages.map((m) => m.text)).not.toContain('змінила назву групи');
    expect(parsed!.messages[0]).toMatchObject({ fromName: 'Оля', messageId: 1 });
  });

  it('id групи вирівнюється під Bot API (-100…), приватний чат лишається як є', () => {
    expect(parseExport(exportFile())!.chatId).toBe('-1001234');
    expect(parseExport(exportFile({ type: 'personal_chat' }))!.chatId).toBe('1234');
    // Приватний чат уже з мінусом не отримує другого префікса.
    expect(parseExport(exportFile({ id: -1001234, type: 'private_supergroup' }))!.chatId).toBe(
      '-1001234',
    );
  });

  it('не той формат - null (а машина станів скаже це словами)', () => {
    expect(parseExport(null)).toBeNull();
    expect(parseExport({ messages: 'ні' })).toBeNull();
    expect(parseExport({ name: 'X', messages: [] })).toBeNull();
    // Є messages, але всі без id або без дати - теж не імпорт.
    expect(
      parseExport({ name: 'X', id: 1, messages: [{ type: 'message', text: 'без id' }] }),
    ).toBeNull();
  });

  it('flattenText: рядок, масив, сміття', () => {
    expect(flattenText('текст')).toBe('текст');
    expect(flattenText(['а', { text: 'б' }, { type: 'x' }])).toBe('аб');
    expect(flattenText(null)).toBe('');
  });
});

describe('машина станів InboxExport', () => {
  it('імпорт: рядки збережено, підсумок із роками і питанням «Що шукати?»', async () => {
    const { env, db } = setup();
    db.prepare(
      `INSERT INTO chains (id, kind, state_json, status, created_at, updated_at)
       VALUES ('c1', 'inbox-export', '{}', 'running', '2026-09-07T00:00:00Z', '2026-09-07T00:00:00Z')`,
    ).run();
    const { io, sent, saved } = fakeIo();
    const out = await runInboxExport(env, { chainId: 'c1', fileId: 'f1' }, step, io as never);
    expect(out).toMatchObject({ ok: true, imported: 2, chatId: '-1001234' });
    expect(saved).toHaveLength(2);
    expect(sent[0]).toBe('Завантажив 2 повідомлення чату «Робота» за 2024-2026. Що шукати?');
    expect(db.prepare("SELECT status FROM chains WHERE id = 'c1'").get()).toMatchObject({
      status: 'done',
    });
  });

  it('чужий формат - рівно текст S-2-7 і статус failed', async () => {
    const { env, db } = setup();
    db.prepare(
      `INSERT INTO chains (id, kind, state_json, status, created_at, updated_at)
       VALUES ('c1', 'inbox-export', '{}', 'running', '2026-09-07T00:00:00Z', '2026-09-07T00:00:00Z')`,
    ).run();
    const { io, sent } = fakeIo({ download: async () => ({ hello: 'world' }) });
    const out = await runInboxExport(env, { chainId: 'c1', fileId: 'f1' }, step, io as never);
    expect(out).toMatchObject({ ok: false, reason: 'bad-format' });
    expect(sent[0]).toBe(HINT_WRONG_FORMAT);
    expect(db.prepare("SELECT status FROM chains WHERE id = 'c1'").get()).toMatchObject({
      status: 'failed',
    });
  });

  it('понад стелю - імпортуємо перші й КАЖЕМО, скільки не взяли', async () => {
    const { env, db } = setup();
    db.prepare(
      `INSERT INTO chains (id, kind, state_json, status, created_at, updated_at)
       VALUES ('c1', 'inbox-export', '{}', 'running', '2026-09-07T00:00:00Z', '2026-09-07T00:00:00Z')`,
    ).run();
    const many = {
      name: 'Великий',
      id: 5,
      type: 'personal_chat',
      messages: Array.from({ length: IMPORT_MAX + 3 }, (_, i) => ({
        id: i + 1,
        type: 'message',
        date_unixtime: String(Math.floor(NOON / 1000) - i),
        from: 'Хтось',
        text: `рядок ${i}`,
      })),
    };
    const { io, sent, saved } = fakeIo({ download: async () => many });
    const out = await runInboxExport(env, { chainId: 'c1', fileId: 'f1' }, step, io as never);
    expect(out).toMatchObject({ imported: IMPORT_MAX, skipped: 3 });
    expect(saved).toHaveLength(IMPORT_MAX);
    expect(sent[0]).toContain('решту (3) не брав');
  });

  it('через межу кроку їде лише ПІДСУМОК, а крок влазить у бюджет Free', async () => {
    const { env, db } = setup();
    db.prepare(
      `INSERT INTO chains (id, kind, state_json, status, created_at, updated_at)
       VALUES ('c1', 'inbox-export', '{}', 'running', '2026-09-07T00:00:00Z', '2026-09-07T00:00:00Z')`,
    ).run();
    // Дві платформні межі Workers Free одночасно: стан кроку 1 МіБ і 50
    // підзапитів на виклик. Пінимо обидві - розмір того, що крок ПОВЕРТАЄ, і
    // кількість зовнішніх дій усередині одного кроку.
    const returned: unknown[] = [];
    let calls = 0;
    const perStep: number[] = [];
    const sizedStep = {
      do: async (_name: string, fn: () => Promise<unknown>) => {
        calls = 0;
        const out = await fn();
        perStep.push(calls);
        returned.push(out);
        return out;
      },
    };
    const big = {
      name: 'Великий',
      id: 5,
      type: 'personal_chat',
      messages: Array.from({ length: 1200 }, (_, i) => ({
        id: i + 1,
        type: 'message',
        date_unixtime: String(Math.floor(NOON / 1000) - i),
        from: 'Хтось',
        text: `рядок ${i} ${'х'.repeat(80)}`,
      })),
    };
    const { io } = fakeIo({
      download: async () => {
        calls += 2; // getFile + сам файл
        return big;
      },
      saveMany: async (msgs: unknown[]) => {
        calls += Math.ceil(msgs.length / 50) * 2; // SELECT «що вже є» + batch
        return { inserted: msgs.length, present: 0 };
      },
    });
    await runInboxExport(env, { chainId: 'c1', fileId: 'f1' }, sizedStep, io as never);
    expect(returned).not.toHaveLength(0);
    for (const value of returned) {
      expect(JSON.stringify(value ?? null).length).toBeLessThan(1000);
    }
    expect(Math.max(...perStep)).toBeLessThan(50);
    // 1 200 повідомлень - три кроки імпорту по MESSAGES_PER_STEP.
    expect(Math.ceil(1200 / MESSAGES_PER_STEP)).toBe(3);
  });

  it('повтор кроку не бреше числом: показуємо, скільки ТЕПЕР у базі', async () => {
    const { env, db } = setup();
    db.prepare(
      `INSERT INTO chains (id, kind, state_json, status, created_at, updated_at)
       VALUES ('c1', 'inbox-export', '{}', 'running', '2026-09-07T00:00:00Z', '2026-09-07T00:00:00Z')`,
    ).run();
    // Справжній io поверх D1: перший прогін вставляє, другий - бачить дублі.
    const sent: string[] = [];
    const realIo = {
      now: () => NOON,
      download: async () => exportFile(),
      saveMany: (msgs: never[]) => saveInboxBatch(env, msgs, NOON),
      send: async (text: string) => {
        sent.push(text);
      },
    };
    await runInboxExport(env, { chainId: 'c1', fileId: 'f1' }, step, realIo as never);
    expect(sent[0]).toContain('Завантажив 2 повідомлення');
    expect(db.prepare('SELECT COUNT(*) AS n FROM inbox_messages').get()).toMatchObject({ n: 2 });
    // Повтор ланцюга (крок Workflow міг упасти й піти на другий раунд).
    await runInboxExport(env, { chainId: 'c1', fileId: 'f1' }, step, realIo as never);
    expect(sent[1]).toContain('Завантажив 2 повідомлення');
    expect(db.prepare('SELECT COUNT(*) AS n FROM inbox_messages').get()).toMatchObject({ n: 2 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM inbox_fts').get()).toMatchObject({ n: 2 });
  });

  it('пачкова вставка: два звернення до D1 на 50 рядків, а не два на рядок', async () => {
    const { d1 } = setup();
    // На Workers Free - 50 підзапитів на виклик, тож поштучний запис (INSERT +
    // реіндекс FTS на кожне повідомлення) не проліз би в крок узагалі.
    let roundTrips = 0;
    // Стаб емулює `batch`, викликаючи кожне твердження окремо, - тож рахуємо
    // лише ЗОВНІШНІ звернення, інакше вийшло б число тверджень, а не round-trip.
    let inBatch = false;
    const inner = d1.stub.prepare;
    const env = workerEnv({
      DB: {
        prepare: (sql: string) => {
          const st = inner(sql);
          return {
            bind: (...args: unknown[]) => {
              const bound = st.bind(...args);
              return {
                run: async () => {
                  if (!inBatch) roundTrips += 1;
                  return bound.run();
                },
                all: async () => {
                  if (!inBatch) roundTrips += 1;
                  return bound.all();
                },
                first: async () => bound.first(),
                // batch спільного стаба кличе саме once() - без нього обгортка
                // ламає пачкову вставку (яку цей тест і міряє).
                once: async () => bound.once(),
              };
            },
          };
        },
        batch: async (statements: { all: () => Promise<unknown> }[]) => {
          roundTrips += 1;
          inBatch = true;
          try {
            return await d1.stub.batch(statements as never);
          } finally {
            inBatch = false;
          }
        },
      },
      BRIEFING: memoryKv(new Map()),
    });
    const msgs = Array.from({ length: 100 }, (_, i) => ({
      chatId: -100,
      chatTitle: 'Робота',
      fromId: 1,
      fromName: 'Хтось',
      messageId: i + 1,
      dateS: Math.floor(NOON / 1000),
      text: `рядок ${i}`,
      mediaKind: null,
      replyTo: null,
    }));
    const out = await saveInboxBatch(env, msgs as never, NOON);
    expect(out).toMatchObject({ inserted: 100, present: 0 });
    // Дві пачки по 50: SELECT «що вже є» + batch на кожну.
    expect(roundTrips).toBe(4);
  });

  it('файл понад стелю - причина і що робити, ще до завантаження', () => {
    expect(tooBig(FILE_MAX_BYTES + 1)).toContain('експортуй коротший період');
    expect(tooBig(3 * 1024 * 1024)).toContain('3072 КБ');
  });

  it('імпорт НЕ витрачає добову стелю вхідних', async () => {
    const { env, db } = setup();
    const res = await saveInboxMessage(
      env,
      {
        chatId: -100,
        chatTitle: 'Робота',
        fromId: 1,
        fromName: 'Хтось',
        messageId: 1,
        dateS: Math.floor(NOON / 1000),
        text: 'текст',
        mediaKind: null,
        replyTo: null,
        viaImport: true,
      },
      NOON,
    );
    expect(res).toMatchObject({ saved: true });
    // Лічильник доби не зрушив: імпорт - свідома дія власника.
    expect(await env.BRIEFING.get('inboxDayCount')).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM inbox_messages').get()).toMatchObject({ n: 1 });
  });

  it('документ .json від власника запускає ланцюг, інші файли - ні', () => {
    const doc = (fileName: string, mime = 'application/json') =>
      parseUpdate({
        message: {
          message_id: 1,
          chat: { id: 555 },
          from: { id: 42 },
          document: { file_id: 'f1', file_name: fileName, mime_type: mime, file_size: 1000 },
        },
      });
    expect(doc('result.json')).toMatchObject({
      document: { fileId: 'f1', fileName: 'result.json', mimeType: 'application/json' },
    });
    expect(
      parseUpdate({ message: { message_id: 1, chat: { id: 555 }, text: 'привіт' } }),
    ).toMatchObject({ document: null });
  });
});

describe('ранковий дайджест (S-2-5)', () => {
  async function enable(env: Env, value: unknown = '08:30') {
    await runFactsSet(
      env,
      { kind: 'setting', key: DIGEST_SETTING_KEY, value, source: 'owner' },
      NOON,
    );
    await handleBusinessConnection(
      env,
      parseUpdate({
        business_connection: { id: CONN, user: { id: Number(OWNER) }, is_enabled: true },
      }) as never,
      NOON,
    );
  }

  it('час із факту: «08:30», «on», порожньо', () => {
    expect(digestTime('08:30')).toEqual({ hour: 8, minute: 30 });
    expect(digestTime('on')).toEqual({ hour: 8, minute: 30 });
    expect(digestTime({ time: '07:00' })).toEqual({ hour: 7, minute: 0 });
    expect(digestTime('')).toBeNull();
    expect(digestTime('off')).toBeNull();
    expect(digestTime('25:00')).toBeNull();
  });

  it('вимкнений - мовчить; увімкнений без нових повідомлень - теж (S-2-5)', async () => {
    const { env } = setup();
    expect(await inboxDigestTask(env, MORNING)).toEqual({ skipped: 'off' });
    await enable(env);
    expect(await inboxDigestTask(env, NOON)).toEqual({ skipped: 'window' });
    expect(await inboxDigestTask(env, MORNING)).toMatchObject({
      sent: false,
      reason: 'no-messages',
    });
    expect(await env.BRIEFING.get(DIGEST_MARKER_KEY)).toBe('2026-09-07');
  });

  it('увімкнено без підключення - гучний пропуск, а не щоденна тиша', async () => {
    const { env } = setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await runFactsSet(
      env,
      { kind: 'setting', key: DIGEST_SETTING_KEY, value: '08:30', source: 'owner' },
      NOON,
    );
    expect(await inboxDigestTask(env, MORNING)).toEqual({ skipped: 'not-connected' });
  });

  it('«нічого важливого» у базу не пишеться; звичайний текст - пишеться', async () => {
    const { env, db } = setup();
    await saveInboxMessage(
      env,
      {
        chatId: -100,
        chatTitle: 'Робота',
        fromId: 1,
        fromName: 'Хтось',
        messageId: 1,
        dateS: Math.floor((NOON - 3600_000) / 1000),
        text: 'текст',
        mediaKind: null,
        replyTo: null,
      },
      NOON,
    );
    expect(NOTHING_RE.test('нічого важливого')).toBe(true);
    expect(await saveInboxDigest(env, 'нічого важливого.', NOON)).toBeNull();
    const saved = await saveInboxDigest(env, 'Робота · Іван: питає про документи', NOON);
    expect(saved).toMatchObject({ chats: 1 });
    const row = db.prepare('SELECT chat_ids_json, text_md FROM inbox_digests').get() as {
      chat_ids_json: string;
      text_md: string;
    };
    expect(JSON.parse(row.chat_ids_json)).toEqual(['-100']);
    expect(row.text_md).toContain('питає про документи');
  });
});

describe('«забудь чат» через policy (S-2-8, T2)', () => {
  it('T2 зі словом: після ✅ - скільки стерто', async () => {
    const { env, db } = setup();
    for (const id of [1, 2, 3]) {
      await saveInboxMessage(
        env,
        {
          chatId: -100,
          chatTitle: 'Робота',
          fromId: 1,
          fromName: 'Хтось',
          messageId: id,
          dateS: Math.floor(NOON / 1000),
          text: `рядок ${id}`,
          mediaKind: null,
          replyTo: null,
        },
        NOON,
      );
    }
    const out = await applyPolicy(
      env,
      {
        kind: 'forget',
        payload: { target: 'chat', chat: 'Робота' },
        threadId: '99',
        chatId: 555,
        tainted: false,
      },
      NOON,
    );
    if (out.mode !== 'proposed') throw new Error('очікувалась пропозиція T2');
    expect(out.proposal.word).toBeTruthy();
    const res = await resolveProposal(
      env,
      { id: out.proposal.id, choice: 'ok', word: out.proposal.word },
      NOON + 1000,
    );
    expect(res.ok).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM inbox_messages').get()).toMatchObject({ n: 0 });
  });

  it('меню /forget бачить чати', async () => {
    const { env } = setup();
    await saveInboxMessage(
      env,
      {
        chatId: -100,
        chatTitle: 'Робота',
        fromId: 1,
        fromName: 'Хтось',
        messageId: 1,
        dateS: Math.floor(NOON / 1000),
        text: 'текст',
        mediaKind: null,
        replyTo: null,
      },
      NOON,
    );
    expect(await listInboxChats(env)).toEqual([{ id: '-100', title: 'Робота', messages: 1 }]);
  });
});

describe('ретенція (07 §1)', () => {
  it('правила покривають кожну таблицю зі строком - і жодної «безстрокової»', () => {
    const tables = RETENTION.map((r) => r.table).sort();
    expect(tables).toEqual([
      'inbox_messages',
      'memory_chunks',
      'outbox',
      'price_points',
      'proposals',
      'quota_counters',
      'reminders',
      'runs',
      'transactions',
      'voice_pending',
    ]);
    // Дайджести, підписки, ідеї й колекції - «безстроково» (07 §1).
    expect(tables).not.toContain('inbox_digests');
    expect(tables).not.toContain('subscriptions');
    expect(tables).not.toContain('ideas');
  });

  it('вхідні старші 30 діб зникають разом з індексом, свіжі лишаються (S-2-9)', async () => {
    const { env, db } = setup();
    const add = (id: number, iso: string) =>
      db
        .prepare(
          `INSERT INTO inbox_messages (id, chat_id, chat_title, from_name, from_id, at, text, tainted)
           VALUES (?, '-100', 'Робота', 'Хтось', '1', ?, ?, 1)`,
        )
        .run(`-100:${id}`, iso, `рядок ${id}`);
    add(1, '2026-07-01T00:00:00.000Z');
    add(2, '2026-09-06T00:00:00.000Z');
    db.prepare(`INSERT INTO inbox_fts (id, text) VALUES ('-100:1', 'рядок 1')`).run();
    db.prepare(`INSERT INTO inbox_fts (id, text) VALUES ('-100:2', 'рядок 2')`).run();
    const rule = RETENTION.find((r) => r.table === 'inbox_messages')!;
    expect(await applyRule(env, rule, NOON)).toBe(1);
    expect(db.prepare('SELECT id FROM inbox_messages').all()).toEqual([{ id: '-100:2' }]);
    expect(db.prepare('SELECT id FROM inbox_fts').all()).toEqual([{ id: '-100:2' }]);
  });

  it('нагадування - лише виконані/скасовані; активне старе лишається', async () => {
    const { env, db } = setup();
    const add = (id: string, status: string, due: string) =>
      db
        .prepare(
          `INSERT INTO reminders (id, due_at, text, status, snooze_count) VALUES (?, ?, 'x', ?, 0)`,
        )
        .run(id, due, status);
    add('old-done', 'done', '2024-01-01T00:00:00.000Z');
    add('old-pending', 'pending', '2024-01-01T00:00:00.000Z');
    const rule = RETENTION.find((r) => r.table === 'reminders')!;
    expect(await applyRule(env, rule, NOON)).toBe(1);
    expect(db.prepare('SELECT id FROM reminders').all()).toEqual([{ id: 'old-pending' }]);
  });

  it('черга відправок - лише доставлене й провалене', async () => {
    const { env, db } = setup();
    const add = (id: string, status: string) =>
      db
        .prepare(
          `INSERT INTO outbox (id, chat_id, kind, payload_json, attempts, next_at, status)
           VALUES (?, '555', 'send', '{}', 0, '2024-01-01T00:00:00.000Z', ?)`,
        )
        .run(id, status);
    add('sent-1', 'sent');
    add('pending-1', 'pending');
    const rule = RETENTION.find((r) => r.table === 'outbox')!;
    expect(await applyRule(env, rule, NOON)).toBe(1);
    expect(db.prepare('SELECT id FROM outbox').all()).toEqual([{ id: 'pending-1' }]);
  });

  it('за одну добу проходів кілька: 2 000 рядків стелі не лишають хвоста', async () => {
    const { env, db } = setup();
    // Понад одну стелю прострочених: один прохід лишив би 500 на завтра, а
    // вхідних приходить до 5 000 на добу - черга росла б щодня.
    const insert = db.prepare(
      `INSERT INTO transactions (id, at, amount, currency, mcc, description, category, flags_json)
       VALUES (?, '2020-01-01T00:00:00.000Z', -100, 'UAH', 0, 'x', 'інше', '[]')`,
    );
    for (let i = 0; i < 2500; i += 1) insert.run(`old-${i}`);
    const out = await retentionCleanupTask(env, NIGHT);
    expect(out).toMatchObject({ removed: { transactions: 2500 } });
    expect(db.prepare('SELECT COUNT(*) AS n FROM transactions').get()).toMatchObject({ n: 0 });
  });

  it('задача: 04:00, раз на добу; збій однієї таблиці не зупиняє решту', async () => {
    const { env, db } = setup();
    db.prepare(
      `INSERT INTO transactions (id, at, amount, currency, mcc, description, category, flags_json)
       VALUES ('old', '2020-01-01T00:00:00.000Z', -100, 'UAH', 0, 'x', 'інше', '[]')`,
    ).run();
    expect(await retentionCleanupTask(env, NOON)).toEqual({ skipped: 'hour' });
    const out = await retentionCleanupTask(env, NIGHT);
    expect(out).toMatchObject({ removed: { transactions: 1 }, failed: [] });
    expect(db.prepare('SELECT COUNT(*) AS n FROM transactions').get()).toMatchObject({ n: 0 });
    expect(await env.BRIEFING.get(CLEANUP_MARKER_KEY)).toBe('2026-09-07');
    expect(await retentionCleanupTask(env, NIGHT + 60_000)).toEqual({ skipped: 'done' });
  });

  it('збита таблиця - алерт і решта все одно прибрана', async () => {
    const { env, db } = setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    db.prepare(
      `INSERT INTO transactions (id, at, amount, currency, mcc, description, category, flags_json)
       VALUES ('old', '2020-01-01T00:00:00.000Z', -100, 'UAH', 0, 'x', 'інше', '[]')`,
    ).run();
    db.exec('DROP TABLE voice_pending');
    const out = await retentionCleanupTask(env, NIGHT);
    expect(out).toMatchObject({ removed: { transactions: 1 }, failed: ['voice_pending'] });
    expect(outboxTexts(db).some((m) => m.text.includes('Ретенція не пройшла'))).toBe(true);
  });
});
