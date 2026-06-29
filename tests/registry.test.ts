import { describe, it, expect } from 'vitest';
import { partitionModules } from '../src/core/registry.js';
import type { Module } from '../src/core/types.js';

const mod = (id: string, kind: 'producer' | 'consumer'): Module => ({
  id,
  kind,
  enabled: () => true,
  run: async () => null,
});

describe('registry — partitionModules', () => {
  it('розділяє за kind, зберігаючи порядок', () => {
    const { producers, consumers } = partitionModules([
      mod('weather', 'producer'),
      mod('stoic', 'consumer'),
      mod('calendar', 'producer'),
      mod('news', 'consumer'),
    ]);
    expect(producers.map((m) => m.id)).toEqual(['weather', 'calendar']);
    expect(consumers.map((m) => m.id)).toEqual(['stoic', 'news']);
  });
});
