import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// @ts-expect-error — JS-модуль Worker'а без типів.
import worker from '../web/worker.js';

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
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => void kv.set(k, v),
      list: async () => ({ keys: [] }),
    },
    TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    TELEGRAM_BOT_TOKEN: 'bot-token',
    TELEGRAM_OWNER_USER_ID: String(OWNER),
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
  it('/locate шле промпт з кнопкою KeyboardButton{request_location:true}', async () => {
    await sendCommand('/locate');

    const sent = lastSend();
    expect(sent?.body.text).toContain('GPS-позицію');
    const markup = sent?.body.reply_markup as { keyboard: unknown[][] };
    expect(markup.keyboard[0]?.[0]).toMatchObject({ request_location: true });
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
