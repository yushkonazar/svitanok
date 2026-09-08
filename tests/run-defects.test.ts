// Дефекти приймального прогону 08.09 (PR-1 релізного блоку). Кожен тест
// названо скаргою власника, а не назвою функції: інакше через півроку не
// видно, ЧОМУ саме ця перевірка існує.

import { describe, it, expect } from 'vitest';
import { mergeSentMessages, recordSentMessage, lastExchangeMessages } from '../web/tg-core.mjs';
import { loadSentMessages, putSentMessages } from '../web/kv-store.mjs';
import { deliverAt } from '../web/core/tools/reminders.mjs';
import { ideaTextForDispatch } from '../web/core/ideas/analysis.mjs';
import { SCHEDULER_TASKS } from '../web/core/scheduler/tasks.mjs';
import { activeRemindersForList } from '../web/commands.mjs';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';
import { d1FromSqlite } from './helpers/d1.js';

describe('«/clear 10 видалив два» — луна читача проти втрат KV', () => {
  it('злиття: обʼєднання за id, own виграє, порядок за id, стеля 50', () => {
    const merged = mergeSentMessages(
      {
        dm: [
          { id: 3, own: false },
          { id: 1, own: true },
        ],
      },
      {
        dm: [
          { id: 2, own: false },
          { id: 1, own: false },
        ],
      },
    );
    expect(merged.dm).toEqual([
      { id: 1, own: true },
      { id: 2, own: false },
      { id: 3, own: false },
    ]);

    const many = mergeSentMessages(
      { dm: Array.from({ length: 60 }, (_, i) => ({ id: i + 1, own: false })) },
      {},
    );
    expect(many.dm).toHaveLength(50);
    expect(many.dm[0]).toEqual({ id: 11, own: false }); // зрізано найстаріші
  });

  it('злиття не тягне назад те, що /clear уже зняв', () => {
    const merged = mergeSentMessages({ dm: [{ id: 7, own: false }] }, {}, new Set([7]));
    expect(merged.dm).toEqual([]);
  });

  it('put → load бачить свій запис навіть коли KV віддає старе', async () => {
    // Стаб KV із затримкою публікації - рівно те, що робить справжній KV:
    // put уже прийнято, а get ще віддає попереднє значення.
    const published = '{}'; // KV навмисно НЕ публікує - віддає старе
    let pending = published;
    const env = workerEnv({
      BRIEFING: {
        get: async () => published,
        put: async (_k: string, v: string) => void (pending = v),
        delete: async () => {},
        list: async () => ({ keys: [] }),
      },
    });

    await putSentMessages(env, recordSentMessage(await loadSentMessages(env), -100, 77, 5));
    await putSentMessages(env, recordSentMessage(await loadSentMessages(env), -100, 77, 6));
    await putSentMessages(env, recordSentMessage(await loadSentMessages(env), -100, 77, 7));
    // KV усі три рази віддавав "{}" - без луни в блобі лишився б лише id 7.
    expect(JSON.parse(pending)['-100:77'].map((e: { id: number }) => e.id)).toEqual([5, 6, 7]);
    expect(published).toBe('{}'); // публікація справді відставала
  });

  it('після /clear видалені id не повертаються луною', async () => {
    const kv = new Map<string, string>();
    const env = workerEnv({ BRIEFING: memoryKv(kv) });
    let store = recordSentMessage(await loadSentMessages(env), -100, 77, 5);
    store = recordSentMessage(store, -100, 77, 6);
    await putSentMessages(env, store);
    // /clear зняв 5: пише блоб БЕЗ нього.
    const after = { '-100:77': [{ id: 6, own: false }] };
    await putSentMessages(env, after);
    // KV навмисно відкочуємо до стану «до /clear» — саме так виглядає
    // застаріле читання, через яке 5 повернувся б у буфер.
    kv.set('sentMessages', JSON.stringify(store));
    expect((await loadSentMessages(env))['-100:77']).toEqual([{ id: 6, own: false }]);
  });

  it('повторний запис того самого id не дублює рядок', () => {
    const once = recordSentMessage({}, -100, 77, 5, true);
    const twice = recordSentMessage(once, -100, 77, 5);
    expect(twice['-100:77']).toEqual([{ id: 5, own: true }]); // own не втрачено
  });

  it('обміни рахуються за повідомленнями власника', () => {
    const store = {
      '-100:77': [
        { id: 1, own: true },
        { id: 2, own: false },
        { id: 3, own: true },
        { id: 4, own: false },
      ],
    };
    expect(lastExchangeMessages(store, -100, 77, 1, 9)).toEqual([3, 4, 9]);
  });
});

describe('«нагадування прийшло пізно»', () => {
  it('планувальник будить нагадування щохвилини', () => {
    expect(SCHEDULER_TASKS.reminder?.periodMin).toBe(1);
  });

  it('deliver_at - межа хвилини вгору, не сира секунда', () => {
    expect(deliverAt(Date.parse('2026-09-08T11:40:01.000Z'))).toBe('2026-09-08T11:41:00.000Z');
    expect(deliverAt(Date.parse('2026-09-08T11:40:00.000Z'))).toBe('2026-09-08T11:40:00.000Z');
  });
});

describe('«Аналіз ідеї не вдався: Required input idea not provided»', () => {
  it('порожній body_md - у dispatch іде заголовок', () => {
    expect(ideaTextForDispatch({ title: 'Профіль', body_md: '' })).toBe('Профіль');
    expect(ideaTextForDispatch({ title: 'Профіль', body_md: '  ' })).toBe('Профіль');
    expect(ideaTextForDispatch({ title: 'Профіль', body_md: 'опис' })).toBe('опис');
  });

  it('ані тексту, ані заголовка - порожньо (ядро скаже це власнику)', () => {
    expect(ideaTextForDispatch({ title: '', body_md: null })).toBe('');
  });
});

describe('«команда reminders не відобразила активне нагадування»', () => {
  const MIGRATIONS = ['0001_base.sql', '0002_assistant.sql', '0010_reminders_address.sql'];

  it('джерело - D1; KV домерджується, дублів за id немає', async () => {
    const d1 = d1FromSqlite(MIGRATIONS);
    d1.db
      .prepare(`INSERT INTO reminders (id, due_at, text, status, snooze_count) VALUES (?,?,?,?,0)`)
      .run('d1r', '2026-09-08T12:00:00.000Z', 'полити квіти', 'pending');
    // Той самий id ще й у KV - вікно між копіюванням і чисткою міграції.
    const kv = new Map<string, string>([
      [
        'state',
        JSON.stringify({
          reminders: [
            { id: 'd1r', text: 'старий текст', whenMs: Date.parse('2026-09-08T12:00:00.000Z') },
            { id: 'kv1', text: 'легасі', whenMs: Date.parse('2026-09-08T11:00:00.000Z') },
          ],
        }),
      ],
    ]);
    const env = workerEnv({ DB: d1.stub, BRIEFING: memoryKv(kv) });

    const list = await activeRemindersForList(env);
    expect(list.map((r) => [r.id, r.text])).toEqual([
      ['kv1', 'легасі'],
      ['d1r', 'полити квіти'], // D1 виграє над копією в KV
    ]);
  });

  it('D1 недоступна - показуємо хоч KV, не падаємо', async () => {
    const kv = new Map<string, string>([
      ['state', JSON.stringify({ reminders: [{ id: 'kv1', text: 'легасі', whenMs: 1 }] })],
    ]);
    const env = workerEnv({ BRIEFING: memoryKv(kv) }); // DB немає
    expect((await activeRemindersForList(env)).map((r) => r.id)).toEqual(['kv1']);
  });
});
