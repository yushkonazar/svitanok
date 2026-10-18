import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  changeLeisure,
  LeisureSaveUncertainError,
  LeisureCommandRejectedError,
} from './leisure.ts';
import { readRequestDiagnostics } from './request-diagnostics.ts';
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
  it('verifies an existing acknowledgement with GET before any replay', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          verification: {
            found: true,
            fingerprint: JSON.stringify({
              op: command.op,
              id: command.id,
              payload: command.payload,
            }),
            receipt: { id: 'visit-1', message: 'Збережено.' },
          },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetcher);
    expect((await changeLeisure(command, true)).receipt).toMatchObject({ id: 'visit-1' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toContain('?commandId=same-command-id');
    expect(fetcher.mock.calls[0]![1].method).toBeUndefined();
  });
  it('does not accept a receipt that belongs to a different command', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            verification: {
              found: true,
              fingerprint: 'different-command',
              receipt: { message: 'Збережено.' },
            },
          }),
        ),
      ),
    );
    await expect(changeLeisure(command, true)).rejects.toBeInstanceOf(LeisureCommandRejectedError);
  });
  it('records HTTP status, server request id and phase without saving a personal payload', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: 'unavailable',
              diagnostic: { code: 'storage-failure', phase: 'command' },
            }),
            { status: 503, headers: { 'X-Request-Id': 'server-request-id' } },
          ),
        ),
      ),
    );
    await expect(changeLeisure(command)).rejects.toMatchObject({
      diagnostic: {
        status: 503,
        requestId: 'server-request-id',
        phase: 'command',
        code: 'storage-failure',
        layer: 'server',
      },
    });
    expect(JSON.stringify(readRequestDiagnostics())).not.toContain('Обожнюю Marvel');
  });
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
