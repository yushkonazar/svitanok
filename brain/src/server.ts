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
  profile: z.enum([
    'chat',
    'quick',
    'summarize',
    'weekly-review',
    'day-planner',
    'price-check',
    'inbox-digest',
  ]),
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
  /** Інструкція профілю з D1 ядра (PR-5): тіло + хеш, який мозок звіряє сам.
   *  Мозок не має доступу до D1, тож текст приходить у тілі; хеш робить цю
   *  передачу перевірною - розбіжність означає, що персона в дорозі змінилась,
   *  і прогін не стартує (вшитих запасних текстів більше немає). */
  instruction: z
    .object({
      name: z.string().min(1).max(64),
      version_hash: z.string().regex(/^[0-9a-f]{64}$/),
      body_md: z.string().min(1).max(20_000),
    })
    .optional(),
});
export type RunRequest = z.infer<typeof RUN_REQUEST_SCHEMA>;

/**
 * Контракт стирання SDK-транскриптів. Це не є прогоном моделі: ядро надсилає
 * лише ідентифікатори вже відомих йому сесій, а мозок фізично прибирає їх зі
 * свого локального сховища. Стеля 100 тримає тіло й одну операцію SDK
 * обмеженими; ядро розбиває більші черги на пачки.
 */
export const DELETE_SESSIONS_SCHEMA = z.object({
  run_id: z.string().min(1).max(64),
  session_ids: z.array(z.string().min(1).max(128)).min(1).max(100),
});
export type DeleteSessionsRequest = z.infer<typeof DELETE_SESSIONS_SCHEMA>;

/** Виконавець прогону. Кидати не сміє - всі збої логує сам. */
export type Runner = (req: RunRequest) => Promise<void>;
/** Повертає лише лічильники: id сесій не мають потрапляти у логи чи квитанцію. */
export type DeleteSessions = (
  sessionIds: string[],
) => Promise<{ deleted: number; alreadyMissing: number }>;

export interface ServerDeps {
  config: BrainConfig;
  buildInfo: BuildInfo;
  limits: HealthLimits;
  runner: Runner;
  /** Реальне видалення локальних транскриптів Claude SDK на VPS. */
  deleteSessions?: DeleteSessions;
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
  /** Перестати приймати нові /run, не обриваючи вже прийняті. */
  beginDrain: () => void;
}

export function createHandler(deps: ServerDeps): BrainHandler {
  const now = deps.now ?? Date.now;
  const maxConcurrent = deps.maxConcurrent ?? 2;
  const nonces = new NonceCache(2 * INTERNAL_SIG_TTL_MS);
  const startedAt = now();
  let active = 0;
  let draining = false;

  /** /ready — навмисно вужчий за /health: процес може відповідати на health,
   * але ще не мати готового Claude runtime або адреси core. */
  function readiness() {
    if (draining) return { ok: false, error: 'draining' };
    if (!deps.sdkVersion || !deps.claudeVersion)
      return { ok: false, error: 'sdk-or-cli-unavailable' };
    if (deps.limits.models.length === 0) return { ok: false, error: 'no-profile-models' };
    if (deps.internalApiProbe() !== 'ok') return { ok: false, error: 'internal-api-not-ready' };
    return { ok: true };
  }

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

    if (req.path === '/ready') {
      if (req.method !== 'GET') return err(405, 'method-not-allowed');
      const ready = readiness();
      return ready.ok
        ? {
            status: 200,
            body: {
              ok: true,
              version: deps.buildInfo.version,
              gitSha: deps.buildInfo.gitSha,
              activeRuns: active,
            },
          }
        : err(503, ready.error ?? 'not-ready');
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

    if (req.path === '/sessions/delete') {
      // Той самий підписаний control-plane, що /run та /abort. Не стираємо
      // session під живим SDK-прогоном: у такому разі ядро отримає чесний 409
      // і повторить T2 пізніше, замість гонки з файлом транскрипту.
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
      const deletion = DELETE_SESSIONS_SCHEMA.safeParse(parsed);
      if (!deletion.success) {
        const first = deletion.error.issues[0];
        const where = first ? `$.${first.path.join('.')}: ${first.message}` : 'невалідне тіло';
        return err(400, `contract: ${where}`);
      }
      if (deletion.data.run_id !== verdict.runId) return err(400, 'run-mismatch');
      if (active > 0) return err(409, 'active-runs');
      if (!deps.deleteSessions) return err(501, 'session-delete-not-configured');
      if (!nonces.consume(verdict.runId, verdict.nonce, now())) return err(401, 'replayed');
      try {
        const result = await deps.deleteSessions(deletion.data.session_ids);
        return { status: 200, body: { ok: true, ...result } };
      } catch (e: unknown) {
        // Не включаємо session id чи текст транскрипту в HTTP-відповідь.
        console.error(`session cleanup ${deletion.data.run_id}: ${String(e)}`);
        return err(502, 'session-delete-failed');
      }
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

    // SIGTERM починає drain до server.close(): socket міг уже прийняти /run,
    // але цей run не має опинитися в процесі, який ось-ось буде зупинений.
    // Відмова до consume nonce дозволяє ядру ретраїти той самий запит на новому
    // release без подвійного start.
    if (draining) return err(503, 'draining');
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

  return {
    handle,
    activeRuns: () => active,
    beginDrain: () => {
      draining = true;
    },
  };
}

function err(status: number, error: string): PlainResponse {
  return { status, body: { ok: false, error } };
}
