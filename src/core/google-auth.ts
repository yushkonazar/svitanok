// Спільний «Google-конектор»: OAuth refresh-token grant + timeout-обгортка,
// використовується і calendar.ts (readonly+events), і mail.ts (readonly),
// той самий refresh token покриває всі консентовані скоупи разом. Екстракт
// з src/modules/calendar.ts — без зміни поведінки (той самий URL/формат
// помилки), лише спільна точка, щоб не дублювати для кожного нового
// Google-модуля (§ master-план: "Розширити calendar.ts OAuth на спільний
// «Google-конектор»").

import { optionalSecret } from './secrets.js';

export interface GoogleOAuthCreds {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

/** Прочитати GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN; неповні -> null (graceful degrade). */
export function googleCreds(env: Record<string, string | undefined>): GoogleOAuthCreds | null {
  const clientId = optionalSecret('GOOGLE_CLIENT_ID', env);
  const clientSecret = optionalSecret('GOOGLE_CLIENT_SECRET', env);
  const refreshToken = optionalSecret('GOOGLE_REFRESH_TOKEN', env);
  if (!clientId || !clientSecret || !refreshToken) return null;
  return { clientId, clientSecret, refreshToken };
}

/** AbortController-обгортка з таймаутом — спільна для token-обміну й API-викликів. */
export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fn(ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
}

export interface AccessTokenOptions {
  fetchImpl: typeof fetch;
  timeoutMs: number;
}

/** Обміняти refresh token на access token. Кидає при збої (401/invalid_grant тощо). */
export async function googleAccessToken(
  creds: GoogleOAuthCreds,
  opts: AccessTokenOptions,
): Promise<string> {
  const body = new URLSearchParams({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    refresh_token: creds.refreshToken,
    grant_type: 'refresh_token',
  });
  const res = await withTimeout(
    (signal) =>
      opts.fetchImpl('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal,
      }),
    opts.timeoutMs,
  );
  if (!res.ok) {
    // 401/invalid_grant (протух refresh token — OAuth не в Production, §6)
    throw new Error(`Google token HTTP ${res.status}`);
  }
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error('Google token: немає access_token');
  return json.access_token;
}
