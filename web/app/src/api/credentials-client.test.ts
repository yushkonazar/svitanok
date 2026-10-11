import { afterEach, expect, it, vi } from 'vitest';
import { fetchCredentials, saveCredentialMetadata } from './client.ts';
vi.mock('../telegram.ts', () => ({
  inTelegram: () => true,
  tg: { initData: 'synthetic-init-data' },
}));
afterEach(() => vi.unstubAllGlobals());
const input = {
  id: 'OPENAI_API_KEY:vps',
  version: 0,
  rotatedAt: null,
  expiresAt: null,
  rotateAfterDays: null,
};
it('reports an ambiguous network failure without pretending metadata was saved', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
  await expect(fetchCredentials()).rejects.toThrow('Не вдалося завантажити');
  await expect(saveCredentialMetadata(input)).rejects.toThrow('Не отримав підтвердження');
});
it('distinguishes a committed update with a failed snapshot from an unproven 200 response', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ ok: true, saved: true }))
    .mockResolvedValueOnce(Response.json({ ok: true }));
  vi.stubGlobal('fetch', fetch);
  await expect(saveCredentialMetadata(input)).rejects.toThrow('Дати збережено');
  await expect(saveCredentialMetadata(input)).rejects.toThrow('Не отримав підтвердження');
});
