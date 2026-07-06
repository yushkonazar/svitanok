import { describe, it, expect } from 'vitest';
// @ts-expect-error — JS-модуль Worker'а без типів
import { emptyStore, normalize, recordEvent, aggregateStats } from '../web/stats-core.mjs';

describe('stats-core — recordEvent', () => {
  it('open рахує відкриття дня + час до відкриття', () => {
    let s = emptyStore();
    s = recordEvent(s, { type: 'open' }, '2026-07-07', 23);
    s = recordEvent(s, { type: 'open' }, '2026-07-07', 31);
    expect(s.days['2026-07-07'].opens).toBe(2);
    expect(s.opensMin).toEqual([23, 31]);
  });

  it('save_news додає в обране + піднімає інтерес; дедуп за url', () => {
    let s = emptyStore();
    s = recordEvent(
      s,
      { type: 'save_news', url: 'u1', title: 'T', category: 'Наука' },
      '2026-07-07',
    );
    s = recordEvent(
      s,
      { type: 'save_news', url: 'u1', title: 'T', category: 'Наука' },
      '2026-07-07',
    );
    expect(s.saved).toHaveLength(1);
    expect(s.interests['Наука']).toBe(2);
  });

  it('job_stage applied -> воронка + лог відгуку + fit', () => {
    let s = emptyStore();
    s = recordEvent(s, { type: 'job_stage', url: 'j1', stage: 'applied', fit: 80 }, '2026-07-07');
    expect(s.funnel['j1']).toBe('applied');
    expect(s.appliedLog).toHaveLength(1);
    expect(s.fitApplied).toEqual([80]);
    // stage null знімає
    s = recordEvent(s, { type: 'job_stage', url: 'j1', stage: null }, '2026-07-07');
    expect(s.funnel['j1']).toBeUndefined();
  });

  it('job_dismiss ефемерне — стор не змінюється', () => {
    let s = emptyStore();
    const before = JSON.stringify(s);
    s = recordEvent(s, { type: 'job_dismiss', url: 'j9' }, '2026-07-07');
    expect(JSON.stringify(s)).toBe(before);
  });

  it('mock_answer hard -> слабка тема; vote -> інтерес', () => {
    let s = emptyStore();
    s = recordEvent(s, { type: 'mock_answer', topic: 'Алгоритми', rating: 'hard' }, '2026-07-07');
    expect(s.mockTopics['Алгоритми']).toEqual({ seen: 1, weak: 1 });
    s = recordEvent(s, { type: 'vote', category: 'Спорт', dir: 'up' }, '2026-07-07');
    expect(s.interests['Спорт']).toBe(1);
  });

  it('невідома подія й биті дані не валять', () => {
    expect(() => recordEvent(null, { type: 'wat' }, '2026-07-07')).not.toThrow();
    expect(normalize('bad')).toEqual(emptyStore());
  });
});

describe('stats-core — aggregateStats', () => {
  const seed = () => {
    let s = emptyStore();
    // 3 дні поспіль до 2026-07-07 з відкриттями + крок
    for (const day of ['2026-07-05', '2026-07-06', '2026-07-07']) {
      s = recordEvent(s, { type: 'open' }, day, 20);
      s = recordEvent(s, { type: 'step_done' }, day);
    }
    s = recordEvent(s, { type: 'news_click', category: 'Технології' }, '2026-07-07');
    s = recordEvent(s, { type: 'job_stage', url: 'a', stage: 'applied', fit: 90 }, '2026-07-07');
    s = recordEvent(s, { type: 'job_stage', url: 'b', stage: 'interview' }, '2026-07-07');
    s = recordEvent(s, { type: 'save_news', url: 'n1', category: 'Технології' }, '2026-07-07');
    return s;
  };

  it('стріки, тижнева активність (7), воронка, ціль, інтереси', () => {
    const st = aggregateStats(seed(), '2026-07-07');
    expect(st.streaks.openDays).toBe(3);
    expect(st.streaks.stepDays).toBe(3);
    expect(st.weekly).toHaveLength(7);
    expect(st.weekly[6].active).toBe(true); // сьогодні активний (останній)
    expect(st.funnel).toMatchObject({ applied: 1, interview: 1 });
    expect(st.goal.weeklyApplied).toBe(1);
    expect(st.goal.weeklyTarget).toBe(5);
    expect(st.avgFitApplied).toBe(90);
    expect(st.interests[0].topic).toBe('Технології'); // 1(click)+2(save)=3
    expect(st.timeToOpenMin).toBe(20);
  });

  it('порожній стор -> валідна форма з нулями', () => {
    const st = aggregateStats(emptyStore(), '2026-07-07');
    expect(st.streaks.openDays).toBe(0);
    expect(st.weekly).toHaveLength(7);
    expect(st.funnel).toEqual({ saved: 0, applied: 0, interview: 0, offer: 0 });
    expect(st.interests).toEqual([]);
    expect(st.timeToOpenMin).toBeNull();
  });
});
