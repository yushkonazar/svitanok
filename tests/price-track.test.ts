// PriceTrack (етап 5 PR-3, S-5-11/S-5-12): розбір грошей (крапка-тисячник),
// звіт Дослідника (« - » у назві магазину, чужа валюта, чужий хост у URL),
// старт/дедуп/зупинка, машина станів на фейкових step/io (перша ціна →
// мовчання → −5 % → ≤ target → «Стоп»; свіже бажання щодня; «Стоп» під час
// очікування звіту; повтор при зайнятому мозку; пропуски й алерт на третій;
// зупинка без події; закінчення після MAX_DAYS), задача price-track-kick,
// виконавці chain.start(price)/chain.cancel(price).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  runPriceTrack,
  startPriceTrack,
  cancelPriceTrack,
  findActivePriceChain,
  parseAmount,
  parsePrice,
  parsePriceReport,
  pickBest,
  hostAllowed,
  priceVerdict,
  checkTask,
  trackingText,
  readWishSnapshot,
  shopsOf,
  startPriceCheckRun,
  priceTrackKickTask,
  productionIo,
  CHAIN_KIND,
  MAX_DAYS,
  MISSES_ALERT,
  WAIT_CHECK_MS,
  DAY_MS,
  DEFAULT_SHOPS,
  PRICE_TRACK_KICK_MARKER_KEY,
} from '../web/core/chains/price.mjs';
import { formatMoney } from '../web/core/format.mjs';
import { readChainState } from '../web/core/chains/state.mjs';
import { runWishesCreate, runWishesUpdate } from '../web/core/tools/wishes.mjs';
import { runFactsSet } from '../web/core/tools/facts.mjs';
import { applyPolicy, resolveUndo } from '../web/core/policy/proposals.mjs';
import { syncInstructionHash } from './helpers/instructions.js';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';
import { d1FromSqlite } from './helpers/d1.js';

const MIGRATIONS = [
  '0001_base.sql',
  '0002_assistant.sql',
  '0003_telemetry.sql',
  '0004_ideas_travel.sql',
  '0007_instructions_plans.sql',
  '0014_fact_provenance.sql',
];
const NOW = Date.parse('2026-09-07T07:00:00.000Z');
const URL_HD = 'https://rozetka.com.ua/ua/philips_hd9200/p1/';

type Step = Parameters<typeof runPriceTrack>[2];
type Io = Parameters<typeof runPriceTrack>[3];
type Wish = Awaited<ReturnType<typeof readWishSnapshot>>;

function setup(kv: Record<string, string> = {}) {
  const d1 = d1FromSqlite(MIGRATIONS);
  const created: { id: string; params: unknown }[] = [];
  const events: { id: string; ev: unknown }[] = [];
  const env = workerEnv({
    DB: d1.stub,
    BRIEFING: memoryKv(new Map(Object.entries(kv))),
    TELEGRAM_CHAT_ID: '555',
    TELEGRAM_OWNER_USER_ID: '777',
    TOPIC_ASSISTANT: '99',
    PRICE_TRACK: {
      create: async (o: { id: string; params: unknown }) => void created.push(o),
      get: async (id: string) => ({
        sendEvent: async (ev: unknown) => void events.push({ id, ev }),
      }),
    } as unknown as Env['PRICE_TRACK'],
  });
  return { db: d1.db, env, created, events };
}

const WISH = {
  id: 'w1',
  title: 'Philips HD9200',
  url: URL_HD,
  target_price: 299900,
  currency: 'UAH',
};
/** Знімок бажання, який io.wish віддає ланцюгу. */
const SNAPSHOT: NonNullable<Wish> = {
  url: URL_HD,
  target_price: 299900,
  currency: 'UAH',
  active: true,
  shops: DEFAULT_SHOPS,
};

function seedChain(
  db: ReturnType<typeof setup>['db'],
  id: string,
  over: Record<string, unknown> = {},
) {
  db.prepare(
    `INSERT INTO chains (id, kind, workflow_id, state_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'running', 'x', 'x')`,
  ).run(
    id,
    CHAIN_KIND,
    id,
    JSON.stringify({
      wish_id: 'w1',
      title: 'Philips HD9200',
      url: URL_HD,
      target_price: 299900,
      currency: 'UAH',
      chat_id: 555,
      thread_id: '99',
      awaiting: null,
      misses: 0,
      ...over,
    }),
  );
}

const report = (lines: string[]) =>
  `## Коротко\n- x\n\n## Ціни\n${lines.join('\n')}\n\n## UNKNOWN\n- немає`;
const COMFY = (p: string) => `- Comfy - ${p} - є в наявності - 07.09.2026 - https://comfy.ua/x`;
const OPTS = { currency: 'UAH', allowedHosts: ['rozetka.com.ua', ...DEFAULT_SHOPS] };

/** Кроки: do одразу; події за типом з черг (null - тиша, час іде вперед). */
function fakeStep(
  queues: Record<string, (Record<string, unknown> | null)[]>,
  clock: { now: number },
) {
  const log: string[] = [];
  const names = new Set<string>();
  const step: Step = {
    do: async (name, fn) => {
      if (names.has(name)) throw new Error(`крок «${name}» повторюється`);
      names.add(name);
      log.push(`do:${name}`);
      return fn();
    },
    waitForEvent: async (name, { type, timeout }) => {
      if (names.has(name)) throw new Error(`крок «${name}» повторюється`);
      names.add(name);
      log.push(`wait:${name}:${type}`);
      const q = queues[type] ?? [];
      const next = q.shift();
      if (next == null) {
        clock.now += Number(String(timeout).replace(' seconds', '')) * 1000;
        throw new Error('timeout');
      }
      return { payload: next };
    },
  };
  return { step, log };
}

function fakeIo(clock: { now: number }, over: Partial<Io> = {}) {
  const sent: { text: string; buttons: string[] }[] = [];
  const alerts: string[] = [];
  const tasks: string[] = [];
  const io: Io = {
    now: () => clock.now,
    wish: async () => SNAPSHOT,
    startCheck: async (task) => {
      tasks.push(task);
      return true;
    },
    send: async (text, buttons) =>
      void sent.push({ text, buttons: (buttons ?? []).flat().map((b) => b.callback_data) }),
    alert: async (text) => void alerts.push(text),
    ...over,
  };
  return { io, sent, alerts, tasks };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('гроші й звіт', () => {
  it('parseAmount: крапка-тисячник, кома-копійки, змішане; formatMoney; parsePrice лише з валютою', () => {
    expect(parseAmount('3 299')).toBe(3299);
    expect(parseAmount('3.299')).toBe(3299); // тисячник, не 3,30
    expect(parseAmount('3299.50')).toBe(3299.5);
    expect(parseAmount('3 299,50')).toBe(3299.5);
    expect(parseAmount('1.099,00')).toBe(1099);
    expect(parseAmount('12,99')).toBe(12.99);
    expect(parseAmount('немає')).toBeNull();
    expect(formatMoney(329900, 'UAH')).toBe('3 299 грн');
    expect(formatMoney(329950, 'UAH')).toBe('3 299,50 грн');
    expect(formatMoney(1299, 'USD')).toBe('12,99 $');
    expect(formatMoney(500, 'CZK')).toBe('5 CZK');
    expect(parsePrice('3.299 грн')).toEqual({ price: 329900, currency: 'UAH' });
    expect(parsePrice('$12,99')).toEqual({ price: 1299, currency: 'USD' });
    expect(parsePrice('є в наявності')).toBeNull();
    expect(parsePrice('0 грн')).toBeNull();
    expect(parsePrice('3299')).toBeNull(); // без валюти - не ціна
  });

  it('parsePriceReport: « - » у назві магазину, чужа валюта геть, URL лише з дозволених хостів, назва без розмітки', () => {
    const points = parsePriceReport(
      report([
        '- Comfy - Forum Lviv - 3 299 грн - є в наявності - 07.09.2026 - https://comfy.ua/x',
        '- Allo - 3 399 грн - є в наявності - 07.09.2026 - https://allo.ua/x',
        '- Amazon - $80 - є в наявності - 07.09.2026 - https://amazon.com/x',
        '- [Знижка](https://evil.tld/phish) - 1 грн - є в наявності - 07.09.2026 - https://evil.tld/phish',
        '- Eldorado - 3 449 грн - немає - 07.09.2026',
        'не рядок',
      ]),
      OPTS,
    );
    expect(points.map((p) => [p.source, p.price, p.in_stock, p.url])).toEqual([
      ['Знижка', 100, true, null], // фішинг-URL відкинуто, розмітку знято
      ['Comfy - Forum Lviv', 329900, true, 'https://comfy.ua/x'],
      ['Allo', 339900, true, 'https://allo.ua/x'],
      ['Eldorado', 344900, false, null],
    ]);
    expect(pickBest(points)?.source).toBe('Знижка');
    expect(pickBest([])).toBeNull();
    expect(parsePriceReport('## Коротко\n- нічого', OPTS)).toEqual([]);
    expect(
      parsePriceReport(
        '## Ціни\n- A - 10 грн - є - 07.09.2026 - u\n## Факти\n- B - 5 грн - є',
        OPTS,
      ),
    ).toHaveLength(1);
    expect(hostAllowed('m.comfy.ua', DEFAULT_SHOPS)).toBe(true);
    expect(hostAllowed('comfy.ua.evil.tld', DEFAULT_SHOPS)).toBe(false);
  });

  it('checkTask несе назву, url і магазини знімка; trackingText; priceVerdict: перша / target / −5 % / мовчання', () => {
    expect(checkTask('Philips HD9200', SNAPSHOT)).toContain(URL_HD);
    expect(checkTask('Philips HD9200', { ...SNAPSHOT, shops: ['comfy.ua'] })).toContain('comfy.ua');
    expect(trackingText('X', 299900, 'UAH')).toBe(
      'Відстежую ціну «X» щодня; скажу при −5 % або ≤ 2 999 грн.',
    );
    expect(trackingText('X', null, 'UAH')).toContain('цільовій ціні');
    const best = {
      source: 'Comfy',
      price: 329900,
      currency: 'UAH',
      in_stock: true,
      url: 'https://comfy.ua/x',
    };
    expect(priceVerdict('HD', 299900, best, { prev: null, min: null })).toBe(
      'Перша ціна «HD»: 3 299 грн (Comfy: https://comfy.ua/x). Стежу далі.',
    );
    expect(priceVerdict('HD', 299900, best, { prev: 339900, min: 339900 })).toBeNull(); // −2,9 %
    expect(priceVerdict('HD', 299900, best, { prev: 349900, min: 349900 })).toBe(
      '📉 «HD» подешевшало: 3 299 грн (−6 % від 3 499 грн, мінімум за весь час) - Comfy: https://comfy.ua/x.',
    );
    expect(
      priceVerdict('HD', 299900, { ...best, price: 299900 }, { prev: 305000, min: 305000 }),
    ).toBe('🎯 «HD» - 2 999 грн, не дорожче цільових 2 999 грн (Comfy: https://comfy.ua/x).');
    expect(
      priceVerdict('HD', null, { ...best, url: null }, { prev: 349900, min: 349900 }),
    ).toContain('- Comfy.');
  });
});

describe('старт / зупинка / знімок бажання', () => {
  it('startPriceTrack: рядок chains + інстанс; другий старт для того ж бажання - existing без нового інстанса', async () => {
    const { env, created } = setup();
    const a = await startPriceTrack(env, WISH, NOW, { chatId: 555, threadId: '99' });
    const b = await startPriceTrack(env, WISH, NOW + 1, {});
    expect(a.existing).toBe(false);
    expect(b).toEqual({ chainId: a.chainId, existing: true });
    expect(created).toHaveLength(1);
    expect(await findActivePriceChain(env, { wishId: 'w1' })).toEqual({
      id: a.chainId,
      title: 'Philips HD9200',
      wishId: 'w1',
    });
    expect(await findActivePriceChain(env, { chainId: a.chainId })).toMatchObject({
      id: a.chainId,
    });
    expect(await findActivePriceChain(env, {})).toMatchObject({ id: a.chainId });
    expect(await findActivePriceChain(env, { chainId: 'nope' })).toBeNull();
  });

  it('cancelPriceTrack: cancelled + подія stop одним UPDATE; повторно - false; без привʼязки - явна відмова старту', async () => {
    const { env, events } = setup();
    const a = await startPriceTrack(env, WISH, NOW, {});
    expect(await cancelPriceTrack(env, 'w1', NOW)).toBe(true);
    expect(events).toEqual([{ id: a.chainId, ev: { type: 'price', payload: { action: 'stop' } } }]);
    expect((await readChainState(env, a.chainId))?.status).toBe('cancelled');
    expect(await cancelPriceTrack(env, 'w1', NOW)).toBe(false);
    (env as { PRICE_TRACK?: unknown }).PRICE_TRACK = undefined;
    await expect(startPriceTrack(env, WISH, NOW, {})).rejects.toThrow(/PRICE_TRACK/);
  });

  it('Workflow не створився - рядок failed і помилка', async () => {
    const { env } = setup();
    (env as { PRICE_TRACK?: unknown }).PRICE_TRACK = {
      create: async () => {
        throw new Error('boom');
      },
      get: async () => ({ sendEvent: async () => undefined }),
    };
    await expect(startPriceTrack(env, WISH, NOW, {})).rejects.toThrow(/не стартував: boom/);
    expect(await findActivePriceChain(env, { wishId: 'w1' })).toBeNull();
  });

  it('readWishSnapshot бачить правку wishes.update; shopsOf - facts.setting.price_shops або типові', async () => {
    const { env } = setup();
    const w = await runWishesCreate(
      env,
      { type: 'purchase', title: 'HD', url: URL_HD, target_price: 3000 },
      NOW,
    );
    expect(await readWishSnapshot(env, w.result.id)).toMatchObject({
      url: URL_HD,
      target_price: 300000,
      currency: 'UAH',
      active: true,
      shops: DEFAULT_SHOPS,
    });
    await runWishesUpdate(env, { id: w.result.id, target_price: 2500, status: 'done' }, NOW + 1);
    expect(await readWishSnapshot(env, w.result.id)).toMatchObject({
      target_price: 250000,
      active: false,
    });
    expect(await readWishSnapshot(env, 'nope')).toBeNull();
    await runFactsSet(
      env,
      { kind: 'setting', key: 'price_shops', value: ['Comfy.UA', 'allo.ua'], source: 'owner' },
      NOW,
    );
    expect(await shopsOf(env)).toEqual(['comfy.ua', 'allo.ua']);
  });
});

describe('runPriceTrack', () => {
  it('день 0: перша ціна → повідомлення; день 1: −2 % мовчить; день 2: −6 % → 📉; день 3: ≤ target → 🎯; «Стоп» уночі → cancelled', async () => {
    const { env, db } = setup();
    seedChain(db, 'c1');
    const clock = { now: NOW };
    const { step, log } = fakeStep(
      {
        worker: [
          { output: report([COMFY('3 499 грн')]) },
          { output: report([COMFY('3 429 грн')]) },
          {
            output: report([
              COMFY('3 199 грн'),
              '- Allo - 3 150 грн - немає - 07.09.2026 - https://allo.ua/x',
            ]),
          },
          { output: report([COMFY('2 990 грн')]) },
        ],
        price: [null, null, null, { action: 'stop' }],
      },
      clock,
    );
    const { io, sent, tasks } = fakeIo(clock);
    expect(await runPriceTrack(env, { chainId: 'c1' }, step, io)).toEqual({ outcome: 'cancelled' });
    expect(tasks).toHaveLength(4);
    expect(sent.map((s) => s.text)).toEqual([
      'Перша ціна «Philips HD9200»: 3 499 грн (Comfy: https://comfy.ua/x). Стежу далі.',
      '📉 «Philips HD9200» подешевшало: 3 199 грн (−7 % від 3 429 грн, мінімум за весь час) - Comfy: https://comfy.ua/x.',
      '🎯 «Philips HD9200» - 2 990 грн, не дорожче цільових 2 999 грн (Comfy: https://comfy.ua/x).',
      'Зупинив відстеження «Philips HD9200».',
    ]);
    // «Купив» поруч зі «Стоп» (PR-6 §2.6): падіння ціни - момент, коли
    // бажання найчастіше стає покупкою, і закривати його потім ніхто не йде.
    expect(sent[0]!.buttons).toEqual(['m:buy:w1', 'c:c1:stop']);
    // Allo дешевше, але немає в наявності - пишемо ціну Comfy.
    expect(db.prepare('SELECT price, is_low, source FROM price_points ORDER BY at').all()).toEqual([
      { price: 349900, is_low: 1, source: 'Comfy' },
      { price: 342900, is_low: 1, source: 'Comfy' },
      { price: 319900, is_low: 1, source: 'Comfy' },
      { price: 299000, is_low: 1, source: 'Comfy' },
    ]);
    expect(log.filter((l) => l.startsWith('wait:d0'))).toEqual([
      'wait:d0-wait:worker',
      'wait:d0-sleep:price',
    ]);
    expect(await readChainState(env, 'c1')).toMatchObject({
      status: 'cancelled',
      state: { misses: 0 },
    });
  });

  it('ціль читається свіжою щодня: після wishes.update ціль нижча - 🎯 не спрацьовує, лише 📉', async () => {
    const { env, db } = setup();
    seedChain(db, 'c1'); // у стані ланцюга ціль 2 999 грн - застаріла
    // Учорашня ціна: інакше спрацював би рядок «Перша ціна» і ціль не читалась.
    db.prepare(
      `INSERT INTO price_points (id, wish_id, at, source, price, currency, url, is_low) VALUES ('pp0', 'w1', '2026-09-06T07:00:00Z', 'Comfy', 320000, 'UAH', null, 1)`,
    ).run();
    const clock = { now: NOW };
    const { step } = fakeStep(
      { worker: [{ output: report([COMFY('2 990 грн')]) }], price: [{ action: 'stop' }] },
      clock,
    );
    const { io, sent } = fakeIo(clock, {
      wish: async () => ({ ...SNAPSHOT, target_price: 250000 }),
    });
    await runPriceTrack(env, { chainId: 'c1' }, step, io);
    expect(sent[0]!.text).toContain('📉');
    expect(sent.some((s) => s.text.startsWith('🎯'))).toBe(false);
  });

  it('бажання зникло, стало неактивним або без url - зупинка до прогону', async () => {
    const { env, db } = setup();
    for (const [id, wish] of [
      ['c1', null],
      ['c2', { ...SNAPSHOT, active: false }],
      ['c3', { ...SNAPSHOT, url: '' }],
    ] as const) {
      seedChain(db, id);
      const clock = { now: NOW };
      const { step } = fakeStep({}, clock);
      const { io, tasks, sent } = fakeIo(clock, { wish: async () => wish });
      expect(await runPriceTrack(env, { chainId: id }, step, io)).toEqual({ outcome: 'cancelled' });
      expect(tasks).toHaveLength(0);
      expect(sent.map((s) => s.text)).toEqual(['Зупинив відстеження «Philips HD9200».']);
    }
  });

  it('«Стоп» під час очікування звіту: ціна не пишеться і повідомлення немає', async () => {
    const { env, db } = setup();
    seedChain(db, 'c1');
    const clock = { now: NOW };
    const { step } = fakeStep({ worker: [{ output: report([COMFY('3 000 грн')]) }] }, clock);
    const { io, sent } = fakeIo(clock);
    const orig = step.waitForEvent;
    step.waitForEvent = async (name, opts) => {
      // Поки ланцюг чекав звіт, власник натиснув «Стоп» (подія іншого типу).
      if (name === 'd0-wait') db.prepare(`UPDATE chains SET status = 'cancelled'`).run();
      return orig(name, opts);
    };
    expect(await runPriceTrack(env, { chainId: 'c1' }, step, io)).toEqual({ outcome: 'cancelled' });
    expect(db.prepare('SELECT count(*) AS n FROM price_points').get()).toEqual({ n: 0 });
    expect(sent.map((s) => s.text)).toEqual(['Зупинив відстеження «Philips HD9200».']);
  });

  it('мозок зайнятий: друга спроба через 5 хв; «Стоп» у паузі - кінець', async () => {
    const { env, db } = setup();
    seedChain(db, 'c1');
    const clock = { now: NOW };
    const { step, log } = fakeStep(
      { worker: [{ output: report([COMFY('3 000 грн')]) }], price: [null, { action: 'stop' }] },
      clock,
    );
    let attempt = 0;
    const { io, sent } = fakeIo(clock, {
      startCheck: async () => {
        attempt += 1;
        return attempt > 1;
      },
    });
    await runPriceTrack(env, { chainId: 'c1' }, step, io);
    expect(log.filter((l) => l.includes('d0-start'))).toEqual(['do:d0-start-0', 'do:d0-start-1']);
    expect(log).toContain('wait:d0-retry-0:price');
    expect(sent[0]!.text).toContain('Перша ціна');

    seedChain(db, 'c2');
    const clock2 = { now: NOW };
    const { step: step2 } = fakeStep({ price: [{ action: 'stop' }] }, clock2);
    const { io: io2, sent: sent2 } = fakeIo(clock2, { startCheck: async () => false });
    expect(await runPriceTrack(env, { chainId: 'c2' }, step2, io2)).toEqual({
      outcome: 'cancelled',
    });
    expect(sent2.map((s) => s.text)).toEqual(['Зупинив відстеження «Philips HD9200».']);
  });

  it('пропуски: без ціни у звіті / мозок мовчить / прогін не стартував - лічильник; третій поспіль - один алерт; успіх скидає', async () => {
    const { env, db } = setup();
    seedChain(db, 'c1');
    const clock = { now: NOW };
    const { step } = fakeStep(
      {
        worker: [
          { output: '## Коротко\n- нічого' },
          null,
          { output: report([COMFY('3 000 грн')]) },
        ],
        // Паузу-повтор дня 2 теж читає черга `price`.
        price: [null, null, null, null, { action: 'cancel' }],
      },
      clock,
    );
    let n = 0;
    const { io, alerts, sent } = fakeIo(clock, {
      startCheck: async () => {
        n += 1;
        return n !== 3 && n !== 4; // день 2 - мозок недоступний в обох спробах
      },
    });
    expect(await runPriceTrack(env, { chainId: 'c1' }, step, io)).toEqual({ outcome: 'cancelled' });
    expect(alerts).toEqual([
      `Відстеження ціни «Philips HD9200»: ${MISSES_ALERT} дні поспіль без ціни (мозок/Дослідник). Ланцюг живе, перевірю завтра.`,
    ]);
    expect(sent.map((s) => s.text)[0]).toContain('Перша ціна');
    expect((await readChainState(env, 'c1'))?.state.misses).toBe(0);
  });

  it('звіт лише в чужій валюті - день без ціни (не порівнюємо гривні з доларами)', async () => {
    const { env, db } = setup();
    seedChain(db, 'c1');
    const clock = { now: NOW };
    const { step } = fakeStep(
      {
        worker: [
          {
            output: report(['- Amazon - $80 - є в наявності - 07.09.2026 - https://amazon.com/x']),
          },
        ],
        price: [{ action: 'stop' }],
      },
      clock,
    );
    const { io, sent } = fakeIo(clock);
    await runPriceTrack(env, { chainId: 'c1' }, step, io);
    expect(db.prepare('SELECT count(*) AS n FROM price_points').get()).toEqual({ n: 0 });
    expect(sent.map((s) => s.text)).toEqual(['Зупинив відстеження «Philips HD9200».']);
  });

  it(`після ${MAX_DAYS} днів - done з повідомленням; таймаути очікувань - 12 хв і доба`, async () => {
    const { env, db } = setup();
    seedChain(db, 'c1');
    const clock = { now: NOW };
    const { step, log } = fakeStep({}, clock);
    const { io, sent } = fakeIo(clock, { startCheck: async () => false });
    expect(await runPriceTrack(env, { chainId: 'c1' }, step, io)).toEqual({ outcome: 'expired' });
    expect(sent.at(-1)!.text).toContain(`завершено після ${MAX_DAYS} днів`);
    expect((await readChainState(env, 'c1'))?.status).toBe('done');
    // Кожен день: пауза-повтор 5 хв + доба сну (звіту немає - waitForEvent worker не буде).
    expect(log.filter((l) => l.startsWith('wait:')).length).toBe(MAX_DAYS * 2);
    expect(clock.now - NOW).toBe(MAX_DAYS * (DAY_MS + 5 * 60_000));
    expect(WAIT_CHECK_MS).toBe(12 * 60_000);
  });
});

describe('бойове io та інтеграція', () => {
  it('startPriceCheckRun: інструкція researcher з D1 → /run профілю price-check з JSON-задачею; без інструкції - false', async () => {
    const { env, db } = setup();
    const begins: Record<string, unknown>[] = [];
    (env as { RUN_REGISTRY?: unknown }).RUN_REGISTRY = {
      getByName: () => ({
        begin: async (r: Record<string, unknown>) => void begins.push(r),
        finish: async () => null,
      }),
    };
    Object.assign(env, {
      BRAIN_URL: 'https://brain.example',
      ASSISTANT_V2: 'on',
      INTERNAL_HMAC_KEY: 'k'.repeat(32),
    });
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
        return new Response('{"ok":true}', { status: 202 });
      }),
    );
    expect(await startPriceCheckRun(env, { chainId: 'c1', task: 'Ціна X' }, NOW)).toBe(false);
    expect(calls).toHaveLength(0);
    const body = '# Дослідник\nШукай ціни.';
    db.prepare(
      `INSERT INTO instructions (name, kind, version_hash, body_md, max_chars, deployed_at) VALUES ('researcher', 'agent', ?, ?, 7000, 'x')`,
    ).run(syncInstructionHash(body), body);
    expect(await startPriceCheckRun(env, { chainId: 'c1', task: 'Ціна X' }, NOW)).toBe(true);
    expect(calls[0]!.url).toBe('https://brain.example/run');
    expect(calls[0]!.body).toMatchObject({
      profile: 'price-check',
      instruction: { name: 'researcher', body_md: body },
    });
    expect(JSON.parse(String((calls[0]!.body.input as { text: string }).text))).toEqual({
      chain_id: 'c1',
      mode: 'price',
      task: 'Ціна X',
      format: 'chat',
    });
    // Сторож прогону - довший за очікування звіту, інакше run закриють до нього.
    expect(begins[0]).toMatchObject({ profile: 'price-check', trigger: 'workflow' });
    expect(Number(begins[0]!.staleMs)).toBeGreaterThan(WAIT_CHECK_MS);
  });

  it('productionIo: адреса зі стану (DM → чат власника), send через outbox з кнопками; без чату - помилка', async () => {
    const { env, db } = setup();
    seedChain(db, 'c1', { chat_id: null, thread_id: 'dm' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"ok":true,"result":{"message_id":1}}', { status: 200 })),
    );
    (env as { TELEGRAM_BOT_TOKEN?: string }).TELEGRAM_BOT_TOKEN = 't';
    const state = (await readChainState(env, 'c1'))!.state as Parameters<typeof productionIo>[2];
    const io = productionIo(env, 'c1', state);
    await io.send('ціна', [[{ text: 'Стоп', callback_data: 'c:c1:stop' }]]);
    const rowo = db.prepare('SELECT chat_id, thread_id, payload_json FROM outbox').get() as {
      chat_id: string;
      thread_id: string | null;
      payload_json: string;
    };
    expect([rowo.chat_id, rowo.thread_id]).toEqual(['777', null]);
    expect(JSON.parse(rowo.payload_json).reply_markup.inline_keyboard[0][0].callback_data).toBe(
      'c:c1:stop',
    );
    expect(() => productionIo(workerEnv({}), 'c1', { ...state, thread_id: '99' })).toThrow(
      /немає чату/,
    );
  });

  it('price-track-kick: 09:00 раз на день - purchase з url без ЖОДНОГО ланцюга → старт; зупинений власником не поновлюється', async () => {
    const { env, db, created } = setup();
    const at0900 = Date.parse('2026-09-07T06:05:00.000Z');
    await runWishesCreate(env, { type: 'purchase', title: 'A', url: URL_HD }, NOW); // ланцюг є
    await runWishesCreate(env, { type: 'purchase', title: 'B' }, NOW); // без url
    const stopped = await runWishesCreate(
      env,
      { type: 'purchase', title: 'C', url: 'https://comfy.ua/c' },
      NOW,
    );
    await cancelPriceTrack(env, stopped.result.id, NOW); // власник натиснув «Стоп»
    (env as { PRICE_TRACK?: unknown }).PRICE_TRACK = undefined;
    await runWishesCreate(env, { type: 'purchase', title: 'D', url: 'https://allo.ua/d' }, NOW); // без ланцюга
    expect(await priceTrackKickTask(env, at0900)).toEqual({ skipped: 'no-binding' });
    (env as { PRICE_TRACK?: unknown }).PRICE_TRACK = {
      create: async (o: { id: string; params: unknown }) => void created.push(o),
      get: async () => ({ sendEvent: async () => undefined }),
    };
    expect(await priceTrackKickTask(env, NOW)).toEqual({ skipped: 'hour' });
    expect(await priceTrackKickTask(env, at0900)).toEqual({ started: 1 });
    expect(
      db
        .prepare(`SELECT count(*) AS n FROM chains WHERE kind = 'price' AND status = 'running'`)
        .get(),
    ).toEqual({ n: 2 });
    expect(await priceTrackKickTask(env, at0900 + 60_000)).toEqual({ skipped: 'done' });
    expect(await env.BRIEFING.get(PRICE_TRACK_KICK_MARKER_KEY)).toBe('2026-09-07');
  });

  it('chain.start(price) через policy: за url створює бажання + ланцюг («↩» - усе геть); за wish_id - лише ланцюг; chain.cancel(price) зупиняє', async () => {
    const { env, db, events } = setup();
    const out = await applyPolicy(
      env,
      {
        kind: 'chain.start',
        payload: { kind: 'price', payload: { url: URL_HD, title: 'HD9200', target_price: 2999 } },
        threadId: '99',
        chatId: 555,
        tainted: false,
      },
      NOW,
    );
    if (out.mode !== 'executed') throw new Error(`mode ${out.mode}`);
    expect(out.result).toMatchObject({
      tracking: true,
      text: expect.stringContaining('Відстежую ціну «HD9200»'),
    });
    await resolveUndo(env, out.undo!.id, NOW + 1);
    expect(db.prepare('SELECT count(*) AS n FROM wishes').get()).toEqual({ n: 0 });
    expect(events).toHaveLength(1);

    const w = await runWishesCreate(
      env,
      { type: 'purchase', title: 'Ігровий', url: 'https://comfy.ua/g', target_price: 1500 },
      NOW + 2,
    );
    await cancelPriceTrack(env, w.result.id, NOW + 3);
    const byId = await applyPolicy(
      env,
      {
        kind: 'chain.start',
        payload: { kind: 'price', payload: { wish_id: w.result.id } },
        tainted: false,
      },
      NOW + 4,
    );
    expect(byId).toMatchObject({
      mode: 'executed',
      result: { wish_id: w.result.id, text: expect.stringContaining('≤ 1 500 грн') },
    });
    const again = await applyPolicy(
      env,
      {
        kind: 'chain.start',
        payload: { kind: 'price', payload: { wish_id: w.result.id } },
        tainted: false,
      },
      NOW + 5,
    );
    expect(again).toMatchObject({ mode: 'executed', result: { text: '«Ігровий» уже відстежую' } });
    expect((again as { undo?: unknown }).undo).toBeUndefined();
    const stop = await applyPolicy(
      env,
      { kind: 'chain.cancel', payload: { kind: 'price' }, tainted: false },
      NOW + 6,
    );
    expect(stop).toMatchObject({
      mode: 'executed',
      result: { cancelled: true, text: 'Зупинив відстеження «Ігровий»' },
    });
    await expect(
      applyPolicy(
        env,
        { kind: 'chain.cancel', payload: { kind: 'price' }, tainted: false },
        NOW + 7,
      ),
    ).rejects.toThrow(/активного відстеження ціни немає/);
    await expect(
      applyPolicy(
        env,
        {
          kind: 'chain.start',
          payload: { kind: 'price', payload: { wish_id: 'nope' } },
          tainted: false,
        },
        NOW,
      ),
    ).rejects.toThrow(/немає/);
    // type у payload моделі не перекриває purchase.
    const forced = await applyPolicy(
      env,
      {
        kind: 'chain.start',
        payload: {
          kind: 'price',
          payload: { type: 'game', title: 'Гра', url: 'https://allo.ua/x' },
        },
        tainted: false,
      },
      NOW + 8,
    );
    expect(forced).toMatchObject({ mode: 'executed', result: { type: 'purchase' } });
  });
});
