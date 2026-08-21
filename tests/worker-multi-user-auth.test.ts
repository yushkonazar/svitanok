import { describe, it, expect, beforeEach, vi } from 'vitest';
import worker from '../web/worker.js';
import { memoryKv } from './helpers/kv.js';
import { buildInitData } from './helpers/init-data.js';

/* TELEGRAM_ALLOWED_USER_IDS (кілька учасників супергрупи можуть користуватись
 * тим самим ботом/Mini App) — перевіряємо ОБИДВА шляхи авторизації, які
 * читають цей список: вебхук (isOwner, tg-core.mjs) і Mini App (checkOwner,
 * worker.js). Той самий стиль харнесу, що worker-agent-command.test.ts
 * (вебхук) + worker-weather.test.ts (initData). */

const WEBHOOK_SECRET = 'tg-webhook-secret-abcdef';
const OWNER = 4242;
const FRIEND = 5151;
const STRANGER = 9999;
const BOT_TOKEN = 'bot-token-abc';

let kv: Map<string, string>;
let tg: { method: string; body: Record<string, unknown> }[];

function env(overrides: Record<string, unknown> = {}) {
  return {
    BRIEFING: {
      ...memoryKv(kv),
    },
    TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    TELEGRAM_OWNER_USER_ID: String(OWNER),
    ...overrides,
  };
}

function ctx() {
  const promises: Promise<unknown>[] = [];
  return {
    waitUntil: (p: Promise<unknown>) => void promises.push(p),
    settle: () => Promise.all(promises),
  };
}

async function sendCommand(fromId: number, text: string, e = env(), updateId = 1) {
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
        message: { message_id: 1, chat: { id: fromId }, from: { id: fromId }, text },
      }),
    }),
    e,
    c,
  );
  await c.settle();
}

/** Той самий HMAC-алгоритм Telegram WebApp initData, що worker.js validateInitData. */

async function getStats(initData: string, e: Record<string, unknown>) {
  return worker.fetch(
    new Request('https://svitanok.example/api/stats', {
      headers: { 'X-Telegram-Init-Data': initData },
    }),
    e,
    { waitUntil: () => {} },
  );
}

beforeEach(() => {
  kv = new Map();
  tg = [];
  vi.stubGlobal('fetch', async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    if (url.includes('api.telegram.org')) {
      tg.push({ method: url.split('/').pop()!, body: JSON.parse(String(init.body ?? '{}')) });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', { status: 200 });
  });
});

describe('вебхук — TELEGRAM_ALLOWED_USER_IDS', () => {
  it('без TELEGRAM_ALLOWED_USER_IDS — інший учасник тихо ігнорується (як і зараз)', async () => {
    await sendCommand(FRIEND, '/help');
    expect(tg).toHaveLength(0);
  });

  it('з TELEGRAM_ALLOWED_USER_IDS — учасник зі списку отримує відповідь', async () => {
    await sendCommand(FRIEND, '/help', env({ TELEGRAM_ALLOWED_USER_IDS: String(FRIEND) }));
    expect(tg.length).toBeGreaterThan(0);
  });

  it('з TELEGRAM_ALLOWED_USER_IDS — сторонній (не в списку) і далі тихо ігнорується', async () => {
    await sendCommand(
      STRANGER,
      '/help',
      env({ TELEGRAM_ALLOWED_USER_IDS: `${FRIEND},${STRANGER + 1}` }),
    );
    expect(tg).toHaveLength(0);
  });

  it('власник лишається дозволеним НАВІТЬ коли TELEGRAM_ALLOWED_USER_IDS заданий', async () => {
    await sendCommand(OWNER, '/help', env({ TELEGRAM_ALLOWED_USER_IDS: String(FRIEND) }));
    expect(tg.length).toBeGreaterThan(0);
  });

  it('декілька id через кому (з пробілами) — усі розпізнаються', async () => {
    await sendCommand(FRIEND, '/help', env({ TELEGRAM_ALLOWED_USER_IDS: ` ${FRIEND} , 777 ` }));
    expect(tg.length).toBeGreaterThan(0);
  });
});

describe('Mini App (/api/stats) — TELEGRAM_ALLOWED_USER_IDS', () => {
  it('без TELEGRAM_ALLOWED_USER_IDS — 403 для не-власника', async () => {
    const initData = await buildInitData(FRIEND, BOT_TOKEN);
    const res = await getStats(initData, env());
    expect(res.status).toBe(403);
  });

  it('з TELEGRAM_ALLOWED_USER_IDS — 200 для учасника зі списку', async () => {
    const initData = await buildInitData(FRIEND, BOT_TOKEN);
    const res = await getStats(initData, env({ TELEGRAM_ALLOWED_USER_IDS: String(FRIEND) }));
    expect(res.status).toBe(200);
  });

  it('з TELEGRAM_ALLOWED_USER_IDS — 403 для стороннього поза списком', async () => {
    const initData = await buildInitData(STRANGER, BOT_TOKEN);
    const res = await getStats(initData, env({ TELEGRAM_ALLOWED_USER_IDS: String(FRIEND) }));
    expect(res.status).toBe(403);
  });
});

/* S1/B1 (аудит 11.08.2026, 🔴 HIGH): «multi-user» насправді означав CO-OWNER, а
 * не гостя. Другий id зі списку читав пошту й настрій власника, перезаписував
 * його settings і гео, приймав його календарні пропозиції й ЗАПУСКАВ агента
 * проти його Gmail — рівно з тими самими правами, що власник.
 *
 * Розділення ролей: `allowedUserIds` лишається для ЧИТАННЯ (дашборд), а
 * будь-яка мутація стану власника й агент вимагають ГОЛОВНОГО власника
 * (TELEGRAM_OWNER_USER_ID). Нижче — обидві сторони межі. */

async function postJson(path: string, body: unknown, e: Record<string, unknown>, method = 'POST') {
  return worker.fetch(
    new Request(`https://svitanok.example${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    e,
    { waitUntil: () => {} },
  );
}

// ОБИДВІ назви змінної — щоб тести на межу ролей були червоними ВЖЕ ЗАРАЗ
// (за старою назвою co-owner уже дозволений), а не «зеленими» лише тому, що
// нову назву код ще не читає. Перейменування перевіряється окремим блоком нижче.
const coOwnerEnv = (over: Record<string, unknown> = {}) =>
  env({
    TELEGRAM_COOWNER_USER_IDS: String(FRIEND),
    TELEGRAM_ALLOWED_USER_IDS: String(FRIEND),
    ...over,
  });

const FULL_SETTINGS = { quiet: { from: 22, to: 8 }, modules: {} };

describe('розділення ролей — co-owner ЧИТАЄ, але не мутує (S1/B1)', () => {
  it('дашборд лишається доступним co-owner (це й був сенс списку)', async () => {
    const res = await getStats(await buildInitData(FRIEND, BOT_TOKEN), coOwnerEnv());
    expect(res.status).toBe(200);
  });

  it('POST /api/settings — co-owner 403, власник 200', async () => {
    const e = coOwnerEnv();
    const friend = await postJson(
      '/api/settings',
      { initData: await buildInitData(FRIEND, BOT_TOKEN), settings: FULL_SETTINGS },
      e,
    );
    expect(friend.status).toBe(403);
    // ...і блоб у KV НЕ зʼявився: 403 має бути ДО запису, а не після.
    expect(kv.get('settings')).toBeUndefined();

    const owner = await postJson(
      '/api/settings',
      { initData: await buildInitData(OWNER, BOT_TOKEN), settings: FULL_SETTINGS },
      e,
    );
    expect(owner.status).toBe(200);
  });

  it('POST /api/weather/location — co-owner не перезаписує гео власника (S5)', async () => {
    const e = coOwnerEnv();
    const res = await postJson(
      '/api/weather/location',
      { initData: await buildInitData(FRIEND, BOT_TOKEN), lat: 50.45, lon: 30.52, name: 'Київ' },
      e,
    );
    expect(res.status).toBe(403);
    expect(kv.get('ownerGeoManual')).toBeUndefined();
  });

  it('POST /api/event — co-owner не пише чек-ін у статистику власника', async () => {
    const res = await postJson(
      '/api/event',
      { initData: await buildInitData(FRIEND, BOT_TOKEN), type: 'open' },
      coOwnerEnv(),
    );
    expect(res.status).toBe(403);
    expect(kv.get('stats')).toBeUndefined();
  });

  it('POST /api/vote — co-owner не зсуває ваги тем власника', async () => {
    const res = await postJson(
      '/api/vote',
      { initData: await buildInitData(FRIEND, BOT_TOKEN), category: 'Технології', dir: 'up' },
      coOwnerEnv(),
    );
    expect(res.status).toBe(403);
    expect(kv.get('state')).toBeUndefined();
  });
});

describe('розділення ролей — Telegram: агент і команди власника (S1/B1)', () => {
  const agentEnv = (over: Record<string, unknown> = {}) =>
    coOwnerEnv({
      LLM_HOST_URL: 'https://llm.example/llm',
      LLM_HOST_SECRET: 'host-secret',
      TELEGRAM_CHAT_ID: String(OWNER),
      ...over,
    });

  it('вільний текст co-owner НЕ запускає агента проти Gmail власника', async () => {
    const e = agentEnv();
    await sendCommand(FRIEND, 'знайди листи про співбесіди за тиждень', e);

    // Жодного виклику хоста — саме це й було найгіршим сценарієм S1.
    expect(tg.some((c) => String(c.body.text ?? '').includes('Працюю'))).toBe(false);
  });

  it('/brief co-owner не запускає прогін брифінгу', async () => {
    await sendCommand(FRIEND, '/brief', agentEnv({ GH_DISPATCH_TOKEN: 'gh' }), 2);
    expect(tg.some((c) => String(c.body.text ?? '').includes('Запустив генерацію'))).toBe(false);
  });

  it('власник тими самими командами користується як раніше', async () => {
    await sendCommand(OWNER, '/help', agentEnv(), 3);
    expect(tg.filter((c) => c.method === 'sendMessage')).not.toHaveLength(0);
  });
});

describe('перейменування змінної (TELEGRAM_COOWNER_USER_IDS)', () => {
  it('нова назва працює сама по собі', async () => {
    const res = await getStats(
      await buildInitData(FRIEND, BOT_TOKEN),
      env({ TELEGRAM_COOWNER_USER_IDS: String(FRIEND) }),
    );
    expect(res.status).toBe(200);
  });

  it('стара назва теж (секрети живуть у двох місцях — рвати доступ на деплої не можна)', async () => {
    const res = await getStats(
      await buildInitData(FRIEND, BOT_TOKEN),
      env({ TELEGRAM_ALLOWED_USER_IDS: String(FRIEND) }),
    );
    expect(res.status).toBe(200);
  });
});

describe('розділення ролей — межа проходить по МУТАЦІЯХ, не по всьому боту', () => {
  it('читальні команди co-owner працюють (/stats, /reminders, /settings)', async () => {
    const e = coOwnerEnv();
    for (const [i, cmd] of ['/stats', '/reminders', '/settings'].entries()) {
      tg = [];
      await sendCommand(FRIEND, cmd, e, 100 + i);
      const texts = tg.filter((c) => c.method === 'sendMessage').map((c) => String(c.body.text));
      expect(texts.length, cmd).toBeGreaterThan(0);
      expect(texts.join(' '), cmd).not.toContain('лише власнику');
    }
  });

  it('/remind co-owner не створює нагадування у стані власника', async () => {
    await sendCommand(FRIEND, '/remind купити молоко о 18:00', coOwnerEnv(), 110);
    // 'state' сам по собі зʼявиться (туди пишеться lastUpdateId дедупу) —
    // важливо, що в ньому НЕМАЄ нагадувань.
    expect(JSON.parse(kv.get('state') ?? '{}').reminders).toBeUndefined();
    expect(tg.some((c) => String(c.body.text ?? '').includes('лише власнику'))).toBe(true);
  });

  it('кнопка (callback) від co-owner нічого не мутує — лише тост', async () => {
    const c = ctx();
    await worker.fetch(
      new Request('https://svitanok.example/api/telegram', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET,
        },
        body: JSON.stringify({
          update_id: 120,
          callback_query: {
            id: 'cb1',
            from: { id: FRIEND },
            data: 'sl:start', // «🌙 Ліг спати» — пише в sleepLog власника
            message: { message_id: 5, chat: { id: OWNER } },
          },
        }),
      }),
      coOwnerEnv(),
      c,
    );
    await c.settle();

    expect(kv.get('stats')).toBeUndefined();
    const answer = tg.find((x) => x.method === 'answerCallbackQuery');
    expect(String(answer?.body.text ?? '')).toContain('Лише власник');
  });
});

/* Стеля тіла вебхука — регресія, знайдена рев'ю PR #334.
 *
 * Спільна стеля 16 КБ менша за максимальний ЗАКОННИЙ апдейт Telegram: текст до
 * 4096 символів, кирилиця в UTF-8 — два байти на літеру, і якщо повідомлення є
 * ВІДПОВІДДЮ, у тому ж апдейті їде вкладений reply_to_message такого самого
 * розміру. Бот віддавав би 413, Telegram кілька разів повторив би доставку й
 * зрештою кинув її — повідомлення власника не оброблялось би взагалі, тихо.
 *
 * Перевіряємо саме МАРШРУТ, а не readJsonBody: одиничний тест на функцію не
 * помітив би, що worker.js забув передати їй окрему стелю.
 */
describe('вебхук приймає максимальний законний апдейт Telegram', () => {
  const longCyrillic = 'я'.repeat(4096);

  it('reply на довге кириличне повідомлення (>16КБ) обробляється, а не 413', async () => {
    const body = JSON.stringify({
      update_id: 501,
      message: {
        message_id: 2,
        chat: { id: OWNER },
        from: { id: OWNER },
        text: longCyrillic,
        reply_to_message: { message_id: 1, chat: { id: OWNER }, text: longCyrillic },
      },
    });
    expect(new TextEncoder().encode(body).length).toBeGreaterThan(16 * 1024);

    const c = ctx();
    const res = await worker.fetch(
      new Request('https://svitanok.example/api/telegram', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET,
        },
        body,
      }),
      env(),
      c,
    );
    await c.settle();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    // Апдейт реально дійшов до обробки: дедуп записав його id.
    expect(JSON.parse(kv.get('state') ?? '{}').lastUpdateId).toBe(501);
  });

  it('справді величезне тіло (понад 128КБ) вебхук усе одно відкидає', async () => {
    const res = await worker.fetch(
      new Request('https://svitanok.example/api/telegram', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET,
        },
        body: JSON.stringify({ update_id: 502, pad: 'я'.repeat(70_000) }),
      }),
      env(),
      ctx(),
    );
    expect(res.status).toBe(413);
  });
});
