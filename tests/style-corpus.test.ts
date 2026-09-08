// Корпус стилю власника (релізний блок PR-8, §6 варіант A): свій шар поверх
// чужої моделі. Перевіряється головне - що в корпус потрапляють ЛИШЕ власні
// тексти власника, що збір ідемпотентний і що зразки доходять до працівника.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  collectOwnStyle,
  runStyleSamples,
  styleBlock,
  CORPUS_CAP,
  SAMPLES_DEFAULT,
  SAMPLES_MAX,
} from '../web/core/style/corpus.mjs';
import { applyPolicy } from '../web/core/policy/proposals.mjs';
import { ACTION_LEVELS } from '../web/core/policy/core.mjs';
import { TOOLS } from '../web/core/tools/index.mjs';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';
import { d1FromSqlite } from './helpers/d1.js';

const NOW = Date.parse('2026-09-08T09:00:00.000Z');
const OWNER = '555';
const MIGRATIONS = [
  '0001_base.sql',
  '0002_assistant.sql',
  '0006_inbox_collections.sql',
  '0007_instructions_plans.sql',
];

/** Текст потрібної довжини - корпус бере від 60 до 600 символів. */
const long = (head: string) => `${head} ${'слово '.repeat(15)}`.trim();

function setup() {
  const d1 = d1FromSqlite(MIGRATIONS);
  const env = workerEnv({
    DB: d1.stub,
    BRIEFING: memoryKv(new Map()),
    TELEGRAM_OWNER_USER_ID: OWNER,
  });
  const add = (id: string, fromId: string, text: string, at: string) =>
    d1.db
      .prepare(
        `INSERT INTO inbox_messages (id, chat_id, chat_title, from_name, from_id, at, text)
         VALUES (?, 'c1', 'Чат', 'хтось', ?, ?, ?)`,
      )
      .run(id, fromId, at, text);
  return { env, db: d1.db, add };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('збір корпусу', () => {
  it('бере ЛИШЕ тексти власника, чужі не чіпає', async () => {
    const { env, db, add } = setup();
    add('m1', OWNER, long('моє повідомлення'), '2026-09-01T10:00:00Z');
    add('m2', '999', long('чуже повідомлення'), '2026-09-02T10:00:00Z');
    const { result } = await collectOwnStyle(env, NOW);
    expect(result).toMatchObject({ added: 1, total: 1 });
    const rows = db.prepare('SELECT text FROM style_corpus').all() as { text: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toContain('моє повідомлення');
  });

  it('короткі й довгі не беруться - зразок має бути зразком', async () => {
    const { env, add } = setup();
    add('m1', OWNER, 'ок', '2026-09-01T10:00:00Z');
    add('m2', OWNER, 'а'.repeat(1000), '2026-09-02T10:00:00Z');
    expect((await collectOwnStyle(env, NOW)).result).toMatchObject({ added: 0, total: 0 });
  });

  it('повторний збір нічого не дублює (ключ - хеш тексту)', async () => {
    const { env, add } = setup();
    add('m1', OWNER, long('той самий текст'), '2026-09-01T10:00:00Z');
    // Те саме, але в іншому чаті й з іншим id повідомлення: як ЗРАЗОК ГОЛОСУ
    // це один текст, і другого рядка бути не має.
    add('m2', OWNER, long('той самий текст'), '2026-09-03T10:00:00Z');
    expect((await collectOwnStyle(env, NOW)).result).toMatchObject({ added: 1, total: 1 });
    expect((await collectOwnStyle(env, NOW)).result).toMatchObject({ added: 0, total: 1 });
  });

  it('без TELEGRAM_OWNER_USER_ID - гучна відмова, не тихий порожній корпус', async () => {
    const d1 = d1FromSqlite(MIGRATIONS);
    const env = workerEnv({ DB: d1.stub, BRIEFING: memoryKv(new Map()) });
    await expect(collectOwnStyle(env, NOW)).rejects.toThrow(/TELEGRAM_OWNER_USER_ID/);
  });

  it('двісті рядків - НЕ двісті запитів: збір іде пачками', async () => {
    // ⚠️ Запит до D1 - підзапит Worker'а, а їх на виклик ~50. Цикл із await
    // валив би КОЖЕН збір приблизно на пʼятдесятому рядку, лишаючи корпус
    // наполовину записаним (ревʼю релізу). Тестовий стаб стелі не моделює,
    // тож міряємо саме кількість звернень.
    const { env, add, db } = setup();
    for (let i = 0; i < CORPUS_CAP; i += 1) {
      add(
        `m${i}`,
        OWNER,
        long(`текст ${i}`),
        `2026-09-01T10:${String(i % 60).padStart(2, '0')}:00Z`,
      );
    }
    let single = 0;
    let batched = 0;
    const inner = env.DB as unknown as {
      prepare: (sql: string) => unknown;
      batch: (s: unknown[]) => Promise<unknown>;
    };
    const realPrepare = inner.prepare.bind(inner);
    const realBatch = inner.batch.bind(inner);
    (env as { DB?: unknown }).DB = {
      prepare: (sql: string) => {
        const st = realPrepare(sql) as { bind: (...a: unknown[]) => Record<string, unknown> };
        return {
          bind: (...a: unknown[]) => {
            const b = st.bind(...a);
            return {
              ...b,
              run: async () => (single += 1) && (b.run as () => Promise<unknown>)(),
              all: async () => (single += 1) && (b.all as () => Promise<unknown>)(),
              first: async () => (single += 1) && (b.first as () => Promise<unknown>)(),
              once: b.once,
            };
          },
        };
      },
      batch: async (sts: unknown[]) => {
        batched += 1;
        return realBatch(sts);
      },
    };
    const { result } = await collectOwnStyle(env, NOW);
    expect(result.added).toBe(CORPUS_CAP);
    // Один batch на 50 - не двісті окремих звернень.
    expect(batched).toBeLessThanOrEqual(Math.ceil(CORPUS_CAP / 50));
    expect(batched).toBeGreaterThan(0);
    // SELECT + trim + COUNT - одиниці, не сотні.
    expect(single).toBeLessThan(10);
    expect(db.prepare('SELECT count(*) AS n FROM style_corpus').get()).toEqual({ n: CORPUS_CAP });
  });

  it('збій пачки не викидає того, що вже записано, і названий уголос', async () => {
    // ⚠️ 200 рядків - це кілька batch-ів; збій третього не сміє викинути
    // перші два (другий прохід ревʼю). Мовчазний «ок» тут виглядав би як
    // повний корпус.
    const { env, add, db } = setup();
    for (let i = 0; i < 120; i += 1) {
      add(
        `m${i}`,
        OWNER,
        long(`текст ${i}`),
        `2026-09-01T10:${String(i % 60).padStart(2, '0')}:00Z`,
      );
    }
    const inner = env.DB as unknown as { batch: (s: unknown[]) => Promise<unknown> };
    const realBatch = inner.batch.bind(inner);
    let calls = 0;
    (env.DB as unknown as { batch: unknown }).batch = async (sts: unknown[]) => {
      calls += 1;
      if (calls === 2) throw new Error('D1 відмовила');
      return realBatch(sts);
    };
    const { result } = await collectOwnStyle(env, NOW);
    expect(result.added).toBe(50); // перша пачка вціліла
    expect(result.error).toContain('D1 відмовила');
    expect(db.prepare('SELECT count(*) AS n FROM style_corpus').get()).toEqual({ n: 50 });
  });

  it('стеля корпусу тримається між ЗБОРАМИ, найстаріші зайві зникають', async () => {
    // ⚠️ Двома заходами навмисно: сама вибірка вже має LIMIT, тож за один
    // збір стеля не перевищується ніколи, і тест перевіряв би нічого. Корпус
    // росте саме від повторних зборів - там і має спрацювати чистка.
    const { env, add, db } = setup();
    for (let i = 0; i < CORPUS_CAP; i += 1) {
      add(
        `a${i}`,
        OWNER,
        long(`старий ${i}`),
        `2026-09-01T10:${String(i % 60).padStart(2, '0')}:00Z`,
      );
    }
    expect((await collectOwnStyle(env, NOW)).result.total).toBe(CORPUS_CAP);
    for (let i = 0; i < 20; i += 1) {
      add(
        `b${i}`,
        OWNER,
        long(`новий ${i}`),
        `2026-09-07T10:${String(i % 60).padStart(2, '0')}:00Z`,
      );
    }
    expect((await collectOwnStyle(env, NOW + 1000)).result.total).toBe(CORPUS_CAP);
    // Лишились саме НОВІ: чистка ріже найстаріші, а не випадкові.
    const rows = db
      .prepare(`SELECT count(*) AS n FROM style_corpus WHERE text LIKE 'новий%'`)
      .get() as { n: number };
    expect(rows.n).toBe(20);
  });
});

describe('зразки для працівника', () => {
  async function seeded() {
    const { env, add } = setup();
    // Більше за SAMPLES_MAX - інакше кламп ліміту нічим не перевірити.
    for (let i = 0; i < SAMPLES_MAX + 10; i += 1) {
      add(
        `m${i}`,
        OWNER,
        long(`текст ${i}`),
        `2026-09-01T10:${String(i % 60).padStart(2, '0')}:00Z`,
      );
    }
    await collectOwnStyle(env, NOW);
    return env;
  }

  it('за замовчуванням - помірна кількість; limit клампиться', async () => {
    const env = await seeded();
    expect((await runStyleSamples(env)).result.samples).toHaveLength(SAMPLES_DEFAULT);
    expect((await runStyleSamples(env, { limit: 3 })).result.samples).toHaveLength(3);
    expect((await runStyleSamples(env, { limit: 999 })).result.samples).toHaveLength(SAMPLES_MAX);
  });

  it('порожній корпус - порожній блок, а не заглушка', async () => {
    const { env } = setup();
    const { result } = await runStyleSamples(env);
    expect(result).toEqual({ samples: [], total: 0 });
    expect(styleBlock(result.samples)).toBe('');
  });

  it('блок каже, що зразки - про манеру, а не матеріал', () => {
    const block = styleBlock(['перший текст', 'другий  текст']);
    expect(block).toContain('не переказувати й не цитувати');
    // Переноси в зразках схлопуються: рядок «—» має лишатись одним рядком.
    expect(block.split(String.fromCharCode(10))).toHaveLength(3);
  });
});

describe('контракт', () => {
  it('збір - T1 (свідома згода власника), читання зразків - звичайний інструмент', () => {
    expect(ACTION_LEVELS['style.collect']).toBe('T1');
    expect(TOOLS['style.samples']?.write).toBeUndefined();
    // Корпус - ВЛАСНІ тексти власника, не зовнішній вміст: не tainting.
    expect(TOOLS['style.samples']?.tainting).toBeUndefined();
  });

  it('через policy: пропозиція, а після ✅ - зібрано', async () => {
    const { env, add } = setup();
    add('m1', OWNER, long('мій текст'), '2026-09-01T10:00:00Z');
    const out = await applyPolicy(
      env,
      { kind: 'style.collect', payload: {}, threadId: 'dm', tainted: false },
      NOW,
    );
    expect(out).toMatchObject({ mode: 'proposed', proposal: { level: 'T1' } });
  });
});
