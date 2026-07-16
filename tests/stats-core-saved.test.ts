import { describe, it, expect } from 'vitest';
// @ts-expect-error — JS-модуль Worker'а без типів
import { emptyStore, recordEvent, aggregateStats, pageSaved } from '../web/stats-core.mjs';

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
