import { describe, it, expect } from 'vitest';
import { parseConfig, loadConfig, locationsFromEnv } from '../src/core/config.js';
// @ts-expect-error — JS-модуль Worker'а без типів
import { TOGGLEABLE_MODULE_IDS } from '../web/settings-core.mjs';

// Мінімальний валідний конфіг для негативних кейсів.
const valid = {
  timezone: 'Europe/Kyiv',
  sendHour: 8,
  sendWindowHours: 4,
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
    weeklyReview: { enabled: true, day: 'sunday' },
    fact: { enabled: false, batchSize: 30 },
    mock: { enabled: false, batchSize: 15, profile: 'x' },
    currency: { enabled: false },
    onthisday: { enabled: false },
    jobs: { enabled: false, perRun: 3, dedupDays: 7, sources: [] },
    mail: { enabled: false, dedupDays: 3, maxCandidates: 15, query: '' },
  },
  llm: { model: 'claude-x', maxCallsPerRun: 2, timeoutMs: 90000 },
  fetch: { timeoutMs: 30000, retries: 2 },
  telegram: { maxMessageChars: 3900 },
};

describe('config — валідний конфіг', () => {
  it('реальний config.yml завантажується', () => {
    const cfg = loadConfig('config.yml');
    expect(cfg.locations.length).toBeGreaterThanOrEqual(1);
    expect(cfg.sendHour + cfg.sendWindowHours).toBeLessThanOrEqual(24);
  });

  it('тестовий період [1,23] проходить валідацію (§19.6)', () => {
    expect(() => parseConfig({ ...valid, sendHour: 1, sendWindowHours: 22 })).not.toThrow();
  });

  // Теми новин: кожна мусить уміти сказати, ЩО саме тягне. rss — стрічкою (url),
  // newsdata — категорією або пошуком. Тема без цього звелась би до «віддай усе».
  it('кожна тема новин у config.yml має url (rss) або category/q (newsdata)', () => {
    const topics = loadConfig('config.yml').modules.news.topics;
    expect(topics.length).toBeGreaterThan(0);
    for (const t of topics) {
      if (t.source === 'rss') expect(t.url, `rss-тема «${t.topic}» без url`).toBeTruthy();
      else expect(Boolean(t.category || t.q), `тема «${t.topic}» без category і q`).toBe(true);
    }
  });

  // Кредити NewsData: лише newsdata-теми їх витрачають (rss безкоштовні). Тримаємо
  // явний стелаж, щоб розростання переліку не з'їло free-тариф (200/добу) мовчки.
  it('newsdata-тем не більше 50 на прогін (free-тариф 200/добу)', () => {
    const topics = loadConfig('config.yml').modules.news.topics;
    const paid = topics.filter((t) => (t.source ?? 'newsdata') === 'newsdata');
    expect(paid.length).toBeLessThanOrEqual(50);
  });
});

describe('config — невалідний падає гучно', () => {
  it('sendWindowHours 0 — відхиляється', () => {
    expect(() => parseConfig({ ...valid, sendWindowHours: 0 })).toThrow();
  });

  it('інваріант sendHour+window > 24 — відхиляється', () => {
    expect(() => parseConfig({ ...valid, sendHour: 20, sendWindowHours: 10 })).toThrow();
  });

  it('порожній locations — відхиляється', () => {
    expect(() => parseConfig({ ...valid, locations: [] })).toThrow();
  });

  it('sendHour поза 0–23 — відхиляється', () => {
    expect(() => parseConfig({ ...valid, sendHour: 24, sendWindowHours: 0 })).toThrow();
  });
});

describe('config — інваріант перемикних модулів (F2)', () => {
  // Mini App не читає config.yml, тож у налаштуваннях відсутність оверрайду
  // малюється як «увімкнено». Це чесно лише поки ці вісім реально enabled:true
  // у config.yml. Вимкнули котрийсь тут — або приберіть його з
  // TOGGLEABLE_MODULE_IDS, або тумблер почне брехати власнику.
  it('усі перемикні з Mini App модулі увімкнені в config.yml', () => {
    const cfg = loadConfig();
    const mods = cfg.modules as unknown as Record<string, { enabled: boolean }>;
    for (const id of TOGGLEABLE_MODULE_IDS as string[]) {
      expect(mods[id], `модуль ${id}`).toBeDefined();
      expect(mods[id]?.enabled, `модуль ${id} має бути enabled:true`).toBe(true);
    }
  });
});

/* ── Координати власника — зі середовища, не з репозиторію ────────────────
   У config.yml лежали справжні домашні координати з точністю ~1 км: для села
   на дві тисячі людей це адреса, а не «локація погоди». Тепер у файлі лише
   обласні центри, а справжні значення приходять тим самим шляхом, що секрети. */
describe('locationsFromEnv — OWNER_LOCATIONS', () => {
  it('порожньо/пробіли -> null (працює фолбек із config.yml)', () => {
    expect(locationsFromEnv(undefined)).toBeNull();
    expect(locationsFromEnv('')).toBeNull();
    expect(locationsFromEnv('   ')).toBeNull();
  });

  it('валідний JSON -> той самий тип, що в конфігу', () => {
    const got = locationsFromEnv('[{"lat":51.12,"lon":26.46,"name":"Село"}]');
    expect(got).toEqual([{ lat: 51.12, lon: 26.46, name: 'Село' }]);
  });

  /* ⚠️ ПАДАЄ, а не мовчки бере фолбек. Тихий фолбек на публічні координати
     означав би, що власник місяць дивиться погоду чужого міста й не знає про
     це — гірше за видиму помилку на старті. */
  it('битий JSON -> throw з поясненням', () => {
    expect(() => locationsFromEnv('{не json')).toThrow(/не парситься як JSON/);
  });

  it('валідний JSON, але не та форма -> throw', () => {
    for (const bad of ['[]', '[{"lat":1}]', '"рядок"', '{"lat":1,"lon":2,"name":"x"}']) {
      expect(() => locationsFromEnv(bad)).toThrow(/невалідні/);
    }
  });

  it('loadConfig бере OWNER_LOCATIONS замість файлу', () => {
    const cfg = loadConfig('config.yml', {
      OWNER_LOCATIONS: '[{"lat":48.9226,"lon":24.7111,"name":"Івано-Франківськ"}]',
    } as NodeJS.ProcessEnv);
    expect(cfg.locations).toEqual([{ lat: 48.9226, lon: 24.7111, name: 'Івано-Франківськ' }]);
  });

  /* Головна асерція всієї правки: у самому файлі домашніх координат немає. */
  it('config.yml без змінної -> ПУБЛІЧНІ обласні центри, не домашні координати', () => {
    const cfg = loadConfig('config.yml', {} as NodeJS.ProcessEnv);
    expect(cfg.locations.map((l) => l.name)).toEqual(['Львів', 'Рівне']);
  });
});
