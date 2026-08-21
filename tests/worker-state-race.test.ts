import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../web/worker.js';
import { memoryKv } from './helpers/kv.js';
import { buildInitData } from './helpers/init-data.js';
import { workerEnv } from './helpers/env.js';

/* C4 — те саме, що `tests/worker-stats-race.test.ts` довів для 'stats', тепер
 * для 'state'.
 *
 * Блоб 'state' пишуть незалежні писарі, яких послідовний прогін крону НЕ
 * ізолює один від одного: вебхук (`lastUpdateId` на КОЖНЕ оновлення Telegram),
 * `/api/*` (jobPrefs, mockWeights, голоси), асистент (roadmapProgress),
 * пропозиції (нагадування). Кожен робив наївний load -> mutate -> put, тож той,
 * хто прочитав раніше, а записав пізніше, затирав чужу зміну ЦІЛИМ блобом.
 *
 * Вікно тут не теоретичне: між читанням і записом у більшості цих шляхів стоять
 * await-и до Telegram і Google — секунди, не мілісекунди.
 *
 * `updateState` (kv-store.mjs) читає двічі й, якщо між читаннями сирий рядок
 * змінився, застосовує ТОЙ САМИЙ patch до свіжішої копії. Тести нижче ставлять
 * конкурентного писаря РІВНО в те вікно, яке цей retry має покривати.
 */

const OWNER = 4242;
const BOT_TOKEN = 'bot-token-abc';
const WEBHOOK_SECRET = 'tg-webhook-secret-abcdef';

let kv: Map<string, string>;

function baseEnv() {
  return workerEnv({
    BRIEFING: memoryKv(kv),
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    TELEGRAM_OWNER_USER_ID: String(OWNER),
    TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
  });
}

/**
 * Оточення, у якому конкурентний писар вклинюється на N-ному читанні 'state'.
 * Запис відбувається ДО того, як читання поверне значення, — тобто саме так,
 * як його побачив би retry: перший рядок один, другий уже інший.
 */
function envWithRacer(onCall: number, write: () => void) {
  const calls = { state: 0 };
  return {
    env: workerEnv({
      ...baseEnv(),
      BRIEFING: {
        get: async (k: string) => {
          if (k === 'state' && ++calls.state === onCall) write();
          return kv.get(k) ?? null;
        },
        put: async (k: string, v: string) => void kv.set(k, v),
        list: async () => ({ keys: [] }),
      },
    }),
    calls,
  };
}

function ctx() {
  const promises: Promise<unknown>[] = [];
  return {
    waitUntil: (p: Promise<unknown>) => void promises.push(p),
    settle: () => Promise.all(promises),
  };
}

beforeEach(() => {
  kv = new Map();
});

describe("updateState — конкурентний писар 'state' не губиться", () => {
  it('подія дашборда (jobPrefs) і паралельна зміна роадмепу виживають обидві', async () => {
    const initData = await buildInitData(OWNER, BOT_TOKEN);
    kv.set('state', JSON.stringify({ jobPrefs: { liked: [], disliked: [] }, roadmapProgress: {} }));

    // Асистент позначає підпункт вивченим у ту саму мить, що дашборд рухає
    // вакансію по воронці. Раніше один із двох записів зникав безслідно.
    const { env, calls } = envWithRacer(2, () =>
      kv.set(
        'state',
        JSON.stringify({
          jobPrefs: { liked: [], disliked: [] },
          roadmapProgress: { 'ts/generics': '2026-08-21T10:00:00.000Z' },
        }),
      ),
    );

    const res = await worker.fetch(
      new Request('https://svitanok.example/api/event', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Telegram-Init-Data': initData },
        body: JSON.stringify({ type: 'job_stage', stage: 'applied', title: 'Senior TS', url: 'u' }),
      }),
      env,
      { waitUntil: () => {} },
    );
    expect(res.status).toBe(200);
    // Рівно два читання 'state' == запис пройшов через updateState, а не через
    // loadState + сирий put (той читав би один раз).
    expect(calls.state).toBe(2);

    const state = JSON.parse(kv.get('state')!);
    // updateJobPrefs зберігає НОРМАЛІЗОВАНІ токени заголовка, не сам рядок.
    expect(state.jobPrefs.liked).toContain('senior'); // наша зміна...
    expect(state.roadmapProgress['ts/generics']).toBeTruthy(); // ...і чужа
  });

  it('вебхук (lastUpdateId) не затирає нагадування, додане в той самий момент', async () => {
    kv.set('state', JSON.stringify({ lastUpdateId: 1, reminders: [] }));

    // Вебхук читає 'state' тричі: перше — дедуп-перевірка lastUpdateId у
    // handleTelegramWebhook (web/worker.js), далі пара всередині updateState.
    // (Резолв callback'а тут 'state' НЕ читає взагалі: `noop:xxx` не парситься,
    // тож resolveCallbackToast виходить на першому ж рядку.)
    //
    // Писар мусить вклинитись саме на ТРЕТЬОМУ — між першим і другим читанням
    // retry. На другому він приїхав би ще ДО patch, і тест проходив би навіть
    // з наївним put, нічого не доводячи.
    const { env, calls } = envWithRacer(3, () =>
      kv.set(
        'state',
        JSON.stringify({
          lastUpdateId: 1,
          reminders: [{ id: 'r1', text: 'подзвонити', whenMs: 1 }],
        }),
      ),
    );

    const c = ctx();
    await worker.fetch(
      new Request('https://svitanok.example/api/telegram', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET,
        },
        body: JSON.stringify({
          update_id: 77,
          callback_query: { id: 'cb1', from: { id: OWNER }, data: 'noop:xxx' },
        }),
      }),
      env,
      c,
    );
    await c.settle();

    const state = JSON.parse(kv.get('state')!);
    expect(state.lastUpdateId).toBe(77); // дедуп оновлень працює...
    expect(state.reminders).toHaveLength(1); // ...і нагадування на місці
    expect(calls.state).toBe(3);
  });
});
