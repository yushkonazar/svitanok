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
  USAGE_LIMIT_ERROR,
} from './llm-host-core.mjs';

const PORT = Number(process.env.PORT) || 8787;
const SECRET = process.env.LLM_HOST_SECRET;
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const CLAUDE_TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS) || 30_000;
const MAX_BODY_BYTES = 20_000; // з запасом понад суму лімітів prompt+systemPrompt+schema
const RATE_LIMIT = {
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000,
  max: Number(process.env.RATE_LIMIT_MAX) || 20,
};

if (!SECRET) {
  console.error('LLM_HOST_SECRET не задано — вимикаюсь (не піднімаю незахищений ендпоінт).');
  process.exit(1);
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

const server = http.createServer(async (req, res) => {
  const start = Date.now();
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
    `[${new Date().toISOString()}] ${status} ${Date.now() - start}ms cost=${result.costUsd ?? '-'} "${preview}"`,
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
