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

  it('job_stage applied -> воронка + лог подачі з fit у записі', () => {
    let s = emptyStore();
    s = recordEvent(s, { type: 'job_stage', url: 'j1', stage: 'applied', fit: 80 }, '2026-07-07');
    expect(s.funnel['j1']).toBe('applied');
    expect(s.appliedLog).toEqual([{ url: 'j1', ts: '2026-07-07', fit: 80 }]); // fit у записі (ревʼю D)
    // мета (title+дата) для списку стадії
    expect(s.funnelMeta['j1']).toMatchObject({ ts: '2026-07-07' });
    // stage null знімає стадію, мету ТА запис подачі (ревʼю D)
    s = recordEvent(s, { type: 'job_stage', url: 'j1', stage: null }, '2026-07-07');
    expect(s.funnel['j1']).toBeUndefined();
    expect(s.funnelMeta['j1']).toBeUndefined();
    expect(s.appliedLog).toHaveLength(0);
  });

  it('appliedLog: дедуп по url і чистка при знятті/видаленні (ревʼю D)', () => {
    let s = emptyStore();
    // delete+re-apply того ж url не додає другий рядок
    s = recordEvent(s, { type: 'job_stage', url: 'j1', stage: 'applied', fit: 70 }, '2026-07-07');
    s = recordEvent(s, { type: 'job_stage', url: 'j1', stage: null }, '2026-07-07'); // видалили
    s = recordEvent(s, { type: 'job_stage', url: 'j1', stage: 'applied', fit: 90 }, '2026-07-08');
    expect(s.appliedLog).toEqual([{ url: 'j1', ts: '2026-07-08', fit: 90 }]); // один запис, свіжий fit
    expect(aggregateStats(s, '2026-07-08').goal.weeklyApplied).toBe(1); // НЕ 2
    expect(aggregateStats(s, '2026-07-08').avgFitApplied).toBe(90);
    // applied -> saved (зняли подачу) прибирає з лічильника
    s = recordEvent(s, { type: 'job_stage', url: 'j1', stage: 'saved' }, '2026-07-08');
    expect(s.appliedLog).toHaveLength(0);
    // applied -> interview НЕ прибирає (вакансію подано, прогресує)
    s = recordEvent(s, { type: 'job_stage', url: 'j2', stage: 'applied', fit: 60 }, '2026-07-08');
    s = recordEvent(s, { type: 'job_stage', url: 'j2', stage: 'interview' }, '2026-07-08');
    expect(s.appliedLog).toEqual([{ url: 'j2', ts: '2026-07-08', fit: 60 }]);
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
    // F1: ts — дата ПЕРШОГО входу (07-07), не останнього переходу (07-08).
    // Доти тут стояло ts:'2026-07-08' — тест закріплював баг як норму, через що
    // напис «у воронці з …» у шторці показував дату останньої зміни стадії.
    expect(s.funnelMeta['j2']).toEqual({
      title: 'Junior Dev',
      ts: '2026-07-07',
      history: [
        { stage: 'saved', ts: '2026-07-07' },
        { stage: 'applied', ts: '2026-07-08' },
      ],
    });
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

  it('mock.recentEasyPct: частка easy серед mockRated, null коли порожньо', () => {
    let s = emptyStore();
    expect(aggregateStats(s, '2026-07-07').mock.recentEasyPct).toBeNull();
    s = recordEvent(
      s,
      { type: 'mock_answer', qId: 'q1', topic: 'Алгоритми', rating: 'easy' },
      '2026-07-07',
    );
    s = recordEvent(
      s,
      { type: 'mock_answer', qId: 'q2', topic: 'Алгоритми', rating: 'hard' },
      '2026-07-07',
    );
    s = recordEvent(
      s,
      { type: 'mock_answer', qId: 'q3', topic: 'Патерни', rating: 'easy' },
      '2026-07-07',
    );
    expect(aggregateStats(s, '2026-07-07').mock.recentEasyPct).toBe(67); // 2 із 3
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

  it('❤️ поверх легасі-дизлайку знімає мінус і додає плюс (фідбек власника, п.5)', () => {
    // Регресія на val('down'). UI дизлайків уже не створює, але в KV вони є, і
    // саме звідти прилетить prevDir:'down'. Якщо колись «почистити» гілку
    // 'down' у val() — вона поверне 0 замість -1, старий мінус не зніметься, і
    // бал теми назавжди лишиться на одиницю нижчим. Тест ловить саме це.
    let s = emptyStore();
    s = recordEvent(s, { type: 'vote', category: 'Кіно', dir: 'down' }, '2026-07-07');
    expect(s.interests['Кіно']).toBe(-1);

    s = recordEvent(
      s,
      { type: 'vote', category: 'Кіно', dir: 'up', prevDir: 'down', prevCategory: 'Кіно' },
      '2026-07-08',
    );
    // -1 +1(зняли дизлайк) +1(лайк) = +1 — як у теми, яку просто лайкнули.
    expect(s.interests['Кіно']).toBe(1);
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

describe('stats-core — сон (Блок «Сон»)', () => {
  it('sleepStart записує startedAt лише коли передано nowIso; повторний тап не перезаписує', () => {
    let s = emptyStore();
    // Без nowIso (виклик без 5-го аргументу) — тихо нічого не пише, не падає.
    s = recordEvent(s, { type: 'sleepStart' }, '2026-07-10');
    expect(s.sleepLog['2026-07-10']).toBeUndefined();

    s = recordEvent(s, { type: 'sleepStart' }, '2026-07-10', null, '2026-07-10T23:47:00.000Z');
    expect(s.sleepLog['2026-07-10'].startedAt).toBe('2026-07-10T23:47:00.000Z');

    // Другий тап тієї ж ночі — перший виграє (idempotent).
    s = recordEvent(s, { type: 'sleepStart' }, '2026-07-10', null, '2026-07-10T23:59:00.000Z');
    expect(s.sleepLog['2026-07-10'].startedAt).toBe('2026-07-10T23:47:00.000Z');
  });

  it('open (перше за добу) закриває МИНУЛУ ніч — проставляє wokeAt, не чіпає startedAt', () => {
    let s = emptyStore();
    s = recordEvent(s, { type: 'sleepStart' }, '2026-07-10', null, '2026-07-10T23:47:00.000Z');
    s = recordEvent(s, { type: 'open' }, '2026-07-11', 30, '2026-07-11T07:52:00.000Z');
    expect(s.sleepLog['2026-07-10']).toEqual({
      startedAt: '2026-07-10T23:47:00.000Z',
      wokeAt: '2026-07-11T07:52:00.000Z',
    });
  });

  it('open НЕ чіпає ніч, де wokeAt уже проставлено (лише перше відкриття доби рахується)', () => {
    let s = emptyStore();
    s = recordEvent(s, { type: 'sleepStart' }, '2026-07-10', null, '2026-07-10T23:47:00.000Z');
    s = recordEvent(s, { type: 'open' }, '2026-07-11', 30, '2026-07-11T07:52:00.000Z');
    // Друге відкриття того самого дня (day.opens вже > 0) — wokeAt не зсувається.
    s = recordEvent(s, { type: 'open' }, '2026-07-11', 300, '2026-07-11T12:00:00.000Z');
    expect(s.sleepLog['2026-07-10'].wokeAt).toBe('2026-07-11T07:52:00.000Z');
  });

  it('open закриває НАЙДАВНІШУ відкриту ніч теж, коли застосунок не відкривали кілька днів', () => {
    let s = emptyStore();
    s = recordEvent(s, { type: 'sleepStart' }, '2026-07-08', null, '2026-07-08T23:00:00.000Z');
    // Проґав 09.07 і 10.07 повністю — перше відкриття лише 11.07.
    s = recordEvent(s, { type: 'open' }, '2026-07-11', 30, '2026-07-11T08:00:00.000Z');
    expect(s.sleepLog['2026-07-08'].wokeAt).toBe('2026-07-11T08:00:00.000Z');
  });

  it('немає startedAt -> open нічого не проставляє (нема що закривати)', () => {
    let s = emptyStore();
    s = recordEvent(s, { type: 'open' }, '2026-07-11', 30, '2026-07-11T08:00:00.000Z');
    expect(s.sleepLog).toEqual({});
  });

  it('aggregateStats.sleepLog: durationMin лише коли є ОБИДВА таймстемпи, сорт за датою', () => {
    let s = emptyStore();
    s = recordEvent(s, { type: 'sleepStart' }, '2026-07-10', null, '2026-07-10T23:00:00.000Z');
    s = recordEvent(s, { type: 'open' }, '2026-07-11', 30, '2026-07-11T07:30:00.000Z');
    s = recordEvent(s, { type: 'sleepStart' }, '2026-07-11', null, '2026-07-11T23:30:00.000Z');
    // 11.07 ніч без wokeAt (ще не було відкриття 12.07) -> durationMin null.
    const log = aggregateStats(s, '2026-07-12').sleepLog;
    expect(log).toEqual([
      {
        d: '2026-07-10',
        startedAt: '2026-07-10T23:00:00.000Z',
        wokeAt: '2026-07-11T07:30:00.000Z',
        durationMin: 510,
      },
      { d: '2026-07-11', startedAt: '2026-07-11T23:30:00.000Z', wokeAt: null, durationMin: null },
    ]);
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
    // history (F1) — журнал переходів для «Історії» у шторці вакансії.
    expect(st.funnelList).toEqual([
      {
        url: 'c',
        stage: 'saved',
        title: 'React Trainee',
        ts: '2026-07-07',
        history: [{ stage: 'saved', ts: '2026-07-07' }],
      },
      {
        url: 'a',
        stage: 'applied',
        title: '',
        ts: '2026-07-07',
        history: [{ stage: 'applied', ts: '2026-07-07' }],
      },
      {
        url: 'b',
        stage: 'interview',
        title: '',
        ts: '2026-07-07',
        history: [{ stage: 'interview', ts: '2026-07-07' }],
      },
    ]);
  });

  it('порожній стор -> валідна форма з нулями', () => {
    const st = aggregateStats(emptyStore(), '2026-07-07');
    expect(st.streaks.openDays).toBe(0);
    expect(st.weekly).toHaveLength(7);
    // F1: шість стадій — 4 лінійні + термінальні rejected/failed.
    expect(st.funnel).toEqual({
      saved: 0,
      applied: 0,
      interview: 0,
      offer: 0,
      rejected: 0,
      failed: 0,
    });
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

  it('heatmap: клітинка несе СКЛАД активності (o/m/n), не лише суму', () => {
    let s = emptyStore();
    s = recordEvent(s, { type: 'open' }, '2026-07-06');
    s = recordEvent(s, { type: 'news_click', category: 'Т' }, '2026-07-06');
    s = recordEvent(s, { type: 'news_click', category: 'Т' }, '2026-07-06');
    const hm = aggregateStats(s, '2026-07-07').heatmap;
    const cell = hm.find((c: { d: string }) => c.d === '2026-07-06');
    // Сума лишається як була, але тепер видно, ЩО саме її склало.
    expect(cell.o + cell.m + cell.n).toBe(cell.v);
    expect(cell.n).toBe(2);
    expect(cell.m).toBe(0);
  });

  it('openRhythm: розподіл (не лише медіана); замало точок -> ready=false', () => {
    let s = emptyStore();
    // 4 доби -> нижче гейта 5.
    ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04'].forEach((d, i) => {
      s = recordEvent(s, { type: 'open' }, d, 10 + i * 10);
    });
    expect(aggregateStats(s, '2026-07-07').openRhythm).toMatchObject({ ready: false, n: 4 });

    // 9 діб із рівномірним розкидом 0..80 хв -> медіана 40, квартилі 20/60.
    let s2 = emptyStore();
    for (let i = 0; i < 9; i++) {
      const d = `2026-06-${String(10 + i).padStart(2, '0')}`;
      s2 = recordEvent(s2, { type: 'open' }, d, i * 10);
    }
    const r = aggregateStats(s2, '2026-07-07').openRhythm;
    expect(r.ready).toBe(true);
    expect(r.n).toBe(9);
    expect(r.median).toBe(40);
    expect([r.q1, r.q3]).toEqual([20, 60]);
    expect(r.iqr).toBe(40); // саме це число відрізняє ритуал від випадковості
  });

  it('habitWeekly: знаменник — лише доби, що НАСТАЛИ (поточний тиждень не штрафується)', () => {
    let s = emptyStore();
    // Вівторок 07.07 — другий день тижня (пн 06.07).
    s = recordEvent(s, { type: 'open' }, '2026-07-06');
    s = recordEvent(s, { type: 'open' }, '2026-07-07');
    const hw = aggregateStats(s, '2026-07-07').habitWeekly;
    const cur = hw[hw.length - 1];
    expect(cur.week).toBe('2026-07-06');
    expect(cur.days).toBe(2); // не 7 — інакше живий тиждень завжди «провальний»
    expect(cur.active).toBe(2);
  });

  it('habitWeekly: 12 тижнів, склад активності по кошиках', () => {
    let s = emptyStore();
    s = recordEvent(s, { type: 'open' }, '2026-07-06');
    s = recordEvent(s, { type: 'news_click', category: 'Т' }, '2026-07-06');
    const hw = aggregateStats(s, '2026-07-07').habitWeekly;
    expect(hw).toHaveLength(12);
    const cur = hw[hw.length - 1];
    // news_click рахується ЛИШЕ в news — окремі лічильники, не подвійний облік
    // (той самий інваріант, що вже перевіряє heatmap-тест вище).
    expect([cur.opens, cur.news]).toEqual([1, 1]);
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

  it('fitWeekly: середній fit по тижнях, null для тижня без fit-записів (не 0)', () => {
    let s = emptyStore();
    s = recordEvent(s, { type: 'job_stage', url: 'a', stage: 'applied', fit: 80 }, '2026-07-07');
    s = recordEvent(s, { type: 'job_stage', url: 'b', stage: 'applied', fit: 60 }, '2026-07-07');
    s = recordEvent(s, { type: 'job_stage', url: 'c', stage: 'applied' }, '2026-06-30'); // без fit
    const fw = aggregateStats(s, '2026-07-07').fitWeekly;
    expect(fw).toHaveLength(8);
    expect(fw[7]).toEqual({ week: '2026-07-06', avgFit: 70 }); // (80+60)/2
    expect(fw[6]).toEqual({ week: '2026-06-29', avgFit: null }); // подача була, fit — ні
    expect(fw[5].avgFit).toBeNull(); // порожній тиждень
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

  it('interestsTrend: топ-теми за історію, серії по останніх 26 тижнях (WEEKLY_CAP — уся глибина ретенції)', () => {
    let s = emptyStore();
    s = recordEvent(s, { type: 'news_click', category: 'Наука' }, '2026-07-07');
    s = recordEvent(s, { type: 'save_news', url: 'u', category: 'Технології' }, '2026-06-30');
    const tr = aggregateStats(s, '2026-07-07').interestsTrend;
    expect(tr.weeks).toHaveLength(26);
    expect(tr.weeks[25]).toBe('2026-07-06');
    const tech = tr.topics.find((t: { topic: string }) => t.topic === 'Технології');
    expect(tech.series).toEqual([...Array(24).fill(0), 2, 0]);
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
      days: { '2026-07-07': { ok: true } },
      lastCheckDate: '2026-07-07',
    });
    s = recordReliability(s, '2026-07-08', false);
    expect(s.reliability).toEqual({
      onTime: 1,
      total: 2,
      deadman: 1,
      days: { '2026-07-07': { ok: true }, '2026-07-08': { ok: false } },
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
      days: { '2026-07-07': { ok: false } },
      lastCheckDate: '2026-07-07',
    });
  });

  it('normalize терпить старий стор без reliability.days взагалі', () => {
    expect(normalize({ reliability: { onTime: 3, total: 4 } }).reliability.days).toEqual({});
  });

  it('aggregateStats віддає лічильники + журнал (без lastCheckDate)', () => {
    const s = recordReliability(emptyStore(), '2026-07-07', true);
    const st = aggregateStats(s, '2026-07-07');
    expect(st.reliability).toEqual({
      onTime: 1,
      total: 1,
      deadman: 0,
      streak: 1,
      best: 1,
      days: [{ d: '2026-07-07', ok: true }],
    });
  });

  it('reliability: стрік рахує підряд ok, той самий грейс-принцип, що streaks.openDays', () => {
    let s = emptyStore();
    s = recordReliability(s, '2026-07-05', true);
    s = recordReliability(s, '2026-07-06', true);
    s = recordReliability(s, '2026-07-07', false); // сьогодні зірвано
    const st = aggregateStats(s, '2026-07-07');
    // сьогодні ok=false -> стрік не рахує сьогодні і не йде в грейс-гілку
    // (та відрізняється від streaks.openDays лише тим, що тут "сьогодні"
    // РЕАЛЬНО записано, а не просто відсутнє — тому стрік=0, не 2)
    expect(st.reliability.streak).toBe(0);
    expect(st.reliability.best).toBe(2);
  });

  it('reliability: журнал капиться на RELIABILITY_CAP (90) днів', () => {
    let s = emptyStore();
    const d = new Date('2026-07-07T00:00:00Z');
    for (let i = 0; i < 95; i++) {
      s = recordReliability(s, d.toISOString().slice(0, 10), true);
      d.setUTCDate(d.getUTCDate() - 1);
    }
    expect(Object.keys(s.reliability.days)).toHaveLength(90);
  });
});

describe('stats-core — set_goal (F2, слайдер тижневої цілі)', () => {
  it('виставляє ціль і віддає її в агрегат', () => {
    const s = recordEvent(emptyStore(), { type: 'set_goal', value: 8 }, '2026-07-16');
    expect(s.goal.weeklyTarget).toBe(8);
    expect(aggregateStats(s, '2026-07-16').goal.weeklyTarget).toBe(8);
  });

  it('клампить у діапазон слайдера 1..10', () => {
    const set = (v: unknown) =>
      recordEvent(emptyStore(), { type: 'set_goal', value: v }, '2026-07-16').goal.weeklyTarget;
    expect(set(0)).toBe(1);
    expect(set(-3)).toBe(1);
    expect(set(99)).toBe(10);
    expect(set(1)).toBe(1);
    expect(set(10)).toBe(10);
  });

  it('дробове округлює; сміття лишає ціль недоторканою', () => {
    expect(
      recordEvent(emptyStore(), { type: 'set_goal', value: 6.7 }, '2026-07-16').goal.weeklyTarget,
    ).toBe(7);
    for (const bad of ['вісім', null, undefined, NaN, {}, '', [], false, '8']) {
      expect(
        recordEvent(emptyStore(), { type: 'set_goal', value: bad }, '2026-07-16').goal.weeklyTarget,
      ).toBe(5);
    }
  });

  it('normalize самолікує биту/легасі ціль поза діапазоном', () => {
    expect(normalize({ goal: { weeklyTarget: 4000 } }).goal.weeklyTarget).toBe(10);
    expect(normalize({ goal: { weeklyTarget: -1 } }).goal.weeklyTarget).toBe(1);
    expect(normalize({ goal: { weeklyTarget: 0 } }).goal.weeklyTarget).toBe(5); // 0 -> дефолт
  });
});
