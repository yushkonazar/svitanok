import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
// @ts-expect-error — JS-модуль Worker'а без типів.
import worker from '../web/worker.js';
// @ts-expect-error — JS-модуль Worker'а без типів.
import { mintRunToken } from '../web/agent-run-core.mjs';
// @ts-expect-error — JS-модуль Worker'а без типів.
import { ASSISTANT_HISTORY_TTL_S } from '../web/assistant-memory-core.mjs';

/* Борг (аудит §KV): «жоден ключ не має TTL — нічого не протухає».
 *
 * Для більшості ключів це правильно: `stats` — трекер життя власника, `state` —
 * нагадування й прогрес, вони МАЮТЬ жити вічно. Але два ключі ефемерні за
 * природою й накопичуються без верхньої межі:
 *
 *   briefing:<дата> — копія денного брифінгу (новини/погода/курс). Пишеться
 *     щодня назавжди; за рік — 365 ключів по кілька КБ.
 *   assistantHistory — кілька останніх реплік розмови з асистентом. Переписується
 *     на КОЖНОМУ обміні, тож TTL тут означає «стільки тиші», а не «стільки життя»:
 *     жива розмова його щоразу відсуває.
 *
 * TTL — це і гігієна сховища, і приватність: у розмові з асистентом осідають
 * теми листів і назви подій. */

describe('TTL: історія брифінгів (briefing:<дата>)', () => {
  const yml = readFileSync(new URL('../.github/workflows/brief.yml', import.meta.url), 'utf8');

  it('копія в історію пишеться з expiration_ttl', () => {
    // Ключі пише CI напряму через REST API Cloudflare (не wrangler), тож TTL —
    // це query-параметр на PUT. Перевіряємо саме рядок воркфлову: іншого місця,
    // де цей ключ народжується, немає.
    const historyPut = yml.match(/values\/briefing:\$\{DAY\}[^"\s]*/)?.[0] ?? '';
    expect(historyPut).toContain('expiration_ttl=');
    const ttl = Number(historyPut.match(/expiration_ttl=(\d+)/)?.[1]);
    // Мінімум Cloudflare — 60 с; зверху тримаємо розумну межу, щоб «прибирання»
    // не перетворилось на «зберігаємо роками».
    expect(ttl).toBeGreaterThanOrEqual(60);
    expect(ttl).toBeLessThanOrEqual(400 * 86_400);
  });

  it('`latest` пишеться БЕЗ TTL — це живий payload дашборда', () => {
    // Якби брифінг не згенерувався довше за TTL (відпустка, зламаний CI), ключ
    // просто зник би, і дашборд лишився б порожнім. Протухати має історія, не
    // поточний стан.
    const latestPut = yml.match(/values\/latest[^"\s]*/)?.[0] ?? '';
    expect(latestPut).not.toContain('expiration_ttl');
  });
});

describe('TTL: памʼять розмови (assistantHistory)', () => {
  const HOST_SECRET = 'host-secret-0123456789';
  const WEBHOOK_SECRET = 'worker-only-webhook-secret-xyz';
  let kv: Map<string, string>;
  let putOpts: Map<string, unknown>;

  const env = () => ({
    BRIEFING: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string, opts?: unknown) => {
        kv.set(k, v);
        putOpts.set(k, opts);
      },
      delete: async (k: string) => void kv.delete(k),
      list: async () => ({ keys: [] }),
    },
    LLM_HOST_SECRET: HOST_SECRET,
    TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    TELEGRAM_BOT_TOKEN: 'bot-token',
    TELEGRAM_OWNER_USER_ID: '555',
  });

  beforeEach(() => {
    kv = new Map();
    putOpts = new Map();
    vi.stubGlobal('fetch', async (input: unknown) =>
      String(input).includes('api.telegram.org')
        ? new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        : new Response('{}', { status: 401 }),
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  /** Завершити прогін агента реплікою — саме тут памʼять і пишеться. */
  async function replyStep() {
    await worker.fetch(
      new Request('https://svitanok.example/api/agent-step', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Llm-Host-Secret': HOST_SECRET },
        body: JSON.stringify({
          token: await mintRunToken(WEBHOOK_SECRET, {
            runId: 'run1234',
            chatId: 555,
            userText: 'що в мене завтра?',
          }),
          structured: { action: 'reply', replyText: 'Завтра вільно.' },
        }),
      }),
      env(),
      { waitUntil: () => {}, passThroughOnException: () => {} },
    );
  }

  it('обмін записується з TTL — розмова, покинута надовго, не лежить вічно', async () => {
    await replyStep();
    expect(kv.get('assistantHistory')).toBeTruthy();
    expect(putOpts.get('assistantHistory')).toMatchObject({
      expirationTtl: ASSISTANT_HISTORY_TTL_S,
    });
  });

  it('TTL відсувається кожним новим обміном (жива розмова не зникає посеред себе)', async () => {
    await replyStep();
    await replyStep();
    // Другий запис теж несе TTL — саме це й робить його «стільки тиші»,
    // а не «стільки життя від першої репліки».
    expect(putOpts.get('assistantHistory')).toMatchObject({
      expirationTtl: ASSISTANT_HISTORY_TTL_S,
    });
    expect(ASSISTANT_HISTORY_TTL_S).toBeGreaterThanOrEqual(7 * 86_400); // тиждень тиші — точно не старт
  });

  it('стан і статистика TTL НЕ отримують — це не ефемерні дані', async () => {
    await replyStep();
    for (const key of ['state', 'stats']) {
      expect(putOpts.get(key)).toBeUndefined();
    }
  });
});
