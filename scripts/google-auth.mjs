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
import { createHash, randomBytes } from 'node:crypto';
import { CORE_SCOPES, auditScopes } from '../web/core/google-scopes.mjs';

const PORT = Number(process.env.GOOGLE_AUTH_PORT ?? 8765);
const REDIRECT = `http://127.0.0.1:${PORT}/`;

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error('Потрібні GOOGLE_CLIENT_ID і GOOGLE_CLIENT_SECRET в оточенні.');
  process.exit(1);
}

// ⚠️ STATE + PKCE (security-ревʼю етапу 7). Доти локальний сервер приймав
// БУДЬ-ЯКИЙ `?code=` з будь-якого запиту на 127.0.0.1: поки власник проходить
// консент, довільна відкрита в браузері сторінка могла зробити
// `<img src="http://127.0.0.1:8765/?code=…">` зі своїм кодом - і власник
// поклав би в Cloudflare refresh-токен ЧУЖОГО акаунта. Далі бекапи й експорт
// їхали б у чужий Drive, а тріаж читав би чужу скриньку. Тепер код без
// нашого `state` відкидається, а PKCE звʼязує обмін із цим самим запуском.
const STATE = randomBytes(24).toString('base64url');
const VERIFIER = randomBytes(48).toString('base64url');
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

/** Дочекатись `?code=` на локальному редиректі. @returns {Promise<string>} */
function waitForCode() {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', REDIRECT);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      const stateOk = url.searchParams.get('state') === STATE;
      const pathOk = url.pathname === '/';
      const ok = Boolean(code) && stateOk && pathOk;
      res.writeHead(ok ? 200 : 400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(
        ok
          ? 'Готово. Повертайся в термінал.'
          : `Помилка: ${error ?? (code ? 'чужий state або шлях' : 'без коду')}`,
      );
      // ⚠️ Сервер закривається ЛИШЕ на очікуваних подіях: наш код або явна
      // відмова Google. Будь-що інше - `/favicon.ico` від браузера, префетч,
      // чужий `<img src="http://127.0.0.1:8765/">` - ігнорується. Інакше та
      // сама сторінка, якій щойно заборонили підсунути свій код, зривала б
      // консент одним порожнім запитом (ревʼю виправлень).
      if (!ok && !error) {
        if (code) console.error('⚠️ Прийшов code із чужим state або шляхом - проігноровано.');
        return;
      }
      server.close();
      if (ok) resolve(/** @type {string} */ (code));
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
      auth.searchParams.set('state', STATE);
      auth.searchParams.set('code_challenge', CHALLENGE);
      auth.searchParams.set('code_challenge_method', 'S256');
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
    code_verifier: VERIFIER,
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
