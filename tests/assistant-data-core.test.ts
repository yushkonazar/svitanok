import { describe, it, expect } from 'vitest';
// @ts-expect-error — JS-модуль Worker'а без типів (namespace-імпорт).
import * as dd from '../web/assistant-data-core.mjs';
const {
  digestReminders,
  digestJobs,
  digestProgress,
  digestBriefing,
  normalizeScope,
  buildOwnDataDigest,
  MAX_DIGEST_LEN,
} = dd;

// 2026-07-15 12:00 UTC = 15:00 Київ (+3); 2026-07-16 06:00 UTC = 09:00 Київ.
const MS_15 = Date.parse('2026-07-15T12:00:00Z');
const MS_16 = Date.parse('2026-07-16T06:00:00Z');

describe('digestReminders', () => {
  it('порожньо / лише спрацьовані -> "активних немає"', () => {
    expect(digestReminders([])).toBe('Нагадування: активних немає.');
    expect(digestReminders(null)).toBe('Нагадування: активних немає.');
    expect(digestReminders([{ id: 'a', text: 'старе', whenMs: MS_15, firedTs: 111 }])).toBe(
      'Нагадування: активних немає.',
    );
  });

  it('активні — нумеровані, київський час, найближче спершу, спрацьовані виключені', () => {
    const out = digestReminders([
      { id: 'b', text: 'дзвінок', whenMs: MS_16, firedTs: null },
      { id: 'a', text: 'стоматолог', whenMs: MS_15, firedTs: null },
      { id: 'c', text: 'старе', whenMs: MS_15, firedTs: 999 },
    ]);
    expect(out).toBe('Нагадування (активні): 1) 15.07, 15:00 стоматолог; 2) 16.07, 09:00 дзвінок.');
  });
});

describe('digestJobs', () => {
  it('повна воронка + ціль + fit', () => {
    const out = digestJobs({
      funnel: { saved: 5, applied: 3, interview: 1, offer: 0 },
      goal: { weeklyTarget: 5, weeklyApplied: 2 },
      avgFitApplied: 72,
    });
    expect(out).toBe(
      'Вакансії — воронка: збережено 5, подано 3, співбесіда 1, оферів 0; ' +
        'ціль тижня 2/5 подач; середній fit поданих 72%.',
    );
  });

  it('відсутні опційні поля деградують (без цілі/fit)', () => {
    const out = digestJobs({ funnel: {}, goal: {} });
    expect(out).toBe('Вакансії — воронка: збережено 0, подано 0, співбесіда 0, оферів 0.');
  });
});

describe('digestProgress', () => {
  it('стрік + роадмеп + слабкі теми', () => {
    const out = digestProgress(
      {
        streaks: { openDays: 5, bestOpenDays: 12 },
        mock: {
          weakTopics: [
            { name: 'React', value: 80 },
            { name: 'SQL', value: 60 },
            { name: 'CSS', value: 0 },
          ],
        },
      },
      { done: 14, total: 48 },
    );
    expect(out).toBe(
      'Активність: стрік відкриттів 5 дн (рекорд 12); роадмеп 14/48 пройдено; ' +
        'слабкі теми (mock): React 80%, SQL 60%.',
    );
  });

  it('без слабких тем і без роадмепу — лише стрік', () => {
    expect(
      digestProgress({ streaks: { openDays: 0, bestOpenDays: 0 } }, { done: 0, total: 0 }),
    ).toBe('Активність: стрік відкриттів 0 дн (рекорд 0).');
  });
});

describe('digestBriefing', () => {
  it('блоки з icon+title+summary; багаторядковий summary плющиться', () => {
    const out = digestBriefing({
      blocks: [
        { id: 'weather', icon: '☀️', title: 'Погода', summary: '+22°C, ясно' },
        { id: 'currency', icon: '💵', title: 'Курс', summary: 'USD 41.2\nEUR 44.5' },
        { id: 'empty', icon: '❓', title: 'Порожній', summary: '   ' },
      ],
    });
    expect(out).toBe(
      'Сьогоднішній брифінг — ☀️ Погода: +22°C, ясно; 💵 Курс: USD 41.2 / EUR 44.5.',
    );
  });

  it('без блоків / без latest -> заглушка', () => {
    expect(digestBriefing({ blocks: [] })).toBe('Сьогоднішній брифінг: даних поки немає.');
    expect(digestBriefing(null)).toBe('Сьогоднішній брифінг: даних поки немає.');
  });
});

describe('normalizeScope', () => {
  it('відоме лишає, невідоме/відсутнє -> all', () => {
    expect(normalizeScope('jobs')).toBe('jobs');
    expect(normalizeScope('reminders')).toBe('reminders');
    expect(normalizeScope('щось')).toBe('all');
    expect(normalizeScope(undefined)).toBe('all');
  });
});

describe('buildOwnDataDigest', () => {
  const sources = {
    reminders: [{ id: 'a', text: 'стоматолог', whenMs: MS_15, firedTs: null }],
    agg: {
      funnel: { saved: 1, applied: 0, interview: 0, offer: 0 },
      goal: {},
      streaks: { openDays: 3, bestOpenDays: 3 },
      mock: { weakTopics: [] },
    },
    roadmap: { done: 2, total: 10 },
    latest: { blocks: [{ id: 'fact', icon: '💡', title: 'Факт', summary: 'Земля кругла' }] },
  };

  it("scope 'all' -> усі чотири секції", () => {
    const out = buildOwnDataDigest({ scope: 'all', ...sources });
    expect(out).toContain('Сьогоднішній брифінг');
    expect(out).toContain('Вакансії — воронка');
    expect(out).toContain('стрік відкриттів');
    expect(out).toContain('Нагадування (активні)');
  });

  it("scope 'jobs' -> лише воронка", () => {
    const out = buildOwnDataDigest({ scope: 'jobs', ...sources });
    expect(out).toContain('Вакансії — воронка');
    expect(out).not.toContain('Нагадування');
    expect(out).not.toContain('Сьогоднішній брифінг');
  });

  it('невідомий scope -> all (граційно)', () => {
    const out = buildOwnDataDigest({ scope: 'chaos', ...sources });
    expect(out).toContain('Вакансії — воронка');
    expect(out).toContain('Нагадування (активні)');
  });

  it('обрізає до MAX_DIGEST_LEN', () => {
    const many = Array.from({ length: 400 }, (_, i) => ({
      id: `r${i}`,
      icon: '📌',
      title: `Блок ${i}`,
      summary: 'x'.repeat(120),
    }));
    const out = buildOwnDataDigest({ scope: 'briefing', latest: { blocks: many } });
    expect(out.length).toBeLessThanOrEqual(MAX_DIGEST_LEN);
    expect(out.endsWith('…')).toBe(true);
  });
});
