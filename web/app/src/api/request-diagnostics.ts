export interface RequestDiagnostic {
  at: string;
  area: 'leisure' | 'plan';
  operation: string;
  requestId: string;
  phase: string;
  status: number | null;
  code: string;
  layer: 'client' | 'network' | 'server';
  durationMs: number;
  attempt: number;
}
const KEY = 'svitanok-request-diagnostics-v1';
export function readRequestDiagnostics(): RequestDiagnostic[] {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(KEY) ?? '[]');
    return Array.isArray(value)
      ? value
          .filter(
            (v) =>
              v &&
              ['leisure', 'plan'].includes(v.area) &&
              typeof v.at === 'string' &&
              typeof v.code === 'string',
          )
          .slice(0, 25)
          .map((v) => ({
            at: v.at,
            area: v.area,
            operation: String(v.operation ?? '').slice(0, 40),
            requestId: String(v.requestId ?? '').slice(0, 100),
            phase: String(v.phase ?? '').slice(0, 40),
            status: typeof v.status === 'number' ? v.status : null,
            code: v.code.slice(0, 50),
            layer: ['network', 'server', 'client'].includes(v.layer) ? v.layer : 'client',
            durationMs: Number(v.durationMs) || 0,
            attempt: Number(v.attempt) || 1,
          }))
      : [];
  } catch {
    return [];
  }
}
export function recordRequestDiagnostic(diagnostic: RequestDiagnostic) {
  try {
    sessionStorage.setItem(
      KEY,
      JSON.stringify([diagnostic, ...readRequestDiagnostics()].slice(0, 25)),
    );
  } catch {
    /* In-memory error still contains its report. */
  }
  window.dispatchEvent(new Event('svitanok-request-diagnostic'));
  return diagnostic;
}
export function diagnosticReport(entries: RequestDiagnostic[] = readRequestDiagnostics()) {
  return JSON.stringify(
    { app: 'Svitanok', scope: 'Діагностика запитів на цьому пристрої в поточному сеансі', entries },
    null,
    2,
  );
}
