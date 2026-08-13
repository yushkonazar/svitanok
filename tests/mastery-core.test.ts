import { describe, it, expect } from 'vitest';
// @ts-expect-error — JS-модуль Worker'а без типів
import { MOCK_TO_ROADMAP, roadmapToMock, masteryHints, themeOfWeek } from '../web/mastery-core.mjs';
// @ts-expect-error — JS-модуль Worker'а без типів (окремий рядок: директива діє на 1 рядок)
import { mockMaterials } from '../web/mastery-core.mjs';
// @ts-expect-error — JS-модуль Worker'а без типів
import { masteryTopics } from '../web/mastery-core.mjs';
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

  it('roadmapToMock: зворотна мапа повна; КОЖНА тема роадмепу має mock-тему', () => {
    const rev = roadmapToMock();
    expect(Object.keys(rev)).toHaveLength(TOPICS.length);
    expect(rev['react']).toEqual(['Фреймворк']);
    // F4 закрив прогалину: доти tools/ecosystem/testing-adv/perf-a11y були
    // roadmap-only ([]), тож «тема тижня» з них не могла сісти батч питань.
    expect(rev['tools']).toEqual(['Git/CI']);
    for (const t of TOPICS) {
      expect(rev[t.id]!.length, `тема ${t.id} без mock-теми`).toBeGreaterThan(0);
    }
  });

  it('mockMaterials: кожна mock-тема веде в куроване джерело (F4 «Вивчити»)', () => {
    const mm = mockMaterials();
    for (const topic of Object.keys(MOCK_TO_ROADMAP)) {
      const mats = mm[topic];
      expect(mats?.length, `mock-тема ${topic} без матеріалів`).toBeGreaterThan(0);
      for (const m of mats!) expect(m.url).toMatch(/^https:\/\//);
    }
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

  it('завершення НЕдотичної теми серед тижня не перемикає тему тижня', () => {
    const before = themeOfWeek({}, '2026-07-08');
    // повністю завершуємо будь-яку іншу тему
    const other = TOPICS.find((t) => t.id !== before.topicId)!;
    const progress: Record<string, string> = {};
    for (const s of other.subtopics) progress[progressKey(other.id, s.id)] = '2026-07-08T00:00:00Z';
    expect(themeOfWeek(progress, '2026-07-08').topicId).toBe(before.topicId);
    // а завершення САМОЇ теми тижня — переводить до наступної незавершеної
    const own: Record<string, string> = {};
    const theme = TOPICS.find((t) => t.id === before.topicId)!;
    for (const s of theme.subtopics) own[progressKey(theme.id, s.id)] = '2026-07-08T00:00:00Z';
    const next = themeOfWeek(own, '2026-07-08');
    expect(next.topicId).not.toBe(before.topicId);
  });
});

/* Готовність по темах: єдине місце, де «відмічено пройденим» зустрічається з
 * «як воно даються на питаннях».
 *
 * ⚠️ ПРИВІД. Блок «Майстерність» вимкнено з рендера ще 29.07 із вердиктом
 * власника «абсолютно не розумію, що мені показується»: три незалежні сутності
 * (роадмеп, mock, тема тижня) стояли поруч без жодного звʼязку. Звʼязок при
 * цьому ІСНУВАВ — MOCK_TO_ROADMAP тут-таки, — але назовні не виходив: дашборд
 * бачив або загальний відсоток роадмепу, або all-time %невдалих по mock-темах,
 * і зіставити їх було нічим.
 *
 * Найцінніше, що дає це зіставлення, — РОЗРИВ: тема відмічена пройденою, а
 * питання по ній даються погано. Це «ілюзія знання», і жоден із двох боків
 * окремо її показати не може. */
describe('mastery-core — masteryTopics (готовність по темах)', () => {
  const progress = (pairs: [string, string][]) =>
    Object.fromEntries(pairs.map(([t, s]) => [progressKey(t, s), '2026-08-01T10:00:00.000Z']));

  it('зшиває прогрес роадмепу з mock-статистикою по КОЖНІЙ темі', () => {
    const rows = masteryTopics(progress([]), { HTTP: { seen: 10, weak: 4 } });
    const http = rows.find((r: { id: string }) => r.id === 'networking');
    expect(http.seen).toBe(10);
    expect(http.weak).toBe(4);
  });

  it('mock-тема, що мапиться на КІЛЬКА тем роадмепу, рахується в кожній', () => {
    // HTTP -> ['networking', 'backend'] (MOCK_TO_ROADMAP)
    const rows = masteryTopics({}, { HTTP: { seen: 10, weak: 4 } });
    for (const id of ['networking', 'backend']) {
      expect(rows.find((r: { id: string }) => r.id === id).seen).toBe(10);
    }
  });

  it('тема роадмепу з кількох mock-тем СУМУЄ їхні лічильники', () => {
    // backend <- 'HTTP' і 'Патерни'
    const rows = masteryTopics({}, { HTTP: { seen: 10, weak: 4 }, Патерни: { seen: 6, weak: 1 } });
    const backend = rows.find((r: { id: string }) => r.id === 'backend');
    expect(backend.seen).toBe(16);
    expect(backend.weak).toBe(5);
  });

  it('віддає ВСІ теми роадмепу, навіть без жодного питання', () => {
    const rows = masteryTopics({}, {});
    expect(rows).toHaveLength(TOPICS.length);
    for (const r of rows) expect(r.seen).toBe(0);
  });

  it('прогрес рахується по підпунктах теми, не по всьому роадмепу', () => {
    const t = TOPICS[0]!;
    const rows = masteryTopics(progress([[t.id, t.subtopics[0]!.id]]), {});
    const row = rows.find((r: { id: string }) => r.id === t.id);
    expect(row.done).toBe(1);
    expect(row.total).toBe(t.subtopics.length);
  });

  it('seen=0 -> easePct НУЛЬ НЕ ставиться (це «не питали», а не «погано»)', () => {
    const rows = masteryTopics({}, {});
    for (const r of rows) expect(r.easePct).toBeNull();
  });

  it('easePct — частка НЕвідмічених складними, від 0 до 100', () => {
    const rows = masteryTopics({}, { Алгоритми: { seen: 10, weak: 3 } });
    expect(rows.find((r: { id: string }) => r.id === 'algorithms').easePct).toBe(70);
  });

  it('битий вхід не валить агрегат', () => {
    expect(() => masteryTopics(null, null)).not.toThrow();
    expect(() => masteryTopics('дурня', { HTTP: 'теж дурня' })).not.toThrow();
    expect(masteryTopics(null, null)).toHaveLength(TOPICS.length);
  });

  it('weak більший за seen не дає відʼємної легкості', () => {
    const rows = masteryTopics({}, { Алгоритми: { seen: 2, weak: 5 } });
    expect(rows.find((r: { id: string }) => r.id === 'algorithms').easePct).toBe(0);
  });
});
