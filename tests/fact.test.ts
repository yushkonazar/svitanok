import { describe, it, expect, vi } from 'vitest';
import { factModule, resolveFact } from '../src/modules/fact.js';
import { resolveQuote, stoicModule } from '../src/modules/stoic.js';
import { memState } from './helpers/state.js';
import type { Ctx } from '../src/core/types.js';
import type { AppConfig } from '../src/core/config.js';
import facts from '../src/data/verified-facts.json' with { type: 'json' };
import quotes from '../src/data/verified-stoic.json' with { type: 'json' };

function context(date: string, state = memState()) {
  const complete = vi.fn();
  return {
    ctx: { clock: { todayKey: () => date }, state, llm: { complete } } as unknown as Ctx<AppConfig>,
    complete,
  };
}
describe('source-reviewed daily content', () => {
  it('unverified legacy LLM cache is never published; reruns keep the same fact without a paid call', async () => {
    const state = memState({ factCache: ['вигаданий факт'] });
    const { ctx, complete } = context('2026-10-04', state);
    const first = await factModule.run(ctx),
      again = await factModule.run(ctx);
    expect(first?.summary).toContain('три серця');
    expect(again).toEqual(first);
    expect(complete).not.toHaveBeenCalled();
    expect((first?.data as { sourceUrl: string }).sourceUrl).toContain('ocean.si.edu');
    const next = await factModule.run(context('2026-10-05', state).ctx);
    expect(next?.summary).not.toBe(first?.summary);
  });
  it('covers thirty consecutive days without repeats, including month rollover', () => {
    const ids = Array.from(
      { length: 30 },
      (_, i) => resolveFact(new Date(Date.UTC(2026, 9, 20 + i)).toISOString().slice(0, 10))?.id,
    );
    expect(new Set(ids).size).toBe(30);
    expect(resolveFact('bad-date')).toBeNull();
  });
  it('every publishable fact and quote has a reviewed primary-source reference', async () => {
    expect(facts).toHaveLength(30);
    expect(quotes).toHaveLength(30);
    for (const item of [...facts, ...quotes]) {
      const url = new URL(item.sourceUrl);
      expect(url.protocol).toBe('https:');
      expect([
        'science.nasa.gov',
        'www.nasa.gov',
        'ocean.si.edu',
        'home.cern',
        'classics.mit.edu',
        'en.wikisource.org',
      ]).toContain(url.hostname);
      expect(item.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    const block = await stoicModule.run(context('2026-10-04').ctx);
    expect(block?.data).toMatchObject({
      sourceUrl: resolveQuote('2026-10-04')?.sourceUrl,
      translation: 'Власний український переказ',
    });
  });
});
