// Варіативність сценаріїв (релізний блок PR-7, §3): те, що доти впиралось у
// відмову або в перебір інструментів. Повторювані нагадування (§3.1) сюди не
// входять - їхня колонка приїхала окремо від коду, див. міграцію 0012.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runDataSearch, SEARCH_SOURCES } from '../web/core/tools/search.mjs';
import { runRemindersCancel, CANCEL_BATCH_MAX } from '../web/core/tools/reminders.mjs';
import { applyPolicy, undoLastInThread } from '../web/core/policy/proposals.mjs';
import { prerouteMessage } from '../web/core/prerouter.mjs';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';
import { d1FromSqlite } from './helpers/d1.js';

const NOW = Date.parse('2026-09-08T09:00:00.000Z');
const ALL = [
  '0001_base.sql',
  '0002_assistant.sql',
  '0003_telemetry.sql',
  '0004_ideas_travel.sql',
  '0005_finance.sql',
  '0006_inbox_collections.sql',
  '0007_instructions_plans.sql',
  '0008_fts.sql',
  '0009_voice.sql',
  '0010_reminders_address.sql',
  '0011_ideas_number.sql',
  '0012_reminders_recurrence.sql',
];

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('data.search - один запит по всіх власних джерелах (§3.2)', () => {
  function seeded() {
    const d1 = d1FromSqlite(ALL);
    const env = workerEnv({ DB: d1.stub, BRIEFING: memoryKv(new Map()) });
    d1.db
      .prepare(
        `INSERT INTO ideas (id, number, title, body_md, status, created_at, updated_at)
         VALUES ('i1', 1, 'Кава з Креденсу', 'опис', 'new', 'x', '2026-09-01T00:00:00Z')`,
      )
      .run();
    d1.db
      .prepare(`INSERT INTO ideas_fts (id, title, body_md) VALUES ('i1', ?, ?)`)
      .run('Кава з Креденсу', 'опис');
    d1.db
      .prepare(
        `INSERT INTO places (place_id, name, address, visits, fetched_at)
         VALUES ('p1', 'Креденс', 'вул. Вірменська 6', 4, '2026-09-05T00:00:00Z')`,
      )
      .run();
    d1.db
      .prepare(
        `INSERT INTO transactions (id, at, amount, currency, amount_uah, description)
         VALUES ('t1', '2026-09-06T10:00:00Z', -18000, 'UAH', -18000, 'Креденс кава')`,
      )
      .run();
    return { env, d1 };
  }

  it('знаходить в ідеях, місцях і грошах одним викликом', async () => {
    const { env } = seeded();
    const { result } = await runDataSearch(env, { q: 'Креденс' });
    const bySource = new Map(
      (result.hits as { source: string; title: string }[]).map((h) => [h.source, h.title]),
    );
    expect([...bySource.keys()].sort()).toEqual(['ideas', 'money', 'places']);
    expect(bySource.get('ideas')).toBe('#1 Кава з Креденсу');
    expect(bySource.get('places')).toBe('Креденс');
    expect(result.searched).toEqual(SEARCH_SOURCES);
    expect(result.failed).toEqual([]);
  });

  it('кирилиця знаходиться попри lower() у SQLite (він тільки для ASCII)', async () => {
    // ⚠️ Пастка, на якій цей пошук уже спіткнувся: `lower('Креденс')` у SQLite
    // віддає «Креденс» як є, тож приведення ЗАПИТУ до нижнього регістру
    // гарантовано ламає збіг для кирилиці.
    const { env } = seeded();
    const { result } = await runDataSearch(env, { q: 'Креденс', scopes: ['places', 'money'] });
    expect((result.hits as { source: string }[]).map((h) => h.source).sort()).toEqual([
      'money',
      'places',
    ]);
    // ASCII LIKE у SQLite нечутливий до регістру - це має лишитись правдою.
    expect(
      ((await runDataSearch(env, { q: 'кава', scopes: ['ideas'] })).result.hits as unknown[])
        .length,
    ).toBe(1);
  });

  it('scopes звужує джерела; невідоме джерело - відмова з переліком', async () => {
    const { env } = seeded();
    const { result } = await runDataSearch(env, { q: 'Креденс', scopes: ['places'] });
    expect(result.searched).toEqual(['places']);
    expect(result.hits).toHaveLength(1);
    await expect(runDataSearch(env, { q: 'Креденс', scopes: ['чати'] })).rejects.toThrow(
      /дозволені: ideas, records, places, money/,
    );
  });

  it('одне джерело впало - решта відповідає, і про провал сказано вголос', async () => {
    const d1 = d1FromSqlite(['0001_base.sql', '0002_assistant.sql', '0004_ideas_travel.sql']);
    // Без 0008 немає ideas_fts, без 0005 - transactions: два джерела з чотирьох
    // зникли, і саме це має бути видно у відповіді, а не порожній результат.
    d1.db
      .prepare(
        `INSERT INTO places (place_id, name, address, visits, fetched_at)
         VALUES ('p1', 'Креденс', 'вул. Вірменська 6', 4, 'x')`,
      )
      .run();
    const env = workerEnv({ DB: d1.stub, BRIEFING: memoryKv(new Map()) });
    const { result } = await runDataSearch(env, { q: 'Креденс' });
    expect(result.searched).toContain('places');
    expect(result.failed.sort()).toEqual(['ideas', 'money', 'records']);
    expect(result.hits).toHaveLength(1);
  });

  it('порожній запит - відмова до бази', async () => {
    const { env } = seeded();
    await expect(runDataSearch(env, { q: '   ' })).rejects.toThrow(/хоч одне слово/);
  });

  it('«%» у запиті шукає символ, а не «будь-що»', async () => {
    const { env, d1 } = seeded();
    d1.db
      .prepare(
        `INSERT INTO transactions (id, at, amount, currency, amount_uah, description)
         VALUES ('t2', '2026-09-06T11:00:00Z', -100, 'UAH', -100, 'Знижка 50% у Сільпо')`,
      )
      .run();
    const hit = await runDataSearch(env, { q: '50%', scopes: ['money'] });
    expect((hit.result.hits as { title: string }[]).map((h) => h.title)).toEqual([
      'Знижка 50% у Сільпо',
    ]);
    // Без екранування «50%» знайшло б і «500 грн» - результат ширший за питання.
    const miss = await runDataSearch(env, { q: 'Креденс%', scopes: ['money'] });
    expect(miss.result.hits).toEqual([]);
  });

  it('бази немає - ОДНА чесна помилка, а не чотири «джерело впало»', async () => {
    const env = workerEnv({ BRIEFING: memoryKv(new Map()) });
    await expect(runDataSearch(env, { q: 'будь-що' })).rejects.toThrow(/DB/);
  });
});

describe('пакетне скасування нагадувань (§3.4)', () => {
  function withReminders(ids: string[]) {
    const d1 = d1FromSqlite(ALL);
    for (const id of ids) {
      d1.db
        .prepare(
          `INSERT INTO reminders (id, due_at, text, status, snooze_count) VALUES (?,?,?,'pending',0)`,
        )
        .run(id, '2026-09-09T09:00:00.000Z', `справа ${id}`);
    }
    return { d1, env: workerEnv({ DB: d1.stub, BRIEFING: memoryKv(new Map()) }) };
  }

  it('ids списком - один виклик замість трьох', async () => {
    const { env, d1 } = withReminders(['r1', 'r2', 'r3']);
    const { result } = await runRemindersCancel(env, { ids: ['r1', 'r2', 'r3'] });
    expect(result).toMatchObject({ missed: [] });
    expect(
      d1.db.prepare(`SELECT count(*) AS n FROM reminders WHERE status = 'cancelled'`).get(),
    ).toEqual({ n: 3 });
  });

  it('зниклий у пачці не губить решту, але названий', async () => {
    const { env, d1 } = withReminders(['r1', 'r2']);
    const { result } = await runRemindersCancel(env, { ids: ['r1', 'нема', 'r2'] });
    expect(result).toMatchObject({ missed: ['нема'] });
    expect(
      d1.db.prepare(`SELECT count(*) AS n FROM reminders WHERE status = 'cancelled'`).get(),
    ).toEqual({ n: 2 });
  });

  it('одне нагадування - стара помилка дослівно (її бачить власник)', async () => {
    const { env } = withReminders([]);
    await expect(runRemindersCancel(env, { id: 'нема' })).rejects.toThrow(/не знайдено/);
  });

  it('нічого не задано або понад стелю - відмова до бази', async () => {
    const { env } = withReminders([]);
    await expect(runRemindersCancel(env, {})).rejects.toThrow(/обовʼязковий/);
    await expect(
      runRemindersCancel(env, {
        ids: Array.from({ length: CANCEL_BATCH_MAX + 1 }, (_, i) => `r${i}`),
      }),
    ).rejects.toThrow(/щонайбільше/);
  });
});

describe('«відміни останнє» (§3.5)', () => {
  function setup() {
    const d1 = d1FromSqlite(ALL);
    const tg: { method: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        tg.push({
          method: String(url).split('/').pop() ?? '',
          body: init?.body ? JSON.parse(String(init.body)) : {},
        });
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
          status: 200,
        });
      }),
    );
    const env = workerEnv({
      ASSISTANT_V2: 'on',
      DB: d1.stub,
      BRIEFING: memoryKv(new Map()),
      TELEGRAM_BOT_TOKEN: 'bot',
      TELEGRAM_CHAT_ID: '555',
      TELEGRAM_OWNER_USER_ID: '555',
    });
    return { env, db: d1.db, tg };
  }

  const idea = (env: Env, title: string, at: number) =>
    applyPolicy(
      env,
      { kind: 'ideas.create', payload: { title }, threadId: 'dm', chatId: 555, tainted: false },
      at,
    );

  it('відкочує ОСТАННЮ дію треду, не першу', async () => {
    const { env, db } = setup();
    await idea(env, 'перша', NOW);
    await idea(env, 'друга', NOW + 1000);
    const out = await undoLastInThread(env, 'dm', NOW + 2000);
    expect(out).toMatchObject({ ok: true, kind: 'ideas.create', late: false });
    const left = db.prepare('SELECT title FROM ideas').all() as { title: string }[];
    expect(left.map((r) => r.title)).toEqual(['перша']);
  });

  it('після вікна «↩» - теж відкочує, але КАЖЕ, що це вже окрема дія назад', async () => {
    const { env, tg } = setup();
    await idea(env, 'стара', NOW);
    const late = NOW + 60 * 60_000;
    expect(await prerouteMessage(env, msg('відміни останнє'), late)).toBe(true);
    const line = tg.find((c) => String(c.body.text ?? '').includes('Відкотив'))!;
    expect(String(line.body.text)).toContain('Вікно «↩» вже минуло');
  });

  it('двічі поспіль - другий раз нема чого відкочувати', async () => {
    const { env } = setup();
    await idea(env, 'єдина', NOW);
    expect(await undoLastInThread(env, 'dm', NOW + 1000)).toMatchObject({ ok: true });
    expect(await undoLastInThread(env, 'dm', NOW + 2000)).toEqual({ ok: false, reason: 'none' });
  });

  it('два «відміни останнє» одночасно - відкат РІВНО один', async () => {
    // Той самий claim-first, що в resolveProposal: власник міг тапнути двічі,
    // або підказка прийти з двох місць. Без CAS обидва виклики побачили б
    // «open» і відкотили б дію двічі - для ідеї це «видалити вже видалене»,
    // для календаря було б видалення чужої події.
    const { env } = setup();
    await idea(env, 'єдина', NOW);
    const [a, b] = await Promise.all([
      undoLastInThread(env, 'dm', NOW + 1000),
      undoLastInThread(env, 'dm', NOW + 1001),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
  });

  it('назвав ПРЕДМЕТ - у мозок, а не в сліпий відкат', async () => {
    // ⚠️ Ширший шаблон пускав будь-яке слово після «останнє», і «скасуй
    // останнє нагадування» відкочувало останню дію треду - нею могла бути
    // подія в календарі (ревʼю релізу).
    const { env, tg } = setup();
    await idea(env, 'єдина', NOW);
    for (const phrase of ['скасуй останнє нагадування', 'скасуй останню зустріч']) {
      tg.length = 0;
      await prerouteMessage(env, msg(phrase), NOW + 1000);
      expect(
        tg.some((c) => String(c.body.text ?? '').includes('Відкотив')),
        phrase,
      ).toBe(false);
    }
  });

  it('відкат упав - рядок лишається відкочуваним, а не закритим назавжди', async () => {
    // ⚠️ Клейм стоїть ДО відкату (щоб два одночасні не відкотили двічі), тож
    // при збої його треба ПОВЕРНУТИ: інакше повтор давав би «нема чого
    // відкочувати», а дія лишалась зробленою (ревʼю релізу).
    const { env } = setup();
    await idea(env, 'єдина', NOW);
    const executors = (await import('../web/core/policy/proposals.mjs')).EXECUTORS;
    const real = executors['ideas.create']!.undo!;
    executors['ideas.create']!.undo = async () => {
      throw new Error('Google відмовив');
    };
    const failed = await undoLastInThread(env, 'dm', NOW + 1000);
    executors['ideas.create']!.undo = real;
    expect(failed).toMatchObject({ ok: false, reason: 'failed' });
    // Друга спроба - уже зі справжнім виконавцем - має спрацювати.
    expect(await undoLastInThread(env, 'dm', NOW + 2000)).toMatchObject({ ok: true });
  });

  it('дуже стара дія «останнім» не вважається', async () => {
    const { env } = setup();
    await idea(env, 'позавчорашня', NOW);
    const twoDays = NOW + 2 * 24 * 60 * 60_000;
    expect(await undoLastInThread(env, 'dm', twoDays)).toEqual({ ok: false, reason: 'none' });
  });

  it('пачкове скасування доходить і через policy, не лише інструментом', async () => {
    const { env, db } = setup();
    for (const id of ['r1', 'r2'])
      db.prepare(
        `INSERT INTO reminders (id, due_at, text, status, snooze_count) VALUES (?,?,?,'pending',0)`,
      ).run(id, '2026-09-09T09:00:00.000Z', `справа ${id}`);
    const out = await applyPolicy(
      env,
      {
        kind: 'reminders.cancel',
        payload: { ids: ['r1', 'r2'] },
        threadId: 'dm',
        chatId: 555,
        tainted: false,
      },
      NOW,
    );
    expect(out.mode).toBe('executed');
    expect(
      db.prepare(`SELECT count(*) AS n FROM reminders WHERE status = 'cancelled'`).get(),
    ).toEqual({ n: 2 });
  });

  it('порожній тред - чесна відмова, не виняток', async () => {
    const { env, tg } = setup();
    expect(await prerouteMessage(env, msg('скасуй останнє'), NOW)).toBe(true);
    expect(tg.some((c) => String(c.body.text ?? '').includes('Нема чого відкочувати'))).toBe(true);
  });
});

/** Повідомлення власника в DM - те, що дає parseUpdate. */
function msg(text: string) {
  return { kind: 'message', chatId: 555, threadId: null, text, messageId: 10, fromId: 555 };
}
