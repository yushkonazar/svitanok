// Вхідна точка (wiring, без логіки): конфіг → штамп збірки → клієнт ядра →
// рушій SDK → чистий обробник server.ts → node:http на 127.0.0.1 (Tunnel
// назовні). Уся поведінка живе в модулях із тестами; тут лише збирання.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { CoreClient } from './core-client.js';
import { createHandler } from './server.js';
import { makeRunner } from './agent.js';
import { createSdkEngine, deleteSdkSessions } from './sdk/engine.js';
import { createOpenAiEngine } from './openai/engine.js';
import { probeInternalApi, type BuildInfo } from './health.js';
import { PROFILES, PROFILE_MODELS } from './profiles.js';
import { BRAIN_TOOLS } from './tools/schemas.js';

const MAX_BODY_BYTES = 256 * 1024;

const config = loadConfig(process.env);

const here = path.dirname(fileURLToPath(import.meta.url));
// Штамп пише збірка (scripts/stamp-build.mjs); без нього /health брехав би
// про версію - тому відсутність чи битий sha = відмова стартувати.
const buildInfo = JSON.parse(readFileSync(path.join(here, 'build-info.json'), 'utf8')) as BuildInfo;
if (!/^[0-9a-f]{40}$/.test(buildInfo.gitSha)) {
  console.error(`build-info.json: gitSha не 40-hex - перезбери (npm run build)`);
  process.exit(1);
}

// package.json SDK закритий exports-ами - читаємо файлом.
const sdkPkg = JSON.parse(
  readFileSync(
    path.join(here, '..', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'),
    'utf8',
  ),
) as { version?: string; claudeCodeVersion?: string };

const client = new CoreClient({
  baseUrl: config.internalApiUrl,
  hmacKey: config.hmacKeys[0] as string,
  accessClientId: config.accessClientId,
  accessClientSecret: config.accessClientSecret,
});

const engine =
  config.aiProvider === 'openai'
    ? createOpenAiEngine({
        apiKey: config.openAiApiKey as string,
        model: config.openAiModel as string,
        reasoningEffort: config.openAiReasoningEffort as
          'low' | 'medium' | 'high' | 'xhigh' | 'max',
      })
    : createSdkEngine();

// Проба «401-не-404» (інцидент 24.08): результат видно в /health, а не-ok -
// гучний лог одразу на старті. З Access-парою очікування - строго 401 від
// HMAC-шару ядра: чужий Access-хост так не відповість.
let internalApiProbe = 'pending';
const probeAccess =
  config.accessClientId && config.accessClientSecret
    ? { clientId: config.accessClientId, clientSecret: config.accessClientSecret }
    : null;
void probeInternalApi(config.internalApiUrl, fetch, probeAccess).then((r) => {
  internalApiProbe = r;
  if (r !== 'ok') console.error(`internal API проба: ${r} - перевір INTERNAL_API_URL`);
});

// Реєстр активних AbortController-ів (ADR-039): runner кладе, /abort рве.
const aborts = new Map<string, AbortController>();

const handler = createHandler({
  config,
  buildInfo,
  limits: {
    tools: BRAIN_TOOLS.map((t) => t.coreName),
    models: PROFILE_MODELS,
    maxSteps: PROFILES.chat.maxToolCalls,
  },
  runner: makeRunner({ client, engine, aborts }),
  deleteSessions: deleteSdkSessions,
  sdkVersion: sdkPkg.version ?? null,
  claudeVersion: sdkPkg.claudeCodeVersion ?? null,
  internalApiProbe: () => internalApiProbe,
  abortRun: (runId) => {
    const ctrl = aborts.get(runId);
    if (!ctrl) return false;
    ctrl.abort('stop');
    return true;
  },
});

function respond(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(text);
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = [];
  let size = 0;
  let overflow = false;
  req.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) overflow = true;
    else chunks.push(chunk);
  });
  req.on('error', (err) => {
    console.error(`http: обірваний запит: ${String(err)}`);
  });
  req.on('end', () => {
    if (overflow) return respond(res, 413, { ok: false, error: 'body-too-large' });
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    void handler
      .handle({
        method: req.method ?? 'GET',
        path: url.pathname,
        getHeader: (name) => {
          const v = req.headers[name.toLowerCase()];
          return Array.isArray(v) ? v[0] : v;
        },
        bodyText: Buffer.concat(chunks).toString('utf8'),
      })
      .then((out) => respond(res, out.status, out.body))
      .catch((err: unknown) => {
        console.error(`http: збій обробника: ${String(err)}`);
        respond(res, 500, { ok: false, error: 'internal' });
      });
  });
});

server.listen(config.port, config.host, () => {
  console.log(
    `svitanok-brain ${buildInfo.version} (${buildInfo.gitSha.slice(0, 12)}…) на ${config.host}:${config.port}`,
  );
});

// systemd stop: нові зʼєднання не приймаємо і ЧЕКАЄМО активні прогони через
// handler.activeRuns() - server.close() їх не бачить, бо /run відповів 202 і
// прогін живе поза зʼєднанням (знахідка ревʼю: рестарт убивав прогін мовчки).
// Стеля 85 с < systemd TimeoutStopSec (90 с типово): далі чесно виходимо з
// логом, скільки прогонів утрачено.
process.on('SIGTERM', () => {
  console.log(`SIGTERM: закриваю сервер, активних прогонів: ${handler.activeRuns()}`);
  handler.beginDrain();
  server.close();
  const startedAt = Date.now();
  const drain = setInterval(() => {
    const active = handler.activeRuns();
    if (active === 0) {
      clearInterval(drain);
      process.exit(0);
    }
    if (Date.now() - startedAt > 85_000) {
      console.error(`SIGTERM: таймаут дренажу, втрачаю ${active} активних прогонів`);
      clearInterval(drain);
      process.exit(0);
    }
  }, 500);
});
