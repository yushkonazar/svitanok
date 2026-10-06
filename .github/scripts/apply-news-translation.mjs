// Fixed-purpose encrypted transfer when the Actions token only permits D1 access.
// Plaintext exists only in memory and in Wrangler's stdin; never a file or log.
import { constants, generateKeyPairSync, privateDecrypt } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const [mode, directory] = process.argv.slice(2);
if (!directory || !['prepare', 'apply'].includes(mode))
  throw new Error(
    'Usage: node apply-news-translation.mjs prepare|apply <private temporary directory>',
  );
const folder = resolve(directory);
if (mode === 'prepare') {
  mkdirSync(folder, { recursive: true });
  const keys = generateKeyPairSync('rsa', { modulusLength: 4096 });
  writeFileSync(
    join(folder, 'private.pem'),
    keys.privateKey.export({ format: 'pem', type: 'pkcs8' }),
    { flag: 'wx', mode: 0o600 },
  );
  writeFileSync(
    join(folder, 'public.txt'),
    keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    { flag: 'wx' },
  );
  console.log('Ephemeral transfer key pair created. Submit only public.txt to the setup workflow.');
} else {
  const bundle = JSON.parse(readFileSync(join(folder, 'news-translation-transfer.json'), 'utf8'));
  const secretName = bundle.secretName ?? 'GOOGLE_TRANSLATE_API_KEY';
  if (!['GOOGLE_TRANSLATE_API_KEY', 'OPENAI_API_KEY'].includes(secretName))
    throw new Error('Unsupported news service');
  if (bundle.algorithm !== 'RSA-OAEP-SHA256' || typeof bundle.ciphertext !== 'string')
    throw new Error('Invalid encrypted package');
  const value = privateDecrypt(
    {
      key: readFileSync(join(folder, 'private.pem')),
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    Buffer.from(bundle.ciphertext, 'base64'),
  );
  try {
    if (value.length < 20 || value.length > 300 || /\s/.test(value.toString()))
      throw new Error('Unexpected translation credential format');
    const applied = spawnSync(
      process.execPath,
      [
        'node_modules/wrangler/bin/wrangler.js',
        'secret',
        'put',
        secretName,
        '--config',
        'web/wrangler.jsonc',
      ],
      {
        input: Buffer.concat([value, Buffer.from('\n')]),
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 90000,
      },
    );
    if (applied.error || applied.status !== 0)
      throw new Error(`Local Worker secret setup failed (exit ${applied.status ?? 'timeout'})`);
    console.log(
      'Existing news service configured with local Worker authorization. No plaintext files or credential output.',
    );
  } finally {
    value.fill(0);
  }
}
