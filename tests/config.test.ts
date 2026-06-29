import { describe, it, expect } from 'vitest';
import { parseConfig, loadConfig } from '../src/core/config.js';

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
    nextStep: { enabled: true, steps: ['x'] },
    weeklyReview: { enabled: true, day: 'sunday' },
    fact: { enabled: false, batchSize: 30 },
    jobs: { enabled: false, perRun: 3, dedupDays: 7, sources: [] },
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
