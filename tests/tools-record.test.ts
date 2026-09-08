// record (етап 2 PR-6, 07 §4): чотири види локальних записів. Головне, що
// доводять ці тести, - інструмент НЕ має власної логіки запису: він проходить
// тими самими примітивами, що дашборд і легасі-агент (applyEvent,
// applyUrlVote + recordEvent, toggleProgress), тож стрік і воронка не можуть
// розійтися між Mini App і асистентом.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runRecord, RECORD_KINDS } from '../web/core/tools/record.mjs';
import { TOOLS } from '../web/core/tools/index.mjs';
import { applyPolicy } from '../web/core/policy/proposals.mjs';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';
import { d1FromSqlite } from './helpers/d1.js';

// 12:00 у Києві - РАНКОВИЙ слот (CHECKIN_FROM: morning 8, afternoon 14,
// evening 20); тиха зона (02:00-08:00) окремим тестом.
const NOON = Date.parse('2026-08-28T09:00:00.000Z');
const NIGHT = Date.parse('2026-08-28T02:00:00.000Z'); // 05:00 у Києві

function makeEnv(seed: Record<string, unknown> = {}) {
  const store = new Map<string, string>();
  store.set('state', JSON.stringify(seed.state ?? {}));
  store.set('stats', JSON.stringify(seed.stats ?? {}));
  if (seed.latest) store.set('latest', JSON.stringify(seed.latest));
  const d1 = d1FromSqlite(['0001_base.sql', '0002_assistant.sql']);
  return { store, env: workerEnv({ BRIEFING: memoryKv(store), DB: d1.stub }) };
}

const read = (store: Map<string, string>, key: string) => JSON.parse(store.get(key) ?? '{}');

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  // Слот чек-іна applyEvent бере з РЕАЛЬНОГО годинника (kyivHour), а не з
  // nowMs інструмента, тож без замороженого часу файл червонів о 02:00-07:59
  // за Києвом - тобто вночі за UTC у CI. Підмінюємо лише Date: таймери мають
  // лишитись справжніми, інакше await у сховищах не дочекається.
  vi.useFakeTimers({ toFake: ['Date'], now: NOON });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('record: чек-ін', () => {
  it('слот рахує КОД за київською годиною, запис іде через applyEvent', async () => {
    const { store, env } = makeEnv();
    const { result } = await runRecord(env, { kind: 'checkin', payload: { mood: 4 } }, NOON);

    expect(result).toMatchObject({ kind: 'checkin', slot: 'morning', written: true });
    // Той самий стор, що читає Mini App.
    expect(JSON.stringify(read(store, 'stats'))).toContain('mood');
  });

  it('тиха зона (02:00-08:00) - відмова, нічого не записано', async () => {
    const { store, env } = makeEnv();
    await expect(runRecord(env, { kind: 'checkin', payload: { mood: 5 } }, NIGHT)).rejects.toThrow(
      /тиха зона/,
    );
    expect(store.get('stats')).toBe('{}');
  });
});

describe('record: голос за новину', () => {
  const latest = {
    blocks: [
      {
        id: 'news',
        data: {
          groups: [
            {
              topic: 'ШІ',
              items: [
                { url: 'https://a.example/1', title: 'Перша' },
                { url: 'https://a.example/2', title: 'Друга' },
              ],
            },
          ],
        },
      },
    ],
  };

  it('індекс із брифінгу дає ваги преференцій і подію стріку', async () => {
    const { store, env } = makeEnv({ latest });
    const { result } = await runRecord(env, { kind: 'news-vote', payload: { index: 2 } }, NOON);

    expect(result).toMatchObject({ kind: 'news-vote', title: 'Друга', topic: 'ШІ' });
    const state = read(store, 'state');
    expect(state.votedUrls['https://a.example/2']).toBeDefined();
    expect(state.preferenceWeights).toBeDefined();
    // Подія голосу пішла в stats тим самим recordEvent, що й кнопка під новиною.
    expect(JSON.stringify(read(store, 'stats'))).toContain('ШІ');
  });

  it('позиції немає у свіжому брифінгу - відмова з підказкою перечитати', async () => {
    const { store, env } = makeEnv({ latest });
    await expect(
      runRecord(env, { kind: 'news-vote', payload: { index: 9 } }, NOON),
    ).rejects.toThrow(/немає у свіжому брифінгу/);
    expect(read(store, 'state').votedUrls).toBeUndefined();
  });

  it('index має бути позицією від 1, не url і не нуль', async () => {
    const { env } = makeEnv({ latest });
    for (const index of [0, -1, 'https://a.example/1']) {
      await expect(runRecord(env, { kind: 'news-vote', payload: { index } }, NOON)).rejects.toThrow(
        /позиція новини від 1/,
      );
    }
  });
});

describe('record: стадія вакансії і роадмеп', () => {
  it('невідома стадія відкидається переліком', async () => {
    const { env } = makeEnv();
    await expect(
      runRecord(env, { kind: 'job-stage', payload: { index: 1, stage: 'думаю' } }, NOON),
    ).rejects.toThrow(/невідома стадія/);
  });

  it('порожня воронка - чесна відмова, а не запис у порожнечу', async () => {
    const { env } = makeEnv();
    await expect(
      runRecord(env, { kind: 'job-stage', payload: { index: 1, stage: 'applied' } }, NOON),
    ).rejects.toThrow(/немає у воронці/);
  });

  it('роадмеп: позначає вивченим і НЕ знімає прапорець повторним викликом', async () => {
    const { store, env } = makeEnv();
    const first = await runRecord(
      env,
      { kind: 'roadmap', payload: { topic_id: 't1', subtopic_id: 's1' } },
      NOON,
    );
    expect(first.result).toMatchObject({ written: true });
    const key = (first.result as { key: string }).key;
    expect(read(store, 'state').roadmapProgress[key]).toBeTruthy();

    // Друга спроба ідемпотентна: toggleProgress зняв би прапорець, і саме
    // тому інструмент перевіряє його ДО виклику.
    const second = await runRecord(
      env,
      { kind: 'roadmap', payload: { topic_id: 't1', subtopic_id: 's1' } },
      NOON,
    );
    expect(second.result).toMatchObject({ written: false, reason: 'already-done' });
    expect(read(store, 'state').roadmapProgress[key]).toBeTruthy();
  });

  it('без topic_id або subtopic_id - відмова', async () => {
    const { env } = makeEnv();
    await expect(
      runRecord(env, { kind: 'roadmap', payload: { topic_id: 't1' } }, NOON),
    ).rejects.toThrow(/потрібні topic_id і subtopic_id/);
  });
});

describe('record: payload не може перекрити службові поля (security-ревʼю PR-6)', () => {
  it('type у payload НЕ підміняє вид події', async () => {
    // Доти `{ type: 'checkin', ...payload }` дозволяв виклику «запиши чек-ін»
    // записати job_stage з довільним url - повз RECORD_KINDS, перелік стадій і
    // привʼязку до воронки власника, ще й зі звітом «записав чек-ін».
    const { store, env } = makeEnv();
    const { result } = await runRecord(
      env,
      {
        kind: 'checkin',
        payload: {
          type: 'job_stage',
          url: 'https://evil.example/1',
          stage: 'applied',
          title: 'Чужа вакансія',
        },
      },
      NOON,
    );

    expect(result).toMatchObject({ kind: 'checkin' });
    const stats = JSON.stringify(read(store, 'stats'));
    expect(stats).not.toContain('evil.example');
    expect(stats).not.toContain('Чужа вакансія');
  });
});

describe('record: контракт інструмента', () => {
  it('невідомий kind відкидається переліком', async () => {
    const { env } = makeEnv();
    await expect(runRecord(env, { kind: 'вигадка' }, NOON)).rejects.toThrow(/невідомий kind/);
    expect(RECORD_KINDS).toEqual(['checkin', 'news-vote', 'job-stage', 'roadmap']);
  });

  it('write через policy; прямий run кидає', () => {
    expect(TOOLS.record!.write).toEqual({ kind: 'record' });
    expect(() => TOOLS.record!.run({} as never, {}, NOON)).toThrow(/через policy/);
  });

  it('T0 виконується одразу, але БЕЗ кнопки «↩» (події не відкочуються)', async () => {
    const { env } = makeEnv();
    const res = await applyPolicy(
      env,
      {
        kind: 'record',
        payload: { kind: 'roadmap', payload: { topic_id: 't', subtopic_id: 's' } },
        tainted: false,
      },
      NOON,
    );
    if (res.mode !== 'executed') throw new Error(`очікували executed, отримали ${res.mode}`);
    expect(res.undo).toBeUndefined();
  });

  it('у tainted виконується одразу - це запис у власному стані (звуження 08.09)', async () => {
    const { store, env } = makeEnv();
    const res = await applyPolicy(
      env,
      {
        kind: 'record',
        payload: { kind: 'roadmap', payload: { topic_id: 't', subtopic_id: 's' } },
        tainted: true,
      },
      NOON,
    );
    expect(res.mode).toBe('executed');
    expect(read(store, 'state').roadmapProgress).toBeDefined();
  });
});
