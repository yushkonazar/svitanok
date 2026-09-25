import { describe, expect, it, vi } from 'vitest';
import { createOpenAiEngine } from '../brain/src/openai/engine.js';
import { decodeOpenAiArguments, openAiFunctionTool } from '../brain/src/openai/tools.js';
import { TOOL_BY_MCP_NAME } from '../brain/src/tools/schemas.js';

function options(over: Partial<Parameters<ReturnType<typeof createOpenAiEngine>['run']>[0]> = {}) {
  return {
    systemPrompt: 'Ти Світанок.',
    model: 'legacy-claude-name-is-not-sent',
    safetyIdentifier: 'telegram-owner-42',
    maxTurns: 4,
    toolNames: ['calendar_read'],
    resumeSessionId: 'must-not-be-used',
    streamPartials: true,
    abortSignal: new AbortController().signal,
    onToolCall: vi.fn(async () => ({ text: '{"events":[]}', isError: false })),
    onPartialText: vi.fn(),
    ...over,
  };
}

describe('OpenAI Responses runtime', () => {
  it('uses a stateless strict function loop and sends every tool result back by call_id', async () => {
    const payloads: Array<Record<string, unknown>> = [];
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      payloads.push(JSON.parse(String(init?.body)));
      if (payloads.length === 1) {
        return Response.json({
          id: 'resp_1',
          model: 'gpt-6-astra',
          status: 'completed',
          output: [
            {
              type: 'function_call',
              name: 'calendar_read',
              call_id: 'call_1',
              arguments: '{"days":2}',
            },
          ],
        });
      }
      return Response.json({
        id: 'resp_2',
        model: 'gpt-6-astra',
        status: 'completed',
        output_text: 'У календарі вільно.',
        output: [
          { type: 'message', content: [{ type: 'output_text', text: 'У календарі вільно.' }] },
        ],
        usage: { input_tokens: 123, output_tokens: 45, total_tokens: 168 },
      });
    }) as unknown as typeof fetch;
    const engine = createOpenAiEngine({
      apiKey: 'test-key',
      models: { fast: 'gpt-6-luna', standard: 'gpt-6-sol', advanced: 'gpt-6-astra' },
      reasoningEffort: 'high',
      fetchFn,
      now: () => 100,
    });
    const opts = options({ openAiModelTier: 'advanced', maxOutputTokens: 777 });

    await expect(engine.run(opts, 'Що в календарі?')).resolves.toMatchObject({
      finalText: 'У календарі вільно.',
      sessionId: null,
      provider: 'openai',
      model: 'gpt-6-astra',
      responseId: 'resp_2',
      usage: { inputTokens: 123, outputTokens: 45, totalTokens: 168 },
    });

    expect(opts.onToolCall).toHaveBeenCalledWith('calendar_read', { days: 2 });
    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toMatchObject({
      model: 'gpt-6-astra',
      store: false,
      parallel_tool_calls: false,
      tool_choice: 'auto',
      reasoning: { effort: 'high' },
      max_output_tokens: 777,
    });
    expect(payloads[0]?.safety_identifier).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(payloads[0])).not.toContain('telegram-owner-42');
    expect(JSON.stringify(payloads[0])).not.toContain('test-key');
    expect(payloads[0]).not.toHaveProperty('previous_response_id');
    expect(payloads[1]).not.toHaveProperty('previous_response_id');
    expect(payloads[1]?.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'function_call', call_id: 'call_1' }),
        expect.objectContaining({ type: 'function_call_output', call_id: 'call_1' }),
      ]),
    );
    expect(opts.onPartialText).toHaveBeenCalledWith('У календарі вільно.');
  });

  it('converts optional argument fields to strict nullable schema and strips null before core', async () => {
    const tool = openAiFunctionTool(TOOL_BY_MCP_NAME.get('finance_query')!);
    expect(tool.strict).toBe(true);
    expect(tool.parameters).toMatchObject({ type: 'object', additionalProperties: false });
    expect(tool.parameters.required).toContain('period');
    expect(tool.parameters.properties).toMatchObject({ period: { type: ['string', 'null'] } });
  });

  it('encodes an unconstrained JSON value so every strict tool property has a schema', () => {
    const tool = openAiFunctionTool(TOOL_BY_MCP_NAME.get('facts_set')!);
    expect(tool.encodedArguments).toBe(true);
    expect(tool.parameters).toEqual({
      type: 'object',
      properties: { arguments_json: { type: 'string' } },
      required: ['arguments_json'],
      additionalProperties: false,
    });
    expect(
      decodeOpenAiArguments(
        JSON.stringify({
          arguments_json: JSON.stringify({ kind: 'setting', key: 'k', value: { n: 1 } }),
        }),
        true,
      ),
    ).toEqual({ kind: 'setting', key: 'k', value: { n: 1 } });
  });

  it('allows hosted web search only for the isolated no-Core-tool researcher surface', async () => {
    const fetchSpy = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({
        id: 'resp_research',
        model: 'gpt-6-sol',
        status: 'completed',
        output_text: 'Знайшов джерела.',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'Знайшов джерела.' }] }],
      }),
    );
    const fetchFn = fetchSpy as unknown as typeof fetch;
    const engine = createOpenAiEngine({
      apiKey: 'test-key',
      models: { fast: 'gpt-6-luna', standard: 'gpt-6-sol', advanced: 'gpt-6-astra' },
      fetchFn,
      reasoningEffort: 'high',
    });
    await expect(
      engine.run(options({ toolNames: [], builtinTools: ['WebSearch', 'WebFetch'] }), 'досліди'),
    ).resolves.toMatchObject({ finalText: 'Знайшов джерела.' });
    const payload = JSON.parse(String(fetchSpy.mock.calls[0]![1]?.body)) as Record<string, unknown>;
    expect(payload.tools).toEqual([{ type: 'web_search', search_context_size: 'medium' }]);
  });

  it('refuses every provider builtin on a run that has Core tools', async () => {
    const engine = createOpenAiEngine({
      apiKey: 'test-key',
      models: { fast: 'gpt-6-luna', standard: 'gpt-6-sol', advanced: 'gpt-6-astra' },
      reasoningEffort: 'high',
    });
    await expect(engine.run(options({ builtinTools: ['WebSearch'] }), 'досліди')).rejects.toThrow(
      /provider built-in tools заборонені/,
    );
  });

  it('retries a retryable first request but never repeats a request after a tool result', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(
        Response.json({
          id: 'resp_ok',
          model: 'gpt-6-sol',
          status: 'completed',
          output_text: 'готово',
          output: [],
        }),
      ) as unknown as typeof fetch;
    const sleep = vi.fn(async () => undefined);
    const engine = createOpenAiEngine({
      apiKey: 'test-key',
      models: { fast: 'gpt-6-luna', standard: 'gpt-6-sol', advanced: 'gpt-6-astra' },
      reasoningEffort: 'low',
      fetchFn,
      sleep,
    });
    await expect(engine.run(options(), 'привіт')).resolves.toMatchObject({ finalText: 'готово' });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });
});
