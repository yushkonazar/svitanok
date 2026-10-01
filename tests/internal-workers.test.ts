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
import { tutorButtons } from '../web/core/brain/learning-session.mjs';
import {
  WORKER_CHAT_MAX,
  WORKER_FOLLOWUPS,
  workerFollowupText,
  workerButtons,
  workerFilename,
  saveWorkerResult,
  loadWorkerResult,
  priceShopOptions,
  priceShopCard,
  priceShopButtons,
  mailCardItems,
  mailReportButtons,
  mailItemButtons,
  mailItemFollowup,
  mailNextPageInfo,
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

function stubTelegram(options: { failEditMessageId?: number } = {}) {
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
        if (
          method === 'editMessageText' &&
          Number((form as Record<string, unknown>).message_id) === options.failEditMessageId
        ) {
          return new Response(
            JSON.stringify({ ok: false, description: 'message cannot be edited' }),
            {
              status: 400,
            },
          );
        }
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
  it('навчальне питання доставляється з кнопками сесії, повторна відповідь не змінює стан', async () => {
    const { env, db } = setup();
    const { tg } = stubTelegram();
    const question =
      '🎓 SQL індекси\nЯкий індекс допоможе пошуку за містом?\nМожеш відповісти або попросити підказку.';
    const res = await post(env, '/internal/deliver', 'r1', {
      text: question,
      worker: { name: 'tutor', text: question },
    });
    expect(res.status).toBe(200);
    const { worker_result_id: id } = (await res.json()) as { worker_result_id: string };
    const row = db.prepare('SELECT status, topic FROM learning_sessions WHERE id = ?').get(id);
    expect(row).toEqual({ status: 'question', topic: 'SQL індекси' });
    const msg = tg.find((call) => call.method === 'sendMessage')?.form as Record<string, unknown>;
    expect((msg.reply_markup as { inline_keyboard: unknown }).inline_keyboard).toEqual(
      tutorButtons(id, 'question'),
    );
    const first = await handleBrainCallback(
      env,
      {
        data: `m:tu:${id}:answer`,
        chatId: 555,
        threadId: 99,
        messageId: 11,
      },
      NOW + 1,
    );
    const second = await handleBrainCallback(
      env,
      {
        data: `m:tu:${id}:answer`,
        chatId: 555,
        threadId: 99,
        messageId: 11,
      },
      NOW + 2,
    );
    expect(first).toBe('Чекаю твою відповідь');
    expect(second).toContain('вже почата');
    expect(db.prepare('SELECT status FROM learning_sessions WHERE id = ?').get(id)).toEqual({
      status: 'awaiting_answer',
    });
    expect(
      await handleBrainCallback(
        env,
        {
          data: `m:tu:${id}:finish`,
          chatId: 777,
          threadId: 99,
          messageId: 11,
        },
        NOW + 3,
      ),
    ).toContain('недоступне');
  });

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

  it('facts.set T1 має людську картку без setting.* і дублювання кнопки', async () => {
    const { env, db } = setup();
    const { tg } = stubTelegram();
    db.prepare(
      `INSERT INTO proposals (id, level, kind, payload_json, thread_id, msg_id, word, expires_at, status, created_at)
       VALUES ('fact1', 'T1', 'facts.set', ?, '99', NULL, NULL, ?, 'open', ?)`,
    ).run(
      JSON.stringify({ kind: 'setting', key: 'setting.test_word', value: 'лимон' }),
      new Date(NOW + 600_000).toISOString(),
      new Date(NOW).toISOString(),
    );
    const res = await post(env, '/internal/deliver', 'r1', {
      text: 'Запамʼятаю setting.test_word після твого ✅.',
      buttons: [[{ text: '✅ Так', callback_data: 'p:fact1:ok' }]],
    });
    expect(res.status).toBe(200);
    const msg = tg.find((c) => c.method === 'sendMessage')!.form as Record<string, unknown>;
    expect(msg.text).toBe('🧠 Зберегти для тестів слово «лимон»?');
    expect(String(msg.text)).not.toContain('setting.');
    expect(String(msg.text)).not.toContain('після твого');
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

describe('підбір магазину для відстеження ціни', () => {
  it('показує лише перевірені https-магазини, посилання й окремі кнопки вибору', () => {
    const options = priceShopOptions(
      [
        '## Ціни',
        '- Rozetka — 14 999 грн — https://rozetka.com.ua/ua/sony-wh-1000xm6/p123',
        '- підробка — 1 грн — https://evil.example/sony',
        '- Allo — 15 499 грн — https://www.allo.ua/ua/naushniki/sony-wh-1000xm6/',
        '## Джерела',
        '- ця секція вже не є добіркою цін — https://comfy.ua/ua/nope',
      ].join('\n'),
    );
    expect(options).toEqual([
      {
        shop: 'Rozetka',
        detail: 'Rozetka — 14 999 грн',
        url: 'https://rozetka.com.ua/ua/sony-wh-1000xm6/p123',
      },
      {
        shop: 'Allo',
        detail: 'Allo — 15 499 грн',
        url: 'https://www.allo.ua/ua/naushniki/sony-wh-1000xm6/',
      },
    ]);
    expect(priceShopCard(options)).toContain(
      '[Rozetka](https://rozetka.com.ua/ua/sony-wh-1000xm6/p123)',
    );
    expect(priceShopCard(options)).not.toContain('evil.example');
    expect(priceShopButtons('r-price', options)).toEqual([
      [{ text: '🎁 Rozetka', callback_data: 'm:ps:r-price:0' }],
      [{ text: '🎁 Allo', callback_data: 'm:ps:r-price:1' }],
    ]);
  });

  it('price-search не отримує непотрібних кнопок переписування тексту', () => {
    expect(workerButtons('r-price', true, 'price-search')).toEqual([]);
  });

  it('не пропонує домашню сторінку, URL з обліковими даними чи ціну без валюти', () => {
    expect(
      priceShopOptions(
        [
          '## Ціни',
          '- Rozetka — 14 999 грн — https://rozetka.com.ua/',
          '- Rozetka — 14 999 грн — https://name:password@rozetka.com.ua/ua/sony/p123',
          '- Rozetka — 14 999 — https://rozetka.com.ua/ua/sony/p123',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('бере не більш як чотири унікальні картки товарів лише з секції цін', () => {
    const lines = [
      '## Пояснення',
      '- Rozetka — 900 грн — https://rozetka.com.ua/ua/wrong/p0',
      '## Ціни',
      '- Rozetka — 1000 грн — https://rozetka.com.ua/ua/item/p1',
      '- Rozetka — 1000 грн — https://rozetka.com.ua/ua/item/p1',
      '- Comfy — 1100 грн — https://comfy.ua/ua/item/p2',
      '- Allo — 1200 грн — https://allo.ua/ua/item/p3',
      '- Foxtrot — 1300 грн — https://foxtrot.com.ua/ua/item/p4',
      '- Eldorado — 1400 грн — https://eldorado.ua/ua/item/p5',
    ];
    const options = priceShopOptions(lines.join('\n'));
    expect(options.map((option) => option.shop)).toEqual(['Rozetka', 'Comfy', 'Allo', 'Foxtrot']);
    expect(priceShopCard(options)).toContain('🎁 Обери магазин');
    expect(priceShopButtons('r1', options)).toHaveLength(4);
    expect(priceShopCard([])).toBe('');
    expect(priceShopOptions('## Інше\n- Comfy — 1000 грн — https://comfy.ua/ua/item/p2')).toEqual(
      [],
    );
    expect(priceShopOptions(null as unknown as string)).toEqual([]);
    expect(priceShopOptions('## Ціни\n- без посилання 1000 грн')).toEqual([]);
    expect(priceShopOptions('## Ціни\n- товар — 1000 грн — https://unknown.example/p')).toEqual([]);
    expect(priceShopOptions('## Ціни\n- товар — 1000 грн — https://comfy.ua:8443/p')).toEqual([]);
    expect(priceShopOptions('## Ціни\n- товар — 1000 грн — https://%')).toEqual([]);
  });

  it('подвійний вибір магазину не запускає другий прогін або іншу сторінку', async () => {
    const { env, db } = setup();
    const { brain } = stubTelegram();
    const { id } = await saveWorkerResult(
      env,
      {
        name: 'price-search',
        text: '## Ціни\n- Rozetka — 14 999 грн — https://rozetka.com.ua/ua/sony-wh-1000xm6/p123\n- Allo — 15 499 грн — https://allo.ua/ua/sony-wh-1000xm6/',
      },
      NOW,
    );
    const first = await handleBrainCallback(
      env,
      { data: `m:ps:${id}:0`, chatId: 555, messageId: 11, threadId: 99 },
      NOW,
    );
    const second = await handleBrainCallback(
      env,
      { data: `m:ps:${id}:1`, chatId: 555, messageId: 11, threadId: 99 },
      NOW + 1,
    );
    expect(first).toBe('Обрано: Rozetka');
    expect(second).toBe('Магазин із цього підбору вже обрано.');
    expect(brain).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM worker_card_actions').get()).toEqual({ n: 1 });
  });

  it('якщо картку магазину не можна змінити, створює лише один новий статус для відповіді', async () => {
    const { env } = setup();
    const { tg, brain } = stubTelegram({ failEditMessageId: 11 });
    const { id } = await saveWorkerResult(
      env,
      {
        name: 'price-search',
        text: '## Ціни\n- Rozetka — 14 999 грн — https://rozetka.com.ua/ua/sony-wh-1000xm6/p123',
      },
      NOW,
    );
    expect(
      await handleBrainCallback(
        env,
        { data: `m:ps:${id}:0`, chatId: 555, messageId: 11, threadId: 99 },
        NOW,
      ),
    ).toBe('Обрано: Rozetka');
    expect(brain).toHaveLength(1);
    expect(tg.filter(({ method }) => method === 'sendMessage')).toHaveLength(1);
    expect(
      tg.filter(
        ({ method, form }) =>
          method === 'editMessageText' &&
          Number((form as Record<string, unknown>).message_id) === 9,
      ),
    ).toHaveLength(0);
  });

  it('після збою запуску показує помилку на картці та дозволяє повторний вибір', async () => {
    const { env, db } = setup({
      RUN_REGISTRY: {
        getByName: () => ({
          threadClaim: async () => {
            throw new Error('registry down');
          },
        }),
      } as unknown as NonNullable<Env['RUN_REGISTRY']>,
    });
    const { tg, brain } = stubTelegram();
    const { id } = await saveWorkerResult(
      env,
      {
        name: 'price-search',
        text: '## Ціни\n- Rozetka — 14 999 грн — https://rozetka.com.ua/ua/sony-wh-1000xm6/p123',
      },
      NOW,
    );
    expect(
      await handleBrainCallback(
        env,
        { data: `m:ps:${id}:0`, chatId: 555, messageId: 11, threadId: 99 },
        NOW,
      ),
    ).toBe('Обрано: Rozetka');
    expect(brain).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM worker_card_actions').get()).toEqual({ n: 0 });
    expect(
      tg.some(
        ({ method, form }) =>
          method === 'editMessageText' &&
          String((form as Record<string, unknown>).text).includes(
            'Не вдалося запустити відстеження',
          ) &&
          JSON.stringify((form as Record<string, unknown>).reply_markup).includes(`m:ps:${id}:0`),
      ),
    ).toBe(true);
  });
});

describe('картки пошти', () => {
  const report = [
    '## Вхідні сьогодні — 2 листи',
    '🔴 Важливо',
    '- від: a@example.com - Тест з гостем - відповісти сьогодні - id a1b2',
    '🟡 Дія',
    '- від: b@example.com - Рахунок - перевірити оплату - id b2c3',
    '## Чернетки',
    '### Re: Тест з гостем - до a@example.com - id a1b2',
    '## Строки',
    '- оплатити завтра - id b2c3',
  ].join('\n');

  it('бере id лише зі списків листів, не з чернеток і строків', () => {
    const items = mailCardItems(report);
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.id)).toEqual(['a1b2', 'b2c3']);
    expect(mailReportButtons('report1', items, false).map((row) => row[0]?.callback_data)).toEqual([
      'm:mi:report1:0',
      'm:mi:report1:1',
    ]);
    expect(
      mailItemButtons('report1', 0)
        .flat()
        .map((b) => b.callback_data),
    ).toEqual([
      'm:ma:report1:0:brief',
      'm:ma:report1:0:draft',
      'm:ma:report1:0:remind',
      'm:ml:report1',
    ]);
    expect(mailItemFollowup({ id: 'report1' }, items[0]!, 'draft')).toContain('ID листа: a1b2');
    expect(mailItemFollowup({ id: 'report1' }, items[0]!, 'draft')).not.toContain('b2c3');
  });

  it('доставляє кнопки конкретних листів і наступну сторінку лише за наявності курсора', async () => {
    const { env } = setup();
    const { tg } = stubTelegram();
    const body = `Охоплення: запит from:example.com; наступна сторінка cursor-2; пропущено метаданих 0\n${report}`;
    const res = await post(env, '/internal/deliver', 'r1', {
      text: 'Знайшов два листи.',
      worker: { name: 'mail-secretary', text: body },
    });
    expect(res.status).toBe(200);
    const id = ((await res.json()) as { worker_result_id: string }).worker_result_id;
    const msg = tg.find((call) => call.method === 'sendMessage')!.form as Record<string, unknown>;
    const buttons = (msg.reply_markup as { inline_keyboard: { callback_data: string }[][] })
      .inline_keyboard;
    expect(buttons.flat().map((b) => b.callback_data)).toEqual([
      `m:mi:${id}:0`,
      `m:mi:${id}:1`,
      `m:w:${id}:next`,
      `m:w:${id}:md`,
    ]);
    expect(mailNextPageInfo(body)).toEqual({ query: 'from:example.com', cursor: 'cursor-2' });
    expect(mailNextPageInfo(body.replace('cursor-2', 'немає'))).toBeNull();
  });

  it('не створює кнопку з некоректного або дубльованого id', () => {
    expect(mailCardItems('🔴 Важливо\n- від: a@example.com - Тема - id a/b')).toEqual([]);
    expect(
      mailCardItems(
        '🔴 Важливо\n- від: a@example.com - Тема - id a1\n- від: a@example.com - Тема - id a1',
      ),
    ).toHaveLength(1);
    expect(mailCardItems('')).toEqual([]);
    expect(mailCardItems(null as unknown as string)).toEqual([]);
    expect(mailCardItems('## Чернетки\n- від: a@example.com - Тема - id a1')).toEqual([]);
    expect(
      mailCardItems('🔴 Важливо\n- від: a@example.com - id a1\n- від: - Тема - id a2'),
    ).toEqual([]);
    expect(
      mailCardItems(
        '🔴 Важливо\n- від: a@example.com - Тема - id a1\n## Строки\n- від: b@example.com - Інше - id b2',
      ),
    ).toHaveLength(1);
    expect(
      mailCardItems(
        `🔴 Важливо\n${Array.from({ length: 12 }, (_, index) => `- від: a@example.com - Тема ${index} - id a${index}`).join('\n')}`,
      ),
    ).toHaveLength(10);
    expect(mailNextPageInfo('Охоплення: запит x; наступна сторінка null')).toBeNull();
    expect(mailNextPageInfo(null as unknown as string)).toBeNull();
    expect(mailNextPageInfo('Охоплення: запит x; наступна сторінка cursor-3')).toEqual({
      query: 'x',
      cursor: 'cursor-3',
    });
    expect(
      mailReportButtons('r1', [], true, true)
        .flat()
        .map((button) => button.callback_data),
    ).toEqual(['m:w:r1:next', 'm:w:r1:md']);
  });

  it('відхиляє невідому кнопку працівника й не стверджує збереження без D1', async () => {
    expect(() =>
      workerFollowupText({ id: 'r1', name: 'editor', text: 'Текст' }, 'unknown' as 'short'),
    ).toThrow('Невідома дія');
    await expect(
      saveWorkerResult(workerEnv({ DB: undefined }), { name: 'editor', text: 'Текст' }, NOW),
    ).rejects.toThrow('DB');
  });

  it('картка одного листа відкривається в тому самому повідомленні, а дія стартує один раз', async () => {
    const { env, db } = setup();
    const { tg, brain } = stubTelegram();
    const { id } = await saveWorkerResult(env, { name: 'mail-secretary', text: report }, NOW);
    expect(
      await handleBrainCallback(
        env,
        { data: `m:mi:${id}:0`, chatId: 555, messageId: 11, threadId: 99 },
        NOW,
      ),
    ).toBe('Картку відкрито');
    const edit = tg.find((call) => call.method === 'editMessageText')?.form as Record<
      string,
      unknown
    >;
    expect(String(edit.text)).toContain('Тест з гостем');
    expect(JSON.stringify(edit.reply_markup)).toContain(`m:ma:${id}:0:draft`);
    expect(
      await handleBrainCallback(
        env,
        { data: `m:ma:${id}:0:draft`, chatId: 555, messageId: 11, threadId: 99 },
        NOW + 1,
      ),
    ).toBe('Взяв вибраний лист у роботу');
    expect(
      await handleBrainCallback(
        env,
        { data: `m:ma:${id}:0:draft`, chatId: 555, messageId: 11, threadId: 99 },
        NOW + 2,
      ),
    ).toBe('Цю дію для листа вже запущено.');
    expect(brain).toHaveLength(1);
    expect((brain[0]!.body.input as { text: string }).text).toContain('ID листа: a1b2');
    expect((brain[0]!.body.input as { text: string }).text).not.toContain('ID листа: b2c3');
    expect(db.prepare('SELECT COUNT(*) AS n FROM worker_card_actions').get()).toEqual({ n: 1 });
  });

  it('нагадування з картки зберігає предмет і показує варіанти часу без нового модельного прогону', async () => {
    const { env, db } = setup();
    const { tg, brain } = stubTelegram();
    const { id } = await saveWorkerResult(env, { name: 'mail-secretary', text: report }, NOW);
    const toast = await handleBrainCallback(
      env,
      { data: `m:ma:${id}:1:remind`, chatId: 555, messageId: 11, threadId: 99 },
      NOW,
    );
    expect(toast).toBe('Обери час нагадування');
    const edit = tg.find((call) => call.method === 'editMessageText')?.form as Record<
      string,
      unknown
    >;
    expect(String(edit.text)).toContain('Рахунок');
    expect(JSON.stringify(edit.reply_markup)).toContain('m:rt:');
    expect(brain).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM worker_card_actions').get()).toEqual({ n: 1 });
    expect(
      await handleBrainCallback(
        env,
        { data: `m:ma:${id}:1:remind`, chatId: 555, messageId: 11, threadId: 99 },
        NOW + 1,
      ),
    ).toBe('Цю дію для листа вже запущено.');
    expect(
      await handleBrainCallback(
        env,
        { data: `m:ma:${id}:1:remind`, chatId: 555, messageId: 11, threadId: 99 },
        NOW + 21 * 60_000,
      ),
    ).toBe('Обери час нагадування');
    expect(db.prepare('SELECT COUNT(*) AS n FROM worker_card_actions').get()).toEqual({ n: 1 });
  });

  it('наступна сторінка привʼязана до запиту й курсора конкретного результату', async () => {
    const { env } = setup();
    const { brain } = stubTelegram();
    const { id } = await saveWorkerResult(
      env,
      {
        name: 'mail-secretary',
        text: `Охоплення: запит from:example.com; наступна сторінка cursor-2; пропущено метаданих 0\n${report}`,
      },
      NOW,
    );
    expect(
      await handleBrainCallback(
        env,
        { data: `m:w:${id}:next`, chatId: 555, messageId: 11, threadId: 99 },
        NOW,
      ),
    ).toBe('Дивлюсь далі');
    const input = (brain[0]!.body.input as { text: string }).text;
    expect(input).toContain('q="from:example.com"');
    expect(input).toContain('pageToken="cursor-2"');
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
    expect((brain[0]!.body.input as { text: string }).text).toContain(WORKER_FOLLOWUPS.short);
    expect((brain[0]!.body.input as { text: string }).text).toContain(id);
    expect((brain[0]!.body.input as { text: string }).text).toContain('Пост.');
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
