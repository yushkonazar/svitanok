// Svitanok LLM-хост: тонкий HTTP-реле на claude CLI (підписка, не платний API).
// POST /llm {prompt, systemPrompt?, jsonSchema?, model?} -> spawn('claude', ...)
// -> {ok,result,structured,costUsd}. Уся валідація/безпековий локдаун argv —
// у llm-host-core.mjs (чисте, тестоване). Тут лише I/O: HTTP, spawn, таймаути.
//
// БЕЗПЕКА (це інтернет-доступний ендпоінт, що виконує підпроцес):
// - auth: shared-secret у заголовку X-Llm-Host-Secret, const-time порівняння.
// - spawn БЕЗ shell (за замовчуванням, ніколи не передаємо shell:true) —
//   argv-масив, тому вміст prompt НІКОЛИ не парситься як команда.
// - claude CLI завжди з --tools '' (llm-host-core.mjs) — модель не виконує
//   жодних дій, лише повертає текст.
// - rate-limit + ліміт розміру тіла запиту — захист від зловживання.
// - деталі помилок (stderr, стек) НІКОЛИ не йдуть у HTTP-відповідь — лише в лог.

import http from 'node:http';
import os from 'node:os';
import { spawn } from 'node:child_process';
import {
  verifySecret,
  validateLlmRequest,
  buildClaudeArgs,
  parseClaudeOutput,
  createRateLimiter,
  detectUsageLimit,
  formatUsage,
  USAGE_LIMIT_ERROR,
} from './llm-host-core.mjs';
import { WORKER_STEP_TIMEOUT_MS, validateAgentRequest, runAgentLoop } from './agent-loop-core.mjs';

const PORT = Number(process.env.PORT) || 8787;
const SECRET = process.env.LLM_HOST_SECRET;
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const CLAUDE_TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS) || 30_000;
const MAX_BODY_BYTES = 40_000; // транскрипт агента більший за одноразовий prompt
const RATE_LIMIT = {
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000,
  max: Number(process.env.RATE_LIMIT_MAX) || 20,
};
// Куди хост стукає по кожен інструмент. Свідомо з .env, а НЕ з тіла запиту:
// адреса в запиті зробила б хост універсальним проксі назовні для будь-кого,
// хто дістав LLM_HOST_SECRET (SSRF із нашого ж VPS).
const WORKER_STEP_URL = process.env.WORKER_STEP_URL;
// Скільки прогонів агента крутиться водночас. Кожен — до MAX_AGENT_STEPS
// спавнів claude, тож без цієї межі десяток паралельних запитів поклав би VPS.
const MAX_CONCURRENT_RUNS = Number(process.env.MAX_CONCURRENT_RUNS) || 2;

if (!SECRET) {
  console.error('LLM_HOST_SECRET не задано — вимикаюсь (не піднімаю незахищений ендпоінт).');
  process.exit(1);
}
if (!WORKER_STEP_URL) {
  // Не фатально: /llm (нагадування-рерайт) працює й без цього. Агент — ні.
  console.warn('WORKER_STEP_URL не задано — роут /agent віддаватиме 503.');
}

const rateLimiter = createRateLimiter(RATE_LIMIT);

const json = (res, status, obj) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};

/** Прочитати тіло запиту з жорстким лімітом розміру (не JSON.parse на завеликому). */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body-too-large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Викликати claude CLI з готовим argv (llm-host-core.buildClaudeArgs). */
function runClaude(args) {
  return new Promise((resolve) => {
    let child;
    try {
      // spawn() може кинути СИНХРОННО (не лише емітнути async 'error') —
      // без try/catch тут одна невдала спроба валить увесь сервер (DoS).
      child = spawn(CLAUDE_BIN, args, {
        cwd: os.tmpdir(), // нейтральна тека — жодного проєктного CLAUDE.md поруч
        shell: false, // ЖОРСТКО: без цього argv міг би парситись як shell-рядок
        timeout: CLAUDE_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        windowsHide: true,
      });
    } catch (err) {
      console.error('claude spawn threw synchronously:', err.message);
      resolve({ ok: false, error: 'spawn-failed' });
      return;
    }

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));

    child.on('error', (err) => {
      console.error('claude spawn error:', err.message);
      resolve({ ok: false, error: 'spawn-failed' });
    });

    child.on('close', (code, signal) => {
      if (signal === 'SIGKILL') {
        console.error(`claude вбито по таймауту (${CLAUDE_TIMEOUT_MS}ms)`);
        resolve({ ok: false, error: 'timeout' });
        return;
      }
      const parsed = parseClaudeOutput(stdout);
      if (!parsed.ok) {
        console.error(`claude exit=${code} parse-fail; stderr:`, stderr.slice(0, 500));
        // Вичерпаний ліміт підписки CLI інколи друкує ПЛЕЙН-текстом і виходить
        // ненульовим кодом — тоді JSON не парситься і вище лишається глухе
        // 'bad-output'. Перевіряємо обидва потоки й віддаємо стабільний код
        // (A1) — назовні йде лише енум+epoch, ніколи сам stderr.
        const lim = detectUsageLimit(`${stdout}\n${stderr}`);
        if (lim.limit) {
          resolve({
            ok: false,
            error: USAGE_LIMIT_ERROR,
            ...(lim.resetAtMs ? { resetAtMs: lim.resetAtMs } : {}),
          });
          return;
        }
      }
      resolve(parsed);
    });
  });
}

/* ══ Цикл агента (варіант Б) ═════════════════════════════════════════════════
   POST /agent віддає 202 ОДРАЗУ, ще до першої думки моделі, — і саме в цьому
   суть переходу: Worker'ів ctx.waitUntil завершується за ~300мс і Cloudflare
   не має чого вбивати. Далі петля крутиться тут, без обмеження часу.

   Кожен крок: claude -p -> Worker виконує обрану дію -> повертає текст для
   транскрипту й токен наступного кроку. Секрети (Gmail, календар, Telegram, KV)
   лишаються у Worker'а; хост їх не бачить і не хоче бачити. */

let activeRuns = 0;

/** POST у Worker на /api/agent-step. Ніколи не кидає — {ok:false} при будь-якому збої. */
async function callWorkerStep(body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), WORKER_STEP_TIMEOUT_MS);
  try {
    const res = await fetch(WORKER_STEP_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-llm-host-secret': SECRET },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const raw = await res.text().catch(() => '');
    try {
      return JSON.parse(raw);
    } catch {
      console.error(`worker step ${res.status}: не-JSON відповідь`, raw.slice(0, 200));
      return { ok: false, error: `http-${res.status}` };
    }
  } catch (err) {
    console.error('worker step call failed:', err?.message);
    return { ok: false, error: err?.name === 'AbortError' ? 'timeout' : 'offline' };
  } finally {
    clearTimeout(timer);
  }
}

/** POST /agent — прийняти прогін і одразу відпустити викликача. */
async function handleAgent(req, res) {
  if (!WORKER_STEP_URL) {
    json(res, 503, { ok: false, error: 'not-configured' });
    return;
  }
  if (activeRuns >= MAX_CONCURRENT_RUNS) {
    json(res, 429, { ok: false, error: 'rate-limited' });
    return;
  }

  let raw;
  try {
    raw = await readBody(req);
  } catch {
    json(res, 413, { ok: false, error: 'body-too-large' });
    return;
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    json(res, 400, { ok: false, error: 'bad-json' });
    return;
  }
  const validated = validateAgentRequest(body);
  if (!validated.ok) {
    json(res, 400, { ok: false, error: validated.error });
    return;
  }

  // 202 ДО першої думки моделі — інакше Worker чекав би у waitUntil і ми
  // повернулись би рівно до тієї мовчанки, заради якої все це робиться.
  json(res, 202, { ok: true, accepted: true });

  activeRuns++;
  runAgentLoop({ runClaude, callWorkerStep, buildArgs: buildClaudeArgs }, validated.value)
    .then((r) => console.log(`[agent] прогін завершено: ${r.outcome}, кроків ${r.steps}`))
    .catch((err) => console.error('agent loop crashed:', err)) // runAgentLoop не кидає, це страховка
    .finally(() => {
      activeRuns--;
    });
}

const server = http.createServer(async (req, res) => {
  const start = Date.now();
  if (req.method === 'POST' && req.url === '/agent') {
    const agentHeader = req.headers['x-llm-host-secret'];
    if (!verifySecret(Array.isArray(agentHeader) ? agentHeader[0] : agentHeader, SECRET)) {
      json(res, 401, { ok: false, error: 'bad-secret' });
      return;
    }
    if (!rateLimiter.allow(Date.now())) {
      json(res, 429, { ok: false, error: 'rate-limited' });
      return;
    }
    await handleAgent(req, res);
    console.log(`[${new Date().toISOString()}] /agent прийнято, активних прогонів: ${activeRuns}`);
    return;
  }
  if (req.method !== 'POST' || req.url !== '/llm') {
    json(res, 404, { ok: false, error: 'not-found' });
    return;
  }

  const header = req.headers['x-llm-host-secret'];
  if (!verifySecret(Array.isArray(header) ? header[0] : header, SECRET)) {
    json(res, 401, { ok: false, error: 'bad-secret' });
    return;
  }

  if (!rateLimiter.allow(Date.now())) {
    json(res, 429, { ok: false, error: 'rate-limited' });
    return;
  }

  let raw;
  try {
    raw = await readBody(req);
  } catch {
    json(res, 413, { ok: false, error: 'body-too-large' });
    return;
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    json(res, 400, { ok: false, error: 'bad-json' });
    return;
  }

  const validated = validateLlmRequest(body);
  if (!validated.ok) {
    json(res, 400, { ok: false, error: validated.error });
    return;
  }

  const args = buildClaudeArgs(validated.value);
  const result = await runClaude(args);
  const status = result.ok ? 200 : 502;
  json(res, status, result);

  const preview = validated.value.prompt.slice(0, 200).replace(/\n/g, ' ');
  console.log(
    `[${new Date().toISOString()}] ${status} ${Date.now() - start}ms cost=${result.costUsd ?? '-'} ` +
      `${formatUsage(result.usage)} "${preview}"`,
  );
});

server.listen(PORT, () => {
  console.log(`svitanok-llm-host слухає :${PORT}`);
});

// Останній запобіжник: логуємо й падаємо КЕРОВАНО (не тихо зависаємо в
// невизначеному стані — офіційна рекомендація Node щодо uncaughtException).
// systemd (Restart=on-failure) підійме процес заново за секунди.
process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('unhandledRejection:', err);
  process.exit(1);
});
