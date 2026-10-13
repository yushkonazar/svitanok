import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { d1FromSqlite } from './helpers/d1.js';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';
import { buildInitData } from './helpers/init-data.js';
import worker from '../web/worker.js';
import { extractExplicitFact } from '../web/core/memory/explicit.mjs';
import { directOwnerMemory } from '../web/core/memory/direct.mjs';
import { readMemoryPreferences } from '../web/core/memory/preferences.mjs';
import {
  readMemoryWorkspace,
  validateMemoryCommand,
  executeMemoryCommand,
} from '../web/core/memory/workspace.mjs';
import { runFactsGet, runFactsSet, runFactsLedger } from '../web/core/tools/facts.mjs';
import { applyPolicy, resolveUndo } from '../web/core/policy/proposals.mjs';
import { parseUpdate } from '../web/tg-core.mjs';
import { savePendingVoice, claimPendingVoice } from '../web/core/voice.mjs';
import { prerouteMessage, handleBrainCallback } from '../web/core/prerouter.mjs';

const NOW = Date.parse('2026-10-11T14:00:00Z');
const migrationDir = join(__dirname, '..', 'web', 'core', 'migrations');
function setup(voiceEvidence = true) {
  const files = readdirSync(migrationDir)
    .filter((name) => name.endsWith('.sql') && (voiceEvidence || !name.startsWith('0038_')))
    .sort();
  const d1 = d1FromSqlite(files, { atomicBatch: true });
  const env = workerEnv({
    DB: d1.stub,
    BRIEFING: memoryKv(new Map()),
    TELEGRAM_BOT_TOKEN: 'memory-test-bot',
    TELEGRAM_OWNER_USER_ID: '123',
    TELEGRAM_CHAT_ID: '123',
    TELEGRAM_ALLOWED_USER_IDS: '456',
    ASSISTANT_V2: 'on',
  });
  return { env, d1 };
}
const categories = ['preferences', 'schedule', 'style'];
async function enable(env: Env, mode = 'explicit', source = 'owner_assertion') {
  await runFactsSet(
    env,
    { kind: 'setting', key: 'personalization', value: { version: 1, mode, categories }, source },
    NOW,
  );
}
const owner = {
  kind: 'message',
  fromId: 123,
  messageId: 42,
  chatId: 123,
  threadId: null,
  ownerComposed: true,
};
async function api(env: Env, body?: unknown, user = 123, query = '') {
  const init = await buildInitData(user, 'memory-test-bot');
  return worker.fetch(
    new Request(`https://example.test/api/memory${query}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'X-Telegram-Init-Data': init, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
    { waitUntil() {} },
  );
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('first-party explicit memory', () => {
  it('updates a reclassified preference rather than creating a hashed duplicate', async () => {
    const { env } = setup();
    await enable(env);
    await runFactsSet(
      env,
      {
        kind: 'habit',
        key: 'favorite_dish',
        value: {
          schemaVersion: 2,
          type: 'preference',
          domain: 'food',
          subject: 'Салат у ресторані Приклад',
          relation: 'likes',
        },
        source: 'owner_assertion',
      },
      NOW,
    );
    const result = await directOwnerMemory(
      env,
      owner,
      'Запам’ятай: не люблю салат у ресторані Приклад',
      NOW + 1000,
    );
    expect(result?.text).toContain('Пам’ятаю');
    const workspace = await readMemoryWorkspace(env, NOW + 2000);
    expect(workspace.entries).toHaveLength(1);
    expect(workspace.entries[0]).toMatchObject({
      id: 'habit:favorite_dish',
      value: { relation: 'dislikes', domain: 'food' },
    });
  });
  it.each(['Люблю азійську кухню.', 'Я люблю азійську кухню', 'Запам’ятай: люблю азійську кухню'])(
    'recognizes one owner preference: %s',
    async (text) => {
      const fact = await extractExplicitFact(text);
      expect(fact).toMatchObject({
        category: 'preferences',
        kind: 'profile',
        value: { preference: 'азійську кухню', stance: 'like' },
      });
    },
  );
  it.each(['Не люблю піцу', 'Я не люблю піцу', 'Мені не подобається піцу'])(
    'does not invert a negative preference: %s',
    async (text) =>
      expect(await extractExplicitFact(text)).toMatchObject({ value: { stance: 'dislike' } }),
  );
  it.each([
    '«Люблю піцу»',
    'Він сказав: люблю піцу',
    'Люблю піцу?',
    'Наприклад, люблю піцу',
    'Якби я сказав: люблю піцу',
    'Люблю піцу, але не сьогодні',
    'Люблю піцу зараз',
    'Люблю піцу\nНе люблю суші',
    'Нагадай завтра о 8',
    'Люблю https://example.test',
    'Зазвичай прокидаюся о 25:00',
    'Завтра прокинуся о 08:00',
  ])('keeps ambiguous/quoted/temporary text on the regular path: %s', async (text) =>
    expect(await extractExplicitFact(text)).toBeNull(),
  );
  it('uses a stable identity for like/dislike and accepts explicit stable time/style', async () => {
    expect((await extractExplicitFact('Люблю ПІЦУ'))?.key).toBe(
      (await extractExplicitFact('Не люблю піцу'))?.key,
    );
    expect(await extractExplicitFact('Зазвичай прокидаюся о 8:00')).toMatchObject({
      kind: 'habit',
      key: 'day_start',
      value: '08:00',
    });
    expect(await extractExplicitFact('Відповідай коротко')).toMatchObject({
      kind: 'profile',
      key: 'reply_style',
      value: 'коротко',
    });
  });
  it('defaults to confirmation and ignores model-produced opt-in', async () => {
    const { env } = setup();
    expect((await readMemoryPreferences(env)).preferences.mode).toBe('confirm');
    expect(await directOwnerMemory(env, owner, 'Люблю піцу', NOW)).toBeNull();
    await enable(env, 'explicit', 'inferred');
    expect(await readMemoryPreferences(env)).toMatchObject({
      valid: false,
      preferences: { mode: 'confirm' },
    });
    expect(await directOwnerMemory(env, owner, 'Люблю піцу', NOW)).toBeNull();
  });
  it('a model cannot enable memory via T0 or forge first-party evidence in tool arguments', async () => {
    const { env } = setup();
    const setting = await applyPolicy(
      env,
      {
        kind: 'facts.set',
        payload: {
          kind: 'setting',
          key: 'personalization',
          value: { version: 1, mode: 'explicit', categories },
        },
        tainted: false,
      },
      NOW,
    );
    expect(setting.mode).toBe('proposed');
    await enable(env);
    const fact = (await extractExplicitFact('Люблю піцу'))!;
    const out = await applyPolicy(
      env,
      {
        kind: 'facts.set',
        payload: {
          kind: fact.kind,
          key: fact.key,
          value: fact.value,
          internal: {
            ownerFactEvidence: {
              ownerId: 123,
              ownerComposed: true,
              messageId: 42,
              text: 'Люблю піцу',
              origin: 'text',
            },
          },
        },
        tainted: false,
      },
      NOW,
    );
    expect(out.mode).toBe('proposed');
    expect((await runFactsGet(env, { kind: fact.kind, key: fact.key })).result).toHaveLength(0);
  });
  it('records an allowed owner assertion, deduplicates it, and keeps an undo', async () => {
    const { env } = setup();
    await enable(env);
    const saved = await directOwnerMemory(env, owner, 'Люблю піцу', NOW + 1);
    expect(saved?.text).toContain('Пам’ятаю');
    const fact = (await extractExplicitFact('Люблю піцу'))!;
    expect((await runFactsGet(env, { kind: fact.kind, key: fact.key })).result[0]).toMatchObject({
      source: 'owner_assertion',
      value: fact.value,
    });
    expect((await directOwnerMemory(env, owner, 'Люблю піцу', NOW + 2))?.text).toBe(
      'Це вже пам’ятаю.',
    );
    expect((await runFactsLedger(env, { kind: fact.kind, key: fact.key })).result).toHaveLength(1);
    const keyboard = saved?.reply_markup?.inline_keyboard as
      Array<Array<{ callback_data: string }>> | undefined;
    const button = keyboard?.[0]?.[0]?.callback_data;
    expect(button).toMatch(/^u:/);
    expect(await resolveUndo(env, String(button).slice(2), NOW + 3)).toMatchObject({
      status: 'undone',
    });
  });
  it.each([
    { ...owner, ownerComposed: false },
    { ...owner, fromId: 456 },
    { ...owner, messageId: 0 },
    { ...owner, memoryOrigin: 'import' },
  ])('does not auto-record forwarded, foreign or unbound evidence', async (parsed) => {
    const { env } = setup();
    await enable(env);
    const out = await directOwnerMemory(env, parsed, 'Люблю піцу', NOW + 1);
    expect(out == null || !out.text.startsWith('Пам’ятаю')).toBe(true);
    expect((await readMemoryWorkspace(env, NOW)).entries).toHaveLength(0);
  });
  it('respects category selection and stops a queued write after opt-out', async () => {
    const { env, d1 } = setup();
    await enable(env);
    await executeMemoryCommand(
      env,
      {
        type: 'preferences',
        preferences: { version: 1, mode: 'explicit', categories: ['style'] },
        token: (await readMemoryPreferences(env)).token,
      },
      NOW + 1,
    );
    expect(await directOwnerMemory(env, owner, 'Люблю піцу', NOW + 2)).toBeNull();
    await enable(env);
    const batch = d1.stub.batch;
    let inject = true;
    d1.stub.batch = async (statements) => {
      if (inject) {
        inject = false;
        await enable(env, 'confirm');
      }
      return batch(statements);
    };
    const out = await directOwnerMemory(env, owner, 'Люблю піцу', NOW + 3);
    expect(out?.text).toContain('уже змінився');
    expect((await readMemoryWorkspace(env, NOW)).entries).toHaveLength(0);
  });
  it('does not steal a pending answer, while a remember/style command remains explicit', async () => {
    const { env, d1 } = setup();
    await enable(env);
    d1.db
      .prepare('INSERT INTO sessions(thread_id,transcript_md) VALUES (?,?)')
      .run('dm', 'Власник: Поїздка\nСвітанок: Яку кухню обрати?\n');
    expect(await directOwnerMemory(env, owner, 'Люблю піцу', NOW)).toBeNull();
    expect((await directOwnerMemory(env, owner, 'Запам’ятай: люблю піцу', NOW))?.text).toContain(
      'Пам’ятаю',
    );
    expect((await directOwnerMemory(env, owner, 'Відповідай коротко', NOW))?.text).toContain(
      'Пам’ятаю',
    );
  });
  it('uses the owner-only prerouter, without starting the brain or a paid request', async () => {
    const { env } = setup();
    await enable(env);
    const fetcher = vi.fn(
      async (_request: unknown) =>
        new Response(JSON.stringify({ ok: true, result: { message_id: 91 } }), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetcher);
    const parsed = parseUpdate({
      update_id: 1,
      message: { message_id: 42, from: { id: 123 }, chat: { id: 123 }, text: 'Люблю піцу' },
    });
    expect(await prerouteMessage(env, parsed, NOW)).toBe(true);
    expect(fetcher.mock.calls.every((call) => String(call[0]).includes('api.telegram.org'))).toBe(
      true,
    );
    expect((await readMemoryWorkspace(env, NOW)).entries).toHaveLength(1);
  });
  it('keeps the original voice flag across confirmation and safely handles old schema', async () => {
    for (const evidence of [true, false]) {
      const { env } = setup(evidence);
      const id = await savePendingVoice(
        env,
        {
          kind: 'transcript',
          text: 'Люблю піцу',
          durationS: 3,
          chatId: 123,
          threadId: null,
          ownerComposed: true,
        },
        NOW,
      );
      expect((await claimPendingVoice(env, id, NOW + 1))?.ownerComposed).toBe(evidence);
    }
    expect(
      parseUpdate({
        message: {
          message_id: 42,
          from: { id: 123 },
          chat: { id: 123 },
          forward_origin: { type: 'user' },
          text: 'Люблю піцу',
        },
      }),
    ).toMatchObject({ ownerComposed: false });
  });
  it.each([true, false])('confirmed voice keeps first-party evidence (%s)', async (original) => {
    const { env } = setup();
    await enable(env);
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init?: RequestInit) => {
        requests.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
        return Response.json({ ok: true, result: { message_id: 91 } });
      }),
    );
    const id = await savePendingVoice(
      env,
      {
        kind: 'transcript',
        text: 'Люблю піцу',
        durationS: 3,
        chatId: 123,
        threadId: null,
        ownerComposed: original,
      },
      NOW,
    );
    expect(
      await handleBrainCallback(env, { data: `v:${id}:ok`, chatId: 123, messageId: 91 }, NOW),
    ).toBe('Прийняв ✅');
    expect((await readMemoryWorkspace(env, NOW)).entries).toHaveLength(original ? 1 : 0);
    if (original) {
      const reply = requests.find((item) => String(item.body.text).includes('Пам’ятаю'));
      expect(reply?.body.reply_markup).toMatchObject({
        inline_keyboard: [[{ callback_data: expect.stringMatching(/^u:/) }]],
      });
      expect(reply?.url).toContain('editMessageText');
      expect(reply?.body.message_id).toBe(91);
      expect(requests.filter((item) => String(item.body.text).includes('Пам’ятаю'))).toHaveLength(
        1,
      );
      expect(requests.every((item) => item.url.includes('api.telegram.org'))).toBe(true);
      expect(
        await handleBrainCallback(env, { data: `v:${id}:ok`, chatId: 123, messageId: 91 }, NOW),
      ).toContain('Застаріло');
      expect((await readMemoryWorkspace(env, NOW)).entries).toHaveLength(1);
    }
  });
  it.each([
    { forward_origin: { type: 'user' } },
    { via_bot: { id: 222 } },
    { quote: { text: 'Люблю піцу' } },
    { entities: [{ type: 'blockquote', offset: 0, length: 10 }] },
    { business_connection_id: 'synthetic' },
    { sender_chat: { id: 222 } },
  ])('does not attribute forwarded, quoted or delegated text to the owner: %j', (metadata) => {
    expect(
      parseUpdate({
        update_id: 1,
        message: {
          message_id: 42,
          from: { id: 123 },
          chat: { id: 123 },
          text: 'Люблю піцу',
          ...metadata,
        },
      }),
    ).toMatchObject({ ownerComposed: false });
  });
  it('expired consent fails closed and an explicit new choice renews it', async () => {
    const { env } = setup();
    await runFactsSet(
      env,
      {
        kind: 'setting',
        key: 'personalization',
        value: { version: 1, mode: 'explicit', categories },
        source: 'owner',
        expires_at: new Date(NOW - 1).toISOString(),
      },
      NOW,
    );
    expect(await readMemoryPreferences(env, NOW)).toMatchObject({
      valid: false,
      preferences: { mode: 'confirm' },
    });
    expect(await directOwnerMemory(env, owner, 'Люблю піцу', NOW)).toBeNull();
    const before = await readMemoryWorkspace(env, NOW);
    await executeMemoryCommand(
      env,
      {
        type: 'preferences',
        token: before.preferencesToken,
        preferences: { version: 1, mode: 'explicit', categories },
      },
      NOW,
    );
    expect(await readMemoryPreferences(env, NOW)).toMatchObject({
      valid: true,
      preferences: { mode: 'explicit' },
    });
  });
});

describe('private shared memory workspace', () => {
  it('primary-owner only, private no-store, never secret inventory or demos', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const { env } = setup();
    const empty = await api(env);
    expect(empty.status).toBe(200);
    expect(empty.headers.get('cache-control')).toBe('private, no-store');
    expect((await empty.json()).preferences.mode).toBe('confirm');
    expect((await api(env, undefined, 456)).status).toBe(403);
    const raw = await worker.fetch(new Request('https://example.test/api/memory'), env, {
      waitUntil() {},
    });
    expect(raw.status).toBe(401);
    await runFactsSet(
      env,
      { kind: 'setting', key: 'internal_secret', value: 'PRIVATE_NON_UI_DATA' },
      NOW,
    );
    expect(JSON.stringify(await (await api(env)).json())).not.toContain('PRIVATE_NON_UI_DATA');
  });
  it('strict commands cannot impersonate source, write config fields or omit confirmation', () => {
    expect(() =>
      validateMemoryCommand({
        type: 'update',
        id: 'habit:day_start',
        value: '08:00',
        token: '',
        confirm: true,
        renew: true,
        source: 'trusted_server',
      }),
    ).toThrow('непідтримувані');
    expect(() =>
      validateMemoryCommand({
        type: 'remove',
        id: 'setting:personalization',
        token: '',
        confirm: true,
      }),
    ).toThrow('не належить');
    expect(() =>
      validateMemoryCommand({
        type: 'update',
        id: 'habit:day_start',
        value: '08:00',
        token: '',
        renew: true,
      }),
    ).toThrow('Підтверди');
    expect(() =>
      validateMemoryCommand({
        type: 'preferences',
        token: '',
        preferences: { version: 1, mode: 'explicit', categories: ['mail'] },
      }),
    ).toThrow('категорії');
  });
  it('rejects obvious access data before it becomes a proposal or fact', async () => {
    const { env, d1 } = setup();
    const out = await applyPolicy(
      env,
      {
        kind: 'facts.set',
        payload: { kind: 'profile', key: 'sample', value: { api_key: 'SYNTHETIC_NOT_REAL' } },
        tainted: false,
      },
      NOW,
    );
    expect(out.mode).toBe('error');
    expect(d1.db.prepare('SELECT count(*) AS n FROM proposals').get()).toMatchObject({ n: 0 });
  });
  it.each(['OPENAI_API_KEY', 'apiKey', 'refreshToken'])(
    'refuses recognizable credential fields: %s',
    async (key) => {
      const { env, d1 } = setup();
      const result = await applyPolicy(
        env,
        {
          kind: 'facts.set',
          payload: { kind: 'profile', key: 'sample', value: { [key]: 'SYNTHETIC_NOT_REAL' } },
          tainted: false,
        },
        NOW,
      );
      expect(result.mode).toBe('error');
      expect(d1.db.prepare('SELECT count(*) AS n FROM proposals').get()).toMatchObject({ n: 0 });
    },
  );
  it('edits, renews and removes through the same fact ledger and rejects stale versions', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const { env } = setup();
    await runFactsSet(
      env,
      {
        kind: 'habit',
        key: 'day_start',
        value: '08:00',
        source: 'owner',
        observed_at: '2026-01-01T00:00:00Z',
        expires_at: '2026-02-01T00:00:00Z',
        review_at: '2026-02-01T00:00:00Z',
      },
      NOW,
    );
    const entry = (await readMemoryWorkspace(env, NOW)).entries[0]!;
    expect(entry.stale).toBe(true);
    const update = {
      type: 'update',
      id: entry.id,
      token: entry.token,
      value: '09:00',
      confirm: true,
      renew: true,
    };
    const saved = await api(env, update);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      acknowledged: true,
      entries: [{ text: '09:00', stale: false, expiresAt: null, reviewAt: null }],
    });
    expect((await api(env, { ...update, value: '10:00' })).status).toBe(409);
    const fresh = (await readMemoryWorkspace(env, NOW)).entries[0]!;
    expect(
      (await api(env, { type: 'remove', id: fresh.id, token: fresh.token, confirm: true })).status,
    ).toBe(200);
    expect((await runFactsGet(env, { kind: 'habit', key: 'day_start' })).result).toHaveLength(0);
    expect((await runFactsLedger(env, { kind: 'habit', key: 'day_start' })).result).toHaveLength(3);
  });
  it('persists explicit opt-in, protects configuration versions and refuses fabricated preference identities', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const { env } = setup();
    const choice = {
      type: 'preferences',
      token: '',
      preferences: { version: 1, mode: 'explicit', categories: ['preferences'] },
    };
    expect((await api(env, choice)).status).toBe(200);
    expect(
      (await api(env, { ...choice, preferences: { ...choice.preferences, mode: 'confirm' } }))
        .status,
    ).toBe(409);
    await directOwnerMemory(env, owner, 'Люблю піцу', NOW);
    const entry = (await readMemoryWorkspace(env, NOW)).entries[0]!;
    expect(
      (
        await api(env, {
          type: 'update',
          id: entry.id,
          token: entry.token,
          value: { preference: 'суші', stance: 'like' },
          confirm: true,
          renew: false,
        })
      ).status,
    ).toBe(400);
  });
  it('shows and resolves only memory proposals; stale candidates are explicit', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const { env } = setup();
    const proposed = await applyPolicy(
      env,
      {
        kind: 'facts.set',
        payload: { kind: 'habit', key: 'day_start', value: '08:00' },
        tainted: false,
      },
      NOW,
    );
    if (proposed.mode !== 'proposed') throw new Error('Missing proposal');
    const workspace = await readMemoryWorkspace(env, NOW);
    expect(workspace.candidates).toHaveLength(1);
    expect(
      (await api(env, { type: 'resolve', id: proposed.proposal.id, choice: 'ok' })).status,
    ).toBe(200);
    expect((await readMemoryWorkspace(env, NOW)).entries[0]?.source).toBe('owner_assertion');
    const stale = await applyPolicy(
      env,
      { kind: 'facts.delete', payload: { kind: 'habit', key: 'day_start' }, tainted: false },
      NOW + 1,
    );
    await runFactsSet(
      env,
      { kind: 'habit', key: 'day_start', value: '09:00', source: 'owner' },
      NOW + 2,
    );
    expect((await readMemoryWorkspace(env, NOW)).candidates[0]?.stale).toBe(true);
    if (stale.mode !== 'proposed') throw new Error('Missing stale proposal');
    expect((await api(env, { type: 'resolve', id: stale.proposal.id, choice: 'ok' })).status).toBe(
      409,
    );
  });
  it('pages through facts without prompts or history dumps', async () => {
    const { env } = setup();
    for (let n = 0; n < 28; n++)
      await runFactsSet(
        env,
        {
          kind: 'profile',
          key: `fixture_${String(n).padStart(2, '0')}`,
          value: `Факт ${n}`,
          source: 'owner',
        },
        NOW + n,
      );
    const first = await readMemoryWorkspace(env, NOW);
    expect(first.entries).toHaveLength(25);
    expect(first.nextOffset).toBe(25);
    expect((await readMemoryWorkspace(env, NOW, 25)).entries).toHaveLength(3);
    expect(JSON.stringify(first)).not.toMatch(/payload_json|context_json|prompt|input|output/);
  });
  it.each(['constructor', 'toString'])(
    'uses human labels even for a prototype-like fact key: %s',
    async (key) => {
      const { env } = setup();
      await runFactsSet(
        env,
        { kind: 'profile', key, value: 'Тестовий факт', source: 'owner' },
        NOW,
      );
      expect((await readMemoryWorkspace(env, NOW)).entries[0]?.label).toBe('Про тебе');
    },
  );
  it('acknowledges a committed change even when the later snapshot read fails', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const { env, d1 } = setup();
    const prepare = d1.stub.prepare;
    d1.stub.prepare = (sql) => {
      if (sql.includes('SELECT f.*')) throw new Error('storage SECRET_INTERNAL');
      return prepare(sql);
    };
    const response = await api(env, {
      type: 'preferences',
      token: '',
      preferences: { version: 1, mode: 'confirm', categories: [] },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      acknowledged: true,
      message: 'Режим пам’яті збережено.',
      error: expect.stringContaining('показ'),
    });
    expect((await readMemoryPreferences(env)).configured).toBe(true);
  });
  it('does not report an empty healthy workspace when storage fails', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const { env, d1 } = setup();
    d1.stub.prepare = () => {
      throw new Error('SELECT SECRET_DATA');
    };
    const response = await api(env);
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain('SECRET_DATA');
  });
});
