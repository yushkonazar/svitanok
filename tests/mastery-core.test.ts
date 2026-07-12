import { describe, it, expect } from 'vitest';
// @ts-expect-error — JS-модуль Worker'а без типів
import { MOCK_TO_ROADMAP, roadmapToMock, masteryHints, themeOfWeek } from '../web/mastery-core.mjs';
// @ts-expect-error — JS-модуль Worker'а без типів
import { ROADMAP_TOPICS } from '../web/roadmap-data.mjs';
// @ts-expect-error — JS-модуль Worker'а без типів
import { progressKey } from '../web/roadmap-core.mjs';
import { MOCK_TOPICS } from '../src/modules/mock.js';

type Topic = { id: string; title: string; subtopics: { id: string }[] };
const TOPICS = ROADMAP_TOPICS as Topic[];

describe('mastery-core — контракт словників', () => {
  it('кожна mock-тема має мапінг; кожен id існує в ROADMAP_TOPICS', () => {
    const ids = new Set(TOPICS.map((t) => t.id));
    for (const topic of MOCK_TOPICS) {
      const mapped = MOCK_TO_ROADMAP[topic] as string[] | undefined;
      expect(mapped, `нема мапінгу для mock-теми '${topic}'`).toBeDefined();
      expect(mapped!.length, `порожній мапінг для '${topic}'`).toBeGreaterThan(0);
      for (const id of mapped!) {
        expect(ids.has(id), `невідомий roadmap id '${id}' у мапінгу '${topic}'`).toBe(true);
      }
    }
    // і навпаки: у мапінгу нема тем поза словником MOCK_TOPICS
    for (const k of Object.keys(MOCK_TO_ROADMAP)) expect(MOCK_TOPICS).toContain(k);
  });

  it('roadmapToMock: зворотна мапа повна; roadmap-only теми -> []', () => {
    const rev = roadmapToMock();
    expect(Object.keys(rev)).toHaveLength(TOPICS.length);
    expect(rev['react']).toEqual(['Фреймворк']);
    expect(rev['tools']).toEqual([]); // roadmap-only тема без mock-звʼязки
  });
});

describe('mastery-core — masteryHints', () => {
  it('слабка тема -> теми роадмепу з прогресом; тема без мапінгу відпадає', () => {
    const alg = TOPICS.find((t) => t.id === 'algorithms')!;
    const progress = {
      [progressKey('algorithms', alg.subtopics[0]!.id)]: '2026-07-07T00:00:00Z',
    };
    const hints = masteryHints(
      [
        { name: 'Алгоритми', value: 60 },
        { name: 'Невідома тема', value: 50 },
      ],
      progress,
    );
    expect(hints).toHaveLength(1);
    expect(hints[0].mockTopic).toBe('Алгоритми');
    expect(hints[0].themes[0]).toMatchObject({
      id: 'algorithms',
      done: 1,
      total: alg.subtopics.length,
    });
  });

  it('биті входи не валять: порожньо/не-обʼєкт progress', () => {
    expect(masteryHints(null, null)).toEqual([]);
    const hints = masteryHints([{ name: 'HTTP', value: 10 }], 'bad');
    expect(hints[0].themes.every((t: { done: number }) => t.done === 0)).toBe(true);
  });
});

describe('mastery-core — themeOfWeek', () => {
  it('детермінована в межах тижня, ротується наступного', () => {
    const a = themeOfWeek({}, '2026-07-06'); // понеділок
    const b = themeOfWeek({}, '2026-07-12'); // неділя того ж тижня
    expect(a.topicId).toBe(b.topicId);
    expect(a.week).toBe('2026-07-06');
    const c = themeOfWeek({}, '2026-07-13'); // наступний тиждень
    expect(c.topicId).not.toBe(a.topicId); // >1 незавершеної теми -> зсув ротації
  });

  it('завершені теми пропускаються; все завершено -> null', () => {
    const all: Record<string, string> = {};
    for (const t of TOPICS)
      for (const s of t.subtopics) all[progressKey(t.id, s.id)] = '2026-07-07T00:00:00Z';
    expect(themeOfWeek(all, '2026-07-06')).toBeNull();
    // все, крім однієї -> завжди вона, будь-якого тижня
    const keep = TOPICS[3]!;
    const almost = { ...all };
    for (const s of keep.subtopics) delete almost[progressKey(keep.id, s.id)];
    expect(themeOfWeek(almost, '2026-07-06').topicId).toBe(keep.id);
    expect(themeOfWeek(almost, '2026-07-13').topicId).toBe(keep.id);
  });

  it('форма: прогрес теми + mockTopics зі зворотної мапи', () => {
    const t = themeOfWeek({}, '2026-07-06');
    expect(t).toMatchObject({ done: 0 });
    expect(t.total).toBeGreaterThan(0);
    expect(Array.isArray(t.mockTopics)).toBe(true);
  });
});
