// Реєстр ланцюгів (етап 5 PR-2): kind рядка chains → привʼязка Workflow;
// кнопки c:<id>:<choice> і текст власника → подія за kind; findAwaitingChain
// бачить лише стани, що годуються текстом; sendChainEvent іде в правильний
// інстанс; /internal/runs outcome.chain - через реєстр.

import { describe, it, expect } from 'vitest';
import {
  CHAIN_BINDINGS,
  readChainKind,
  sendChainEvent,
  findAwaitingChain,
  textEvent,
  choiceEvent,
  tableChoiceEvent,
  dayPlanChoiceEvent,
} from '../web/core/chains/registry.mjs';
import { workerEnv } from './helpers/env.js';
import { d1FromSqlite } from './helpers/d1.js';

function setup() {
  const d1 = d1FromSqlite(['0001_base.sql', '0002_assistant.sql']);
  const events: { binding: string; id: string; ev: unknown }[] = [];
  const binding = (name: string) => ({
    create: async () => undefined,
    get: async (id: string) => ({
      sendEvent: async (ev: unknown) => void events.push({ binding: name, id, ev }),
    }),
  });
  const env = workerEnv({
    DB: d1.stub,
    DAY_PLAN: binding('DAY_PLAN') as never,
    TABLE_CHAIN: binding('TABLE_CHAIN') as never,
  });
  const seed = (
    id: string,
    kind: string,
    state: Record<string, unknown>,
    status = 'waiting',
    updated = 'x',
  ) =>
    d1.db
      .prepare(
        `INSERT INTO chains (id, kind, workflow_id, state_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'x', ?)`,
      )
      .run(id, kind, id, JSON.stringify(state), status, updated);
  return { env, db: d1.db, events, seed };
}

describe('мапи кнопок і тексту', () => {
  it('tableChoiceEvent покриває всі кнопки столика; чуже - null', () => {
    expect(tableChoiceEvent('cancel')).toEqual({ type: 'table', payload: { action: 'cancel' } });
    expect(tableChoiceEvent('v3')).toEqual({
      type: 'table',
      payload: { action: 'venue', index: 3 },
    });
    expect(tableChoiceEvent('vother')).toEqual({
      type: 'table',
      payload: { action: 'venue', other: true },
    });
    for (const c of ['called', 'later', 'phone']) {
      expect(tableChoiceEvent(c)).toEqual({ type: 'table', payload: { action: c } });
    }
    for (const c of ['route', 'leave', 'invite', 'fav', 'done']) {
      expect(tableChoiceEvent(c)).toEqual({
        type: 'table',
        payload: { action: 'next', choice: c },
      });
    }
    expect(tableChoiceEvent('mcar')).toEqual({
      type: 'table',
      payload: { action: 'mode', mode: 'car' },
    });
    expect(tableChoiceEvent('r4')).toEqual({
      type: 'table',
      payload: { action: 'rating', stars: 4 },
    });
    expect(tableChoiceEvent('rskip')).toEqual({
      type: 'table',
      payload: { action: 'rating', stars: null },
    });
    expect(tableChoiceEvent('accept')).toBeNull();
    expect(tableChoiceEvent('v12')).toBeNull();
  });

  it('choiceEvent за kind: day-plan → мапа плану, table → мапа столика, інший - null', () => {
    expect(choiceEvent('day-plan', 'accept')).toEqual(dayPlanChoiceEvent('accept'));
    expect(choiceEvent('table', 'called')).toEqual(tableChoiceEvent('called'));
    expect(choiceEvent('table', 'accept')).toBeNull();
    expect(choiceEvent('idea', 'accept')).toBeNull();
  });

  it('textEvent: план - intent/answer; столик - venue_text/phone/time/invitees; решта null', () => {
    expect(textEvent('day-plan', 'intent', 'x')).toEqual({
      type: 'intent',
      payload: { text: 'x' },
    });
    expect(textEvent('day-plan', 'accept', 'x')).toBeNull();
    expect(textEvent('table', 'time', '19:00')).toEqual({
      type: 'table',
      payload: { action: 'text', text: '19:00' },
    });
    expect(textEvent('table', 'venue', 'x')).toBeNull();
    expect(textEvent('table', 'next', 'x')).toBeNull();
    expect(textEvent('idea', 'x', 'x')).toBeNull();
  });
});

describe('D1 + привʼязки', () => {
  it('readChainKind / sendChainEvent: привʼязка за kind; невідомий рядок або kind без привʼязки - помилка', async () => {
    const { env, events, seed } = setup();
    seed('d1', 'day-plan', { awaiting: 'intent' });
    seed('t1', 'table', { awaiting: 'venue' });
    seed('i1', 'idea', {});
    expect(await readChainKind(env, 't1')).toBe('table');
    expect(await readChainKind(env, 'nope')).toBeNull();
    await sendChainEvent(env, 'd1', 'intent', { text: 'x' });
    await sendChainEvent(env, 't1', 'table', { action: 'cancel' });
    expect(events).toEqual([
      { binding: 'DAY_PLAN', id: 'd1', ev: { type: 'intent', payload: { text: 'x' } } },
      { binding: 'TABLE_CHAIN', id: 't1', ev: { type: 'table', payload: { action: 'cancel' } } },
    ]);
    await expect(sendChainEvent(env, 'nope', 'x', {})).rejects.toThrow(/немає/);
    // idea має привʼязку IDEA_ANALYSIS - у цьому env її не задано.
    await expect(sendChainEvent(env, 'i1', 'artifact', {})).rejects.toThrow(/привʼязки Workflow/);
    expect(CHAIN_BINDINGS.idea).toBe('IDEA_ANALYSIS');
  });

  it('findAwaitingChain: лише waiting зі станом, що годується текстом; найсвіжіший перший', async () => {
    const { env, seed, db } = setup();
    expect(await findAwaitingChain(env)).toBeNull();
    seed('t-buttons', 'table', { awaiting: 'venue' }, 'waiting', '2026-09-07T10:00:00Z');
    expect(await findAwaitingChain(env)).toBeNull();
    seed('t-time', 'table', { awaiting: 'time' }, 'waiting', '2026-09-07T09:00:00Z');
    seed('d-intent', 'day-plan', { awaiting: 'intent' }, 'waiting', '2026-09-07T08:00:00Z');
    expect(await findAwaitingChain(env)).toEqual({ id: 't-time', kind: 'table', awaiting: 'time' });
    db.prepare(`UPDATE chains SET status = 'done' WHERE id = 't-time'`).run();
    expect(await findAwaitingChain(env)).toEqual({
      id: 'd-intent',
      kind: 'day-plan',
      awaiting: 'intent',
    });
  });
});
