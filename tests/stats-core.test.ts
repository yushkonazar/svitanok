import { describe, it, expect } from 'vitest';
// @ts-expect-error — JS-модуль Worker'а без типів
import { emptyStore, normalize, recordEvent, aggregateStats } from '../web/stats-core.mjs';
// @ts-expect-error — JS-модуль Worker'а без типів (окремий рядок: директива діє на 1 рядок)
import { recordReliability } from '../web/stats-core.mjs';

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
    // мета (title+дата) для списку стадії
    expect(s.funnelMeta['j1']).toMatchObject({ ts: '2026-07-07' });
    // stage null знімає стадію ТА мету
    s = recordEvent(s, { type: 'job_stage', url: 'j1', stage: null }, '2026-07-07');
    expect(s.funnel['j1']).toBeUndefined();
    expect(s.funnelMeta['j1']).toBeUndefined();
  });

  it('job_stage зберігає title; зміна стадії не втрачає title', () => {
    let s = emptyStore();
    s = recordEvent(
      s,
      { type: 'job_stage', url: 'j2', stage: 'saved', title: 'Junior Dev' },
      '2026-07-07',
    );
    expect(s.funnelMeta['j2'].title).toBe('Junior Dev');
    // подальший перехід без title у події — тайтл зберігається зі стану
    s = recordEvent(s, { type: 'job_stage', url: 'j2', stage: 'applied' }, '2026-07-08');
    expect(s.funnel['j2']).toBe('applied');
    expect(s.funnelMeta['j2']).toEqual({ title: 'Junior Dev', ts: '2026-07-08' });
  });

  it('normalize терпить старий стор без funnelMeta', () => {
    const legacy = { funnel: { x: 'saved' } };
    expect(normalize(legacy).funnelMeta).toEqual({});
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

  it('save_item додає в обране за kind+id; дедуп; інтерес лише з topic', () => {
    let s = emptyStore();
    s = recordEvent(s, { type: 'save_item', kind: 'fact', id: 'f1', title: 'Факт' }, '2026-07-07');
    s = recordEvent(s, { type: 'save_item', kind: 'fact', id: 'f1', title: 'Факт' }, '2026-07-07');
    expect(s.saved).toHaveLength(1);
    expect(s.saved[0]).toEqual({ kind: 'fact', id: 'f1', title: 'Факт', ts: '2026-07-07' });
    expect(s.interests).toEqual({});
    // той самий id, інший kind — не дедуп
    s = recordEvent(
      s,
      { type: 'save_item', kind: 'question', id: 'f1', title: 'Питання', topic: 'Алгоритми' },
      '2026-07-07',
    );
    expect(s.saved).toHaveLength(2);
    expect(s.interests['Алгоритми']).toBe(2);
  });

  it('unsave_item знімає лише збіг kind+id', () => {
    let s = emptyStore();
    s = recordEvent(s, { type: 'save_item', kind: 'quote', id: 'q1', title: 'Q' }, '2026-07-07');
    s = recordEvent(s, { type: 'save_item', kind: 'fact', id: 'q1', title: 'F' }, '2026-07-07');
    s = recordEvent(s, { type: 'unsave_item', kind: 'quote', id: 'q1' }, '2026-07-07');
    expect(s.saved).toEqual([{ kind: 'fact', id: 'q1', title: 'F', ts: '2026-07-07' }]);
  });

  it('save_news позначає kind:"news"', () => {
    let s = emptyStore();
    s = recordEvent(s, { type: 'save_news', url: 'u1', title: 'T' }, '2026-07-07');
    expect(s.saved[0].kind).toBe('news');
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

  it('funnelList: живий список стадій із title, впорядкований за стадіями', () => {
    let s = seed(); // a=applied(fit90), b=interview — без title у seed
    s = recordEvent(
      s,
      { type: 'job_stage', url: 'c', stage: 'saved', title: 'React Trainee' },
      '2026-07-07',
    );
    const st = aggregateStats(s, '2026-07-07');
    expect(st.funnelList).toEqual([
      { url: 'c', stage: 'saved', title: 'React Trainee', ts: '2026-07-07' },
      { url: 'a', stage: 'applied', title: '', ts: '2026-07-07' },
      { url: 'b', stage: 'interview', title: '', ts: '2026-07-07' },
    ]);
  });

  it('порожній стор -> валідна форма з нулями', () => {
    const st = aggregateStats(emptyStore(), '2026-07-07');
    expect(st.streaks.openDays).toBe(0);
    expect(st.weekly).toHaveLength(7);
    expect(st.funnel).toEqual({ saved: 0, applied: 0, interview: 0, offer: 0 });
    expect(st.funnelList).toEqual([]);
    expect(st.interests).toEqual([]);
    expect(st.timeToOpenMin).toBeNull();
    expect(st.savedCount).toBe(0);
    expect(st.savedList).toEqual([]);
    expect(st.stepDoneToday).toBe(false);
    expect(st.mockRatedToday).toBe(false);
  });

  it('stepDoneToday: true лише після step_done СЬОГОДНІ', () => {
    const s = seed(); // seed вже містить step_done на 05/06/07
    expect(aggregateStats(s, '2026-07-07').stepDoneToday).toBe(true);
    expect(aggregateStats(s, '2026-07-08').stepDoneToday).toBe(false); // інший день
  });

  it('mockRatedToday: true лише після mock_answer СЬОГОДНІ', () => {
    let s = seed();
    s = recordEvent(s, { type: 'mock_answer', topic: 'Алгоритми', rating: 'hard' }, '2026-07-07');
    expect(aggregateStats(s, '2026-07-07').mockRatedToday).toBe(true);
    expect(aggregateStats(s, '2026-07-08').mockRatedToday).toBe(false); // інший день
  });

  it('savedCount/savedList: news має url, item-типи мають id; cap 8, найновіші перші', () => {
    let s = seed(); // seed вже містить save_news('n1')
    s = recordEvent(
      s,
      { type: 'save_item', kind: 'fact', id: 'f1', title: 'Факт дня' },
      '2026-07-08',
    );
    const st = aggregateStats(s, '2026-07-08');
    expect(st.savedCount).toBe(2);
    expect(st.savedList[0]).toEqual({
      kind: 'fact',
      id: 'f1',
      title: 'Факт дня',
      url: null,
      ts: '2026-07-08',
    });
    expect(st.savedList[1]).toEqual({
      kind: 'news',
      id: 'n1',
      title: '',
      url: 'n1',
      ts: '2026-07-07',
    });
  });
});

describe('stats-core — recordReliability', () => {
  it('доставлено -> onTime+total; пропущено -> deadman+total', () => {
    let s = emptyStore();
    s = recordReliability(s, '2026-07-07', true);
    expect(s.reliability).toEqual({
      onTime: 1,
      total: 1,
      deadman: 0,
      lastCheckDate: '2026-07-07',
    });
    s = recordReliability(s, '2026-07-08', false);
    expect(s.reliability).toEqual({
      onTime: 1,
      total: 2,
      deadman: 1,
      lastCheckDate: '2026-07-08',
    });
  });

  it('ідемпотентно за день: повторний виклик тим самим dateKey — no-op', () => {
    let s = emptyStore();
    s = recordReliability(s, '2026-07-07', true);
    const before = JSON.stringify(s);
    s = recordReliability(s, '2026-07-07', true);
    s = recordReliability(s, '2026-07-07', false); // навіть з іншим вердиктом
    expect(JSON.stringify(s)).toBe(before);
  });

  it('normalize зберігає lastCheckDate і терпить старий стор без нього', () => {
    const n = normalize({ reliability: { onTime: 3, total: 4, deadman: 1, lastCheckDate: 'x' } });
    expect(n.reliability.lastCheckDate).toBe('x');
    expect(normalize({ reliability: { onTime: 3, total: 4 } }).reliability.lastCheckDate).toBe(
      undefined,
    );
    // битий стор -> нулі, лічильник стартує з чистого аркуша
    const s = recordReliability('bad', '2026-07-07', false);
    expect(s.reliability).toEqual({
      onTime: 0,
      total: 1,
      deadman: 1,
      lastCheckDate: '2026-07-07',
    });
  });

  it('aggregateStats віддає лише лічильники (без lastCheckDate)', () => {
    const s = recordReliability(emptyStore(), '2026-07-07', true);
    const st = aggregateStats(s, '2026-07-07');
    expect(st.reliability).toEqual({ onTime: 1, total: 1, deadman: 0 });
  });
});
