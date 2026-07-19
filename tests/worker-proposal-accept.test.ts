import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// @ts-expect-error — JS-модуль Worker'а без типів.
import worker from '../web/worker.js';

/* Регресія на прод-баг 19.07: пропозиція асистента (✅/❌) жила в блобі 'state',
   і наївні писарі 'state' (lastUpdateId у вебхуку, крон, дашборд) БЕЗ
   read-your-writes затирали її — кожен ✅ падав у «Застаріла пропозиція».
   Фікс: пропозиція у ВЛАСНОМУ KV-ключі 'assistantPending'. Тут перевіряємо, що
   вона переживає затирання блоба 'state', і що legacy-фолбек (брифінг ще пише
   в блоб) працює. */

const WEBHOOK_SECRET = 'tg-webhook-secret-abcdef';
const OWNER = 4242;

let kv: Map<string, string>;
let tg: { method: string; body: Record<string, unknown> }[];

function env() {
  return {
    BRIEFING: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => void kv.set(k, v),
      list: async () => ({ keys: [] }),
    },
    TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    TELEGRAM_BOT_TOKEN: 'bot-token',
    TELEGRAM_OWNER_USER_ID: String(OWNER),
  };
}

/** CTX, чий waitUntil РЕАЛЬНО тримає проміси — вебхук обробляє апдейт у фоні. */
function ctx() {
  const promises: Promise<unknown>[] = [];
  return {
    waitUntil: (p: Promise<unknown>) => void promises.push(p),
    settle: () => Promise.all(promises),
  };
}

const acceptUpdate = (id: string, updateId = 1000) => ({
  update_id: updateId,
  callback_query: {
    id: 'cbq1',
    from: { id: OWNER },
    data: `pd:a:${id}`,
    message: {
      message_id: 555,
      chat: { id: OWNER },
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Прийняти', callback_data: `pd:a:${id}` },
            { text: '❌ Скасувати', callback_data: `pd:c:${id}` },
          ],
        ],
      },
    },
  },
});

const pending = (id: string) => ({
  id,
  createdMs: Date.now(),
  items: [{ kind: 'reminder', title: 'купити квитки', whenMs: Date.now() + 3_600_000 }],
});

async function postAccept(id: string, e = env()) {
  const c = ctx();
  await worker.fetch(
    new Request('https://svitanok.example/api/telegram', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET,
      },
      body: JSON.stringify(acceptUpdate(id)),
    }),
    e,
    c,
  );
  await c.settle(); // дочекатись фонової обробки (resolveProposalCallback)
}

const toast = () =>
  tg.find((c) => c.method === 'answerCallbackQuery')?.body.text as string | undefined;

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

afterEach(() => vi.unstubAllGlobals());

describe('accept пропозиції — власний KV-ключ переживає затирання блоба state', () => {
  it('пропозиція у власному ключі -> ✅ приймається, НЕ «Застаріла»', async () => {
    kv.set('assistantPending', JSON.stringify(pending('abc12345')));
    await postAccept('abc12345');
    expect(toast()).toContain('Додано');
    expect(toast()).not.toContain('Застаріла');
    // Списано (тумбстоун), тож повторний тап уже стане «Застаріла».
    expect(kv.get('assistantPending')).toBe('null');
  });

  it('РЕГРЕСІЯ: наївний писар затер блоб state, але пропозиція вціліла у власному ключі', async () => {
    kv.set('assistantPending', JSON.stringify(pending('abc12345')));
    // Симулюємо клобер: писар 'state' (напр. lastUpdateId) записав блоб БЕЗ
    // assistantPending. До фіксу це «з'їдало» пропозицію -> «Застаріла».
    kv.set('state', JSON.stringify({ lastUpdateId: 5, reminders: [] }));
    await postAccept('abc12345');
    expect(toast()).toContain('Додано');
    expect(toast()).not.toContain('Застаріла');
  });

  it('legacy-фолбек: пропозиція лише в блобі state (брифінг) -> теж приймається', async () => {
    kv.set('state', JSON.stringify({ reminders: [], assistantPending: pending('legacy99') }));
    await postAccept('legacy99');
    expect(toast()).toContain('Додано');
    // Legacy-слот прибрано з блоба.
    const st = JSON.parse(kv.get('state')!);
    expect(st.assistantPending).toBeUndefined();
  });

  it('чужий/відсутній id -> «Застаріла пропозиція»', async () => {
    kv.set('assistantPending', JSON.stringify(pending('realid00')));
    await postAccept('WRONGid0');
    expect(toast()).toContain('Застаріла');
  });
});
