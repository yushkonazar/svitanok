// Глобальні типи Worker'а: прив'язки, секрети й ті блоби KV, які поки що не
// мають оголошеної схеми (C1).
//
// НАВІЩО АМБІЄНТНИЙ ФАЙЛ, а не експорти. `Env` іде параметром майже в кожну
// експортовану функцію `web/*.mjs`; якби він жив у модулі, кожен JSDoc починався
// б з `import('./worker-env.d.ts').Env`. Тут файл без import/export, тобто
// скрипт-глобал: імена доступні всюди в цій програмі й ніде поза нею
// (`web/app` — окрема програма зі своїм tsconfig).
//
// ⚠️ Джерело істини для прив'язок — `web/wrangler.jsonc`. Розбіжність між ним і
// цим файлом tsc НЕ побачить: він не читає wrangler-конфіг.

/**
 * Секрет або змінна оточення Worker'а.
 *
 * `undefined` тут — не педантизм: у Cloudflare незадана змінна саме така, і весь
 * код Worker'а вже це перевіряє (`if (!env.LLM_HOST_URL) …`, `?? ''`). Тип
 * `string` натомість тихо погодився б із `fetch(undefined)`.
 */
type WorkerSecret = string | undefined;

interface Env {
  /* ── Прив'язки (wrangler.jsonc) ─────────────────────────────────────── */

  /** KV-неймспейс BRIEFING. Ключі та патерни доступу — `web/kv-store.mjs`. */
  BRIEFING: KVNamespace;
  /** Статика React-дашборда (`web/public`), біндинг `assets`. */
  ASSETS: Fetcher;
  /** Durable Object прогону асистента, клас `AgentRun` (`web/agent-run-do.mjs`). */
  AGENT_RUN: DurableObjectNamespace;

  /* ── Telegram ───────────────────────────────────────────────────────── */

  TELEGRAM_BOT_TOKEN: WorkerSecret;
  /** Куди слати (в супергрупі — груповий id, НЕ id людини). */
  TELEGRAM_CHAT_ID: WorkerSecret;
  /** Єдиний головний власник: право ПИСАТИ (`isPrimaryOwner`). */
  TELEGRAM_OWNER_USER_ID: WorkerSecret;
  /** Читачі, через кому (`allowedUserIds`). */
  TELEGRAM_COOWNER_USER_IDS: WorkerSecret;
  /** Стара назва TELEGRAM_COOWNER_USER_IDS; лишається живою до перейменування секрету. */
  TELEGRAM_ALLOWED_USER_IDS: WorkerSecret;
  TELEGRAM_WEBHOOK_SECRET: WorkerSecret;
  /** Для Direct Link Mini App (`https://t.me/<bot>/app?startapp=…`). */
  TELEGRAM_BOT_USERNAME: WorkerSecret;

  /** Треди forum-супергрупи; опційні — без них повідомлення йде в загальний. */
  TOPIC_BRIEFING: WorkerSecret;
  TOPIC_ASSISTANT: WorkerSecret;
  TOPIC_SYSTEM: WorkerSecret;

  /* ── Зовнішні сервіси ───────────────────────────────────────────────── */

  MINI_APP_URL: WorkerSecret;
  WEATHER_API_KEY: WorkerSecret;
  /**
   * Домашні координати власника: JSON-масив `{lat, lon, name}`. Незаданий —
   * `web/weather-geo.mjs` працює на публічному фолбеку.
   */
  OWNER_LOCATIONS: WorkerSecret;
  GOOGLE_CLIENT_ID: WorkerSecret;
  GOOGLE_CLIENT_SECRET: WorkerSecret;
  GOOGLE_REFRESH_TOKEN: WorkerSecret;
  /** `repository_dispatch` у brief.yml (крон-диспетч брифінгу). */
  GH_DISPATCH_TOKEN: WorkerSecret;

  /** LLM-хост на VPS: `/llm` (синхронний) і `/agent` (прогін асистента). */
  LLM_HOST_URL: WorkerSecret;
  LLM_HOST_AGENT_URL: WorkerSecret;
  LLM_HOST_SECRET: WorkerSecret;

  /** Прапорець маршрутизації наміру нагадувань (`web/commands.mjs`). */
  REMINDER_INTENT_ROUTING: WorkerSecret;
}

/**
 * Блоб KV без оголошеної схеми.
 *
 * ⚠️ Це НЕ «типізовано». Це чесна межа першого етапу C1: `state`, `stats`,
 * `latest`, `settings` — довгоживучі JSON-блоби, які пише ще й оркестратор
 * (`src/**`), тож їхня схема — окремий крок, а не побічний ефект цього.
 * TODO(C1): оголосити схеми блобів і замінити цей псевдонім.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type KvBlob = Record<string, any>;
