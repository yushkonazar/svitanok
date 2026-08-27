// Клієнт internal API ядра (07 §3): усі запити мозок→ядро йдуть звідси -
// підпис ADR-037 по СИРОМУ тілу + Access service token (периметр Cloudflare).
// Політика помилок за місцем виклику: callTool повертає {ok:false} (модель
// має побачити відмову інструмента), deliver кидає (втрата відповіді - збій
// прогону), status і reportRuns - best-effort (утрата статусного рядка чи
// телеметрії не має валити прогін; /internal/runs до дротування - 501).
// У логи йдуть лише шлях і статус - ні заголовків, ні тіл.

import { buildSignedHeaders } from './sign.js';

export type DeliverButtons = Array<Array<{ text: string; callback_data: string }>>;

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

  /** Фінальна відповідь прогону. Невдача - виняток: без deliver прогін німий. */
  async deliver(runId: string, text: string, buttons?: DeliverButtons): Promise<void> {
    const body = buttons?.length ? { text, buttons } : { text };
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

  /** Телеметрія кроків (run_steps + закриття прогону в реєстрі); best-effort -
   *  журнал не сміє валити прогін. 501 терпимо: старе ядро до PR-2. */
  async reportRuns(runId: string, steps: object[]): Promise<void> {
    try {
      const res = await this.post('/internal/runs', runId, { steps });
      if (res.status !== 501 && (res.status < 200 || res.status >= 300)) {
        console.warn(`core-client: /internal/runs ${res.status}`);
      }
    } catch (err) {
      console.warn(`core-client: /internal/runs недоступний: ${String(err)}`);
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
