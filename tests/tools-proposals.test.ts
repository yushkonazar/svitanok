// proposals.create і chain.start (етап 2 PR-6, 07 §4).
//
// proposals.create - єдиний інструмент, чий РІВЕНЬ підтвердження визначається
// не ним самим, а аргументом `kind`: він не дія, а обгортка «створи
// пропозицію на дію X». Тому тут перевіряється наскрізний шлях через router
// (де живе write.kindFrom), а не лише виконавець.
//
// chain.start - з етапу 5 виконує kind=table; trip/price - чесна відмова,
// і власник дістає чесне «виконавця ще немає» замість тиші.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TOOLS } from '../web/core/tools/index.mjs';
import { applyPolicy, resolveProposal } from '../web/core/policy/proposals.mjs';
import { ACTION_LEVELS } from '../web/core/policy/core.mjs';
import { handleInternal } from '../web/core/internal/router.mjs';
import { signInternal } from '../web/core/internal/auth.mjs';
import { workerEnv } from './helpers/env.js';
import { d1FromSqlite } from './helpers/d1.js';

const NOW = Date.parse('2026-08-28T10:00:00.000Z');
const KEY = 'proposals-test-key';
const RUN_ID = 'run-1';

function makeEnv(over: Record<string, unknown> = {}) {
  const d1 = d1FromSqlite(['0001_base.sql', '0002_assistant.sql']);
  const env = workerEnv({
    ASSISTANT_V2: 'on',
    INTERNAL_HMAC_KEY: KEY,
    DB: d1.stub,
    RUN_REGISTRY: {
      getByName: () => ({
        has: async () => true,
        consumeNonce: async () => true,
        runInfo: async () => ({ threadId: 'dm', chatId: 555 }),
      }),
    },
    ...over,
  });
  return { d1, env };
}

/** Підписаний виклик інструмента - той самий шлях, яким ходить мозок. */
async function callTool(env: Env, name: string, args: unknown, nowMs = NOW) {
  const path = `/internal/tool/${name}`;
  const rawBody = JSON.stringify({ args });
  const nonce = crypto.randomUUID();
  const signature = await signInternal(KEY, {
    method: 'POST',
    path,
    timestampMs: nowMs,
    runId: RUN_ID,
    nonce,
    rawBody,
  });
  const req = new Request(`https://svitanok.example${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Internal-Timestamp': String(nowMs),
      'X-Internal-Run': RUN_ID,
      'X-Internal-Nonce': nonce,
      'X-Internal-Signature': signature,
    },
    body: rawBody,
  });
  // Сигнатура: (request, env, nowMs, ctx) - порядок саме такий.
  const res = await handleInternal(req, env, nowMs, { waitUntil: () => {} } as never);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('proposals.create: рівень бере kind з аргументів', () => {
  it('T1-дія (подія календаря) стає пропозицією з кнопками, нічого не виконано', async () => {
    const { env } = makeEnv();
    const { status, body } = await callTool(env, 'proposals.create', {
      kind: 'calendar.event',
      payload: { title: 'Зустріч', at: '2026-08-29T09:00:00Z' },
    });

    expect(status).toBe(200);
    expect(body.mode).toBe('proposed');
    const proposal = body.proposal as { level: string; word: string | null };
    expect(proposal.level).toBe('T1');
    expect(proposal.word).toBeNull(); // слово - лише для T2
  });

  it('T2-дія (forget) вимагає слова-підтвердження', async () => {
    const { env } = makeEnv();
    const { body } = await callTool(env, 'proposals.create', {
      kind: 'forget',
      payload: { what: 'чат' },
    });
    const proposal = body.proposal as { level: string; word: string | null };
    expect(proposal.level).toBe('T2');
    expect(typeof proposal.word).toBe('string');
  });

  it('невідомий kind - відмова policy, а не мовчазна пропозиція', async () => {
    const { env } = makeEnv();
    const { status, body } = await callTool(env, 'proposals.create', { kind: 'вигадана.дія' });
    expect(status).toBe(400);
    expect(String(body.error)).toContain('policy:');
  });

  it('порожній kind відкидається до policy', async () => {
    const { env } = makeEnv();
    const { status, body } = await callTool(env, 'proposals.create', { kind: '' });
    expect(status).toBe(400);
    expect(String(body.error)).toContain('kind не заданий');
  });

  it('T0-дію через обгортку НЕ пускає: підтвердження обіцяне - має бути справжнім', async () => {
    // Інакше модель викликала б proposals.create(kind='record'|'reminders.create')
    // і дія виконалась би миттєво, повз схему самого інструмента, хоча опис
    // у мозку обіцяє власнику протилежне (security-ревʼю PR-6).
    const { env } = makeEnv();
    for (const kind of ['record', 'reminders.create', 'facts.set']) {
      const { status, body } = await callTool(env, 'proposals.create', {
        kind,
        payload: { kind: 'roadmap', payload: {} },
      });
      expect(status).toBe(400);
      expect(String(body.error)).toContain('direct-tool');
    }
  });

  it('після ✅ без виконавця - ЧЕСНЕ «no-executor», а не «прийнято і забуто»', async () => {
    const { env } = makeEnv();
    const { body } = await callTool(env, 'proposals.create', {
      kind: 'contact',
      payload: { name: 'Олена' },
    });
    const proposal = body.proposal as { id: string };
    const decided = await resolveProposal(env, { id: proposal.id, choice: 'ok' }, NOW + 1000);
    expect(decided).toMatchObject({ ok: false });
    expect(String((decided as { error: string }).error)).toContain('no-executor');
  });

  it('payload дії передається виконавцю БЕЗ обгортки {kind, payload}', async () => {
    // Виконавець є лише у facts.set, і сам по собі це T0. Але з source=owner
    // policy ескалює його до T1 - саме такий випадок і легітимний для
    // обгортки: підтвердження справді потрібне.
    const { d1, env } = makeEnv();
    const { body } = await callTool(env, 'proposals.create', {
      kind: 'facts.set',
      payload: { kind: 'setting', key: 'мова', value: 'укр', source: 'owner' },
    });
    expect(body.mode).toBe('proposed');
    const proposal = body.proposal as { id: string };
    const approved = await resolveProposal(env, { id: proposal.id, choice: 'ok' }, NOW + 1000);
    expect(approved).toMatchObject({ ok: true, status: 'approved', executed: true });

    const row = d1.db.prepare("SELECT key, value_json FROM facts WHERE kind = 'setting'").get() as {
      key: string;
      value_json: string;
    };
    expect(row).toMatchObject({ key: 'мова' });
    expect(JSON.parse(row.value_json)).toBe('укр');
  });
});

describe('chain.start: невідомий kind і брак привʼязки - чесна відмова', () => {
  it('є в реєстрі як write (T0); без привʼязки Workflow - її назва, невідомий kind - перелік', async () => {
    expect(TOOLS['chain.start']!.write).toEqual({ kind: 'chain.start' });
    expect(ACTION_LEVELS['chain.start']).toBe('T0');
    expect(ACTION_LEVELS['chain.cancel']).toBe('T0');

    const { env } = makeEnv();
    await expect(
      applyPolicy(env, { kind: 'chain.start', payload: { kind: 'trip' }, tainted: false }, NOW),
    ).rejects.toThrow(/TRIP_CHAIN/);
    await expect(
      applyPolicy(env, { kind: 'chain.start', payload: { kind: 'x' }, tainted: false }, NOW),
    ).rejects.toThrow(/дозволені: table/);
  });

  it('через router відмова доходить до мозку як 502 tool-failed з причиною', async () => {
    const { env } = makeEnv();
    const { status, body } = await callTool(env, 'chain.start', { kind: 'trip' });
    expect(status).toBe(502);
    expect(String(body.reason)).toContain('TRIP_CHAIN');
  });
});
