// Outbox Telegram (етап 1, PR-7): розбиття 4096, бекоф, claim проти дублю,
// fallback розмітки, 429 → retry_after, deliver/status через router.
// D1 - node:sqlite зі СПРАВЖНЬОЮ міграцією 0002 (таблиця outbox як у проді).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  splitMessage,
  nextAttemptAt,
  isParseEntitiesError,
  TG_TEXT_LIMIT,
  MAX_ATTEMPTS,
} from '../web/core/tg/outbox-core.mjs';
import { enqueueOutbox, drainOutbox, dropPendingEdits } from '../web/core/tg/outbox.mjs';
import { handleInternal } from '../web/core/internal/router.mjs';
import { productionIo } from '../web/core/ideas/analysis.mjs';
import { signInternal } from '../web/core/internal/auth.mjs';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';

const NOW = Date.parse('2026-08-27T12:00:00.000Z');
const noSleep = async () => {};

/** D1-фейк на node:sqlite зі справжньою міграцією 0002 (містить outbox). */
function d1() {
  const db = new DatabaseSync(':memory:');
  db.exec(
    readFileSync(join(__dirname, '..', 'web', 'core', 'migrations', '0002_assistant.sql'), 'utf8'),
  );
  return {
    raw: db,
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        run: async () => {
          // @ts-expect-error node:sqlite приймає біндинги варіативно
          const info = db.prepare(sql).run(...args);
          return { meta: { changes: Number(info.changes) } };
        },
        all: async () => ({
          // @ts-expect-error те саме для all
          results: db.prepare(sql).all(...args),
        }),
      }),
    }),
  };
}

const rowsOf = (d: ReturnType<typeof d1>) =>
  d.raw.prepare('SELECT * FROM outbox ORDER BY next_at, id').all() as {
    status: string;
    kind: string;
    attempts: number;
    payload_json: string;
  }[];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('outbox-core — чиста логіка', () => {
  it('splitMessage: короткий текст цілим, довгий — частинами ≤ 4096 по межах', () => {
    expect(splitMessage('привіт')).toEqual(['привіт']);
    expect(splitMessage('   ')).toEqual([]);
    const long = Array.from({ length: 300 }, (_, i) => `рядок ${i} ${'x'.repeat(30)}`).join('\n');
    const parts = splitMessage(long);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(TG_TEXT_LIMIT);
    // Нічого не загублено: склеєне назад містить перший і останній рядок.
    expect(parts[0]).toContain('рядок 0');
    expect(parts.at(-1)).toContain('рядок 299');
  });

  it('nextAttemptAt: retry_after Telegram переважає, інакше експонента з капом', () => {
    expect(nextAttemptAt(0, 1, 7)).toBe(7_000);
    expect(nextAttemptAt(0, 1)).toBe(30_000);
    expect(nextAttemptAt(0, 2)).toBe(60_000);
    expect(nextAttemptAt(0, 99)).toBe(30 * 60_000); // кап
  });

  it('isParseEntitiesError: лише 400 із parse entities', () => {
    expect(isParseEntitiesError(400, "Bad Request: can't parse entities")).toBe(true);
    expect(isParseEntitiesError(400, 'Bad Request: chat not found')).toBe(false);
    expect(isParseEntitiesError(429, "can't parse entities")).toBe(false);
  });
});

describe('outbox — enqueue і drain', () => {
  let store: ReturnType<typeof d1>;
  let env: Env;
  let calls: { url: string; body: unknown }[];

  const tgOk = () =>
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    });

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    store = d1();
    calls = [];
    env = workerEnv({ TELEGRAM_BOT_TOKEN: 'bot-t', DB: store });
  });

  it('довгий deliver-текст стає кількома рядами; кнопки лише на останньому', async () => {
    const text = `${'а'.repeat(5000)}\n\nхвіст`;
    const { queued } = await enqueueOutbox(
      env,
      {
        chatId: '-100',
        threadId: 7,
        kind: 'send',
        payload: {
          text,
          reply_markup: { inline_keyboard: [[{ text: 'ok', callback_data: 'a:1' }]] },
        },
      },
      NOW,
    );
    expect(queued).toBeGreaterThan(1);
    const rows = rowsOf(store);
    const withButtons = rows.filter((r) => JSON.parse(r.payload_json).reply_markup);
    expect(withButtons).toHaveLength(1);
    expect(rows.at(-1)?.payload_json).toContain('inline_keyboard');
  });

  it('drain шле послідовно і ставить sent; порядок частин збережено', async () => {
    vi.stubGlobal('fetch', tgOk());
    await enqueueOutbox(env, { chatId: '-100', kind: 'send', payload: { text: 'один' } }, NOW);
    await enqueueOutbox(env, { chatId: '-100', kind: 'send', payload: { text: 'два' } }, NOW + 10);
    const res = await drainOutbox(env, { nowMs: NOW + 100, sleep: noSleep });
    expect(res).toMatchObject({ sent: 2, retried: 0, failed: 0 });
    expect(calls.map((c) => (c.body as { text: string }).text)).toEqual(['один', 'два']);
    expect(rowsOf(store).map((r) => r.status)).toEqual(['sent', 'sent']);
  });

  it('429 з retry_after: ряд лишається pending із next_at у майбутньому', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: false, parameters: { retry_after: 17 } }), {
            status: 429,
          }),
      ),
    );
    await enqueueOutbox(env, { chatId: '-100', kind: 'send', payload: { text: 'x' } }, NOW);
    const res = await drainOutbox(env, { nowMs: NOW + 100, sleep: noSleep });
    expect(res).toMatchObject({ sent: 0, retried: 1 });
    const [row] = rowsOf(store);
    expect(row?.status).toBe('pending');
    expect(row?.attempts).toBe(1);
    // Наступний драйн ДО retry_after нічого не бере.
    const again = await drainOutbox(env, { nowMs: NOW + 5_000, sleep: noSleep });
    expect(again).toMatchObject({ sent: 0, retried: 0 });
  });

  it('розмітка не парситься — повтор БЕЗ parse_mode тим самим текстом', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      calls.push({ url, body });
      if (body.parse_mode) {
        return new Response(
          JSON.stringify({ ok: false, description: "Bad Request: can't parse entities" }),
          { status: 400 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    await enqueueOutbox(
      env,
      { chatId: '-100', kind: 'send', payload: { text: '<b>зламаний', parse_mode: 'HTML' } },
      NOW,
    );
    const res = await drainOutbox(env, { nowMs: NOW + 100, sleep: noSleep });
    expect(res).toMatchObject({ sent: 1 });
    expect(calls).toHaveLength(2);
    expect((calls[1]?.body as { parse_mode?: string }).parse_mode).toBeUndefined();
  });

  it('parts із plain_text: розмітку відхилено → фолбек шле ОРИГІНАЛ Markdown, а не голі теги; plain_text у Telegram не їде', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      calls.push({ url, body });
      if (body.parse_mode) {
        return new Response(
          JSON.stringify({ ok: false, description: "Bad Request: can't parse entities" }),
          { status: 400 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    await enqueueOutbox(
      env,
      {
        chatId: '-100',
        kind: 'send',
        parts: [{ text: '<b>жирно</b>', plain_text: '**жирно**' }],
        payload: { parse_mode: 'HTML' },
      },
      NOW,
    );
    const res = await drainOutbox(env, { nowMs: NOW + 100, sleep: noSleep });
    expect(res).toMatchObject({ sent: 1 });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body).toMatchObject({ text: '<b>жирно</b>', parse_mode: 'HTML' });
    expect(calls[0]?.body).not.toHaveProperty('plain_text');
    expect(calls[1]?.body).toMatchObject({ text: '**жирно**' });
    expect(calls[1]?.body).not.toHaveProperty('parse_mode');
    expect(calls[1]?.body).not.toHaveProperty('plain_text');
  });

  it('після MAX_ATTEMPTS ряд стає failed — видима поломка, не вічний цикл', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"ok":false}', { status: 500 })),
    );
    await enqueueOutbox(env, { chatId: '-100', kind: 'send', payload: { text: 'x' } }, NOW);
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      store.raw.prepare(`UPDATE outbox SET next_at = ? WHERE 1=1`).run(new Date(NOW).toISOString());
      await drainOutbox(env, { nowMs: NOW + 100, sleep: noSleep });
    }
    expect(rowsOf(store)[0]?.status).toBe('failed');
  });

  it('claim: два конкурентні драйни не шлють той самий ряд двічі', async () => {
    vi.stubGlobal('fetch', tgOk());
    await enqueueOutbox(env, { chatId: '-100', kind: 'send', payload: { text: 'раз' } }, NOW);
    const [a, b] = await Promise.all([
      drainOutbox(env, { nowMs: NOW + 100, sleep: noSleep }),
      drainOutbox(env, { nowMs: NOW + 100, sleep: noSleep }),
    ]);
    expect((a?.sent ?? 0) + (b?.sent ?? 0)).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it('dropPendingEdits заміняє незісланий статус новішим', async () => {
    await enqueueOutbox(
      env,
      { chatId: '-100', kind: 'edit', payload: { message_id: 42, text: 'старий' } },
      NOW,
    );
    await dropPendingEdits(env, '-100', 42);
    await enqueueOutbox(
      env,
      { chatId: '-100', kind: 'edit', payload: { message_id: 42, text: 'новий' } },
      NOW + 10,
    );
    const rows = rowsOf(store);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload_json).toContain('новий');
  });

  it('contact і venue (етап 5) йдуть JSON-ом на sendContact/sendVenue з темою і кнопками', async () => {
    vi.stubGlobal('fetch', tgOk());
    await enqueueOutbox(
      env,
      {
        chatId: '-100',
        threadId: '99',
        kind: 'contact',
        payload: {
          phone_number: '+380',
          first_name: 'Креденс',
          reply_markup: { inline_keyboard: [[{ text: 'x', callback_data: 'c:1:called' }]] },
        },
      },
      NOW,
    );
    await enqueueOutbox(
      env,
      {
        chatId: '-100',
        kind: 'venue',
        payload: { latitude: 49.8, longitude: 24.0, title: 'Креденс', address: 'адреса' },
      },
      NOW + 1,
    );
    await drainOutbox(env, { nowMs: NOW + 100, sleep: noSleep });
    expect(calls.map((c) => String(c.url).split('/').pop())).toEqual(['sendContact', 'sendVenue']);
    expect(calls[0]?.body).toMatchObject({
      chat_id: '-100',
      message_thread_id: '99',
      phone_number: '+380',
      first_name: 'Креденс',
      reply_markup: { inline_keyboard: [[{ text: 'x', callback_data: 'c:1:called' }]] },
    });
    expect(calls[1]?.body).toMatchObject({ latitude: 49.8, longitude: 24.0, title: 'Креденс' });
    expect(rowsOf(store).map((r) => r.status)).toEqual(['sent', 'sent']);
  });

  it('документ іде multipart-ом на sendDocument', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ?? null });
      return new Response('{"ok":true}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    await enqueueOutbox(
      env,
      { chatId: '-100', kind: 'document', payload: { filename: 'звіт.md', content: '# Звіт' } },
      NOW,
    );
    await drainOutbox(env, { nowMs: NOW + 100, sleep: noSleep });
    expect(String(calls[0]?.url)).toContain('/sendDocument');
    expect(calls[0]?.body).toBeInstanceOf(FormData);
  });
});

describe('deliver/status через router', () => {
  const KEY = 'k';
  let store: ReturnType<typeof d1>;
  let env: Env;
  let sends: { url: string; body: Record<string, unknown> }[];

  const signedRequest = async (path: string, bodyObj: unknown, nonce: string) => {
    const body = JSON.stringify(bodyObj);
    return new Request(`https://svitanok.test${path}`, {
      method: 'POST',
      headers: {
        'X-Internal-Timestamp': String(NOW),
        'X-Internal-Run': 'r1',
        'X-Internal-Nonce': nonce,
        'X-Internal-Signature': await signInternal(KEY, {
          method: 'POST',
          path,
          timestampMs: NOW,
          runId: 'r1',
          nonce,
          rawBody: body,
        }),
      },
      body,
    });
  };

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    store = d1();
    sends = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        sends.push({
          url,
          body: typeof init?.body === 'string' ? JSON.parse(init.body) : { form: true },
        });
        return new Response(JSON.stringify({ ok: true, result: { message_id: 5 } }), {
          status: 200,
        });
      }),
    );
    env = workerEnv({
      ASSISTANT_V2: 'shadow',
      INTERNAL_HMAC_KEY: KEY,
      TELEGRAM_BOT_TOKEN: 'bot-t',
      TELEGRAM_CHAT_ID: '-100',
      TOPIC_ASSISTANT: '33',
      DB: store,
      RUN_REGISTRY: {
        getByName: () => ({
          has: async (id: string) => id === 'r1',
          consumeNonce: async () => true,
          runInfo: async () => ({ threadId: 77 }),
        }),
      },
    });
  });

  it('deliver: тред прогону, Markdown → HTML + кнопки, доставка одразу', async () => {
    const res = await handleInternal(
      await signedRequest(
        '/internal/deliver',
        { text: '**Готово** ✅ <3', buttons: [[{ text: '↩', callback_data: 'u:1' }]] },
        'n-d1',
      ),
      env,
      NOW,
    );
    expect(res.status).toBe(200);
    // Відповідь - лише факт постановки в чергу; доставку підтверджують sends
    // нижче (без ctx драйн awaited синхронно ще до відповіді).
    expect(await res.json()).toMatchObject({ ok: true, queued: 1 });
    // Модель пише Markdown, у Telegram їде HTML (приймання етапу 4: «**» текстом).
    expect(sends[0]?.body).toMatchObject({
      chat_id: '-100',
      message_thread_id: '77',
      parse_mode: 'HTML',
      text: '<b>Готово</b> ✅ &lt;3',
    });
    expect(sends[0]?.body).not.toHaveProperty('plain_text');
    expect(JSON.stringify(sends[0]?.body.reply_markup)).toContain('u:1');
  });

  it('productionIo аналізу ідеї: «Коротко» Markdown → HTML з кнопками (той самий шлях, що deliver)', async () => {
    const io = productionIo(env, {
      chainId: 'c1',
      ideaId: 'i1',
      runId: 'r1',
      repo: 'svitanok',
      sha: 'a'.repeat(40),
      prevStatus: 'нова',
      chatId: -100,
      threadId: '33',
    });
    await io.send('## Коротко\n- **є** <3', [[{ text: '🔁', callback_data: 'm:ia:i1' }]]);
    expect(sends[0]?.body).toMatchObject({
      chat_id: '-100',
      message_thread_id: '33',
      parse_mode: 'HTML',
      text: '<b>Коротко</b>\n• <b>є</b> &lt;3',
    });
    expect(sends[0]?.body).not.toHaveProperty('plain_text');
    expect(JSON.stringify(sends[0]?.body.reply_markup)).toContain('m:ia:i1');
  });

  it('deliver понад 4096 — кілька частин по порядку (приймання етапу)', async () => {
    const res = await handleInternal(
      await signedRequest('/internal/deliver', { text: 'щось дуже довге '.repeat(700) }, 'n-d2'),
      env,
      NOW,
    );
    const body = (await res.json()) as { queued: number };
    expect(body.queued).toBeGreaterThanOrEqual(3);
    expect(sends).toHaveLength(body.queued);
  });

  // Статус-повідомлення - ЧЕРНЕТКА відповіді (01 §3.1): фінал заміняє її, а не
  // лягає другим повідомленням. До фіксу власник бачив обірваний партіал
  // («2 494,24 (14 672») і повну відповідь окремо - два повідомлення на один
  // запит, причому перше зі зрізаною формулою.
  const envWithDraft = (statusMessageId: number) =>
    workerEnv({
      ASSISTANT_V2: 'shadow',
      INTERNAL_HMAC_KEY: KEY,
      TELEGRAM_BOT_TOKEN: 'bot-t',
      TELEGRAM_CHAT_ID: '-100',
      TOPIC_ASSISTANT: '33',
      DB: store,
      RUN_REGISTRY: {
        getByName: () => ({
          has: async (id: string) => id === 'r1',
          consumeNonce: async () => true,
          runInfo: async () => ({ threadId: 77, statusMessageId }),
        }),
      },
    });

  it('deliver із чернеткою: фінал ЗАМІНЯЄ статусник, другого повідомлення немає', async () => {
    const res = await handleInternal(
      await signedRequest(
        '/internal/deliver',
        { text: '2 494,24 (14 672 × 0,17)', buttons: [[{ text: '↩', callback_data: 'u:1' }]] },
        'n-d4',
      ),
      envWithDraft(629),
      NOW,
    );
    expect(res.status).toBe(200);
    expect(sends).toHaveLength(1);
    expect(sends[0]?.url).toContain('editMessageText');
    expect(sends[0]?.body).toMatchObject({
      message_id: 629,
      text: '2 494,24 (14 672 × 0,17)',
      parse_mode: 'HTML',
    });
    // Кнопки їдуть із фіналом, бо відповідь ціла в чернетці.
    expect(JSON.stringify(sends[0]?.body.reply_markup)).toContain('u:1');
    expect(sends.some((c) => c.url.includes('sendMessage'))).toBe(false);
    // editMessageText адресує повідомлення за id: тема тут зайва (той самий
    // виклик, що робить статусник).
    expect(sends[0]?.body.message_thread_id).toBeUndefined();
  });

  it('деліверу довшого за 4096: перша частина в чернетку, решта - окремі повідомлення', async () => {
    const res = await handleInternal(
      await signedRequest(
        '/internal/deliver',
        {
          text: 'щось дуже довге '.repeat(700),
          buttons: [[{ text: '↩', callback_data: 'u:2' }]],
        },
        'n-d5',
      ),
      envWithDraft(630),
      NOW,
    );
    const body = (await res.json()) as { queued: number };
    expect(body.queued).toBeGreaterThanOrEqual(3);
    expect(sends).toHaveLength(body.queued);
    expect(sends[0]?.url).toContain('editMessageText');
    expect(sends[0]?.body).toMatchObject({ message_id: 630 });
    // Кнопки - на ОСТАННІЙ частині, як і в звичайного send.
    expect(sends[0]?.body.reply_markup).toBeUndefined();
    expect(sends.slice(1).every((c) => c.url.includes('sendMessage'))).toBe(true);
    expect(JSON.stringify(sends.at(-1)?.body.reply_markup)).toContain('u:2');
  });

  it('редагування в той самий текст - успіх, а не ретраї (message is not modified)', async () => {
    // Останній партіал уже дорівнював фіналу: Telegram відповідає 400, і без
    // окремої гілки ряд ішов би в ретраї, а потім у failed - на відповіді,
    // яку власник давно бачить.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        sends.push({
          url,
          body: typeof init?.body === 'string' ? JSON.parse(init.body) : { form: true },
        });
        return new Response(
          JSON.stringify({
            ok: false,
            error_code: 400,
            description: 'Bad Request: message is not modified',
          }),
          { status: 400 },
        );
      }),
    );
    const res = await handleInternal(
      await signedRequest('/internal/deliver', { text: 'вже там' }, 'n-d6'),
      envWithDraft(631),
      NOW,
    );
    expect(res.status).toBe(200);
    const rows = store.raw.prepare('SELECT status, attempts FROM outbox').all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'sent', attempts: 0 });
  });

  it('чернетки вже немає - відповідь іде новим повідомленням, а не зникає', async () => {
    // Власник стер статусник, поки прогін ішов. До фолбеку відповідь просто
    // губилась би: ряд-edit ішов у ретраї й failed, і власник не діставав
    // нічого - гірше, ніж було до фіксу.
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
        calls.push({ url, body });
        if (url.includes('editMessageText')) {
          return new Response(
            JSON.stringify({
              ok: false,
              error_code: 400,
              description: 'Bad Request: message to edit not found',
            }),
            { status: 400 },
          );
        }
        return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }), {
          status: 200,
        });
      }),
    );
    const res = await handleInternal(
      await signedRequest('/internal/deliver', { text: 'відповідь' }, 'n-d7'),
      envWithDraft(632),
      NOW,
    );
    expect(res.status).toBe(200);
    expect(calls[0]?.url).toContain('editMessageText');
    expect(calls[1]?.url).toContain('sendMessage');
    expect(calls[1]?.body).toMatchObject({ text: 'відповідь', message_thread_id: '77' });
    // Службовий прапорець і чужий message_id у Telegram не їдуть.
    expect(calls[1]?.body.message_id).toBeUndefined();
    expect(calls[1]?.body.fallback_send).toBeUndefined();
    const rows = store.raw.prepare('SELECT status FROM outbox').all();
    expect(rows[0]).toMatchObject({ status: 'sent' });
  });

  it('чернетки немає І розмітку відхилено: нове повідомлення їде plain, а не HTML знову', async () => {
    // Ланцюг: edit(HTML) → parse-помилка → edit(plain) → «чернетки немає» →
    // send мусить нести plain (те, що пройшло б), інакше HTML знову впав би.
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
        calls.push({ url, body });
        if (body.parse_mode) {
          return new Response(
            JSON.stringify({ ok: false, description: "Bad Request: can't parse entities" }),
            { status: 400 },
          );
        }
        if (url.includes('editMessageText')) {
          return new Response(
            JSON.stringify({ ok: false, description: 'Bad Request: message to edit not found' }),
            { status: 400 },
          );
        }
        return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }), {
          status: 200,
        });
      }),
    );
    const res = await handleInternal(
      await signedRequest('/internal/deliver', { text: '**відповідь**' }, 'n-d8'),
      envWithDraft(633),
      NOW,
    );
    expect(res.status).toBe(200);
    expect(calls.map((c) => c.url.split('/').pop())).toEqual([
      'editMessageText',
      'editMessageText',
      'sendMessage',
    ]);
    expect(calls[2]?.body).toMatchObject({ text: '**відповідь**' });
    expect(calls[2]?.body.parse_mode).toBeUndefined();
    expect(store.raw.prepare('SELECT status FROM outbox').all()[0]).toMatchObject({
      status: 'sent',
    });
  });

  it('статусний партіал БЕЗ чернетки не перетворюється на нове повідомлення', async () => {
    // Дзеркальний випадок: у статусника прапорця немає, тож застарілий
    // партіал має тихо згаснути, а не лягти в чат окремим повідомленням.
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        return new Response(
          JSON.stringify({
            ok: false,
            error_code: 400,
            description: 'Bad Request: message to edit not found',
          }),
          { status: 400 },
        );
      }),
    );
    await handleInternal(
      await signedRequest('/internal/status', { message_id: 640, text: '▸ Думаю…' }, 'n-s9'),
      envWithDraft(640),
      NOW,
    );
    expect(calls.filter((u) => u.includes('sendMessage'))).toHaveLength(0);
  });

  it('надіслане чергою потрапляє в буфер /clear, відредаговане - ні', async () => {
    // Борг етапу 1: канал outbox не трекався, тож /clear лишав у чаті самі
    // відповіді асистента. Чернетку трекає prerouter при створенні, тож
    // рядок-edit другого запису не додає.
    const kv = new Map<string, string>();
    const envTrack = workerEnv({
      ASSISTANT_V2: 'shadow',
      INTERNAL_HMAC_KEY: KEY,
      TELEGRAM_BOT_TOKEN: 'bot-t',
      TELEGRAM_CHAT_ID: '-100',
      TOPIC_ASSISTANT: '33',
      DB: store,
      BRIEFING: memoryKv(kv),
      RUN_REGISTRY: {
        getByName: () => ({
          has: async (id: string) => id === 'r1',
          consumeNonce: async () => true,
          runInfo: async () => ({ threadId: 77 }),
        }),
      },
    });
    await handleInternal(
      await signedRequest('/internal/deliver', { text: 'нова відповідь' }, 'n-t1'),
      envTrack,
      NOW,
    );
    const tracked = JSON.parse(kv.get('sentMessages') ?? '{}') as Record<
      string,
      { id: number; own: boolean }[]
    >;
    expect(tracked['-100:77']).toEqual([{ id: 5, own: false }]);
  });

  it('deliver з callback_data поза простором 07 §9 — 400 (confused deputy)', async () => {
    const res = await handleInternal(
      await signedRequest(
        '/internal/deliver',
        { text: 'x', buttons: [[{ text: 'Читати далі', callback_data: 'rc:all' }]] },
        'n-d3',
      ),
      env,
      NOW,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('07 §9') });
    expect(sends).toHaveLength(0); // нічого не покладено і не відправлено
  });

  it('status: edit статусника; без TELEGRAM_CHAT_ID — явний 500', async () => {
    const ok = await handleInternal(
      await signedRequest('/internal/status', { message_id: 5, text: '▸ читаю пошту' }, 'n-s1'),
      env,
      NOW,
    );
    expect(ok.status).toBe(200);
    expect(String(sends[0]?.url)).toContain('/editMessageText');

    const bare = workerEnv({
      ASSISTANT_V2: 'shadow',
      INTERNAL_HMAC_KEY: KEY,
      DB: store,
      RUN_REGISTRY: {
        getByName: () => ({ has: async () => true, consumeNonce: async () => true }),
      },
    });
    const fail = await handleInternal(
      await signedRequest('/internal/status', { message_id: 5, text: 'x' }, 'n-s2'),
      bare,
      NOW,
    );
    expect(fail.status).toBe(500);
    expect(await fail.json()).toMatchObject({ error: 'chat-not-configured' });
  });
});
