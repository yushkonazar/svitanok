#!/usr/bin/env node
// Аналіз ідеї по коду в GitHub Actions (01 §3.9, 07 §5 профіль `idea-analysis`,
// S-3-3…S-3-5; етап 4 PR-1). Запускає idea-analysis.yml:
//
//   node scripts/idea-analysis.mjs run      - claude -p з code-reviewer.md над
//                                             checkout цільового репо → звіт →
//                                             POST /internal/artifact (status ok);
//                                             будь-який власний збій → failed
//   node scripts/idea-analysis.mjs failed   - лише POST status=failed (крок
//                                             `if: failure()` воркфлоу, коли
//                                             упало ДО аналізу: checkout, CLI)
//
// Вхід - змінні середовища IA_* (inputs воркфлоу) + секрети. Ядро приймає
// артефакт тим самим підписом ADR-037, що й мозок: HMAC по сирому тілу з
// run_id, який ядро зареєструвало ДО dispatch (Workflow IdeaAnalysis, PR-2),
// + Access service token на периметрі. Секрети в лог не потрапляють: лише
// шлях, статус і довжина звіту; stderr claude - з вирізаним токеном.
//
// Без npm-залежностей (npm ci у job не потрібен): підпис - web/core/internal/
// auth.mjs (той самий, що в ядрі), парсер інструкції - web/core/instructions.mjs.

import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseInstruction } from '../web/core/instructions.mjs';
import { signedInternalHeaders } from '../web/core/internal/auth.mjs';

/** Inputs воркфлоу = поля dispatch з ядра (парність тримають тести обох боків). */
export const WORKFLOW_INPUTS = ['run_id', 'idea_id', 'repo', 'sha', 'title', 'idea'];

/** Без цього не можна навіть повідомити ядру про збій (обидва режими). */
export const REQUIRED_ENV = [
  'IA_RUN_ID',
  'IA_IDEA_ID',
  'INTERNAL_API_URL',
  'INTERNAL_HMAC_KEY',
  'BRAIN_ACCESS_CLIENT_ID',
  'BRAIN_ACCESS_CLIENT_SECRET',
];
/** Додатково для режиму run: без них нема чого аналізувати. */
export const RUN_REQUIRED_ENV = ['IA_REPO', 'IA_SHA', 'TARGET_DIR', 'CLAUDE_CODE_OAUTH_TOKEN'];

/** Репозиторії, доступні для аналізу (S-3-8; парність із ядром тримає тест). */
export const IDEA_REPOS = ['svitanok', 'portfolio', 'moviehouse', 'modern-blog'];

export const ARTIFACT_PATH = '/internal/artifact';
/** Кап звіту в артефакті - у БАЙТАХ UTF-8: тіло /internal/* ≤ 128 KiB
 *  (MAX_INTERNAL_BODY_BYTES ядра), запас - на JSON-екранування й решту полів. */
export const ARTIFACT_MD_MAX_BYTES = 96_000;
/** Кап тексту ідеї у промпті (inputs воркфлоу ≤ 65 535 символів разом). */
export const IDEA_TEXT_MAX = 12_000;
/** Бюджет claude -p: інструкція каже ≤ 25 хв, стеля job - 40. */
export const CLAUDE_TIMEOUT_MS = 25 * 60_000;
/** SIGTERM проігноровано (посеред виклику інструмента) - SIGKILL, інакше
 *  висіли б до стелі job, а та вбиває без failed у ядро. */
export const CLAUDE_KILL_GRACE_MS = 10_000;
/** Один повтор POST після мережевого збою чи 5xx: 25 хв аналізу дорожчі за 5 с. */
export const POST_RETRY_DELAY_MS = 5_000;
export const INSTRUCTION_FILE = 'docs/assistant/agents/code-reviewer.md';
/** Вбудовані інструменти, дозволені Код-оглядачу (07 §4: Read, Grep, Glob). */
export const ALLOWED_TOOLS = ['Read', 'Grep', 'Glob'];
/** Решта - вимкнена явно: денайлист поверх allow, як у рушії мозку. */
export const DISALLOWED_TOOLS = [
  'Bash',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'WebSearch',
  'WebFetch',
  'Task',
  'TodoWrite',
];
/** Змінні, які дістає дочірній claude - і ТІЛЬКИ вони. Секрети ядра
 *  (INTERNAL_HMAC_KEY, Access-пара) процесу моделі не потрібні; хук із
 *  чужого репо, навіть якби завантажився, їх би не побачив (security-ревʼю). */
export const CHILD_ENV_KEYS = ['PATH', 'HOME', 'CLAUDE_CODE_OAUTH_TOKEN'];
const MODEL_IDS = { sonnet: 'claude-sonnet-5', haiku: 'claude-haiku-4-5' };

/** @param {NodeJS.ProcessEnv} env */
export function childEnv(env) {
  /** @type {NodeJS.ProcessEnv} */
  const out = {};
  for (const k of CHILD_ENV_KEYS) if (env[k] != null) out[k] = env[k];
  return out;
}

/**
 * Задача Код-оглядачу («Що отримує»): task = {idea, repo, sha}, format = md.
 * Текст ідеї - дослівно від власника, у межах капу.
 * @param {{ idea: string, title?: string, repo: string, sha: string }} input
 */
export function buildTaskPrompt({ idea, title, repo, sha }) {
  const text = String(idea ?? '').slice(0, IDEA_TEXT_MAX);
  const ideaText = title && !text.startsWith(String(title)) ? `${title}\n\n${text}` : text;
  return [
    'task:',
    JSON.stringify({ idea: ideaText, repo, sha }, null, 2),
    'format: md',
    'Робоча тека - checkout repo на sha. Відповідь - лише звіт за «Формат відповіді».',
  ].join('\n');
}

/**
 * Аргументи claude -p: системний промпт = тіло інструкції, стеля ходів і
 * модель - з її front-matter, інструменти - лише Read/Grep/Glob, налаштування
 * лише користувача раннера (security-ревʼю PR-1: без цього claude -p підхопив
 * би .claude/settings.json цільового репо, а хуки в ньому - shell-команди в
 * довіреній теці; те саме для .mcp.json).
 * @param {{ instructionRaw: string, prompt: string }} input
 */
export function claudeArgs({ instructionRaw, prompt }) {
  const parsed = parseInstruction(instructionRaw);
  if (!parsed.ok) throw new Error(`code-reviewer.md: ${parsed.error}`);
  const maxSteps = Number(parsed.front.max_steps);
  if (!Number.isInteger(maxSteps) || maxSteps <= 0) {
    throw new Error('code-reviewer.md: max_steps має бути додатним цілим');
  }
  const model = MODEL_IDS[/** @type {'sonnet' | 'haiku'} */ (String(parsed.front.model))];
  if (!model) throw new Error(`code-reviewer.md: model «${String(parsed.front.model)}» без id`);
  return [
    '-p',
    prompt,
    '--system-prompt',
    parsed.body,
    '--model',
    model,
    '--max-turns',
    String(maxSteps),
    '--output-format',
    'json',
    '--allowedTools',
    ...ALLOWED_TOOLS,
    '--disallowedTools',
    ...DISALLOWED_TOOLS,
    '--setting-sources',
    'user',
    '--strict-mcp-config',
  ];
}

/**
 * Результат claude -p --output-format json: один обʼєкт {type:'result', result,
 * is_error, subtype, num_turns}. Стеля ходів (error_max_turns) із непорожнім
 * текстом - НЕ збій, а частковий звіт (S-7-5 «не вклався - ось що встиг»):
 * 20 хв читання коду не викидаються.
 * @param {string} stdout
 * @returns {{ ok: true, md: string, meta: { num_turns: number | null, duration_ms: number | null, partial?: true } }
 *         | { ok: false, reason: string }}
 */
export function parseClaudeOutput(stdout) {
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return { ok: false, reason: 'вивід claude не JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'без result' };
  }
  const r = /** @type {Record<string, unknown>} */ (parsed);
  const md = typeof r.result === 'string' ? r.result.trim() : '';
  const subtype = typeof r.subtype === 'string' ? r.subtype : 'success';
  const partial = subtype === 'error_max_turns' && md !== '';
  if (r.is_error || (subtype !== 'success' && !partial)) {
    return { ok: false, reason: `claude: ${subtype}` };
  }
  if (!md) return { ok: false, reason: 'порожній звіт' };
  const num = (/** @type {unknown} */ v) =>
    v == null || !Number.isFinite(Number(v)) ? null : Number(v);
  return {
    ok: true,
    md: partial ? `> Не вклався у стелю ходів - ось що встиг.\n\n${md}` : md,
    meta: {
      num_turns: num(r.num_turns),
      duration_ms: num(r.duration_ms),
      ...(partial ? { partial: true } : {}),
    },
  };
}

/**
 * Зріз під кап у байтах UTF-8 (не символах: «→», «≤» і емодзі - 3-4 байти).
 * Межа не розрубує код-поїнт.
 * @param {string} text @param {number} maxBytes
 */
export function clipToBytes(text, maxBytes) {
  let bytes = 0;
  let i = 0;
  for (const ch of text) {
    const cp = /** @type {number} */ (ch.codePointAt(0));
    const b = cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
    if (bytes + b > maxBytes) return text.slice(0, i);
    bytes += b;
    i += ch.length;
  }
  return text;
}

/**
 * Тіло /internal/artifact (07 §3): результат або відмова. md ріжеться під кап
 * артефакту; повний звіт лишається в лозі job.
 * @param {{ ideaId: string, repo: string, sha: string }} ctx
 * @param {{ ok: true, md: string, meta?: Record<string, unknown> } | { ok: false, reason: string }} outcome
 */
export function artifactBody(ctx, outcome) {
  const base = { idea_id: ctx.ideaId, repo: ctx.repo, sha: ctx.sha };
  if (!outcome.ok) return { ...base, status: 'failed', reason: outcome.reason.slice(0, 500) };
  const clipped = clipToBytes(outcome.md, ARTIFACT_MD_MAX_BYTES);
  const md =
    clipped.length < outcome.md.length
      ? `${clipped}\n\n…(звіт обрізано до ${ARTIFACT_MD_MAX_BYTES} байт)`
      : outcome.md;
  return { ...base, status: 'ok', md, ...(outcome.meta ? { meta: outcome.meta } : {}) };
}

/**
 * Запустити claude -p у теці checkout-у; вихід - stdout цілком (utf8 з
 * декодером потоку, а не по чанках: розрубаний на межі чанка символ дав би
 * U+FFFD посеред звіту). Таймаут - SIGTERM, за CLAUDE_KILL_GRACE_MS - SIGKILL.
 * @param {{ bin: string, args: string[], cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv }} opts
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string, timedOut: boolean }>}
 */
export function runClaude({ bin, args, cwd, timeoutMs, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    /** @type {NodeJS.Timeout | null} */
    let killer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killer = setTimeout(() => child.kill('SIGKILL'), CLAUDE_KILL_GRACE_MS);
    }, timeoutMs);
    const clear = () => {
      clearTimeout(timer);
      if (killer) clearTimeout(killer);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (e) => {
      clear();
      reject(e);
    });
    child.on('close', (code) => {
      clear();
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/**
 * Надіслати артефакт у ядро. Мережевий збій чи 5xx - один повтор; відповідь
 * ≠ 2xx після нього - виняток із кодом: невідданий результат = червоний job,
 * а не тиша.
 * @param {{ apiUrl: string, hmacKey: string, access: { clientId: string, clientSecret: string }, runId: string }} ctx
 * @param {Record<string, unknown>} body
 * @param {typeof fetch} [fetchFn]
 * @param {(ms: number) => Promise<void>} [sleep]
 */
export async function postArtifact(ctx, body, fetchFn = fetch, sleep = defaultSleep) {
  const rawBody = JSON.stringify(body);
  const attempt = async () => {
    const headers = await signedInternalHeaders(ctx.hmacKey, {
      method: 'POST',
      path: ARTIFACT_PATH,
      runId: ctx.runId,
      rawBody,
      nowMs: Date.now(),
      access: ctx.access,
    });
    return fetchFn(`${ctx.apiUrl}${ARTIFACT_PATH}`, {
      method: 'POST',
      headers,
      body: rawBody,
      signal: AbortSignal.timeout(30_000),
    });
  };
  /** @type {Response | null} */
  let res = null;
  /** @type {unknown} */
  let transportErr = null;
  for (let i = 0; i < 2; i += 1) {
    try {
      res = await attempt();
      transportErr = null;
      if (res.status < 500) break;
    } catch (e) {
      transportErr = e;
    }
    if (i === 0) await sleep(POST_RETRY_DELAY_MS);
  }
  if (!res) {
    throw new Error(`/internal/artifact недосяжний: ${String(transportErr).slice(0, 200)}`);
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`/internal/artifact ${res.status}: ${text.slice(0, 200)}`);
  return res.status;
}

/** @param {number} ms */
function defaultSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Контекст із env. Режим failed перевіряє лише те, без чого не можна
 * повідомити ядру (run_id, адреса, ключі): збій через кривий repo/sha теж має
 * доїхати як failed, а не впасти вдруге на власній валідації.
 * @param {NodeJS.ProcessEnv} env
 * @param {'run' | 'failed'} mode
 */
export function readContext(env, mode) {
  const need = mode === 'run' ? [...REQUIRED_ENV, ...RUN_REQUIRED_ENV] : REQUIRED_ENV;
  const missing = need.filter((k) => !String(env[k] ?? '').trim());
  if (missing.length) throw new Error(`не задано: ${missing.join(', ')}`);
  const apiUrl = String(env.INTERNAL_API_URL).trim().replace(/\/+$/, '');
  // Канон internal API - лише кастомний домен (інцидент 24.08).
  if (new URL(apiUrl).hostname.endsWith('.workers.dev')) {
    throw new Error('INTERNAL_API_URL на *.workers.dev - лише кастомний домен');
  }
  const repo = String(env.IA_REPO ?? '').trim();
  const sha = String(env.IA_SHA ?? '').trim();
  const idea = String(env.IA_IDEA ?? '').trim();
  const title = String(env.IA_TITLE ?? '').trim();
  if (mode === 'run') {
    if (!IDEA_REPOS.includes(repo)) {
      throw new Error(`repo «${repo}» поза переліком: ${IDEA_REPOS.join(', ')}`);
    }
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('sha має бути 40 hex');
    if (!idea && !title) throw new Error('порожня ідея - нема чого аналізувати');
  }
  return {
    runId: String(env.IA_RUN_ID).trim(),
    ideaId: String(env.IA_IDEA_ID).trim(),
    apiUrl,
    hmacKey: String(env.INTERNAL_HMAC_KEY).trim(),
    access: {
      clientId: String(env.BRAIN_ACCESS_CLIENT_ID).trim(),
      clientSecret: String(env.BRAIN_ACCESS_CLIENT_SECRET).trim(),
    },
    repo: repo.slice(0, 64),
    sha: sha.slice(0, 64),
    title,
    idea,
    targetDir: String(env.TARGET_DIR ?? '').trim(),
  };
}

/** stderr дочірнього процесу без значення токена (він у env дитини).
 *  @param {string} text @param {string} token */
export function redact(text, token) {
  return token ? text.split(token).join('***') : text;
}

async function main() {
  const mode = process.argv[2];
  const env = process.env;
  if (mode !== 'run' && mode !== 'failed') throw new Error('режим: run | failed');
  const ctx = readContext(env, mode);

  if (mode === 'failed') {
    const reason = String(env.IA_REASON ?? 'job упав до аналізу');
    await postArtifact(ctx, artifactBody(ctx, { ok: false, reason }));
    console.log(`артефакт: failed (${reason})`);
    return;
  }

  // Будь-який збій нижче - failed у ядро від самого скрипта (ревʼю PR-1):
  // крок воркфлоу `if: failure()` покриває лише те, що впало ДО цього кроку.
  /** @type {ReturnType<typeof parseClaudeOutput>} */
  let outcome;
  try {
    const instructionRaw = readFileSync(INSTRUCTION_FILE, 'utf8');
    const args = claudeArgs({ instructionRaw, prompt: buildTaskPrompt(ctx) });
    const started = Date.now();
    const proc = await runClaude({
      bin: String(env.CLAUDE_BIN ?? 'claude'),
      args,
      cwd: ctx.targetDir,
      timeoutMs: CLAUDE_TIMEOUT_MS,
      env: childEnv(env),
    });
    console.log(
      `claude -p: код ${proc.code}, ${Math.round((Date.now() - started) / 1000)} с, stdout ${proc.stdout.length} симв.`,
    );
    if (proc.stderr.trim()) {
      console.error(redact(proc.stderr.slice(-2000), String(env.CLAUDE_CODE_OAUTH_TOKEN ?? '')));
    }
    outcome = proc.timedOut
      ? { ok: false, reason: `таймаут ${CLAUDE_TIMEOUT_MS / 60_000} хв` }
      : parseClaudeOutput(proc.stdout);
  } catch (e) {
    outcome = { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
  await postArtifact(ctx, artifactBody(ctx, outcome));
  if (!outcome.ok) {
    console.error(`артефакт: failed (${outcome.reason})`);
    process.exit(1);
  }
  console.log(
    `артефакт: ok, звіт ${outcome.md.length} симв.${outcome.meta.partial ? ' (частковий)' : ''}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
