// Policy + proposals (етап 1, PR-8): таблиця рівнів × taint, T0 з «↩»,
// пропозиції T1/T2 з TTL і словом, ідемпотентність рішень, інтеграція
// write-інструмента через router. D1 - node:sqlite зі справжніми міграціями
// 0001 (facts, sessions) і 0002 (proposals).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ACTION_LEVELS,
  decideLevel,
  parsePolicyCallback,
  proposalButtons,
  PROPOSAL_TTL_MS,
  UNDO_WINDOW_MS,
} from '../web/core/policy/core.mjs';
import { applyPolicy, resolveProposal, resolveUndo } from '../web/core/policy/proposals.mjs';
import { runFactsGet, runFactsSet } from '../web/core/tools/facts.mjs';
import { handleInternal } from '../web/core/internal/router.mjs';
import { signInternal } from '../web/core/internal/auth.mjs';
import { workerEnv } from './helpers/env.js';

const NOW = Date.parse('2026-08-28T10:00:00.000Z');

function d1() {
  const db = new DatabaseSync(':memory:');
  for (const f of ['0001_base.sql', '0002_assistant.sql']) {
    db.exec(readFileSync(join(__dirname, '..', 'web', 'core', 'migrations', f), 'utf8'));
  }
  return {
    raw: db,
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        run: async () => {
          // @ts-expect-error node:sqlite приймає біндинги варіативно
          const info = db.prepare(sql).run(...args);
          return { meta: { changes: Number(info.changes) } };
        },
        all: async () => ({
          // @ts-expect-error те саме для all
          results: db.prepare(sql).all(...args),
        }),
      }),
    }),
  };
}

let store: ReturnType<typeof d1>;
let env: Env;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  store = d1();
  env = workerEnv({ DB: store });
});

describe('policy core — таблиця рівнів', () => {
  it('канонічні рядки: T0 виконується, T1 питає, T2 питає зі словом', () => {
    expect(decideLevel('facts.set', false)).toEqual({ level: 'T0' });
    expect(decideLevel('calendar.event', false)).toEqual({ level: 'T1' });
    expect(decideLevel('forget', false)).toEqual({ level: 'T2' });
  });

  it('taint ескалює ЛИШЕ T0 → T1; T1/T2 не рухаються', () => {
    expect(decideLevel('facts.set', true)).toEqual({ level: 'T1' });
    expect(decideLevel('calendar.event', true)).toEqual({ level: 'T1' });
    expect(decideLevel('forget', true)).toEqual({ level: 'T2' });
  });

  it('невідомий kind — відмова, не дефолт-рівень', () => {
    expect(decideLevel('rm-rf', false)).toMatchObject({ error: expect.stringContaining('rm-rf') });
  });

  it('уся таблиця має валідні рівні і TTL для T1/T2 визначені', () => {
    for (const [kind, level] of Object.entries(ACTION_LEVELS)) {
      expect(['T0', 'T1', 'T2'], kind).toContain(level);
    }
    expect(PROPOSAL_TTL_MS.T1).toBe(30 * 60_000);
    expect(PROPOSAL_TTL_MS.T2).toBe(10 * 60_000);
    expect(UNDO_WINDOW_MS).toBe(10 * 60_000);
  });

  it('parsePolicyCallback: p:/u: за 07 §9, сміття - null', () => {
    expect(parsePolicyCallback('p:abc-1:ok')).toEqual({
      kind: 'proposal',
      id: 'abc-1',
      choice: 'ok',
    });
    expect(parsePolicyCallback('p:abc:no')).toMatchObject({ choice: 'no' });
    expect(parsePolicyCallback('u:xyz')).toEqual({ kind: 'undo', id: 'xyz' });
    expect(parsePolicyCallback('rc:all')).toBeNull();
    expect(parsePolicyCallback('p::ok')).toBeNull();
  });

  it('кнопки пропозиції у межах 64 байт callback_data', () => {
    const [row] = proposalButtons(crypto.randomUUID());
    for (const b of row ?? []) expect(b.callback_data.length).toBeLessThanOrEqual(64);
  });
});

describe('T0: виконати одразу + «↩» 10 хв', () => {
  it('facts.set у чистій сесії пишеться одразу, undo повертає ЯК БУЛО', async () => {
    // Було value=uk (owner) — сід напряму, як шлях команд власника (поза
    // мозком): через applyPolicy source=owner тепер ескалюється (тест нижче).
    await runFactsSet(
      env,
      { kind: 'setting', key: 'lang', value: 'uk', source: 'owner' },
      NOW - 1000,
    );
    const out = await applyPolicy(
      env,
      { kind: 'facts.set', payload: { kind: 'setting', key: 'lang', value: 'en' }, tainted: false },
      NOW,
    );
    expect(out.mode).toBe('executed');
    const undoId = out.mode === 'executed' ? out.undo?.id : undefined;
    expect(undoId).toBeTruthy();

    const undone = await resolveUndo(env, String(undoId), NOW + 60_000);
    expect(undone).toMatchObject({ ok: true, status: 'undone' });
    const after = await runFactsGet(env, { kind: 'setting', key: 'lang' });
    expect(after.result[0]).toMatchObject({ value: 'uk', source: 'owner' }); // відкат зберіг source

    // Другий тап «↩» - ідемпотентний, не другий відкат.
    expect(await resolveUndo(env, String(undoId), NOW + 61_000)).toMatchObject({
      already: 'approved',
    });
  });

  it('факту не існувало — undo його видаляє; поза вікном 10 хв — expired', async () => {
    const out = await applyPolicy(
      env,
      { kind: 'facts.set', payload: { kind: 'habit', key: 'кава', value: 2 }, tainted: false },
      NOW,
    );
    const undoId = out.mode === 'executed' ? String(out.undo?.id) : '';
    const late = await resolveUndo(env, undoId, NOW + UNDO_WINDOW_MS + 1);
    expect(late).toMatchObject({ ok: true, status: 'expired' });
    // Прострочений «↩» НЕ відкотив - факт лишився.
    expect((await runFactsGet(env, { kind: 'habit', key: 'кава' })).result).toHaveLength(1);

    const out2 = await applyPolicy(
      env,
      { kind: 'facts.set', payload: { kind: 'habit', key: 'чай', value: 1 }, tainted: false },
      NOW,
    );
    const undo2 = out2.mode === 'executed' ? String(out2.undo?.id) : '';
    await resolveUndo(env, undo2, NOW + 1000);
    expect((await runFactsGet(env, { kind: 'habit', key: 'чай' })).result).toHaveLength(0);
  });
});

describe('T1/T2: пропозиції', () => {
  it('tainted facts.set → пропозиція T1; ✅ виконує, повторний ✅ — already', async () => {
    const out = await applyPolicy(
      env,
      { kind: 'facts.set', payload: { kind: 'contact', key: 'np', value: 'x' }, tainted: true },
      NOW,
    );
    expect(out.mode).toBe('proposed');
    const id = out.mode === 'proposed' ? out.proposal.id : '';
    expect(out.mode === 'proposed' && out.proposal.level).toBe('T1');
    // ДО ✅ факту немає - у tainted нічого не пишеться одразу.
    expect((await runFactsGet(env, { kind: 'contact', key: 'np' })).result).toHaveLength(0);

    const ok = await resolveProposal(env, { id, choice: 'ok' }, NOW + 60_000);
    expect(ok).toMatchObject({ ok: true, status: 'approved', executed: true });
    expect((await runFactsGet(env, { kind: 'contact', key: 'np' })).result).toHaveLength(1);
    expect(await resolveProposal(env, { id, choice: 'ok' }, NOW + 61_000)).toMatchObject({
      already: 'approved',
    });
  });

  // Сценарій приймання етапу 2 (пункт 6): після листа сесія брудна, і
  // «нагадай завтра забрати» мусить прийти ПРОПОЗИЦІЄЮ з ✅, а не відмовою.
  // Мозок власного барʼєра більше не має - рішення тут.
  it('tainted reminders.create → пропозиція T1, а не відмова (01 §4.3)', async () => {
    const out = await applyPolicy(
      env,
      {
        kind: 'reminders.create',
        payload: { text: 'забрати посилку', when: 'завтра о 10' },
        tainted: true,
      },
      NOW,
    );
    expect(out.mode).toBe('proposed');
    expect(out.mode === 'proposed' && out.proposal.level).toBe('T1');
  });

  // Приймання 01.09: модель тричі вгадувала kind для календаря
  // (calendar_event → calendar.create → calendar_add) і жодного разу не
  // влучила, бо помилка не називала правильних варіантів.
  it('невідомий kind - відмова З ПЕРЕЛІКОМ дозволених', async () => {
    const out = await applyPolicy(
      env,
      { kind: 'calendar_event', payload: {}, tainted: false },
      NOW,
    );
    expect(out.mode).toBe('error');
    const error = out.mode === 'error' ? out.error : '';
    expect(error).toContain('невідомий kind');
    expect(error).toContain('calendar.event');
    expect(error).toContain('tasks.create');
  });

  it('❌ — rejected без виконання; прострочена — expired', async () => {
    const a = await applyPolicy(
      env,
      { kind: 'facts.set', payload: { kind: 'place', key: 'дім', value: 1 }, tainted: true },
      NOW,
    );
    const idA = a.mode === 'proposed' ? a.proposal.id : '';
    expect(await resolveProposal(env, { id: idA, choice: 'no' }, NOW + 1000)).toMatchObject({
      status: 'rejected',
    });
    expect((await runFactsGet(env, { kind: 'place', key: 'дім' })).result).toHaveLength(0);

    const b = await applyPolicy(
      env,
      { kind: 'facts.set', payload: { kind: 'place', key: 'дача', value: 1 }, tainted: true },
      NOW,
    );
    const idB = b.mode === 'proposed' ? b.proposal.id : '';
    expect(
      await resolveProposal(env, { id: idB, choice: 'ok' }, NOW + PROPOSAL_TTL_MS.T1 + 1),
    ).toMatchObject({ status: 'expired' });
    expect((await runFactsGet(env, { kind: 'place', key: 'дача' })).result).toHaveLength(0);
  });

  it('T2: ✅ без слова відхиляється; зі словом - виконавець forget каже вголос, що ціль «чат» ще не підтримується (етап 6)', async () => {
    const out = await applyPolicy(
      env,
      { kind: 'forget', payload: { target: 'chat', what: 'чат' }, tainted: false },
      NOW,
    );
    expect(out.mode).toBe('proposed');
    const id = out.mode === 'proposed' ? out.proposal.id : '';
    const word = out.mode === 'proposed' ? out.proposal.word : null;
    expect(word).toBeTruthy();

    expect(await resolveProposal(env, { id, choice: 'ok' }, NOW + 1000)).toMatchObject({
      ok: false,
      error: 'word-required',
    });
    // Виконавець forget є з етапу 3 (колекції); чат - етап 6, тож збій
    // виконання названо вголос, а не тихо «прийнято».
    expect(
      await resolveProposal(
        env,
        { id, choice: 'ok', word: ` ${String(word).toLowerCase()} ` },
        NOW + 2000,
      ),
    ).toMatchObject({ ok: false, error: expect.stringContaining('етап 6') });
    // Клейм стоїть: повторний тап не переграє виконання.
    const row = store.raw.prepare('SELECT status FROM proposals WHERE id = ?').get(id) as {
      status: string;
    };
    expect(row.status).toBe('approved');
  });

  it('source=owner з T0-шляху ескалюється до пропозиції: attribution потребує ✅', async () => {
    const out = await applyPolicy(
      env,
      {
        kind: 'facts.set',
        payload: { kind: 'contact', key: 'мама', value: 'x', source: 'owner' },
        tainted: false,
      },
      NOW,
    );
    expect(out.mode).toBe('proposed'); // НЕ executed, хоч сесія чиста
    const id = out.mode === 'proposed' ? out.proposal.id : '';
    // ДО ✅ факту немає.
    expect((await runFactsGet(env, { kind: 'contact', key: 'мама' })).result).toHaveLength(0);
    await resolveProposal(env, { id, choice: 'ok' }, NOW + 1000);
    // ПІСЛЯ ✅ власника owner-attribution легітимний.
    expect((await runFactsGet(env, { kind: 'contact', key: 'мама' })).result[0]).toMatchObject({
      source: 'owner',
    });
  });

  it('подвійний тап ✅ (конкурентні resolve) — виконання рівно одне', async () => {
    const out = await applyPolicy(
      env,
      { kind: 'facts.set', payload: { kind: 'setting', key: 'dbl', value: 1 }, tainted: true },
      NOW,
    );
    const id = out.mode === 'proposed' ? out.proposal.id : '';
    const [a, b] = await Promise.all([
      resolveProposal(env, { id, choice: 'ok' }, NOW + 1000),
      resolveProposal(env, { id, choice: 'ok' }, NOW + 1001),
    ]);
    const executed = [a, b].filter((r) => 'status' in r && r.status === 'approved');
    const already = [a, b].filter((r) => 'already' in r);
    expect(executed).toHaveLength(1);
    expect(already).toHaveLength(1);
  });

  it('невідомий kind дії — error без рядка в proposals', async () => {
    const out = await applyPolicy(env, { kind: 'evil.hack', payload: {}, tainted: false }, NOW);
    expect(out).toMatchObject({ mode: 'error' });
  });
});

describe('router: write-інструмент через policy', () => {
  const KEY = 'k';
  const PATH = '/internal/tool/facts.set';

  const signedRequest = async (bodyObj: unknown, nonce: string) => {
    const body = JSON.stringify(bodyObj);
    return new Request(`https://svitanok.test${PATH}`, {
      method: 'POST',
      headers: {
        'X-Internal-Timestamp': String(NOW),
        'X-Internal-Run': 'r1',
        'X-Internal-Nonce': nonce,
        'X-Internal-Signature': await signInternal(KEY, {
          method: 'POST',
          path: PATH,
          timestampMs: NOW,
          runId: 'r1',
          nonce,
          rawBody: body,
        }),
      },
      body,
    });
  };

  const routerEnv = () =>
    workerEnv({
      ASSISTANT_V2: 'shadow',
      INTERNAL_HMAC_KEY: KEY,
      DB: store,
      RUN_REGISTRY: {
        getByName: () => ({
          has: async (id: string) => id === 'r1',
          consumeNonce: async () => true,
          runInfo: async () => ({ threadId: 'thr-1' }),
        }),
      },
    });

  it('чиста сесія: mode=executed + кнопка «↩»', async () => {
    const res = await handleInternal(
      await signedRequest({ args: { kind: 'setting', key: 'tz', value: 'Kyiv' } }, 'n1'),
      routerEnv(),
      NOW,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mode: string; undo?: { id: string } };
    expect(body).toMatchObject({ ok: true, mode: 'executed', tainted: false });
    expect(body.undo?.id).toBeTruthy();
  });

  it('tainted-сесія (sessions.tainted=1): mode=proposed, факт НЕ записано', async () => {
    store.raw
      .prepare(
        `INSERT INTO sessions (thread_id, started_at, last_at, tainted, turn_count) VALUES ('thr-1', '', '', 1, 0)`,
      )
      .run();
    const res = await handleInternal(
      await signedRequest({ args: { kind: 'setting', key: 'x', value: 1 } }, 'n2'),
      routerEnv(),
      NOW,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mode: string; proposal?: { level: string } };
    expect(body).toMatchObject({ ok: true, mode: 'proposed', tainted: true });
    expect(body.proposal?.level).toBe('T1');
    expect((await runFactsGet(env, { kind: 'setting', key: 'x' })).result).toHaveLength(0);
  });
});
