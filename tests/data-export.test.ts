// Експорт даних (S-0-6) і «забудь усе» (S-0-5) - етап 7 PR-4.
//
// ГОЛОВНЕ: (1) архів справді читається сторонніми інструментами - перевіряємо
// його nodeʼівським zlib, а не власним кодом, який його й написав; (2) у файл
// не потрапляє жоден секрет оточення; (3) «забудь усе» стирає ДАНІ й НЕ чіпає
// конфіг застосунку, інакше асистент після цього не працює.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { inflateRawSync, crc32 } from 'node:zlib';
import { buildZip, unwrapGzip } from '../web/core/export/zip.mjs';
import {
  buildExportFiles,
  redactSecrets,
  secretValues,
  runDataExport,
  exportStamp,
  EXPORT_KV_EXCLUDE,
  REDACTED,
} from '../web/core/export/data-export.mjs';
import {
  forgetAll,
  FORGET_ALL_TABLES,
  FORGET_ALL_KV_KEYS,
  FORGET_ALL_STATE_FIELDS,
  FORGET_ALL_KEEP,
} from '../web/core/export/forget-all.mjs';
import { BACKUP_TABLES } from '../web/core/backup/core.mjs';
import { CORE_SCOPES } from '../web/core/google-scopes.mjs';
import { ACTION_LEVELS } from '../web/core/policy/core.mjs';
import { applyPolicy, resolveProposal } from '../web/core/policy/proposals.mjs';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';
import { d1FromSqlite } from './helpers/d1.js';

const NOW = Date.parse('2026-09-08T09:30:00.000Z'); // 12:30 Києва
// ⚠️ expMs - від РЕАЛЬНОГО годинника, не від NOW: свіжість кешу токена
// перевіряє googleAccessToken за Date.now(), тож привʼязка до фіксованого
// NOW робила б тест бомбою сповільненої дії - зеленим уранці й червоним
// пополудні.
const TOKEN_EXP = () => Date.now() + 3_600_000;
const MIGRATIONS = [
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

function makeEnv(kvSeed: Record<string, string> = {}, over: Record<string, unknown> = {}) {
  const store = new Map<string, string>(Object.entries(kvSeed));
  // Кеш токена зі скоупами ядра: інакше Drive упреться в барʼєр S-8-7 і тест
  // доводив би відсутність токена, а не роботу експорту.
  if (!store.has('googleToken')) {
    store.set(
      'googleToken',
      JSON.stringify({ token: 'AT', expMs: TOKEN_EXP(), scope: CORE_SCOPES.join(' ') }),
    );
  }
  const d1 = d1FromSqlite(MIGRATIONS);
  const env = workerEnv({
    ASSISTANT_V2: 'on',
    TELEGRAM_BOT_TOKEN: 'bot',
    TELEGRAM_CHAT_ID: '555',
    GOOGLE_CLIENT_ID: 'id',
    GOOGLE_CLIENT_SECRET: 'secret',
    GOOGLE_REFRESH_TOKEN: 'refresh',
    BRIEFING: memoryKv(store, { listKeys: () => [...store.keys()] }),
    DB: d1.stub,
    ...over,
  });
  return { env, d1, store };
}

/** Розібрати ZIP nodeʼівськими засобами - незалежно від нашого письменника. */
function readZip(zip: Uint8Array): Record<string, string> {
  const buf = Buffer.from(zip);
  const out: Record<string, string> = {};
  let at = 0;
  while (buf.readUInt32LE(at) === 0x04034b50) {
    const crc = buf.readUInt32LE(at + 14);
    const csize = buf.readUInt32LE(at + 18);
    const usize = buf.readUInt32LE(at + 22);
    const nameLen = buf.readUInt16LE(at + 26);
    const extraLen = buf.readUInt16LE(at + 28);
    const name = buf.subarray(at + 30, at + 30 + nameLen).toString('utf8');
    const start = at + 30 + nameLen + extraLen;
    const raw = inflateRawSync(buf.subarray(start, start + csize));
    // CRC і довжина в заголовку мусять відповідати вмісту - інакше архіватори
    // покажуть «пошкоджений архів», а ми б цього не помітили.
    expect(raw.length, name).toBe(usize);
    expect(crc32(raw) >>> 0, name).toBe(crc);
    out[name] = raw.toString('utf8');
    at = start + csize;
  }
  // Центральний каталог - не формальність: саме за ним архіватори знаходять
  // файли. Зміщення мусять вказувати на реальні локальні заголовки, інакше
  // «файли всередині» читає лише той, хто йде по архіву послідовно (як цикл
  // вище) - тобто ми самі, і ніхто більше.
  const names: string[] = [];
  while (buf.readUInt32LE(at) === 0x02014b50) {
    const nameLen = buf.readUInt16LE(at + 28);
    const offset = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    expect(buf.readUInt32LE(offset), `${name}: зміщення в каталозі`).toBe(0x04034b50);
    expect(
      buf.subarray(offset + 30, offset + 30 + nameLen).toString('utf8'),
      `${name}: заголовок за зміщенням`,
    ).toBe(name);
    names.push(name);
    at += 46 + nameLen + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
  }
  expect(buf.readUInt32LE(at)).toBe(0x06054b50); // EOCD
  expect(buf.readUInt16LE(at + 10)).toBe(names.length);
  expect(names).toEqual(Object.keys(out));
  return out;
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('ZIP', () => {
  it('архів читається сторонніми засобами: CRC і розміри збігаються', async () => {
    const enc = new TextEncoder();
    const zip = await buildZip(
      [
        { name: 'a.json', bytes: enc.encode('{"привіт":"світ"}') },
        { name: 'd1/facts.json', bytes: enc.encode('[]') },
      ],
      { dateMs: NOW },
    );
    const files = readZip(zip);
    expect(Object.keys(files)).toEqual(['a.json', 'd1/facts.json']);
    expect(files['a.json']).toBe('{"привіт":"світ"}');
  });

  it('порожній файл теж коректний', async () => {
    const zip = await buildZip([{ name: 'empty.txt', bytes: new Uint8Array(0) }], { dateMs: NOW });
    expect(readZip(zip)['empty.txt']).toBe('');
  });

  it('unwrapGzip розбирає заголовок за прапорцями, а не за фіксованою довжиною', () => {
    // Заголовок із FNAME: 10 байтів + «x\\0». Фіксовані 10 зіпсували б дані.
    const body = Buffer.from([0x01, 0x02, 0x03]);
    const gz = Buffer.concat([
      Buffer.from([0x1f, 0x8b, 0x08, 0x08, 0, 0, 0, 0, 0, 0]),
      Buffer.from('x\0', 'latin1'),
      body,
      Buffer.from([1, 0, 0, 0, 3, 0, 0, 0]),
    ]);
    const out = unwrapGzip(new Uint8Array(gz));
    expect([...out.deflate]).toEqual([1, 2, 3]);
    expect(out.crc).toBe(1);
    expect(out.size).toBe(3);
  });

  it('чужий формат - помилка, а не мовчки зіпсований архів', () => {
    expect(() => unwrapGzip(new Uint8Array(20))).toThrow(/gzip/);
  });

  it('якщо стискач збрехав про довжину - архів не збирається', async () => {
    // Перевірка розміру - страховка від зіпсованого стискача платформи, і
    // спрацювати вона може лише тоді, коли той бреше. Підміняємо його, щоб
    // страховка була доведеною, а не задекларованою.
    class LyingGzip {
      readable: ReadableStream<Uint8Array>;
      writable: WritableStream<Uint8Array>;
      constructor() {
        const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>({
          transform() {},
          flush(controller) {
            // Валідний порожній gzip, але ISIZE каже «999 байтів».
            controller.enqueue(
              new Uint8Array([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xe7, 0x03, 0, 0]),
            );
          },
        });
        this.readable = readable;
        this.writable = writable;
      }
    }
    vi.stubGlobal('CompressionStream', LyingGzip);
    try {
      await expect(
        buildZip([{ name: 'a', bytes: new TextEncoder().encode('щось') }]),
      ).rejects.toThrow(/розмір/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('секрети в експорт не потрапляють', () => {
  it('значення секретів оточення вирізані з усіх файлів', () => {
    const { env } = makeEnv();
    const secret = 'gho_ДУЖЕ-СЕКРЕТНИЙ-ТОКЕН-1234';
    const files = buildExportFiles({
      tables: {
        facts: [{ id: '1', value_json: JSON.stringify({ note: `ключ ${secret} тут` }) }],
      },
      kv: { state: `{"x":"${secret}"}`, googleToken: '{"token":"AT"}' },
      secrets: secretValues(workerEnv({ GH_DISPATCH_TOKEN: secret })),
      nowMs: NOW,
    });
    const all = files.map((f) => new TextDecoder().decode(f.bytes)).join('\n');
    expect(all).not.toContain(secret);
    expect(all).toContain(REDACTED);
    // Кеш OAuth-токена не входить у знімок узагалі.
    expect(all).not.toContain('googleToken');
    void env;
  });

  it('кеш токена Google - у переліку виключених', () => {
    expect(EXPORT_KV_EXCLUDE.has('googleToken')).toBe(true);
  });

  it('короткі значення не вирізаються - інакше експорт зіпсував би власні дані', () => {
    const short = secretValues(workerEnv({ TELEGRAM_CHAT_ID: '555', MONO_TOKEN: 'abc' }));
    expect(short).toEqual([]);
    expect(redactSecrets('555 і abc лишаються', short)).toBe('555 і abc лишаються');
  });

  it('довший секрет вирізається першим (коротший - його префікс)', () => {
    const secrets = secretValues(
      workerEnv({ MONO_TOKEN: 'abcdefghijkl', MONO_WEBHOOK_SECRET: 'abcdefghijklmnop' }),
    );
    expect(redactSecrets('abcdefghijklmnop', secrets)).toBe(REDACTED);
  });
});

describe('склад експорту', () => {
  it('файл на кожну таблицю знімка + kv.json + README', () => {
    const files = buildExportFiles({ tables: {}, kv: {}, secrets: [], nowMs: NOW });
    expect(files).toHaveLength(BACKUP_TABLES.length + 2);
    expect(files.map((f) => f.name)).toContain('d1/transactions.json');
    expect(files.map((f) => f.name)).toContain('kv.json');
  });

  it('імʼя файла - за КИЇВСЬКИМ днем і часом', () => {
    expect(exportStamp(NOW)).toBe('2026-09-08-1230');
  });
});

describe('data.export - T2 (суперечність канону вирішено на користь 07 §4)', () => {
  it('рівень T2, не T1', () => {
    expect(ACTION_LEVELS['data.export']).toBe('T2');
  });

  it('після ✅ зі словом архів лягає в Drive і власник дістає імʼя', async () => {
    const { env, d1 } = makeEnv();
    d1.db.exec(
      `INSERT INTO facts (id, kind, key, value_json, source, confidence, created_at, updated_at)
       VALUES ('f1', 'setting', 'мова', '"укр"', 'owner', 1, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`,
    );
    let uploaded: FormData | null = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.includes('/upload/')) {
        uploaded = (init as RequestInit).body as FormData;
        return new Response(JSON.stringify({ id: 'z1', name: 'x.zip', size: 10 }), { status: 200 });
      }
      if ((init as RequestInit)?.method === 'POST') {
        return new Response(JSON.stringify({ id: 'folder' }), { status: 200 });
      }
      return new Response(JSON.stringify({ files: [] }), { status: 200 });
    });
    const decided = await applyPolicy(
      env,
      { kind: 'data.export', payload: {}, tainted: false },
      NOW,
    );
    if (decided.mode !== 'proposed') throw new Error('очікувалась пропозиція');
    expect(decided.proposal.level).toBe('T2');
    const res = await resolveProposal(
      env,
      { id: decided.proposal.id, choice: 'ok', word: decided.proposal.word ?? undefined },
      NOW,
    );
    if (!('result' in res)) throw new Error(JSON.stringify(res));
    expect(res).toMatchObject({
      ok: true,
      result: { file_id: 'z1', name: 'svitanok-export-2026-09-08-1230.zip' },
    });
    // Архів справді містить рядок факту.
    const blob = (uploaded as unknown as FormData).get('file') as Blob;
    const files = readZip(new Uint8Array(await blob.arrayBuffer()));
    expect(files['d1/facts.json']).toContain('"мова"');
  });

  it('без слова T2 не виконується', async () => {
    const { env } = makeEnv();
    const decided = await applyPolicy(
      env,
      { kind: 'data.export', payload: {}, tainted: false },
      NOW,
    );
    if (decided.mode !== 'proposed') throw new Error('очікувалась пропозиція');
    const res = await resolveProposal(env, { id: decided.proposal.id, choice: 'ok' }, NOW);
    expect(res).toMatchObject({ ok: false, error: 'word-required' });
  });

  it('runDataExport без DB - чесна помилка', async () => {
    const { env } = makeEnv({}, { DB: undefined });
    await expect(runDataExport(env, NOW)).rejects.toThrow(/DB/);
  });
});

describe('forget target=all', () => {
  it('стирає дані власника і НЕ чіпає конфіг застосунку', async () => {
    const { env, d1, store } = makeEnv({
      stats: '{"a":1}',
      state: JSON.stringify({ lastUpdateId: 42, reminders: [{ id: 'r' }], shownMail: { m: 'd' } }),
    });
    d1.db.exec(
      `INSERT INTO facts (id, kind, key, value_json, source, confidence, created_at, updated_at)
       VALUES ('f1', 'setting', 'k', '"v"', 'owner', 1, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`,
    );
    d1.db.exec(
      `INSERT INTO instructions (name, kind, version_hash, body_md, max_chars, deployed_at)
       VALUES ('persona', 'persona', 'h', 'текст', 100, '2026-09-01T00:00:00Z')`,
    );
    const out = await forgetAll(env);
    expect(out.rows).toBeGreaterThan(0);
    expect(d1.db.prepare('SELECT count(*) AS n FROM facts').get()).toEqual({ n: 0 });
    // Персона лишилась: без неї прогін не стартує, і «забудь усе» стало б
    // «вимкни асистента».
    expect(d1.db.prepare('SELECT count(*) AS n FROM instructions').get()).toEqual({ n: 1 });
    expect(store.get('stats')).toBeUndefined();
    const state = JSON.parse(store.get('state') ?? '{}');
    expect(state.lastUpdateId).toBe(42); // робоче листування з Telegram живе
    expect(state.reminders).toBeUndefined();
    expect(state.shownMail).toBeUndefined();
  });

  it('перелік таблиць виводиться зі знімка бекапу - нова таблиця не переживе «усе»', () => {
    const missing = BACKUP_TABLES.filter(
      (t) => !FORGET_ALL_TABLES.includes(t) && !FORGET_ALL_KEEP.includes(t),
    );
    expect(missing).toEqual([]);
    expect(FORGET_ALL_KEEP).toEqual(['instructions', 'instruction_history', 'counters']);
  });

  it('лічильник ідей ОБНУЛЯЄТЬСЯ, а не зникає - інакше ideas.create падає назавжди', async () => {
    // `DELETE FROM counters` прибирає сам рядок, і `UPDATE … RETURNING` після
    // цього віддає null: власник дістав би «міграція 0011 не застосована» на
    // кожній новій ідеї, і полагодити можна було б лише руками в базі.
    const { env, d1 } = makeEnv();
    d1.db.exec(
      `INSERT INTO ideas (id, number, title, body_md, domain, status, priority, next_action, tags_json, source_msg_id, created_at, updated_at)
       VALUES ('i1', 7, 'Тема', '', 'побут', 'нова', 2, '', '[]', NULL, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`,
    );
    d1.db.exec(`UPDATE counters SET value = 7 WHERE name = 'ideas'`);
    await forgetAll(env);
    expect(d1.db.prepare("SELECT value FROM counters WHERE name = 'ideas'").get()).toEqual({
      value: 0,
    });
    expect(d1.db.prepare('SELECT count(*) AS n FROM ideas').get()).toEqual({ n: 0 });
  });

  it('KV-список накриває дані, які власник вважає своїми (координати, збережене)', async () => {
    const { env, store } = makeEnv({
      ownerGeo: '{"lat":49.8,"lon":24,"name":"Львів"}',
      saved: '[]',
      lastUpdateId: '42',
    });
    await forgetAll(env);
    // Локація власника - теж його дані: доти вона переживала «стерто все», і
    // асистент далі відповідав на «де я».
    expect(store.get('ownerGeo')).toBeUndefined();
    expect(store.get('saved')).toBeUndefined();
    // А службовий ключ - лишається: інакше зламався б сам бот.
    expect(store.get('lastUpdateId')).toBe('42');
  });

  it('поля даних у `state` перелічені явно', () => {
    expect(FORGET_ALL_STATE_FIELDS).toContain('mailTriage');
    expect(FORGET_ALL_STATE_FIELDS).toContain('calendarToday');
    expect(FORGET_ALL_KV_KEYS).toContain('stats');
  });

  it('через policy - T2 зі словом, у результаті число стертого', async () => {
    const { env, d1 } = makeEnv();
    d1.db.exec(
      `INSERT INTO facts (id, kind, key, value_json, source, confidence, created_at, updated_at)
       VALUES ('f1', 'setting', 'k', '"v"', 'owner', 1, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`,
    );
    const decided = await applyPolicy(
      env,
      { kind: 'forget', payload: { target: 'all' }, tainted: false },
      NOW,
    );
    if (decided.mode !== 'proposed') throw new Error('очікувалась пропозиція');
    expect(decided.proposal.level).toBe('T2');
    const res = await resolveProposal(
      env,
      { id: decided.proposal.id, choice: 'ok', word: decided.proposal.word ?? undefined },
      NOW,
    );
    expect(res).toMatchObject({
      ok: true,
      result: { erased: expect.stringContaining('таблицях') },
    });
  });

  it('невідома ціль - чесна відмова з переліком', async () => {
    const { env } = makeEnv();
    const decided = await applyPolicy(
      env,
      { kind: 'forget', payload: { target: 'усе-разом' }, tainted: false },
      NOW,
    );
    if (decided.mode !== 'proposed') throw new Error('очікувалась пропозиція');
    const res = await resolveProposal(
      env,
      { id: decided.proposal.id, choice: 'ok', word: decided.proposal.word ?? undefined },
      NOW,
    );
    expect(res).toMatchObject({
      ok: false,
      error: expect.stringContaining('chat | collection | all'),
    });
  });
});
