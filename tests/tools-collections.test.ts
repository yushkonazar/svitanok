// Колекції (етап 3 PR-5, S-N4-1…5): схема 07 §2, приведення значень,
// компілятор фільтрів (json_extract з біндингами, інʼєкція неможлива),
// FTS, policy (T0 з «↩», records.delete T1, forget T2 зі словом), CSV.
// Реальні міграції 0006 (collections/records) + 0008 (records_fts).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  normalizeFields,
  coerceValue,
  coerceRecord,
  compileWhere,
  findCollection,
  runCollectionsCreate,
  runCollectionsUpdate,
  runCollectionsList,
  deleteCollection,
  runRecordsCreate,
  runRecordsUpdate,
  runRecordsList,
  runRecordsSearch,
  runRecordsDelete,
  exportCollectionCsv,
  RECORDS_LIST_MAX,
} from '../web/core/tools/collections.mjs';
import { applyPolicy, resolveUndo, resolveProposal } from '../web/core/policy/proposals.mjs';
import { ACTION_LEVELS } from '../web/core/policy/core.mjs';
import { TOOLS } from '../web/core/tools/index.mjs';
import { workerEnv } from './helpers/env.js';
import { d1FromSqlite } from './helpers/d1.js';

const NOW = Date.parse('2026-09-03T10:00:00.000Z');
const MIGRATIONS = [
  '0001_base.sql',
  '0002_assistant.sql',
  '0006_inbox_collections.sql',
  '0008_fts.sql',
];

/** Схема «Сервіси» з 07 §2. */
const SERVICES_FIELDS = [
  { name: 'назва', type: 'text', required: true },
  { name: 'категорія', type: 'choice', options: ['музика', 'хмара', 'ШІ', 'звʼязок', 'інше'] },
  { name: 'ціна_міс', type: 'money', currency: 'UAH' },
  { name: 'валюта', type: 'choice', options: ['UAH', 'USD', 'EUR'] },
  { name: 'дата_списання', type: 'date' },
  { name: 'статус', type: 'choice', options: ['активний', 'скасований'], default: 'активний' },
  { name: 'email_логіну', type: 'text' },
  { name: 'нотатки', type: 'text' },
];

let d1: ReturnType<typeof d1FromSqlite>;
let env: Env;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  d1 = d1FromSqlite(MIGRATIONS);
  env = workerEnv({ DB: d1.stub, TELEGRAM_CHAT_ID: '555', TELEGRAM_BOT_TOKEN: 'tok' });
});

const count = (sql: string) => (d1.db.prepare(sql).get() as { n: number }).n;

async function services() {
  const { result } = await runCollectionsCreate(
    env,
    {
      name: 'Сервіси',
      description: 'Сервіси, якими користуюсь',
      fields: SERVICES_FIELDS,
      sort_by: 'дата_списання',
    },
    NOW,
  );
  return result;
}

describe('схема (07 §2)', () => {
  it('normalizeFields: 8 полів канону проходять; дубль, чужий тип, choice без options, крива назва - помилки', () => {
    const fields = normalizeFields(SERVICES_FIELDS);
    expect(fields.map((f) => f.name)).toEqual(SERVICES_FIELDS.map((f) => f.name));
    expect(fields[5]?.default).toBe('активний');
    expect(() =>
      normalizeFields([
        { name: 'a', type: 'text' },
        { name: 'A', type: 'text' },
      ]),
    ).toThrow(/повторюється/);
    expect(() => normalizeFields([{ name: 'a', type: 'json' }])).toThrow(/тип поля/);
    expect(() => normalizeFields([{ name: 'a', type: 'choice' }])).toThrow(/options/);
    expect(() => normalizeFields([{ name: 'a; DROP', type: 'text' }])).toThrow(/назва поля/);
    expect(() => normalizeFields([])).toThrow(/непорожній/);
  });

  it('coerceValue: число з комою і валютою, дата DD.MM.YYYY, так/ні, choice без регістру, url з протоколом', () => {
    expect(coerceValue({ name: 'p', type: 'money' }, '4,99 USD')).toBe(4.99);
    expect(coerceValue({ name: 'p', type: 'number' }, 7)).toBe(7);
    expect(() => coerceValue({ name: 'p', type: 'number' }, 'багато')).toThrow(/число/);
    expect(coerceValue({ name: 'd', type: 'date' }, '15.09.2026')).toBe('2026-09-15');
    expect(coerceValue({ name: 'd', type: 'date' }, '2026-09-15T10:00:00Z')).toBe('2026-09-15');
    expect(() => coerceValue({ name: 'd', type: 'date' }, 'п’ятнадцятого')).toThrow(/дата/);
    expect(coerceValue({ name: 'b', type: 'bool' }, 'так')).toBe(true);
    expect(coerceValue({ name: 'b', type: 'bool' }, 'ні')).toBe(false);
    expect(coerceValue({ name: 'c', type: 'choice', options: ['Музика'] }, 'музика')).toBe(
      'Музика',
    );
    expect(() => coerceValue({ name: 'c', type: 'choice', options: ['a'] }, 'z')).toThrow(/одне з/);
    expect(() => coerceValue({ name: 'u', type: 'url' }, 'example.com')).toThrow(/http/);
    expect(coerceValue({ name: 't', type: 'text' }, null)).toBeNull();
  });

  it('coerceRecord: дефолти й обовʼязкові лише при створенні; невідоме поле - помилка з переліком', () => {
    const fields = normalizeFields(SERVICES_FIELDS);
    const full = coerceRecord(
      fields,
      { назва: 'Spotify', категорія: 'музика' },
      { partial: false },
    );
    expect(full).toMatchObject({ назва: 'Spotify', статус: 'активний' });
    expect(() => coerceRecord(fields, { категорія: 'музика' }, { partial: false })).toThrow(
      /обовʼязкове/,
    );
    expect(coerceRecord(fields, { ціна_міс: '4.99' }, { partial: true })).toEqual({
      ціна_міс: 4.99,
    });
    expect(() => coerceRecord(fields, { ціна: 1 }, { partial: true })).toThrow(
      /у схемі немає \(є: назва/,
    );
  });
});

describe('правки ревʼю PR-5', () => {
  it('дата з календарною перевіркою: 31.02 і 2026-13-45 - помилки, 29.02.2028 - ок', () => {
    expect(() => coerceValue({ name: 'd', type: 'date' }, '31.02.2026')).toThrow(/дата/);
    expect(() => coerceValue({ name: 'd', type: 'date' }, '2026-13-45')).toThrow(/дата/);
    expect(coerceValue({ name: 'd', type: 'date' }, '29.02.2028')).toBe('2028-02-29');
  });

  it('поля «id» і «_updated» зарезервовані (їх додає records.list до рядка)', () => {
    expect(() => normalizeFields([{ name: 'ID', type: 'text' }])).toThrow(/зарезервована/);
    expect(() => normalizeFields([{ name: '_updated', type: 'date' }])).toThrow(/зарезервована/);
  });

  it('зміна схеми без sort_by: зникле поле сортування скидається, а не валить оновлення', async () => {
    await services();
    const { result } = await runCollectionsUpdate(env, {
      collection: 'Сервіси',
      fields: [{ name: 'назва', type: 'text' }],
    });
    expect(result.fields).toEqual(['назва']);
    expect((await findCollection(env, 'Сервіси'))?.sort_by).toBeNull();
    await expect(
      runCollectionsUpdate(env, { collection: 'Сервіси', sort_by: 'дата_списання' }),
    ).rejects.toThrow(/sort_by/);
  });

  it('CSV: клітинки з = + - @ на початку екрануються апострофом (формули Excel)', async () => {
    await services();
    await runRecordsCreate(
      env,
      { collection: 'Сервіси', data: { назва: '=HYPERLINK("x")', нотатки: '-5 грн' } },
      NOW,
    );
    const csv = await exportCollectionCsv(env, 'Сервіси');
    expect(csv.content).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv.content).toContain(`"'-5 грн"`);
  });
});

describe('compileWhere - компілятор фільтрів', () => {
  const fields = normalizeFields(SERVICES_FIELDS);

  it('шлях і значення - біндингами, числа через CAST, contains через LIKE з ESCAPE', () => {
    const out = compileWhere(fields, [
      { field: 'ціна_міс', op: '>', value: 100 },
      { field: 'назва', op: 'contains', value: '50%_off' },
      { field: 'категорія', op: 'in', value: ['музика', 'хмара'] },
      { field: 'нотатки', op: 'empty' },
    ]);
    expect(out.sql).toBe(
      "CAST(json_extract(data_json, ?) AS REAL) > ? AND json_extract(data_json, ?) LIKE ? ESCAPE '\\' AND json_extract(data_json, ?) IN (?, ?) AND (json_extract(data_json, ?) IS NULL OR json_extract(data_json, ?) = '')",
    );
    expect(out.binds).toEqual([
      '$.ціна_міс',
      100,
      '$.назва',
      '%50\\%\\_off%',
      '$.категорія',
      'музика',
      'хмара',
      '$.нотатки',
      '$.нотатки',
    ]);
  });

  it('інʼєкція неможлива: чуже поле, чужий оператор, значення не за типом - помилки, SQL не будується', () => {
    expect(() => compileWhere(fields, [{ field: "назва') OR 1=1 --", op: '=', value: 1 }])).toThrow(
      /у схемі немає/,
    );
    expect(() => compileWhere(fields, [{ field: 'назва', op: 'LIKE', value: 'x' }])).toThrow(
      /оператор/,
    );
    expect(() => compileWhere(fields, [{ field: 'ціна_міс', op: '>', value: '1 OR 1' }])).toThrow(
      /число/,
    );
    expect(() => compileWhere(fields, 'ціна > 100')).toThrow(/список умов/);
    expect(compileWhere(fields, undefined)).toEqual({ sql: '', binds: [] });
  });
});

describe('collections + records наскрізь (D1 0006 + FTS 0008)', () => {
  it('create: колекція з полями; дубль назви - помилка; findCollection без регістру; list із кількістю', async () => {
    const created = await services();
    expect(created).toMatchObject({ name: 'Сервіси', sort_by: 'дата_списання' });
    expect(created.fields).toHaveLength(8);
    await expect(services()).rejects.toThrow(/уже є/);
    expect((await findCollection(env, 'сервіси'))?.id).toBe(created.id);
    const { result } = await runCollectionsList(env);
    expect(result).toEqual([expect.objectContaining({ name: 'Сервіси', records: 0 })]);
  });

  it('records: create з парсингом (S-N4-2), FTS, list із фільтром (S-N4-3) і сортуванням, update зі знімком, search, delete', async () => {
    await services();
    const spotify = await runRecordsCreate(
      env,
      {
        collection: 'Сервіси',
        data: {
          назва: 'Spotify',
          категорія: 'музика',
          ціна_міс: '4.99',
          валюта: 'USD',
          дата_списання: '15.09.2026',
        },
      },
      NOW,
    );
    expect(spotify.result.data).toMatchObject({
      назва: 'Spotify',
      ціна_міс: 4.99,
      дата_списання: '2026-09-15',
      статус: 'активний',
    });
    await runRecordsCreate(
      env,
      {
        collection: 'Сервіси',
        data: {
          назва: 'iCloud',
          категорія: 'хмара',
          ціна_міс: 129,
          валюта: 'UAH',
          дата_списання: '2026-09-01',
        },
      },
      NOW + 1,
    );
    await runRecordsCreate(
      env,
      {
        collection: 'Сервіси',
        data: {
          назва: 'ChatGPT',
          категорія: 'ШІ',
          ціна_міс: 800,
          валюта: 'UAH',
          дата_списання: '2026-09-20',
        },
      },
      NOW + 2,
    );
    expect(count('SELECT COUNT(*) AS n FROM records_fts')).toBe(3);

    const expensive = await runRecordsList(env, {
      collection: 'Сервіси',
      where: [{ field: 'ціна_міс', op: '>', value: 100 }],
    });
    expect(expensive.result.items.map((r) => r.назва).sort()).toEqual(['ChatGPT', 'iCloud']);
    // Сортування за sort_by колекції (дата) за зростанням.
    const all = await runRecordsList(env, { collection: 'Сервіси' });
    expect(all.result.items.map((r) => r.назва)).toEqual(['iCloud', 'Spotify', 'ChatGPT']);
    const byPrice = await runRecordsList(env, {
      collection: 'Сервіси',
      sort: 'ціна_міс',
      desc: true,
    });
    expect(byPrice.result.items[0]?.назва).toBe('ChatGPT');
    expect(all.result.fields).toEqual(SERVICES_FIELDS.map((f) => f.name));

    const upd = await runRecordsUpdate(
      env,
      { collection: 'Сервіси', id: spotify.result.id, data: { ціна_міс: 5.99 } },
      NOW + 3,
    );
    expect(upd.prev).toEqual({ id: spotify.result.id, data: spotify.result.data });
    expect(upd.result.data.ціна_міс).toBe(5.99);
    await expect(
      runRecordsUpdate(env, { collection: 'Сервіси', id: 'nope', data: { ціна_міс: 1 } }, NOW),
    ).rejects.toThrow(/немає/);

    expect((await runRecordsSearch(env, { q: 'spotify' })).result).toHaveLength(1);
    expect(
      (await runRecordsSearch(env, { q: 'хмара', collection: 'Сервіси' })).result[0]?.назва,
    ).toBe('iCloud');

    const del = await runRecordsDelete(env, { collection: 'Сервіси', id: spotify.result.id });
    expect(del.result.deleted).toBe(true);
    expect(count('SELECT COUNT(*) AS n FROM records')).toBe(2);
    expect(count('SELECT COUNT(*) AS n FROM records_fts')).toBe(2);
  });

  it('list: стеля 20 і прапорець more', async () => {
    await services();
    for (let i = 0; i < RECORDS_LIST_MAX + 1; i += 1) {
      await runRecordsCreate(env, { collection: 'Сервіси', data: { назва: `S${i}` } }, NOW + i);
    }
    const { result } = await runRecordsList(env, { collection: 'Сервіси', limit: 99 });
    expect(result.items).toHaveLength(RECORDS_LIST_MAX);
    expect(result.more).toBe(true);
  });

  it('collections.update: перейменування переіндексовує FTS, знімок для «↩», дубль назви - помилка', async () => {
    const created = await services();
    await runCollectionsCreate(env, { name: 'Інша', fields: [{ name: 'x', type: 'text' }] }, NOW);
    await runRecordsCreate(env, { collection: 'Сервіси', data: { назва: 'Spotify' } }, NOW);
    const { prev } = await runCollectionsUpdate(env, { collection: created.id, name: 'Підписки' });
    expect(prev).toMatchObject({ id: created.id, name: 'Сервіси', sort_by: 'дата_списання' });
    expect((await runRecordsSearch(env, { q: 'підписки' })).result).toHaveLength(1);
    await expect(
      runCollectionsUpdate(env, { collection: 'Підписки', name: 'Інша' }),
    ).rejects.toThrow(/уже є/);
  });

  it('deleteCollection стирає записи й FTS; CSV з BOM, лапками і кількістю рядків', async () => {
    await services();
    await runRecordsCreate(
      env,
      { collection: 'Сервіси', data: { назва: 'A, "B"', нотатки: 'рядок\nдва' } },
      NOW,
    );
    const csv = await exportCollectionCsv(env, 'Сервіси');
    expect(csv.filename).toBe('Сервіси.csv');
    expect(csv.rows).toBe(1);
    expect(csv.content.startsWith(`${String.fromCharCode(0xfeff)}назва,категорія`)).toBe(true);
    expect(csv.content).toContain('"A, ""B"""');
    expect(csv.content).toContain('"рядок\nдва"');
    const erased = await deleteCollection(env, 'сервіси');
    expect(erased).toEqual({ name: 'Сервіси', records: 1 });
    expect(count('SELECT COUNT(*) AS n FROM records')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM records_fts')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM collections')).toBe(0);
  });
});

describe('policy: рівні й виконавці колекцій', () => {
  it('рівні: create/update/export T0, records.delete T1, forget T2; collections.delete = forget', () => {
    expect(ACTION_LEVELS['collections.create']).toBe('T0');
    expect(ACTION_LEVELS['records.update']).toBe('T0');
    expect(ACTION_LEVELS['records.delete']).toBe('T1');
    // ⚠️ Від 08.09 експорт - T0: файл не виходить нікуди, крім чату власника,
    // і відкочувати в ньому нічого (тому й без «↩»).
    expect(ACTION_LEVELS['collection.export']).toBe('T0');
    expect(ACTION_LEVELS['forget']).toBe('T2');
    expect(TOOLS['collections.delete']?.write?.kind).toBe('forget');
    expect(TOOLS['records.list']?.write).toBeUndefined();
  });

  it('T0 create колекції з «↩» → undo видаляє; T0 запис з «↩» → undo видаляє; update запису → undo повертає data', async () => {
    const col = await applyPolicy(
      env,
      {
        kind: 'collections.create',
        payload: { name: 'Сервіси', fields: SERVICES_FIELDS },
        tainted: false,
      },
      NOW,
    );
    if (col.mode !== 'executed' || !col.undo) throw new Error('очікувався T0 з undo');
    const rec = await applyPolicy(
      env,
      {
        kind: 'records.create',
        payload: { collection: 'Сервіси', data: { назва: 'Spotify', ціна_міс: 4.99 } },
        tainted: false,
      },
      NOW + 1,
    );
    if (rec.mode !== 'executed' || !rec.undo) throw new Error('очікувався T0 з undo');
    const recId = (rec.result as { id: string }).id;
    const upd = await applyPolicy(
      env,
      {
        kind: 'records.update',
        payload: { collection: 'Сервіси', id: recId, data: { ціна_міс: 9.99 } },
        tainted: false,
      },
      NOW + 2,
    );
    if (upd.mode !== 'executed' || !upd.undo) throw new Error('очікувався T0 з undo');
    await resolveUndo(env, upd.undo.id, NOW + 3);
    const row = d1.db.prepare('SELECT data_json FROM records').get() as { data_json: string };
    expect(JSON.parse(row.data_json).ціна_міс).toBe(4.99);
    await resolveUndo(env, rec.undo.id, NOW + 4);
    expect(count('SELECT COUNT(*) AS n FROM records')).toBe(0);
    await resolveUndo(env, col.undo.id, NOW + 5);
    expect(count('SELECT COUNT(*) AS n FROM collections')).toBe(0);
  });

  it('forget (T2): пропозиція зі словом; ✅ без слова - word-required; зі словом - стерто (S-N4-5)', async () => {
    await services();
    await runRecordsCreate(env, { collection: 'Сервіси', data: { назва: 'X' } }, NOW);
    const out = await applyPolicy(
      env,
      {
        kind: 'forget',
        payload: { target: 'collection', collection: 'Сервіси' },
        tainted: false,
        threadId: 'dm',
      },
      NOW,
    );
    if (out.mode !== 'proposed') throw new Error('очікувалась пропозиція');
    expect(out.proposal.level).toBe('T2');
    // Слово несе випадковий суфікс: саме він робить його ідентифікатором
    // ПРОПОЗИЦІЇ, а не типом підтвердження (security-ревʼю етапу 7).
    expect(out.proposal.word).toMatch(/^[А-ЯІЇЄҐ-]+-[A-Z0-9]{3}$/u);
    expect(await resolveProposal(env, { id: out.proposal.id, choice: 'ok' }, NOW + 1)).toEqual({
      ok: false,
      error: 'word-required',
    });
    expect(count('SELECT COUNT(*) AS n FROM collections')).toBe(1);
    const done = await resolveProposal(
      env,
      { id: out.proposal.id, choice: 'ok', word: out.proposal.word },
      NOW + 2,
    );
    expect(done).toMatchObject({
      ok: true,
      executed: true,
      result: { erased: 'колекція «Сервіси» (1 зап.)' },
    });
    expect(count('SELECT COUNT(*) AS n FROM collections')).toBe(0);
    // Чат/усе - чесна відмова до своїх етапів.
    const chat = await applyPolicy(
      env,
      { kind: 'forget', payload: { target: 'chat', id: 'c1' }, tainted: false },
      NOW,
    );
    if (chat.mode !== 'proposed') throw new Error('очікувалась пропозиція');
    const res = await resolveProposal(
      env,
      { id: chat.proposal.id, choice: 'ok', word: chat.proposal.word },
      NOW + 1,
    );
    // Чат є з етапу 6, але без назви стирати нема чого - чесна відмова.
    expect(res).toMatchObject({
      ok: false,
      error: expect.stringContaining('не сказано, який чат'),
    });
  });

  it('collection.export (T0): документ .csv іде в outbox треду одразу', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 }),
      ),
    );
    await services();
    await runRecordsCreate(env, { collection: 'Сервіси', data: { назва: 'Spotify' } }, NOW);
    const out = await applyPolicy(
      env,
      {
        kind: 'collection.export',
        payload: { collection: 'Сервіси' },
        tainted: false,
        threadId: '99',
      },
      NOW,
    );
    // T0 від 08.09: документ іде одразу, без ✅.
    expect(out).toMatchObject({ mode: 'executed', result: { filename: 'Сервіси.csv', rows: 1 } });
    const doc = d1.db
      .prepare(`SELECT chat_id, thread_id, kind, payload_json FROM outbox`)
      .get() as {
      chat_id: string;
      thread_id: string;
      kind: string;
      payload_json: string;
    };
    expect(doc).toMatchObject({ chat_id: '555', thread_id: '99', kind: 'document' });
    expect(JSON.parse(doc.payload_json).filename).toBe('Сервіси.csv');
    vi.unstubAllGlobals();
  });
});
