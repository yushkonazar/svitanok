// Працівники з боку ядра (етап 4 PR-3, S-7-1…S-7-3): POST /internal/instruction
// (інструкція працівника з D1 з хешем; немає - 404 + алерт; персона - 400),
// POST /internal/taint (позначка треду, fail-closed 503), deliver з результатом
// працівника (reports + кнопки; довгий - файл одразу без кнопки .md), кнопки
// m:w: у prerouter (файл із бази; «Коротше»/«Інший тон» - підказка в тред).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { signedInternalHeaders } from '../web/core/internal/auth.mjs';
import { handleInternal } from '../web/core/internal/router.mjs';
import {
  INSTRUCTION_SCHEMA,
  TAINT_SCHEMA,
  DELIVER_SCHEMA,
  validateAgainst,
} from '../web/core/internal/schemas.mjs';
import { handleBrainCallback } from '../web/core/prerouter.mjs';
import {
  WORKER_CHAT_MAX,
  WORKER_FOLLOWUPS,
  workerButtons,
  workerFilename,
  saveWorkerResult,
  loadWorkerResult,
} from '../web/core/brain/worker-results.mjs';
import { isTaintActive } from '../web/core/policy/core.mjs';
import { workerEnv } from './helpers/env.js';
import { d1WithInstructions, syncInstructionHash } from './helpers/instructions.js';

const KEY = 'workers-test-key';
const NOW = Date.parse('2026-09-06T12:00:00.000Z');
const EDITOR_BODY = '# Редактор\nВиправ і скороти.';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

function stubTelegram() {
  const tg: { method: string; form: FormData | Record<string, unknown> }[] = [];
  const brain: { path: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('api.telegram.org')) {
        const method = u.split('/').pop() ?? '';
        const form =
          init?.body instanceof FormData
            ? init.body
            : (JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        tg.push({ method, form });
        return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }), {
          status: 200,
        });
      }
      if (u.includes('brain.example')) {
        brain.push({ path: new URL(u).pathname, body: JSON.parse(String(init?.body ?? '{}')) });
        return new Response(JSON.stringify({ ok: true }), { status: 202 });
      }
      if (u.includes('googleapis.com')) return new Response('{}', { status: 500 });
      throw new Error(`несподіваний fetch: ${u}`);
    }),
  );
  return { tg, brain };
}

function setup(over: Partial<Env> = {}) {
  const d1 = d1WithInstructions(['0001_base.sql', '0002_assistant.sql', '0003_telemetry.sql']);
  d1.db
    .prepare(
      `INSERT INTO instructions (name, kind, version_hash, body_md, max_chars, deployed_at)
       VALUES ('editor', 'agent', ?, ?, 6000, '2026-09-01T00:00:00Z')`,
    )
    .run(syncInstructionHash(EDITOR_BODY), EDITOR_BODY);
  const threads = new Map<string, { activeRunId: string | null; queue: unknown[] }>();
  const runs = new Map<string, { threadId: string | number | null; chatId: number | null }>([
    ['r1', { threadId: 99, chatId: 555 }],
    ['r-dm', { threadId: 'dm', chatId: 777 }],
    ['r-none', { threadId: null, chatId: null }],
  ]);
  const registry = {
    has: async (id: string) => runs.has(id),
    consumeNonce: async () => true,
    runInfo: async (id: string) => {
      const r = runs.get(id);
      return r ? { ...r, statusMessageId: null } : null;
    },
    begin: async () => undefined,
    finish: async () => null,
    threadClaim: async (threadId: string) => {
      const t = threads.get(threadId) ?? { activeRunId: null, queue: [] };
      if (t.activeRunId != null) {
        t.queue.push({});
        return { queued: t.queue.length };
      }
      t.activeRunId = 'pending';
      threads.set(threadId, t);
      return { start: true };
    },
    threadSetRun: async () => ({ claimed: true }),
    threadFinish: async () => ({ next: null }),
  };
  const env = workerEnv({
    ASSISTANT_V2: 'on',
    INTERNAL_HMAC_KEY: KEY,
    DB: d1.stub,
    TELEGRAM_BOT_TOKEN: 'bot',
    TELEGRAM_CHAT_ID: '555',
    TELEGRAM_OWNER_USER_ID: '777',
    TOPIC_ASSISTANT: '99',
    TOPIC_SYSTEM: '77',
    BRAIN_URL: 'https://brain.example',
    RUN_REGISTRY: { getByName: () => registry },
    ...over,
  });
  return { d1, db: d1.db, env, threads };
}

async function post(env: Env, path: string, runId: string, body: unknown) {
  const raw = JSON.stringify(body);
  const headers = await signedInternalHeaders(KEY, {
    method: 'POST',
    path,
    runId,
    rawBody: raw,
    nowMs: NOW,
  });
  return handleInternal(
    new Request(`https://svitanok.test${path}`, { method: 'POST', headers, body: raw }),
    env,
    NOW,
  );
}

describe('POST /internal/instruction', () => {
  it('агент з D1: імʼя, хеш тіла, тіло; персона - 400 not-a-worker', async () => {
    const { env } = setup();
    stubTelegram();
    const res = await post(env, '/internal/instruction', 'r1', { name: 'editor' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      name: 'editor',
      version_hash: syncInstructionHash(EDITOR_BODY),
      body_md: EDITOR_BODY,
    });
    const persona = await post(env, '/internal/instruction', 'r1', { name: 'persona' });
    expect(persona.status).toBe(400);
    expect(await persona.json()).toMatchObject({ error: 'not-a-worker', kind: 'persona' });
  });

  it('S-7-3: немає рядка - 404 instruction-missing + алерт у TOPIC_SYSTEM; контракт без name - 400', async () => {
    const { env } = setup();
    const { tg } = stubTelegram();
    const res = await post(env, '/internal/instruction', 'r1', { name: 'copywriter' });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'instruction-missing' });
    const alert = tg.find((c) =>
      String((c.form as Record<string, unknown>).text ?? '').includes('не налаштований'),
    );
    expect(alert).toBeTruthy();
    expect(String((alert!.form as Record<string, unknown>).message_thread_id)).toBe('77');
    expect((await post(env, '/internal/instruction', 'r1', {})).status).toBe(400);
    expect(validateAgainst(INSTRUCTION_SCHEMA, { name: '' }).ok).toBe(false);
  });
});

describe('POST /internal/taint', () => {
  it('позначає тред прогону (epoch-ms) - той самий прапорець, що після mail.*', async () => {
    const { env, db } = setup();
    const res = await post(env, '/internal/taint', 'r1', { source: 'worker:researcher' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, source: 'worker:researcher', tainted: true });
    const row = db.prepare('SELECT tainted FROM sessions WHERE thread_id = ?').get('99') as {
      tainted: number;
    };
    expect(row.tainted).toBe(NOW);
    expect(isTaintActive(row.tainted, NOW + 60_000)).toBe(true);
  });

  it('fail-closed: прогін без треду або без DB - 503 taint-not-persisted; контракт - source обовʼязковий', async () => {
    const { env } = setup();
    expect((await post(env, '/internal/taint', 'r-none', { source: 'worker:x' })).status).toBe(503);
    const noDb = setup({ DB: undefined });
    expect((await post(noDb.env, '/internal/taint', 'r1', { source: 'worker:x' })).status).toBe(
      503,
    );
    expect((await post(env, '/internal/taint', 'r1', {})).status).toBe(400);
    expect(validateAgainst(TAINT_SCHEMA, { source: 'x' }).ok).toBe(true);
  });
});

describe('deliver з результатом працівника (S-7-1)', () => {
  it('короткий: рядок у reports(kind=worker:<name>), кнопки Коротше/Інший тон/.md під відповіддю', async () => {
    const { env, db } = setup();
    const { tg } = stubTelegram();
    const res = await post(env, '/internal/deliver', 'r1', {
      text: 'Ось пост:\nПривіт',
      worker: { name: 'copywriter', text: 'Привіт, це пост.' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { worker_result_id: string };
    expect(body.worker_result_id).toMatch(/^[0-9a-f-]{36}$/);
    const row = db
      .prepare('SELECT kind, text_md FROM reports WHERE id = ?')
      .get(body.worker_result_id);
    expect(row).toEqual({ kind: 'worker:copywriter', text_md: 'Привіт, це пост.' });
    const msg = tg.find((c) => c.method === 'sendMessage')!.form as Record<string, unknown>;
    expect((msg.reply_markup as { inline_keyboard: unknown }).inline_keyboard).toEqual(
      workerButtons(body.worker_result_id, true, 'copywriter'),
    );
    expect(tg.some((c) => c.method === 'sendDocument')).toBe(false);
    expect(await loadWorkerResult(env, body.worker_result_id)).toMatchObject({
      name: 'copywriter',
      text: 'Привіт, це пост.',
    });
  });

  it('довгий (> 3 500): файл одразу у той самий тред, кнопки без .md; кнопки пропозиції лишаються першими', async () => {
    const { env } = setup();
    const { tg } = stubTelegram();
    const long = 'т'.repeat(WORKER_CHAT_MAX + 1);
    const res = await post(env, '/internal/deliver', 'r1', {
      text: 'Готово, файл нижче',
      buttons: [[{ text: '✅ Так', callback_data: 'p:abc:ok' }]],
      worker: { name: 'researcher', text: long },
    });
    expect(res.status).toBe(200);
    const { worker_result_id: id } = (await res.json()) as { worker_result_id: string };
    const msg = tg.find((c) => c.method === 'sendMessage')!.form as Record<string, unknown>;
    const kb = (msg.reply_markup as { inline_keyboard: { callback_data: string }[][] })
      .inline_keyboard;
    expect(kb[0]![0]!.callback_data).toBe('p:abc:ok');
    // Набір - за працівником (скарга 15 прогону 08.09): Дослідник дістає
    // «Джерела», а не «Інший тон» - переписувати чужі факти нема сенсу.
    expect(kb[1]!.map((b) => b.callback_data)).toEqual([`m:w:${id}:src`, `m:w:${id}:short`]);
    const doc = tg.find((c) => c.method === 'sendDocument')!.form as FormData;
    expect(doc.get('message_thread_id')).toBe('99');
    expect((doc.get('document') as File).name).toBe(workerFilename('researcher', NOW));
  });

  it('ціну gemini дописує ЯДРО під текстом моделі (S-8-5/S-8-6)', async () => {
    // Модель просить схвалення - і не має права називати ціну, від якої це
    // схвалення залежить. Тому рядок береться з kind+payload самої
    // пропозиції в базі, а не з тексту, який надіслав мозок.
    const { env, db } = setup();
    const { tg } = stubTelegram();
    db.prepare(
      `INSERT INTO proposals (id, level, kind, payload_json, thread_id, msg_id, word, expires_at, status, created_at)
       VALUES ('g1', 'T2', 'gemini.video', '{"prompt":"море"}', '99', NULL, 'ВИКОНАТИ', ?, 'open', ?)`,
    ).run(new Date(NOW + 600_000).toISOString(), new Date(NOW).toISOString());
    const res = await post(env, '/internal/deliver', 'r1', {
      text: 'Зробити відео?',
      buttons: [[{ text: '✅ Так', callback_data: 'p:g1:ok' }]],
    });
    expect(res.status).toBe(200);
    const msg = tg.find((c) => c.method === 'sendMessage')!.form as Record<string, unknown>;
    expect(String(msg.text)).toContain('Зробити відео?');
    expect(String(msg.text)).toContain('$3.20');
  });

  it('дві РІЗНІ пропозиції в одному повідомленні - відмова доставки', async () => {
    // Знахідка security-ревʼю: рядок ціни один, а кнопок може бути дві. Модель
    // клала дешеву пропозицію першою (її ціну й показувало ядро), а під «✅
    // Так» - дорогу. Вгадувати «правильну» тут нема сенсу: двох пропозицій під
    // одним текстом не потребує ніхто.
    const { env, db } = setup();
    stubTelegram();
    const pair: [string, string][] = [
      ['g1', 'gemini.image'],
      ['g2', 'gemini.video'],
    ];
    for (const [id, kind] of pair) {
      db.prepare(
        `INSERT INTO proposals (id, level, kind, payload_json, thread_id, msg_id, word, expires_at, status, created_at)
         VALUES (?, 'T1', ?, '{"prompt":"x"}', '99', NULL, NULL, ?, 'open', ?)`,
      ).run(id, kind, new Date(NOW + 600_000).toISOString(), new Date(NOW).toISOString());
    }
    const res = await post(env, '/internal/deliver', 'r1', {
      text: 'Одне з двох?',
      buttons: [
        [
          { text: '❌ Ні', callback_data: 'p:g1:ok' },
          { text: '✅ Так', callback_data: 'p:g2:ok' },
        ],
      ],
    });
    expect(res.status).toBe(400);
    expect(String(((await res.json()) as { error: string }).error)).toContain('різних пропозицій');
  });

  it('пропозиція вже вирішена - ціну не дописуємо', async () => {
    const { env, db } = setup();
    const { tg } = stubTelegram();
    db.prepare(
      `INSERT INTO proposals (id, level, kind, payload_json, thread_id, msg_id, word, expires_at, status, created_at)
       VALUES ('g9', 'T2', 'gemini.video', '{"prompt":"море"}', '99', NULL, 'ВИКОНАТИ', ?, 'approved', ?)`,
    ).run(new Date(NOW + 600_000).toISOString(), new Date(NOW).toISOString());
    await post(env, '/internal/deliver', 'r1', {
      text: 'Готово',
      buttons: [[{ text: '✅ Так', callback_data: 'p:g9:ok' }]],
    });
    const msg = tg.find((c) => c.method === 'sendMessage')!.form as Record<string, unknown>;
    expect(String(msg.text)).toBe('Готово');
  });

  it('збій бази на читанні ціни - відмова доставки, а не мовчазна доставка без ціни', async () => {
    // Інакше транзієнтний збій D1 давав би робочу кнопку ✅ на $3.20 без
    // жодної ціни поруч - рівно те, проти чого рядок і заведено.
    const { env } = setup();
    stubTelegram();
    const broken = {
      ...env,
      DB: {
        prepare: () => ({
          bind: () => ({
            first: async () => {
              throw new Error('D1 лежить');
            },
            all: async () => ({ results: [] }),
            run: async () => ({ meta: { changes: 0 } }),
          }),
        }),
      },
    } as unknown as Env;
    const res = await post(broken, '/internal/deliver', 'r1', {
      text: 'Зробити?',
      buttons: [[{ text: '✅ Так', callback_data: 'p:zzz:ok' }]],
    });
    expect(res.status).toBe(400);
    expect(String(((await res.json()) as { error: string }).error)).toContain('ціну пропозиції');
  });

  it('для звичайної пропозиції рядка ціни немає', async () => {
    const { env, db } = setup();
    const { tg } = stubTelegram();
    db.prepare(
      `INSERT INTO proposals (id, level, kind, payload_json, thread_id, msg_id, word, expires_at, status, created_at)
       VALUES ('c1', 'T1', 'calendar.event', '{"title":"Зустріч"}', '99', NULL, NULL, ?, 'open', ?)`,
    ).run(new Date(NOW + 600_000).toISOString(), new Date(NOW).toISOString());
    await post(env, '/internal/deliver', 'r1', {
      text: 'Створити подію?',
      buttons: [[{ text: '✅ Так', callback_data: 'p:c1:ok' }]],
    });
    const msg = tg.find((c) => c.method === 'sendMessage')!.form as Record<string, unknown>;
    expect(String(msg.text)).toBe('Створити подію?');
  });

  it('контракт: чуже імʼя або порожній текст - 400, у базі нічого; схема deliver знає worker', async () => {
    const { env, db } = setup();
    stubTelegram();
    expect(
      (
        await post(env, '/internal/deliver', 'r1', {
          text: 'x',
          worker: { name: 'Bad Name', text: 'y' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post(env, '/internal/deliver', 'r1', {
          text: 'x',
          worker: { name: 'editor', text: ' ' },
        })
      ).status,
    ).toBe(400);
    expect(db.prepare('SELECT COUNT(*) AS n FROM reports').get()).toEqual({ n: 0 });
    expect(
      validateAgainst(DELIVER_SCHEMA, { text: 'x', worker: { name: 'a', text: 'b' } }).ok,
    ).toBe(true);
    expect(validateAgainst(DELIVER_SCHEMA, { text: 'x', worker: { name: 'a' } }).ok).toBe(false);
    await expect(saveWorkerResult(env, { name: 'ok-name', text: 'т' }, NOW)).resolves.toMatchObject(
      {
        name: 'ok-name',
      },
    );
  });
});

describe('кнопки m:w: (prerouter)', () => {
  it('.md - файл із бази у тред; short/tone - підказка в тред тим самим шляхом, що текст (chat-прогін)', async () => {
    const { env, db } = setup();
    const { tg, brain } = stubTelegram();
    // Персона потрібна прогону chat, який стартує з підказки.
    const { id } = await saveWorkerResult(env, { name: 'copywriter', text: 'Пост.' }, NOW);
    expect(db.prepare('SELECT COUNT(*) AS n FROM reports').get()).toEqual({ n: 1 });
    const md = await handleBrainCallback(
      env,
      { data: `m:w:${id}:md`, chatId: 555, messageId: 1, threadId: 99 },
      NOW,
    );
    expect(md).toBe('Файл у треді');
    const doc = tg.find((c) => c.method === 'sendDocument')!.form as FormData;
    expect(String(doc.get('caption'))).toContain('copywriter');

    const short = await handleBrainCallback(
      env,
      { data: `m:w:${id}:short`, chatId: 555, messageId: 1, threadId: 99 },
      NOW + 1,
    );
    expect(short).toBe('Скорочую');
    expect(brain).toHaveLength(1);
    expect(brain[0]!.path).toBe('/run');
    expect((brain[0]!.body.input as { text: string }).text).toBe(WORKER_FOLLOWUPS.short);
    expect(brain[0]!.body.thread_id).toBe('99');
  });

  it('невідомий id - чесний тост, нічого не шлеться', async () => {
    const { env } = setup();
    const { tg, brain } = stubTelegram();
    expect(
      await handleBrainCallback(env, { data: 'm:w:nope:tone', chatId: 555, messageId: 1 }, NOW),
    ).toBe('Результат уже не в базі.');
    expect(tg).toHaveLength(0);
    expect(brain).toHaveLength(0);
  });
});
