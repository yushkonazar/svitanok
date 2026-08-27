// Підпис internal API - дзеркало web/core/internal/auth.mjs (ADR-037).
// Повідомлення: `${method}\n${path}\n${ts}\n${runId}\n${nonce}\n${rawBody}` -
// метод і шлях усередині підпису, щоб підписаний запит не переносився між
// ендпоїнтами; \n однозначний (у шляху й заголовках його не буває).
// Парність із ядром тримає tests/brain-sign.test.ts: той самий hex на тих
// самих входах, і збудовані тут заголовки проходять ядровий verify.

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

/** TTL підпису - як у ядра (auth.mjs): 10 хв в обидва боки (клок-скью). */
export const INTERNAL_SIG_TTL_MS = 10 * 60_000;

export interface SignInput {
  method: string;
  path: string;
  timestampMs: number;
  runId: string;
  nonce: string;
  rawBody: string;
}

export function signInternal(key: string, i: SignInput): string {
  const msg = `${i.method}\n${i.path}\n${i.timestampMs}\n${i.runId}\n${i.nonce}\n${i.rawBody}`;
  return createHmac('sha256', key).update(msg, 'utf8').digest('hex');
}

export interface SignedHeadersInput {
  method: string;
  path: string;
  runId: string;
  rawBody: string;
  nowMs: number;
  /** Для тестів; у бою - randomUUID на кожен запит. */
  nonce?: string;
}

/** Чотири заголовки X-Internal-* для запиту мозок→ядро. Підписує ОСНОВНИЙ
 *  ключ (перший): у вікні ротації 05-ops §3 ядро приймає обидва. */
export function buildSignedHeaders(key: string, i: SignedHeadersInput): Record<string, string> {
  const nonce = i.nonce ?? randomUUID();
  const signature = signInternal(key, {
    method: i.method,
    path: i.path,
    timestampMs: i.nowMs,
    runId: i.runId,
    nonce,
    rawBody: i.rawBody,
  });
  return {
    'X-Internal-Timestamp': String(i.nowMs),
    'X-Internal-Run': i.runId,
    'X-Internal-Nonce': nonce,
    'X-Internal-Signature': signature,
  };
}

export type VerifyResult =
  { ok: true; runId: string; nonce: string } | { ok: false; status: number; error: string };

/**
 * Перевірка підпису вхідного /run - той самий порядок і ті самі коди помилок,
 * що в ядровому verifyInternalRequest (заголовки → TTL → HMAC, двоключово).
 * Nonce тут лише учасник підпису; споживає його викликач (NonceCache).
 */
export function verifySignedRequest(i: {
  method: string;
  path: string;
  getHeader: (name: string) => string | null | undefined;
  bodyText: string;
  nowMs: number;
  keys: string[];
}): VerifyResult {
  if (i.keys.length === 0) {
    // Misconfig не сміє виглядати як «невірний підпис» - 500 і явний текст.
    return { ok: false, status: 500, error: 'hmac-not-configured' };
  }

  const tsRaw = i.getHeader('X-Internal-Timestamp');
  const runId = i.getHeader('X-Internal-Run');
  const nonce = i.getHeader('X-Internal-Nonce');
  const signature = i.getHeader('X-Internal-Signature');
  if (!tsRaw || !runId || !nonce || !signature) {
    return { ok: false, status: 401, error: 'missing-auth' };
  }

  const timestampMs = Number(tsRaw);
  if (!Number.isFinite(timestampMs)) return { ok: false, status: 401, error: 'bad-timestamp' };
  if (Math.abs(i.nowMs - timestampMs) > INTERNAL_SIG_TTL_MS) {
    return { ok: false, status: 401, error: 'stale-timestamp' };
  }

  for (const key of i.keys) {
    const expected = signInternal(key, {
      method: i.method,
      path: i.path,
      timestampMs,
      runId,
      nonce,
      rawBody: i.bodyText,
    });
    if (constantTimeEqualHex(expected, signature)) return { ok: true, runId, nonce };
  }
  return { ok: false, status: 401, error: 'bad-signature' };
}

/** Константночасне порівняння (звіряємо секрет). Різна довжина - одразу false:
 *  довжина hex HMAC-SHA256 і так публічна (64). */
function constantTimeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
