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
import { createSdkEngine } from './sdk/engine.js';
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

// Проба «401-не-404» (інцидент 24.08): результат видно в /health, а не-ok -
// гучний лог одразу на старті.
let internalApiProbe = 'pending';
void probeInternalApi(config.internalApiUrl).then((r) => {
  internalApiProbe = r;
  if (r !== 'ok') console.error(`internal API проба: ${r} - перевір INTERNAL_API_URL`);
});

const handler = createHandler({
  config,
  buildInfo,
  limits: {
    tools: BRAIN_TOOLS.map((t) => t.coreName),
    models: PROFILE_MODELS,
    maxSteps: PROFILES.chat.maxToolCalls,
  },
  runner: makeRunner({ client, engine: createSdkEngine() }),
  sdkVersion: sdkPkg.version ?? null,
  claudeVersion: sdkPkg.claudeCodeVersion ?? null,
  internalApiProbe: () => internalApiProbe,
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

// systemd stop: даємо активним прогонам дотекти, нові зʼєднання не приймаємо.
process.on('SIGTERM', () => {
  console.log('SIGTERM: закриваю сервер');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
});
