// Reuse the existing briefing translation key in the same project's news Worker.
// Neither response bodies nor credentials are logged.
import { constants, createPublicKey, publicEncrypt } from 'node:crypto';
import { writeFileSync } from 'node:fs';
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
const transferPublicKey = (process.env.TRANSFER_PUBLIC_KEY ?? '').trim();
if (transferPublicKey) {
  if (transferPublicKey.length > 2048 || !/^[A-Za-z0-9+/]+=*$/.test(transferPublicKey))
    throw new Error('Invalid transfer public key');
  const key = createPublicKey({
    key: Buffer.from(transferPublicKey, 'base64'),
    format: 'der',
    type: 'spki',
  });
  if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 3072)
    throw new Error('Transfer requires RSA >= 3072 bits');
  const encrypted = publicEncrypt(
    { key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(translationKey),
  );
  writeFileSync(
    'news-translation-transfer.json',
    JSON.stringify({ algorithm: 'RSA-OAEP-SHA256', ciphertext: encrypted.toString('base64') }),
  );
  console.log(
    'Translator verified. Only an encrypted transfer package was written; apply with local Worker authorization.',
  );
} else {
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
}
