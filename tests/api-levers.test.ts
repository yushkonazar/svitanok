import { describe, it, expect } from 'vitest';
import worker from '../web/worker.js';
import { handleLevers } from '../web/api-levers.mjs';
import { LEVERS_KEY } from '../web/kv-store.mjs';
import { LEVER_FEATURE_KEYS, GATE_WEEKS } from '../web/levers-core.mjs';
import { leversSchema } from '../web/app/src/api/schema.ts';
import { workerEnv } from './helpers/env.js';

/* GET /api/levers — читання шару звʼязків.
 *
 * ⚠️ ПРИВАТНИЙ. Тут не «сервіс живий», а звʼязки між сном, настроєм і подачами
 * конкретної людини — щоденник у найщільнішій формі.
 *
 * ⚠️ ТІЛЬКИ ЧИТАННЯ. Рахує крон раз на тиждень; спокуса «порожньо -> порахувати
 * на льоту» відкидається свідомо: саме та вартість (10 мс на запит) і вигнала
 * розрахунок із запиту. */

const env = (value: string | null) =>
  workerEnv({
    BRIEFING: { get: async (k: string) => (k === LEVERS_KEY ? value : null) },
    ASSETS: { fetch: async () => new Response('nf', { status: 404 }) },
  });

const call = (e: Env, headers: Record<string, string> = {}) =>
  worker.fetch(new Request('https://svitanok.yushko.dev/api/levers', { headers }), e, {
    waitUntil: () => {},
  });

const READY = {
  computedAt: '2026-08-17T00:05:00.000Z',
  weekOf: '2026-08-17',
  window: 52,
  firstWeek: '2025-08-18',
  lastWeek: '2026-08-10',
  ready: true,
  weeks: 40,
  weeksNeeded: 0,
  tested: 18,
  shown: 1,
  rows: [
    {
      from: 'sleep',
      to: 'applied',
      lag: 1,
      rho: 0.52,
      rhoDiff: 0.44,
      n: 39,
      nDiff: 37,
      p: 0.0022,
      effect: { high: 11.3, low: 5.3, nHigh: 14, nLow: 25, d: 0.97 },
    },
  ],
  skipped: [{ key: 'roadmap', reason: 'майже стале значення' }],
};

describe('GET /api/levers — доступ', () => {
  it('без initData -> 401, а не дані', async () => {
    const res = await call(env(JSON.stringify(READY)));
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).not.toContain('applied');
  });

  it('не отримує публічних CORS-заголовків (це НЕ /api/status)', async () => {
    const res = await call(env(null));
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  /* ⚠️ ЗНАХІДКА РЕВʼЮ. Ендпоінт read-only, тож POST нічого не ламає — але той
     самий клас уже виправляли для /api/weather/locate-prompt (ревʼю PR #334),
     і лишати новий маршрут відкритим для будь-якого дієслова означає
     повторювати те, від чого щойно відмовились. */
  it.each(['POST', 'PUT', 'DELETE', 'PATCH'])('%s -> 405, а не дані', async (method) => {
    const res = await worker.fetch(
      new Request('https://svitanok.yushko.dev/api/levers', { method }),
      env(JSON.stringify(READY)),
      { waitUntil: () => {} },
    );
    expect(res.status).toBe(405);
    expect(JSON.stringify(await res.json())).not.toContain('applied');
  });

  it('приватне й тижневе — не кешується', async () => {
    const res = await handleLevers(env(JSON.stringify(READY)), { ok: true });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('GET /api/levers — «ще не рахувалось» ≠ «даних замало»', () => {
  /* ⚠️ Два РІЗНІ стани, і клієнт мусить їх розрізняти. null — крон ще жодного
     разу не відпрацював (свіжий деплой до першого понеділка). ready:false —
     відпрацював, але тижнів замало. Злити їх означало б показати «потрібно ще
     N тижнів» там, де правильна відповідь «перший розрахунок у понеділок». */
  it('ключа немає -> levers:null, а не вигаданий порожній стан', async () => {
    const body = (await (await handleLevers(env(null), { ok: true })).json()) as {
      levers: unknown;
    };
    expect(body.levers).toBeNull();
  });

  it('порахований, але до гейта -> ready:false і справжнє N', async () => {
    const raw = JSON.stringify({ ...READY, ready: false, weeks: 6, weeksNeeded: 20, rows: [] });
    const body = (await (await handleLevers(env(raw), { ok: true })).json()) as {
      levers: { ready: boolean; weeks: number; weeksNeeded: number };
    };
    expect(body.levers.ready).toBe(false);
    expect(body.levers.weeks).toBe(6);
    expect(body.levers.weeksNeeded).toBe(20);
  });
});

describe('GET /api/levers — стійкість до битих даних', () => {
  it('битий JSON -> levers:null, а не 500', async () => {
    const res = await handleLevers(env('{ це не json'), { ok: true });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { levers: unknown }).levers).toBeNull();
  });

  it('блоб без мітки тижня нечитабельний -> null', async () => {
    const raw = JSON.stringify({ ready: true, rows: [], tested: 5 });
    expect(
      ((await (await handleLevers(env(raw), { ok: true })).json()) as { levers: unknown }).levers,
    ).toBeNull();
  });

  /* Рядок із невідомою ознакою намалювати нічим — і мовчки показати «→ undefined»
     гірше, ніж не показати рядок. */
  it('рядок із невідомою ознакою відкидається, решта лишається', async () => {
    const raw = JSON.stringify({
      ...READY,
      rows: [...READY.rows, { from: 'вигадка', to: 'applied', lag: 1, rho: 0.9, p: 0.001, n: 30 }],
    });
    const body = (await (await handleLevers(env(raw), { ok: true })).json()) as {
      levers: { rows: { from: string }[] };
    };
    expect(body.levers.rows.map((r) => r.from)).toEqual(['sleep']);
  });

  /* ⚠️ ЗНАХІДКА РЕВʼЮ. `FEATURES['constructor']` на звичайному обʼєкті
     правдиве через ланцюг прототипів, тож такий рядок проходив фільтр і
     доїжджав до екрана порожнім. Той самий клас, від якого в stats-core.mjs
     живе `isSafeKey`. */
  it.each(['constructor', '__proto__', 'prototype', 'toString'])(
    'ознака «%s» не вважається відомою',
    async (key) => {
      const raw = JSON.stringify({
        ...READY,
        rows: [...READY.rows, { ...READY.rows[0], from: key }],
        skipped: [...READY.skipped, { key, reason: 'x' }],
      });
      const body = (await (await handleLevers(env(raw), { ok: true })).json()) as {
        levers: { rows: { from: string }[]; skipped: { key: string }[] };
      };
      expect(body.levers.rows.map((r) => r.from)).toEqual(['sleep']);
      expect(body.levers.skipped.map((x) => x.key)).toEqual(['roadmap']);
    },
  );

  it('виключений ряд із невідомим ключем теж відкидається', async () => {
    const raw = JSON.stringify({
      ...READY,
      skipped: [...READY.skipped, { key: 'вигадка', reason: 'x' }],
    });
    const body = (await (await handleLevers(env(raw), { ok: true })).json()) as {
      levers: { skipped: { key: string }[] };
    };
    expect(body.levers.skipped.map((s) => s.key)).toEqual(['roadmap']);
  });
});

describe('GET /api/levers — підписи й знаменник чесності', () => {
  /* ⚠️ Ярлики підставляє СЕРВЕР із реєстру, а не зберігає крон у KV. Інакше
     перейменування підпису чекало б наступного понеділка, а блоб ріс би
     копіями того, що вже є в коді. */
  it('віддає підписи на ВСІ ознаки реєстру, не лише на показані', async () => {
    const body = (await (await handleLevers(env(JSON.stringify(READY)), { ok: true })).json()) as {
      features: Record<string, { label: string; emoji: string; domainLabel: string }>;
    };
    expect(Object.keys(body.features).sort()).toEqual([...LEVER_FEATURE_KEYS].sort());
    expect(body.features.sleep!.label).toBe('Сон');
    expect(body.features.sleep!.emoji).toBeTruthy();
    expect(body.features.sleep!.domainLabel).toBe('Відновлення');
  });

  /* ⚠️ Готові фрази, а не рід із прикметником у шаблоні на клієнті: без них
     речення на екрані втратило б другу половину, і це було б видно лише очима. */
  it('віддає готові фрази «більше/менше» на кожну ознаку', async () => {
    const body = (await (await handleLevers(env(JSON.stringify(READY)), { ok: true })).json()) as {
      features: Record<string, { more: string; less: string }>;
    };
    for (const [key, f] of Object.entries(body.features)) {
      expect(f.more, key).toBeTruthy();
      expect(f.less, key).toBeTruthy();
      expect(f.more, key).not.toBe(f.less);
    }
    expect(body.features.dayScore!.more).toBe('вища оцінка дня');
    expect(body.features.applied!.less).toBe('менше подач');
  });

  /* Без цих двох чисел три рядки читаються як істина, а не як три вижилі
     з двох десятків перевірених гіпотез. */
  it('tested і shown доїжджають до клієнта', async () => {
    const body = (await (await handleLevers(env(JSON.stringify(READY)), { ok: true })).json()) as {
      levers: { tested: number; shown: number; rows: unknown[] };
    };
    expect(body.levers.tested).toBe(18);
    expect(body.levers.shown).toBe(1);
    expect(body.levers.rows).toHaveLength(1);
  });

  it('гейт їде поруч — екран не має знати число з другого місця', async () => {
    const body = (await (await handleLevers(env(null), { ok: true })).json()) as { gate: number };
    expect(body.gate).toBe(GATE_WEEKS);
  });

  /* ⚠️ Ці поля — єдине, що відрізняє свіжий результат від «крон упав три тижні
     тому, а рядки ті самі». */
  it('мітки свіжості доїжджають', async () => {
    const body = (await (await handleLevers(env(JSON.stringify(READY)), { ok: true })).json()) as {
      levers: { computedAt: string; weekOf: string; firstWeek: string; lastWeek: string };
    };
    expect(body.levers.computedAt).toBe('2026-08-17T00:05:00.000Z');
    expect(body.levers.weekOf).toBe('2026-08-17');
    expect(body.levers.firstWeek).toBe('2025-08-18');
    expect(body.levers.lastWeek).toBe('2026-08-10');
  });
});

describe('GET /api/levers — відповідь сервера проти контракту клієнта', () => {
  /* ⚠️ Тест саме КОРЕНЕВИЙ: лише звідси видно одночасно хендлер воркера й
     схему Mini App, тобто розбіжність між тим, що віддає сервер, і тим, що
     приймає екран (та сама причина, що в dashboard-schema.test.ts). */
  it('справжня відповідь хендлера проходить схему клієнта', async () => {
    const body = await (await handleLevers(env(JSON.stringify(READY)), { ok: true })).json();
    const parsed = leversSchema.safeParse(body);
    expect(parsed.success).toBe(true);
  });

  /* ⚠️ ЗНАХІДКА РЕВʼЮ. Блоб пише крон і перезаписує лише в понеділок. Доти
     `rho`/`p`/`n`/`lag` не мали дефолтів, тож один рядок старішої форми валив
     `safeParse` ЦІЛКОМ — і блок показував би «формат змінився» аж до
     наступного перерахунку. `archiveMonthSchema` двома схемами вище тримає
     протилежне правило саме з цієї причини. */
  it('рядок старішої форми не валить увесь блок, а добирає дефолти', () => {
    const parsed = leversSchema.safeParse({
      levers: {
        weekOf: '2026-08-17',
        ready: true,
        rows: [{ from: 'sleep', to: 'applied' }],
      },
      features: {},
    });
    expect(parsed.success).toBe(true);
    const row = parsed.data!.levers!.rows[0]!;
    expect(row.p).toBe(1);
    expect(row.rho).toBe(0);
    expect(row.effect).toBeNull();
  });

  it('а без мітки тижня схема таки падає — це єдине незамінне поле', () => {
    const parsed = leversSchema.safeParse({ levers: { ready: true, rows: [] }, features: {} });
    expect(parsed.success).toBe(false);
  });
});

describe('GET /api/levers — не рахує, лише читає', () => {
  it('не торкається ключів stats/state (розрахунок — робота крону)', async () => {
    const reads: string[] = [];
    const e = workerEnv({
      BRIEFING: {
        get: async (k: string) => {
          reads.push(k);
          return k === LEVERS_KEY ? JSON.stringify(READY) : null;
        },
      },
    });
    await handleLevers(e, { ok: true });
    expect(reads).toEqual([LEVERS_KEY]);
  });
});
