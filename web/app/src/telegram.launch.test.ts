import { afterEach, beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('Telegram', undefined);
  window.history.replaceState(null, '', '/app/');
});
afterEach(() => vi.unstubAllGlobals());

it('reads the SDK start parameter without changing authorization data', async () => {
  const sdk = { initData: 'synthetic-auth', initDataUnsafe: { start_param: 'weekly_20261026' } };
  vi.stubGlobal('Telegram', { WebApp: sdk });
  const { startParam } = await import('./telegram.ts');
  expect(startParam()).toBe('weekly_20261026');
  expect(sdk.initData).toBe('synthetic-auth');
});

it('reads the signed initData field when the SDK unsafe projection is absent', async () => {
  vi.stubGlobal('Telegram', { WebApp: { initData: 'start_param=checkin_2026-11-02_evening' } });
  const { startParam } = await import('./telegram.ts');
  expect(startParam()).toBe('checkin_2026-11-02_evening');
});

it('reads Telegram GET launch data without treating it as authentication', async () => {
  window.history.replaceState(null, '', '/app/?tgWebAppStartParam=weekly_20261026');
  const { startParam, inTelegram } = await import('./telegram.ts');
  expect(startParam()).toBe('weekly_20261026');
  expect(inTelegram()).toBe(false);
});

it.each([
  '#tgWebAppData=synthetic&tgWebAppStartParam=checkin_2026-11-02_morning',
  '#?tgWebAppStartParam=checkin_2026-11-02_morning&tgWebAppVersion=8.0',
])('uses a fresh %s target ahead of an older SDK target', async (fragment) => {
  vi.stubGlobal('Telegram', {
    WebApp: { initData: 'unchanged', initDataUnsafe: { start_param: 'finance' } },
  });
  window.history.replaceState(null, '', `/app/?tgWebAppStartParam=plan${fragment}`);
  const { startParam } = await import('./telegram.ts');
  expect(startParam()).toBe('checkin_2026-11-02_morning');
});

it('reads the transport parameter alongside a normal hash route', async () => {
  window.history.replaceState(
    null,
    '',
    '/app/#/checkin?date=2026-11-02&tgWebAppStartParam=checkin_2026-11-02_morning',
  );
  const { startParam } = await import('./telegram.ts');
  expect(startParam()).toBe('checkin_2026-11-02_morning');
});

it.each(['', 'x'.repeat(513)])(
  'does not revive a stale SDK target for an empty or excessive transport value',
  async (value) => {
    vi.stubGlobal('Telegram', {
      WebApp: { initData: 'unchanged', initDataUnsafe: { start_param: 'finance' } },
    });
    window.history.replaceState(null, '', `/app/?tgWebAppStartParam=${value}`);
    const { startParam } = await import('./telegram.ts');
    expect(startParam()).toBeUndefined();
  },
);

it('does not invent a launch target from an ordinary route', async () => {
  window.history.replaceState(null, '', '/app/#/checkin?date=2026-11-02&slot=morning');
  const { startParam } = await import('./telegram.ts');
  expect(startParam()).toBeUndefined();
});
