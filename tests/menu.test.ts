// Меню закладів (ідея №3): «чи є в Креденсі сирники?».
//
// Головне, що тут перевіряється, - ПОРЯДОК: своя колекція спершу, мережа лише
// потім і лише за окремим викликом. Саме на цьому економія: питання з кешу не
// коштує ні квоти Places, ні прогону Дослідника, ні ✅ на наступну дію.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runPlacesMenu } from '../web/core/tools/menu.mjs';
import {
  ensureMenuCollection,
  MENU_COLLECTION,
  MENU_FIELDS,
  MENU_FRESH_DAYS,
} from '../web/core/menu/store.mjs';
import { runRecordsCreate, runRecordsSearch } from '../web/core/tools/collections.mjs';
import { TOOLS } from '../web/core/tools/index.mjs';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';
import { d1FromSqlite } from './helpers/d1.js';

const NOW = Date.parse('2026-09-10T10:00:00.000Z');
const MIGRATIONS = [
  '0001_base.sql',
  '0002_assistant.sql',
  '0003_telemetry.sql',
  '0004_ideas_travel.sql',
  '0006_inbox_collections.sql',
  '0008_fts.sql',
];

function setup() {
  const d1 = d1FromSqlite(MIGRATIONS);
  const env = workerEnv({
    DB: d1.stub,
    MAPS_API_KEY: 'k',
    BRIEFING: memoryKv(new Map()),
  });
  return { env, db: d1.db };
}

/** Скільки разів ходили в мережу. */
function stubFetch(...bodies: unknown[]) {
  const calls: string[] = [];
  let i = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(String(url));
      const body = bodies[Math.min(i++, bodies.length - 1)] ?? {};
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
  return calls;
}

const SEARCH_OK = { places: [{ id: 'ChIJmenu1', displayName: { text: 'Креденс' } }] };
const DETAILS_OK = {
  id: 'ChIJmenu1',
  displayName: { text: 'Креденс' },
  websiteUri: 'https://kredens.example/menu',
};

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('колекція', () => {
  it('створюється сама, з полями плану, і вдруге не дублюється', async () => {
    const { env, db } = setup();
    const a = await ensureMenuCollection(env, NOW);
    const b = await ensureMenuCollection(env, NOW + 1000);
    expect(b.id).toBe(a.id);
    const row = db
      .prepare(`SELECT name, fields_json, sort_by FROM collections WHERE id = ?`)
      .get(a.id) as { name: string; fields_json: string; sort_by: string };
    expect(row.name).toBe(MENU_COLLECTION);
    expect(JSON.parse(row.fields_json).map((f: { name: string }) => f.name)).toEqual(
      MENU_FIELDS.map((f) => f.name),
    );
    expect(db.prepare(`SELECT count(*) AS n FROM collections`).get()).toEqual({ n: 1 });
  });
});

describe('порядок пошуку', () => {
  /** Покласти в колекцію знахідку віком `ageDays`. */
  async function note(env: Env, ageDays: number, dish = 'сирники') {
    await ensureMenuCollection(env, NOW);
    await runRecordsCreate(
      env,
      {
        collection: MENU_COLLECTION,
        data: {
          заклад: 'Креденс',
          місто: 'Львів',
          страва: dish,
          джерело: 'https://kredens.example/menu',
          перевірено: new Date(NOW - ageDays * 86_400_000).toISOString().slice(0, 10),
        },
      },
      NOW,
    );
  }

  it('свіжа знахідка = відповідь, і в мережу НЕ йдемо', async () => {
    const { env } = setup();
    await note(env, 3);
    const calls = stubFetch();
    const { result } = await runPlacesMenu(env, { place: 'Креденс', dish: 'сирники' }, NOW);
    expect(result.next).toBe('answer');
    expect(result.found).toHaveLength(1);
    expect(calls).toHaveLength(0); // ⚠️ саме заради цього все й будувалось
  });

  it('відмінок не ховає знахідку: «сирник» знаходить «сирники»', async () => {
    const { env } = setup();
    await note(env, 3);
    stubFetch();
    const { result } = await runPlacesMenu(env, { place: 'Креденсі', dish: 'сирник' }, NOW);
    expect(result.next).toBe('answer');
  });

  it('протухла знахідка - підказка, а не відповідь', async () => {
    const { env } = setup();
    await note(env, MENU_FRESH_DAYS + 5);
    const calls = stubFetch();
    const { result } = await runPlacesMenu(env, { place: 'Креденс', dish: 'сирники' }, NOW);
    expect(result.next).toBe('online');
    expect(result.found).toHaveLength(0);
    expect(result.stale).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });

  it('нічого не знайшли - просимо другий крок, але самі в мережу не лізем', async () => {
    const { env } = setup();
    await ensureMenuCollection(env, NOW);
    const calls = stubFetch();
    const { result } = await runPlacesMenu(env, { place: 'Креденс', dish: 'сирники' }, NOW);
    expect(result.next).toBe('online');
    expect(calls).toHaveLength(0);
  });

  it('online: сайт закладу і доручення Дослідникові', async () => {
    const { env } = setup();
    const calls = stubFetch(SEARCH_OK, DETAILS_OK);
    const { result } = await runPlacesMenu(
      env,
      { place: 'Креденс', dish: 'сирники', city: 'Львів', online: true },
      NOW,
    );
    expect(calls).toHaveLength(2); // пошук + деталі
    expect(result.site).toBe('https://kredens.example/menu');
    expect(result.next).toBe('delegate');
    // Модель має куди записати знахідку - без вигадування назв.
    expect(result.collection).toBe(MENU_COLLECTION);
    expect(result.fields).toContain('перевірено');
  });

  it('сайту немає - кажемо прямо, а не шлемо шукати навмання', async () => {
    const { env } = setup();
    stubFetch(SEARCH_OK, { id: 'ChIJmenu1', displayName: { text: 'Креденс' } });
    const { result } = await runPlacesMenu(
      env,
      { place: 'Креденс', dish: 'сирники', online: true },
      NOW,
    );
    expect(result.site).toBeNull();
    expect(result.next).toBe('no_site');
  });

  it('не-http адреса сайту не доїжджає до Дослідника', async () => {
    const { env } = setup();
    // ⚠️ Адресу пише Google; зіпсована картка не має давати Дослідникові
    // «сторінку», яку він піде відкривати.
    stubFetch(SEARCH_OK, { ...DETAILS_OK, websiteUri: 'javascript:alert(1)' });
    const { result } = await runPlacesMenu(
      env,
      { place: 'Креденс', dish: 'сирники', online: true },
      NOW,
    );
    expect(result.site).toBeNull();
    expect(result.next).toBe('no_site');
  });

  it('назва закладу приходить як зовнішній текст, не голим рядком', async () => {
    const { env } = setup();
    stubFetch(SEARCH_OK, DETAILS_OK);
    const { result } = await runPlacesMenu(
      env,
      { place: 'Креденс', dish: 'сирники', online: true },
      NOW,
    );
    expect(String(result.place)).toContain('<external source="places"');
  });

  it('закладу взагалі немає в довіднику', async () => {
    const { env } = setup();
    stubFetch({ places: [] });
    const { result } = await runPlacesMenu(
      env,
      { place: 'Не існує', dish: 'сирники', online: true },
      NOW,
    );
    expect(result.next).toBe('no_site');
  });

  it('порожні аргументи - чесна помилка', async () => {
    const { env } = setup();
    await expect(runPlacesMenu(env, { place: '', dish: 'x' }, NOW)).rejects.toThrow(/place/);
    await expect(runPlacesMenu(env, { place: 'x', dish: '  ' }, NOW)).rejects.toThrow(/dish/);
  });
});

describe('реєстр', () => {
  it('плямує ЛИШЕ крок у мережу', () => {
    const t = TOOLS['places.menu']!.tainting;
    expect(typeof t).toBe('function');
    // ⚠️ Питання з кешу не має коштувати власнику ✅ на наступну дію.
    expect((t as (a: unknown) => boolean)({ place: 'a', dish: 'b' })).toBe(false);
    expect((t as (a: unknown) => boolean)({ place: 'a', dish: 'b', online: true })).toBe(true);
  });
});

describe('records.search', () => {
  it('знаходить за відмінком - префіксний FTS, як у data.search', async () => {
    const { env } = setup();
    await ensureMenuCollection(env, NOW);
    await runRecordsCreate(
      env,
      {
        collection: MENU_COLLECTION,
        data: { заклад: 'Креденсі', страва: 'сирники', перевірено: '2026-09-01' },
      },
      NOW,
    );
    // ⚠️ Запит КОРОТШИЙ за збережене слово - саме той випадок, на якому точний
    // FTS промахувався: власник чув «немає» про власний же запис.
    const { result } = await runRecordsSearch(env, { q: 'Креденс' });
    expect(result).toHaveLength(1);
  });
});
