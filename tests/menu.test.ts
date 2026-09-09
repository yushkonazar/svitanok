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
    expect(result.found_count).toBe(1);
    // ⚠️ Вміст записів приїхав колись зі сторінки закладу через Дослідника -
    // тож у моделі він має зʼявитись позначеним, інакше колекція стає каналом,
    // яким чужий текст знімає з себе позначку (security-ревʼю).
    expect(String(result.found)).toContain('<external source="collection:menu"');
    expect(String(result.found)).toContain('Креденс');
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
    expect(result.found_count).toBe(0);
    expect(result.stale_count).toBe(1);
    expect(String(result.stale)).toContain('<external source="collection:menu"');
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
    // ⚠️ Типи й обовʼязковість, а не самі імена: без них `records.create`
    // падав на діапазоні цін, голому домені й забутій даті - і знахідка не
    // кешувалась, тобто мета «щоб удруге не шукати» не досягалась.
    expect(result.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'перевірено', type: 'date', required: true }),
        expect.objectContaining({ name: 'ціна', type: 'money' }),
      ]),
    );
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

  it('ІНШИЙ заклад чи ІНША страва - не відповідь', async () => {
    const { env } = setup();
    await note(env, 3, 'сирний суп');
    stubFetch();
    // ⚠️ FTS шукає за основами по всьому запису, тож у кандидати потрапляє й
    // «Креденс / сирний суп». Без звірки ПОЛІВ асистент упевнено відповідав про
    // інший заклад і про іншу страву - тобто брехав.
    const other = await runPlacesMenu(env, { place: 'Кредо', dish: 'сирники' }, NOW);
    expect(other.result.next).toBe('online');
    const dish = await runPlacesMenu(env, { place: 'Креденс', dish: 'сирники' }, NOW);
    expect(dish.result.next).toBe('online');
    // А той самий заклад і та сама страва у відмінку - знаходяться.
    const hit = await runPlacesMenu(env, { place: 'Креденсі', dish: 'сирний' }, NOW);
    expect(hit.result.next).toBe('answer');
  });

  it('читання НЕ створює колекції, а запис - створює', async () => {
    const { env, db } = setup();
    stubFetch(SEARCH_OK, DETAILS_OK);
    await runPlacesMenu(env, { place: 'Креденс', dish: 'сирники' }, NOW);
    // ⚠️ Видалення колекції - це T2 (✅ і слово). Безшумне відродження на
    // кожне питання відкочувало б рішення власника читанням.
    expect(db.prepare(`SELECT count(*) AS n FROM collections`).get()).toEqual({ n: 0 });
    // А ось коли є що писати - колекція має бути, інакше `records.create` впаде.
    await runPlacesMenu(env, { place: 'Креденс', dish: 'сирники', online: true }, NOW);
    expect(db.prepare(`SELECT count(*) AS n FROM collections`).get()).toEqual({ n: 1 });
  });

  it('внутрішня адреса не доїжджає до Дослідника', async () => {
    for (const site of [
      'http://127.0.0.1:8787/menu',
      'http://169.254.169.254/latest/meta-data',
      'http://10.0.0.5/menu',
      'http://192.168.1.1/menu',
      'https://user:pass@kredens.example/menu',
      'http://router.internal/menu',
      'http://[::1]/menu',
      'http://intranet/menu',
    ]) {
      // ⚠️ Свіже середовище на КОЖНУ адресу: `placeDetails` кешує картку в D1
      // на 7 днів, і спільний env віддавав би результат ПЕРШОЇ ітерації - тобто
      // решта адрес не перевірялась би взагалі (знайдено пробою).
      const { env } = setup();
      stubFetch(SEARCH_OK, { ...DETAILS_OK, websiteUri: site });
      const { result } = await runPlacesMenu(
        env,
        { place: 'Креденс', dish: 'сирники', online: true },
        NOW,
      );
      expect(result.site, site).toBeNull();
      expect(result.next, site).toBe('no_site');
    }
  });

  it('звичайний сайт проходить - фільтр не глушить усе підряд', async () => {
    // Калібрування: без цього попередній тест був би зеленим і на фільтрі,
    // що ріже геть усе.
    const { env } = setup();
    stubFetch(SEARCH_OK, DETAILS_OK);
    const { result } = await runPlacesMenu(
      env,
      { place: 'Креденс', dish: 'сирники', online: true },
      NOW,
    );
    expect(result.site).toBe('https://kredens.example/menu');
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

  it('однолітерний запит не вигрібає все підряд', async () => {
    const { env } = setup();
    await ensureMenuCollection(env, NOW);
    await runRecordsCreate(
      env,
      {
        collection: MENU_COLLECTION,
        data: { заклад: 'Креденс', страва: 'сирники', перевірено: '2026-09-01' },
      },
      NOW,
    );
    // ⚠️ `"к"*` збігається з усім, що починається на «к»: фікс відмінків мовчки
    // розширював поверхню читання до 20 випадкових записів у контекст моделі.
    expect((await runRecordsSearch(env, { q: 'к' })).result).toHaveLength(0);
    expect((await runRecordsSearch(env, { q: 'Кред' })).result).toHaveLength(1);
  });
});
