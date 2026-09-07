// Реєстр ланцюгів (етап 5 PR-2): kind рядка chains → привʼязка Workflow;
// кнопки c:<id>:<choice> і текст власника → подія за kind (у кнопкових
// станах столика - лише текст певної форми; слова скасування - в мозок);
// findAwaitingChain - той, хто спитав останнім (awaiting_since), у тому ж
// треді; sendChainEvent іде в правильний інстанс.

import { describe, it, expect } from 'vitest';
import {
  CHAIN_BINDINGS,
  readChainKind,
  sendChainEvent,
  findAwaitingChain,
  textEvent,
  looksLikeClock,
  choiceEvent,
  tableChoiceEvent,
  dayPlanChoiceEvent,
} from '../web/core/chains/registry.mjs';
import { setChainState } from '../web/core/chains/state.mjs';
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

const tableText = (text: string) => ({ type: 'table', payload: { action: 'text', text } });

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
    expect(choiceEvent('price', 'stop')).toEqual({ type: 'price', payload: { action: 'stop' } });
    expect(choiceEvent('price', 'v0')).toBeNull();
    expect(choiceEvent('idea', 'accept')).toBeNull();
    expect(CHAIN_BINDINGS.price).toBe('PRICE_TRACK');
  });

  it('textEvent: план - intent/answer; столик - текстові стани безумовно, кнопкові - за формою; скасування - в мозок', () => {
    expect(textEvent('day-plan', 'intent', 'x')).toEqual({
      type: 'intent',
      payload: { text: 'x' },
    });
    expect(textEvent('day-plan', 'accept', 'x')).toBeNull();
    expect(textEvent('table', 'time', '19:00')).toEqual(tableText('19:00'));
    expect(textEvent('table', 'venue_text', 'Креденс на Вірменській')).toEqual(
      tableText('Креденс на Вірменській'),
    );
    // venue (кнопки): коротка назва або номер - так; питання/довгий текст - ні.
    expect(textEvent('table', 'venue', 'Креденс Дім')).toEqual(tableText('Креденс Дім'));
    expect(textEvent('table', 'venue', '+380 32 235 55 55')).toEqual(
      tableText('+380 32 235 55 55'),
    );
    expect(textEvent('table', 'venue', 'а що там з планом на завтра?')).toBeNull();
    expect(textEvent('table', 'venue', 'x'.repeat(41))).toBeNull();
    // contact: лише номер; next: лише годинник.
    expect(textEvent('table', 'contact', '032 235 55 55')).toEqual(tableText('032 235 55 55'));
    expect(textEvent('table', 'contact', 'Креденс')).toBeNull();
    expect(textEvent('table', 'next', 'на 19:00')).toEqual(tableText('на 19:00'));
    expect(textEvent('table', 'next', 'скільки їхати?')).toBeNull();
    // Скасування - завжди в мозок (chain.cancel), навіть у текстовому стані.
    for (const t of ['скасуй столик', 'відміни', 'не треба']) {
      expect(textEvent('table', 'venue_text', t)).toBeNull();
    }
    expect(textEvent('table', 'rating', 'x')).toBeNull();
    expect(textEvent('idea', 'x', 'x')).toBeNull();
    expect(looksLikeClock('о 19')).toBe(true);
    expect(looksLikeClock('19.30')).toBe(true);
    expect(looksLikeClock('о 19 приблизно')).toBe(false);
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

  it('findAwaitingChain: лише waiting у текстових/кнопкових станах; хто спитав останнім (awaiting_since) - перший; тред ланцюга', async () => {
    const { env, seed, db } = setup();
    expect(await findAwaitingChain(env)).toBeNull();
    seed('t-rating', 'table', { awaiting: 'rating', awaiting_since: '2026-09-01T12:00:00Z' });
    expect(await findAwaitingChain(env)).toBeNull();
    seed('t-time', 'table', {
      awaiting: 'time',
      thread_id: '99',
      awaiting_since: '2026-09-01T09:00:00Z',
    });
    seed('d-intent', 'day-plan', { awaiting: 'intent', awaiting_since: '2026-09-01T08:00:00Z' });
    expect(await findAwaitingChain(env)).toEqual({ id: 't-time', kind: 'table', awaiting: 'time' });
    // Тред DM - столик із теми 99 не підходить, план (без thread_id) підходить.
    expect(await findAwaitingChain(env, 'dm')).toEqual({
      id: 'd-intent',
      kind: 'day-plan',
      awaiting: 'intent',
    });
    // План спитав пізніше (setChainState ставить awaiting_since) - він перший,
    // навіть якщо chain-nudge потім оновить updated_at столика.
    await setChainState(env, 'd-intent', { status: 'waiting', awaiting: 'intent' });
    db.prepare(`UPDATE chains SET updated_at = '2099-01-01T00:00:00Z' WHERE id = 't-time'`).run();
    expect(await findAwaitingChain(env, '99')).toEqual({
      id: 'd-intent',
      kind: 'day-plan',
      awaiting: 'intent',
    });
    db.prepare(`UPDATE chains SET status = 'done' WHERE id = 'd-intent'`).run();
    expect(await findAwaitingChain(env, '99')).toEqual({
      id: 't-time',
      kind: 'table',
      awaiting: 'time',
    });
  });
});
