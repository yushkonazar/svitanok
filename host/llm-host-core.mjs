// Чиста логіка LLM-хоста (VPS-реле на claude CLI, підписка): валідація запиту,
// const-time secret (той самий патерн, що web/tg-core.mjs — окремий копі,
// host/ деплоїться самостійно, без залежності на web/), побудова argv для
// claude CLI (НІКОЛИ shell-рядком — лише масив, spawn({shell:false}) —
// command injection неможливий незалежно від вмісту prompt), rate-limit,
// парсинг виводу. І/O (HTTP-сервер, сам spawn) — server.mjs.

export const MAX_PROMPT_LEN = 4000;
export const MAX_SYSTEM_PROMPT_LEN = 2000;
export const MAX_SCHEMA_LEN = 2000;
const DEFAULT_MODEL = 'haiku';

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

  if (model !== undefined && (typeof model !== 'string' || !/^[a-z0-9-]{1,40}$/i.test(model))) {
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
    return { ok: false, error: typeof parsed.result === 'string' ? parsed.result : 'llm-error' };
  }
  return {
    ok: true,
    result: typeof parsed.result === 'string' ? parsed.result : '',
    structured: parsed.structured_output ?? null,
    costUsd: typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : null,
  };
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
