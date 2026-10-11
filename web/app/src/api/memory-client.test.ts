import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fetchMemory, changeMemory } from './client.ts';
import { MemoryChangeError } from './memory-schema.ts';
const mocks = vi.hoisted(() => ({ private: true }));
vi.mock('../telegram.ts', () => ({
  inTelegram: () => mocks.private,
  tg: { initData: 'synthetic-init-data' },
}));
beforeEach(() => {
  mocks.private = true;
});
afterEach(() => vi.unstubAllGlobals());
const command = {
  type: 'remove',
  id: 'habit:day_start',
  token: 'synthetic-event',
  confirm: true,
} as const;
it('never calls the private endpoint from public demo', async () => {
  mocks.private = false;
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  await expect(fetchMemory()).rejects.toThrow('особистому чаті');
  await expect(changeMemory(command)).rejects.toThrow('особистому чаті');
  expect(fetch).not.toHaveBeenCalled();
});
it('uses signed no-store reads and fails honestly on malformed snapshots', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ ok: true }));
  vi.stubGlobal('fetch', fetch);
  await expect(fetchMemory(25)).rejects.toThrow('Формат пам’яті');
  expect(fetch).toHaveBeenCalledWith('/api/memory?offset=25', {
    cache: 'no-store',
    headers: { 'X-Telegram-Init-Data': 'synthetic-init-data' },
  });
});
it('does not retry an uncertain write and requests refresh', async () => {
  const fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
  vi.stubGlobal('fetch', fetch);
  const error = await changeMemory(command).catch((value: unknown) => value);
  expect(error).toBeInstanceOf(MemoryChangeError);
  expect(error).toMatchObject({ refreshRequired: true });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('distinguishes a committed update from an unacknowledged success response', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ ok: true, acknowledged: true, message: 'Прибрано.' }))
    .mockResolvedValueOnce(Response.json({ ok: true }));
  vi.stubGlobal('fetch', fetch);
  await expect(changeMemory(command)).resolves.toEqual({ message: 'Прибрано.', snapshot: null });
  await expect(changeMemory(command)).rejects.toMatchObject({ refreshRequired: true });
  expect(fetch).toHaveBeenCalledTimes(2);
});
it.each([409, 503])(
  'requires refresh after a conflict or uncertain storage failure (%s)',
  async (status) => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ ok: false, error: 'Перевір актуальні записи.' }, { status }),
        ),
    );
    await expect(changeMemory(command)).rejects.toMatchObject({
      message: 'Перевір актуальні записи.',
      refreshRequired: true,
    });
  },
);
