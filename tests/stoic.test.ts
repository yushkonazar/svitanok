import { describe, it, expect } from 'vitest';
import { resolveQuote, dayOfYear, stoicModule } from '../src/modules/stoic.js';
import type { Ctx } from '../src/core/types.js';
import type { AppConfig } from '../src/core/config.js';

describe('stoic — вибір цитати (ротація за днем року)', () => {
  it('dayOfYear рахує день року', () => {
    expect(dayOfYear('2026-01-01')).toBe(1);
    expect(dayOfYear('2026-02-01')).toBe(32);
    expect(dayOfYear('2024-12-31')).toBe(366); // 2024 високосний
  });

  it('перший день року -> перша цитата (стабільно між роками)', () => {
    const a = resolveQuote('2026-01-01');
    expect(a).not.toBeNull();
    expect(a).toEqual(resolveQuote('2027-01-01'));
  });

  it('щодня є цитата, вибір детермінований', () => {
    const a = resolveQuote('2026-03-03');
    expect(a).not.toBeNull();
    expect(a).toEqual(resolveQuote('2026-03-03'));
  });

  it('сусідні дні дають різні цитати', () => {
    expect(resolveQuote('2026-01-01')).not.toEqual(resolveQuote('2026-01-02'));
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
