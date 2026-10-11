import { afterEach, describe, expect, it, vi } from 'vitest';
import { d1FromSqlite } from './helpers/d1.js';
import { memoryKv } from './helpers/kv.js';
import { workerEnv } from './helpers/env.js';
import { buildInitData } from './helpers/init-data.js';
import worker from '../web/worker.js';
import {
  readCredentials,
  saveCredentialMetadata,
  validateCredentialMetadata,
  CREDENTIALS,
} from '../web/core/ops/credentials.mjs';
import {
  cachedGoogleAudit,
  googleGrantIdentity,
  CORE_SCOPES,
  hasFeatureScope,
} from '../web/core/google-scopes.mjs';
import { googleAccessToken } from '../web/google.mjs';
import { queueOpsNotice } from '../web/core/ops/notices.mjs';
import { drainOutbox } from '../web/core/tg/outbox.mjs';
import { connectorStatus } from '../web/settings-core.mjs';
import { secretExpiryTask } from '../web/core/ops/secret-expiry.mjs';

const NOW = Date.parse('2026-10-11T07:00:00Z');
const input = {
  id: 'OPENAI_API_KEY:vps',
  version: 0,
  rotatedAt: '2026-09-01',
  expiresAt: '2026-10-17',
  rotateAfterDays: null,
};
function setup(migrated = true) {
  const d1 = d1FromSqlite([
    '0001_base.sql',
    '0002_assistant.sql',
    ...(migrated ? ['0037_credential_metadata.sql'] : []),
  ]);
  const kv = new Map<string, string>();
  const batch = d1.stub.batch;
  let queue = Promise.resolve();
  d1.stub.batch = (statements) => {
    const work = queue.then(async () => {
      d1.db.exec('BEGIN');
      try {
        const result = await batch(statements);
        d1.db.exec('COMMIT');
        return result;
      } catch (error) {
        d1.db.exec('ROLLBACK');
        throw error;
      }
    });
    queue = work.then(
      () => {},
      () => {},
    );
    return work;
  };
  const env = workerEnv({
    DB: d1.stub,
    BRIEFING: memoryKv(kv),
    TELEGRAM_BOT_TOKEN: 'test-bot',
    TELEGRAM_CHAT_ID: '123',
    TELEGRAM_OWNER_USER_ID: '123',
    TELEGRAM_ALLOWED_USER_IDS: '456',
    TELEGRAM_BOT_USERNAME: 'sample_bot',
    OPENAI_API_KEY: 'SECRET_VALUE_NOT_FOR_UI',
    GOOGLE_CLIENT_ID: 'sample-client',
    GOOGLE_REFRESH_TOKEN: 'sample-refresh',
    GOOGLE_CLIENT_SECRET: 'sample-secret',
  });
  return { env, d1, kv };
}
async function api(env: Env, user: number, body?: Record<string, unknown>) {
  const init = await buildInitData(user, 'test-bot');
  return worker.fetch(
    new Request('https://example.test/api/credentials', {
      method: body ? 'POST' : 'GET',
      headers: { 'X-Telegram-Init-Data': init, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
    env,
    { waitUntil() {} },
  );
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('metadata boundaries', () => {
  it('inventories three OpenAI installations without requiring equal keys', () => {
    expect(
      CREDENTIALS.filter((entry) => entry.name === 'OPENAI_API_KEY').map((entry) => entry.location),
    ).toEqual(['cloudflare', 'vps', 'github']);
  });
  it('stores only supplied metadata and never derives expiry from the rotation year', async () => {
    const { env } = setup();
    await saveCredentialMetadata(env, { ...input, expiresAt: null }, NOW);
    const row = (await readCredentials(env, NOW)).entries.find((entry) => entry.id === input.id)!;
    expect(row.rotatedAt).toBe('2026-09-01');
    expect(row.expiryDaysLeft).toBeNull();
    expect(row.rotationDaysLeft).toBeNull();
    expect(row.version).toBe(1);
    expect(JSON.stringify(row)).not.toContain('SECRET_VALUE_NOT_FOR_UI');
  });
  it('keeps VPS/GitHub/Cloudflare dates independent', async () => {
    const { env } = setup();
    await saveCredentialMetadata(env, input, NOW);
    await saveCredentialMetadata(
      env,
      { ...input, id: 'OPENAI_API_KEY:github', expiresAt: '2026-11-01' },
      NOW,
    );
    const entries = (await readCredentials(env, NOW)).entries;
    expect(entries.find((entry) => entry.id === 'OPENAI_API_KEY:github')?.expiresAt).toBe(
      '2026-11-01',
    );
    expect(entries.find((entry) => entry.id === 'OPENAI_API_KEY:cloudflare')?.expiresAt).toBeNull();
    expect(entries.find((entry) => entry.id === 'OPENAI_API_KEY:cloudflare')?.configured).toBe(
      true,
    );
    expect(entries.find((entry) => entry.id === 'OPENAI_API_KEY:vps')?.configured).toBeNull();
  });
  it('rejects a pasted key, unknown identifiers, partial writes and invalid/future dates', () => {
    for (const body of [
      { ...input, value: 'SECRET_VALUE' },
      { ...input, id: 'arbitrary:key' },
      { id: input.id, version: 0 },
      { ...input, expiresAt: '2026-02-30' },
      { ...input, rotatedAt: '2026-10-12' },
      { ...input, rotateAfterDays: 3651 },
      { ...input, rotateAfterDays: 365, rotatedAt: null },
      { ...input, expiresAt: '2020-01-01' },
    ])
      expect(() => validateCredentialMetadata(body, NOW)).toThrow();
  });
  it('guards concurrent updates and rejects a forged initial version', async () => {
    const { env } = setup();
    expect(await saveCredentialMetadata(env, { ...input, version: 5 }, NOW)).toEqual({
      saved: false,
    });
    const created = await Promise.all([
      saveCredentialMetadata(env, input, NOW),
      saveCredentialMetadata(env, { ...input, expiresAt: '2026-11-11' }, NOW),
    ]);
    expect(created.filter((row) => row.saved)).toHaveLength(1);
    const updated = await Promise.all([
      saveCredentialMetadata(env, { ...input, version: 1, expiresAt: '2026-11-01' }, NOW),
      saveCredentialMetadata(env, { ...input, version: 1, expiresAt: '2026-12-01' }, NOW),
    ]);
    expect(updated.filter((row) => row.saved)).toHaveLength(1);
    expect(
      (await readCredentials(env, NOW)).entries.find((entry) => entry.id === input.id)?.version,
    ).toBe(2);
  });
  it('keeps legacy rotation facts as unassigned references, not provider deadlines', async () => {
    const { env, d1 } = setup();
    d1.db
      .prepare(
        "INSERT INTO facts(id,kind,key,value_json,source,confidence,created_at,updated_at) VALUES('legacy','setting','secret_rotated_OPENAI_API_KEY',?,'owner',1,?,?)",
      )
      .run(
        JSON.stringify('2026-01-01T00:00:00Z'),
        new Date(NOW).toISOString(),
        new Date(NOW).toISOString(),
      );
    const entries = (await readCredentials(env, NOW)).entries.filter(
      (entry) => entry.name === 'OPENAI_API_KEY',
    );
    expect(
      entries.every(
        (entry) =>
          entry.expiresAt == null && entry.rotatedAt == null && entry.legacyRotationAt != null,
      ),
    ).toBe(true);
  });
  it('allows viewing inventory before migration without enabling edits or fake expiry', async () => {
    const { env } = setup(false);
    expect((await readCredentials(env, NOW)).available).toBe(false);
    await expect(saveCredentialMetadata(env, input, NOW)).rejects.toThrow('лише для перегляду');
    expect(await secretExpiryTask(env, NOW)).toEqual({ skipped: 'metadata-unavailable' });
  });
  it('requires the primary owner even to read the private registry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { env } = setup();
    expect((await api(env, 456)).status).toBe(403);
    expect((await api(env, 456, input)).status).toBe(403);
    const view = await api(env, 123);
    expect(view.status).toBe(200);
    expect(view.headers.get('cache-control')).toBe('private, no-store');
    expect(await view.text()).not.toMatch(/SECRET_VALUE_NOT_FOR_UI|sample-refresh|sample-secret/);
    expect((await api(env, 123, input)).status).toBe(200);
    expect((await api(env, 123, input)).status).toBe(409);
    expect((await api(env, 123, { ...input, value: 'PRIVATE' })).status).toBe(400);
  });
  it('acknowledges a committed update even if the response snapshot cannot be read', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { env, d1 } = setup();
    const prepare = d1.stub.prepare;
    d1.stub.prepare = (sql) => {
      if (sql === 'SELECT * FROM credential_metadata') throw new Error('read failed');
      return prepare(sql);
    };
    const response = await api(env, 123, input);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      saved: true,
      error: expect.stringContaining('Дати збережено'),
    });
    expect(
      d1.db.prepare('SELECT version FROM credential_metadata WHERE id=?').get(input.id)?.version,
    ).toBe(1);
  });
});
describe('Google evidence and read/write scopes', () => {
  it('does not perform OAuth or API requests on registry reads', async () => {
    const { env } = setup();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const audit = await cachedGoogleAudit(env, NOW);
    expect(audit.known).toBe(false);
    expect(audit.features.calendar).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('separates cached-but-unverified scopes, actual verified evidence and stale grants', async () => {
    const { env, kv } = setup();
    const cache = { token: 'token', expMs: NOW + 3600000, scope: CORE_SCOPES.join(' ') };
    kv.set('googleToken', JSON.stringify(cache));
    expect(await cachedGoogleAudit(env, NOW)).toMatchObject({ known: true, verified: false });
    const grantIdentity = await googleGrantIdentity(env);
    kv.set(
      'googleToken',
      JSON.stringify({ ...cache, grantIdentity, scopeCheckedAt: new Date(NOW).toISOString() }),
    );
    const trusted = await cachedGoogleAudit(env, NOW);
    expect(trusted).toMatchObject({ known: true, verified: true });
    expect(JSON.stringify(trusted)).not.toContain(grantIdentity!);
    env.GOOGLE_REFRESH_TOKEN = 'a-different-grant';
    expect(await cachedGoogleAudit(env, NOW)).toMatchObject({ known: false, verified: false });
  });
  it('forces normal token refresh when a bound cached token belongs to a different grant', async () => {
    const { env, kv } = setup();
    kv.set(
      'googleToken',
      JSON.stringify({
        token: 'old-token',
        expMs: Date.now() + 3600000,
        grantIdentity: 'different',
        scope: CORE_SCOPES.join(' '),
      }),
    );
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        access_token: 'new-token',
        expires_in: 3600,
        scope: CORE_SCOPES.join(' '),
      }),
    );
    vi.stubGlobal('fetch', fetch);
    expect(await googleAccessToken(env)).toBe('new-token');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(kv.get('googleToken')!).grantIdentity).toBe(await googleGrantIdentity(env));
  });
  it('read-only calendar and contacts work for reading, not for writes; Gmail send alone is not mail reading', () => {
    const scopes = [
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/contacts.readonly',
      'https://www.googleapis.com/auth/gmail.send',
    ];
    expect(hasFeatureScope(scopes, 'calendar_read')).toBe(true);
    expect(hasFeatureScope(scopes, 'calendar')).toBe(false);
    expect(hasFeatureScope(scopes, 'contacts_read')).toBe(true);
    expect(hasFeatureScope(scopes, 'contacts')).toBe(false);
    expect(connectorStatus({ hasGoogleCreds: true, scope: scopes.join(' ') })).toMatchObject({
      calendar: true,
      contacts: true,
      gmail: false,
    });
  });
});
describe('durable actionable notices', () => {
  it('suppresses a queued Google warning after the grant permissions changed', async () => {
    const { env, kv } = setup();
    const grantIdentity = await googleGrantIdentity(env);
    const scope = 'https://www.googleapis.com/auth/gmail.send';
    kv.set(
      'googleToken',
      JSON.stringify({
        token: 'AT',
        expMs: NOW + 3600000,
        scope: [...CORE_SCOPES, scope].join(' '),
        grantIdentity,
        scopeCheckedAt: new Date(NOW).toISOString(),
      }),
    );
    await queueOpsNotice(env, 'google-test', 'old permission warning', NOW, null, null, {
      scopeState: `${scope}|`,
    });
    kv.set(
      'googleToken',
      JSON.stringify({
        token: 'AT',
        expMs: NOW + 3600000,
        scope: CORE_SCOPES.join(' '),
        grantIdentity,
        scopeCheckedAt: new Date(NOW).toISOString(),
      }),
    );
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await drainOutbox(env, { nowMs: NOW, sleep: async () => {} });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('deduplicates concurrent enqueue, includes a private Mini App link and survives outbox retention', async () => {
    const { env, d1 } = setup();
    await saveCredentialMetadata(env, input, NOW);
    const queued = await Promise.all([
      queueOpsNotice(env, 'deadline', 'text', NOW, { ...input, version: 1 }, 'expiry'),
      queueOpsNotice(env, 'deadline', 'text', NOW, { ...input, version: 1 }, 'expiry'),
    ]);
    expect(queued.filter(Boolean)).toHaveLength(1);
    const payload = JSON.parse(
      String(d1.db.prepare('SELECT payload_json FROM outbox').get()?.payload_json),
    );
    expect(payload.reply_markup.inline_keyboard[0][0].url).toBe(
      'https://t.me/sample_bot?startapp=access',
    );
    d1.db.exec('DELETE FROM outbox');
    expect(
      await queueOpsNotice(env, 'deadline', 'text', NOW, { ...input, version: 1 }, 'expiry'),
    ).toBe(false);
  });
  it('rolls back the durable claim if enqueue fails and can retry', async () => {
    const { env, d1 } = setup();
    d1.db.exec(
      "CREATE TRIGGER fail_notice BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'failure'); END",
    );
    await expect(queueOpsNotice(env, 'test', 'text', NOW)).rejects.toThrow();
    expect(d1.db.prepare('SELECT count(*) AS n FROM ops_notices').get()?.n).toBe(0);
    d1.db.exec('DROP TRIGGER fail_notice');
    expect(await queueOpsNotice(env, 'test', 'text', NOW)).toBe(true);
  });
  it('does not queue from a stale metadata version or deliver an old date after editing', async () => {
    const { env } = setup();
    await saveCredentialMetadata(env, input, NOW);
    expect(await queueOpsNotice(env, 'stale', 'text', NOW, input, 'expiry')).toBe(false);
    await queueOpsNotice(env, 'current', 'text', NOW, { ...input, version: 1 }, 'expiry');
    await saveCredentialMetadata(env, { ...input, version: 1, expiresAt: '2026-12-01' }, NOW);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await drainOutbox(env, { nowMs: NOW, sleep: async () => {} });
    expect(fetch).not.toHaveBeenCalled();
  });
});
