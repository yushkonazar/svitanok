// Чиста логіка LLM-хоста (VPS-реле на claude CLI, підписка): валідація запиту,
// const-time secret (той самий патерн, що web/tg-core.mjs — окремий копі,
// host/ деплоїться самостійно, без залежності на web/), побудова argv для
// claude CLI (НІКОЛИ shell-рядком — лише масив, spawn({shell:false}) —
// command injection неможливий незалежно від вмісту prompt), rate-limit,
// парсинг виводу. І/O (HTTP-сервер, сам spawn) — server.mjs.

// Ліміти — САМОнакладені (не обмеження Anthropic): хост спавнить процеси і стоїть
// в інтернеті, тож розмір payload'а тримаємо під контролем. B3/B4 підняли їх один
// раз під реальну потребу асистента: системний промпт із 6-ма діями вже впирався
// в 1953/2000, а транскрипт може накопичити календар + own-data + пошту за 3 раунди.
// Захист від зловживання лишається на секреті + rate-limiter'і, не на цих цифрах.
//
// Варіант Б підняв MAX_PROMPT_LEN учетверо: цикл переїхав на хост, кроків тепер
// до AGENT_MAX_STEPS замість 3, і транскрипт накопичує результат КОЖНОГО
// інструмента (пошта + повне тіло листа + календар + own-data). Обрізання —
// у agent-loop-core.mjs (голова+хвіст), ця цифра лише стеля payload'а.
export const MAX_PROMPT_LEN = 24_000;
export const MAX_SYSTEM_PROMPT_LEN = 3000;
export const MAX_SCHEMA_LEN = 2000;
const DEFAULT_MODEL = 'haiku';

/** Дозволене імʼя моделі: alias ("haiku"/"sonnet") або повний id. Починається
 *  ЛИШЕ з букви/цифри — див. застереження у validateLlmRequest. */
export const MODEL_RE = /^[a-z0-9][a-z0-9-]{0,39}$/i;

/** Константний-час порівняння секрету (дзеркало web/tg-core.mjs verifyWebhookSecret). */
export function verifySecret(header, secret) {
  if (typeof header !== 'string' || typeof secret !== 'string' || !secret) return false;
  if (header.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < header.length; i++) diff |= header.charCodeAt(i) ^ secret.charCodeAt(i);
  return diff === 0;
}

/**
 * Валідувати тіло запиту {prompt, systemPrompt?, jsonSchema?, model?}.
 * -> {ok:true, value} | {ok:false, error}. Кожне текстове поле — з жорстким
 * лімітом довжини (захист від зловживання/завеликих payload'ів).
 */
export function validateLlmRequest(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'bad-body' };
  const { prompt, systemPrompt, jsonSchema, model } = body;

  if (typeof prompt !== 'string' || !prompt.trim()) return { ok: false, error: 'no-prompt' };
  if (prompt.length > MAX_PROMPT_LEN) return { ok: false, error: 'prompt-too-long' };

  if (systemPrompt !== undefined) {
    if (typeof systemPrompt !== 'string') return { ok: false, error: 'bad-system-prompt' };
    if (systemPrompt.length > MAX_SYSTEM_PROMPT_LEN) {
      return { ok: false, error: 'system-prompt-too-long' };
    }
  }

  let schemaStr;
  if (jsonSchema !== undefined) {
    if (typeof jsonSchema !== 'object' || jsonSchema === null || Array.isArray(jsonSchema)) {
      return { ok: false, error: 'bad-schema' };
    }
    schemaStr = JSON.stringify(jsonSchema);
    if (schemaStr.length > MAX_SCHEMA_LEN) return { ok: false, error: 'schema-too-long' };
  }

  // ⚠️ Перший символ — обовʼязково буквено-цифровий. Регекс без цього умовляння
  // (`^[a-z0-9-]+$`) пропускав значення на кшталт "--dangerously-skip-permissions":
  // spawn({shell:false}) інʼєкцію команд не дає, але argv-слот після `--model`
  // усе одно ліпше не заповнювати чимось, що виглядає як прапорець CLI.
  if (model !== undefined && (typeof model !== 'string' || !MODEL_RE.test(model))) {
    return { ok: false, error: 'bad-model' };
  }

  return {
    ok: true,
    value: {
      prompt: prompt.trim(),
      systemPrompt: systemPrompt?.trim() || undefined,
      schemaStr,
      model: model || DEFAULT_MODEL,
    },
  };
}

/**
 * Побудувати argv для spawn('claude', argv, {shell:false}) — НІКОЛИ рядком.
 * Кожен елемент масиву передається процесу як окремий argv-слот, тож вміст
 * prompt/systemPrompt не парситься шелом ні за яких обставин (`;`, `|`, `` ` ``,
 * `$()` в тексті — інертні символи, не спецсимволи).
 *
 * ⚠️ Це НЕ достатньо саме по собі: `-p`/`--print` — булевий перемикач
 * commander'а (не valued-опція!), тож prompt — окремий ПОЗИЦІЙНИЙ аргумент.
 * Якщо просто покласти prompt одразу після `-p`, значення на кшталт
 * "--allow-dangerously-skip-permissions" чи "--continue" парсяться CLI як
 * СПРАВЖНІ прапорці (перевірено емпірично: `claude -p --help` показує
 * власний --help CLI, а не «відповідь» на текст "--help" — отже prompt НЕ
 * consumed як значення `-p`). Тому prompt МУСИТЬ іти ПІСЛЯ `--` (POSIX-
 * роздільник «далі — лише позиційне», підтверджено емпірично: після `--`
 * навіть точний той самий рядок іде в модель як текст, не як прапорець).
 * Усі safety-прапорці — СТРОГО ДО `--`, інакше самі стали б позиційним
 * сміттям і НЕ застосувались би.
 *
 * Жорсткий локдаун, НЕ конфігурований викликачем:
 * --tools ''            — модель НЕ отримує жодного інструменту (лише текст-
 *                          відповідь; найважливіша межа безпеки цього хоста).
 * --setting-sources ''  — не читає user/project/local налаштування з диска
 *                          (CLAUDE.md, hooks, плагіни) — чистий контекст щоразу.
 * --no-session-persistence — не лишає файли сесій на диску.
 * --strict-mcp-config   — не підхоплює жоден MCP-сервер з навколишнього конфігу.
 * --permission-mode default — ніколи bypassPermissions.
 * --max-budget-usd      — жорсткий цінник-запобіжник на один виклик.
 */
export function buildClaudeArgs({ prompt, systemPrompt, schemaStr, model }) {
  const args = [
    '-p',
    '--tools',
    '',
    '--output-format',
    'json',
    '--no-session-persistence',
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--permission-mode',
    'default',
    '--max-budget-usd',
    '0.20',
    '--model',
    model || DEFAULT_MODEL,
  ];
  if (systemPrompt) args.push('--system-prompt', systemPrompt);
  if (schemaStr) args.push('--json-schema', schemaStr);
  // ВСЕ після "--" -- лише позиційне (prompt) — ніколи не переінтерпретується
  // як прапорець, незалежно від вмісту.
  args.push('--', prompt);
  return args;
}

/* ── Вичерпаний ліміт підписки (A1) ───────────────────────────────────────
   Коли підписка Claude упирається в ліміт (5-годинне вікно / тижневий кап),
   CLI не дає жодного машинного коду — лише людський текст. Розпізнаємо його
   ТУТ і віддаємо Worker'у стабільний ENUM `usage-limit` (+ resetAtMs, коли CLI
   назвав epoch). Це НЕ порушує інваріант «деталі помилок не йдуть у HTTP-
   відповідь» (server.mjs, шапка): назовні йде фіксований код і число, ніколи
   не сирий stderr/стек. Worker також має власний резервний regex — щоб фікс
   працював ще ДО редеплою хоста (web/agent-core.mjs classifyLlmFailure). */

export const USAGE_LIMIT_ERROR = 'usage-limit';

// «Claude AI usage limit reached|1752620400», «You've hit your session limit»,
// «weekly limit reached», «5-hour limit». Свідомо широко: хибний позитив тут —
// лише точніший текст користувачу, хибний негатив — знову невиразне «не зміг».
const USAGE_LIMIT_RE =
  /(usage limit reached|hit your (?:session|weekly|usage) limit|(?:session|weekly|5-hour) limit reached|limit will reset|upgrade to increase your usage limit)/i;
// Epoch у «...reached|1752620400» — рівно 10 цифр (секунди) або 13 (мс).
// 11–12-значне число двозначне (×1000 дало б 25-те століття) -> ігноруємо час.
const RESET_EPOCH_RE = /limit reached\|(\d{13}|\d{10})(?!\d)/i;

/**
 * Чи текст CLI означає вичерпаний ліміт підписки -> {limit, resetAtMs?}.
 * resetAtMs — лише коли CLI дав epoch; інакше undefined (Worker скаже
 * «спробуй пізніше» без години, а не вигадає її).
 */
export function detectUsageLimit(text) {
  const s = typeof text === 'string' ? text : '';
  if (!USAGE_LIMIT_RE.test(s)) return { limit: false };
  const m = RESET_EPOCH_RE.exec(s);
  if (!m) return { limit: true };
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return { limit: true };
  return { limit: true, resetAtMs: m[1].length >= 13 ? n : n * 1000 };
}

/** Розібрати stdout claude -p --output-format json -> {ok,result,structured,costUsd}|{ok:false,error}. */
export function parseClaudeOutput(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false, error: 'bad-output' };
  }
  if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'bad-output' };
  if (parsed.is_error) {
    const raw = typeof parsed.result === 'string' ? parsed.result : 'llm-error';
    const lim = detectUsageLimit(raw);
    if (lim.limit) {
      return {
        ok: false,
        error: USAGE_LIMIT_ERROR,
        ...(lim.resetAtMs ? { resetAtMs: lim.resetAtMs } : {}),
      };
    }
    return { ok: false, error: raw };
  }
  return {
    ok: true,
    result: typeof parsed.result === 'string' ? parsed.result : '',
    structured: parsed.structured_output ?? null,
    costUsd: typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : null,
    // C1: `usage` CLI (input/output + cache_read/cache_creation) — ЄДИНЕ
    // джерело відповіді на питання «чи кешується статичний префікс». Системний
    // промпт і схема (разом ~5КБ) їдуть у КОЖЕН spawn заново, і досі ми лише
    // припускали, що CLI їх кешує. Просто прокидаємо блок як є, без інтерпретації.
    usage: parsed.usage ?? null,
  };
}

/**
 * `usage` -> компактний рядок для логів. Відсутнє поле дає прочерк, а НЕ нуль:
 * «кеш не спрацював» і «CLI не повідомив» — різні відповіді, і саме їх ми тут
 * і розрізняємо.
 */
export function formatUsage(usage) {
  if (!usage || typeof usage !== 'object') return 'usage=-';
  const n = (v) => (typeof v === 'number' ? v : '-');
  return (
    `in=${n(usage.input_tokens)} out=${n(usage.output_tokens)} ` +
    `cacheRead=${n(usage.cache_read_input_tokens)} cacheCreate=${n(usage.cache_creation_input_tokens)}`
  );
}

/** Проста фіксовано-вікна rate-limiter у памʼяті (один процес = один лічильник). */
export function createRateLimiter({ windowMs, max }) {
  let windowStart = 0;
  let count = 0;
  return {
    allow(nowMs) {
      if (nowMs - windowStart >= windowMs) {
        windowStart = nowMs;
        count = 0;
      }
      count++;
      return count <= max;
    },
  };
}
