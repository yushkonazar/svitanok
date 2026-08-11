import { describe, it, expect } from 'vitest';
// Namespace-імпорт (не список): prettier переносить довгий список на кілька
// рядків, і однорядковий @ts-expect-error відʼїжджає від рядка з помилкою —
// директива стає «невикористаною», а помилка типів лишається.
// @ts-expect-error — JS-модуль Worker'а без типів
import * as stats from '../web/stats-core.mjs';
const { emptyStore, recordEvent, aggregateStats, pageSaved, SAVED_CAP, DAYS_CAP } = stats;

// Повний архів збереженого (роадмеп v3, F3).
//
// Скарга роадмепу: «savedList обрізаний топ-8». Аудит показав, що архів у KV
// НІКОЛИ не обрізався — обрізав лише READ в aggregateStats, тобто дані були,
// їх просто не показували. Тож pageSaved не потребує ні міграції, ні сховища.

interface Page {
  items: Array<{ kind: string; id: string | null; title: string; url: string | null; ts: string }>;
  total: number;
}
const page = (s: unknown, o?: Record<string, unknown>) => pageSaved(s, o) as Page;

/** Зберегти n новин (новіші — перші, бо saved наповнюється unshift). */
const seed = (n: number) => {
  let s = emptyStore();
  for (let i = 0; i < n; i++) {
    s = recordEvent(
      s,
      { type: 'save_news', url: `https://e.com/${i}`, title: `Новина ${i}`, category: 'Тех' },
      '2026-07-07',
    );
  }
  return s;
};

describe('F3 — сторінки збереженого', () => {
  it('archive у сторі НЕ обрізаний: /api/stats дає прев’ю 8, лічильник — правду', () => {
    const st = aggregateStats(seed(30), '2026-07-07');
    expect(st.savedList).toHaveLength(8); // прев'ю
    expect(st.savedCount).toBe(30); // а насправді збережено 30
  });

  it('pageSaved віддає повний архів сторінками, новіші перші', () => {
    const s = seed(30);
    const p1 = page(s, { offset: 0, limit: 20 });
    expect(p1.items).toHaveLength(20);
    expect(p1.total).toBe(30);
    expect(p1.items[0]!.title).toBe('Новина 29'); // найсвіжіша

    const p2 = page(s, { offset: 20, limit: 20 });
    expect(p2.items).toHaveLength(10); // хвіст
    expect(p2.items.at(-1)!.title).toBe('Новина 0'); // найстаріша
    expect(p2.total).toBe(30);
  });

  it('сторінки не перетинаються й покривають усе', () => {
    const s = seed(25);
    const all = [
      ...page(s, { offset: 0, limit: 10 }).items,
      ...page(s, { offset: 10, limit: 10 }).items,
      ...page(s, { offset: 20, limit: 10 }).items,
    ];
    expect(all).toHaveLength(25);
    expect(new Set(all.map((x) => x.id)).size).toBe(25);
  });

  it('limit клампиться зверху — ?limit=100000 не тягне блоб одним махом', () => {
    expect(page(seed(80), { offset: 0, limit: 100000 }).items).toHaveLength(50);
  });

  it('сміття в параметрах -> дефолти, а не краш', () => {
    const s = seed(30);
    for (const bad of [null, undefined, 'abc', NaN, -5, {}]) {
      const p = page(s, { offset: bad, limit: bad });
      expect(p.items.length).toBeGreaterThan(0);
      expect(p.total).toBe(30);
    }
    expect(page(s).items).toHaveLength(20); // дефолт limit
  });

  it('offset за межами -> порожня сторінка, total чесний', () => {
    const p = page(seed(5), { offset: 100, limit: 20 });
    expect(p.items).toEqual([]);
    expect(p.total).toBe(5);
  });

  it('порожній/битий стор не валить', () => {
    expect(page(emptyStore())).toEqual({ items: [], total: 0 });
    expect(page(null)).toEqual({ items: [], total: 0 });
  });

  it('форма запису — та сама, що у прев’ю /api/stats', () => {
    const s = seed(1);
    const fromPage = page(s).items[0]!;
    const fromStats = aggregateStats(s, '2026-07-07').savedList[0];
    expect(fromPage).toEqual(fromStats);
  });

  it('знятий 🔖 зникає й з архіву', () => {
    let s = seed(3);
    s = recordEvent(s, { type: 'unsave_news', url: 'https://e.com/1' }, '2026-07-07');
    const p = page(s);
    expect(p.total).toBe(2);
    expect(p.items.map((x) => x.id)).not.toContain('https://e.com/1');
  });
});

/* S3 (аудит 11.08.2026): checkins/sleepLog/reliability.days давно мають кепи, а
 * `saved` і `days` росли безмежно. Блоб 'stats' читається й переписується на
 * КОЖНУ подію (відкриття застосунку, чек-ін, голос, три 5-хвилинні крони), тож
 * його розмір — це не «місце в KV», а латентність кожної з цих операцій. */
describe('кепи росту стору (S3)', () => {
  it('saved: понад SAVED_CAP — найстаріші випадають, найновіші лишаються', () => {
    let store = emptyStore();
    for (let i = 0; i < SAVED_CAP + 25; i++) {
      store = recordEvent(
        store,
        { type: 'save_news', url: `https://x/${i}`, title: `новина ${i}`, category: 'Тех' },
        '2026-08-11',
      );
    }
    expect(store.saved).toHaveLength(SAVED_CAP);
    // unshift кладе найновіше на початок -> обрізаємо з ХВОСТА.
    expect(store.saved[0].url).toBe(`https://x/${SAVED_CAP + 24}`);
    expect(store.saved.some((x: { url: string }) => x.url === 'https://x/0')).toBe(false);
  });

  it('days: понад DAYS_CAP діб — найстаріші дати випадають', () => {
    const store = emptyStore();
    // Готуємо стор із надлишком днів напряму, тоді одна подія має підрізати.
    for (let i = 0; i < DAYS_CAP + 10; i++) {
      const d = new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10);
      store.days[d] = { opens: 1, mock: 0, news: 0 };
    }
    const after = recordEvent(store, { type: 'open' }, '2026-08-11');
    expect(Object.keys(after.days)).toHaveLength(DAYS_CAP);
    expect(after.days['2020-01-01']).toBeUndefined();
    expect(after.days['2026-08-11']).toBeDefined(); // сьогоднішній — на місці
  });
});
