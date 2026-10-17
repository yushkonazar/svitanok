import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  changeLeisure,
  LeisureSaveUncertainError,
  LeisureCommandRejectedError,
} from './leisure.ts';
vi.mock('../telegram.ts', () => ({ inTelegram: () => true, tg: { initData: 'test-session' } }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const command = {
  commandId: 'same-command-id',
  op: 'visit',
  id: 'film',
  payload: { visitedOn: null, rating: 'liked', reason: 'Обожнюю Marvel' },
};
const ack = () =>
  new Response(JSON.stringify({ ok: true, receipt: { id: 'visit-1', message: 'Збережено.' } }));
describe('leisure save acknowledgement', () => {
  it('replays exactly the original command after a lost response and accepts an acknowledgement without a refreshed workspace', async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('network'))
      .mockResolvedValueOnce(ack());
    vi.stubGlobal('fetch', fetcher);
    const result = await changeLeisure(command);
    expect(result).toMatchObject({ receipt: { id: 'visit-1' }, workspace: null });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]![1].body).toBe(fetcher.mock.calls[1]![1].body);
    expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual(command);
  });
  it('does not retry a known rejection, even when an error response is not JSON', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('Conflict', { status: 409 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(changeLeisure(command)).rejects.toBeInstanceOf(LeisureCommandRejectedError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('preserves uncertainty on repeated server errors instead of claiming a failed write is safe to replace', async () => {
    const fetcher = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response('unavailable', { status: 503 })));
    vi.stubGlobal('fetch', fetcher);
    await expect(changeLeisure(command)).rejects.toBeInstanceOf(LeisureSaveUncertainError);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('does not retry an expired session', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('', { status: 401 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(changeLeisure(command)).rejects.toMatchObject({ status: 401 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
