import { describe, it, expect } from 'vitest';
import { runBriefing, isQuietDay, type RunDeps } from '../src/orchestrator.js';
import { parseConfig, type AppConfig } from '../src/core/config.js';
import { createRunBus } from '../src/core/bus.js';
import { MAIL_PROPOSAL_BUS_KEY } from '../src/modules/mail.js';
import type { Module, Block, StateStore, Clock } from '../src/core/types.js';
import type { Notifier as NotifierType, TgButton } from '../src/core/telegram.js';

const baseConfig = {
  timezone: 'Europe/Kyiv',
  sendHour: 1,
  sendWindowHours: 22,
  locations: [{ lat: 49.8, lon: 24.0, name: 'Львів' }],
  quietDay: { triggerOn: ['news', 'calendar'] },
  modules: {
    stoic: { enabled: true },
    weather: { enabled: true },
    calendar: { enabled: false },
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
const makeConfig = (over: Record<string, unknown> = {}): AppConfig =>
  parseConfig({ ...baseConfig, ...over });

const fakeClock: Clock = {
  now: () => new Date('2026-06-29T09:00:00Z'),
  kyivHour: () => 12,
  todayKey: () => '2026-06-29',
  isSunday: () => false,
};

function memState(initial: Record<string, unknown> = {}): StateStore {
  const data = { ...initial };
  return {
    get: <T>(k: string) => data[k] as T | undefined,
    set: <T>(k: string, v: T) => void (data[k] = v),
    prune: () => {},
    flush: async () => {},
  };
}

function fakeNotifier(): NotifierType & { sent: string[][]; buttons: TgButton[][][] } {
  const sent: string[][] = [];
  const buttons: TgButton[][][] = [];
  return {
    sent,
    buttons,
    send: async (m) => {
      sent.push(m.map((x) => (typeof x === 'string' ? x : x.text)));
      for (const x of m) if (typeof x !== 'string' && x.buttons) buttons.push(x.buttons);
    },
    failNotify: async () => {},
  };
}

const mod = (
  id: string,
  kind: 'producer' | 'consumer',
  run: () => Promise<Block | null>,
  enabled = true,
): Module<AppConfig> => ({ id, kind, enabled: () => enabled, run });

const block = (id: string, priority: number): Block => ({ id, title: id, summary: 's', priority });

function deps(over: Partial<RunDeps> = {}): RunDeps {
  return {
    config: makeConfig(),
    clock: fakeClock,
    state: memState(),
    bus: createRunBus(),
    llm: { complete: async () => '' },
    fetcher: { fetch: async () => '' },
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    modules: [],
    notifier: fakeNotifier(),
    assistantNotifier: null,
    ...over,
  };
}

describe('runBriefing — guard', () => {
  it('гонка дубля: lastSentDate сьогодні -> skipped, не шле', async () => {
    const notifier = fakeNotifier();
    const res = await runBriefing(
      deps({ state: memState({ lastSentDate: '2026-06-29' }), notifier, modules: [] }),
    );
    expect(res.status).toBe('skipped');
    expect(notifier.sent).toHaveLength(0);
  });

  it('force обходить ідемпотентність', async () => {
    const res = await runBriefing(deps({ state: memState({ lastSentDate: '2026-06-29' }) }), {
      force: true,
    });
    expect(res.status).toBe('sent');
  });
});

describe('runBriefing — деградація', () => {
  it('усі модулі null -> брифінг усе одно не порожній (header)', async () => {
    const res = await runBriefing(
      deps({
        modules: [
          mod('weather', 'producer', async () => null),
          mod('stoic', 'consumer', async () => null),
        ],
      }),
    );
    expect(res.status).toBe('sent');
    expect(res.messages.length).toBeGreaterThanOrEqual(1);
    expect(res.messages[0]).toContain('червня'); // header
  });

  it('producer кидає виняток -> graceful, решта блоків доходить', async () => {
    const notifier = fakeNotifier();
    const res = await runBriefing(
      deps({
        notifier,
        modules: [
          mod('weather', 'producer', async () => {
            throw new Error('OpenWeather 500');
          }),
          mod('stoic', 'consumer', async () => block('stoic', 10)),
        ],
      }),
    );
    expect(res.status).toBe('sent');
    expect(notifier.sent[0]!.join('\n')).toContain('stoic');
  });
});

describe('runBriefing — dry-run', () => {
  it('не шле, повертає повідомлення', async () => {
    const notifier = fakeNotifier();
    const res = await runBriefing(
      deps({ notifier, modules: [mod('weather', 'producer', async () => block('weather', 40))] }),
      { dryRun: true },
    );
    expect(res.status).toBe('dry-run');
    expect(notifier.sent).toHaveLength(0);
    expect(res.messages.length).toBeGreaterThanOrEqual(1);
  });
});

describe('runBriefing — бойовий без секретів', () => {
  it('notifier=null + не dry-run -> кидає (видимий fail у main)', async () => {
    await expect(runBriefing(deps({ notifier: null, modules: [] }))).rejects.toThrow(/Notifier/);
  });
});

describe('runBriefing — mail-пропозиція (Блок P2c)', () => {
  const proposalItems = [
    {
      kind: 'event' as const,
      title: 'Співбесіда — Acme',
      whenMs: Date.parse('2026-07-14T12:00:00Z'),
      durationMin: 60,
    },
  ];
  const mailModule: Module<AppConfig> = {
    id: 'mail',
    kind: 'producer',
    enabled: () => true,
    async run(ctx) {
      ctx.bus.set(MAIL_PROPOSAL_BUS_KEY, { items: proposalItems });
      return null;
    },
  };

  it('dry-run -> assistantNotifier не викликається', async () => {
    const assistantNotifier = fakeNotifier();
    await runBriefing(deps({ modules: [mailModule], assistantNotifier }), { dryRun: true });
    expect(assistantNotifier.sent).toHaveLength(0);
  });

  it('успішний send -> state.assistantPending записаний, callback_data кнопок містить ТОЙ САМИЙ id', async () => {
    const assistantNotifier = fakeNotifier();
    const state = memState();
    await runBriefing(deps({ modules: [mailModule], assistantNotifier, state }));
    expect(assistantNotifier.sent).toHaveLength(1);
    const pending = state.get<{ id: string; items: unknown[] }>('assistantPending');
    expect(pending?.items).toEqual(proposalItems);
    expect(pending?.id).toMatch(/^[0-9a-f]{8}$/);
    // Крос-перевірка: id, вшитий у callback_data кнопок, МАЄ збігатися з тим,
    // що записано в assistantPending — інакше тап ✅ у Telegram резолвиться
    // проти чужого/неіснуючого pending (тихий "⚠️ Застаріла пропозиція").
    const [accept, cancel] = assistantNotifier.buttons[0]![0]!;
    expect(accept!.callback_data).toBe(`pd:a:${pending!.id}`);
    expect(cancel!.callback_data).toBe(`pd:c:${pending!.id}`);
  });

  it('assistantNotifier=null (TOPIC_ASSISTANT не задано) -> нічого не падає, брифінг усе одно sent', async () => {
    const res = await runBriefing(deps({ modules: [mailModule], assistantNotifier: null }));
    expect(res.status).toBe('sent');
  });

  it('send пропозиції падає -> assistantPending НЕ записаний, основний брифінг усе одно sent', async () => {
    const assistantNotifier: NotifierType = {
      send: async () => {
        throw new Error('Telegram 500');
      },
      failNotify: async () => {},
    };
    const state = memState();
    const res = await runBriefing(deps({ modules: [mailModule], assistantNotifier, state }));
    expect(res.status).toBe('sent');
    expect(state.get('assistantPending')).toBeUndefined();
  });

  it('без пропозиції (bus порожній) -> assistantNotifier не викликається', async () => {
    const assistantNotifier = fakeNotifier();
    await runBriefing(deps({ modules: [], assistantNotifier }));
    expect(assistantNotifier.sent).toHaveLength(0);
  });
});

describe('isQuietDay (§6)', () => {
  it('активні trigger-джерела порожні -> тихий день', () => {
    const cfg = makeConfig({
      modules: { ...baseConfig.modules, calendar: { enabled: true } },
    });
    expect(isQuietDay(cfg, new Set())).toBe(true);
  });

  it('trigger-джерело дало контент -> не тихий', () => {
    const cfg = makeConfig({
      modules: { ...baseConfig.modules, calendar: { enabled: true } },
    });
    expect(isQuietDay(cfg, new Set(['calendar']))).toBe(false);
  });

  it('жодне trigger-джерело не увімкнене -> не тихий (повний брифінг)', () => {
    expect(isQuietDay(makeConfig(), new Set())).toBe(false);
  });
});
