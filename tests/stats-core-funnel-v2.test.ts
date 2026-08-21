import { describe, it, expect } from 'vitest';
import { emptyStore, recordEvent, aggregateStats, reachedCounts } from '../web/stats-core.mjs';

// Воронка v2 (роадмеп v3, F1): термінальні стадії rejected/failed, журнал
// переходів, дата входу та конверсії без survivorship bias.
// Базові 4-стадійні кейси лишаються в stats-core.test.ts — тут лише те, що F1 додав.

// stats-core — нетипізований JS-модуль Worker'а. Описуємо тут лише те, чого
// торкається F1: це і дає типи тестам, і документує форму блоба.
interface StageEvt {
  stage: string;
  ts: string;
}
interface FunnelMeta {
  title: string;
  ts: string;
  history?: StageEvt[];
}
interface Store {
  funnel: Record<string, string | undefined>;
  funnelMeta: Record<string, FunnelMeta | undefined>;
  appliedLog: Array<{ url: string; ts: string; fit?: number }>;
}
interface Agg {
  funnel: Record<string, number>;
  funnelList: Array<{ url: string; stage: string; title: string; ts: string; history: StageEvt[] }>;
  conversion: { appliedToInterview: number; interviewToOffer: number };
  reached: Record<string, number>;
  goal: { weeklyApplied: number };
  avgFitApplied: number | null;
}

const rec = (s: KvBlob, ev: Record<string, unknown>, day = '2026-07-01') =>
  recordEvent(s, ev, day) as Store;
const agg = (s: KvBlob, day: string) => aggregateStats(s, day) as Agg;
const stageOf = (s: Store, url: string) => s.funnel[url];
const meta = (s: Store, url: string) => s.funnelMeta[url]!;

/** Провести вакансію ланцюжком стадій (кожна — свій день, якщо задано). */
const walk = (url: string, steps: Array<[string, string]>) => {
  let s: Store = emptyStore() as Store;
  for (const [stage, day] of steps) s = rec(s, { type: 'job_stage', url, stage }, day);
  return s;
};

describe('воронка v2 — термінальні стадії', () => {
  it('rejected/failed зберігаються як стадії, а не СТИРАЮТЬ вакансію', () => {
    // Пастка, закладена в моделі: незнана стадія падала в ту саму гілку, що й
    // stage:null, тобто тихо видаляла вакансію з воронки замість позначити її.
    let s = walk('u1', [
      ['applied', '2026-07-01'],
      ['rejected', '2026-07-05'],
    ]);
    expect(stageOf(s, 'u1')).toBe('rejected');

    s = walk('u2', [
      ['interview', '2026-07-01'],
      ['failed', '2026-07-06'],
    ]);
    expect(stageOf(s, 'u2')).toBe('failed');
  });

  it('термінальна стадія НЕ знімає подачу: подача таки відбулась', () => {
    let s = rec(emptyStore(), { type: 'job_stage', url: 'u1', stage: 'applied', fit: 70 });
    s = rec(s, { type: 'job_stage', url: 'u1', stage: 'rejected' }, '2026-07-05');
    expect(s.appliedLog.map((a) => a.url)).toEqual(['u1']);

    const st = agg(s, '2026-07-05');
    expect(st.goal.weeklyApplied).toBe(1);
    expect(st.avgFitApplied).toBe(70);
  });

  it('назад у «збережено» досі знімає подачу; null — прибирає з воронки', () => {
    let s = rec(emptyStore(), { type: 'job_stage', url: 'u1', stage: 'applied' });
    s = rec(s, { type: 'job_stage', url: 'u1', stage: 'saved' }, '2026-07-02');
    expect(s.appliedLog).toEqual([]);

    s = rec(s, { type: 'job_stage', url: 'u1', stage: null }, '2026-07-03');
    expect(stageOf(s, 'u1')).toBeUndefined();
    expect(meta(s, 'u1')).toBeUndefined();
  });

  it('термінальні рахуються й показуються у списку', () => {
    let s = rec(emptyStore(), { type: 'job_stage', url: 'u1', stage: 'rejected', title: 'A' });
    s = rec(s, { type: 'job_stage', url: 'u2', stage: 'failed', title: 'B' });

    const st = agg(s, '2026-07-01');
    expect(st.funnel.rejected).toBe(1);
    expect(st.funnel.failed).toBe(1);
    expect(st.funnelList.map((x) => x.stage).sort()).toEqual(['failed', 'rejected']);
  });

  it('усі шість стадій присутні в лічильниках (порожня воронка -> нулі)', () => {
    expect(agg(emptyStore(), '2026-07-01').funnel).toEqual({
      saved: 0,
      applied: 0,
      interview: 0,
      offer: 0,
      rejected: 0,
      failed: 0,
    });
  });

  it('стадія-сміття досі прибирає вакансію (поведінка stage:null збережена)', () => {
    let s = rec(emptyStore(), { type: 'job_stage', url: 'u1', stage: 'applied' });
    s = rec(s, { type: 'job_stage', url: 'u1', stage: 'вигадана' }, '2026-07-02');
    expect(stageOf(s, 'u1')).toBeUndefined();
  });
});

describe('воронка v2 — журнал переходів і дата входу', () => {
  it('ts — дата ПЕРШОГО входу, а не останнього переходу', () => {
    // Саме через це напис «у воронці з …» у шторці показував неправду.
    const s = walk('u1', [
      ['saved', '2026-07-01'],
      ['applied', '2026-07-09'],
    ]);
    expect(meta(s, 'u1').ts).toBe('2026-07-01');
    expect(agg(s, '2026-07-09').funnelList[0]!.ts).toBe('2026-07-01');
  });

  it('журнал накопичує реальні переходи з датами', () => {
    const s = walk('u1', [
      ['saved', '2026-07-01'],
      ['applied', '2026-07-03'],
      ['interview', '2026-07-07'],
    ]);
    expect(meta(s, 'u1').history).toEqual([
      { stage: 'saved', ts: '2026-07-01' },
      { stage: 'applied', ts: '2026-07-03' },
      { stage: 'interview', ts: '2026-07-07' },
    ]);
    expect(agg(s, '2026-07-07').funnelList[0]!.history).toHaveLength(3);
  });

  it('повтор тієї ж стадії журнал не роздуває', () => {
    const s = walk('u1', [
      ['applied', '2026-07-01'],
      ['applied', '2026-07-02'],
      ['applied', '2026-07-03'],
    ]);
    expect(meta(s, 'u1').history).toEqual([{ stage: 'applied', ts: '2026-07-01' }]);
  });

  it('журнал обмежений — блоб KV не росте безмежно', () => {
    let s: Store = emptyStore() as Store;
    for (let i = 0; i < 40; i++) {
      s = rec(s, { type: 'job_stage', url: 'u1', stage: i % 2 ? 'applied' : 'saved' });
    }
    expect(meta(s, 'u1').history!.length).toBeLessThanOrEqual(12);
    // Лишається ХВІСТ (найсвіжіші переходи), не голова.
    expect(meta(s, 'u1').history!.at(-1)!.stage).toBe('applied');
  });

  it('title переживає зміну стадії без title', () => {
    let s = rec(emptyStore(), {
      type: 'job_stage',
      url: 'u1',
      stage: 'saved',
      title: 'Junior Dev',
    });
    s = rec(s, { type: 'job_stage', url: 'u1', stage: 'applied' }, '2026-07-02');
    expect(meta(s, 'u1').title).toBe('Junior Dev');
  });

  it('легасі-запис без history не ламає список — віддаємо порожній журнал', () => {
    const legacy = {
      funnel: { u1: 'applied' },
      funnelMeta: { u1: { title: 'A', ts: '2026-06-01' } },
    };
    const st = agg(legacy, '2026-07-01');
    expect(st.funnelList[0]!).toMatchObject({ url: 'u1', stage: 'applied', history: [] });
  });
});

describe('воронка v2 — конверсії без survivorship bias', () => {
  const two = (a: Array<[string, string]>, b: Array<[string, string]>) => {
    let s: Store = emptyStore() as Store;
    for (const [stage, day] of a) s = rec(s, { type: 'job_stage', url: 'u1', stage }, day);
    for (const [stage, day] of b) s = rec(s, { type: 'job_stage', url: 'u2', stage }, day);
    return s;
  };

  it('відмова НЕ покращує конверсію — головний сенс F1', () => {
    // Подано 2: одну відхилили до співбесіди, друга дійшла до співбесіди.
    const s = two(
      [
        ['applied', '2026-07-01'],
        ['rejected', '2026-07-02'],
      ],
      [
        ['applied', '2026-07-01'],
        ['interview', '2026-07-03'],
      ],
    );
    const st = agg(s, '2026-07-03');
    expect(st.reached).toEqual({ saved: 0, applied: 2, interview: 1, offer: 0 });
    // Чесно: подались 2, дійшла 1 -> 50%. Стара формула (з ПОТОЧНИХ стадій) дала б
    // interview/(applied+interview+offer) = 1/1 = 100%, тобто відмова «покращувала» показник.
    expect(st.conversion.appliedToInterview).toBe(50);
  });

  it('провал співбесіди лишається у знаменнику interview→offer', () => {
    const s = two(
      [
        ['applied', '2026-07-01'],
        ['interview', '2026-07-02'],
        ['failed', '2026-07-03'],
      ],
      [
        ['applied', '2026-07-01'],
        ['interview', '2026-07-02'],
        ['offer', '2026-07-04'],
      ],
    );
    const st = agg(s, '2026-07-04');
    expect(st.reached.interview).toBe(2);
    expect(st.conversion.interviewToOffer).toBe(50);
  });

  it('легасі без журналу: «дійшов до» виводиться лінійно з поточної стадії', () => {
    const legacy = {
      funnel: { u1: 'offer', u2: 'applied' },
      funnelMeta: { u1: { title: 'A', ts: '2026-07-01' }, u2: { title: 'B', ts: '2026-07-01' } },
    };
    const st = agg(legacy, '2026-07-01');
    expect(st.reached).toEqual({ saved: 2, applied: 2, interview: 1, offer: 1 });
    expect(st.conversion.appliedToInterview).toBe(50);
    expect(st.conversion.interviewToOffer).toBe(100);
  });

  it('порожня воронка -> нулі, без ділення на нуль', () => {
    const st = aggregateStats(emptyStore(), '2026-07-01');
    expect(st.conversion).toEqual({ appliedToInterview: 0, interviewToOffer: 0 });
    expect(st.reached).toEqual({ saved: 0, applied: 0, interview: 0, offer: 0 });
  });

  it('reachedCounts стійкий до битого стору', () => {
    expect(reachedCounts(null)).toEqual({ saved: 0, applied: 0, interview: 0, offer: 0 });
    expect(reachedCounts({ funnel: { u1: 'сміття' }, funnelMeta: {} })).toEqual({
      saved: 0,
      applied: 0,
      interview: 0,
      offer: 0,
    });
  });
});
