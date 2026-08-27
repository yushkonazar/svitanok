// /health - канонічний JSON 07 §3. Ядро (web/core/brain/health.mjs) читає
// version і gitSha та порівнює з brainExpected у KV; deploy-host.yml грепає
// відповідь на ПОВНИЙ 40-hex sha задеплоєного коміта. Решта полів - довідкові.

export interface BuildInfo {
  version: string;
  gitSha: string;
  builtAt: string;
}

export interface HealthLimits {
  tools: string[];
  models: string[];
  maxSteps: number;
}

export interface HealthInput {
  buildInfo: BuildInfo;
  sdkVersion: string | null;
  claudeVersion: string | null;
  limits: HealthLimits;
  uptimeSec: number;
  /** Результат стартової проби internal API ('ok' | 'unexpected-404' | …). */
  internalApiProbe: string;
}

export function buildHealthPayload(i: HealthInput): Record<string, unknown> {
  return {
    version: i.buildInfo.version,
    gitSha: i.buildInfo.gitSha,
    sdkVersion: i.sdkVersion,
    claudeVersion: i.claudeVersion,
    limits: i.limits,
    uptime: i.uptimeSec,
    internalApiProbe: i.internalApiProbe,
  };
}

/**
 * Стартова проба INTERNAL_API_URL (урок інциденту 24.08: жива, але ЧУЖА адреса
 * висіла мовчки). Непідписаний POST на /internal/* мусить дати 401/403 (Access
 * або HMAC-шар) - буде «ok». 404 означає не ту адресу або вимкнений маршрут -
 * гучний лог, і стан видно в /health.
 */
export async function probeInternalApi(
  baseUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  try {
    const res = await fetchFn(`${baseUrl}/internal/tool/geo.last`, {
      method: 'POST',
      body: '{}',
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401 || res.status === 403) return 'ok';
    return `unexpected-${res.status}`;
  } catch {
    return 'unreachable';
  }
}
