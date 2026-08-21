import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../web/worker.js';
import { memoryKv } from './helpers/kv.js';
import { buildInitData } from './helpers/init-data.js';

/* M3 — initData мутацій їде ЗАГОЛОВКОМ, як і в читаннях.
 *
 * Читання (`/api/stats`, `/api/weather`, GET `/api/settings`) від початку
 * автентифікувались через `X-Telegram-Init-Data`, мутації — полем у тілі JSON.
 * Безпечніші від цього мутації не стали й не поменшали: тіло, як і заголовок,
 * не осідає в логах і не тече в Referer (на відміну від query). Проблема інша —
 * до однієї перевірки вело ДВА різні шляхи, і додаючи сьомий ендпоїнт легко
 * взяти не той.
 *
 * Тут перевіряється КОЖНА з шести мутацій, і саме те, що робить цей перехід
 * ризикованим:
 *
 *   1. заголовок працює — інакше новий клієнт отримав би 401 на кожну дію;
 *   2. тіло ВСЕ ЩЕ працює — Mini App кешується у вебвʼю Telegram, і одразу
 *      після релізу стара збірка ще шле поле (фолбек навмисно тимчасовий);
 *   3. заголовок МАЄ пріоритет — це не «підійде будь-який із двох»: биту
 *      автентифікацію в заголовку тіло НЕ рятує.
 *
 * Пункт 3 — головний. Без нього `mutationInitData` могла б непомітно стати
 * «спробуй заголовок, не вийшло — спробуй тіло», а це вже інша перевірка, ніж
 * та, що описана в доці.
 */

const OWNER = 4242;
const STRANGER = 9999;
const BOT_TOKEN = 'bot-token-abc';

let kv: Map<string, string>;

function env() {
  return {
    BRIEFING: { ...memoryKv(kv) },
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    TELEGRAM_OWNER_USER_ID: String(OWNER),
    WEATHER_API_KEY: 'wkey',
  };
}

const SETTINGS = {
  quiet: { enabled: false, from: '22:00', to: '08:00' },
  modules: {},
  mutedTopics: [],
};

/** Шість мутацій, які раніше читали initData з тіла. Тіло — мінімально валідне. */
const MUTATIONS = [
  {
    name: 'POST /api/vote',
    path: '/api/vote',
    method: 'POST',
    body: { category: 'tech', dir: 'up' },
  },
  { name: 'POST /api/event', path: '/api/event', method: 'POST', body: { type: 'open' } },
  {
    name: 'POST /api/settings',
    path: '/api/settings',
    method: 'POST',
    body: { settings: SETTINGS },
  },
  {
    name: 'POST /api/weather/location',
    path: '/api/weather/location',
    method: 'POST',
    body: { lat: 49.84, lon: 24.03, name: 'Львів' },
  },
  {
    name: 'DELETE /api/weather/location',
    path: '/api/weather/location',
    method: 'DELETE',
    body: {},
  },
  {
    name: 'POST /api/weather/locate-prompt',
    path: '/api/weather/locate-prompt',
    method: 'POST',
    body: {},
  },
] as const;

function call(
  m: (typeof MUTATIONS)[number],
  { header, bodyInitData }: { header?: string | null; bodyInitData?: string | null },
) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (header) headers['X-Telegram-Init-Data'] = header;
  const payload = bodyInitData === undefined ? m.body : { ...m.body, initData: bodyInitData };
  return worker.fetch(
    new Request(`https://svitanok.example${m.path}`, {
      method: m.method,
      headers,
      body: JSON.stringify(payload),
    }),
    env(),
    { waitUntil: () => {} },
  );
}

beforeEach(() => {
  kv = new Map();
  // locate-prompt єдиний із шести ходить у мережу (sendMessage власнику);
  // решті стаб не потрібен, але й не заважає.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('M3 — initData мутацій у заголовку', () => {
  for (const m of MUTATIONS) {
    it(`${m.name}: заголовок автентифікує`, async () => {
      const res = await call(m, { header: await buildInitData(OWNER, BOT_TOKEN) });
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ ok: true });
    });

    it(`${m.name}: поле в тілі ще працює (кешована збірка Mini App)`, async () => {
      const res = await call(m, { bodyInitData: await buildInitData(OWNER, BOT_TOKEN) });
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ ok: true });
    });

    it(`${m.name}: заголовок вирішує — тіло НЕ рятує биту автентифікацію`, async () => {
      // Заголовок від чужого, тіло від власника. Якби фолбек спрацьовував на
      // невдачу (а не на відсутність), це проїхало б як 200.
      const res = await call(m, {
        header: await buildInitData(STRANGER, BOT_TOKEN),
        bodyInitData: await buildInitData(OWNER, BOT_TOKEN),
      });
      expect(res.status).toBe(403);
    });

    it(`${m.name}: без обох -> 401`, async () => {
      const res = await call(m, {});
      expect(res.status).toBe(401);
    });
  }
});
