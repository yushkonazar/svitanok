import { describe, expect, it, vi } from 'vitest';
import { callNewsEditor } from '../web/core/brief/news-editor.mjs';
import { workerEnv } from './helpers/env.js';
const input = {
  prompt: '[{"id":"0","title":"Public news"}]',
  systemPrompt: 'Use only these public sources.',
  jsonSchema: {
    type: 'object',
    required: ['items'],
    properties: { items: { type: 'array', items: { type: 'string' } } },
    additionalProperties: false,
  },
};
function db(used = 0) {
  const amounts: unknown[][] = [];
  return {
    amounts,
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => ({ value: used }),
        all: async () => {
          if (sql.startsWith('INSERT')) amounts.push(args);
          return { results: [{ value: 0.01 }] };
        },
      }),
    }),
  };
}
describe('bounded OpenAI news editor', () => {
  it('uses the existing key for one structured, non-stored public request and accounts usage', async () => {
    const quota = db();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'completed',
          usage: { input_tokens: 1000, output_tokens: 200 },
          output: [{ content: [{ type: 'output_text', text: '{"items":["0"]}' }] }],
        }),
      ),
    );
    const result = await callNewsEditor(
      workerEnv({
        OPENAI_API_KEY: 'fake-key',
        GEMINI_API_KEY: 'unusable',
        GEMINI_TIER: 'paid',
        DB: quota,
      }),
      input,
      fetcher,
    );
    expect(result).toMatchObject({ ok: true, provider: 'openai', structured: { items: ['0'] } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, request] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(String(url)).not.toContain('fake-key');
    const body = JSON.parse(String(request?.body));
    expect(body).toMatchObject({
      store: false,
      input: input.prompt,
      text: { format: { strict: true } },
    });
    expect(body.tools).toBeUndefined();
    expect(quota.amounts[0]?.[0]).toBe('news_editor_usd');
    expect(quota.amounts[0]?.[2]).toBeCloseTo(0.00072);
  });
  it('refuses exhausted budget before fetching and does not silently try another paid provider', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const result = await callNewsEditor(
      workerEnv({ OPENAI_API_KEY: 'fake-key', DB: db(3) }),
      input,
      fetcher,
    );
    expect(result).toMatchObject({ ok: false, error: 'quota' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not accept a truncated response as editorial data but accounts consumed tokens', async () => {
    const quota = db();
    const result = await callNewsEditor(
      workerEnv({ OPENAI_API_KEY: 'fake-key', DB: quota }),
      input,
      async () =>
        new Response(
          JSON.stringify({
            status: 'incomplete',
            usage: { input_tokens: 1000, output_tokens: 50 },
            output: [],
          }),
        ),
    );
    expect(result).toMatchObject({ ok: false, attempted: true, error: 'editor-incomplete' });
    expect(result.structured).toBeUndefined();
    expect(quota.amounts).toHaveLength(1);
  });
});
