import { describe, it, expect } from 'vitest';
// @ts-expect-error — JS-модуль Worker'а без типів
import { emptyStore, normalize, recordEvent, aggregateStats } from '../web/stats-core.mjs';
// @ts-expect-error — JS-модуль Worker'а без типів (окремий рядок: директива діє на 1 рядок)
import { recordReliability, weekStartKey } from '../web/stats-core.mjs';

describe('stats-core — recordEvent', () => {
  it('open рахує відкриття дня; час до відкриття — лише ПЕРШЕ відкриття дня', () => {
    let s = emptyStore();
    s = recordEvent(s, { type: 'open' }, '2026-07-07', 23);
    s = recordEvent(s, { type: 'open' }, '2026-07-07', 420); // повторний захід удень
    expect(s.days['2026-07-07'].opens).toBe(2);
    expect(s.opensMin).toEqual([23]); // 420 НЕ тягне медіану — метрика про перший захід
    s = recordEvent(s, { type: 'open' }, '2026-07-08', 31);
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

  it('vote з prevDir — category-aware дельта інтересу (C3)', () => {
    let s = emptyStore();
    // up (як раніше, prevDir відсутній -> +1)
    s = recordEvent(s, { type: 'vote', category: 'Наука', dir: 'up' }, '2026-07-07');
    expect(s.interests['Наука']).toBe(1);
    // toggle-off (newDir=null, prevDir=up, та сама тема) -> -1, повертає в 0
    s = recordEvent(
      s,
      { type: 'vote', category: 'Наука', dir: null, prevDir: 'up', prevCategory: 'Наука' },
      '2026-07-07',
    );
    expect(s.interests['Наука']).toBe(0);
    // зміна up -> down у ТІЙ САМІЙ темі -> -2
    s = recordEvent(s, { type: 'vote', category: 'Кіно', dir: 'up' }, '2026-07-07'); // +1
    s = recordEvent(
      s,
      { type: 'vote', category: 'Кіно', dir: 'down', prevDir: 'up', prevCategory: 'Кіно' },
      '2026-07-07',
    );
    expect(s.interests['Кіно']).toBe(-1); // 1 - 2
  });

  it('vote: той самий url під ІНШОЮ темою — знімає стару, не дінить нову (ревʼю C)', () => {
    let s = emptyStore();
    // Голос up під «Наука» -> interests.Наука=+1.
    s = recordEvent(s, { type: 'vote', category: 'Наука', dir: 'up' }, '2026-07-07');
    // Той самий url приходить під «Тех», клік up -> toggle-off: newDir=null,
    // prevDir=up, prevCategory=Наука. Має зняти +1 з «Наука», «Тех» не чіпати.
    s = recordEvent(
      s,
      { type: 'vote', category: 'Тех', dir: null, prevDir: 'up', prevCategory: 'Наука' },
      '2026-07-07',
    );
    expect(s.interests['Наука']).toBe(0); // знято зі СТАРОЇ теми
    expect(s.interests['Тех'] ?? 0).toBe(0); // нова тема не постраждала
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
    // 3 дні поспіль до 2026-07-07 з відкриттями
    for (const day of ['2026-07-05', '2026-07-06', '2026-07-07']) {
      s = recordEvent(s, { type: 'open' }, day, 20);
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
    expect(st.mockRatedToday).toBe(false);
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

describe('stats-core — розширені метрики (A2)', () => {
  it('weekStartKey: понеділок лишається, неділя -> попередній понеділок', () => {
    expect(weekStartKey('2026-07-06')).toBe('2026-07-06'); // понеділок
    expect(weekStartKey('2026-07-12')).toBe('2026-07-06'); // неділя того ж тижня
    expect(weekStartKey('2026-07-13')).toBe('2026-07-13'); // наступний понеділок
  });

  it('heatmap: вирівняна на понеділок, закінчується сьогодні, рівні за порогами', () => {
    let s = emptyStore();
    s = recordEvent(s, { type: 'open' }, '2026-07-07'); // 1 дія -> l1
    for (let i = 0; i < 3; i++)
      s = recordEvent(s, { type: 'news_click', category: 'Т' }, '2026-07-06'); // +open нижче
    s = recordEvent(s, { type: 'open' }, '2026-07-06'); // 4 дії -> l3
    const hm = aggregateStats(s, '2026-07-07').heatmap;
    expect(new Date(hm[0].d + 'T00:00:00Z').getUTCDay()).toBe(1); // понеділок
    expect(hm[hm.length - 1].d).toBe('2026-07-07'); // сьогодні
    expect(hm.length).toBeGreaterThanOrEqual(84);
    const byDate = Object.fromEntries(hm.map((c: { d: string }) => [c.d, c]));
    expect(byDate['2026-07-07']).toMatchObject({ v: 1, l: 1 });
    expect(byDate['2026-07-06']).toMatchObject({ v: 4, l: 3 });
    expect(byDate['2026-07-05']).toMatchObject({ v: 0, l: 0 });
  });

  it('appliedWeekly: 8 тижнів із нулями, подачі падають у свої кошики', () => {
    let s = emptyStore();
    s = recordEvent(s, { type: 'job_stage', url: 'a', stage: 'applied' }, '2026-07-07'); // пот. тиждень (пн 06)
    s = recordEvent(s, { type: 'job_stage', url: 'b', stage: 'applied' }, '2026-06-30'); // тиждень пн 29.06
    s = recordEvent(s, { type: 'job_stage', url: 'c', stage: 'applied' }, '2026-06-29');
    const aw = aggregateStats(s, '2026-07-07').appliedWeekly;
    expect(aw).toHaveLength(8);
    expect(aw[7]).toEqual({ week: '2026-07-06', count: 1 }); // поточний останній
    expect(aw[6]).toEqual({ week: '2026-06-29', count: 2 });
    expect(aw[5].count).toBe(0); // порожній тиждень присутній
  });

  it('fitHistogram: межі кошиків 49/50 та 89/90', () => {
    let s = emptyStore();
    for (const [u, fit] of [
      ['a', 49],
      ['b', 50],
      ['c', 89],
      ['d', 90],
      ['e', 100],
    ] as const) {
      s = recordEvent(s, { type: 'job_stage', url: u, stage: 'applied', fit }, '2026-07-07');
    }
    const h = aggregateStats(s, '2026-07-07').fitHistogram;
    const by = Object.fromEntries(
      h.map((b: { label: string; count: number }) => [b.label, b.count]),
    );
    expect(by['<50']).toBe(1);
    expect(by['50–59']).toBe(1);
    expect(by['80–89']).toBe(1);
    expect(by['90+']).toBe(2);
    // порожня історія -> всі кошики по нулях, форма стабільна
    expect(
      aggregateStats(emptyStore(), '2026-07-07').fitHistogram.every(
        (b: { count: number }) => b.count === 0,
      ),
    ).toBe(true);
  });

  it('interestsWeekly: події дзеркаляться у тижневі кошики (клік/сейв/голос)', () => {
    let s = emptyStore();
    s = recordEvent(s, { type: 'news_click', category: 'Наука' }, '2026-07-07'); // +1
    s = recordEvent(s, { type: 'save_news', url: 'u', category: 'Наука' }, '2026-07-07'); // +2
    s = recordEvent(s, { type: 'vote', category: 'Наука', dir: 'down' }, '2026-07-07'); // -1
    s = recordEvent(s, { type: 'vote', category: 'Спорт', dir: 'up' }, '2026-06-30'); // мин. тиждень
    expect(s.interestsWeekly['2026-07-06']).toEqual({ Наука: 2 });
    expect(s.interestsWeekly['2026-06-29']).toEqual({ Спорт: 1 });
  });

  it('interestsTrend: топ-теми за історію, серії по останніх 6 тижнях', () => {
    let s = emptyStore();
    s = recordEvent(s, { type: 'news_click', category: 'Наука' }, '2026-07-07');
    s = recordEvent(s, { type: 'save_news', url: 'u', category: 'Технології' }, '2026-06-30');
    const tr = aggregateStats(s, '2026-07-07').interestsTrend;
    expect(tr.weeks).toHaveLength(6);
    expect(tr.weeks[5]).toBe('2026-07-06');
    const tech = tr.topics.find((t: { topic: string }) => t.topic === 'Технології');
    expect(tech.series).toEqual([0, 0, 0, 0, 2, 0]);
    // топ-1 — Технології (2 > 1)
    expect(tr.topics[0].topic).toBe('Технології');
  });

  it('interestsWeekly капиться на 26 тижнів; normalize терпить старий стор', () => {
    let s = emptyStore();
    // 30 тижнів подій назад від 2026-07-06 (понеділки)
    const d = new Date('2026-07-06T00:00:00Z');
    for (let i = 0; i < 30; i++) {
      s = recordEvent(s, { type: 'news_click', category: 'Т' }, d.toISOString().slice(0, 10));
      d.setUTCDate(d.getUTCDate() - 7);
    }
    expect(Object.keys(s.interestsWeekly)).toHaveLength(26);
    expect(normalize({ interests: { X: 1 } }).interestsWeekly).toEqual({});
  });
});

describe('stats-core — межі й стійкість (аудит A5)', () => {
  it('грейс стріку: сьогодні ще без дії -> стрік від учора, не 0', () => {
    let s = emptyStore();
    s = recordEvent(s, { type: 'open' }, '2026-07-05');
    s = recordEvent(s, { type: 'open' }, '2026-07-06');
    // 07-го ще не відкривав — стрік не зламано
    expect(aggregateStats(s, '2026-07-07').streaks.openDays).toBe(2);
    // відкрив 07-го — стрік включає сьогодні
    s = recordEvent(s, { type: 'open' }, '2026-07-07');
    expect(aggregateStats(s, '2026-07-07').streaks.openDays).toBe(3);
  });

  it('грейс НЕ рятує розрив: пропущений учорашній день ламає стрік', () => {
    let s = emptyStore();
    s = recordEvent(s, { type: 'open' }, '2026-07-05'); // позавчора
    expect(aggregateStats(s, '2026-07-07').streaks.openDays).toBe(0);
  });

  it('readPerDay: день із news_click без open рахується у знаменнику', () => {
    let s = emptyStore();
    s = recordEvent(s, { type: 'open' }, '2026-07-06');
    for (let i = 0; i < 3; i++)
      s = recordEvent(s, { type: 'news_click', category: 'Т' }, '2026-07-06');
    for (let i = 0; i < 3; i++)
      s = recordEvent(s, { type: 'news_click', category: 'Т' }, '2026-07-07'); // без open
    expect(aggregateStats(s, '2026-07-07').readPerDay).toBe(3); // 6 кліків / 2 дні
  });

  it('битий dateKey не валить і не засмічує стор ключем "undefined"', () => {
    let s = emptyStore();
    expect(() => (s = recordEvent(s, { type: 'open' }, undefined as never))).not.toThrow();
    expect(Object.keys(s.days)).toEqual([]);
    expect(() => aggregateStats(s, 'сміття' as never)).not.toThrow();
    const st = aggregateStats(s, undefined as never);
    expect(st.weekly).toHaveLength(7);
    expect(st.streaks.openDays).toBe(0);
  });

  it('битий day-bucket (примітив у days) пересоздається, не кидає', () => {
    const corrupt = { days: { '2026-07-07': 5 } };
    const s = recordEvent(corrupt, { type: 'open' }, '2026-07-07');
    expect(s.days['2026-07-07'].opens).toBe(1);
  });

  it('opensMin капиться (історія не росте безмежно)', () => {
    let s = emptyStore();
    // 370 РІЗНИХ днів (у opensMin падає лише перше відкриття дня)
    const d = new Date('2025-01-01T00:00:00Z');
    for (let i = 0; i < 370; i++) {
      s = recordEvent(s, { type: 'open' }, d.toISOString().slice(0, 10), i);
      d.setUTCDate(d.getUTCDate() + 1);
    }
    expect(s.opensMin).toHaveLength(365);
    expect(s.opensMin[0]).toBe(5); // найстаріші зрізано, останні 365 лишились
    expect(s.opensMin[364]).toBe(369);
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
