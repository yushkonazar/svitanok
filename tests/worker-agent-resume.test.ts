import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// @ts-expect-error — JS-модуль Worker'а без типів.
import worker from '../web/worker.js';
// @ts-expect-error — JS-модуль Worker'а без типів.
import { mintRunToken } from '../web/agent-run-core.mjs';
// @ts-expect-error — JS-модуль Worker'а без типів.
import { ASSISTANT_RESUME_TTL_MS } from '../web/agent-core.mjs';

/* U3 (аудит §10) — уточнення перестає бути кінцем роботи.
 *
 * Доти модель перепитувала через `reply`: прогін завершувався, і все прочитане
 * (лист, календар) зникало — відповідь власника заходила ХОЛОДНИМ стартом, і
 * ланцюжок збирався заново, спалюючи кроки й підписку. `ask` кладе в слот
 * продовження блокнот моделі (U2), а наступне повідомлення власника заходить
 * уже з ним.
 *
 * Тест іде через ОБИДВА справжні входи воркера — зворотний виклик хоста
 * (/api/agent-step, де народжується `ask`) і вебхук Telegram (де слот
 * споживається), — бо саме на стику цих двох, а не всередині чистих функцій,
 * ця фіча й може мовчки не спрацювати. */

const HOST_SECRET = 'host-secret-0123456789';
const WEBHOOK_SECRET = 'worker-only-webhook-secret-xyz';
const OWNER = 4242;
const HOST = 'https://llm.example/llm';

type Call = { url: string; body: Record<string, unknown> };

let kv: Map<string, string>;
let tg: Call[];
let agentRuns: Call[];

function env(over: Record<string, unknown> = {}) {
  return {
    BRIEFING: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => void kv.set(k, v),
      delete: async (k: string) => void kv.delete(k),
      list: async () => ({ keys: [] }),
    },
    TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    TELEGRAM_BOT_TOKEN: 'bot-token',
    TELEGRAM_CHAT_ID: String(OWNER),
    TELEGRAM_OWNER_USER_ID: String(OWNER),
    LLM_HOST_URL: HOST,
    LLM_HOST_SECRET: HOST_SECRET,
    ...over,
  };
}

function ctx() {
  const promises: Promise<unknown>[] = [];
  return {
    waitUntil: (p: Promise<unknown>) => void promises.push(p),
    passThroughOnException: () => {},
    settle: () => Promise.all(promises),
  };
}

/** Повідомлення власника в чат бота (той самий шлях, що в проді). */
async function sendMessage(text: string, updateId = 1) {
  const c = ctx();
  await worker.fetch(
    new Request('https://svitanok.example/api/telegram', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET,
      },
      body: JSON.stringify({
        update_id: updateId,
        message: { message_id: updateId, chat: { id: OWNER }, from: { id: OWNER }, text },
      }),
    }),
    env(),
    c,
  );
  await c.settle();
}

/** Крок прогону від хоста (той самий шлях, що в проді). */
async function agentStep(structured: Record<string, unknown>, tokenOver = {}) {
  const c = ctx();
  const res = await worker.fetch(
    new Request('https://svitanok.example/api/agent-step', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Llm-Host-Secret': HOST_SECRET },
      body: JSON.stringify({
        token: await mintRunToken(WEBHOOK_SECRET, {
          runId: 'run1234',
          chatId: OWNER,
          threadId: null,
          progressMsgId: 900,
          userText: 'знайди лист від kontramarka і заплануй',
          ...tokenOver,
        }),
        structured,
      }),
    }),
    env(),
    c,
  );
  await c.settle();
  return res;
}

const resumeKey = `assistantResume:${OWNER}:`;
const resumeSlot = () => JSON.parse(kv.get(resumeKey) ?? 'null');
const sentTexts = () =>
  tg.filter((c) => c.url.endsWith('/sendMessage')).map((c) => String(c.body.text ?? ''));
/** Транскрипт, з яким Worker завів прогін на хості. */
const startedTranscript = () => String(agentRuns.at(-1)?.body.transcript ?? '');
/** Claims останнього ран-токена (payload підписаного токена — публічний). */
const startedClaims = () => {
  const token = String(agentRuns.at(-1)?.body.token ?? '');
  const payload = String(token.split('.')[0]).replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(payload, 'base64').toString());
};

beforeEach(() => {
  kv = new Map();
  tg = [];
  agentRuns = [];
  let nextMsgId = 1000;
  vi.stubGlobal('fetch', async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (url.includes('api.telegram.org')) {
      tg.push({ url, body });
      return new Response(JSON.stringify({ ok: true, result: { message_id: nextMsgId++ } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/agent')) {
      agentRuns.push({ url, body });
      return new Response(JSON.stringify({ ok: true }), { status: 202 });
    }
    return new Response('{}', { status: 401 }); // Google/решта — недоступні
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('ask — Worker питає й лишає слот продовження (U3)', () => {
  it('питання доходить до власника, прогін закривається, слот несе нотатку', async () => {
    const res = await agentStep({
      action: 'ask',
      replyText: 'Знайшов лист від kontramarka. На яку годину ставити зустріч?',
      note: 'лист id=abc123, лишилось: створити подію',
    });

    expect(await res.json()).toMatchObject({ done: true });
    expect(sentTexts()[0]).toContain('На яку годину');
    expect(resumeSlot()).toMatchObject({ note: 'лист id=abc123, лишилось: створити подію' });
  });

  it('питання лягає в памʼять розмови (наступний прогін бачить, ПРО ЩО питали)', async () => {
    await agentStep({ action: 'ask', replyText: 'На яку годину?', note: 'подія лишилась' });
    const history = JSON.parse(kv.get('assistantHistory') ?? '{}')[`${OWNER}:`];
    expect(history.at(-1)).toMatchObject({ role: 'assistant', text: 'На яку годину?' });
    expect(history.at(-2)).toMatchObject({ role: 'user' });
  });

  it('ask без нотатки: питання йде, слот НЕ створюється (продовжувати нічим)', async () => {
    await agentStep({ action: 'ask', replyText: 'Уточни, будь ласка?' });
    expect(sentTexts()[0]).toContain('Уточни');
    expect(kv.has(resumeKey)).toBe(false);
  });
});

describe('наступне повідомлення підхоплює слот (U3)', () => {
  it('нотатка їде в транскрипт нового прогону, слот споживається ОДИН раз', async () => {
    await agentStep({
      action: 'ask',
      replyText: 'На яку годину?',
      note: 'лист id=abc123, лишилось: створити подію',
    });

    await sendMessage('на 15:00', 2);
    expect(startedTranscript()).toContain('лист id=abc123');
    expect(startedTranscript()).toContain('на 15:00');
    expect(kv.has(resumeKey)).toBe(false); // одноразовий

    await sendMessage('а ще що там у календарі?', 3);
    expect(startedTranscript()).not.toContain('лист id=abc123');
  });

  it('протухлий слот не воскрешає стару розмову', async () => {
    kv.set(
      resumeKey,
      JSON.stringify({
        note: 'дуже стара нотатка',
        atMs: Date.now() - ASSISTANT_RESUME_TTL_MS - 1,
      }),
    );
    await sendMessage('привіт', 2);
    expect(startedTranscript()).not.toContain('дуже стара нотатка');
    expect(kv.has(resumeKey)).toBe(false); // мертвий слот усе одно прибрано
  });

  /* S2: нотатка складена ПІСЛЯ читання пошти — це переказ тексту, який пише
     стороння людина. Якби продовжений прогін стартував чистим, інʼєкція з
     листа отримала б рівно те, чого їй бракує: прямий запис (createReminder,
     recordAction) наступним кроком. Тож пляма їде разом із нотаткою. */
  it('пляма пошти/Drive переїжджає в продовжений прогін', async () => {
    await agentStep(
      { action: 'ask', replyText: 'Ставити на 15:00?', note: 'з листа: зустріч 15:00' },
      { tainted: true },
    );
    await sendMessage('так', 2);
    expect(startedTranscript()).toContain('з листа: зустріч 15:00');
    expect(startedClaims().x).toBe(1);
  });

  it('без слота прогін стартує як раніше — жодного «продовження» з нічого', async () => {
    await sendMessage('що в мене завтра?', 2);
    expect(startedTranscript()).toContain('що в мене завтра?');
    expect(startedTranscript()).not.toContain('ПРОДОВЖЕННЯ');
    expect(startedClaims().x).toBe(0);
  });
});
