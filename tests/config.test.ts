import { describe, it, expect } from 'vitest';
import { parseConfig, loadConfig } from '../src/core/config.js';
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
