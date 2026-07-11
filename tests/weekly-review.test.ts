import { describe, it, expect } from 'vitest';
import { weeklyReviewModule } from '../src/modules/weekly-review.js';
import { buildPruners } from '../src/core/prune.js';
import { runBriefing, type RunDeps } from '../src/orchestrator.js';
import { parseConfig, type AppConfig } from '../src/core/config.js';
import { createRunBus } from '../src/core/bus.js';
import type { Ctx, StateStore, Clock } from '../src/core/types.js';
import type { Notifier } from '../src/core/telegram.js';

const day = 86400_000;
const iso = (offsetDays: number) =>
  new Date(Date.now() - offsetDays * day).toISOString().slice(0, 10);

function memState(initial: Record<string, unknown> = {}): StateStore {
  const data = { ...initial };
  return {
    get: <T>(k: string) => data[k] as T | undefined,
    set: <T>(k: string, v: T) => void (data[k] = v),
    prune: () => {},
    flush: async () => {},
  };
}

const sundayClock: Clock = {
  isSunday: () => true,
  todayKey: () => iso(0),
  now: () => new Date(),
  kyivHour: () => 9,
};

function ctx(state: StateStore, clock: Clock): Ctx<AppConfig> {
  const noop = () => {};
  return {
    state,
    clock,
    config: {} as AppConfig,
    bus: createRunBus(),
    log: { debug: noop, info: noop, warn: noop, error: noop },
    llm: {} as Ctx['llm'],
    fetcher: {} as Ctx['fetcher'],
  };
}

describe('weekly-review — модуль', () => {
  it('не неділя -> null', async () => {
    const block = await weeklyReviewModule.run(
      ctx(memState(), { ...sundayClock, isSunday: () => false }),
    );
    expect(block).toBeNull();
  });

  it('неділя -> підсумок: новини + кроки за тиждень', async () => {
    const state = memState({
      shownNews: { 'https://x/a': iso(1), 'https://x/b': iso(2), 'https://x/old': iso(40) },
      nextStepLog: [
        { step: 'OG-теги', date: iso(1) },
        { step: 'Mock', date: iso(3) },
        { step: 'старе', date: iso(30) },
      ],
    });
    const block = await weeklyReviewModule.run(ctx(state, sundayClock));
    expect(block!.priority).toBe(5);
    expect(block!.summary).toContain('2 новин'); // old (40д) не рахується
    expect(block!.detail).toContain('OG-теги');
    expect(block!.detail).not.toContain('старе');
  });
});

describe('buildPruners', () => {
  const config = {
    modules: { news: { dedupDays: 3, retentionDays: 7 }, mail: { dedupDays: 3 } },
  } as AppConfig;

  it('чистить старі shownNews, nextStepLog і shownMail', () => {
    const data: Record<string, unknown> = {
      shownNews: { recent: iso(2), old: iso(40) },
      nextStepLog: [
        { step: 'a', date: iso(1) },
        { step: 'b', date: iso(20) },
      ],
      shownMail: { recent: iso(1), old: iso(10) },
    };
    for (const p of buildPruners(config, Date.now())) p(data);
    expect(Object.keys(data.shownNews as object)).toEqual(['recent']);
    expect(data.nextStepLog).toHaveLength(1);
    expect(Object.keys(data.shownMail as object)).toEqual(['recent']);
  });
});

// --- неділя у runBriefing: weekly-review навіть у «тихий день» ---
function fakeNotifier(): Notifier & { sent: string[][] } {
  const sent: string[][] = [];
  return {
    sent,
    send: async (m) => void sent.push(m.map((x) => (typeof x === 'string' ? x : x.text))),
    failNotify: async () => {},
  };
}

const baseConfig = {
  timezone: 'Europe/Kyiv',
  sendHour: 1,
  sendWindowHours: 22,
  locations: [{ lat: 49.8, lon: 24.0, name: 'Львів' }],
  quietDay: { triggerOn: ['news', 'calendar'] },
  modules: {
    stoic: { enabled: true },
    weather: { enabled: true },
    calendar: { enabled: true }, // активний trigger -> був би тихий день
    news: {
      enabled: false,
      categories: ['A'],
      perCategory: 2,
      dedupDays: 3,
      retentionDays: 7,
      sources: {},
    },
    nextStep: { enabled: true, steps: ['x'] },
    weeklyReview: { enabled: true, day: 'sunday' },
    fact: { enabled: false, batchSize: 30 },
    mock: { enabled: false, batchSize: 15, profile: 'x' },
    currency: { enabled: false },
    onthisday: { enabled: false },
    jobs: { enabled: false, perRun: 3, dedupDays: 7, sources: [] },
    mail: { enabled: false, dedupDays: 3, maxCandidates: 15, query: '' },
  },
  llm: { model: 'm', maxCallsPerRun: 2, timeoutMs: 1000 },
  fetch: { timeoutMs: 1000, retries: 0 },
  telegram: { maxMessageChars: 3900 },
};

describe('runBriefing — неділя', () => {
  it('weekly-review показується навіть у «тихий день» (quiet=false)', async () => {
    const notifier = fakeNotifier();
    const deps: RunDeps = {
      config: parseConfig(baseConfig),
      clock: sundayClock,
      state: memState({ nextStepLog: [{ step: 'OG-теги', date: iso(1) }] }),
      bus: createRunBus(),
      llm: { complete: async () => '' },
      fetcher: { fetch: async () => '' },
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      modules: [weeklyReviewModule],
      notifier,
      assistantNotifier: null,
      miniAppUrl: null,
    };
    const res = await runBriefing(deps);
    expect(res.quiet).toBe(false); // неділя ніколи не тиха
    // Контент тижневого підсумку — у briefing.json (Mini App), НЕ в чаті
    // (чат тепер лише [дата]).
    const reviewBlock = res.briefing.blocks.find((b) => b.id === 'weekly-review');
    expect(reviewBlock?.title).toBe('Підсумок тижня');
    expect((reviewBlock?.data as { steps: string[] })?.steps).toContain('OG-теги');
    expect(notifier.sent[0]!.join('\n')).not.toContain('Підсумок тижня');
  });
});
