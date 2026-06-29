import { describe, it, expect } from 'vitest';
import { jobsModule } from '../src/modules/jobs.js';
import { createRunBus } from '../src/core/bus.js';
import type { Ctx, StateStore } from '../src/core/types.js';
import type { AppConfig } from '../src/core/config.js';

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
const FE = feed([
  ['Frontend A', 'https://jobs.dou.ua/fe1'],
  ['Frontend B', 'https://jobs.dou.ua/fe2'],
]);
const BE = feed([
  ['Backend A', 'https://jobs.dou.ua/be1'],
  ['Backend B', 'https://jobs.dou.ua/be2'],
]);

function makeCtx(over: { state?: StateStore; fetcher?: Ctx['fetcher'] } = {}): Ctx<AppConfig> {
  const noop = () => {};
  return {
    bus: createRunBus(),
    clock: {
      todayKey: () => '2026-07-01',
      kyivHour: () => 8,
      now: () => new Date(),
      isSunday: () => false,
    },
    log: { debug: noop, info: noop, warn: noop, error: noop },
    config: {
      modules: {
        jobs: {
          enabled: true,
          perRun: 3,
          dedupDays: 7,
          sources: ['https://jobs.dou.ua/fs', 'https://jobs.dou.ua/fe', 'https://jobs.dou.ua/be'],
        },
      },
    } as unknown as AppConfig,
    state: over.state ?? memState(),
    llm: {} as Ctx['llm'],
    fetcher: over.fetcher ?? { fetch: async () => '' },
  };
}

const byUrl = (map: Record<string, string>): Ctx['fetcher'] => ({
  fetch: async (u: string) => {
    if (u.includes('/fs')) return map.fs ?? '';
    if (u.includes('/fe')) return map.fe ?? '';
    if (u.includes('/be')) return map.be ?? '';
    return '';
  },
});

describe('jobs — DOU round-robin', () => {
  it('по одній свіжій із кожного фіда, клікабельні, зберігає shownJobs', async () => {
    const state = memState();
    const ctx = makeCtx({ state, fetcher: byUrl({ fs: FS, fe: FE, be: BE }) });
    const block = await jobsModule.run(ctx);
    expect(block!.title).toBe('Вакансії');
    expect(block!.summaryHtml).toContain('<a href="https://jobs.dou.ua/fs1">Full Stack A</a>');
    expect(block!.summaryHtml).toContain('<a href="https://jobs.dou.ua/fe1">Frontend A</a>');
    expect(block!.summaryHtml).toContain('<a href="https://jobs.dou.ua/be1">Backend A</a>');
    // perRun=3 -> другі елементи не йдуть
    expect(block!.summaryHtml).not.toContain('Full Stack B');
    expect(Object.keys(state.get('shownJobs') as object)).toContain('https://jobs.dou.ua/fs1');
  });

  it('дедуп: показана вакансія пропускається', async () => {
    const state = memState({ shownJobs: { 'https://jobs.dou.ua/fs1': '2026-07-01' } });
    const ctx = makeCtx({ state, fetcher: byUrl({ fs: FS, fe: FE, be: BE }) });
    const block = await jobsModule.run(ctx);
    expect(block!.summaryHtml).not.toContain('Full Stack A');
    expect(block!.summaryHtml).toContain('Full Stack B'); // взяли наступну з фіда
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
