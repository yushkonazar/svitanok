import { describe, expect, it, vi } from 'vitest';
import { silpoPreflight } from '../scripts/silpo-preflight.mjs';

const origin = 'https://mcp.silpo.ua';
const resource = () =>
  new Response(null, {
    status: 401,
    headers: {
      'WWW-Authenticate': `Bearer realm="OAuth", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
    },
  });
const protectedMetadata = {
  resource: `${origin}/mcp`,
  authorization_servers: [origin],
  bearer_methods_supported: ['header'],
};
const authMetadata = {
  issuer: origin,
  authorization_endpoint: `${origin}/authorize`,
  token_endpoint: `${origin}/token`,
  registration_endpoint: `${origin}/register`,
  code_challenge_methods_supported: ['S256'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
};
const json = (data: unknown) => Response.json(data);
function client(responses: Response[]) {
  return vi.fn<typeof fetch>().mockImplementation(async () => {
    const response = responses.shift();
    if (!response) throw new Error('unexpected request');
    return response;
  });
}

describe('Silpo public preflight', () => {
  it('verifies discovery without claiming catalog access or performing OAuth writes', async () => {
    const request = client([resource(), json(protectedMetadata), json(authMetadata)]);
    const result = await silpoPreflight({ fetch: request });
    expect(result).toMatchObject({
      publicDiscoveryVerified: true,
      authenticatedCatalogVerified: false,
      dailyMonitoringEnabled: false,
    });
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      `${origin}/mcp`,
      `${origin}/.well-known/oauth-protected-resource/mcp`,
      `${origin}/.well-known/oauth-authorization-server`,
    ]);
    for (const [, options] of request.mock.calls) {
      expect(options).toMatchObject({
        method: 'GET',
        credentials: 'omit',
        redirect: 'manual',
        headers: { Accept: 'application/json' },
      });
      expect(options?.body).toBeUndefined();
      expect(options?.signal).toBeInstanceOf(AbortSignal);
    }
  });
  it('never prints extra metadata or response bodies', async () => {
    const secret = 'do-not-log-this';
    const request = client([
      resource(),
      json({ ...protectedMetadata, private: secret }),
      json({ ...authMetadata, note: secret }),
    ]);
    expect(JSON.stringify(await silpoPreflight({ fetch: request }))).not.toContain(secret);
  });
  it.each([200, 302, 403, 429, 503])(
    'stops on unexpected resource status %i without redirect or retry',
    async (status) => {
      const request = client([
        new Response('provider body', { status, headers: { Location: 'https://example.com/' } }),
      ]);
      expect(await silpoPreflight({ fetch: request })).toMatchObject({
        publicDiscoveryVerified: false,
        checks: [{ status, reason: 'unexpected_status' }],
      });
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
  it('rejects a different challenge URL instead of following it', async () => {
    const request = client([
      new Response(null, {
        status: 401,
        headers: { 'WWW-Authenticate': 'Bearer resource_metadata="https://example.com/metadata"' },
      }),
    ]);
    expect((await silpoPreflight({ fetch: request })).checks[0]?.reason).toBe('metadata_changed');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each([
    { ...protectedMetadata, authorization_servers: ['https://example.com/'] },
    { ...protectedMetadata, resource: `${origin}/other` },
    { ...protectedMetadata, bearer_methods_supported: [] },
  ])('rejects changed protected resource metadata', async (data) => {
    const request = client([resource(), json(data)]);
    expect((await silpoPreflight({ fetch: request })).checks[1]?.reason).toBe('metadata_changed');
    expect(request).toHaveBeenCalledTimes(2);
  });
  it.each([
    { ...authMetadata, token_endpoint: 'https://example.com/token' },
    { ...authMetadata, code_challenge_methods_supported: ['plain'] },
    { ...authMetadata, grant_types_supported: ['authorization_code'] },
  ])('rejects changed authorization metadata', async (data) => {
    expect(
      (await silpoPreflight({ fetch: client([resource(), json(protectedMetadata), json(data)]) }))
        .publicDiscoveryVerified,
    ).toBe(false);
  });
  it.each([
    () => new Response('<html>not metadata</html>'),
    () => new Response('{broken', { headers: { 'Content-Type': 'application/json' } }),
    () => json([]),
    () => json({ large: 'x'.repeat(32768) }),
  ])('rejects non-JSON, malformed, array or oversized metadata', async (response) => {
    expect(
      (await silpoPreflight({ fetch: client([resource(), response()]) })).checks[1]?.reason,
    ).toBe('invalid_metadata');
  });
  it.each(['AbortError', 'TimeoutError', 'TypeError'])(
    'sanitizes %s without logging error details',
    async (name) => {
      const request = vi
        .fn<typeof fetch>()
        .mockRejectedValue(Object.assign(new Error('sensitive transport detail'), { name }));
      const result = await silpoPreflight({ fetch: request });
      expect(result.checks[0]?.reason).toBe(name === 'TypeError' ? 'transport_error' : 'timeout');
      expect(JSON.stringify(result)).not.toContain('sensitive');
    },
  );
  it('reports metadata body timeout as timeout, not malformed JSON', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.error(new DOMException('private detail', 'TimeoutError'));
      },
    });
    const request = client([
      resource(),
      new Response(stream, { headers: { 'Content-Type': 'application/json' } }),
    ]);
    const result = await silpoPreflight({ fetch: request });
    expect(result.checks[1]?.reason).toBe('timeout');
    expect(JSON.stringify(result)).not.toContain('private detail');
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('rejects unbounded timeout before any network request', async () => {
    const request = client([]);
    await expect(silpoPreflight({ fetch: request, timeoutMs: 60000 })).rejects.toThrow(
      'invalid_timeout',
    );
    expect(request).not.toHaveBeenCalled();
  });
});
