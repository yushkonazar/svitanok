// Reuse only the existing translation/editor keys in the same project's news Worker.
// Neither response bodies nor credentials are logged.
import { constants, createPublicKey, publicEncrypt } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const secretName = process.env.TRANSFER_SECRET || 'GOOGLE_TRANSLATE_API_KEY';
if (!['GOOGLE_TRANSLATE_API_KEY', 'OPENAI_API_KEY'].includes(secretName))
  throw new Error('Unsupported news service');
const translationKey = (process.env[secretName] ?? '').trim();
const cloudflareToken = (process.env.CF_API_TOKEN ?? '').trim();
const cloudflareAccount = (process.env.CF_ACCOUNT_ID ?? '').trim();
if (!translationKey || !cloudflareToken || !cloudflareAccount)
  throw new Error('Required existing secret is missing');
if (secretName === 'GOOGLE_TRANSLATE_API_KEY') {
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
} else {
  // A restricted key may permit Responses while denying the model catalogue.
  // Validate the actual endpoint with one fixed public, tightly bounded request.
  const check = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    signal: AbortSignal.timeout(15000),
    headers: { authorization: `Bearer ${translationKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4.1-mini-2025-04-14',
      input: 'Reply only: OK',
      store: false,
      max_output_tokens: 16,
    }),
  });
  if (!check.ok) {
    const body = await check.json().catch(() => ({}));
    const code =
      typeof body.error?.code === 'string' && /^[a-z_]{1,60}$/i.test(body.error.code)
        ? body.error.code
        : 'unspecified';
    throw new Error(`Existing news editor check failed: HTTP ${check.status} (${code})`);
  }
}
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
    JSON.stringify({
      secretName,
      algorithm: 'RSA-OAEP-SHA256',
      ciphertext: encrypted.toString('base64'),
    }),
  );
  console.log(
    'News service verified. Only an encrypted transfer package was written; apply with local Worker authorization.',
  );
} else {
  const configure = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${cloudflareAccount}/workers/scripts/svitanok/secrets`,
    {
      method: 'PUT',
      signal: AbortSignal.timeout(15000),
      headers: { authorization: `Bearer ${cloudflareToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: secretName,
        text: translationKey,
        type: 'secret_text',
      }),
    },
  );
  if (!configure.ok) throw new Error(`Worker translation setup failed: HTTP ${configure.status}`);
  const result = await configure.json();
  if (!result.success) throw new Error('Worker translation setup was not acknowledged');
  console.log(
    'Existing news service verified; news Worker configured. No credential values logged.',
  );
}
