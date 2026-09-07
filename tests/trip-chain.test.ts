// TripChain (етап 5 PR-4, S-5-5…S-5-10): розклад блоків із дат (07 §6),
// чеклісти з D1 (мітки `[авто]`/`[Дослідник]`, abroad-car = ua-car +
// кордонні пункти), вартість авто з фактів, машина станів на фейкових
// step/io (блоки → ✅ пункт → «пора виходити» → «як пройшло»), зміна дат,
// скасування зсередини і ззовні, реєстр кнопок і тексту, погода на дати.

import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  runTripChain,
  startTripChain,
  changeTripDates,
  findActiveTrip,
  schedule,
  daysUntil,
  tripDates,
  isAbroad,
  moneyOf,
  hoursWord,
  weatherNote,
  likeRef,
  failTripChain,
  blocksTitle,
  daysWord,
  tripModeWord,
  productionIo,
  CHAIN_KIND,
} from '../web/core/chains/trip.mjs';
import {
  parseChecklist,
  loadChecklist,
  humanLine,
  renderBlocks,
  renderBlock,
  blocksDueNow,
  pickChecklistKey,
  filesOf,
  parseState,
} from '../web/core/trips/checklist.mjs';
import { listVehicles, fuelPrice, fuelCost, carCostLine } from '../web/core/trips/cost.mjs';
import {
  tripChoiceEvent,
  textEvent,
  findAwaitingChain,
  CHAIN_BINDINGS,
} from '../web/core/chains/registry.mjs';
import { patchChainState } from '../web/core/chains/state.mjs';
import { applyPolicy, resolveUndo } from '../web/core/policy/proposals.mjs';
import { forecastForDates, forecastLine } from '../web/core/adapters/weather.mjs';
import { instructionHash } from '../web/core/instructions.mjs';
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
// Понеділок 07.09.2026 10:00 Києва.
const NOW = Date.parse('2026-09-07T07:00:00.000Z');

type Step = Parameters<typeof runTripChain>[2];
type Io = Parameters<typeof runTripChain>[3];
type Sent = { text: string; buttons: string[]; awaiting: string | null; status: string | null };

const UA_CAR = `# Чекліст: Україна, авто

## Коли застосовується
- Не блок, а опис.

## T-30
- Авто обрано: марка, витрата л/100 км.
- Орієнтовна вартість \`[авто]\`: пальне за формулою.

## T-7
- Погода: прогноз на дати.
- Стан доріг \`[Дослідник]\`: ремонти й обʼїзди.

## T-1
- Заправитись напередодні.

## У дорозі
- Зупинка кожні 2 год.
`;

const ABROAD = `# Чекліст: за кордон

## T-30
- Паспорт: термін дії ≥ 6 місяців.
- Квитки: купити заздалегідь.

## T-7
- Кордон: пункт пропуску і черги \`[Дослідник]\`.
- Роумінг: eSIM на країну.

## T-1
- Онлайн-реєстрація.

## У дорозі
- Страховка під рукою.
`;

function fakeWorkflow() {
  const created: { id: string; params: unknown }[] = [];
  const events: { id: string; ev: unknown }[] = [];
  return {
    created,
    events,
    binding: {
      create: async (o: { id: string; params: unknown }) => void created.push(o),
      get: async (id: string) => ({
        sendEvent: async (ev: unknown) => void events.push({ id, ev }),
      }),
    } as unknown as Env['TRIP_CHAIN'],
  };
}

function setup() {
  const d1 = d1FromSqlite(MIGRATIONS);
  const wf = fakeWorkflow();
  const env = workerEnv({
    DB: d1.stub,
    BRIEFING: memoryKv(new Map()),
    TELEGRAM_CHAT_ID: '555',
    TELEGRAM_OWNER_USER_ID: '777',
    TOPIC_ASSISTANT: '99',
    MAPS_API_KEY: 'k',
    TRIP_CHAIN: wf.binding,
  });
  return { d1, db: d1.db, env, wf };
}

async function seedInstruction(db: ReturnType<typeof setup>['db'], name: string, body: string) {
  db.prepare(
    `INSERT INTO instructions (name, kind, version_hash, body_md, max_chars, deployed_at)
     VALUES (?, 'checklist', ?, ?, 10500, ?)`,
  ).run(name, await instructionHash(body), body, new Date(NOW).toISOString());
}

function seedTrip(
  db: ReturnType<typeof setup>['db'],
  id: string,
  over: Record<string, unknown> = {},
) {
  const row = {
    id,
    from_city: 'Львів',
    to_text: 'Карпати',
    country: 'Україна',
    date_from: '2026-09-10',
    date_to: '2026-09-12',
    mode: 'car',
    vehicle_key: 'octavia',
    checklist_key: 'ua-car',
    workflow_id: id,
    status: 'active',
    ...over,
  };
  db.prepare(
    `INSERT INTO trips (id, wish_id, from_city, to_text, country, date_from, date_to, mode, vehicle_key,
       checklist_key, cost_json, checklist_state_json, workflow_id, status)
     VALUES (@id, NULL, @from_city, @to_text, @country, @date_from, @date_to, @mode, @vehicle_key,
       @checklist_key, NULL, '{"done":[]}', @workflow_id, @status)`,
  ).run(row as never);
}

function seedChain(
  db: ReturnType<typeof setup>['db'],
  id: string,
  state: Record<string, unknown> = {},
) {
  db.prepare(
    `INSERT INTO chains (id, kind, workflow_id, state_json, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'running', 'x', 'x')`,
  ).run(
    id,
    CHAIN_KIND,
    id,
    JSON.stringify({
      trip_id: id,
      to_text: 'Карпати',
      from_city: 'Львів',
      country: 'Україна',
      date_from: '2026-09-10',
      date_to: '2026-09-12',
      mode: 'car',
      vehicle_key: 'octavia',
      checklist_key: 'ua-car',
      depart_at: '08:00',
      chat_id: 555,
      thread_id: '99',
      awaiting: null,
      ...state,
    }),
  );
}

/** Кроки Workflow: do одразу, sleepUntil лише рухає годинник, події `trip` - з черги. */
function fakeStep(queue: (Record<string, unknown> | null)[], clock: { now: number }) {
  const log: string[] = [];
  const names = new Set<string>();
  const step: Step = {
    do: async (name, fn) => {
      if (names.has(name)) throw new Error(`крок «${name}» повторюється`);
      names.add(name);
      log.push(`do:${name}`);
      return fn();
    },
    sleepUntil: async (name, ms) => {
      if (names.has(name)) throw new Error(`крок «${name}» повторюється`);
      names.add(name);
      log.push(`sleep:${name}`);
      clock.now = Math.max(clock.now, ms);
    },
    waitForEvent: async (name, { type, timeout }) => {
      if (names.has(name)) throw new Error(`крок «${name}» повторюється`);
      names.add(name);
      log.push(`wait:${name}:${type}`);
      const next = queue.shift();
      if (next == null) {
        clock.now += Number(String(timeout).replace(' seconds', '')) * 1000;
        throw new Error('timeout');
      }
      return { payload: next };
    },
  };
  return { step, log };
}

function fakeIo(
  db: ReturnType<typeof setup>['db'],
  chainId: string,
  clock: { now: number },
  over: Partial<Io> = {},
) {
  const sent: Sent[] = [];
  const done: string[] = [];
  const costs: Record<string, unknown>[] = [];
  const dates: { from: string; to: string | null }[] = [];
  const finishes: string[] = [];
  const io: Io = {
    now: () => clock.now,
    send: async (text, buttons) => {
      const st = db
        .prepare(
          `SELECT status, json_extract(state_json, '$.awaiting') AS a FROM chains WHERE id = ?`,
        )
        .get(chainId) as { status: string; a: string | null } | undefined;
      sent.push({
        text,
        buttons: (buttons ?? []).flat().map((b) => b.callback_data),
        awaiting: st?.a ?? null,
        status: st?.status ?? null,
      });
    },
    checklist: async () => ({
      t30: [
        { label: 'Авто обрано', text: 'Авто обрано: марка, витрата', marker: null },
        { label: 'Вартість', text: 'Орієнтовна вартість', marker: 'auto' },
      ],
      t7: [{ label: 'Погода', text: 'Погода: прогноз на дати', marker: null }],
      t1: [{ label: 'Заправитись', text: 'Заправитись напередодні', marker: null }],
      road: [{ label: 'Зупинка', text: 'Зупинка кожні 2 год', marker: null }],
    }),
    readDone: async () => [...done],
    markDone: async (id) => void done.push(id),
    route: async () => ({ distance_m: 250_000, duration_min: 200 }),
    carCost: async () => 'Пальне: 500 км × 8 л/100 км × 58.4 грн = 2 336,00 ₴ в обидва боки.',
    weather: async () => ({ lines: ['10.09: 12…19 °, ясно'], reason: null }),
    saveCost: async (patch) => void costs.push(patch),
    saveDates: async (from, to) => void dates.push({ from, to }),
    finish: async (status) => void finishes.push(status),
    ...over,
  };
  return { io, sent, done, costs, dates, finishes };
}

/** Кроки з гачком: побічна дія рівно перед названим кроком (скасування ззовні). */
function stepWithHook(step: Step, at: string, hook: () => Promise<void>): Step {
  const fire = async (name: string) => {
    if (name === at) await hook();
  };
  return {
    do: async (name, fn) => {
      await fire(name);
      return step.do(name, fn);
    },
    sleepUntil: async (name, ms) => {
      await fire(name);
      return step.sleepUntil(name, ms);
    },
    waitForEvent: async (name, opts) => {
      await fire(name);
      return step.waitForEvent(name, opts);
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe('розклад і дрібні помічники', () => {
  it('daysUntil і schedule: далека поїздка - три точки в майбутньому', () => {
    expect(daysUntil('2026-10-12', NOW)).toBe(35);
    const plan = schedule('2026-10-12', NOW);
    expect(plan.map((p) => p.blocks)).toEqual([['t30'], ['t7'], ['t1']]);
    expect(plan.every((p) => p.at > NOW)).toBe(true);
  });

  it('поїздка ближче за 30 днів: T-30 у «зараз», решта у свій час (07 §6)', () => {
    const plan = schedule('2026-09-25', NOW); // 18 днів
    expect(plan[0]).toMatchObject({ at: NOW, blocks: ['t30'] });
    expect(plan.map((p) => p.blocks)).toEqual([['t30'], ['t7'], ['t1']]);
  });

  it('ближче за тиждень - T-30 і T-7 разом; завтра - усі три блоки', () => {
    expect(blocksDueNow(3)).toEqual(['t30', 't7']);
    const near = schedule('2026-09-10', NOW); // 3 дні
    expect(near[0]?.blocks).toEqual(['t30', 't7']);
    expect(near.at(-1)?.blocks).toEqual(['t1']);
    const tomorrow = schedule('2026-09-08', NOW);
    expect(tomorrow).toHaveLength(1);
    expect(tomorrow[0]?.blocks).toEqual(['t30', 't7', 't1']);
  });

  it('рівно 30 діб: блок T-30 показується ОДИН раз (платний маршрут теж один)', () => {
    // 09:00 Києва: рівно 30 діб до виїзду, і момент T-30 (10:00) ще попереду -
    // без захисту блок T-30 пішов би і «зараз», і о 10:00 (два платні маршрути).
    const plan = schedule('2026-10-07', NOW - 3_600_000);
    expect(plan.map((p) => p.blocks)).toEqual([['t30'], ['t7'], ['t1']]);
    expect(plan.filter((p) => p.blocks.includes('t30'))).toHaveLength(1);
  });

  it('дати поїздки, країна, сума й час словами', () => {
    expect(tripDates('2026-09-10', '2026-09-12')).toEqual([
      '2026-09-10',
      '2026-09-11',
      '2026-09-12',
    ]);
    expect(tripDates('2026-09-10', null)).toEqual(['2026-09-10']);
    expect(isAbroad('Польща')).toBe(true);
    expect(isAbroad('Україна')).toBe(false);
    expect(isAbroad('')).toBe(false);
    expect(moneyOf('3 500 грн')).toEqual({ minor: 350_000, currency: 'UAH' });
    expect(moneyOf('1 200,50')).toEqual({ minor: 120_050, currency: 'UAH' });
    // Крапка-тисячник (та сама пастка, що псувала мінімум цін) і валюта.
    expect(moneyOf('3.500')).toEqual({ minor: 350_000, currency: 'UAH' });
    expect(moneyOf('300 usd')).toEqual({ minor: 30_000, currency: 'USD' });
    expect(moneyOf('12 год 20 хв')).toBeNull();
    expect(moneyOf('було чудово')).toBeNull();
    expect(hoursWord(200)).toBe('3 год 20 хв');
    expect(hoursWord(45)).toBe('45 хв');
    expect(tripModeWord('train')).toBe('потяг');
  });
});

describe('чеклісти з D1', () => {
  it('парсер: блоки, мітки в бекапострофах зняті, підпис кнопки - до двокрапки', () => {
    const blocks = parseChecklist(UA_CAR);
    expect(Object.keys(blocks)).toEqual(['t30', 't7', 't1', 'road']);
    expect(blocks.t30?.[1]).toMatchObject({
      marker: 'auto',
      text: 'Орієнтовна вартість: пальне за формулою.',
      label: 'Орієнтовна вартість',
    });
    expect(blocks.t7?.[1]?.marker).toBe('researcher');
    // «Коли застосовується» - не блок чекліста.
    expect(
      Object.values(blocks)
        .flat()
        .some((i) => i.text.includes('Не блок')),
    ).toBe(false);
  });

  it('abroad-car - ua-car плюс лише кордонні пункти другого файлу', async () => {
    const { env, db } = setup();
    await seedInstruction(db, 'ua-car', UA_CAR);
    await seedInstruction(db, 'abroad-plane-bus', ABROAD);
    expect(pickChecklistKey({ mode: 'car', abroad: true })).toBe('abroad-car');
    expect(filesOf('abroad-car')).toEqual(['ua-car', 'abroad-plane-bus']);
    const blocks = await loadChecklist(env, 'abroad-car');
    const t30 = blocks.t30?.map((i) => i.label) ?? [];
    expect(t30).toEqual(['Авто обрано', 'Орієнтовна вартість', 'Паспорт']);
    expect(t30).not.toContain('Квитки');
    // «Роумінг» - теж кордонний пункт (BORDER_RE), «Онлайн-реєстрація» - ні.
    expect(blocks.t7?.map((i) => i.label)).toEqual(['Погода', 'Стан доріг', 'Кордон', 'Роумінг']);
    expect(blocks.t1?.map((i) => i.label)).toEqual(['Заправитись напередодні']);
  });

  it('інструкції немає - помилка, а не порожній чекліст', async () => {
    const { env } = setup();
    await expect(loadChecklist(env, 'ua-car')).rejects.toThrow(/ua-car/);
  });

  it('у чат іде людський рядок, а не інструкція для моделі', () => {
    const body = readFileSync('docs/assistant/checklists/ua-car.md', 'utf8');
    const blocks = parseChecklist(body);
    const view = renderBlocks('c1', {
      blocks: ['t30'],
      items: blocks,
      done: [],
      title: 'Поїздка «Буковель» 10.10 - за місяць:',
    });
    // Ані код-вставок, ані посилань на канон, ані службових дужок.
    expect(view.text).not.toMatch(/[`{}§]/);
    expect(view.text).not.toContain('facts.');
    expect(view.text).not.toContain('routes.eta');
    expect(view.text).not.toContain('T0, owner');
    expect(view.text).toContain('• Авто обрано');
    // Хвіст без машинних слів лишається - він корисний власнику.
    expect(view.text).toContain('• Документи: посвідчення водія');
    expect(humanLine({ label: 'ТО', text: 'ТО: дата й пробіг з `facts`', marker: null })).toBe(
      'ТО',
    );
  });

  it('пунктів більше за стелю - «ще N», і зникають ЗАКРИТІ, а не хвіст списку', () => {
    const items = Array.from({ length: 12 }, (_, i) => ({
      label: `Пункт ${i}`,
      text: `Пункт ${i}`,
      marker: null as null,
    }));
    const view = renderBlocks('c1', {
      blocks: ['t30'],
      items: { t30: items },
      done: ['t30:0', 't30:1'],
      title: 'Чекліст:',
    });
    expect(view.text).not.toContain('Пункт 0');
    expect(view.text).toContain('Пункт 11'); // хвіст видно, бо два закриті
    expect(view.text).not.toContain('ще 0');
    const full = renderBlocks('c1', {
      blocks: ['t30'],
      items: { t30: items },
      done: [],
      title: 'Чекліст:',
    });
    expect(full.text).toContain('…і ще 2 пунктів у цьому блоці.');
    expect(
      full.buttons.flat().filter((b) => b.callback_data.startsWith('c:c1:dt30_')),
    ).toHaveLength(10);
  });

  it('заголовок злитих блоків - за найближчим, дні словом', () => {
    expect(blocksTitle(['t30', 't7'], 'Карпати', '2026-09-10')).toBe(
      'Поїздка «Карпати» 10.09 - за тиждень:',
    );
    expect(blocksTitle(['t30', 't7', 't1'], 'Карпати', '2026-09-10')).toContain('завтра виїзд');
    expect(daysWord(1)).toBe('1 день');
    expect(daysWord(2)).toBe('2 дні');
    expect(daysWord(5)).toBe('5 днів');
    expect(daysWord(11)).toBe('11 днів');
    expect(daysWord(21)).toBe('21 день');
  });

  it('renderBlock: [авто] без кнопки, закритий пункт зник, формат callback', () => {
    const blocks = parseChecklist(UA_CAR);
    const view = renderBlock('c1', {
      block: 't30',
      items: blocks.t30 ?? [],
      done: ['t30:0'],
      title: 'Поїздка «Карпати» 10.09 - за місяць:',
      extra: ['Пальне: 2 336,00 ₴.'],
    });
    expect(view.text).not.toContain('Авто обрано');
    expect(view.text).toContain('Пальне: 2 336,00 ₴.');
    expect(view.buttons.flat().map((b) => b.callback_data)).toEqual([
      'c:c1:newdate',
      'c:c1:cancel',
    ]);
    const all = renderBlock('c1', {
      block: 't7',
      items: blocks.t7 ?? [],
      done: [],
      title: 'T-7',
    });
    expect(all.buttons[0]?.[0]?.callback_data).toBe('c:c1:dt7_0');
    expect(parseState('{"done":["t7:1"]}')).toEqual(['t7:1']);
    expect(parseState('нонсенс')).toEqual([]);
  });
});

describe('вартість авто', () => {
  it('формула пального в обидва боки', () => {
    const cost = fuelCost({ distanceM: 250_000, per100: 8, pricePerLiter: 58.4 });
    expect(cost).toMatchObject({ km: 500, liters: 40 });
    expect(cost.minor).toBe(233_600);
    expect(cost.text).toContain('500 км × 8 л/100 км × 58.4 грн');
  });

  it('факти дають авто й ціну; бракує множника - питання, не «приблизно»', async () => {
    const { env, db } = setup();
    const iso = new Date(NOW).toISOString();
    db.prepare(
      `INSERT INTO facts (id, kind, key, value_json, source, confidence, created_at, updated_at)
       VALUES ('f1', 'vehicle', 'octavia', ?, 'owner', 1, ?, ?)`,
    ).run(JSON.stringify({ name: 'Octavia', per100: 8, fuel: 'A95' }), iso, iso);
    db.prepare(
      `INSERT INTO facts (id, kind, key, value_json, source, confidence, created_at, updated_at)
       VALUES ('f2', 'setting', 'fuel_price', ?, 'owner', 1, ?, ?)`,
    ).run(JSON.stringify({ A95: 58.4 }), iso, iso);
    const vehicles = await listVehicles(env);
    expect(vehicles).toEqual([{ key: 'octavia', name: 'Octavia', per100: 8, fuel: 'A95' }]);
    expect(await fuelPrice(env, 'A95')).toBe(58.4);
    expect(carCostLine({ vehicle: vehicles[0]!, price: 58.4, distanceM: 250_000 })).toContain(
      'Пальне: 500 км',
    );
    expect(carCostLine({ vehicle: vehicles[0]!, price: null, distanceM: 250_000 })).toContain(
      'бракує ціну пального',
    );
    expect(carCostLine({ vehicle: null, price: 58.4, distanceM: null })).toMatch(
      /бракує яке авто.*маршрут/,
    );
  });
});

describe('реєстр: кнопки й текст поїздки', () => {
  it('привʼязка, кнопки блоку, «Змінити дати», «Скасувати»', () => {
    expect(CHAIN_BINDINGS.trip).toBe('TRIP_CHAIN');
    // keep: клавіатура блоку лишається - у блоці кілька пунктів.
    expect(tripChoiceEvent('dt7_3')).toEqual({
      type: 'trip',
      payload: { action: 'done', item: 't7:3' },
      keep: true,
    });
    expect(tripChoiceEvent('newdate')).toEqual({ type: 'trip', payload: { action: 'ask-date' } });
    expect(tripChoiceEvent('cancel')).toEqual({ type: 'trip', payload: { action: 'cancel' } });
    expect(tripChoiceEvent('dt9_1')).toBeNull();
  });

  it('між блоками ланцюг бере лише суму; у підсумку - будь-який текст', () => {
    expect(textEvent('trip', 'checklist', '3 500 грн')).toEqual({
      type: 'trip',
      payload: { action: 'text', text: '3 500 грн' },
    });
    expect(textEvent('trip', 'checklist', 'а що там з погодою?')).toBeNull();
    expect(textEvent('trip', 'spent', 'було чудово, 4 200')).toMatchObject({ type: 'trip' });
    expect(textEvent('trip', 'spent', 'скасуй поїздку')).toBeNull();
  });

  it('findAwaitingChain бачить поїздку, що чекає у своєму треді', async () => {
    const { env, db } = setup();
    seedChain(db, 'c1');
    await patchChainState(env, 'c1', 'waiting', {
      awaiting: 'spent',
      awaiting_since: new Date(NOW).toISOString(),
    });
    expect(await findAwaitingChain(env, '99')).toEqual({
      id: 'c1',
      kind: 'trip',
      awaiting: 'spent',
    });
    expect(await findAwaitingChain(env, 'dm')).toBeNull();
  });
});

/** Виняток «інстанс заснув» - тіло Workflow буде відтворено з початку. */
class Hibernate extends Error {}

/**
 * Кроки Workflow З ПАМʼЯТТЮ, як у платформи: завершений крок не виконується
 * вдруге, а тіло run() проганяється з початку після кожного сну чи таймауту
 * очікування. Саме тут видно помилки, яких не бачить «фейк без памʼяті»:
 * імена кроків, що залежать від часу, і вікна, які мовчки зникають.
 */
function replayStep(clock: { now: number }, events: { at: number; payload: unknown }[]) {
  const memo = new Map<string, { kind: 'value' | 'timeout'; value?: unknown }>();
  const slept = new Set<string>();
  const trace: string[] = [];
  const pending = { restart: false };
  const gate = () => {
    if (!pending.restart) return;
    pending.restart = false;
    throw new Hibernate();
  };
  const step: Step = {
    do: async (name, fn) => {
      gate();
      const hit = memo.get(name);
      if (hit) return hit.value as never;
      const value = await fn();
      memo.set(name, { kind: 'value', value });
      trace.push(`do:${name}`);
      return value;
    },
    sleepUntil: async (name, ms) => {
      gate();
      if (slept.has(name)) return;
      slept.add(name);
      trace.push(`sleep:${name}`);
      clock.now = Math.max(clock.now, ms);
      throw new Hibernate();
    },
    waitForEvent: async (name, { timeout }) => {
      gate();
      const hit = memo.get(name);
      if (hit) {
        if (hit.kind === 'timeout') throw new Error('timeout');
        return { payload: hit.value };
      }
      const deadline = clock.now + Number(String(timeout).replace(' seconds', '')) * 1000;
      const idx = events.findIndex((e) => e.at <= deadline);
      if (idx >= 0) {
        const ev = events.splice(idx, 1)[0]!;
        clock.now = Math.max(clock.now, ev.at);
        memo.set(name, { kind: 'value', value: ev.payload });
        trace.push(`wait:${name}:подія`);
        return { payload: ev.payload };
      }
      memo.set(name, { kind: 'timeout' });
      clock.now = deadline;
      trace.push(`wait:${name}:таймаут`);
      pending.restart = true;
      throw new Error('timeout');
    },
  };
  return { step, trace };
}

/** Прогнати ланцюг до кінця через відтворення (як робить платформа). */
async function runToEnd(
  env: Env,
  chainId: string,
  step: Step,
  io: Io,
  limit = 40,
): Promise<unknown> {
  for (let i = 0; i < limit; i += 1) {
    try {
      return await runTripChain(env, { chainId }, step, io);
    } catch (e) {
      if (!(e instanceof Hibernate)) throw e;
    }
  }
  throw new Error('ланцюг не завершився за відведені прогони');
}

describe('машина станів', () => {
  it('повний прогін: блоки, ✅ пункт, «пора виходити», підсумок із витратами', async () => {
    const { env, db } = setup();
    seedTrip(db, 'c1');
    seedChain(db, 'c1');
    const clock = { now: NOW };
    const { step, log } = fakeStep(
      [
        { action: 'done', item: 't30:0' },
        null, // далі тиша до T-1
        null, // тиша до виїзду
        null, // тиша в дорозі
        { action: 'text', text: '4 200 грн' },
      ],
      clock,
    );
    const { io, sent, done, costs, finishes } = fakeIo(db, 'c1', clock);
    const out = await runTripChain(env, { chainId: 'c1' }, step, io);
    expect(out).toMatchObject({ outcome: 'done', trip_id: 'c1' });
    expect(done).toEqual(['t30:0']);
    expect(costs).toEqual([{ actual: { minor: 420_000, currency: 'UAH' }, note: '4 200 грн' }]);
    expect(finishes).toEqual(['done']);
    // Перший блок - злиті T-30 і T-7 (до поїздки 3 дні): ОДНЕ повідомлення
    // із заголовком за найближчим блоком, пальним і погодою.
    expect(sent[0]?.text).toContain('за тиждень');
    expect(sent[0]?.text).toContain('Пальне:');
    expect(sent[0]?.text).toContain('10.09: 12…19 °, ясно');
    expect(sent.some((s) => s.text.startsWith('Пора виходити'))).toBe(true);
    expect(sent.find((s) => s.text.startsWith('Пора виходити'))?.text).toContain('3 год 20 хв');
    expect(sent.at(-1)?.text).toContain('Записав витрати: 4 200 грн');
    // Стан у базі: питання підсумку ставилось у 'waiting' з awaiting=spent.
    expect(sent.find((s) => s.text.startsWith('Як пройшла'))).toMatchObject({
      awaiting: 'spent',
      status: 'waiting',
    });
    const row = db.prepare('SELECT status FROM chains WHERE id = ?').get('c1') as {
      status: string;
    };
    expect(row.status).toBe('done');
    // Імена кроків детерміновані: жодного повтору (fakeStep кинув би).
    expect(log.filter((l) => l.startsWith('do:')).length).toBeGreaterThan(5);
  });

  it('відтворення тіла: блоки у свої дні, ✅ між блоками не губиться, «пора виходити» за 2 год', async () => {
    const { env, db } = setup();
    // Виїзд 17.09 о 08:00 Києва, сьогодні 07.09 - блоки T-30 (зараз), T-7, T-1.
    seedTrip(db, 'c1', { date_from: '2026-09-17', date_to: '2026-09-19' });
    seedChain(db, 'c1', { date_from: '2026-09-17', date_to: '2026-09-19' });
    const clock = { now: NOW };
    const sent: { at: number; text: string }[] = [];
    const done: string[] = [];
    const { step } = replayStep(clock, [
      // Власник тисне ✅ між блоками - подія має дійти, а не чекати до кінця.
      { at: Date.parse('2026-09-12T09:00:00.000Z'), payload: { action: 'done', item: 't30:0' } },
    ]);
    const io: Io = {
      now: () => clock.now,
      send: async (text) => void sent.push({ at: clock.now, text }),
      checklist: async () => ({
        t30: [{ label: 'Авто', text: 'Авто обрано', marker: null }],
        t7: [{ label: 'Погода', text: 'Погода', marker: null }],
        t1: [{ label: 'Заправитись', text: 'Заправитись', marker: null }],
        road: [{ label: 'Зупинка', text: 'Зупинка', marker: null }],
      }),
      readDone: async () => [...done],
      markDone: async (id) => void done.push(id),
      route: async () => ({ distance_m: 250_000, duration_min: 200 }),
      carCost: async () => 'Пальне: …',
      weather: async () => ({ lines: ['17.09: 12…19 °, ясно'], reason: null }),
      saveCost: async () => {},
      saveDates: async () => {},
      finish: async () => {},
    };
    await runToEnd(env, 'c1', step, io);
    // ✅ дійшло саме між блоками (а не після поїздки).
    expect(done).toEqual(['t30:0']);
    const blocks = sent.filter((m) => m.text.startsWith('Поїздка «Карпати»'));
    expect(blocks.map((m) => new Date(m.at).toISOString())).toEqual([
      '2026-09-07T07:00:00.000Z', // T-30 зараз (до поїздки 10 діб)
      '2026-09-10T07:00:00.000Z', // T-7 о 10:00 Києва
      '2026-09-16T16:00:00.000Z', // T-1 о 19:00 Києва
      '2026-09-17T03:00:00.000Z', // дорожній блок - разом із «пора виходити»
    ]);
    const leave = sent.find((m) => m.text.startsWith('Пора виходити'));
    // Виїзд 08:00 Києва = 05:00Z, повідомлення - за 2 год до нього.
    expect(new Date(leave!.at).toISOString()).toBe('2026-09-17T03:00:00.000Z');
  });

  it('погоди на дати немає - чесний рядок, а не мовчання', async () => {
    const { env, db } = setup();
    seedTrip(db, 'c1');
    seedChain(db, 'c1');
    const clock = { now: NOW };
    const { step } = fakeStep([], clock);
    const { io, sent } = fakeIo(db, 'c1', clock, {
      weather: async () => ({ lines: [], reason: null }),
    });
    await runTripChain(env, { chainId: 'c1' }, step, io);
    expect(sent[0]?.text).toContain('буде ближче до дати');
    // Причина називається: без ключа це НЕ «дати задалеко».
    expect(weatherNote('no-key', '2026-09-10')).toContain('WEATHER_API_KEY не заданий');
    expect(weatherNote('failed', '2026-09-10')).toContain('не відповів');
    expect(weatherNote('no-geo', '2026-09-10')).toContain('координат');
  });

  it('«Змінити дати»: питання, далі подія change-date перепланувала блоки', async () => {
    const { env, db } = setup();
    seedTrip(db, 'c1');
    seedChain(db, 'c1');
    const clock = { now: NOW };
    const { step } = fakeStep(
      [
        { action: 'ask-date' },
        { action: 'change-date', date_from: '2026-09-20', date_to: '2026-09-22' },
        null,
        null,
        null,
        null,
      ],
      clock,
    );
    const { io, sent, dates } = fakeIo(db, 'c1', clock);
    await runTripChain(env, { chainId: 'c1' }, step, io);
    expect(sent.some((s) => s.text.startsWith('Які нові дати'))).toBe(true);
    expect(dates).toEqual([{ from: '2026-09-20', to: '2026-09-22' }]);
    const state = db.prepare('SELECT state_json FROM chains WHERE id = ?').get('c1') as {
      state_json: string;
    };
    expect(JSON.parse(state.state_json).date_from).toBe('2026-09-20');
    // Після переносу блоки надіслані знову - вже під нову дату.
    expect(sent.filter((s) => s.text.includes('Поїздка «Карпати»')).length).toBeGreaterThan(1);
    expect(sent.some((s) => s.text.includes('20.09'))).toBe(true);
  });

  it('подія cancel: поїздка закрита, власнику сказано', async () => {
    const { env, db } = setup();
    seedTrip(db, 'c1');
    seedChain(db, 'c1');
    const clock = { now: NOW };
    const { step } = fakeStep([{ action: 'cancel' }], clock);
    const { io, sent, finishes } = fakeIo(db, 'c1', clock);
    const out = await runTripChain(env, { chainId: 'c1' }, step, io);
    expect(out).toEqual({ outcome: 'cancelled' });
    expect(finishes).toEqual(['cancelled']);
    expect(sent.at(-1)?.text).toBe('Скасував поїздку «Карпати».');
    const row = db.prepare('SELECT status FROM chains WHERE id = ?').get('c1') as {
      status: string;
    };
    expect(row.status).toBe('cancelled');
  });

  it('скасування ПІД ЧАС очікування: ні платного маршруту, ні «Пора виходити»', async () => {
    const { env, db } = setup();
    // Виїзд завтра: усі блоки одним повідомленням, далі одразу день виїзду.
    seedTrip(db, 'c1', { date_from: '2026-09-08', date_to: '2026-09-09' });
    seedChain(db, 'c1', { date_from: '2026-09-08', date_to: '2026-09-09' });
    const clock = { now: NOW };
    const base = fakeStep([null, null], clock);
    const routes: string[] = [];
    const { io, sent } = fakeIo(db, 'c1', clock, {
      route: async (from) => {
        routes.push(from);
        return { distance_m: 250_000, duration_min: 200 };
      },
    });
    // Блоки пішли; поки ланцюг чекає до виїзду, власник каже «скасуй».
    const step = stepWithHook(base.step, 'r0-t30_t7_t1-w-0', async () => {
      await patchChainState(env, 'c1', 'cancelled', { awaiting: null });
    });
    const out = await runTripChain(env, { chainId: 'c1' }, step, io);
    expect(out).toEqual({ outcome: 'cancelled' });
    expect(sent.some((s) => s.text.includes('завтра виїзд'))).toBe(true);
    // Рівно один маршрут - для вартості в блоці T-30; другого (у день
    // виїзду, після сну) немає: скасування помічене ДО платного виклику.
    expect(routes).toEqual(['Львів']);
    expect(sent.some((s) => s.text.startsWith('Пора виходити'))).toBe(false);
  });

  it('вичерпана квота Maps: причина в блоці, а не «не порахував відстань»', async () => {
    const { env, db } = setup();
    seedTrip(db, 'c1');
    seedChain(db, 'c1');
    const clock = { now: NOW };
    const { step } = fakeStep([], clock);
    const quota = Object.assign(
      new Error('Маршрути тимчасово недоступні - стеля 1000 на місяць вичерпана (100 %)'),
      {
        name: 'QuotaExhaustedError',
      },
    );
    const { io, sent } = fakeIo(db, 'c1', clock, {
      route: async () => {
        throw quota;
      },
    });
    await runTripChain(env, { chainId: 'c1' }, step, io);
    expect(sent[0]?.text).toContain('Маршрути тимчасово недоступні');
    expect(sent[0]?.text).not.toContain('бракує');
  });

  it('change-date, що прийшов у вже скасований ланцюг, не воскрешає його', async () => {
    const { env, db } = setup();
    seedTrip(db, 'c1');
    seedChain(db, 'c1');
    const clock = { now: NOW };
    const base = fakeStep(
      [{ action: 'change-date', date_from: '2026-09-20', date_to: null }],
      clock,
    );
    const { io, dates, sent } = fakeIo(db, 'c1', clock);
    // Скасування встигло раніше за подію переносу (тап по старій кнопці).
    const step = stepWithHook(base.step, 'r0-t30_t7-w-0', async () => {
      await patchChainState(env, 'c1', 'cancelled', { awaiting: null });
    });
    const out = await runTripChain(env, { chainId: 'c1' }, step, io);
    expect(out).toEqual({ outcome: 'cancelled' });
    expect(dates).toEqual([]);
    expect(sent.some((s) => s.text.startsWith('Дати оновив'))).toBe(false);
    const row = db.prepare('SELECT status FROM chains WHERE id = ?').get('c1') as {
      status: string;
    };
    expect(row.status).toBe('cancelled');
  });

  it('ланцюг скасовано ззовні («↩») - машина зупиняється, блоків не шле', async () => {
    const { env, db } = setup();
    seedTrip(db, 'c1', { status: 'cancelled' });
    seedChain(db, 'c1');
    await patchChainState(env, 'c1', 'cancelled', { awaiting: null });
    const clock = { now: NOW };
    const { step } = fakeStep([], clock);
    const { io, sent } = fakeIo(db, 'c1', clock);
    const out = await runTripChain(env, { chainId: 'c1' }, step, io);
    expect(out).toEqual({ outcome: 'cancelled' });
    // Ані блоків, ані «Скасував поїздку»: рядок уже cancelled, тобто це
    // chain.cancel із чату - він власнику вже відповів.
    expect(sent).toEqual([]);
  });
});

describe('старт, перенос і скасування з чату', () => {
  it('chain.start kind=trip: рядок trips, ланцюг, Workflow і текст власнику', async () => {
    const { env, db, wf } = setup();
    const out = await applyPolicy(
      env,
      {
        kind: 'chain.start',
        payload: {
          kind: 'trip',
          payload: {
            to: 'Краків',
            country: 'Польща',
            mode: 'car',
            date_from: '2026-10-12',
            date_to: '2026-10-15',
            from_city: 'Львів',
          },
        },
        threadId: '99',
        chatId: 555,
        tainted: false,
      },
      NOW,
    );
    if (out.mode !== 'executed') throw new Error(`mode ${out.mode}`);
    expect(out.result).toMatchObject({ checklist: 'abroad-car' });
    expect(String((out.result as { text: string }).text)).toContain('Поїздка створена');
    const trip = db.prepare('SELECT * FROM trips').get() as Record<string, string>;
    expect(trip).toMatchObject({
      to_text: 'Краків',
      country: 'Польща',
      checklist_key: 'abroad-car',
      status: 'active',
    });
    expect(wf.created).toHaveLength(1);
    // «↩» одразу після старту = скасування поїздки.
    expect(await resolveUndo(env, out.undo!.id, NOW + 1000)).toEqual({
      ok: true,
      status: 'undone',
    });
    const after = db.prepare('SELECT status FROM trips').get() as { status: string };
    expect(after.status).toBe('cancelled');
    expect(wf.events.at(-1)).toMatchObject({ ev: { type: 'trip', payload: { action: 'cancel' } } });
  });

  it('невідомий спосіб, дати навпаки і відсутня привʼязка - відмова без рядка', async () => {
    const { env, db } = setup();
    await expect(
      startTripChain(env, { to: 'Київ', mode: 'ракета', date_from: '2026-10-12' }, NOW, {}),
    ).rejects.toThrow(/невідомий mode/);
    await expect(startTripChain(env, { to: 'Київ', mode: 'car' }, NOW, {})).rejects.toThrow(
      /date_from/,
    );
    await expect(
      startTripChain(
        env,
        { to: 'Київ', mode: 'car', date_from: '2026-10-12', date_to: '2026-10-01' },
        NOW,
        {},
      ),
    ).rejects.toThrow(/раніше/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM trips').get()).toMatchObject({ n: 0 });
    const { env: env2 } = setup();
    (env2 as { TRIP_CHAIN?: unknown }).TRIP_CHAIN = undefined;
    await expect(
      startTripChain(env2, { to: 'Київ', mode: 'car', date_from: '2026-10-12' }, NOW, {}),
    ).rejects.toThrow(/TRIP_CHAIN/);
  });

  it('дата виїзду в минулому - відмова, а не миттєвий прогін усіх блоків', async () => {
    const { env, db } = setup();
    await expect(
      startTripChain(env, { to: 'Київ', mode: 'car', date_from: '2026-09-01' }, NOW, {}),
    ).rejects.toThrow(/у минулому/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM trips').get()).toMatchObject({ n: 0 });
    // Сьогоднішня дата - чинна.
    await expect(
      startTripChain(env, { to: 'Київ', mode: 'car', date_from: '2026-09-07' }, NOW, {}),
    ).resolves.toBeTruthy();
  });

  it('джокер замість назви не скасовує «якусь» поїздку', async () => {
    const { env, db } = setup();
    seedTrip(db, 't1');
    expect(likeRef('%')).toBeNull();
    expect(likeRef('Кар')).toBe('%Кар%');
    await expect(
      applyPolicy(
        env,
        { kind: 'chain.cancel', payload: { kind: 'trip', trip_id: '%' }, tainted: false },
        NOW,
      ),
    ).rejects.toThrow(/активної поїздки немає/);
    const row = db.prepare('SELECT status FROM trips WHERE id = ?').get('t1') as { status: string };
    expect(row.status).toBe('active');
  });

  it('trip_id у payload - перенос дат наявної поїздки подією в живий ланцюг', async () => {
    const { env, db, wf } = setup();
    seedTrip(db, 't1');
    const out = await startTripChain(
      env,
      { trip_id: 't1', date_from: '2026-09-20', date_to: '2026-09-23' },
      NOW,
      {},
    );
    expect(out.result).toMatchObject({ changed: true, rescheduled: true });
    expect(wf.events).toEqual([
      {
        id: 't1',
        ev: {
          type: 'trip',
          payload: { action: 'change-date', date_from: '2026-09-20', date_to: '2026-09-23' },
        },
      },
    ]);
    const row = db.prepare('SELECT date_from, date_to FROM trips WHERE id = ?').get('t1');
    expect(row).toMatchObject({ date_from: '2026-09-20', date_to: '2026-09-23' });
    await expect(changeTripDates(env, 'немає', '2026-09-20', null)).rejects.toThrow(/немає/);
    // Джокери в посиланні на поїздку не роблять «будь-яка поїздка».
    await expect(changeTripDates(env, '%', '2026-09-20', null)).rejects.toThrow(/немає/);
    db.prepare(`UPDATE trips SET status = 'cancelled' WHERE id = 't1'`).run();
    await expect(changeTripDates(env, 't1', '2026-09-25', null)).rejects.toThrow(/активної/);
  });

  it('chain.cancel kind=trip: рядок cancelled, подія в ланцюг, повторно - відмова', async () => {
    const { env, db, wf } = setup();
    seedTrip(db, 't1');
    seedChain(db, 't1');
    expect(await findActiveTrip(env, null)).toMatchObject({ id: 't1', to: 'Карпати' });
    const out = await applyPolicy(
      env,
      { kind: 'chain.cancel', payload: { kind: 'trip' }, tainted: false },
      NOW,
    );
    expect(out).toMatchObject({ mode: 'executed', result: { cancelled: true, trip_id: 't1' } });
    expect(wf.events).toEqual([{ id: 't1', ev: { type: 'trip', payload: { action: 'cancel' } } }]);
    const row = db.prepare('SELECT status FROM trips WHERE id = ?').get('t1') as { status: string };
    expect(row.status).toBe('cancelled');
    await expect(
      applyPolicy(env, { kind: 'chain.cancel', payload: { kind: 'trip' }, tainted: false }, NOW),
    ).rejects.toThrow(/активної поїздки немає/);
  });
});

describe('після ревʼю: звʼязки, скасування за chain_id, видиме падіння', () => {
  it('поїздка створює бажання type=trip і звʼязана з ним (07 §1)', async () => {
    const { env, db } = setup();
    const out = await startTripChain(
      env,
      { to: 'Буковель', mode: 'car', date_from: '2026-10-12', from_city: 'Львів' },
      NOW,
      {},
    );
    const trip = db.prepare('SELECT id, wish_id FROM trips').get() as {
      id: string;
      wish_id: string;
    };
    const wish = db.prepare('SELECT * FROM wishes').get() as Record<string, string>;
    expect(wish).toMatchObject({ type: 'trip', title: 'Буковель', status: 'active' });
    expect(JSON.parse(wish.payload_json!).trip_id).toBe(trip.id);
    expect(trip.wish_id).toBe(wish.id);
    expect((out.result as { wish_id: string }).wish_id).toBe(wish.id);
  });

  it('назва авто з фактів, а не ключ; «за N днів» словом', async () => {
    const { env, db } = setup();
    const iso = new Date(NOW).toISOString();
    db.prepare(
      `INSERT INTO facts (id, kind, key, value_json, source, confidence, created_at, updated_at)
       VALUES ('f1', 'vehicle', 'octavia', ?, 'owner', 1, ?, ?)`,
    ).run(JSON.stringify({ name: 'Octavia', per100: 8, fuel: 'A95' }), iso, iso);
    const out = await startTripChain(
      env,
      {
        to: 'Буковель',
        mode: 'car',
        date_from: '2026-10-31',
        from_city: 'Львів',
        vehicle_key: 'octavia',
      },
      NOW,
      {},
    );
    const text = (out.result as { text: string }).text;
    expect(text).toContain('авто Octavia');
    expect(text).not.toContain('octavia');
    expect(text).not.toContain(' , ');
    expect(text).toContain('за 24 дні');
  });

  it('chain.cancel за chain_id знаходить поїздку', async () => {
    const { env, db } = setup();
    seedTrip(db, 't1', { workflow_id: 'ch-9' });
    seedChain(db, 'ch-9');
    expect(await findActiveTrip(env, 'ch-9')).toMatchObject({ id: 't1' });
    const out = await applyPolicy(
      env,
      { kind: 'chain.cancel', payload: { kind: 'trip', chain_id: 'ch-9' }, tainted: false },
      NOW,
    );
    expect(out).toMatchObject({ mode: 'executed', result: { cancelled: true, trip_id: 't1' } });
  });

  it('падіння ланцюга видиме: статуси failed і рядок власнику', async () => {
    const { env, db } = setup();
    seedTrip(db, 'c1');
    seedChain(db, 'c1');
    await failTripChain(env, 'c1', new Error('Workflow не витримав'));
    const chain = db.prepare('SELECT status FROM chains WHERE id = ?').get('c1') as {
      status: string;
    };
    const trip = db.prepare('SELECT status FROM trips WHERE id = ?').get('c1') as {
      status: string;
    };
    expect(chain.status).toBe('failed');
    expect(trip.status).toBe('failed');
    const row = db.prepare('SELECT payload_json FROM outbox').get() as { payload_json: string };
    expect(JSON.stringify(row)).toContain('зупинився через помилку');
  });

  it('після «Які нові дати?» текст іде в мозок, а не в суму', async () => {
    const { env, db } = setup();
    seedChain(db, 'c1');
    await patchChainState(env, 'c1', 'waiting', {
      awaiting: 'dates',
      awaiting_since: new Date(NOW).toISOString(),
    });
    // Стану 'dates' немає серед текстових станів ланцюга - отже, «12.09»
    // не стане «12,09 ₴», а піде в мозок як нові дати.
    expect(textEvent('trip', 'dates', '12.09')).toBeNull();
    expect(await findAwaitingChain(env, '99')).toBeNull();
  });
});

describe('прогноз на дати поїздки', () => {
  it('бере лише дати поїздки; без ключа - порожньо', async () => {
    const { env } = setup();
    const fetchMock = vi.fn(
      async (_url: string) =>
        new Response(
          JSON.stringify({
            daily: [
              {
                dt: Date.parse('2026-09-10T09:00:00Z') / 1000,
                temp: { min: 11.6, max: 19.2 },
                weather: [{ description: 'ясно' }],
              },
              {
                dt: Date.parse('2026-09-11T09:00:00Z') / 1000,
                temp: { min: 9, max: 15 },
                weather: [{ description: 'дощ' }],
              },
              {
                dt: Date.parse('2026-09-20T09:00:00Z') / 1000,
                temp: { min: 5, max: 10 },
                weather: [{ description: 'хмарно' }],
              },
              // День без температур пропускається: «0…0 °» гірше за мовчання.
              {
                dt: Date.parse('2026-09-12T09:00:00Z') / 1000,
                weather: [{ description: 'сніг' }],
              },
            ],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const out = await forecastForDates(
      { ...env, WEATHER_API_KEY: 'w' } as Env,
      { lat: 48.6, lon: 24.4 },
      ['2026-09-10', '2026-09-11', '2026-09-12'],
    );
    expect(out).toEqual({
      days: [
        { date: '2026-09-10', min: 12, max: 19, desc: 'ясно' },
        { date: '2026-09-11', min: 9, max: 15, desc: 'дощ' },
      ],
      reason: null,
    });
    expect(forecastLine(out.days[0]!)).toBe('10.09: 12…19 °, ясно');
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('exclude=current%2Cminutely%2Chourly%2Calerts');
    // Без ключа причина названа: викликач не скаже «дати задалеко».
    expect(await forecastForDates(env, { lat: 48.6, lon: 24.4 }, ['2026-09-10'])).toEqual({
      days: [],
      reason: 'no-key',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('помилка мережі - порожньо і в лог, ланцюг не падає', async () => {
    const { env } = setup();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    );
    expect(
      await forecastForDates({ ...env, WEATHER_API_KEY: 'w' } as Env, { lat: 1, lon: 2 }, [
        '2026-09-10',
      ]),
    ).toEqual({ days: [], reason: 'failed' });
    expect(err).toHaveBeenCalled();
  });
});

describe('бойове io', () => {
  it('пише в outbox, відмічає пункт і зберігає витрати в trips', async () => {
    const { env, db } = setup();
    seedTrip(db, 'c1');
    seedChain(db, 'c1');
    const state = JSON.parse(
      (db.prepare('SELECT state_json FROM chains WHERE id = ?').get('c1') as { state_json: string })
        .state_json,
    );
    const io = productionIo(env, 'c1', state);
    await io.markDone('t30:0');
    await io.markDone('t30:0'); // повторна кнопка не дублює
    expect(await io.readDone()).toEqual(['t30:0']);
    await io.saveCost({ ticket: 120_000 });
    await io.saveCost({ actual: 350_000 });
    const row = db.prepare('SELECT cost_json, status FROM trips WHERE id = ?').get('c1') as {
      cost_json: string;
      status: string;
    };
    expect(JSON.parse(row.cost_json)).toEqual({ ticket: 120_000, actual: 350_000 });
    await io.saveDates('2026-09-20', null);
    await io.finish('done');
    const after = db.prepare('SELECT date_from, date_to, status FROM trips WHERE id = ?').get('c1');
    expect(after).toMatchObject({ date_from: '2026-09-20', date_to: null, status: 'done' });
  });
});
