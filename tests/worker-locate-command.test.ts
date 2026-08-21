import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../web/worker.js';
import { memoryKv } from './helpers/kv.js';
import { buildInitData } from './helpers/init-data.js';

/* Інтеграційні тести /locate -> ownerGeoManual (фідбек власника: одноразовий
 * GPS-тап у чаті замість Live Location — фонового ОС-дозволу й 8-годинного
 * ліміту Telegram виявилось забагато для разової звірки позиції). Той самий
 * стиль, що worker-brief-command.test.ts: справжній worker.fetch, стаб
 * fetch+Telegram API. */

const WEBHOOK_SECRET = 'tg-webhook-secret-abcdef';
const OWNER = 4242;

let kv: Map<string, string>;
let tg: { method: string; body: Record<string, unknown> }[];
let openWeatherCalls: string[];

function env(overrides: Record<string, unknown> = {}) {
  return {
    BRIEFING: {
      ...memoryKv(kv),
    },
    TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    TELEGRAM_BOT_TOKEN: 'bot-token',
    TELEGRAM_OWNER_USER_ID: String(OWNER),
    TELEGRAM_CHAT_ID: String(OWNER),
    TOPIC_ASSISTANT: '5',
    WEATHER_API_KEY: 'wkey',
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

/** Той самий HMAC-алгоритм Telegram WebApp initData, що worker.js validateInitData
 *  (потрібен лише для POST /api/weather/locate-prompt — Mini App auth, НЕ
 *  webhook secret-token, яким автентифікуються решта тестів цього файлу). */

async function postLocatePrompt(initData: string | null, e = env()) {
  return worker.fetch(
    new Request('https://svitanok.example/api/weather/locate-prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ initData }),
    }),
    e,
    { waitUntil: () => {} },
  );
}

async function sendUpdate(message: Record<string, unknown>, e = env(), updateId = 1) {
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
        message: { message_id: 1, chat: { id: OWNER }, from: { id: OWNER }, ...message },
      }),
    }),
    e,
    c,
  );
  await c.settle();
}

const sendCommand = (text: string, e = env(), updateId = 1) => sendUpdate({ text }, e, updateId);
const sendLocation = (loc: Record<string, unknown>, e = env(), updateId = 1) =>
  sendUpdate({ location: loc }, e, updateId);

const lastSend = () => [...tg].reverse().find((c) => c.method === 'sendMessage');
const lastSendText = () => lastSend()?.body.text as string | undefined;

beforeEach(() => {
  kv = new Map();
  tg = [];
  openWeatherCalls = [];
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (url.includes('api.telegram.org')) {
      tg.push({ method: url.split('/').pop() ?? '', body });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('api.openweathermap.org')) {
      openWeatherCalls.push(url);
      if (url.includes('/geo/1.0/reverse')) {
        return new Response(JSON.stringify([{ local_names: { uk: 'Рівне' } }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('/locate -> клавіатура з request_location', () => {
  it('/locate написано в приватному чаті -> ОДНЕ повідомлення з кнопкою, У ЦЕЙ САМИЙ чат', async () => {
    await sendCommand('/locate'); // sendCommand шле з chat.id: OWNER (приватний, у цьому файлі)

    const sent = lastSend();
    expect(sent?.body).toMatchObject({ chat_id: String(OWNER) });
    expect(sent?.body.message_thread_id).toBeUndefined();
    expect(sent?.body.text).toContain('GPS-позицію');
    const markup = sent?.body.reply_markup as { keyboard: unknown[][] };
    expect(markup.keyboard[0]?.[0]).toMatchObject({ request_location: true });
    // Той самий чат -> без другого «перевір приват» повідомлення (дублю).
    expect(tg.filter((c) => c.method === 'sendMessage')).toHaveLength(1);
  });

  it('РЕГРЕСІЯ (фідбек власника, прод: «Не вдалося надіслати запит (502)»): /locate написано в ГРУПІ -> промпт іде В ПРИВАТ, у групі лише коротке попередження', async () => {
    const GROUP_CHAT_ID = -1001234567890; // Telegram-групи мають від'ємний chat_id
    await sendUpdate({ text: '/locate', chat: { id: GROUP_CHAT_ID }, message_thread_id: 5 });

    const sends = tg.filter((c) => c.method === 'sendMessage');
    expect(sends).toHaveLength(2); // промпт (приват) + попередження (група)

    // Промпт із кнопкою — у ПРИВАТНИЙ чат (TELEGRAM_OWNER_USER_ID), НЕ в групу:
    // request_location там Bot API відхиляв би (кореневий баг регресії).
    const prompt = sends.find((s) => (s.body.reply_markup as { keyboard: unknown[][] })?.keyboard);
    expect(prompt?.body.chat_id).toBe(String(OWNER));
    expect(prompt?.body.message_thread_id).toBeUndefined();

    // Попередження — туди, звідки й викликали (група+тема), щоб власник знав,
    // де шукати кнопку, а не мовчав.
    const notice = sends.find((s) => s !== prompt);
    // chat_id тут — з parsed.chatId (число, як прийшло від Telegram), не
    // рядок з env-змінної — сам факт "не приват" важливіший за тип.
    expect(notice?.body).toMatchObject({ chat_id: GROUP_CHAT_ID, message_thread_id: 5 });
    expect(notice?.body.text).toContain('приватному чаті');
  });
});

describe('location-повідомлення (тап кнопки) -> ownerGeoManual', () => {
  it('зберігає координати + реверс-геокодовану назву, підтверджує, повертає звичайну клавіатуру', async () => {
    await sendLocation({ latitude: 50.62, longitude: 26.24 });

    expect(JSON.parse(kv.get('ownerGeoManual')!)).toMatchObject({
      lat: 50.62,
      lon: 26.24,
      name: 'Рівне',
    });
    expect(lastSendText()).toContain('Рівне');
    const markup = lastSend()?.body.reply_markup as { keyboard: unknown[][] };
    // Звичайна REPLY_KEYBOARD (текстові лейбли), не locate-клавіатура з request_location.
    expect(markup.keyboard.flat().every((b) => typeof b === 'string')).toBe(true);
  });

  it('немає WEATHER_API_KEY -> фолбек «Твоя локація», координати все одно збережено', async () => {
    await sendLocation({ latitude: 50.62, longitude: 26.24 }, env({ WEATHER_API_KEY: undefined }));

    const saved = JSON.parse(kv.get('ownerGeoManual')!);
    expect(saved).toMatchObject({ lat: 50.62, lon: 26.24, name: 'Твоя локація' });
    expect(openWeatherCalls).toHaveLength(0);
  });

  // Биті координати (NaN/не число) НЕ доходять сюди взагалі — parseUpdate
  // (tg-core.mjs) фільтрує їх до location:null раніше, ніж handleCommand
  // побачить апдейт (tests/tg-core.test.ts: «message з location»).
  it('биті координати -> parsed.location:null, апдейт іде звичайним шляхом (не /locate-обробником)', async () => {
    await sendUpdate({ location: { latitude: Number.NaN, longitude: 26.24 } });

    expect(kv.get('ownerGeoManual')).toBeUndefined();
    // Без тексту й без валідної location -> просто порожній текст обробляється
    // як звичайне повідомлення (заглушка асистента), не /locate-гілка.
    expect(lastSendText()).not.toContain('Позицію оновлено');
  });
});

describe('скасування (LOCATE_CANCEL_LABEL)', () => {
  it('повертає звичайну клавіатуру, НЕ чіпає ownerGeoManual', async () => {
    await sendCommand('⬅️ Скасувати');

    expect(kv.get('ownerGeoManual')).toBeUndefined();
    expect(lastSendText()).toContain('без змін');
    const markup = lastSend()?.body.reply_markup as { keyboard: string[][] };
    expect(markup.keyboard[0]?.[0]).toBe('📅 Сьогодні'); // REPLY_KEYBOARD, не locate-клавіатура
  });
});

describe('POST /api/weather/locate-prompt — тригер із Mini App', () => {
  it('без initData -> 401', async () => {
    const res = await postLocatePrompt(null);
    expect(res.status).toBe(401);
  });

  it('чужий user id -> 403', async () => {
    const initData = await buildInitData(9999, 'bot-token');
    const res = await postLocatePrompt(initData);
    expect(res.status).toBe(403);
  });

  it('успіх -> шле ТОЙ САМИЙ /locate-промпт У ПРИВАТНИЙ чат (TELEGRAM_OWNER_USER_ID), БЕЗ message_thread_id', async () => {
    const initData = await buildInitData(OWNER, 'bot-token');
    const res = await postLocatePrompt(initData);
    expect(res.status).toBe(200);

    const sent = lastSend();
    // РЕГРЕСІЯ (прод, фідбек власника: «Не вдалося надіслати запит (502)»):
    // request_location недоступний у груповому чаті (TOPIC_ASSISTANT) — Bot
    // API відхиляв sendMessage із такою клавіатурою. Приватний чат
    // (chat_id=TELEGRAM_OWNER_USER_ID) не має тем, тож message_thread_id
    // тут БУТИ НЕ МАЄ — присутність цього поля й була кореневою причиною.
    expect(sent?.body).toMatchObject({ chat_id: String(OWNER) });
    expect(sent?.body.message_thread_id).toBeUndefined();
    expect(sent?.body.text).toContain('GPS-позицію');
    const markup = sent?.body.reply_markup as { keyboard: unknown[][] };
    expect(markup.keyboard[0]?.[0]).toMatchObject({ request_location: true });
  });

  /* Регресія, знайдена рев'ю PR #334.
   *
   * Доки initData їхав у ТІЛІ, GET сюди не проходив сам собою: тіла в нього
   * немає, автентифікація не складалась, відповідь була 401 — тобто метод
   * гейтився випадково, побічним ефектом місця, звідки читали initData.
   * Після переносу в заголовок (M3) той самий GET став валідним, і побічна
   * дія — бот шле власнику повідомлення — поїхала б на методі, який усі
   * вважають читанням: превʼю посилання, префетч, повтор із девтулзів.
   *
   * Перевіряємо не лише статус, а й що Telegram НЕ смикнули: 405 із уже
   * надісланим повідомленням був би найгіршим варіантом — виглядає як відмова,
   * а дія сталась. */
  for (const method of ['GET', 'HEAD', 'PUT', 'DELETE'] as const) {
    it(`${method} із валідним заголовком власника -> 405 і ЖОДНОГО sendMessage`, async () => {
      const initData = await buildInitData(OWNER, 'bot-token');
      const res = await worker.fetch(
        new Request('https://svitanok.example/api/weather/locate-prompt', {
          method,
          headers: { 'X-Telegram-Init-Data': initData },
        }),
        env(),
        { waitUntil: () => {} },
      );
      expect(res.status).toBe(405);
      expect(lastSend()).toBeUndefined();
    });
  }

  it('POST без тіла (саме так шле клієнт) -> 200, автентифікація заголовком', async () => {
    // Клієнт після M3 не шле тіла взагалі; серверні тести вище шлють `{}`,
    // тобто гілку, якою прод не ходить. Ця перевіряє реальну форму запиту.
    const initData = await buildInitData(OWNER, 'bot-token');
    const res = await worker.fetch(
      new Request('https://svitanok.example/api/weather/locate-prompt', {
        method: 'POST',
        headers: { 'X-Telegram-Init-Data': initData },
      }),
      env(),
      { waitUntil: () => {} },
    );
    expect(res.status).toBe(200);
    expect(lastSend()?.body).toMatchObject({ chat_id: String(OWNER) });
  });

  it('Telegram sendMessage повернув помилку -> 502, не тихий «ok:true»', async () => {
    vi.stubGlobal('fetch', async (input: unknown) => {
      if (String(input).includes('api.telegram.org')) return new Response('down', { status: 500 });
      return new Response('{}', { status: 200 });
    });
    const initData = await buildInitData(OWNER, 'bot-token');
    const res = await postLocatePrompt(initData);
    expect(res.status).toBe(502);
  });
});
