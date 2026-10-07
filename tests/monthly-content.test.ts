import { expect, it } from 'vitest';
import { monthlyContent } from '../src/core/monthly-content.js';
import { memState } from './helpers/state.js';
import { octoberFacts, octoberQuotes } from '../src/data/content-october.js';
const pool = Array.from({ length: 60 }, (_, i) => ({
  id: `item-${String(i).padStart(2, '0')}`,
  sourceUrl: `https://source.test/${i % 3}`,
}));
const fallback = (date: string) =>
  pool[Math.floor((Date.parse(date) - Date.parse('2026-10-01')) / 86400000) % 60] ?? null;
it('prepares month-sized batches and remembers daily choices across reruns and rollover', () => {
  const state = memState();
  const chosen = [];
  for (let i = 0; i < 60; i++) {
    const date = new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10);
    const a = monthlyContent('facts', date, pool, state, (n) => n.id, fallback);
    expect(monthlyContent('facts', date, pool, state, (n) => n.id, fallback)).toEqual(a);
    chosen.push(a?.id);
  }
  expect(new Set(chosen).size).toBe(60);
  expect(state.get<{ month: string }>('dailyContentPlan:facts')?.month).toBe('2026-11');
});
it('appends new reviewed content with unique references and primary sources', () => {
  expect(octoberFacts).toHaveLength(30);
  expect(octoberQuotes).toHaveLength(30);
  expect(new Set(octoberFacts.map((n) => n.id)).size).toBe(30);
  expect(new Set(octoberQuotes.map((n) => n.author + ':' + n.reference)).size).toBe(30);
  for (const n of [...octoberFacts, ...octoberQuotes]) {
    expect(new URL(n.sourceUrl).protocol).toBe('https:');
    expect(n.verifiedAt).toBe('2026-10-07');
  }
});
