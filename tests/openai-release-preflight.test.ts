import { describe, expect, it, vi } from 'vitest';
import { probeOpenAiRelease } from '../scripts/openai-release-preflight.mjs';

function fetcher(catalogue = 200, modelHttp = 200) {
  return vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    if (String(url).includes('/models/')) return Response.json({}, { status: catalogue });
    const body = JSON.parse(String(init?.body));
    return Response.json(
      {
        model: body.model,
        status: 'completed',
        usage: { input_tokens: 50, output_tokens: 20 },
        output: body.tools
          ? [{ type: 'function_call', name: 'release_probe', arguments: '{"ready":true}' }]
          : [{ type: 'message', content: [{ type: 'output_text', text: '{"items":["0"]}' }] }],
      },
      { status: modelHttp },
    );
  });
}
describe('explicit production OpenAI model preflight', () => {
  it('makes two bounded synthetic probes and never sends Astra or executes a Core action', async () => {
    const fetchFn = fetcher();
    const result = await probeOpenAiRelease('private-key', fetchFn);
    expect(result.ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(4);
    const requests = fetchFn.mock.calls
      .filter((call) => call[1]?.method === 'POST')
      .map((call) => JSON.parse(String(call[1]?.body)));
    expect(requests.map((request) => request.model)).toEqual(['gpt-6.1-sol', 'gpt-6-luna']);
    expect(requests[0]).toMatchObject({
      store: false,
      service_tier: 'default',
      max_output_tokens: 256,
      reasoning: { effort: 'low' },
    });
    expect(requests[1]).toMatchObject({
      store: false,
      max_output_tokens: 64,
      reasoning: { effort: 'none' },
    });
    expect(JSON.stringify(result)).not.toContain('private-key');
    expect(JSON.stringify(result)).not.toContain('ready');
  });
  it('accepts restricted catalogue permissions only when actual Responses succeeds', async () => {
    expect((await probeOpenAiRelease('key', fetcher(403))).ok).toBe(true);
    expect((await probeOpenAiRelease('key', fetcher(403, 403))).ok).toBe(false);
  });
  it('sends no requests if the existing key is absent', async () => {
    const fetchFn = fetcher();
    await expect(probeOpenAiRelease('', fetchFn)).rejects.toThrow(/absent/);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
