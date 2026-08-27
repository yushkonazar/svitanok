// HTTP-шар мозку (01 §2.2): GET /health і POST /run на 127.0.0.1 за Tunnel.
// Обробник чистий (метод+шлях+заголовки+тіло → статус+тіло) - node:http
// підключає index.ts. Порядок перевірок /run: метод → підпис по сирому тілу →
// JSON → контракт → run-mismatch → слоти → НОНС → 202; коди помилок ті самі,
// що в ядровому router.mjs (401 replayed, 400 contract, 500 hmac-not-configured),
// але нонс свідомо споживається ОСТАННІМ - інакше валідно підписаний запит,
// відбитий 429 busy чи 400, не можна було б повторити тим самим підписом
// (знахідка ревʼю; уся ділянка синхронна, тому consume+слот атомарні).
//
// /run відповідає 202 ОДРАЗУ, прогін іде у фоні: викликач (ядро) не тримає
// зʼєднання на 4 хв прогону. Помилки прогону runner ловить сам - інакше
// відхилений проміс упустив би їх повз логи.

import { z } from 'zod';
import type { BrainConfig } from './config.js';
import { INTERNAL_SIG_TTL_MS, verifySignedRequest } from './sign.js';
import { NonceCache } from './nonces.js';
import { buildHealthPayload, type BuildInfo, type HealthLimits } from './health.js';

export const RUN_REQUEST_SCHEMA = z.object({
  run_id: z.string().min(1).max(64),
  profile: z.enum(['chat', 'quick', 'summarize']),
  thread_id: z.string().min(1).max(64),
  input: z.object({ text: z.string().min(1).max(30_000) }),
  tainted: z.boolean().optional(),
  /** message_id статус-повідомлення «▸ …» - куди стрімити прогрес. */
  status_message_id: z.number().int().min(1).optional(),
  /** Сесійний стан із D1 ядра (ADR-038): resume для chat, транскрипт для
   *  summarize; summary_md вставляється в системний промпт chat. */
  session: z
    .object({
      sdk_session_id: z.string().max(128).nullable(),
      summary_md: z.string().max(20_000).nullable(),
    })
    .optional(),
});
export type RunRequest = z.infer<typeof RUN_REQUEST_SCHEMA>;

/** Виконавець прогону. Кидати не сміє - всі збої логує сам. */
export type Runner = (req: RunRequest) => Promise<void>;

export interface ServerDeps {
  config: BrainConfig;
  buildInfo: BuildInfo;
  limits: HealthLimits;
  runner: Runner;
  sdkVersion: string | null;
  claudeVersion: string | null;
  internalApiProbe: () => string;
  /** «стоп» (ADR-039): перервати активний прогін. true = було кого рвати. */
  abortRun?: (runId: string) => boolean;
  now?: () => number;
  /** Слоти прогонів - як у RunRegistry ядра (01 §2.1: ≤ 2). */
  maxConcurrent?: number;
}

export interface PlainRequest {
  method: string;
  path: string;
  getHeader: (name: string) => string | null | undefined;
  bodyText: string;
}

export interface PlainResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface BrainHandler {
  handle: (req: PlainRequest) => Promise<PlainResponse>;
  /** Активні прогони (для тестів і graceful-зупинки). */
  activeRuns: () => number;
}

export function createHandler(deps: ServerDeps): BrainHandler {
  const now = deps.now ?? Date.now;
  const maxConcurrent = deps.maxConcurrent ?? 2;
  const nonces = new NonceCache(2 * INTERNAL_SIG_TTL_MS);
  const startedAt = now();
  let active = 0;

  async function handle(req: PlainRequest): Promise<PlainResponse> {
    if (req.path === '/health') {
      if (req.method !== 'GET') return err(405, 'method-not-allowed');
      return {
        status: 200,
        body: buildHealthPayload({
          buildInfo: deps.buildInfo,
          sdkVersion: deps.sdkVersion,
          claudeVersion: deps.claudeVersion,
          limits: deps.limits,
          uptimeSec: Math.floor((now() - startedAt) / 1000),
          internalApiProbe: deps.internalApiProbe(),
        }),
      };
    }

    if (req.path === '/abort') {
      // ADR-039: та сама сходинка, що /run (підпис по сирому тілу → контракт →
      // run-mismatch → нонс); тіло {run_id}. aborted:false = прогін уже
      // завершився - для «стоп» це не помилка.
      if (req.method !== 'POST') return err(405, 'method-not-allowed');
      const verdict = verifySignedRequest({
        method: req.method,
        path: req.path,
        getHeader: req.getHeader,
        bodyText: req.bodyText,
        nowMs: now(),
        keys: deps.config.hmacKeys,
      });
      if (!verdict.ok) return err(verdict.status, verdict.error);
      let parsed: unknown;
      try {
        parsed = JSON.parse(req.bodyText);
      } catch {
        return err(400, 'bad-json');
      }
      const runId = (parsed as { run_id?: unknown } | null)?.run_id;
      if (typeof runId !== 'string' || runId === '') return err(400, 'contract: $.run_id');
      if (runId !== verdict.runId) return err(400, 'run-mismatch');
      if (!nonces.consume(verdict.runId, verdict.nonce, now())) return err(401, 'replayed');
      const aborted = deps.abortRun ? deps.abortRun(runId) : false;
      return { status: 200, body: { ok: true, aborted } };
    }

    if (req.path !== '/run') return err(404, 'not-found');
    if (req.method !== 'POST') return err(405, 'method-not-allowed');

    const verdict = verifySignedRequest({
      method: req.method,
      path: req.path,
      getHeader: req.getHeader,
      bodyText: req.bodyText,
      nowMs: now(),
      keys: deps.config.hmacKeys,
    });
    if (!verdict.ok) return err(verdict.status, verdict.error);

    let parsed: unknown;
    try {
      parsed = JSON.parse(req.bodyText);
    } catch {
      return err(400, 'bad-json');
    }
    const run = RUN_REQUEST_SCHEMA.safeParse(parsed);
    if (!run.success) {
      const first = run.error.issues[0];
      const where = first ? `$.${first.path.join('.')}: ${first.message}` : 'невалідне тіло';
      return err(400, `contract: ${where}`);
    }
    // run_id у тілі мусить збігатися з підписаним заголовком - інакше підпис
    // одного прогону запускав би інший.
    if (run.data.run_id !== verdict.runId) return err(400, 'run-mismatch');

    if (active >= maxConcurrent) return err(429, 'busy');
    if (!nonces.consume(verdict.runId, verdict.nonce, now())) return err(401, 'replayed');
    active += 1;
    void deps
      .runner(run.data)
      .catch((e: unknown) => {
        // Runner зобовʼязаний ловити свої збої сам; це - остання страховка.
        console.error(`run ${run.data.run_id}: неперехоплений збій: ${String(e)}`);
      })
      .finally(() => {
        active -= 1;
      });
    return { status: 202, body: { ok: true, run_id: run.data.run_id } };
  }

  return { handle, activeRuns: () => active };
}

function err(status: number, error: string): PlainResponse {
  return { status, body: { ok: false, error } };
}
