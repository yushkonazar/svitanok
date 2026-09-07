// Задача chain-nudge (етап 5 PR-2, S-1-6/S-1-13): +5 хв → перше нагадування
// і наступне через 15; друге - кінець (nudge стирається); клейм одним batch
// проти подвійного тіку; текст за станом очікування; кілька ланцюгів в одну
// адресу - одним повідомленням; DM-адреса; softWaitingLine - раз на
// київський день після доби тиші, лише для ланцюгів того ж треду.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  chainNudgeTask,
  dueNudges,
  claimNudges,
  softWaitingLine,
} from '../web/core/chains/nudge.mjs';
import { NUDGE_SECOND_MS } from '../web/core/chains/table.mjs';
import { workerEnv } from './helpers/env.js';
import { d1FromSqlite } from './helpers/d1.js';

const NOW = Date.parse('2026-09-07T11:05:00.000Z');

function setup() {
  const d1 = d1FromSqlite(['0001_base.sql', '0002_assistant.sql']);
  const sent: { chat_id: string; thread?: string; text: string }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      sent.push({ chat_id: String(body.chat_id), thread: body.message_thread_id, text: body.text });
      return new Response('{"ok":true,"result":{"message_id":1}}', { status: 200 });
    }),
  );
  const env = workerEnv({
    DB: d1.stub,
    TELEGRAM_BOT_TOKEN: 't',
    TELEGRAM_CHAT_ID: '555',
    TELEGRAM_OWNER_USER_ID: '777',
    TOPIC_ASSISTANT: '99',
  });
  const seed = (id: string, state: Record<string, unknown>, status = 'waiting') =>
    d1.db
      .prepare(
        `INSERT INTO chains (id, kind, workflow_id, state_json, status, created_at, updated_at) VALUES (?, 'table', ?, ?, ?, 'x', 'x')`,
      )
      .run(
        id,
        id,
        JSON.stringify({ venue: 'Креденс', chat_id: 555, thread_id: '99', ...state }),
        status,
      );
  const state = (id: string) =>
    JSON.parse(
      (
        d1.db.prepare('SELECT state_json FROM chains WHERE id = ?').get(id) as {
          state_json: string;
        }
      ).state_json,
    );
  return { env, db: d1.db, sent, seed, state };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('chainNudgeTask', () => {
  it('до строку - нічого; +5 → нагадування і наступне через 15; друге → nudge стерто, третього немає', async () => {
    const { env, sent, seed, state } = setup();
    const at = new Date(NOW).toISOString();
    seed('c1', { awaiting: 'venue', nudge: { at, n: 0 } });
    expect(await chainNudgeTask(env, NOW - 1000)).toEqual({ sent: 0 });
    expect(await chainNudgeTask(env, NOW)).toEqual({ sent: 1 });
    expect(sent).toEqual([
      {
        chat_id: '555',
        thread: '99',
        text: 'Нагадую: столик у Креденс - обери заклад або напиши назву.',
      },
    ]);
    expect(state('c1').nudge).toEqual({ at: new Date(NOW + NUDGE_SECOND_MS).toISOString(), n: 1 });
    // Той самий тік ще раз - не due.
    expect(await chainNudgeTask(env, NOW)).toEqual({ sent: 0 });
    expect(await chainNudgeTask(env, NOW + NUDGE_SECOND_MS)).toEqual({ sent: 1 });
    expect(state('c1').nudge).toBeUndefined();
    expect(await chainNudgeTask(env, NOW + 10 * NUDGE_SECOND_MS)).toEqual({ sent: 0 });
    expect(sent).toHaveLength(2);
  });

  it('claimNudges - CAS за n одним batch: два тіки з тим самим due-списком - лише один клейм', async () => {
    const { env, seed } = setup();
    const due = [
      { id: 'c1', n: 0 },
      { id: 'c2', n: 1 },
    ];
    seed('c1', { awaiting: 'venue', nudge: { at: new Date(NOW).toISOString(), n: 0 } });
    seed('c2', { awaiting: 'venue', nudge: { at: new Date(NOW).toISOString(), n: 1 } });
    expect(await claimNudges(env, due, NOW)).toEqual([true, true]);
    expect(await claimNudges(env, due, NOW)).toEqual([false, false]);
    expect(await claimNudges(env, [{ id: 'c1', n: 1 }], NOW)).toEqual([true]);
    expect(await claimNudges(env, [], NOW)).toEqual([]);
  });

  it('текст за станом: contact - «Подзвонив/Пізніше», next - кнопки під закладом', async () => {
    const { env, sent, seed } = setup();
    const at = new Date(NOW).toISOString();
    seed('a', { venue: 'Креденс', awaiting: 'contact', nudge: { at, n: 0 } });
    await chainNudgeTask(env, NOW);
    seed('b', { venue: 'Дім', awaiting: 'next', nudge: { at, n: 0 } });
    await chainNudgeTask(env, NOW);
    expect(sent.map((s) => s.text)).toEqual([
      'Нагадую: столик у Креденс - натисни «Подзвонив» або «Пізніше».',
      'Нагадую: столик у Дім - кнопки під закладом: маршрут, вихід, запросити або «Готово».',
    ]);
  });

  it('не waiting або без nudge - не в черзі; два ланцюги на ту саму адресу - одне повідомлення списком', async () => {
    const { env, sent, seed } = setup();
    const at = new Date(NOW).toISOString();
    seed('a', { venue: 'Креденс', awaiting: 'venue', nudge: { at, n: 0 } });
    seed('b', { venue: 'Дім', awaiting: 'venue', nudge: { at, n: 0 } });
    seed('running', { awaiting: null, nudge: { at, n: 0 } }, 'running');
    seed('no-nudge', { awaiting: 'venue' });
    expect((await dueNudges(env, NOW)).map((d) => d.id)).toEqual(['a', 'b']);
    expect(await chainNudgeTask(env, NOW)).toEqual({ sent: 1 });
    expect(sent[0]!.text).toBe(
      'Нагадую про столики:\n• Креденс - обери заклад або напиши назву\n• Дім - обери заклад або напиши назву',
    );
  });

  it('без DB - пропуск; DM-адреса (thread_id dm) - особистий чат власника без message_thread_id', async () => {
    const { env, sent, seed } = setup();
    expect(await chainNudgeTask(workerEnv({}), NOW)).toEqual({ sent: 0, skipped: 'no-db' });
    seed('dm', {
      chat_id: null,
      thread_id: 'dm',
      awaiting: 'venue',
      nudge: { at: new Date(NOW).toISOString(), n: 0 },
    });
    await chainNudgeTask(env, NOW);
    expect(sent).toEqual([
      { chat_id: '777', thread: undefined, text: expect.stringContaining('Креденс') },
    ]);
  });
});

describe('softWaitingLine', () => {
  it('після доби очікування - один рядок на день у треді ланцюга; свіже або чужий тред - null', async () => {
    const { env, seed, state } = setup();
    seed('fresh', { awaiting: 'venue', awaiting_since: new Date(NOW - 3_600_000).toISOString() });
    expect(await softWaitingLine(env, NOW, '99')).toBeNull();
    seed('old', {
      awaiting: 'venue',
      awaiting_since: new Date(NOW - 25 * 3_600_000).toISOString(),
    });
    expect(await softWaitingLine(env, NOW, 'dm')).toBeNull();
    expect(await softWaitingLine(env, NOW, '99')).toBe(
      'Ланцюг «столик у Креденс» чекає вибору - кнопки вище або «скасуй столик».',
    );
    expect(state('old').soft_day).toBe('2026-09-07');
    expect(await softWaitingLine(env, NOW + 60_000, '99')).toBeNull();
    // Наступного київського дня - знову (уже обидва старі → списком).
    expect(await softWaitingLine(env, NOW + 24 * 3_600_000, '99')).toMatch(/чека(є|ють) вибору/);
  });

  it('кілька старих - одним рядком через кому', async () => {
    const { env, seed } = setup();
    const since = new Date(NOW - 30 * 3_600_000).toISOString();
    seed('a', { venue: 'Креденс', awaiting: 'venue', awaiting_since: since });
    seed('b', { venue: 'Дім', awaiting: 'contact', awaiting_since: since });
    expect(await softWaitingLine(env, NOW, '99')).toBe(
      'Ланцюги столиків чекають вибору: Креденс, Дім.',
    );
  });
});
