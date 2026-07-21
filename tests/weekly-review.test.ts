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

  it('неділя -> підсумок: новини за тиждень (D4: «кроки до офера» прибрано)', async () => {
    const state = memState({
      shownNews: { 'https://x/a': iso(1), 'https://x/b': iso(2), 'https://x/old': iso(40) },
    });
    const block = await weeklyReviewModule.run(ctx(state, sundayClock));
    expect(block!.priority).toBe(5);
    expect(block!.summary).toContain('2 новин'); // old (40д) не рахується
    expect(block!.summary).not.toContain('кроків');
  });

  it('Фаза B5: roadmapDone/weakTopics — читає ВЖЕ наявні ключі state без нового I/O', async () => {
    const state = memState({
      roadmapProgress: {
        'frontend.html': '2026-07-01T00:00:00Z',
        'react.hooks': '2026-07-02T00:00:00Z',
      },
      mockWeights: { Алгоритми: 1.6, HTTP: 1.0, Патерни: 1.2 },
    });
    const block = await weeklyReviewModule.run(ctx(state, sundayClock));
    const data = block!.data as { roadmapDone: number; weakTopics: string[] };
    expect(data.roadmapDone).toBe(2);
    expect(data.weakTopics).toEqual(['Алгоритми', 'Патерни']); // спадаюче за вагою, HTTP(1.0) не слабка
  });

  it('порожній state -> roadmapDone=0, weakTopics=[] (не валить)', async () => {
    const block = await weeklyReviewModule.run(ctx(memState(), sundayClock));
    const data = block!.data as { roadmapDone: number; weakTopics: string[] };
    expect(data.roadmapDone).toBe(0);
    expect(data.weakTopics).toEqual([]);
  });
});

describe('buildPruners', () => {
  const config = {
    modules: { news: { dedupDays: 3, retentionDays: 7 }, mail: { dedupDays: 3 } },
  } as AppConfig;

  it('чистить старі shownNews і shownMail', () => {
    const data: Record<string, unknown> = {
      shownNews: { recent: iso(2), old: iso(40) },
      shownMail: { recent: iso(1), old: iso(10) },
    };
    for (const p of buildPruners(config, Date.now())) p(data);
    expect(Object.keys(data.shownNews as object)).toEqual(['recent']);
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
  it('weekly-review показується навіть у «тихий день» (quiet=false); Фаза B5: окремий Telegram-пост', async () => {
    const notifier = fakeNotifier();
    const deps: RunDeps = {
      config: parseConfig(baseConfig),
      clock: sundayClock,
      state: memState({ shownNews: { 'https://x/a': iso(1) } }),
      bus: createRunBus(),
      llm: { complete: async () => '' },
      fetcher: { fetch: async () => '' },
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      modules: [weeklyReviewModule],
      notifier,
      assistantNotifier: null,
      miniAppUrl: null,
      kvEnv: null,
    };
    const res = await runBriefing(deps);
    expect(res.quiet).toBe(false); // неділя ніколи не тиха
    const reviewBlock = res.briefing.blocks.find((b) => b.id === 'weekly-review');
    expect(reviewBlock?.title).toBe('Підсумок тижня');
    expect((reviewBlock?.data as { newsCount: number })?.newsCount).toBe(1);
    // Фаза B5: тепер СПРАВДІ йде другим повідомленням у чат (той самий
    // topicBriefing) — раніше чат отримував лише [дата]. Окремий .send()-
    // виклик (best-effort, §код-рев'ю): провал недільного посту не має
    // блокувати вже доставлене щоденне (lastSentDate).
    expect(notifier.sent).toHaveLength(2); // два виклики .send() — щоденний + недільний
    expect(notifier.sent[0]).toHaveLength(1);
    expect(notifier.sent[1]).toHaveLength(1);
    expect(notifier.sent[1]![0]).toContain('Підсумок тижня');
    expect(notifier.sent[1]![0]).toContain('Новин показано: 1');
  });

  it('НЕ неділя -> weekly-review блок відсутній, чат отримує лише [дата] (без регресії)', async () => {
    const notifier = fakeNotifier();
    const notSunday: Clock = { ...sundayClock, isSunday: () => false };
    const deps: RunDeps = {
      config: parseConfig(baseConfig),
      clock: notSunday,
      state: memState(),
      bus: createRunBus(),
      llm: { complete: async () => '' },
      fetcher: { fetch: async () => '' },
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      modules: [weeklyReviewModule],
      notifier,
      assistantNotifier: null,
      miniAppUrl: null,
      kvEnv: null,
    };
    await runBriefing(deps);
    expect(notifier.sent[0]).toHaveLength(1);
    expect(notifier.sent[0]![0]).not.toContain('Підсумок тижня');
  });
});
