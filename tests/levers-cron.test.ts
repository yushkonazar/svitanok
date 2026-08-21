import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { computeLevers } from '../web/cron.mjs';
import { CRON_TASKS } from '../web/worker.js';
import { LEVERS_KEY } from '../web/kv-store.mjs';
import { LEVERS_WEEKS_WINDOW, GATE_WEEKS, MIN_CHECKIN_DAYS } from '../web/levers-core.mjs';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';

/* Тижневий перерахунок «Важелів».
 *
 * ⚠️ Гейт тут НЕ за годиною (як у решти задач), а за самим тижнем: мітка —
 * поле `weekOf` у вже записаному результаті. Тобто задача мусить спрацювати
 * рівно раз на першому тіку нового тижня і мовчати решту ~2015 тіків. Саме це
 * тут і пінимо: інакше пʼятихвилинний крон перераховував би все щоп'ять
 * хвилин, а це найдорожча частина статистики. */

const DAY = 86400000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

let kv: Map<string, string>;
let puts: string[];

function env(overrides: Record<string, unknown> = {}) {
  const base = memoryKv(kv);
  return workerEnv({
    BRIEFING: {
      get: base.get,
      put: async (k: string, v: string) => {
        puts.push(k);
        kv.set(k, v);
      },
      list: async () => ({ keys: [] }),
      ...overrides,
    },
  });
}

/* ⚠️ Значення беруться з детермінованого хешу, а НЕ з модульної арифметики.
   Перша версія цього хелпера писала `5 + ((w + d) % 5)`, і всі тижневі середні
   виходили СТАЛИМИ: сума повного періоду по добах тижня однакова для будь-якого
   тижня. Ряди чесно відсіювались гейтом `seriesUsable` («майже стале
   значення»), tested дорівнював нулю, і тест доводив би зовсім не те. */
const hash = (w: number, d: number, salt: number) =>
  ((Math.imul(w * 73 + d * 19 + salt, 2654435761) >>> 8) % 1000) / 1000;

/** Стор із `weeks` тижнів заповненого чек-іну, що закінчуються перед `endIso`. */
function seedStore(weeks: number, endIso: string, daysPerWeek = 5) {
  const end = Date.parse(endIso + 'T00:00:00Z');
  const checkins: Record<string, unknown> = {};
  const days: Record<string, unknown> = {};
  const appliedLog: { url: string; ts: string }[] = [];
  const funnelMeta: Record<string, unknown> = {};
  for (let w = 1; w <= weeks; w++) {
    for (let d = 0; d < daysPerWeek; d++) {
      const key = iso(end - w * 7 * DAY + d * DAY);
      checkins[key] = {
        morning: {
          sleepH: 5 + Math.round(hash(w, d, 1) * 4),
          energy: 1 + Math.round(hash(w, d, 2) * 4),
        },
        evening: {
          dayScore: 1 + Math.round(hash(w, d, 3) * 4),
          mood: 1 + Math.round(hash(w, d, 4) * 4),
          flames: ['chess', 'duolingo', 'tiktok'].slice(0, Math.floor(hash(w, d, 5) * 4)),
        },
      };
      days[key] = {
        opens: Math.floor(hash(w, d, 6) * 6),
        mock: Math.floor(hash(w, d, 7) * 9),
        news: Math.floor(hash(w, d, 8) * 7),
      };
      // Подачі й рух воронки — НЕ по одній на добу: інакше тижневий лічильник
      // сталий, і ряд відсіюється так само, як вище.
      if (hash(w, d, 9) < 0.6) appliedLog.push({ url: `job-${w}-${d}`, ts: key });
      if (hash(w, d, 10) < 0.5) {
        funnelMeta[`job-${w}-${d}`] = {
          title: 'x',
          ts: key,
          history: [{ stage: 'applied', ts: key }],
        };
      }
    }
  }
  return { checkins, days, appliedLog, funnelMeta };
}

beforeEach(() => {
  kv = new Map();
  puts = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('computeLevers — реєстрація в кроні', () => {
  it('задача є у CRON_TASKS і має імʼя (інакше падіння в логах анонімне)', () => {
    const task = CRON_TASKS.find((t) => t.name === 'computeLevers');
    expect(task).toBeDefined();
    expect(task!.run).toBe(computeLevers);
  });
});

describe('computeLevers — тижнева ідемпотентність', () => {
  it('перший тік тижня рахує і кладе результат у власний ключ', async () => {
    vi.setSystemTime(new Date('2026-08-17T00:05:00Z')); // понеділок
    kv.set('stats', JSON.stringify(seedStore(30, '2026-08-17')));
    await computeLevers(env());

    expect(puts).toEqual([LEVERS_KEY]);
    const payload = JSON.parse(kv.get(LEVERS_KEY)!);
    expect(payload.weekOf).toBe('2026-08-17');
    expect(payload.window).toBe(LEVERS_WEEKS_WINDOW);
    expect(typeof payload.computedAt).toBe('string');
    expect(payload.tested).toBeGreaterThan(0);
  });

  /* ⚠️ Найдорожча задача статистики на 5-хвилинному кроні. Без цього гейта
     вона рахувала б 2016 разів на тиждень замість одного. */
  it('решта тіків того самого тижня — жодного запису', async () => {
    vi.setSystemTime(new Date('2026-08-17T00:05:00Z'));
    kv.set('stats', JSON.stringify(seedStore(30, '2026-08-17')));
    await computeLevers(env());
    const first = kv.get(LEVERS_KEY);
    puts.length = 0;

    // ⚠️ Останній тік — 20:55 UTC у неділю, тобто 23:55 за Києвом ТОГО САМОГО
    // тижня. На годину пізніше було б уже понеділок за Києвом, і перерахунок
    // був би правильною поведінкою, а не порушенням.
    for (const t of ['2026-08-17T06:00:00Z', '2026-08-19T12:00:00Z', '2026-08-23T20:55:00Z']) {
      vi.setSystemTime(new Date(t));
      await computeLevers(env());
    }
    expect(puts).toEqual([]);
    expect(kv.get(LEVERS_KEY)).toBe(first);
  });

  it('новий тиждень — перерахунок', async () => {
    vi.setSystemTime(new Date('2026-08-17T00:05:00Z'));
    kv.set('stats', JSON.stringify(seedStore(30, '2026-08-17')));
    await computeLevers(env());
    puts.length = 0;

    vi.setSystemTime(new Date('2026-08-24T00:05:00Z')); // наступний понеділок
    await computeLevers(env());
    expect(puts).toEqual([LEVERS_KEY]);
    expect(JSON.parse(kv.get(LEVERS_KEY)!).weekOf).toBe('2026-08-24');
  });
});

describe('computeLevers — зміст результату', () => {
  it('до гейта віддає «потрібно ще N тижнів», а не порожній список звʼязків', async () => {
    vi.setSystemTime(new Date('2026-08-17T00:05:00Z'));
    kv.set('stats', JSON.stringify(seedStore(6, '2026-08-17')));
    await computeLevers(env());

    const p = JSON.parse(kv.get(LEVERS_KEY)!);
    expect(p.ready).toBe(false);
    expect(p.weeks).toBe(6);
    expect(p.weeksNeeded).toBe(GATE_WEEKS - 6);
    expect(p.rows).toEqual([]);
    expect(p.shown).toBe(0);
  });

  it('після гейта ready=true і знаменник чесності на місці', async () => {
    vi.setSystemTime(new Date('2026-08-17T00:05:00Z'));
    kv.set('stats', JSON.stringify(seedStore(30, '2026-08-17')));
    await computeLevers(env());

    const p = JSON.parse(kv.get(LEVERS_KEY)!);
    expect(p.ready).toBe(true);
    expect(p.weeks).toBeGreaterThanOrEqual(GATE_WEEKS);
    expect(p.weeksNeeded).toBe(0);
    expect(p.tested).toBeGreaterThan(0);
    expect(p.shown).toBe(p.rows.length);
    expect(Array.isArray(p.skipped)).toBe(true);
  });

  /* ⚠️ Ці два поля — єдине, що відрізняє «свіжий результат» від «крон упав
     три тижні тому, а на екрані ті самі рядки». Без них збій деградував би
     мовчки, бо старий payload лишається валідним на вигляд. */
  it('несе межі вікна, за яке порахований', async () => {
    vi.setSystemTime(new Date('2026-08-17T00:05:00Z'));
    kv.set('stats', JSON.stringify(seedStore(30, '2026-08-17')));
    await computeLevers(env());

    const p = JSON.parse(kv.get(LEVERS_KEY)!);
    expect(p.lastWeek).toBe('2026-08-10'); // останній ПОВНИЙ тиждень, не поточний
    expect(p.firstWeek).toBe(iso(Date.parse('2026-08-10T00:00:00Z') - 51 * 7 * DAY));
  });

  it('тижні з явкою нижче порога не рахуються придатними', async () => {
    vi.setSystemTime(new Date('2026-08-17T00:05:00Z'));
    kv.set('stats', JSON.stringify(seedStore(30, '2026-08-17', MIN_CHECKIN_DAYS - 1)));
    await computeLevers(env());
    expect(JSON.parse(kv.get(LEVERS_KEY)!).weeks).toBe(0);
  });

  /* ⚠️ ЗНАХІДКА РЕВʼЮ. Усі сіди тут заповнювали вікно від самого початку, тож
     найсерйозніший дефект блоку — фальшиві нулі в тижнях до появи даних —
     проходив повз усі 78 тестів ядра й крону. Вікно ж 52 тижні, а історія
     коротша: `days` пишеться з 07.07.2026, чек-ін із 17.07. */
  it('вікно ширше за історію: у передісторії діри, а не нулі', async () => {
    vi.setSystemTime(new Date('2026-08-17T00:05:00Z'));
    kv.set('stats', JSON.stringify(seedStore(6, '2026-08-17')));
    await computeLevers(env());

    const p = JSON.parse(kv.get(LEVERS_KEY)!);
    // Пари між лічильниками не показуються: у передісторії немає спільного
    // блоку нулів, який робив би будь-які два ряди схожими.
    expect(p.rows).toEqual([]);
    expect(p.weeks).toBe(6);
  });

  it('порожній стор не падає й дає чесний порожній стан', async () => {
    vi.setSystemTime(new Date('2026-08-17T00:05:00Z'));
    await computeLevers(env());

    const p = JSON.parse(kv.get(LEVERS_KEY)!);
    expect(p.ready).toBe(false);
    expect(p.weeks).toBe(0);
    expect(p.weeksNeeded).toBe(GATE_WEEKS);
  });
});

describe('computeLevers — ізоляція збою (B11)', () => {
  it('биття KV не кидає назовні — решта задач крону виконується', async () => {
    vi.setSystemTime(new Date('2026-08-17T00:05:00Z'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = env({
      put: async () => {
        throw new Error('KV впав');
      },
    });
    await expect(computeLevers(broken)).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
  });

  it('биття у збереженому payload не блокує перерахунок', async () => {
    vi.setSystemTime(new Date('2026-08-17T00:05:00Z'));
    kv.set(LEVERS_KEY, '{ це не JSON');
    kv.set('stats', JSON.stringify(seedStore(30, '2026-08-17')));
    await computeLevers(env());
    expect(JSON.parse(kv.get(LEVERS_KEY)!).weekOf).toBe('2026-08-17');
  });
});
