// Бекап (етап 3 PR-6, 05-ops §бекапи): документ (усі таблиці, KV без кешу
// токена), AES-256-GCM round-trip (чужий ключ - помилка, не сміття), SQL
// відновлення (літерали екрановані, FTS перебудовується, транзакція),
// задача нд 03:00 (Drive-стаб, відбиток у facts, алерти при збої і о 04:00),
// scripts/restore.mjs у dry-run і --local з підміненим wrangler.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  buildBackupDocument,
  encryptBackup,
  decryptBackup,
  restoreSql,
  sha256Hex,
  summarizeBackup,
  BACKUP_TABLES,
  BACKUP_KV_EXCLUDE,
  BACKUP_MAGIC,
} from '../web/core/backup/core.mjs';
import {
  backupTask,
  isQuarterlySunday,
  BACKUP_STATE_KEY,
  BACKUP_FOLDER_PATH,
} from '../web/core/backup/task.mjs';
import { restore, parseArgs } from '../scripts/restore.mjs';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';
import { d1FromSqlite } from './helpers/d1.js';

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
];
const SECRET = 'backup-secret-for-tests-32-chars!!';
// Неділя 06.09.2026 03:10 Києва = 00:10Z; 04:10 = 01:10Z.
const SUNDAY_0310 = Date.parse('2026-09-06T00:10:00.000Z');
const SUNDAY_0410 = Date.parse('2026-09-06T01:10:00.000Z');
const WEDNESDAY = Date.parse('2026-09-02T00:10:00.000Z');

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('документ і крипто', () => {
  it('усі таблиці міграцій (крім FTS і migrations_meta) є в BACKUP_TABLES; KV без googleToken', () => {
    const db = new DatabaseSync(':memory:');
    for (const f of ALL_MIGRATIONS) {
      db.exec(readFileSync(join(__dirname, '..', 'web', 'core', 'migrations', f), 'utf8'));
    }
    const names = (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
        .all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    const real = names.filter((n) => !/_fts(_|$)/.test(n) && n !== 'migrations_meta');
    expect([...BACKUP_TABLES].sort()).toEqual(real.sort());
    const doc = buildBackupDocument({
      createdMs: SUNDAY_0310,
      envName: 'on',
      tables: { facts: [{ id: 'f1' }] },
      kv: { stats: '{"a":1}', googleToken: '{"token":"secret"}' },
    });
    expect(doc.kv).toEqual({ stats: '{"a":1}' });
    expect(BACKUP_KV_EXCLUDE.has('googleToken')).toBe(true);
    expect(doc.d1.facts).toEqual([{ id: 'f1' }]);
    expect(doc.d1.ideas).toEqual([]);
    expect(summarizeBackup(doc)).toMatchObject({ rows: 1, kvKeys: 1, nonEmpty: ['facts=1'] });
  });

  it('encrypt → decrypt round-trip; чужий ключ і чужа магія - явні помилки; короткий ключ - помилка', async () => {
    const doc = buildBackupDocument({
      createdMs: SUNDAY_0310,
      envName: 'on',
      tables: { ideas: [{ id: 'i1', title: "О'Коннор", body_md: null, priority: 2 }] },
      kv: { state: '{}' },
    });
    const bytes = await encryptBackup(SECRET, doc);
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe(BACKUP_MAGIC);
    expect(new TextDecoder().decode(bytes)).not.toContain('Коннор');
    const back = await decryptBackup(SECRET, bytes);
    expect(back).toEqual(doc);
    await expect(decryptBackup('other-secret-that-is-long-enough', bytes)).rejects.toThrow(
      /чужий ключ/,
    );
    await expect(
      decryptBackup(SECRET, new TextEncoder().encode('XXXX' + 'y'.repeat(40))),
    ).rejects.toThrow(/магія/);
    await expect(encryptBackup('short', doc)).rejects.toThrow(/16/);
    expect(await sha256Hex(bytes)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('restoreSql: транзакція, DELETE+INSERT, лапки подвоєні, чужі імена колонок відкинуті, FTS перебудовано', () => {
    const doc = buildBackupDocument({
      createdMs: SUNDAY_0310,
      envName: 'on',
      tables: {
        ideas: [
          {
            id: 'i1',
            title: "О'Коннор; DROP TABLE x",
            priority: 2,
            body_md: null,
            status: 'нова',
            created_at: 'x',
            updated_at: 'x',
          },
          {
            id: 'i2',
            title: 'ok',
            status: 'нова',
            created_at: 'x',
            updated_at: 'x',
            'bad col; --': 'x',
          },
        ],
      },
      kv: {},
    });
    const sql = restoreSql(doc);
    expect(sql.startsWith('BEGIN TRANSACTION;')).toBe(true);
    expect(sql.endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain(
      `INSERT INTO ideas (id, title, priority, body_md, status, created_at, updated_at) VALUES ('i1', 'О''Коннор; DROP TABLE x', 2, NULL, 'нова', 'x', 'x');`,
    );
    expect(sql).toContain(
      `INSERT INTO ideas (id, title, status, created_at, updated_at) VALUES ('i2', 'ok', 'нова', 'x', 'x');`,
    );
    expect(sql).not.toContain('bad col');
    expect(sql).toContain('DELETE FROM ideas_fts;');
    expect(sql).toContain(
      'INSERT INTO ideas_fts (id, title, body_md) SELECT id, title, body_md FROM ideas;',
    );
    expect(sql).toContain('DELETE FROM records_fts;');
    // SQL справді виконується на схемі міграцій: round-trip у sqlite.
    const db = new DatabaseSync(':memory:');
    for (const f of ALL_MIGRATIONS) {
      db.exec(readFileSync(join(__dirname, '..', 'web', 'core', 'migrations', f), 'utf8'));
    }
    db.exec(sql);
    expect((db.prepare('SELECT COUNT(*) AS n FROM ideas').get() as { n: number }).n).toBe(2);
    expect((db.prepare('SELECT COUNT(*) AS n FROM ideas_fts').get() as { n: number }).n).toBe(2);
  });

  it('records_fts після відновлення = тому, що пише код (назва + значення, без ключів JSON)', () => {
    const doc = buildBackupDocument({
      createdMs: SUNDAY_0310,
      envName: 'on',
      tables: {
        collections: [{ id: 'c1', name: 'Сервіси', fields_json: '[]', created_at: 'x' }],
        records: [
          {
            id: 'r1',
            collection_id: 'c1',
            data_json: JSON.stringify({ назва: 'Spotify', ціна_міс: 4.99 }),
            created_at: 'x',
            updated_at: 'x',
          },
        ],
      },
      kv: {},
    });
    const sql = restoreSql(doc);
    expect(sql).toContain(
      `INSERT INTO records_fts (id, data_text) VALUES ('r1', 'Сервіси Spotify 4.99');`,
    );
    expect(sql).not.toContain('data_json FROM records');
  });
});

describe('задача backup (нд 03:00)', () => {
  /** Drive-стаб: теки шукаються/створюються, файл завантажується. */
  function driveStub() {
    const uploads: { name: string; size: number }[] = [];
    const created: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        if (u.includes('api.telegram.org')) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
            status: 200,
          });
        }
        if (u.startsWith('https://www.googleapis.com/upload/drive/v3/files')) {
          const form = init?.body as FormData;
          const file = form.get('file') as Blob;
          const meta = JSON.parse(await (form.get('metadata') as Blob).text()) as { name: string };
          uploads.push({ name: meta.name, size: file.size });
          return new Response(JSON.stringify({ id: 'file-1', name: meta.name, size: file.size }), {
            status: 200,
          });
        }
        if (
          u.startsWith('https://www.googleapis.com/drive/v3/files?') &&
          (!init || init.method !== 'POST')
        ) {
          return new Response(JSON.stringify({ files: [] }), { status: 200 });
        }
        if (u.startsWith('https://www.googleapis.com/drive/v3/files') && init?.method === 'POST') {
          const body = JSON.parse(String(init.body)) as { name: string };
          created.push(body.name);
          return new Response(JSON.stringify({ id: `folder-${created.length}` }), { status: 200 });
        }
        throw new Error(`несподіваний fetch: ${u}`);
      }),
    );
    return { uploads, created };
  }

  function taskEnv(over: Record<string, unknown> = {}) {
    const d1 = d1FromSqlite(ALL_MIGRATIONS);
    d1.db
      .prepare(
        `INSERT INTO ideas (id, title, status, created_at, updated_at) VALUES ('i1', 'Ідея', 'нова', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`,
      )
      .run();
    const kv = new Map<string, string>([
      ['stats', '{"days":{}}'],
      ['googleToken', JSON.stringify({ token: 'tok', expMs: Date.now() + 3_600_000 })],
    ]);
    const env = workerEnv({
      DB: d1.stub,
      BRIEFING: memoryKv(kv, { listKeys: () => [...kv.keys()] }),
      BACKUP_ENC_KEY: SECRET,
      GOOGLE_CLIENT_ID: 'c',
      GOOGLE_CLIENT_SECRET: 's',
      GOOGLE_REFRESH_TOKEN: 'r',
      TELEGRAM_CHAT_ID: '555',
      TELEGRAM_BOT_TOKEN: 'tok',
      TOPIC_SYSTEM: '7',
      ASSISTANT_V2: 'on',
      ...over,
    });
    return { env, d1, kv };
  }

  it('не неділя / до 03:00 - пропуск', async () => {
    const { env } = taskEnv();
    expect(await backupTask(env, WEDNESDAY)).toEqual({ skipped: 'not-sunday' });
    expect(await backupTask(env, SUNDAY_0310 - 3_600_000)).toEqual({ skipped: 'hour' });
  });

  it('03:10: знімок → шифр → Drive (теки створено) → відбиток у facts; KV без googleToken; повтор того дня - done', async () => {
    const { uploads, created } = driveStub();
    const { env, d1, kv } = taskEnv();
    const out = await backupTask(env, SUNDAY_0310);
    expect(out).toMatchObject({ done: true, driveId: 'file-1', rows: 1 });
    expect(created).toEqual(BACKUP_FOLDER_PATH);
    expect(uploads[0]?.name).toBe('svitanok-2026-09-06.enc');
    const fact = d1.db
      .prepare(`SELECT value_json FROM facts WHERE kind = 'setting' AND key = 'last_backup'`)
      .get() as {
      value_json: string;
    };
    const value = JSON.parse(fact.value_json) as { date: string; sha256: string; kvKeys: number };
    expect(value.date).toBe('2026-09-06');
    expect(value.sha256).toMatch(/^[0-9a-f]{64}$/);
    // stats так, googleToken - ні.
    expect(value.kvKeys).toBe(1);
    expect(JSON.parse(kv.get(BACKUP_STATE_KEY) ?? '{}')).toMatchObject({ done: true, attempts: 1 });
    expect(await backupTask(env, SUNDAY_0310 + 60_000)).toEqual({ skipped: 'done' });
    // Тиша при успіху: жодного повідомлення в TOPIC_SYSTEM (06.09 - не 13-й тиждень).
    expect((d1.db.prepare('SELECT COUNT(*) AS n FROM outbox').get() as { n: number }).n).toBe(0);
  });

  it('збій Drive: алерт одразу, спроба рахується; о 04:10 без файлу - алерт «не зроблено» один раз', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes('api.telegram.org')) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
            status: 200,
          });
        }
        return new Response('boom', { status: 500 });
      }),
    );
    const { env, d1, kv } = taskEnv();
    expect(await backupTask(env, SUNDAY_0310)).toEqual({ failed: true, attempts: 1 });
    const texts = () =>
      (d1.db.prepare('SELECT payload_json FROM outbox').all() as { payload_json: string }[]).map(
        (r) => JSON.parse(r.payload_json).text as string,
      );
    expect(texts().some((t) => t.includes('спроба 1 впала'))).toBe(true);
    expect(JSON.parse(kv.get(BACKUP_STATE_KEY) ?? '{}')).toMatchObject({
      done: false,
      attempts: 1,
    });
    expect(await backupTask(env, SUNDAY_0410)).toEqual({ alertedMissing: true });
    expect(texts().some((t) => t.includes('не зроблено'))).toBe(true);
    expect(await backupTask(env, SUNDAY_0410 + 60_000)).toEqual({ skipped: 'missed' });
  });

  it('без BACKUP_ENC_KEY - збій із назвою змінної, не тихий бекап відкритим текстом', async () => {
    driveStub();
    const { env, d1 } = taskEnv({ BACKUP_ENC_KEY: undefined });
    expect(await backupTask(env, SUNDAY_0310)).toMatchObject({ failed: true });
    const texts = (
      d1.db.prepare('SELECT payload_json FROM outbox').all() as { payload_json: string }[]
    ).map((r) => JSON.parse(r.payload_json).text as string);
    expect(texts.some((t) => t.includes('BACKUP_ENC_KEY'))).toBe(true);
  });

  it('KV читається сторінками (list_complete=false + cursor): жоден ключ не губиться', async () => {
    driveStub();
    const { env, d1 } = taskEnv();
    const pages = [
      { keys: [{ name: 'stats' }], list_complete: false, cursor: 'c1' },
      { keys: [{ name: 'levers' }, { name: 'googleToken' }], list_complete: true },
    ];
    const values: Record<string, string> = {
      stats: '{"s":1}',
      levers: '{"l":1}',
      // Свіжий кеш токена - інакше адаптер Drive пішов би по refresh-грант.
      googleToken: JSON.stringify({ token: 't', expMs: Date.now() + 3_600_000 }),
    };
    let calls = 0;
    env.BRIEFING = {
      list: async (opts: { cursor?: string }) => pages[opts?.cursor ? 1 : 0],
      get: async (k: string) => {
        calls += 1;
        return values[k] ?? null;
      },
      put: async () => {},
      delete: async () => {},
    } as unknown as Env['BRIEFING'];
    expect(await backupTask(env, SUNDAY_0310)).toMatchObject({ done: true, kvKeys: 2 });
    expect(calls).toBeGreaterThanOrEqual(3);
    const fact = d1.db.prepare(`SELECT value_json FROM facts WHERE key = 'last_backup'`).get() as {
      value_json: string;
    };
    expect(JSON.parse(fact.value_json).kvKeys).toBe(2);
  });

  it('isQuarterlySunday: 13-й, 26-й, 39-й, 52-й ISO-тижні', () => {
    expect(isQuarterlySunday('2026-09-06')).toBe(false); // тиждень 36
    expect(isQuarterlySunday('2026-09-27')).toBe(true); // тиждень 39
    expect(isQuarterlySunday('2026-03-29')).toBe(true); // тиждень 13
  });
});

describe('scripts/restore.mjs', () => {
  it('parseArgs; dry-run лише читає; --local збирає SQL і кличе wrangler; без прапорців - зупинка', async () => {
    expect(parseArgs(['--file', 'a.enc', '--dry-run'])).toMatchObject({
      file: 'a.enc',
      dryRun: true,
    });
    const doc = buildBackupDocument({
      createdMs: SUNDAY_0310,
      envName: 'on',
      tables: {
        facts: [
          {
            id: 'f1',
            kind: 'setting',
            key: 'k',
            value_json: '1',
            source: 'owner',
            confidence: null,
            created_at: 'x',
            updated_at: 'x',
          },
        ],
      },
      kv: { stats: '{}' },
    });
    const dir = mkdtempSync(join(tmpdir(), 'svitanok-restore-'));
    const file = join(dir, 'svitanok-2026-09-06.enc');
    writeFileSync(file, await encryptBackup(SECRET, doc));
    const logs: string[] = [];
    const dry = await restore(parseArgs(['--file', file, '--dry-run']), {
      secret: SECRET,
      outDir: dir,
      log: (s) => logs.push(s),
    });
    expect(dry).toMatchObject({ mode: 'dry-run', summary: { rows: 1, kvKeys: 1 } });
    expect(logs.join('\n')).toContain('facts=1');

    await expect(
      restore(parseArgs(['--file', file]), { secret: SECRET, outDir: dir, log: () => {} }),
    ).rejects.toThrow(/--local або --remote --apply/);
    await expect(
      restore(parseArgs(['--file', file, '--dry-run']), {
        secret: undefined,
        outDir: dir,
        log: () => {},
      }),
    ).rejects.toThrow(/BACKUP_ENC_KEY/);

    const calls: string[][] = [];
    const local = await restore(parseArgs(['--file', file, '--local']), {
      secret: SECRET,
      outDir: dir,
      exec: (cmd) => {
        calls.push(cmd);
        return 0;
      },
      log: () => {},
    });
    expect(local.mode).toBe('--local');
    expect(calls[0]).toEqual(
      expect.arrayContaining(['wrangler', 'd1', 'execute', 'svitanok', '--local', '--file']),
    );
    expect(readFileSync(String(local.sqlPath), 'utf8')).toContain(
      "INSERT INTO facts (id, kind, key, value_json, source, confidence, created_at, updated_at) VALUES ('f1', 'setting', 'k', '1', 'owner', NULL, 'x', 'x');",
    );
    expect(JSON.parse(readFileSync(String(local.kvPath), 'utf8'))).toEqual({ stats: '{}' });
    // Бойова D1 - лише з явним --apply.
    await expect(
      restore(parseArgs(['--file', file, '--remote']), {
        secret: SECRET,
        outDir: dir,
        exec: () => 0,
        log: () => {},
      }),
    ).rejects.toThrow(/--apply/);
    rmSync(dir, { recursive: true, force: true });
  });
});
