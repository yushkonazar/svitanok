// Клієнт internal API ядра (07 §3): усі запити мозок→ядро йдуть звідси -
// підпис ADR-037 по СИРОМУ тілу + Access service token (периметр Cloudflare).
// Політика помилок за місцем виклику: callTool повертає {ok:false} (модель
// має побачити відмову інструмента), deliver кидає (втрата відповіді - збій
// прогону), status і reportRuns - best-effort (утрата статусного рядка чи
// телеметрії не має валити прогін); instruction/taint (етап 4, delegate) -
// повертають результат, а рішення «чи видавати працівника» лишають agent.ts.
// У логи йдуть лише шлях і статус - ні заголовків, ні тіл.

import { buildSignedHeaders } from './sign.js';

export type DeliverButtons = Array<Array<{ text: string; callback_data: string }>>;

/** Керівний outcome /internal/runs (RUNS_SCHEMA ядра): ескалація quick→chat
 *  (ADR-039) або подія в ланцюг від працівника (етап 3 PR-8, DayPlanChain). */
export type RunOutcome = {
  escalate?: { text: string; status_message_id?: number };
  chain?: { id: string; event: string; payload: Record<string, unknown> };
};

/** Результат працівника до deliver (етап 4, S-7-1): ядро кладе його в базу і
 *  додає кнопки «Коротше / Інший тон / .md» під відповіддю. */
export type DeliverWorker = { name: string; text: string };

export interface CoreClientConfig {
  /** База internal API без хвостового слеша (config.internalApiUrl). */
  baseUrl: string;
  /** Основний ключ HMAC (перший із config.hmacKeys). */
  hmacKey: string;
  accessClientId: string | null;
  accessClientSecret: string | null;
  fetchFn?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

export type ToolCallOutcome =
  | {
      ok: true;
      tool: string;
      tainted: boolean;
      mode?: 'proposed' | 'executed';
      result?: unknown;
      proposal?: unknown;
      undo?: unknown;
    }
  | { ok: false; status: number; error: string };

/** Інструкція працівника з D1 ядра (/internal/instruction): тіло + хеш, який
 *  мозок перераховує сам (instructions.ts), як і для персони. */
export type InstructionOutcome =
  | { ok: true; name: string; version_hash: string; body_md: string }
  | { ok: false; status: number; error: string };

const DEFAULT_TIMEOUT_MS = 15_000;

export class CoreClient {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(private readonly cfg: CoreClientConfig) {
    this.fetchFn = cfg.fetchFn ?? fetch;
    this.now = cfg.now ?? Date.now;
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async callTool(runId: string, coreName: string, args: unknown): Promise<ToolCallOutcome> {
    const path = `/internal/tool/${coreName}`;
    let res: { status: number; body: unknown };
    try {
      res = await this.post(path, runId, { args });
    } catch (err) {
      // Транспортний збій (мережа, таймаут 15 с) - відмова ОДНОГО інструмента,
      // не всього прогону: модель бачить {ok:false}, як і на HTTP-помилках.
      console.warn(`core-client: ${path} транспорт: ${String(err).slice(0, 120)}`);
      return { ok: false, status: 0, error: `network: ${String(err).slice(0, 120)}` };
    }
    if (res.status >= 200 && res.status < 300 && isRecord(res.body)) {
      const b = res.body;
      return {
        ok: true,
        tool: String(b.tool ?? coreName),
        tainted: Boolean(b.tainted),
        mode: b.mode === 'proposed' || b.mode === 'executed' ? b.mode : undefined,
        result: b.result,
        proposal: b.proposal,
        undo: b.undo,
      };
    }
    return { ok: false, status: res.status, error: errorText(res.body) };
  }

  /** Фінальна відповідь прогону. Невдача - виняток: без deliver прогін німий.
   *  `worker` - результат останнього працівника (S-7-1), лише коли він був. */
  async deliver(
    runId: string,
    text: string,
    buttons?: DeliverButtons,
    worker?: DeliverWorker,
  ): Promise<void> {
    const body = {
      text,
      ...(buttons?.length ? { buttons } : {}),
      ...(worker ? { worker } : {}),
    };
    const res = await this.post('/internal/deliver', runId, body);
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`deliver: ${res.status} ${errorText(res.body)}`);
    }
  }

  /** Оновлення статус-повідомлення; втрата - не привід валити прогін. */
  async status(runId: string, messageId: number, text: string): Promise<void> {
    try {
      const res = await this.post('/internal/status', runId, { message_id: messageId, text });
      if (res.status < 200 || res.status >= 300) {
        console.warn(`core-client: /internal/status ${res.status}`);
      }
    } catch (err) {
      console.warn(`core-client: /internal/status недоступний: ${String(err)}`);
    }
  }

  /**
   * Сесійний стан → /internal/session (ADR-038). Повертає успіх: для chat
   * невдача - лише warn (наступний прогін почне свіжу сесію), для summarize
   * викликач робить із false видимий error-крок - втрачена згортка не сміє
   * виглядати як зроблена.
   */
  async session(
    runId: string,
    body: {
      thread_id: string;
      sdk_session_id?: string;
      summary_md?: string;
      turns_inc?: number;
    },
  ): Promise<boolean> {
    try {
      const res = await this.post('/internal/session', runId, body);
      if (res.status >= 200 && res.status < 300) return true;
      console.warn(`core-client: /internal/session ${res.status} ${errorText(res.body)}`);
      return false;
    } catch (err) {
      console.warn(`core-client: /internal/session недоступний: ${String(err)}`);
      return false;
    }
  }

  /**
   * Інструкція працівника з D1 (етап 4, delegate). {ok:false} - працівник не
   * налаштований або ядро недоступне: agent.ts перетворює це на чесну відмову
   * моделі (S-7-3), алерт власнику шле ядро.
   */
  async instruction(runId: string, name: string): Promise<InstructionOutcome> {
    let res: { status: number; body: unknown };
    try {
      res = await this.post('/internal/instruction', runId, { name });
    } catch (err) {
      console.warn(`core-client: /internal/instruction транспорт: ${String(err).slice(0, 120)}`);
      return { ok: false, status: 0, error: `network: ${String(err).slice(0, 120)}` };
    }
    const b = res.body;
    if (
      res.status >= 200 &&
      res.status < 300 &&
      isRecord(b) &&
      typeof b.name === 'string' &&
      typeof b.version_hash === 'string' &&
      typeof b.body_md === 'string'
    ) {
      return { ok: true, name: b.name, version_hash: b.version_hash, body_md: b.body_md };
    }
    return { ok: false, status: res.status, error: errorText(b) };
  }

  /**
   * Позначити тред прогону tainted (01 §4.2: результат працівника з
   * tainted_output - зовнішній вміст). true = ядро ПЕРСИСТУВАЛО прапорець;
   * false - викликач НЕ видає результат моделі (fail-closed, як ядро для
   * tainting-інструментів).
   */
  async taint(runId: string, source: string): Promise<boolean> {
    try {
      const res = await this.post('/internal/taint', runId, { source });
      if (res.status >= 200 && res.status < 300) return true;
      console.warn(`core-client: /internal/taint ${res.status} ${errorText(res.body)}`);
      return false;
    } catch (err) {
      console.warn(`core-client: /internal/taint недоступний: ${String(err)}`);
      return false;
    }
  }

  /** Завершення run + telemetry. Ядро спершу закриває control plane, тому цей
   * виклик ретраїться при транзієнтній мережевій/5xx відмові. `/internal/runs`
   * ідемпотентний для короткого completion TTL, отже retry не створить другу
   * дію чи другий queue advance. */
  async reportRuns(runId: string, steps: object[], outcome?: RunOutcome): Promise<void> {
    const body = { steps, ...(outcome ? { outcome } : {}) };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const res = await this.post('/internal/runs', runId, body);
        if (res.status === 501 || (res.status >= 200 && res.status < 300)) return;
        const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
        console.warn(`core-client: /internal/runs ${res.status}`);
        if (!retryable) return;
      } catch (err) {
        console.warn(`core-client: /internal/runs недоступний: ${String(err)}`);
      }
      if (attempt < 2) await delay(250 * 2 ** attempt);
    }
  }

  private async post(
    path: string,
    runId: string,
    body: unknown,
  ): Promise<{ status: number; body: unknown }> {
    const rawBody = JSON.stringify(body);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...buildSignedHeaders(this.cfg.hmacKey, {
        method: 'POST',
        path,
        runId,
        rawBody,
        nowMs: this.now(),
      }),
    };
    if (this.cfg.accessClientId && this.cfg.accessClientSecret) {
      headers['CF-Access-Client-Id'] = this.cfg.accessClientId;
      headers['CF-Access-Client-Secret'] = this.cfg.accessClientSecret;
    }
    const res = await this.fetchFn(`${this.cfg.baseUrl}${path}`, {
      method: 'POST',
      headers,
      body: rawBody,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const parsed: unknown = await res.json().catch(() => null);
    return { status: res.status, body: parsed };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function errorText(body: unknown): string {
  if (isRecord(body) && typeof body.error === 'string') {
    const reason = typeof body.reason === 'string' ? `: ${body.reason}` : '';
    return `${body.error}${reason}`;
  }
  return 'no-body';
}
