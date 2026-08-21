import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';

/* H7a — ПІНИМО МІСЦЯ ВИКЛИКУ константночасного порівняння, не саму функцію.
 *
 * `constantTimeEqual`/`verifyWebhookSecret` уже покриті в tg-core.test.ts: там
 * доведено, що вони порівнюють без короткого замикання. Незапіненим лишалось
 * інше — чи справді КОЖНА безпекова перевірка йде через них. Одна правка виду
 * `if (computed !== hash)` повернула б витік позиції першого розбіжного байта, і
 * жоден наявний тест цього не помітив би: поведінка «вірний підпис проходить,
 * невірний ні» лишається та сама.
 *
 * Тому тут — два різні твердження про кожне місце:
 *   1. помічник ВИКЛИКАЄТЬСЯ, і саме з тією парою значень, що порівнюється;
 *   2. його результат РІШАЄ — підмінений `true` пускає завідомо невірне
 *      значення, підмінений `false` не пускає завідомо вірне.
 *
 * Друге важливіше за перше: без нього код міг би кликати помічника «для галочки»
 * й ухвалювати рішення окремим `!==`.
 *
 * ⚠️ Мок перехоплює лише МІЖМОДУЛЬНІ виклики. `verifyWebhookSecret` усередині
 * tg-core кличе `constantTimeEqual` напряму, і цей виклик у лічильник не
 * потрапляє — саме тому два шпигуни не змішуються між собою.
 */

const spies = vi.hoisted(() => ({
  constantTimeEqual: vi.fn(),
  verifyWebhookSecret: vi.fn(),
}));

vi.mock('../web/tg-core.mjs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, ...spies };
});

// Імпорти ПІСЛЯ vi.mock — інакше модулі підхоплять справжні функції.
const { constantTimeEqual: realEqual, verifyWebhookSecret: realVerify } =
  await vi.importActual<Record<string, unknown>>('../web/tg-core.mjs');
// @ts-expect-error — JS-модуль Worker'а без типів.
const { validateInitData } = await import('../web/auth-core.mjs');
// @ts-expect-error — JS-модуль Worker'а без типів.
const { default: worker } = await import('../web/worker.js');
// @ts-expect-error — JS-модуль Worker'а без типів.
const { handleAgentStep } = await import('../web/agent-runtime.mjs');

const BOT_TOKEN = '123456:test-bot-token';
const WEBHOOK_SECRET = 'tg-webhook-secret-abcdef';
const HOST_SECRET = 'llm-host-secret-abcdef';

/** initData за алгоритмом Telegram; `hashOverride` — щоб зібрати завідомо невірний. */
function signInitData(hashOverride?: string) {
  const params = { auth_date: String(Math.floor(Date.now() / 1000)), user: '{"id":42}' };
  const dataCheck = Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = hashOverride ?? createHmac('sha256', secret).update(dataCheck).digest('hex');
  return new URLSearchParams({ ...params, hash }).toString();
}

const env = () => ({
  BRIEFING: {
    get: async () => null,
    put: async () => {},
    list: async () => ({ keys: [] }),
  },
  TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
  TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  TELEGRAM_OWNER_USER_ID: '42',
  LLM_HOST_SECRET: HOST_SECRET,
});

const webhookReq = (secretHeader: string, path = '/api/telegram') =>
  new Request(`https://svitanok.example${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': secretHeader,
    },
    body: JSON.stringify({
      update_id: 1,
      message: { message_id: 1, chat: { id: 42 }, text: '/x' },
    }),
  });

const agentStepReq = (secretHeader: string) =>
  new Request('https://svitanok.example/api/agent-step', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Llm-Host-Secret': secretHeader },
    body: JSON.stringify({ token: 'whatever' }),
  });

const ctx = () => ({ waitUntil: () => {} });

beforeEach(() => {
  spies.constantTimeEqual.mockReset().mockImplementation(realEqual as never);
  spies.verifyWebhookSecret.mockReset().mockImplementation(realVerify as never);
});

afterEach(() => vi.restoreAllMocks());

describe('H7a — initData (validateInitData)', () => {
  it('порівняння підпису йде через constantTimeEqual, а не через ===', async () => {
    const initData = signInitData();
    await validateInitData(initData, BOT_TOKEN);

    expect(spies.constantTimeEqual).toHaveBeenCalledTimes(1);
    const [computed, given] = spies.constantTimeEqual.mock.calls[0]!;
    expect(given).toBe(new URLSearchParams(initData).get('hash'));
    expect(computed).toBe(given); // валідний підпис -> обидва боки збігаються
  });

  it('РІШЕННЯ ухвалює саме він: підмінений true пускає невірний підпис', async () => {
    spies.constantTimeEqual.mockReturnValue(true);
    await expect(
      validateInitData(signInitData('00'.repeat(32)), BOT_TOKEN),
    ).resolves.not.toBeNull();
  });

  it('підмінений false не пускає ВІРНИЙ підпис', async () => {
    spies.constantTimeEqual.mockReturnValue(false);
    await expect(validateInitData(signInitData(), BOT_TOKEN)).resolves.toBeNull();
  });
});

describe('H7a — secret-token вебхука (POST /api/telegram)', () => {
  it('перевірка йде через verifyWebhookSecret із заголовком і секретом env', async () => {
    await worker.fetch(webhookReq(WEBHOOK_SECRET), env(), ctx());

    expect(spies.verifyWebhookSecret).toHaveBeenCalledWith(WEBHOOK_SECRET, WEBHOOK_SECRET);
  });

  it('РІШЕННЯ ухвалює саме він: підмінений true пускає чужий заголовок', async () => {
    spies.verifyWebhookSecret.mockReturnValue(true);
    // ASCII: у значення HTTP-заголовка кирилиця не пролазить (ByteString).
    const res = await worker.fetch(webhookReq('wrong-secret'), env(), ctx());
    expect(res.status).toBe(200);
  });

  it('підмінений false відкидає ВІРНИЙ заголовок 401-м', async () => {
    spies.verifyWebhookSecret.mockReturnValue(false);
    const res = await worker.fetch(webhookReq(WEBHOOK_SECRET), env(), ctx());
    expect(res.status).toBe(401);
  });
});

describe('H7a — той самий гейт на /api/telegram/setup', () => {
  it('перевірка йде через verifyWebhookSecret', async () => {
    await worker.fetch(webhookReq(WEBHOOK_SECRET, '/api/telegram/setup'), env(), ctx());

    expect(spies.verifyWebhookSecret).toHaveBeenCalledWith(WEBHOOK_SECRET, WEBHOOK_SECRET);
  });

  it('підмінений false відкидає ВІРНИЙ заголовок 401-м', async () => {
    spies.verifyWebhookSecret.mockReturnValue(false);
    const res = await worker.fetch(webhookReq(WEBHOOK_SECRET, '/api/telegram/setup'), env(), ctx());
    expect(res.status).toBe(401);
  });
});

describe('H7a — секрет LLM-хоста (handleAgentStep)', () => {
  it('перевірка йде через verifyWebhookSecret із секретом ХОСТА, не вебхука', async () => {
    await handleAgentStep(agentStepReq(HOST_SECRET), env());

    expect(spies.verifyWebhookSecret).toHaveBeenCalledWith(HOST_SECRET, HOST_SECRET);
  });

  // ⚠️ Тут перевіряється КОД ПОМИЛКИ, а не сам 401: далі по обробнику стоїть
  // ще один 401 — на відхилений ран-токен, — і тест на голий статус проходив би
  // навіть тоді, коли гейт секрету зовсім прибрати.
  it('підмінений false відкидає ВІРНИЙ заголовок саме як bad-secret', async () => {
    spies.verifyWebhookSecret.mockReturnValue(false);
    const res = await handleAgentStep(agentStepReq(HOST_SECRET), env());
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: 'bad-secret' });
  });

  it('підмінений true пускає чужий заголовок далі — до перевірки токена', async () => {
    spies.verifyWebhookSecret.mockReturnValue(true);
    const res = await handleAgentStep(agentStepReq('wrong-secret'), env());
    const body = (await res.json()) as { error?: string };
    expect(body.error).not.toBe('bad-secret'); // гейт секрету пройдено
  });
});
