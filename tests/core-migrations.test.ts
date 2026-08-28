// Звірка міграцій D1 (web/core/migrations) з канонічною схемою final/07-schema §1.
//
// Міграції ганяються в node:sqlite — той самий діалект, що й D1 (SQLite з FTS5;
// проба на віддаленій D1 пройдена 26.08.2026). Тест тримає ОЧІКУВАНУ схему як
// дані: розбіжність між SQL-файлом і 07 §1 (загублена колонка, зайва, інша
// назва) валить тест із назвою таблиці в повідомленні. Це контракт-тест етапу 1:
// решта PR-ів етапу пише код проти цих імен.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, expect, beforeAll } from 'vitest';

const MIGRATIONS_DIR = join(__dirname, '..', 'web', 'core', 'migrations');

/** Очікувані колонки звичайних таблиць — дослівно з 07-schema §1. */
const EXPECTED_COLUMNS: Record<string, string[]> = {
  facts: ['id', 'kind', 'key', 'value_json', 'source', 'confidence', 'created_at', 'updated_at'],
  sessions: [
    'thread_id',
    'sdk_session_id',
    'started_at',
    'last_at',
    'tainted',
    'summary_md',
    'turn_count',
  ],
  memory_chunks: ['id', 'thread_id', 'at', 'text', 'vector_id'],
  migrations_meta: ['name', 'applied_at'],
  voice_pending: [
    'id',
    'kind',
    'text',
    'file_id',
    'duration_s',
    'chat_id',
    'thread_id',
    'created_at',
    'claimed_at',
  ],
  reminders: ['id', 'due_at', 'text', 'chain_id', 'status', 'snooze_count', 'source_msg_id'],
  proposals: [
    'id',
    'level',
    'kind',
    'payload_json',
    'thread_id',
    'msg_id',
    'word',
    'expires_at',
    'status',
    'created_at',
    'decided_at',
  ],
  chains: ['id', 'kind', 'workflow_id', 'state_json', 'status', 'created_at', 'updated_at'],
  outbox: ['id', 'chat_id', 'thread_id', 'kind', 'payload_json', 'attempts', 'next_at', 'status'],
  runs: [
    'id',
    'trigger',
    'profile',
    'thread_id',
    'model',
    'started_at',
    'finished_at',
    'duration_ms',
    'tokens_in',
    'tokens_out',
    'cache_read',
    'steps',
    'tools_json',
    'error',
    'cost_note',
  ],
  run_steps: ['id', 'run_id', 'n', 'at', 'kind', 'name', 'ms', 'ok', 'note'],
  quota_counters: ['key', 'period', 'value', 'limit_value', 'updated_at'],
  places: [
    'place_id',
    'name',
    'address',
    'lat',
    'lon',
    'phone',
    'site',
    'hours_json',
    'maps_uri',
    'rating_owner',
    'is_favorite',
    'visits',
    'fetched_at',
  ],
  ideas: [
    'id',
    'title',
    'body_md',
    'domain',
    'status',
    'priority',
    'effort',
    'next_action',
    'tags_json',
    'analysis_md',
    'plan_md',
    'plan_approved_at',
    'repo',
    'head_sha',
    'artifact_drive_id',
    'source_msg_id',
    'created_at',
    'updated_at',
  ],
  idea_events: ['id', 'idea_id', 'at', 'kind', 'note'],
  wishes: ['id', 'type', 'title', 'payload_json', 'status', 'created_at'],
  price_points: ['id', 'wish_id', 'at', 'source', 'price', 'currency', 'url', 'is_low'],
  trips: [
    'id',
    'wish_id',
    'from_city',
    'to_text',
    'country',
    'date_from',
    'date_to',
    'mode',
    'vehicle_key',
    'checklist_key',
    'cost_json',
    'checklist_state_json',
    'workflow_id',
    'status',
  ],
  transactions: [
    'id',
    'at',
    'amount',
    'currency',
    'amount_uah',
    'mcc',
    'description',
    'category',
    'flags_json',
    'balance',
    'note',
    'raw_json',
  ],
  subscriptions: [
    'id',
    'merchant',
    'period',
    'amount',
    'currency',
    'next_at',
    'last_tx_id',
    'status',
    'created_at',
  ],
  merchant_rules: ['id', 'pattern', 'category', 'is_subscription', 'note'],
  inbox_messages: [
    'id',
    'chat_id',
    'chat_title',
    'from_name',
    'from_id',
    'at',
    'text',
    'media_kind',
    'reply_to',
    'tainted',
  ],
  inbox_digests: ['id', 'chat_ids_json', 'period_from', 'period_to', 'text_md', 'created_at'],
  collections: ['id', 'name', 'description', 'fields_json', 'sort_by', 'created_at'],
  records: ['id', 'collection_id', 'data_json', 'created_at', 'updated_at'],
  instructions: ['name', 'kind', 'version_hash', 'body_md', 'max_chars', 'deployed_at'],
  instruction_history: ['name', 'version_hash', 'body_md', 'deployed_at'],
  reports: ['id', 'kind', 'period_from', 'period_to', 'text_md', 'instruction_hash', 'created_at'],
  style_corpus: ['id', 'msg_id', 'at', 'text', 'kind', 'approved'],
  day_plans: [
    'date',
    'status',
    'intent_text',
    'fill_ratio',
    'workflow_id',
    'created_at',
    'reviewed_at',
  ],
  plan_items: [
    'id',
    'date',
    'title',
    'kind',
    'est_min',
    'hard_at',
    'deadline',
    'place',
    'flexible',
    'priority',
    'window_start',
    'window_end',
    'status',
    'done_at',
    'reminder_id',
    'event_id',
    'carried_from',
  ],
};

/**
 * Первинні ключі, що відрізняються від конвенційного `id` (07 §1). Таблиця,
 * якої тут немає, зобовʼязана мати PK рівно `['id']` — перевіряється для всіх.
 */
const EXPECTED_PK: Record<string, string[]> = {
  sessions: ['thread_id'],
  places: ['place_id'],
  instructions: ['name'],
  // Append-only журнал без власного ключа — лише rowid.
  instruction_history: [],
  migrations_meta: ['name'],
  day_plans: ['date'],
  // Рядок на місяць — інакше ретенція «12 міс» із 07 §1 недосяжна.
  quota_counters: ['key', 'period'],
};

type IndexSpec = { cols: string[]; unique?: boolean };

/**
 * Індекси — дослівно колонка «Індекси» 07 §1, включно з UNIQUE-константами
 * (вони теж індекси, origin 'u'). Таблиця, якої тут немає, зобовʼязана не мати
 * жодного індексу поза PK — звірка точна, зайвий індекс теж провалює тест.
 */
const EXPECTED_INDEXES: Record<string, IndexSpec[]> = {
  facts: [{ cols: ['kind', 'key'], unique: true }],
  memory_chunks: [{ cols: ['thread_id', 'at'] }],
  reminders: [{ cols: ['status', 'due_at'] }],
  proposals: [{ cols: ['status', 'expires_at'] }],
  chains: [{ cols: ['status'] }],
  outbox: [{ cols: ['status', 'next_at'] }],
  runs: [{ cols: ['started_at'] }, { cols: ['profile'] }],
  run_steps: [{ cols: ['run_id', 'n'] }],
  places: [{ cols: ['name'] }],
  ideas: [{ cols: ['status'] }, { cols: ['domain'] }],
  idea_events: [{ cols: ['idea_id', 'at'] }],
  wishes: [{ cols: ['type', 'status'] }],
  price_points: [{ cols: ['wish_id', 'at'] }],
  trips: [{ cols: ['date_from'] }],
  transactions: [{ cols: ['at'] }, { cols: ['category'] }],
  subscriptions: [{ cols: ['next_at'] }],
  inbox_messages: [{ cols: ['chat_id', 'at'] }],
  inbox_digests: [{ cols: ['created_at'] }],
  collections: [{ cols: ['name'], unique: true }],
  records: [{ cols: ['collection_id', 'created_at'] }],
  reports: [{ cols: ['kind', 'created_at'] }],
  style_corpus: [{ cols: ['at'] }],
  // Понад 07 §1 (там «-»): пошук історії за імʼям — єдиний спосіб її читати.
  instruction_history: [{ cols: ['name', 'deployed_at'] }],
  plan_items: [{ cols: ['date'] }, { cols: ['status'] }],
  // Прибирання протухлих (lazy expiry + чистка при вставці) шукає за часом.
  voice_pending: [{ cols: ['created_at'] }],
};

/** FTS5-таблиці: перша колонка — місток id (UNINDEXED). */
const EXPECTED_FTS: Record<string, string[]> = {
  ideas_fts: ['id', 'title', 'body_md'],
  inbox_fts: ['id', 'text'],
  records_fts: ['id', 'data_text'],
};

let db: DatabaseSync;
let files: string[] = [];

beforeAll(() => {
  db = new DatabaseSync(':memory:');
  files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const f of files) db.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
});

// Внутрішні таблиці (sqlite_*) і тіні FTS5 (ideas_fts_data, …_idx, …_content,
// …_docsize, …_config — створює сам модуль) не належать контракту.
const tableNames = (): string[] =>
  (
    db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
      )
      .all() as { name: string }[]
  )
    .map((r) => r.name)
    .filter((n) => !/_fts_(data|idx|content|docsize|config)$/.test(n));

const columnsOf = (table: string): { name: string; pk: number }[] =>
  db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as {
    name: string;
    pk: number;
  }[];

describe('міграції D1 — файли', () => {
  it('девʼять файлів 0001–0009, нумерація без дірок', () => {
    expect(files.map((f) => f.slice(0, 4))).toEqual([
      '0001',
      '0002',
      '0003',
      '0004',
      '0005',
      '0006',
      '0007',
      '0008',
      '0009',
    ]);
  });
});

describe('міграції D1 — таблиці за 07-schema §1', () => {
  it('перелік таблиць повний і без зайвих', () => {
    const expected = new Set([...Object.keys(EXPECTED_COLUMNS), ...Object.keys(EXPECTED_FTS)]);
    expect(new Set(tableNames())).toEqual(expected);
  });

  for (const [table, cols] of Object.entries(EXPECTED_COLUMNS)) {
    it(`${table}: колонки як у 07 §1`, () => {
      expect(columnsOf(table).map((c) => c.name)).toEqual(cols);
    });
  }

  for (const [table, cols] of Object.entries(EXPECTED_FTS)) {
    it(`${table}: FTS5-колонки`, () => {
      expect(columnsOf(table).map((c) => c.name)).toEqual(cols);
    });
  }

  for (const table of Object.keys(EXPECTED_COLUMNS)) {
    const pk = EXPECTED_PK[table] ?? ['id'];
    it(`${table}: первинний ключ (${pk.join(', ') || 'rowid'})`, () => {
      const actual = columnsOf(table)
        .filter((c) => c.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => c.name);
      expect(actual).toEqual(pk);
    });
  }
});

describe('міграції D1 — індекси за 07-schema §1', () => {
  // Ключ порівняння: "unique|col1,col2". Порядок у списку не значущий — множини.
  const keyOf = (s: IndexSpec) => `${s.unique ? 'U' : '-'}|${s.cols.join(',')}`;

  for (const table of Object.keys(EXPECTED_COLUMNS)) {
    const specs = EXPECTED_INDEXES[table] ?? [];
    it(`${table}: ${specs.map((s) => `(${s.cols.join(',')}${s.unique ? ' U' : ''})`).join(' ') || 'без індексів'}`, () => {
      const list = db.prepare(`PRAGMA index_list(${JSON.stringify(table)})`).all() as {
        name: string;
        unique: number;
        origin: string; // 'c' — CREATE INDEX, 'u' — UNIQUE, 'pk' — первинний ключ
      }[];
      const actual = list
        .filter((ix) => ix.origin !== 'pk')
        .map((ix) => ({
          cols: (
            db.prepare(`PRAGMA index_info(${JSON.stringify(ix.name)})`).all() as {
              name: string;
            }[]
          ).map((c) => c.name),
          unique: ix.unique === 1,
        }));
      // Точна звірка в обидва боки: загублений індекс І зайвий — обидва дефекти.
      expect(new Set(actual.map(keyOf))).toEqual(new Set(specs.map(keyOf)));
    });
  }
});

describe('міграції D1 — FTS5 працює з українською', () => {
  it('MATCH знаходить слово, вставлене в ideas_fts', () => {
    db.exec(`INSERT INTO ideas_fts (id, title, body_md) VALUES ('01X', 'Світанок', 'тест')`);
    const row = db.prepare(`SELECT id FROM ideas_fts WHERE ideas_fts MATCH 'світанок'`).get() as {
      id: string;
    };
    expect(row.id).toBe('01X');
  });
});
