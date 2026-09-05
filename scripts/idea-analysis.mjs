#!/usr/bin/env node
// Аналіз ідеї по коду в GitHub Actions (01 §3.9, 07 §5 профіль `idea-analysis`,
// S-3-3…S-3-5; етап 4 PR-1). Запускає idea-analysis.yml:
//
//   node scripts/idea-analysis.mjs run      - claude -p з code-reviewer.md над
//                                             checkout цільового репо → звіт →
//                                             POST /internal/artifact (status ok)
//   node scripts/idea-analysis.mjs failed   - лише POST status=failed (крок
//                                             `if: failure()` воркфлоу, коли
//                                             упало ДО аналізу: checkout, CLI)
//
// Вхід - змінні середовища IA_* (inputs воркфлоу) + секрети. Ядро приймає
// артефакт тим самим підписом ADR-037, що й мозок: HMAC по сирому тілу з
// run_id, який ядро зареєструвало ДО dispatch (Workflow IdeaAnalysis, PR-2),
// + Access service token на периметрі. Секрети в лог не потрапляють: лише
// шлях, статус і довжина звіту.
//
// Без залежностей (npm ci у job не потрібен): підпис - node:crypto, парсер
// інструкції - web/core/instructions.mjs (платформно-чистий).

import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseInstruction } from '../web/core/instructions.mjs';

/** Inputs воркфлоу = поля dispatch з ядра (парність тримають тести обох боків). */
export const WORKFLOW_INPUTS = ['run_id', 'idea_id', 'repo', 'sha', 'title', 'idea'];

/** Секрети/змінні, без яких скрипт не має права починати. */
export const REQUIRED_ENV = [
  'IA_RUN_ID',
  'IA_IDEA_ID',
  'IA_REPO',
  'IA_SHA',
  'INTERNAL_HMAC_KEY',
  'BRAIN_ACCESS_CLIENT_ID',
  'BRAIN_ACCESS_CLIENT_SECRET',
];

/** Репозиторії, доступні для аналізу (S-3-8; той самий перелік у ядрі). */
export const IDEA_REPOS = ['svitanok', 'portfolio', 'moviehouse', 'modern-blog'];

/** Канон internal API - лише кастомний домен (інцидент 24.08). */
export const DEFAULT_INTERNAL_API_URL = 'https://svitanok.yushko.dev';
export const ARTIFACT_PATH = '/internal/artifact';
/** Кап звіту в артефакті: тіло /internal/* ≤ 128 KiB, кирилиця - 2 байти/символ. */
export const ARTIFACT_MD_MAX = 40_000;
/** Кап тексту ідеї у промпті (inputs воркфлоу ≤ 65 535 символів разом). */
export const IDEA_TEXT_MAX = 12_000;
/** Бюджет claude -p: інструкція каже ≤ 25 хв, стеля job - 40. */
export const CLAUDE_TIMEOUT_MS = 25 * 60_000;
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
const MODEL_IDS = { sonnet: 'claude-sonnet-5', haiku: 'claude-haiku-4-5' };

/**
 * Підпис ADR-037 - той самий рядок, що verifyInternalRequest ядра:
 * `${method}\n${path}\n${ts}\n${runId}\n${nonce}\n${body}`.
 * @param {string} key
 * @param {{ method: string, path: string, timestampMs: number, runId: string, nonce: string, rawBody: string }} input
 */
export function signInternal(key, { method, path, timestampMs, runId, nonce, rawBody }) {
  return createHmac('sha256', key)
    .update(`${method}\n${path}\n${timestampMs}\n${runId}\n${nonce}\n${rawBody}`, 'utf8')
    .digest('hex');
}

/**
 * Заголовки підписаного POST у ядро (+ Access service token, коли пара є).
 * @param {{ hmacKey: string, accessClientId?: string | null, accessClientSecret?: string | null }} cfg
 * @param {{ path: string, runId: string, rawBody: string, nowMs: number, nonce?: string }} req
 */
export function signedHeaders(cfg, { path, runId, rawBody, nowMs, nonce = randomUUID() }) {
  /** @type {Record<string, string>} */
  const headers = {
    'Content-Type': 'application/json',
    'X-Internal-Timestamp': String(nowMs),
    'X-Internal-Run': runId,
    'X-Internal-Nonce': nonce,
    'X-Internal-Signature': signInternal(cfg.hmacKey, {
      method: 'POST',
      path,
      timestampMs: nowMs,
      runId,
      nonce,
      rawBody,
    }),
  };
  if (cfg.accessClientId && cfg.accessClientSecret) {
    headers['CF-Access-Client-Id'] = cfg.accessClientId;
    headers['CF-Access-Client-Secret'] = cfg.accessClientSecret;
  }
  return headers;
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
 * модель - з її front-matter, інструменти - лише Read/Grep/Glob.
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
  ];
}

/**
 * Результат claude -p --output-format json: обʼєкт {type:'result', result,
 * is_error, subtype, num_turns} або масив повідомлень з ним наприкінці.
 * @param {string} stdout
 * @returns {{ ok: true, md: string, meta: { num_turns: number | null, duration_ms: number | null } }
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
  const result = Array.isArray(parsed)
    ? parsed.findLast((m) => m && typeof m === 'object' && m.type === 'result')
    : parsed;
  if (!result || typeof result !== 'object') return { ok: false, reason: 'без result' };
  const r = /** @type {Record<string, unknown>} */ (result);
  if (r.is_error || (typeof r.subtype === 'string' && r.subtype !== 'success')) {
    return { ok: false, reason: `claude: ${String(r.subtype ?? 'error')}` };
  }
  const md = typeof r.result === 'string' ? r.result.trim() : '';
  if (!md) return { ok: false, reason: 'порожній звіт' };
  return {
    ok: true,
    md,
    meta: {
      num_turns: Number.isFinite(Number(r.num_turns)) ? Number(r.num_turns) : null,
      duration_ms: Number.isFinite(Number(r.duration_ms)) ? Number(r.duration_ms) : null,
    },
  };
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
  const md =
    outcome.md.length > ARTIFACT_MD_MAX
      ? `${outcome.md.slice(0, ARTIFACT_MD_MAX)}\n\n…(звіт обрізано до ${ARTIFACT_MD_MAX} символів)`
      : outcome.md;
  return { ...base, status: 'ok', md, ...(outcome.meta ? { meta: outcome.meta } : {}) };
}

/**
 * Запустити claude -p у теці checkout-у; вихід - stdout цілком. Таймаут -
 * SIGTERM і чесна відмова (стеля job вище страхує зависання самого kill).
 * @param {{ bin: string, args: string[], cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv }} opts
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string, timedOut: boolean }>}
 */
export function runClaude({ bin, args, cwd, timeoutMs, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/**
 * Надіслати артефакт у ядро. Відповідь ≠ 2xx - виняток із кодом: невідданий
 * результат = червоний job, а не тиша.
 * @param {NodeJS.ProcessEnv} env
 * @param {Record<string, unknown>} body
 * @param {typeof fetch} [fetchFn]
 */
export async function postArtifact(env, body, fetchFn = fetch) {
  const base = String(env.INTERNAL_API_URL ?? DEFAULT_INTERNAL_API_URL)
    .trim()
    .replace(/\/+$/, '');
  if (new URL(base).hostname.endsWith('.workers.dev')) {
    throw new Error('INTERNAL_API_URL на *.workers.dev - лише кастомний домен');
  }
  const rawBody = JSON.stringify(body);
  const headers = signedHeaders(
    {
      hmacKey: String(env.INTERNAL_HMAC_KEY ?? '').trim(),
      accessClientId: String(env.BRAIN_ACCESS_CLIENT_ID ?? '').trim() || null,
      accessClientSecret: String(env.BRAIN_ACCESS_CLIENT_SECRET ?? '').trim() || null,
    },
    { path: ARTIFACT_PATH, runId: String(env.IA_RUN_ID), rawBody, nowMs: Date.now() },
  );
  const res = await fetchFn(`${base}${ARTIFACT_PATH}`, {
    method: 'POST',
    headers,
    body: rawBody,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`/internal/artifact ${res.status}: ${text.slice(0, 200)}`);
  return res.status;
}

/** @param {NodeJS.ProcessEnv} env */
export function readContext(env) {
  const missing = REQUIRED_ENV.filter((k) => !String(env[k] ?? '').trim());
  if (missing.length) throw new Error(`не задано: ${missing.join(', ')}`);
  const repo = String(env.IA_REPO).trim();
  if (!IDEA_REPOS.includes(repo)) {
    throw new Error(`repo «${repo}» поза переліком: ${IDEA_REPOS.join(', ')}`);
  }
  const sha = String(env.IA_SHA).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('sha має бути 40 hex');
  return {
    runId: String(env.IA_RUN_ID).trim(),
    ideaId: String(env.IA_IDEA_ID).trim(),
    repo,
    sha,
    title: String(env.IA_TITLE ?? ''),
    idea: String(env.IA_IDEA ?? ''),
    targetDir: String(env.TARGET_DIR ?? 'target'),
  };
}

async function main() {
  const mode = process.argv[2];
  const env = process.env;
  const ctx = readContext(env);

  if (mode === 'failed') {
    const reason = String(env.IA_REASON ?? 'job упав до аналізу');
    await postArtifact(env, artifactBody(ctx, { ok: false, reason }));
    console.log(`артефакт: failed (${reason})`);
    return;
  }
  if (mode !== 'run') throw new Error('режим: run | failed');

  if (!String(env.CLAUDE_CODE_OAUTH_TOKEN ?? '').trim()) {
    throw new Error('не задано: CLAUDE_CODE_OAUTH_TOKEN');
  }
  const instructionRaw = readFileSync(INSTRUCTION_FILE, 'utf8');
  const args = claudeArgs({ instructionRaw, prompt: buildTaskPrompt(ctx) });
  const started = Date.now();
  const proc = await runClaude({
    bin: String(env.CLAUDE_BIN ?? 'claude'),
    args,
    cwd: ctx.targetDir,
    timeoutMs: CLAUDE_TIMEOUT_MS,
    env,
  });
  console.log(
    `claude -p: код ${proc.code}, ${Math.round((Date.now() - started) / 1000)} с, stdout ${proc.stdout.length} симв.`,
  );
  if (proc.stderr.trim()) console.error(proc.stderr.slice(-2000));

  const outcome = proc.timedOut
    ? { ok: /** @type {const} */ (false), reason: `таймаут ${CLAUDE_TIMEOUT_MS / 60_000} хв` }
    : parseClaudeOutput(proc.stdout);
  await postArtifact(env, artifactBody(ctx, outcome));
  if (!outcome.ok) {
    console.error(`артефакт: failed (${outcome.reason})`);
    process.exit(1);
  }
  console.log(`артефакт: ok, звіт ${outcome.md.length} симв.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
