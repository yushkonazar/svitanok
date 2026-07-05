import { describe, it, expect, vi } from 'vitest';
import { jobsModule, parseScores, buildScorePrompt, parseWorkUa } from '../src/modules/jobs.js';
import { createRunBus } from '../src/core/bus.js';
import type { Ctx, StateStore } from '../src/core/types.js';
import type { AppConfig } from '../src/core/config.js';

describe('jobs — parseScores', () => {
  it('парсить масив із прози, клампить 0..100, тримить why', () => {
    const m = parseScores(
      'Ось: [{"i":1,"score":150,"why":" добре "},{"i":2,"score":-5,"why":"ні"}] ',
    );
    expect(m.get(1)).toEqual({ score: 100, why: 'добре' });
    expect(m.get(2)).toEqual({ score: 0, why: 'ні' });
  });
  it('малформат -> порожня map', () => {
    expect(parseScores('нема').size).toBe(0);
    expect(parseScores('[зламано').size).toBe(0);
  });
});

describe('jobs — parseWorkUa', () => {
  it('витягує заголовки + абсолютні URL, дедуп, пропуск порожніх/іконкових', () => {
    const html = `
      <a href="/jobs/111/"><img alt=""></a>
      <a href="/jobs/111/">Junior Full Stack Developer</a>
      <a href="/company/5/">не вакансія</a>
      <a href="/jobs/222/">Trainee React Developer &amp; more</a>
      <a href="/jobs/333/">   </a>`;
    expect(parseWorkUa(html)).toEqual([
      { title: 'Junior Full Stack Developer', url: 'https://www.work.ua/jobs/111/' },
      { title: 'Trainee React Developer & more', url: 'https://www.work.ua/jobs/222/' },
    ]);
  });
});

describe('jobs — buildScorePrompt', () => {
  it('містить профіль і нумеровані вакансії', () => {
    const p = buildScorePrompt('Junior Full Stack', [
      { title: 'A', url: 'u1' },
      { title: 'B', url: 'u2' },
    ]);
    expect(p).toContain('Junior Full Stack');
    expect(p).toContain('1. A');
    expect(p).toContain('2. B');
  });
});

function memState(initial: Record<string, unknown> = {}): StateStore {
  const data = { ...initial };
  return {
    get: <T>(k: string) => data[k] as T | undefined,
    set: <T>(k: string, v: T) => void (data[k] = v),
    prune: () => {},
    flush: async () => {},
  };
}

const feed = (items: [string, string][]) =>
  `<rss><channel>${items
    .map(([t, u]) => `<item><title>${t}</title><link>${u}</link></item>`)
    .join('')}</channel>`;

const FS = feed([
  ['Full Stack A', 'https://jobs.dou.ua/fs1'],
  ['Full Stack B', 'https://jobs.dou.ua/fs2'],
]);
const FE = feed([['Frontend A', 'https://jobs.dou.ua/fe1']]);
const BE = feed([['Backend A', 'https://jobs.dou.ua/be1']]);

const byUrl: Ctx['fetcher'] = {
  fetch: async (u: string) => (u.includes('/fs') ? FS : u.includes('/fe') ? FE : BE),
};

function makeCtx(over: { state?: StateStore; llm?: Ctx['llm']; fetcher?: Ctx['fetcher'] } = {}) {
  const noop = () => {};
  return {
    bus: createRunBus(),
    clock: {
      todayKey: () => '2026-07-01',
      kyivHour: () => 8,
      now: () => new Date('2026-07-01T08:00:00+03:00'),
      isSunday: () => false,
    },
    log: { debug: noop, info: noop, warn: noop, error: noop },
    config: {
      llm: { timeoutMs: 1000 },
      modules: {
        jobs: {
          enabled: true,
          perRun: 3,
          dedupDays: 7,
          profile: 'Junior Full Stack',
          sources: ['https://jobs.dou.ua/fs', 'https://jobs.dou.ua/fe', 'https://jobs.dou.ua/be'],
        },
      },
    } as unknown as AppConfig,
    state: over.state ?? memState(),
    llm: over.llm ?? ({} as Ctx['llm']),
    fetcher: over.fetcher ?? byUrl,
  } as Ctx<AppConfig>;
}

describe('jobs — скоринг і сортування', () => {
  it('сортує за fit %, бейдж і «чому», зберігає shownJobs', async () => {
    // Пул round-robin: 1=FS-A, 2=FE-A, 3=BE-A, 4=FS-B
    const llm = {
      complete: vi.fn(async () =>
        JSON.stringify([
          { i: 1, score: 90, why: 'добрий фулстек' },
          { i: 2, score: 50, why: 'фронт' },
          { i: 3, score: 95, why: 'ідеально' },
          { i: 4, score: 20, why: 'нижче' },
        ]),
      ),
    };
    const state = memState();
    const block = await jobsModule.run(makeCtx({ state, llm }));
    expect(llm.complete).toHaveBeenCalledTimes(1);
    // BE-A (95) перший, FS-A (90), FE-A (50)
    expect(block!.summaryHtml).toContain(
      '<b>95%</b> <a href="https://jobs.dou.ua/be1">Backend A</a>',
    );
    expect(block!.summaryHtml!.indexOf('95%')).toBeLessThan(block!.summaryHtml!.indexOf('90%'));
    // «Чому» лишається в дашборді (data.items), не в Telegram-повідомленні.
    expect(block!.detailHtml).toBeUndefined();
    const items = (block!.data as { items: { why: string }[] }).items;
    expect(items[0]!.why).toBe('ідеально');
    expect(Object.keys(state.get('shownJobs') as object)).toContain('https://jobs.dou.ua/be1');
  });

  it('скоринг впав -> фолбек на свіжість, без бейджів %', async () => {
    const llm = {
      complete: vi.fn(async () => {
        throw new Error('таймаут');
      }),
    };
    const block = await jobsModule.run(makeCtx({ llm }));
    expect(block!.summaryHtml).toContain('<a href="https://jobs.dou.ua/fs1">Full Stack A</a>');
    expect(block!.summaryHtml).not.toContain('%'); // без скорингу — без бейджа
  });

  it('дедуп: показана вакансія не потрапляє в пул', async () => {
    const state = memState({ shownJobs: { 'https://jobs.dou.ua/fs1': '2026-07-01' } });
    const llm = { complete: vi.fn(async () => '[]') }; // порожній скоринг -> фолбек
    const block = await jobsModule.run(makeCtx({ state, llm }));
    expect(block!.summaryHtml).not.toContain('Full Stack A');
  });

  it('порожні sources -> null', async () => {
    const ctx = makeCtx();
    (ctx.config.modules.jobs as { sources: string[] }).sources = [];
    expect(await jobsModule.run(ctx)).toBeNull();
  });

  it('усі фіди впали -> null', async () => {
    const ctx = makeCtx({
      fetcher: {
        fetch: async () => {
          throw new Error('fail');
        },
      },
    });
    expect(await jobsModule.run(ctx)).toBeNull();
  });
});
