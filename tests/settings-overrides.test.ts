import { describe, it, expect } from 'vitest';
import {
  applyModuleOverrides,
  applyTopicMutes,
  applyOwnerGeo,
  formatOverrides,
} from '../src/core/settings-overrides.js';
import type { AppConfig } from '../src/core/config.js';

// Мінімальний конфіг: тут важлива лише секція modules.
const cfg = (mods: Record<string, unknown>) => ({ modules: mods }) as unknown as AppConfig;

/** enabled модуля з конфіга (індексний доступ під noUncheckedIndexedAccess). */
const en = (c: AppConfig, id: string) =>
  (c.modules as unknown as Record<string, { enabled?: unknown }>)[id]?.enabled;

const base = () =>
  cfg({
    weather: { enabled: true },
    news: { enabled: true, perTopic: 3 },
    jobs: { enabled: true },
    calendar: { enabled: false },
  });

describe('settings-overrides — applyModuleOverrides', () => {
  it('вимикає модуль за тумблером Mini App', () => {
    const { config, changes } = applyModuleOverrides(base(), { modules: { news: false } });
    expect(en(config, 'news')).toBe(false);
    expect(en(config, 'weather')).toBe(true);
    expect(changes).toEqual([{ id: 'news', enabled: false }]);
  });

  it('зберігає решту полів модуля, а не тільки enabled', () => {
    const { config } = applyModuleOverrides(base(), { modules: { news: false } });
    const news = (config.modules as unknown as Record<string, { perTopic?: number }>).news;
    expect(news?.perTopic).toBe(3);
  });

  it('вмикає модуль, вимкнений у config.yml (оверрайд діє в обидва боки)', () => {
    const { config, changes } = applyModuleOverrides(base(), { modules: { calendar: true } });
    expect(en(config, 'calendar')).toBe(true);
    expect(changes).toEqual([{ id: 'calendar', enabled: true }]);
  });

  it('не мутує вхідний конфіг', () => {
    const input = base();
    applyModuleOverrides(input, { modules: { news: false } });
    expect(en(input, 'news')).toBe(true);
  });

  it('збіг із дефолтом — не зміна (порожній changes, той самий обʼєкт)', () => {
    const input = base();
    const { config, changes } = applyModuleOverrides(input, { modules: { news: true } });
    expect(changes).toEqual([]);
    expect(config).toBe(input);
  });

  it('відсутні/биті налаштування -> конфіг як є (ран не падає)', () => {
    const input = base();
    for (const bad of [null, undefined, {}, { modules: null }, { modules: 'nope' }, 42, 'x']) {
      const { config, changes } = applyModuleOverrides(input, bad);
      expect(config).toBe(input);
      expect(changes).toEqual([]);
    }
  });

  it('невідомий id та не-boolean значення ігноруються', () => {
    const input = base();
    const { config, changes } = applyModuleOverrides(input, {
      modules: { привид: false, news: 'off', jobs: 1, weather: null },
    });
    expect(config).toBe(input);
    expect(changes).toEqual([]);
  });

  it('кілька тумблерів за раз', () => {
    const { config, changes } = applyModuleOverrides(base(), {
      modules: { news: false, jobs: false, weather: true },
    });
    expect([en(config, 'news'), en(config, 'jobs'), en(config, 'weather')]).toEqual([
      false,
      false,
      true,
    ]);
    expect(changes).toEqual([
      { id: 'news', enabled: false },
      { id: 'jobs', enabled: false },
    ]);
  });

  it('модуль без boolean enabled у конфізі не чіпається', () => {
    const weird = cfg({ news: { enabled: 'yes' } });
    const { config, changes } = applyModuleOverrides(weird, { modules: { news: false } });
    expect(config).toBe(weird);
    expect(changes).toEqual([]);
  });
});

describe('settings-overrides — applyTopicMutes (фільтр тем новин)', () => {
  const withTopics = () =>
    cfg({
      news: {
        enabled: true,
        topics: [
          { scope: 'ua', topic: 'Головне', category: 'top' },
          { scope: 'ua', topic: 'Спорт', category: 'sports' },
          { scope: 'world', topic: 'Наука', category: 'science' },
        ],
      },
    });
  const topicsOf = (c: AppConfig) =>
    (
      (c.modules as unknown as { news: { topics: Array<{ topic: string }> } }).news.topics ?? []
    ).map((t) => t.topic);

  it('ріже приглушену тему з конфіга ДО прогону (економія кредиту)', () => {
    const { config, muted } = applyTopicMutes(withTopics(), { mutedTopics: ['Спорт'] });
    expect(topicsOf(config)).toEqual(['Головне', 'Наука']);
    expect(muted).toEqual(['Спорт']);
  });

  it('порожній/відсутній список — конфіг той самий обʼєкт (без зайвих копій)', () => {
    const c = withTopics();
    expect(applyTopicMutes(c, { mutedTopics: [] }).config).toBe(c);
    expect(applyTopicMutes(c, {}).config).toBe(c);
    expect(applyTopicMutes(c, null).config).toBe(c);
  });

  it('невідома тема нічого не ріже', () => {
    const c = withTopics();
    const { config, muted } = applyTopicMutes(c, { mutedTopics: ['Вигадка'] });
    expect(config).toBe(c);
    expect(muted).toEqual([]);
  });

  it('не мутує вхідний конфіг (чиста функція)', () => {
    const c = withTopics();
    applyTopicMutes(c, { mutedTopics: ['Спорт'] });
    expect(topicsOf(c)).toEqual(['Головне', 'Спорт', 'Наука']);
  });

  it('битий блоб/відсутні теми не валять', () => {
    expect(() => applyTopicMutes(cfg({}), { mutedTopics: ['Спорт'] })).not.toThrow();
    expect(
      applyTopicMutes(cfg({ news: { enabled: true } }), { mutedTopics: ['Спорт'] }).muted,
    ).toEqual([]);
  });

  it('приглушена rss-тема НЕ вирізається з конфіга (безкоштовна, потрібна для peek у Mini App)', () => {
    const c = cfg({
      news: {
        enabled: true,
        topics: [
          { scope: 'ua', topic: 'Головне', category: 'top' },
          {
            scope: 'world',
            topic: 'Кіберспорт',
            source: 'rss',
            url: 'https://dotesports.com/feed',
          },
        ],
      },
    });
    const { config, muted } = applyTopicMutes(c, { mutedTopics: ['Кіберспорт'] });
    // Рядок лишається в конфізі (усе ще фетчиться) — але муж лог "тема приглушена".
    expect(topicsOf(config)).toEqual(['Головне', 'Кіберспорт']);
    expect(muted).toEqual(['Кіберспорт']);
  });

  it('приглушена newsdata-тема далі ріжеться, поруч з непорізаною rss', () => {
    const c = cfg({
      news: {
        enabled: true,
        topics: [
          { scope: 'ua', topic: 'Спорт', category: 'sports' },
          {
            scope: 'world',
            topic: 'Кіберспорт',
            source: 'rss',
            url: 'https://dotesports.com/feed',
          },
        ],
      },
    });
    const { config, muted } = applyTopicMutes(c, { mutedTopics: ['Спорт', 'Кіберспорт'] });
    expect(topicsOf(config)).toEqual(['Кіберспорт']); // Спорт (newsdata) вирізано, Кіберспорт (rss) лишився
    expect(muted).toEqual(['Спорт', 'Кіберспорт']);
  });
});

describe('settings-overrides — formatOverrides', () => {
  it('людський рядок для логу рану', () => {
    expect(
      formatOverrides([
        { id: 'news', enabled: false },
        { id: 'calendar', enabled: true },
      ]),
    ).toBe('news вимкнено, calendar увімкнено');
  });
});

/* Геопозиція власника з Mini App поверх config.locations.
 *
 * ⚠️ ПРИВІД. Локацію можна задати трьома способами — авто-детекція Cloudflare,
 * «Вказати локацію вручну» й пошук міста, — і жоден не доходив до ранкового
 * брифінгу: той крутиться в Actions о 08:00 без браузера й без `request.cf`.
 * Виходило, що власник щодня вказує локацію в застосунку, а брифінг щоранку
 * шле інше місто, і ніде не видно чому. */

const LVIV = { lat: 49.8397, lon: 24.0297, name: 'Львів' };
const RIVNE = { lat: 50.6199, lon: 26.2516, name: 'Рівне' };
const geoCfg = (locations: unknown[]) => ({ locations, modules: {} }) as unknown as AppConfig;

describe('settings-overrides — applyOwnerGeo', () => {
  it('ручний вибір стає першою локацією, налаштована зсувається у другу', () => {
    const kyiv = { lat: 50.45, lon: 30.52, name: 'Київ' };
    const { config, source, name } = applyOwnerGeo(geoCfg([LVIV, RIVNE]), kyiv, null);
    expect(config.locations).toEqual([kyiv, LVIV]);
    expect(source).toBe('manual');
    expect(name).toBe('Київ');
  });

  /* Той самий порядок, що в Mini App (`handleLiveWeather`): два екрани, що
     показують погоду одного ранку, мусять узгоджуватись. */
  it('ручний вибір має пріоритет над авто-детекцією', () => {
    const manual = { lat: 50.45, lon: 30.52, name: 'Київ' };
    const auto = { lat: 48.92, lon: 24.71, name: 'Івано-Франківськ' };
    const { config, source } = applyOwnerGeo(geoCfg([LVIV, RIVNE]), manual, auto);
    expect(config.locations?.[0]).toEqual(manual);
    expect(source).toBe('manual');
  });

  it('без ручного береться авто-детекція', () => {
    const auto = { lat: 48.92, lon: 24.71, name: 'Івано-Франківськ' };
    const { config, source } = applyOwnerGeo(geoCfg([LVIV, RIVNE]), null, auto);
    expect(config.locations).toEqual([auto, LVIV]);
    expect(source).toBe('auto');
  });

  it('жодного сигналу -> config недоторканий', () => {
    const before = geoCfg([LVIV, RIVNE]);
    const { config, source, name } = applyOwnerGeo(before, null, null);
    expect(config).toBe(before);
    expect(source).toBeNull();
    expect(name).toBeNull();
  });

  /* ⚠️ Головна причина, чому оверрайд гейтиться назвою: авто-детекція дає лише
     координати, а назву їй проставляє Worker тоді, коли й так робить зворотне
     геокодування для Mini App. Немає назви — краще лишити налаштоване місто,
     ніж написати «Поточна локація» чи геокодувати тут другим шляхом. */
  it('координати без назви ігноруються, а не показуються без підпису', () => {
    const { config, source } = applyOwnerGeo(geoCfg([LVIV, RIVNE]), null, {
      lat: 48.92,
      lon: 24.71,
    });
    expect(config.locations).toEqual([LVIV, RIVNE]);
    expect(source).toBeNull();
  });

  it.each([
    ['порожня назва', { lat: 48.9, lon: 24.7, name: '   ' }],
    ['lat поза межами', { lat: 91, lon: 24.7, name: 'X' }],
    ['lon поза межами', { lat: 48.9, lon: 181, name: 'X' }],
    ['lat не число', { lat: '48.9', lon: 24.7, name: 'X' }],
    ['NaN', { lat: Number.NaN, lon: 24.7, name: 'X' }],
    ['не обʼєкт', 'Львів'],
    ['null', null],
  ])('битий блоб (%s) -> config недоторканий', (_label, raw) => {
    const { config, source } = applyOwnerGeo(geoCfg([LVIV, RIVNE]), raw, null);
    expect(config.locations).toEqual([LVIV, RIVNE]);
    expect(source).toBeNull();
  });

  /* Власник ТАМ, де вже налаштовано: оверрайд лише продублював би місто в обох
     слотах брифінгу. Це не «не спрацювало», а «нема чого міняти». */
  it('позиція збігається з налаштованою -> без дублювання міста', () => {
    const jitter = { lat: 49.845, lon: 24.035, name: 'Львів' }; // ~0.5 км
    const { config, source } = applyOwnerGeo(geoCfg([LVIV, RIVNE]), jitter, null);
    expect(config.locations).toEqual([LVIV, RIVNE]);
    expect(source).toBeNull();
  });

  it('зсув понад поріг -> оверрайд таки застосовується', () => {
    const moved = { lat: 49.9, lon: 24.1, name: 'Передмістя' }; // ~7 км
    const { config, source } = applyOwnerGeo(geoCfg([LVIV, RIVNE]), moved, null);
    expect(config.locations?.[0]).toEqual(moved);
    expect(source).toBe('manual');
  });

  it('порожній список локацій у конфігу -> одна локація, без падіння', () => {
    const kyiv = { lat: 50.45, lon: 30.52, name: 'Київ' };
    const { config } = applyOwnerGeo(geoCfg([]), kyiv, null);
    expect(config.locations).toEqual([kyiv]);
  });

  it('решта конфіга не чіпається', () => {
    const before = geoCfg([LVIV, RIVNE]);
    const { config } = applyOwnerGeo(before, { lat: 50.45, lon: 30.52, name: 'Київ' }, null);
    expect(config.modules).toBe(before.modules);
    expect(before.locations).toEqual([LVIV, RIVNE]); // вхідний конфіг не мутовано
  });
});
