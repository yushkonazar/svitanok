// PriceTrack (етап 5 PR-3, S-5-11/S-5-12): парсер звіту Дослідника («## Ціни»),
// формат грошей, старт/дедуп/зупинка ланцюга, машина станів на фейкових
// step/io (перша ціна → мовчання без змін → −5 % → ≤ target → «Стоп»;
// пропуски й алерт на третій; зупинка без події через cancelled; закінчення
// після MAX_DAYS), імена кроків детерміновані, задача price-track-kick,
// виконавці chain.start(price)/chain.cancel(price).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  runPriceTrack,
  startPriceTrack,
  cancelPriceTrack,
  findActivePriceChain,
  parsePrice,
  parsePriceReport,
  pickBest,
  formatMoney,
  priceVerdict,
  checkTask,
  startPriceCheckRun,
  priceTrackKickTask,
  productionIo,
  CHAIN_KIND,
  MAX_DAYS,
  MISSES_ALERT,
  WAIT_CHECK_MS,
  DAY_MS,
  PRICE_TRACK_KICK_MARKER_KEY,
} from '../web/core/chains/price.mjs';
import { readChainState } from '../web/core/chains/state.mjs';
import { runWishesCreate } from '../web/core/tools/wishes.mjs';
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
];
const NOW = Date.parse('2026-09-07T07:00:00.000Z');
const URL_HD = 'https://rozetka.com.ua/ua/philips_hd9200/p1/';

type Step = Parameters<typeof runPriceTrack>[2];
type Io = Parameters<typeof runPriceTrack>[3];

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
      last_price: null,
      ...over,
    }),
  );
}

const report = (lines: string[]) =>
  `## Коротко\n- x\n\n## Ціни\n${lines.join('\n')}\n\n## UNKNOWN\n- немає`;
const COMFY = (p: string) => `- Comfy - ${p} - є в наявності - 07.09.2026 - https://comfy.ua/x`;

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
  it('formatMoney / parsePrice', () => {
    expect(formatMoney(329900, 'UAH')).toBe('3 299 грн');
    expect(formatMoney(329950, 'UAH')).toBe('3 299,50 грн');
    expect(formatMoney(1299, 'USD')).toBe('12,99 $');
    expect(formatMoney(100000000, 'PLN')).toBe('1 000 000 zł');
    expect(formatMoney(500, 'CZK')).toBe('5 CZK');
    expect(parsePrice('3 299 грн')).toEqual({ price: 329900, currency: 'UAH' });
    expect(parsePrice('3299.50 UAH')).toEqual({ price: 329950, currency: 'UAH' });
    expect(parsePrice('$12,99')).toEqual({ price: 1299, currency: 'USD' });
    expect(parsePrice('є в наявності')).toBeNull();
    expect(parsePrice('0 грн')).toBeNull();
    expect(parsePrice('3299')).toBeNull(); // без валюти - не ціна
  });

  it('parsePriceReport: лише розділ «## Ціни», від найнижчої; рядки без ціни/валюти пропускаються; pickBest - наявне', () => {
    const points = parsePriceReport(
      report([
        '- Allo - 3 399 грн - є в наявності, доставка у Львів - 07.09.2026 - https://allo.ua/x',
        '- Comfy - 3 299 грн - під замовлення - 07.09.2026 - https://comfy.ua/x',
        '- Foxtrot - UNKNOWN - немає - 07.09.2026 - https://foxtrot.com.ua/x',
        '- Eldorado - 3 449 грн - немає - 07.09.2026',
        'не рядок',
      ]),
    );
    expect(points.map((p) => [p.source, p.price, p.in_stock, p.url])).toEqual([
      ['Comfy', 329900, false, 'https://comfy.ua/x'],
      ['Allo', 339900, true, 'https://allo.ua/x'],
      ['Eldorado', 344900, false, null],
    ]);
    expect(pickBest(points)?.source).toBe('Allo');
    expect(pickBest([])).toBeNull();
    expect(parsePriceReport('## Коротко\n- нічого')).toEqual([]);
    // Розділ «Факти» після «Ціни» не читається як ціни.
    expect(
      parsePriceReport('## Ціни\n- A - 10 грн - є - д - u\n## Факти\n- B - 5 грн - є - д - u'),
    ).toHaveLength(1);
  });

  it('checkTask несе назву, url і магазини; priceVerdict: перша / target / −5 % / мовчання', () => {
    const state = { ...WISH, wish_id: 'w1', chat_id: 555, thread_id: '99', awaiting: null };
    expect(checkTask(state)).toContain(URL_HD);
    expect(checkTask(state)).toContain('comfy.ua');
    const best = {
      source: 'Comfy',
      price: 329900,
      currency: 'UAH',
      in_stock: true,
      url: 'https://comfy.ua/x',
    };
    expect(priceVerdict(state, best, { prev: null, min: null })).toBe(
      'Перша ціна «Philips HD9200»: 3 299 грн (Comfy: https://comfy.ua/x). Стежу далі.',
    );
    expect(priceVerdict(state, best, { prev: 339900, min: 339900 })).toBeNull(); // −2,9 %
    expect(priceVerdict(state, best, { prev: 349900, min: 349900 })).toBe(
      '📉 «Philips HD9200» подешевшало: 3 299 грн (−6 % від 3 499 грн, мінімум за весь час) - Comfy: https://comfy.ua/x.',
    );
    expect(priceVerdict(state, { ...best, price: 299900 }, { prev: 305000, min: 305000 })).toBe(
      '🎯 «Philips HD9200» - 2 999 грн, не дорожче цільових 2 999 грн (Comfy: https://comfy.ua/x).',
    );
  });
});

describe('старт / зупинка', () => {
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
  });

  it('cancelPriceTrack: cancelled + подія stop; повторно - false; без привʼязки - явна відмова старту', async () => {
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
              '- Allo - 3 150 грн - немає - д - https://allo.ua/x',
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
    expect(sent[0]!.buttons).toEqual(['c:c1:stop']);
    const points = db.prepare('SELECT price, is_low, source FROM price_points ORDER BY at').all();
    expect(points).toEqual([
      { price: 349900, is_low: 1, source: 'Comfy' },
      { price: 342900, is_low: 1, source: 'Comfy' },
      { price: 319900, is_low: 1, source: 'Comfy' }, // Allo дешевше, але немає в наявності
      { price: 299000, is_low: 1, source: 'Comfy' },
    ]);
    expect(log.filter((l) => l.startsWith('wait:d0'))).toEqual([
      'wait:d0-wait:worker',
      'wait:d0-sleep:price',
    ]);
    expect(await readChainState(env, 'c1')).toMatchObject({
      status: 'cancelled',
      state: { last_price: 299000, misses: 0 },
    });
  });

  it('пропуски: без ціни у звіті / мозок мовчить / прогін не стартував - лічильник; третій поспіль - один алерт; успіх скидає', async () => {
    const { env, db } = setup();
    seedChain(db, 'c1');
    const clock = { now: NOW };
    let startOk = true;
    const { step } = fakeStep(
      {
        worker: [
          { output: '## Коротко\n- нічого' },
          null,
          { output: report([COMFY('3 000 грн')]) },
        ],
        price: [null, null, null, { action: 'cancel' }],
      },
      clock,
    );
    const { io, alerts, sent } = fakeIo(clock, { startCheck: async () => startOk });
    // День 2 - прогін не стартує (мозок недоступний).
    const origStart = io.startCheck;
    let day = 0;
    io.startCheck = async (task) => {
      day += 1;
      startOk = day !== 3;
      return origStart(task);
    };
    expect(await runPriceTrack(env, { chainId: 'c1' }, step, io)).toEqual({ outcome: 'cancelled' });
    expect(alerts).toEqual([
      `Відстеження ціни «Philips HD9200»: ${MISSES_ALERT} дні поспіль без ціни (мозок/Дослідник). Ланцюг живе, перевірю завтра.`,
    ]);
    expect(sent.map((s) => s.text)[0]).toContain('Перша ціна');
    expect((await readChainState(env, 'c1'))?.state.misses).toBe(0);
  });

  it('зупинка без події (wishes.update поставив cancelled) - машина зупиняється на наступному записі стану', async () => {
    const { env, db } = setup();
    seedChain(db, 'c1');
    const clock = { now: NOW };
    const { step } = fakeStep(
      { worker: [{ output: report([COMFY('3 000 грн')]) }], price: [null] },
      clock,
    );
    const { io, sent } = fakeIo(clock);
    const orig = step.waitForEvent;
    step.waitForEvent = async (name, opts) => {
      if (name === 'd0-wait')
        db.prepare(`UPDATE chains SET status = 'cancelled' WHERE id = 'c1'`).run();
      return orig(name, opts);
    };
    expect(await runPriceTrack(env, { chainId: 'c1' }, step, io)).toEqual({ outcome: 'cancelled' });
    // Ціна за день 0 збережена, повідомлення про неї є, але далі - зупинка.
    expect(sent.map((s) => s.text)).toEqual([
      'Перша ціна «Philips HD9200»: 3 000 грн (Comfy: https://comfy.ua/x). Стежу далі.',
      'Зупинив відстеження «Philips HD9200».',
    ]);
  });

  it(`після ${MAX_DAYS} днів - done з повідомленням; таймаути очікувань = 10 хв і доба`, async () => {
    const { env, db } = setup();
    seedChain(db, 'c1');
    const clock = { now: NOW };
    const { step, log } = fakeStep({ worker: [], price: [] }, clock);
    const { io, sent } = fakeIo(clock, { startCheck: async () => false });
    expect(await runPriceTrack(env, { chainId: 'c1' }, step, io)).toEqual({ outcome: 'expired' });
    expect(sent.at(-1)!.text).toContain(`завершено після ${MAX_DAYS} днів`);
    expect((await readChainState(env, 'c1'))?.status).toBe('done');
    expect(log.filter((l) => l.startsWith('wait:')).length).toBe(MAX_DAYS);
    expect(clock.now - NOW).toBe(MAX_DAYS * DAY_MS);
    expect(WAIT_CHECK_MS).toBe(10 * 60_000);
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
    expect(
      JSON.parse(String(calls[0]!.body.input && (calls[0]!.body.input as { text: string }).text)),
    ).toEqual({
      chain_id: 'c1',
      mode: 'price',
      task: 'Ціна X',
      format: 'chat',
    });
    expect(begins[0]).toMatchObject({ profile: 'price-check', trigger: 'workflow' });
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

  it('price-track-kick: 09:00 Києва раз на день - purchase з url без активного ланцюга → старт; без url або з ланцюгом - ні', async () => {
    const { env, db, created } = setup();
    const at0900 = Date.parse('2026-09-07T06:05:00.000Z');
    await runWishesCreate(env, { type: 'purchase', title: 'A', url: URL_HD }, NOW); // ланцюг уже є
    await runWishesCreate(env, { type: 'purchase', title: 'B' }, NOW); // без url
    (env as { PRICE_TRACK?: unknown }).PRICE_TRACK = undefined;
    await runWishesCreate(env, { type: 'purchase', title: 'C', url: 'https://comfy.ua/c' }, NOW); // без ланцюга
    expect(await priceTrackKickTask(env, at0900)).toEqual({ skipped: 'no-binding' });
    (env as { PRICE_TRACK?: unknown }).PRICE_TRACK = {
      create: async (o: { id: string; params: unknown }) => void created.push(o),
      get: async () => ({ sendEvent: async () => undefined }),
    };
    expect(await priceTrackKickTask(env, NOW)).toEqual({ skipped: 'hour' });
    expect(await priceTrackKickTask(env, at0900)).toEqual({ started: 1 });
    expect(created).toHaveLength(2);
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
      { type: 'purchase', title: 'Ігровий', url: 'https://comfy.ua/g' },
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
      result: { wish_id: w.result.id, text: 'Відстежую ціну «Ігровий» щодня' },
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
  });
});
