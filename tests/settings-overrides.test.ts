import { describe, it, expect } from 'vitest';
import {
  applyModuleOverrides,
  applyTopicMutes,
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
