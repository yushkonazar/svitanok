import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker, { CRON_TASKS, runCronTasks } from '../web/worker.js';
import { workerEnv } from './helpers/env.js';

/* B11 (аудит 11.08.2026): вісім крон-задач були awaited підряд в ОДНОМУ
 * ctx.waitUntil без ізоляції. Throw у першій (типово Telegram лежить о 08:05 —
 * tgCall не ловить помилку fetch) обривав увесь ланцюг: брифінг не
 * диспатчився, dead-man не спрацьовував, нагадування про чек-ін не йшли —
 * і все це МОВЧКИ, бо waitUntil ковтає reject.
 *
 * Ізоляція тут ПОСЛІДОВНА (try/catch навколо кожної), а НЕ Promise.allSettled:
 * задачі роблять read-modify-write KV без CAS, тож паралельні гілки в одному
 * ізоляті перетинали б вікна GET->PUT і затирали одна одну (саме тому вони й
 * стали послідовними — ревʼю A). Ізолювати треба збій, не порядок. */

const OWNER_CHAT = '-100777';

let kv: Map<string, string>;
let reads: string[];

function kvEnv() {
  return workerEnv({
    BRIEFING: {
      get: async (k: string) => {
        reads.push(k);
        return kv.get(k) ?? null;
      },
      put: async (k: string, v: string) => void kv.set(k, v),
      list: async () => ({ keys: [] }),
    },
    TELEGRAM_BOT_TOKEN: 'bot-token-abc',
    TELEGRAM_CHAT_ID: OWNER_CHAT,
  });
}

beforeEach(() => {
  kv = new Map();
  reads = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('runCronTasks — збій однієї задачі не забирає решту', () => {
  it('усі задачі виконуються, навіть якщо перша кидає; помилка логується З НАЗВОЮ', async () => {
    const ran: string[] = [];
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const tasks = [
      {
        name: 'вибухає',
        run: async () => {
          ran.push('вибухає');
          throw new Error('Telegram HTTP 502');
        },
      },
      { name: 'друга', run: async () => void ran.push('друга') },
      { name: 'третя', run: async () => void ran.push('третя') },
    ];

    await expect(runCronTasks(tasks, workerEnv())).resolves.toBeUndefined(); // сам раннер НЕ кидає
    expect(ran).toEqual(['вибухає', 'друга', 'третя']);
    const logged = err.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toContain('вибухає');
    expect(logged).toContain('Telegram HTTP 502');
  });

  it('виконує ПОСЛІДОВНО (KV read-modify-write без CAS не терпить паралелі)', async () => {
    const order: string[] = [];
    const slow = async (name: string, ms: number) => {
      order.push(`${name}:start`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${name}:end`);
    };
    await runCronTasks(
      [
        { name: 'a', run: () => slow('a', 20) },
        { name: 'b', run: () => slow('b', 0) },
      ],
      workerEnv(),
    );
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('CRON_TASKS — усі девʼять задач, кожна з назвою для логів', () => {
    expect(CRON_TASKS.map((t: { name: string }) => t.name)).toEqual([
      'checkReminders',
      'agentRunWatchdog',
      'agentHostHealthCheck',
      'autoBriefDispatch',
      'deadMansCheck',
      'checkinNudgeCheck',
      'sleepNudgeCheck',
      'autoTelegramSetup',
      'archiveMonthly',
    ]);
  });
});

describe('scheduled() — лежачий Telegram у першій задачі не блокує наступні', () => {
  it('checkReminders падає на fetch, а сторож прогонів і dead-man усе одно читають своє KV', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T10:00:00.000Z')); // 13:00 Київ — після DEAD_MAN_HOUR
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Мережі немає взагалі: КОЖНА задача, що ходить у Telegram, кидає — саме
    // так виглядав інцидент, і саме так перевіряється, що ізольовані ВСІ.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );

    kv.set(
      'state',
      JSON.stringify({
        reminders: [{ id: 'r1', text: 'молоко', whenMs: Date.parse('2026-08-11T09:00:00.000Z') }],
      }),
    );

    const ctxTasks: Promise<unknown>[] = [];
    await worker.scheduled({}, kvEnv(), { waitUntil: (p: Promise<unknown>) => ctxTasks.push(p) });
    await Promise.all(ctxTasks);

    // Задача №1 справді дійшла до Telegram і впала...
    expect(fetch).toHaveBeenCalled();
    // ...а наступні все одно відпрацювали: 'agentRuns' читає лише
    // agentRunWatchdog (№2), 'latest' — лише deadMansCheck (№5).
    expect(reads).toContain('agentRuns');
    expect(reads).toContain('latest');
  });
});
