// Reuse the existing briefing translation key in the same project's news Worker.
// Neither response bodies nor credentials are logged.
const translationKey = (process.env.GOOGLE_TRANSLATE_API_KEY ?? '').trim();
const cloudflareToken = (process.env.CF_API_TOKEN ?? '').trim();
const cloudflareAccount = (process.env.CF_ACCOUNT_ID ?? '').trim();
if (!translationKey || !cloudflareToken || !cloudflareAccount)
  throw new Error('Required existing secret is missing');
const check = await fetch('https://translation.googleapis.com/language/translate/v2', {
  method: 'POST',
  signal: AbortSignal.timeout(15000),
  headers: { 'content-type': 'application/json', 'x-goog-api-key': translationKey },
  body: JSON.stringify({ q: ['A new telescope was launched.'], target: 'uk', format: 'text' }),
});
if (!check.ok) throw new Error(`Existing Google translator check failed: HTTP ${check.status}`);
const translated = await check.json();
if (!/[іїєґа-я]/i.test(translated.data?.translations?.[0]?.translatedText ?? ''))
  throw new Error('Translator did not return Ukrainian text');
const configure = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${cloudflareAccount}/workers/scripts/svitanok/secrets`,
  {
    method: 'PUT',
    signal: AbortSignal.timeout(15000),
    headers: { authorization: `Bearer ${cloudflareToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'GOOGLE_TRANSLATE_API_KEY',
      text: translationKey,
      type: 'secret_text',
    }),
  },
);
if (!configure.ok) throw new Error(`Worker translation setup failed: HTTP ${configure.status}`);
const result = await configure.json();
if (!result.success) throw new Error('Worker translation setup was not acknowledged');
console.log(
  'Existing Google translator verified; news Worker configured. No credential values logged.',
);
