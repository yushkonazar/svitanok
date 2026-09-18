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
  BRIEFING: import('@cloudflare/workers-types').KVNamespace;
  /** Статика React-дашборда (`web/public`), біндинг `assets`. */
  ASSETS: import('@cloudflare/workers-types').Fetcher;
  /**
   * Durable Object прогону асистента (`web/agent-run-do.mjs`).
   *
   * Клас у параметрі — не церемонія: без нього стаб має лише базові методи, і
   * виклики `claimStep`/`finish` не перевіряються взагалі.
   *
   * ⚠️ ОПЦІЙНИЙ навмисно. `claimAgentStep` явно передбачає відсутність прив'язки
   * (`typeof ns?.getByName !== 'function'` -> надгробок лишається best-effort у
   * KV): запобіжник углиб не має валити асистента, якщо DO не привʼязано.
   * Оголосити його обовʼязковим означало б, що цей шлях недосяжний, — а він
   * досяжний і перевіряється тестами.
   */
  AGENT_RUN?: import('@cloudflare/workers-types').DurableObjectNamespace<
    import('./agent-run-do.mjs').AgentRun
  >;
  /**
   * D1 нового асистента (редизайн, етап 1; схема — final/07-schema §1).
   * Опційний з тієї ж причини, що AGENT_RUN: незадана привʼязка в рантаймі —
   * `undefined`, і код зобовʼязаний падати явно, а не типово-тихо.
   */
  DB?: import('@cloudflare/workers-types').D1Database;
  /**
   * Durable Object планувальника (`web/core/scheduler/do.mjs`, етап 1, PR-2).
   * Опційний, але на відміну від AGENT_RUN відсутність при ввімкненому
   * прапорці — помилка конфігурації, і schedulerWatchdog каже про це вголос.
   */
  SCHEDULER?: import('@cloudflare/workers-types').DurableObjectNamespace<
    import('./core/scheduler/do.mjs').SchedulerDO
  >;
  /**
   * Durable Object реєстру прогонів (`web/core/run-registry/do.mjs`, етап 1,
   * PR-4). Опційний; при ввімкненому прапорці відсутність — помилка
   * конфігурації, клієнт (client.mjs) каже про це вголос.
   */
  RUN_REGISTRY?: import('@cloudflare/workers-types').DurableObjectNamespace<
    import('./core/run-registry/do.mjs').RunRegistryDO
  >;
  /**
   * Канонічний state/stats store. На відміну від KV, цей singleton дає
   * versioned compare-and-set для конкурентних webhook/cron/Mini App writes.
   * Опційний лише для локальних тестів та rollback-коду без нового binding.
   */
  STATE_STORE?: import('@cloudflare/workers-types').DurableObjectNamespace<
    import('./core/state-store/do.mjs').StateStoreDO
  >;
  /** Один атомарний slot pending-пропозиції: claim перед Calendar/Contacts
   * має бути серіалізований, бо KV не здатний гарантувати single-consumer. */
  PENDING_PROPOSALS?: import('@cloudflare/workers-types').DurableObjectNamespace<
    import('./core/pending-proposals/do.mjs').PendingProposalsDO
  >;
  /** Atomic per-chat ring buffer для /clear; KV mirror не є source of truth. */
  SENT_MESSAGES?: import('@cloudflare/workers-types').DurableObjectNamespace<
    import('./core/sent-messages/do.mjs').SentMessagesDO
  >;
  /** Short per-thread assistant context, canonical with a 30-day DO alarm TTL. */
  ASSISTANT_HISTORY?: import('@cloudflare/workers-types').DurableObjectNamespace<
    import('./core/assistant-history/do.mjs').AssistantHistoryDO
  >;
  /** Atomic single-consumer slots for short agent clarification continuations. */
  ASSISTANT_RESUME?: import('@cloudflare/workers-types').DurableObjectNamespace<
    import('./core/assistant-resume/do.mjs').AssistantResumeDO
  >;
  /** Atomic daily reservation before live OpenWeather calls. */
  WEATHER_QUOTA?: import('@cloudflare/workers-types').DurableObjectNamespace<
    import('./core/weather-quota/do.mjs').WeatherQuotaDO
  >;
  /** Atomic admission control before persisting an inbound Business message. */
  INBOX_QUOTA?: import('@cloudflare/workers-types').DurableObjectNamespace<
    import('./core/inbox-quota/do.mjs').InboxQuotaDO
  >;
  /** Atomic VPS health transition before owner-facing alert delivery. */
  AGENT_HOST_HEALTH?: import('@cloudflare/workers-types').DurableObjectNamespace<
    import('./core/agent-host-health/do.mjs').AgentHostHealthDO
  >;
  /** Atomic lease and progress state for a multi-tick Mono reconciliation. */
  MONO_RECONCILE?: import('@cloudflare/workers-types').DurableObjectNamespace<
    import('./core/mono-reconcile/do.mjs').MonoReconcileDO
  >;
  BACKUP_STATE?: import('@cloudflare/workers-types').DurableObjectNamespace<
    import('./core/backup-state/do.mjs').BackupStateDO
  >;
  WEEKLY_REVIEW_STATE?: import('@cloudflare/workers-types').DurableObjectNamespace<
    import('./core/weekly-review-state/do.mjs').WeeklyReviewStateDO
  >;
  MONO_ALERT_GATE?: import('@cloudflare/workers-types').DurableObjectNamespace<
    import('./core/mono-alert-gate/do.mjs').MonoAlertGateDO
  >;
  /** One lease owns the daily Steam price check and its anomaly/sale state. */
  STEAM_CHECK_STATE?: import('@cloudflare/workers-types').DurableObjectNamespace<
    import('./core/steam-check-state/do.mjs').SteamCheckStateDO
  >;
  /** Atomic claim/release gate before manual or scheduled GitHub briefing dispatch. */
  BRIEF_DISPATCH?: import('@cloudflare/workers-types').DurableObjectNamespace<
    import('./core/brief-dispatch/do.mjs').BriefDispatchDO
  >;

  /**
   * Vectorize-індекс памʼяті (ADR-038, етап 2 PR-2): svitanok-memory,
   * bge-m3/1024/cosine. Опційний: без нього memory.search чесно відмовляє,
   * а згортки живуть лише в sessions.summary_md (резерв ADR-020).
   */
  VECTORIZE?: import('@cloudflare/workers-types').VectorizeIndex;
  /** Workers AI - ембединги bge-m3 для памʼяті (01 §2.1). Опційний, як VECTORIZE. */
  AI?: import('@cloudflare/workers-types').Ai;

  /** Прапорець редизайну асистента: 'off' | 'shadow' | 'on' (01-architecture §5). */
  ASSISTANT_V2?: string;

  /** Origin мозку через Tunnel (напр. https://brain.yushko.dev); незаданий на
   *  етапі 1 - норма, handshake тихо пропускається до появи мозку. */
  BRAIN_URL?: string;
  /** Access service token для викликів ядро→мозок (05-ops §2, етап 0). */
  BRAIN_ACCESS_CLIENT_ID?: string;
  BRAIN_ACCESS_CLIENT_SECRET?: string;

  /** Deepgram nova-3 - розпізнавання голосових (ADR-010; покладений на етапі 0). */
  DEEPGRAM_API_KEY?: string;

  /** HMAC internal API ядро↔мозок (05-ops §2; покладений на етапі 0). */
  INTERNAL_HMAC_KEY?: string;
  /** Другий ключ на вікно ротації (05-ops §3, двоключова ротація 24 год). */
  INTERNAL_HMAC_KEY_NEXT?: string;

  /* ── Telegram ───────────────────────────────────────────────────────── */

  TELEGRAM_BOT_TOKEN?: string;
  /** Куди слати (в супергрупі — груповий id, НЕ id людини). */
  TELEGRAM_CHAT_ID?: string;
  /** Єдиний головний власник: право ПИСАТИ (`isPrimaryOwner`). */
  TELEGRAM_OWNER_USER_ID?: string;
  /** Читачі, через кому (`allowedUserIds`). */
  TELEGRAM_COOWNER_USER_IDS?: string;
  /** Стара назва TELEGRAM_COOWNER_USER_IDS; лишається живою до перейменування секрету. */
  TELEGRAM_ALLOWED_USER_IDS?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  /** Для Direct Link Mini App (`https://t.me/<bot>/app?startapp=…`). */
  TELEGRAM_BOT_USERNAME?: string;

  /** Треди forum-супергрупи; опційні — без них повідомлення йде в загальний. */
  TOPIC_BRIEFING?: string;
  TOPIC_ASSISTANT?: string;
  TOPIC_SYSTEM?: string;

  /* ── Зовнішні сервіси ───────────────────────────────────────────────── */

  MINI_APP_URL?: string;
  WEATHER_API_KEY?: string;
  /** Google Maps Platform (ADR-011, етап 0): один ключ на Places (New),
   *  Routes, Geocoding - `core/adapters/maps.mjs`, квоти в quota_counters. */
  MAPS_API_KEY?: string;
  /**
   * Домашні координати власника: JSON-масив `{lat, lon, name}`. Незаданий —
   * `web/weather-geo.mjs` працює на публічному фолбеку.
   */
  OWNER_LOCATIONS?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REFRESH_TOKEN?: string;
  /** Ключ шифрування бекапів (05-ops §2; етап 0). Довільний рядок ≥ 16
   *  символів - у ключ AES його перетворює SHA-256 (core/backup/core.mjs). */
  BACKUP_ENC_KEY?: string;
  /**
   * Workflow плану дня (ADR-035, етап 3 PR-8): `workflows` у wrangler.jsonc.
   * Мінімальний контракт, який вживає core/day-plan/chain.mjs (create + get
   * + sendEvent); повний тип Workflow із workers-types не потрібен.
   */
  DAY_PLAN?: {
    create: (opts: { id?: string; params?: unknown }) => Promise<unknown>;
    get: (id: string) => Promise<{
      sendEvent: (event: { type: string; payload?: unknown }) => Promise<void>;
      status?: () => Promise<unknown>;
    }>;
  };
  /**
   * Workflow аналізу ідеї по коду (етап 4 PR-2, 07 §6 IdeaAnalysis): той
   * самий мінімальний контракт, що DAY_PLAN.
   */
  IDEA_ANALYSIS?: {
    create: (opts: { id?: string; params?: unknown }) => Promise<unknown>;
    get: (id: string) => Promise<{
      sendEvent: (event: { type: string; payload?: unknown }) => Promise<void>;
      status?: () => Promise<unknown>;
    }>;
  };
  /** Workflow ланцюга столика (етап 5 PR-2, 07 §6 TableChain) - той самий контракт. */
  TABLE_CHAIN?: {
    create: (opts: { id?: string; params?: unknown }) => Promise<unknown>;
    get: (id: string) => Promise<{
      sendEvent: (event: { type: string; payload?: unknown }) => Promise<void>;
      status?: () => Promise<unknown>;
    }>;
  };
  /** Workflow відстеження ціни (етап 5 PR-3, 07 §6 PriceTrack) - той самий контракт. */
  PRICE_TRACK?: {
    create: (opts: { id?: string; params?: unknown }) => Promise<unknown>;
    get: (id: string) => Promise<{
      sendEvent: (event: { type: string; payload?: unknown }) => Promise<void>;
      status?: () => Promise<unknown>;
    }>;
  };
  /** Workflow поїздки (етап 5 PR-4, 07 §6 TripChain) - той самий контракт. */
  TRIP_CHAIN?: {
    create: (opts: { id?: string; params?: unknown }) => Promise<unknown>;
    get: (id: string) => Promise<{
      sendEvent: (event: { type: string; payload?: unknown }) => Promise<void>;
      status?: () => Promise<unknown>;
    }>;
  };
  /**
   * Workflow імпорту експорту чату (етап 6 PR-4, 07 §6 InboxExport) - той
   * самий контракт; подій не має (`sendEvent` лишається заради спільного типу).
   */
  INBOX_EXPORT?: {
    create: (opts: { id?: string; params?: unknown }) => Promise<unknown>;
    get: (id: string) => Promise<{
      sendEvent: (event: { type: string; payload?: unknown }) => Promise<void>;
      status?: () => Promise<unknown>;
    }>;
  };
  /** Ключ IsThereAnyDeal (етап 0, 05-ops §секрети): знижки на ігри, задача steam-check. */
  ITAD_API_KEY?: string;
  /** Токен Monobank personal API (етап 0, 05-ops §секрети): вебхук і виписка. */
  MONO_TOKEN?: string;
  /** Ключ Gemini API (ADR-012, етап 7): ЛИШЕ з проєкту з білінгом - зображення
   *  й відео. Без нього генерація відмовляє; безключового шляху немає. */
  GEMINI_API_KEY?: string;
  /**
   * Рівень проєкту Gemini - plaintext var у `wrangler.jsonc`, не секрет.
   * Мусить бути рівно 'paid', інакше `gemini.*` відмовляє: free tier
   * навчається на даних власника (ADR-012), і єдиний спосіб довести, що ключ
   * із платного проєкту, - твердження власника, видиме на код-ревʼю.
   */
  GEMINI_TIER?: string;
  /**
   * Секрет у ШЛЯХУ вебхука Mono (05-ops §секрети, виняток із правила «секрет
   * не в URL»): Mono тіло не підписує, тож автентичність дає лише адреса, яку
   * знають двоє. ≥ 32 символи, ротація раз на рік.
   */
  MONO_WEBHOOK_SECRET?: string;
  /** Read-only PAT на 4 репо (етап 0): HEAD-sha для кешу аналізу ідеї. */
  REPO_READ_PAT?: string;
  /** `workflow_dispatch` у brief.yml (крон-диспетч брифінгу) та idea-analysis.yml. */
  GH_DISPATCH_TOKEN?: string;
  /** Слаг `owner/repo` для того ж диспетчу. Незаданий -> дефолт у `cron.mjs`. */
  GH_REPO?: string;
  /**
   * Origin, якому дозволено читати публічний `/api/status`. Незаданий або
   * невалідний -> дефолт у `api-status.mjs` (помилка конфігу звужує доступ).
   */
  PUBLIC_STATUS_ORIGIN?: string;

  /** LLM-хост на VPS: `/llm` (синхронний) і `/agent` (прогін асистента). */
  LLM_HOST_URL?: string;
  LLM_HOST_AGENT_URL?: string;
  LLM_HOST_SECRET?: string;

  /** Прапорець маршрутизації наміру нагадувань (`web/commands.mjs`). */
  REMINDER_INTENT_ROUTING?: string;
}

/**
 * Блоб KV без оголошеної схеми.
 *
 * ⚠️ Це НЕ «типізовано». Це чесна межа першого етапу C1: `state`, `stats`,
 * `settings`, `latest` — довгоживучі JSON-блоби. Перші три canonical у
 * StateStoreDO та віддзеркалюються в KV; оркестратор (`src/**`) читає
 * `settings` mirror, тож схема — окремий крок, а не побічний ефект цього.
 * TODO(C1): оголосити схеми блобів і замінити цей псевдонім.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type KvBlob = Record<string, any>;
