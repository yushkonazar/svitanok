import { afterEach, expect, it, vi } from 'vitest';
import { fetchWeeklyReports } from './client.ts';
vi.mock('../telegram.ts', () => ({
  inTelegram: () => true,
  tg: { initData: 'synthetic-init-data' },
}));
afterEach(() => vi.unstubAllGlobals());
it('authenticates the private read, preserves the exact requested week and never posts', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ history: [], report: null }));
  vi.stubGlobal('fetch', fetch);
  expect(await fetchWeeklyReports('2026-10-19')).toEqual({ history: [], report: null });
  expect(fetch).toHaveBeenCalledWith('/api/reports/weekly?week=2026-10-19', {
    cache: 'no-store',
    headers: { 'X-Telegram-Init-Data': 'synthetic-init-data' },
  });
});
it('does not hide an authorization failure or changed schema with empty or demo data', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(Response.json({}, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ ok: true })),
  );
  await expect(fetchWeeklyReports()).rejects.toThrow();
  await expect(fetchWeeklyReports()).rejects.toThrow('Формат оглядів змінився');
});
