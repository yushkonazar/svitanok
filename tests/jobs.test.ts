import { describe, it, expect, vi } from 'vitest';
import {
  jobsModule,
  parseScores,
  buildScorePrompt,
  parseWorkUa,
  updateJobPrefs,
  JOB_PREFS_CAP,
  type JobPrefs,
} from '../src/modules/jobs.js';
import { createRunBus } from '../src/core/bus.js';
import type { Ctx, StateStore } from '../src/core/types.js';
import type { AppConfig } from '../src/core/config.js';
import { memState } from './helpers/state.js';

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

  it('без prefs -> без згадки уподобань (сумісність)', () => {
    const p = buildScorePrompt('Junior Full Stack', [{ title: 'A', url: 'u1' }]);
    expect(p).not.toContain('цінує');
    expect(p).not.toContain('ігнорує');
  });

  it('з prefs -> додає рядки цінує/ігнорує', () => {
    const p = buildScorePrompt('Junior Full Stack', [{ title: 'A', url: 'u1' }], {
      liked: ['react', 'remote'],
      disliked: ['java'],
    });
    expect(p).toContain('цінує: react, remote');
    expect(p).toContain('ігнорує: java');
  });
});

describe('jobs — updateJobPrefs', () => {
  it('dismiss -> токени тайтла в disliked; стоп-слова відфільтровані', () => {
    const prefs = updateJobPrefs(
      { liked: [], disliked: [] },
      'dismiss',
      'Junior Java Backend Developer',
    );
    expect(prefs.disliked).toEqual(['java', 'backend']);
    expect(prefs.liked).toEqual([]);
  });

  it('applied/interview/offer -> токени в liked', () => {
    let prefs: JobPrefs = { liked: [], disliked: [] };
    prefs = updateJobPrefs(prefs, 'applied', 'React Frontend Trainee');
    expect(prefs.liked).toEqual(['react', 'frontend']);
    prefs = updateJobPrefs(prefs, 'interview', 'Node Backend');
    expect(prefs.liked).toEqual(['node', 'backend', 'react', 'frontend']);
  });

  it('суперечливий сигнал переносить токен між списками', () => {
    let prefs = updateJobPrefs({ liked: [], disliked: [] }, 'dismiss', 'PHP Legacy');
    expect(prefs.disliked).toContain('php');
    prefs = updateJobPrefs(prefs, 'applied', 'PHP Symfony');
    expect(prefs.liked).toContain('php');
    expect(prefs.disliked).not.toContain('php');
  });

  it('cap: список не перевищує JOB_PREFS_CAP, найновіші зверху', () => {
    let prefs: JobPrefs = { liked: [], disliked: [] };
    for (let i = 0; i < JOB_PREFS_CAP + 5; i++) {
      prefs = updateJobPrefs(prefs, 'applied', `Skill${i}xyz`);
    }
    expect(prefs.liked.length).toBeLessThanOrEqual(JOB_PREFS_CAP);
    expect(prefs.liked[0]).toBe(`skill${JOB_PREFS_CAP + 4}xyz`);
  });

  it('порожній тайтл після фільтра стоп-слів -> без змін', () => {
    const prefs = { liked: [], disliked: [] };
    expect(updateJobPrefs(prefs, 'dismiss', 'Junior Trainee Full Time')).toEqual(prefs);
  });
});

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
    // Порядок за скорингом: BE-A (95) перший, далі FS-A (90), FE-A (50).
    // Перевіряємо data.items — саме він доїжджає до дашборда (HTML-версія
    // summary й кнопки 💾/✅ прибрані разом із мертвим рендерером, B20/F5).
    const items = (block!.data as { items: { title: string; score: number; why: string }[] }).items;
    expect(items.map((i) => i.title)).toEqual(['Backend A', 'Full Stack A', 'Frontend A']);
    expect(items[0]!.why).toBe('ідеально');
    // У короткий рядок дня йдуть лише топ-2 заголовки, у тому самому порядку.
    expect(block!.summary.split('\n')).toEqual(['Backend A', 'Full Stack A']);
    expect(Object.keys(state.get('shownJobs') as object)).toContain('https://jobs.dou.ua/be1');
  });

  it('скоринг впав -> фолбек на свіжість, без бейджів %', async () => {
    const llm = {
      complete: vi.fn(async () => {
        throw new Error('таймаут');
      }),
    };
    const block = await jobsModule.run(makeCtx({ llm }));
    expect(block!.summary).toContain('Full Stack A');
    const items = (block!.data as { items: { score: number }[] }).items;
    expect(items.every((i) => i.score === -1)).toBe(true); // -1 = без скорингу
  });

  it('дедуп: показана вакансія не потрапляє в пул', async () => {
    const state = memState({ shownJobs: { 'https://jobs.dou.ua/fs1': '2026-07-01' } });
    const llm = { complete: vi.fn(async () => '[]') }; // порожній скоринг -> фолбек
    const block = await jobsModule.run(makeCtx({ state, llm }));
    const items = (block!.data as { items: { title: string }[] }).items;
    expect(items.map((i) => i.title)).not.toContain('Full Stack A');
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
