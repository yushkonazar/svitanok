import { memoryKv } from './kv.js';

/* Повний `Env` для тестів (закриття знахідки рев'ю PR #334).
 *
 * ПРОБЛЕМА, ЯКУ ЦЕ ЗАКРИВАЄ. Доти `web/worker-env.d.ts` не входив у кореневу
 * програму, тож імʼя `Env` там не резолвилось і КОЖЕН `@param {Env}` мовчки
 * ставав `any`. Тест міг підсунути обʼєкт із будь-якими полями — включно з
 * помилкою в імені секрету — і `npm run typecheck` лишався зеленим. Тобто
 * найчастіший параметр кожного модуля Worker'а не перевірявся взагалі.
 *
 * ЧОМУ ХЕЛПЕР, А НЕ ПРИВЕДЕННЯ НА МІСЦІ. Тестам не потрібні 25 прив'язок, їм
 * потрібні дві-три. Але `as unknown as Env` у кожному файлі повернуло б рівно
 * те, від чого тікаємо: типи знову перестали б ловити описку в імені. Тут
 * прив'язки-заглушки задані ОДИН раз, а `Partial<Env>` зверху лишається
 * перевіреним — і назви полів, і типи значень.
 */

/**
 * Перекриття для `workerEnv`.
 *
 * ⚠️ СЕКРЕТИ типізовані строго — саме заради них усе це й робиться: описка в
 * імені (`TELEGRAM_BOT_TOKN`) або число замість рядка ловляться компілятором.
 *
 * ⚠️ ПРИВʼЯЗКИ (BRIEFING/ASSETS/AGENT_RUN/SCHEDULER) навмисно `unknown`. Тест
 * підміняє їх власним стабом на дві-три потрібні йому операції; вимагати від
 * такого стаба повний `KVNamespace` (з getWithMetadata і чотирма
 * перевантаженнями `get`) чи повний `DurableObjectStub` означало б імітувати
 * те, чого код не викликає, — і кожен тест однаково втік би в приведення,
 * знявши перевірку заразом і з секретів.
 */
export interface WorkerEnvOverrides extends Partial<
  Omit<
    Env,
    | 'BRIEFING'
    | 'ASSETS'
    | 'AGENT_RUN'
    | 'SCHEDULER'
    | 'RUN_REGISTRY'
    | 'STATE_STORE'
    | 'PENDING_PROPOSALS'
    | 'DB'
    | 'AI'
    | 'VECTORIZE'
  >
> {
  BRIEFING?: unknown;
  ASSETS?: unknown;
  AGENT_RUN?: unknown;
  SCHEDULER?: unknown;
  RUN_REGISTRY?: unknown;
  STATE_STORE?: unknown;
  PENDING_PROPOSALS?: unknown;
  DB?: unknown;
  // AI/VECTORIZE (памʼять, ADR-038) - та сама доктрина, що DB: стаб на одну-дві
  // операції, а не імітація повного інтерфейсу Workers AI/Vectorize.
  AI?: unknown;
  VECTORIZE?: unknown;
}

/**
 * Повний `Env` із стабами прив'язок; `overrides` перекриває що завгодно.
 *
 * Секрети в `Env` опційні (незадана змінна в Cloudflare саме така), тож
 * передавати треба лише ті, від яких залежить перевірюваний шлях.
 */
export function workerEnv(overrides: WorkerEnvOverrides = {}): Env {
  return {
    BRIEFING: memoryKv(new Map()),
    // 404 — те саме, що віддав би справжній ASSETS на невідомий шлях. Кидати
    // тут виняток було б гірше: тести, які повз статику не ходять, падали б на
    // ній випадково.
    ASSETS: { fetch: async () => new Response('not found', { status: 404 }) },
    // AGENT_RUN свідомо НЕ підставляємо: його відсутність — підтримуваний стан
    // (claimAgentStep має фолбек на KV), і саме таким його бачили ці тести доти.
    ...overrides,
  } as Env;
}
