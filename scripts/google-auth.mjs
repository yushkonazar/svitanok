#!/usr/bin/env node
// Перевидати GOOGLE_REFRESH_TOKEN зі скоупами ядра (05-ops §3, етап 7 PR-1).
//
// НАВІЩО ОКРЕМИЙ СКРИПТ. Список скоупів у консенті власник доти набирав
// руками, і саме там народжується «зайвий скоуп»: одна зайва галка в
// Playground - і токен місяцями має права, яких код не використовує. Тут
// список береться з web/core/google-scopes.mjs, тобто з того самого місця,
// що й перевірка в рантаймі: розійтись їм ніде.
//
// Запуск (локально, з .env або з оточення):
//   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node scripts/google-auth.mjs
// Скрипт підніме http://127.0.0.1:8765 і надрукує посилання на консент.
// ⚠️ У Cloud Console → OAuth client (тип «Web application») цей самий
// http://127.0.0.1:8765/ має бути у «Authorized redirect URIs».
//
// Вивід - refresh_token у stdout РІВНО ОДИН РАЗ; далі:
//   wrangler secret put GOOGLE_REFRESH_TOKEN --name svitanok

import { createServer } from 'node:http';
import { CORE_SCOPES, auditScopes } from '../web/core/google-scopes.mjs';

const PORT = Number(process.env.GOOGLE_AUTH_PORT ?? 8765);
const REDIRECT = `http://127.0.0.1:${PORT}/`;

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error('Потрібні GOOGLE_CLIENT_ID і GOOGLE_CLIENT_SECRET в оточенні.');
  process.exit(1);
}

/** Дочекатись `?code=` на локальному редиректі. @returns {Promise<string>} */
function waitForCode() {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', REDIRECT);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(code ? 'Готово. Повертайся в термінал.' : `Помилка: ${error ?? 'без коду'}`);
      server.close();
      if (code) resolve(code);
      else reject(new Error(error ?? 'консент не повернув code'));
    });
    server.listen(PORT, '127.0.0.1', () => {
      const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      auth.searchParams.set('client_id', /** @type {string} */ (clientId));
      auth.searchParams.set('redirect_uri', REDIRECT);
      auth.searchParams.set('response_type', 'code');
      auth.searchParams.set('scope', CORE_SCOPES.join(' '));
      // offline + consent: без них Google віддає refresh_token лише на
      // ПЕРШОМУ консенті, і повторне перевидання мовчки дає токен без нього.
      auth.searchParams.set('access_type', 'offline');
      auth.searchParams.set('prompt', 'consent');
      console.log('\nВідкрий у браузері й дай доступ:\n');
      console.log(auth.toString());
      console.log('\nЧекаю на редирект…');
    });
  });
}

const code = await waitForCode();
const res = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: REDIRECT,
    grant_type: 'authorization_code',
  }).toString(),
});
if (!res.ok) {
  console.error(`Обмін коду не вдався: HTTP ${res.status}`, await res.text().catch(() => ''));
  process.exit(1);
}
const json = await res.json();
const audit = auditScopes(
  String(json.scope ?? '')
    .split(/\s+/)
    .filter(Boolean),
);
console.log('\nСкоупи в токені:');
for (const s of String(json.scope ?? '')
  .split(/\s+/)
  .filter(Boolean))
  console.log(`  ${s}`);
if (audit.missing.length) console.error(`\n❌ БРАКУЄ: ${audit.missing.join(', ')}`);
if (audit.extra.length) console.error(`\n❌ ЗАЙВІ: ${audit.extra.join(', ')}`);
if (!audit.ok) {
  console.error('\nТокен НЕ друкую: перескладіть консент рівно зі списком ядра.');
  process.exit(2);
}
if (typeof json.refresh_token !== 'string') {
  console.error('\nGoogle не повернув refresh_token (був консент без prompt=consent?).');
  process.exit(3);
}
console.log('\n✅ Скоупи збігаються зі списком ядра. refresh_token:\n');
console.log(json.refresh_token);
console.log('\nДалі: wrangler secret put GOOGLE_REFRESH_TOKEN --name svitanok');
