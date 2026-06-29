import { describe, it, expect } from 'vitest';
import { resolveQuote, mmdd, stoicModule } from '../src/modules/stoic.js';
import type { Ctx } from '../src/core/types.js';
import type { AppConfig } from '../src/core/config.js';

describe('stoic — вибір цитати', () => {
  it('mmdd зрізає рік', () => {
    expect(mmdd('2026-06-29')).toBe('06-29');
  });

  it('точний MM-DD повертає свою цитату', () => {
    const q = resolveQuote('2025-06-29'); // 06-29 є у даних (Марк Аврелій)
    expect(q?.author).toContain('Марк Аврелій');
  });

  it('02-29 у невисокосний рік -> фолбек на 02-28', () => {
    const leap = resolveQuote('2025-02-29'); // 2025 невисокосний; має дати 02-28
    const feb28 = resolveQuote('2025-02-28');
    expect(leap).toEqual(feb28);
  });

  it('дата без точного запису -> детермінований фолбек (не null, стабільний)', () => {
    const a = resolveQuote('2026-03-03');
    const b = resolveQuote('2026-03-03');
    expect(a).not.toBeNull();
    expect(a).toEqual(b);
  });
});

describe('stoic — модуль', () => {
  const ctx = {
    clock: { todayKey: () => '2026-06-29' },
  } as unknown as Ctx<AppConfig>;

  it('повертає Block з цитатою (priority 10)', async () => {
    const block = await stoicModule.run(ctx);
    expect(block).not.toBeNull();
    expect(block!.priority).toBe(10);
    expect(block!.summary).toContain('«');
  });

  it('enabled читає config.modules.stoic.enabled', () => {
    expect(stoicModule.enabled({ modules: { stoic: { enabled: false } } } as AppConfig)).toBe(
      false,
    );
  });
});
