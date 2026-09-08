// Ядро говорить людською (релізний блок PR-2, скарги 4/9/13/16 прогону 08.09).
// Словник дій, обсяг T2, посилання в тексті, статуси прогону - усе, що власник
// читає очима і де технічна назва була б внутрішньою кухнею.

import { describe, it, expect, vi } from 'vitest';
import { ACTION_PHRASE, actionPhrase, actionIcon, plural } from '../web/core/tg/phrase.mjs';
import { ACTION_LEVELS } from '../web/core/policy/core.mjs';
import { describeProposal, humanAction } from '../web/core/prerouter.mjs';
import { proposalVolume } from '../web/core/policy/volume.mjs';
import { toolStatusWord } from '../brain/src/tools/status-words.js';
import { workerButtons } from '../web/core/brain/worker-results.mjs';
import { workerEnv } from './helpers/env.js';
import { d1FromSqlite } from './helpers/d1.js';
import { memoryKv } from './helpers/kv.js';

/** Env із живим токеном Google (Date.now(), не фіксована мітка - інакше ядро
 *  пішло б по новий токен у мережу і стаб віддав би йому не те). */
const googleEnv = () =>
  workerEnv({
    BRIEFING: memoryKv(
      new Map([['googleToken', JSON.stringify({ token: 'tok', expMs: Date.now() + 3_600_000 })]]),
    ),
    GOOGLE_CLIENT_ID: 'c',
    GOOGLE_CLIENT_SECRET: 's',
    GOOGLE_REFRESH_TOKEN: 'r',
  });

describe('словник дій', () => {
  it('кожен kind із ACTION_LEVELS має людську назву', () => {
    // ⚠️ Парність, а не список: новий kind без рядка тут показав би власнику
    // технічну назву - рівно те, на що він скаржився.
    const missing = Object.keys(ACTION_LEVELS).filter((k) => !ACTION_PHRASE[k]);
    expect(missing).toEqual([]);
  });

  it('невідомий kind - видима технічна назва, не мовчазна заглушка', () => {
    expect(actionPhrase('nope.kind', 'X')).toBe('nope.kind «X»');
    expect(actionIcon('nope.kind')).toBe('');
  });

  it('для власника - людською, для моделі - kind', () => {
    const payload = { collection: 'ТЕСТ-Сервіси' };
    expect(humanAction('collection.export', payload)).toBe('Експортував колекцію «ТЕСТ-Сервіси»');
    // Дайджест рішень читає МОДЕЛЬ: їй потрібен саме kind, щоб не повторювати дію.
    expect(describeProposal('collection.export', payload)).toBe('collection.export «ТЕСТ-Сервіси»');
  });

  it('інфінітив для пропозиції, доконаний вид для результату', () => {
    expect(humanAction('forget', { target: 'all' }, 'ask')).toBe('Стерти');
    expect(humanAction('forget', { erased: 'x' })).toBe('Стер');
  });
});

describe('посилання - у тексті, не голим URL', () => {
  it('drive.write з лінком дає підпис-посилання - але ЛИШЕ з результату', () => {
    const obj = { name: 'ТЕСТ-нотатка.md', link: 'https://drive.google.com/file/d/n1/view' };
    expect(humanAction('drive.write', obj, 'done', true)).toBe(
      'Зберіг нотатку «[ТЕСТ-нотатка.md](https://drive.google.com/file/d/n1/view)»',
    );
    // ⚠️ Той самий обʼєкт як PAYLOAD моделі посилання не дає: інакше ядро
    // своїм голосом ставило б клікабельний лінк, який склала модель
    // (security-ревʼю релізу).
    expect(humanAction('drive.write', obj)).toBe('Зберіг нотатку «ТЕСТ-нотатка.md»');
  });

  it('https-лінк ІЗ PAYLOAD не стає посиланням - його склала модель', () => {
    // ⚠️ Саме цей випадок ревʼю назвало дірою: перевірка схеми його пускала,
    // бо схема правильна. Відсікає його джерело, не вигляд.
    const model = { name: 'Підтвердити акаунт', link: 'https://evil.example/phish' };
    expect(humanAction('calendar.delete', model)).toBe('Видалив подію «Підтвердити акаунт»');
    expect(humanAction('calendar.delete', model, 'ask')).toBe(
      'Видалити подію «Підтвердити акаунт»',
    );
  });

  it('не-https або не з результату - лінка немає (payload пише модель)', () => {
    for (const link of ['javascript:alert(1)', 'http://x/y', 'drive.google.com/f', 42]) {
      expect(humanAction('drive.write', { name: 'н', link }, 'done', true)).toBe(
        'Зберіг нотатку «н»',
      );
    }
  });

  it('ZWJ усередині емодзі лишається, керівні символи - ні', () => {
    // ⚠️ Зачистка \p{Cf} без винятку рвала «👨‍💻» на два окремі емодзі просто
    // в назві дії (другий прохід ревʼю).
    expect(humanAction('ideas.create', { title: '👨‍💻 Робота' })).toBe('Записав ідею «👨‍💻 Робота»');
    // А ось підробка рядка й далі зрізається.
    expect(humanAction('ideas.create', { title: 'X [Ядро] Y' })).toBe('Записав ідею «X [Ядро] Y»');
  });

  it('дужки в назві не рвуть підпис', () => {
    const out = humanAction(
      'drive.write',
      { name: 'а [b] c', link: 'https://x.example/f' },
      'done',
      true,
    );
    expect(out).toBe('Зберіг нотатку «[а  b  c](https://x.example/f)»');
  });
});

describe('обсяг T2 - ДО слова', () => {
  const MIGRATIONS = ['0001_base.sql', '0002_assistant.sql', '0006_inbox_collections.sql'];
  const ALL_MIGRATIONS = [
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
  ];

  it('forget target=collection - скільки записів і в якій колекції', async () => {
    const d1 = d1FromSqlite(MIGRATIONS);
    d1.db
      .prepare(`INSERT INTO collections (id, name, fields_json, created_at) VALUES (?,?,?,?)`)
      .run('c1', 'Сервіси', '{}', 'x');
    for (const id of ['r1', 'r2', 'r3'])
      d1.db
        .prepare(
          `INSERT INTO records (id, collection_id, data_json, created_at, updated_at) VALUES (?,?,?,?,?)`,
        )
        .run(id, 'c1', '{}', 'x', 'x');
    const env = workerEnv({ DB: d1.stub });
    expect(
      await proposalVolume(env, 'forget', { target: 'collection', collection: 'Сервіси' }),
    ).toBe('3 записи у колекції «Сервіси»');
  });

  it('forget target=all - рядки по всіх таблицях, а не «все»', async () => {
    const d1 = d1FromSqlite(ALL_MIGRATIONS);
    for (const key of ['k1', 'k2'])
      d1.db
        .prepare(
          `INSERT INTO facts (key, kind, value_json, source, created_at, updated_at) VALUES (?,'setting','1','owner','x','x')`,
        )
        .run(key);
    const env = workerEnv({ DB: d1.stub });
    const text = await proposalVolume(env, 'forget', { target: 'all' });
    expect(text).toMatch(/^2 рядки у \d+ таблицях і \d+ ключів KV$/);
  });

  it('рахунок упав - пропозиція лишається без числа, не падає', async () => {
    const env = workerEnv({}); // DB немає
    expect(await proposalVolume(env, 'forget', { target: 'all' })).toBe('');
  });

  it('gemini.video обсягу не має - там уже стоїть ціна', async () => {
    expect(await proposalVolume(workerEnv({}), 'gemini.video', { prompt: 'x' })).toBe('');
  });
});

describe('статуси прогону - що я роблю, а не «Думаю»', () => {
  it('точні збіги й префікси', () => {
    expect(toolStatusWord('mail.search')).toBe('Читаю пошту');
    expect(toolStatusWord('routes.matrix')).toBe('Рахую маршрут');
    expect(toolStatusWord('wishes.create')).toBe('Дивлюсь бажання'); // за префіксом
  });

  it('невідомий інструмент - порожньо: краще старий статус, ніж вигаданий', () => {
    expect(toolStatusWord('чогось.такого')).toBe('');
  });
});

describe('plural - одне правило на весь проєкт', () => {
  it('11-14 - пастка, що ловить наївну реалізацію', () => {
    expect([1, 2, 5, 11, 12, 21, 22, 25].map((n) => plural(n, 'рядок', 'рядки', 'рядків'))).toEqual(
      ['рядок', 'рядки', 'рядків', 'рядків', 'рядків', 'рядок', 'рядки', 'рядків'],
    );
  });
});

describe('кнопки за працівником і слід вибору', () => {
  it('пошта дістає свої кнопки, а не «Коротше / Інший тон»', () => {
    const mail = workerButtons('w1', true, 'mail-secretary')[0]!;
    expect(mail.map((b) => b.callback_data)).toEqual(['m:w:w1:draft', 'm:w:w1:next', 'm:w:w1:md']);
    // Скарга 15: під тріажем висіли кнопки для ТЕКСТУ, а не для переліку листів.
    expect(JSON.stringify(mail)).not.toContain('tone');
  });

  it('невідомий працівник - базовий набір (для довільного тексту він і правильний)', () => {
    expect(workerButtons('w2', false, 'нема-такого')[0]!.map((b) => b.callback_data)).toEqual([
      'm:w:w2:short',
      'm:w:w2:tone',
    ]);
  });

  it('імʼя з прототипу не валить доставку («constructor» проходить NAME_RE)', () => {
    // ⚠️ Імʼя працівника приходить від моделі: індексація звичайного обʼєкта
    // резолвила `constructor` в Object, у якого немає .map, і фінальна
    // відповідь прогону не доходила взагалі (security-ревʼю релізу).
    for (const evil of ['constructor', 'toString', 'valueOf']) {
      expect(() => workerButtons('w9', false, evil), evil).not.toThrow();
      expect(workerButtons('w9', false, evil)[0]!.map((b) => b.callback_data)).toEqual([
        'm:w:w9:short',
        'm:w:w9:tone',
      ]);
    }
  });

  it('довгий результат - без «.md» у рядку (він уже пішов файлом)', () => {
    expect(workerButtons('w3', false, 'researcher')[0]!.map((b) => b.callback_data)).toEqual([
      'm:w:w3:src',
      'm:w:w3:short',
    ]);
  });
});

describe('«↩» для дій, що переїхали з T1 (реліз 08.09)', () => {
  it('deleteTask: 404 - успіх (задачі вже немає, чого «↩» і домагався)', async () => {
    const { deleteTask } = await import('../web/core/adapters/tasks.mjs');
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method} ${String(url)}`);
        return new Response('', { status: 404 });
      }),
    );
    const env = googleEnv();
    await expect(deleteTask(env, 't9')).resolves.toBeUndefined();
    expect(calls[0]).toContain('DELETE');
    expect(calls[0]).toContain('/tasks/t9');
    vi.unstubAllGlobals();
  });

  it('deleteTask: id поза алфавітом Google - відмова ДО мережі («..» міняє адресата)', async () => {
    const { deleteTask } = await import('../web/core/adapters/tasks.mjs');
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const env = googleEnv();
    for (const bad of ['../lists/@default/tasks/x', 'a/b', '', 'x'.repeat(300)]) {
      await expect(deleteTask(env, bad)).rejects.toThrow(/не схожий на задачу/);
    }
    expect(spy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('trashFile: id поза алфавітом - відмова ДО мережі', async () => {
    const { trashFile } = await import('../web/core/adapters/drive.mjs');
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    for (const bad of ['../files/x', 'a/b', '', 'x'.repeat(300)]) {
      await expect(trashFile(googleEnv(), bad)).rejects.toThrow(/не схожий на файл/);
    }
    expect(spy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('«↩» після tasks.create справді видаляє задачу з Tasks', async () => {
    const { applyPolicy, resolveUndo } = await import('../web/core/policy/proposals.mjs');
    const d1 = d1FromSqlite(['0001_base.sql', '0002_assistant.sql']);
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? 'GET'} ${String(url)}`);
        return new Response(JSON.stringify({ id: 't9', title: 'молоко' }), { status: 200 });
      }),
    );
    const env = workerEnv({
      DB: d1.stub,
      BRIEFING: memoryKv(
        new Map([['googleToken', JSON.stringify({ token: 'tok', expMs: Date.now() + 3_600_000 })]]),
      ),
      GOOGLE_CLIENT_ID: 'c',
      GOOGLE_CLIENT_SECRET: 's',
      GOOGLE_REFRESH_TOKEN: 'r',
    });
    const NOW = Date.parse('2026-09-08T10:00:00.000Z');
    const out = await applyPolicy(
      env,
      { kind: 'tasks.create', payload: { title: 'молоко' }, threadId: 'dm', tainted: false },
      NOW,
    );
    expect(out.mode).toBe('executed');
    const undoId = out.mode === 'executed' ? out.undo?.id : undefined;
    expect(undoId).toBeTruthy();
    await expect(resolveUndo(env, String(undoId), NOW + 1000)).resolves.toMatchObject({
      status: 'undone',
    });
    expect(calls.some((c) => c.startsWith('DELETE') && c.includes('/tasks/t9'))).toBe(true);
    vi.unstubAllGlobals();
  });

  it('trashFile: у кошик (trashed:true), не «назавжди»', async () => {
    const { trashFile } = await import('../web/core/adapters/drive.mjs');
    const bodies: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response('{}', { status: 200 });
      }),
    );
    await trashFile(googleEnv(), 'n1');
    expect(bodies).toEqual([{ trashed: true }]);
    vi.unstubAllGlobals();
  });
});
