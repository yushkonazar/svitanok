import { describe, it, expect, afterEach } from 'vitest';
import { emptyStore, recordEvent, aggregateStats } from '../web/stats-core.mjs';

/* Забруднення прототипу через ключі стору.
 *
 * ⚠️ ЗНАЙДЕНО РЕВʼЮ ЦІЄЇ Ж ГІЛКИ. Мапи стору кейзяться рядками з події:
 * mockTopics[ev.topic], і поруч — buildRecentByTopic, який я щойно додав.
 * Патерн `if (!m[k]) m[k] = {...}; m[k].seen++` на ключі '__proto__' не
 * створює запису: m['__proto__'] уже істинний (це Object.prototype), тож
 * інкремент іде В ПРОТОТИП. Після цього КОЖЕН порожній обʼєкт у цьому
 * ізоляті має поле `seen` — і будь-яка перевірка виду `if (!obj.seen)` в
 * будь-якому іншому місці воркера починає брехати.
 *
 * Джерело ключа — POST /api/event власника, тобто це не шлях зловмисника, а
 * латентна пастка: досить одного кривого клієнта чи копіпасти. Ізолят живе
 * довго й обслуговує наступні запити вже отруєним.
 *
 * Перевіряємо ОБИДВІ межі: запис у стор і читання агрегата. */

const DANGEROUS = ['__proto__', 'constructor', 'prototype'];

afterEach(() => {
  // Тест, що ловить забруднення, не має лишати його по собі.
  for (const k of ['seen', 'weak', 'polluted']) {
    delete (Object.prototype as Record<string, unknown>)[k];
  }
});

describe('recordEvent — небезпечний ключ теми', () => {
  it.each(DANGEROUS)('mock_answer з topic=%s не чіпає Object.prototype', (topic) => {
    const before = Object.getOwnPropertyNames(Object.prototype).length;
    recordEvent(
      emptyStore(),
      { type: 'mock_answer', qId: 'q1', rating: 'hard', topic },
      '2026-08-13',
    );
    expect(Object.getOwnPropertyNames(Object.prototype).length).toBe(before);
    expect(({} as Record<string, unknown>).seen).toBeUndefined();
  });

  it('небезпечний ключ не потрапляє й у сам стор', () => {
    const s = recordEvent(
      emptyStore(),
      { type: 'mock_answer', qId: 'q1', rating: 'hard', topic: '__proto__' },
      '2026-08-13',
    );
    expect(JSON.stringify(s.mockTopics)).not.toContain('__proto__');
  });

  it('звичайна тема далі рахується — гард не відрізав корисне', () => {
    const s = recordEvent(
      emptyStore(),
      { type: 'mock_answer', qId: 'q1', rating: 'hard', topic: 'HTTP' },
      '2026-08-13',
    );
    expect(s.mockTopics.HTTP).toEqual({ seen: 1, weak: 1 });
  });
});

describe('aggregateStats — небезпечний ключ у вже записаному сторі', () => {
  it('стор із отруйним ключем не забруднює прототип на читанні', () => {
    // Такий стор міг лягти в KV ДО гарда — читання мусить бути стійким саме
    // тому, що виправити вже записане заднім числом неможливо.
    const s = emptyStore();
    s.mockRated.q1 = { r: 'hard', at: '2026-08-13', topic: '__proto__' };
    s.mockTopics['__proto__'] = { seen: 5, weak: 5 };
    const before = Object.getOwnPropertyNames(Object.prototype).length;
    const agg = aggregateStats(s, '2026-08-13');
    expect(Object.getOwnPropertyNames(Object.prototype).length).toBe(before);
    expect(({} as Record<string, unknown>).seen).toBeUndefined();
    expect(agg.mock.recentByTopic).toEqual({});
  });

  it('решта агрегата від отруйного ключа не постраждала', () => {
    const s = emptyStore();
    s.mockTopics['__proto__'] = { seen: 5, weak: 5 };
    s.mockTopics.HTTP = { seen: 4, weak: 1 };
    const weak = aggregateStats(s, '2026-08-13').mock.weakTopics;
    expect(weak.map((t: { name: string }) => t.name)).toEqual(['HTTP']);
  });
});
