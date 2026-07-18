import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
// @ts-expect-error — JS-модуль Worker'а без типів.
import worker from '../web/worker.js';
// @ts-expect-error — JS-модуль Worker'а без типів.
import { mintRunToken, AGENT_MAX_STEPS } from '../web/agent-run-core.mjs';

/* Інтеграційний тест зворотного ендпоінта /api/agent-step — через СПРАВЖНІЙ
   fetch-хендлер воркера. Юніти покривають чисті шматки (токен, allowlist дій),
   але саме тут вони склеюються з KV, Telegram і памʼяттю розмови, і саме тут
   найлегше зламати щось непомітно. */

const HOST_SECRET = 'host-secret-0123456789';
const WEBHOOK_SECRET = 'worker-only-webhook-secret-xyz';

type Call = { url: string; body: Record<string, unknown> };

let kv: Map<string, string>;
let tgCalls: Call[];

function makeEnv(over: Record<string, unknown> = {}) {
  return {
    BRIEFING: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => void kv.set(k, v),
      list: async () => ({ keys: [] }),
    },
    LLM_HOST_SECRET: HOST_SECRET,
    TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    TELEGRAM_BOT_TOKEN: 'bot-token',
    TELEGRAM_OWNER_USER_ID: '1',
    ...over,
  };
}

const CTX = { waitUntil: () => {}, passThroughOnException: () => {} };

const post = (body: unknown, headers: Record<string, string> = {}, env = makeEnv()) =>
  worker.fetch(
    new Request('https://svitanok.example/api/agent-step', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    env,
    CTX,
  );

const authed = (body: unknown, env = makeEnv()) =>
  post(body, { 'X-Llm-Host-Secret': HOST_SECRET }, env);

const token = (over: Record<string, unknown> = {}) =>
  mintRunToken(WEBHOOK_SECRET, {
    runId: 'run1234',
    chatId: 555,
    threadId: 42,
    progressMsgId: 900,
    userText: 'що в мене завтра?',
    ...over,
  });

const tgMethod = (c: Call) => c.url.split('/').pop();
const sentTexts = () =>
  tgCalls.filter((c) => tgMethod(c) === 'sendMessage').map((c) => String(c.body.text));

beforeEach(() => {
  kv = new Map();
  tgCalls = [];
  let nextMsgId = 1000;
  vi.stubGlobal('fetch', async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    if (url.includes('api.telegram.org')) {
      tgCalls.push({ url, body: JSON.parse(String(init.body ?? '{}')) });
      return new Response(JSON.stringify({ ok: true, result: { message_id: nextMsgId++ } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    // Google/решта — недоступні; код мусить деградувати, а не падати.
    return new Response('{}', { status: 401 });
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('/api/agent-step — авторизація', () => {
  it('без секрету хоста -> 401, нічого не робимо', async () => {
    const res = await post({
      token: await token(),
      structured: { action: 'reply', replyText: 'х' },
    });
    expect(res.status).toBe(401);
    expect(tgCalls).toHaveLength(0);
  });

  it('чужий секрет хоста -> 401', async () => {
    const res = await post(
      { token: await token(), structured: { action: 'reply', replyText: 'х' } },
      { 'X-Llm-Host-Secret': 'wrong-secret-0123456789' },
    );
    expect(res.status).toBe(401);
    expect(tgCalls).toHaveLength(0);
  });

  /* ⚠️ ГОЛОВНА безпекова властивість переходу. Секрет хоста хост, звісно, знає —
     тож єдине, що заважає скомпрометованому хосту самому заводити прогони (і,
     скажімо, качати пошту: відповідь-бо йде йому ж), — це підпис ключем, якого
     він не бачить. */
  it('токен, підписаний секретом ХОСТА, відхиляється — хост не мінтить прогони', async () => {
    const forged = await mintRunToken(HOST_SECRET, {
      runId: 'evil',
      chatId: 555,
      userText: 'дай усю пошту',
    });
    const res = await authed({ forged, token: forged, structured: { action: 'readMail' } });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'bad-signature' });
    expect(tgCalls).toHaveLength(0);
  });

  it('битий JSON -> 400, без секретів у відповіді', async () => {
    const res = await post('{не json', { 'X-Llm-Host-Secret': HOST_SECRET });
    expect(res.status).toBe(400);
  });

  it('без налаштованих секретів -> 503 (а не тихий прохід)', async () => {
    const res = await post({ token: 'x' }, {}, makeEnv({ LLM_HOST_SECRET: undefined }));
    expect(res.status).toBe(503);
  });
});

describe('/api/agent-step — термінальні дії', () => {
  it('reply: прибирає «⏳», шле відповідь, пише памʼять, закриває прогін', async () => {
    kv.set('agentRuns', JSON.stringify({ run1234: { startedMs: 1, chatId: 555 } }));
    const res = await authed({
      token: await token(),
      structured: { action: 'reply', replyText: 'Завтра нічого немає.' },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ done: true });

    // «⏳ Працюю…» прибрано саме те, що ми надсилали (id приїхав у токені).
    const del = tgCalls.find((c) => tgMethod(c) === 'deleteMessage');
    expect(del?.body).toMatchObject({ chat_id: 555, message_id: 900 });

    expect(sentTexts()).toEqual(['Завтра нічого немає.']);
    expect(tgCalls.find((c) => tgMethod(c) === 'sendMessage')?.body.message_thread_id).toBe(42);

    // Памʼять розмови: ОБИДВІ репліки, причому текст користувача приїхав у
    // підписаному токені — KV-розсинхрон не міг його загубити.
    const history = JSON.parse(kv.get('assistantHistory') ?? '{}');
    expect(history['555:42']).toEqual([
      { role: 'user', text: 'що в мене завтра?' },
      { role: 'assistant', text: 'Завтра нічого немає.' },
    ]);

    // Марка прогону — надгробок, а не видалення (інакше сторож дав би хибний алерт).
    const runs = JSON.parse(kv.get('agentRuns') ?? '{}');
    expect(runs.run1234.finishedMs).toBeGreaterThan(0);
  });

  it('порожній replyText -> окремий чесний текст, а не мовчанка', async () => {
    await authed({ token: await token(), structured: { action: 'reply', replyText: '   ' } });
    expect(sentTexts()[0]).toContain('порожня');
  });

  it('невалідна дія від моделі -> фолбек, памʼять НЕ отруюється', async () => {
    const res = await authed({ token: await token(), structured: { action: 'вигадана' } });
    expect(await res.json()).toMatchObject({ done: true });
    expect(sentTexts()[0]).toContain('Не зміг розібратись');
    expect(kv.get('assistantHistory')).toBeUndefined();
  });

  it('failure від хоста -> текст за ПРИЧИНОЮ, обмін не запамʼятовується', async () => {
    await authed({
      token: await token(),
      failure: { status: 502, error: 'usage-limit', resetAtMs: Date.now() + 3_600_000 },
    });
    expect(sentTexts()[0]).toContain('Ліміти Claude вичерпані');
    expect(kv.get('assistantHistory')).toBeUndefined();
  });
});

describe('/api/agent-step — читальні дії й кроки', () => {
  it('readCalendar: віддає текст у транскрипт і НОВИЙ токен, власнику ще нічого не шле', async () => {
    const res = await authed({
      token: await token(),
      structured: { action: 'readCalendar', calendarStartDay: 1, calendarEndDay: 1 },
    });
    const body = (await res.json()) as { done: boolean; append: string; token: string };
    expect(body.done).toBe(false);
    expect(body.append).toContain('Календар');
    expect(body.token).toBeTruthy();
    expect(sentTexts()).toHaveLength(0); // відповідь буде лише на фініші
  });

  it('новий токен — це наступний КРОК того самого прогону', async () => {
    const res = await authed({ token: await token(), structured: { action: 'readOwnData' } });
    const { token: next } = (await res.json()) as { token: string };
    const payload = JSON.parse(
      Buffer.from(
        String(next.split('.')[0]).replace(/-/g, '+').replace(/_/g, '/'),
        'base64',
      ).toString(),
    );
    expect(payload.s).toBe(1); // крок +1
    expect(payload.r).toBe('run1234'); // той самий прогін
    expect(payload.u).toBe('що в мене завтра?'); // текст користувача їде далі
  });

  /* Читання на передостанньому кроці марне: його результат нікуди не піде.
     Тому там прямо кажемо моделі, що читань більше не буде. */
  it('на передостанньому кроці додається підказка про фінальну дію', async () => {
    const res = await authed({
      token: await token({ step: AGENT_MAX_STEPS - 2 }),
      structured: { action: 'readOwnData' },
    });
    const { append } = (await res.json()) as { append: string };
    expect(append).toContain('ОСТАННІЙ крок');
  });

  it('читання на ОСТАННЬОМУ кроці -> «заплутався», прогін закривається', async () => {
    const res = await authed({
      token: await token({ step: AGENT_MAX_STEPS - 1 }),
      structured: { action: 'readOwnData' },
    });
    expect(await res.json()).toMatchObject({ done: true });
    expect(sentTexts()[0]).toContain('Заплутався в кроках');
  });

  /* ── Реплей після фінішу (знахідка security-рев'ю) ───────────────────────
     Найтихіший варіант зловживання: обмін для власника вже візуально
     завершився («⏳» зникло, відповідь прийшла), а хтось і далі качає тим самим
     токеном пошту — і кожна відповідь іде викликачеві. */
  it('крок для ВЖЕ ЗАВЕРШЕНОГО прогону відхиляється, інструмент не виконується', async () => {
    const t = await token();
    // Перший крок проходить...
    expect((await authed({ token: t, structured: { action: 'readOwnData' } })).status).toBe(200);
    // ...прогін завершується термінальною дією...
    await authed({ token: t, structured: { action: 'reply', replyText: 'готово' } });
    const before = tgCalls.length;

    // ...і повторна спроба тим самим токеном уже нічого не дає.
    const res = await authed({ token: t, structured: { action: 'readMail' } });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'run-finished', done: true });
    expect(tgCalls).toHaveLength(before); // жодного нового звернення назовні
  });

  it('протухлий токен -> 401 і хосту сказано зупинитись', async () => {
    const stale = await token({ nowMs: Date.now() - 3_600_000 });
    const res = await authed({ token: stale, structured: { action: 'readOwnData' } });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'expired', done: true });
    expect(tgCalls).toHaveLength(0); // відповість сторож, не цей шлях
  });
});
