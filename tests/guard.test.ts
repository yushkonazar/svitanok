import { describe, it, expect } from 'vitest';
import { sendGuard } from '../src/core/guard.js';
import { createClock } from '../src/core/clock.js';

// Влітку Київ = UTC+3, тож KyivHour = UTC-година + 3.
const atKyiv = (utcIso: string) => createClock(() => new Date(utcIso));

describe('sendGuard — бойове вікно [8, 12)', () => {
  const cfg = { sendHour: 8, sendWindowHours: 4 };

  it('усередині вікна (09:00 Київ) — шле', () => {
    const clock = atKyiv('2026-07-01T06:00:00Z'); // 09:00 Kyiv
    expect(sendGuard({ ...cfg, clock, lastSentDate: null }).send).toBe(true);
  });

  it('нижня межа (08:00 Київ, спізнення cron) — шле', () => {
    const clock = atKyiv('2026-07-01T05:00:00Z'); // 08:00 Kyiv
    expect(sendGuard({ ...cfg, clock, lastSentDate: null }).send).toBe(true);
  });

  it('верхня межа невключна (12:00 Київ) — скіпає', () => {
    const clock = atKyiv('2026-07-01T09:00:00Z'); // 12:00 Kyiv
    expect(sendGuard({ ...cfg, clock, lastSentDate: null }).send).toBe(false);
  });
});

describe('sendGuard — тестовий період [1, 23)', () => {
  const cfg = { sendHour: 1, sendWindowHours: 22 };

  it('23:00 Київ — скіпає (верхня межа)', () => {
    const clock = atKyiv('2026-07-01T20:00:00Z'); // 23:00 Kyiv
    expect(sendGuard({ ...cfg, clock, lastSentDate: null }).send).toBe(false);
  });

  it('00:30 Київ — скіпає (до вікна)', () => {
    const clock = atKyiv('2026-07-01T21:30:00Z'); // 00:30 Kyiv (наступна доба)
    expect(sendGuard({ ...cfg, clock, lastSentDate: null }).send).toBe(false);
  });

  it('12:00 Київ — шле (усередині широкого вікна)', () => {
    const clock = atKyiv('2026-07-01T09:00:00Z'); // 12:00 Kyiv
    expect(sendGuard({ ...cfg, clock, lastSentDate: null }).send).toBe(true);
  });
});

describe('sendGuard — ідемпотентність за київською датою', () => {
  const cfg = { sendHour: 1, sendWindowHours: 22 };

  it('друга джоба того ж дня — скіпає', () => {
    const clock = atKyiv('2026-07-01T09:00:00Z'); // 12:00 Kyiv, todayKey 2026-07-01
    expect(sendGuard({ ...cfg, clock, lastSentDate: '2026-07-01' }).send).toBe(false);
  });

  it('слали вчора — шле сьогодні', () => {
    const clock = atKyiv('2026-07-01T09:00:00Z');
    expect(sendGuard({ ...cfg, clock, lastSentDate: '2026-06-30' }).send).toBe(true);
  });
});

describe('sendGuard — два різні force (workflow_dispatch, B2)', () => {
  const cfg = { sendHour: 8, sendWindowHours: 4 };

  it('force-send обходить вікно ТА ідемпотентність', () => {
    const clock = atKyiv('2026-07-01T00:00:00Z'); // 03:00 Kyiv — поза вікном
    expect(sendGuard({ ...cfg, clock, lastSentDate: '2026-07-01', forceSend: true }).send).toBe(
      true,
    );
  });

  it('force-window обходить лише вікно — сьогоднішній брифінг не перезаписується', () => {
    const clock = atKyiv('2026-07-01T00:00:00Z'); // 03:00 Kyiv — поза вікном
    // Ще не слали сьогодні -> шлемо, хоч і поза вікном.
    expect(sendGuard({ ...cfg, clock, lastSentDate: null, forceWindow: true }).send).toBe(true);
    // Уже слали -> НЕ шлемо (саме це й ламало опублікований брифінг, B2).
    const d = sendGuard({ ...cfg, clock, lastSentDate: '2026-07-01', forceWindow: true });
    expect(d.send).toBe(false);
    expect(d.reason).toContain('idempotent');
  });
});
