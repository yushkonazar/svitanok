import { describe, expect, it, vi } from 'vitest';
import { ModelRunError, type EngineRunOptions } from '../brain/src/agent.js';
import { loadConfig } from '../brain/src/config.js';
import { createOpenAiEngine, type OpenAiModelPricing } from '../brain/src/openai/engine.js';

const baseEnv = {
  AI_PROVIDER: 'openai',
  OPENAI_ROLLOUT: 'full',
  OPENAI_API_KEY: 'fake-key',
  INTERNAL_HMAC_KEY: 'fake-hmac',
  INTERNAL_API_URL: 'https://core.example',
};
const solPrice: OpenAiModelPricing = {
  inputPerMillionUsd: 2,
  outputPerMillionUsd: 10,
  cachedInputPerMillionUsd: 0.1,
  cacheWritePerMillionUsd: 2.5,
};
function options(over: Partial<EngineRunOptions> = {}): EngineRunOptions {
  return {
    systemPrompt: 'Synthetic test only.',
    model: 'legacy',
    safetyIdentifier: 'synthetic',
    maxTurns: 3,
    toolNames: [],
    resumeSessionId: null,
    streamPartials: false,
    abortSignal: new AbortController().signal,
    onToolCall: vi.fn(async () => ({ text: '{}', isError: false })),
    onPartialText: vi.fn(),
    ...over,
  };
}
function receipt(input = 1000, output = 100, cached = 600, written = 200) {
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: input + output,
    input_tokens_details: { cached_tokens: cached, cache_write_tokens: written },
    output_tokens_details: { reasoning_tokens: 20 },
  };
}
function runtime(fetchFn: typeof fetch, pricing = solPrice) {
  const cfg = loadConfig(baseEnv);
  return createOpenAiEngine({
    apiKey: cfg.openAiApiKey!,
    models: cfg.openAiModels!,
    reasoningEffort: cfg.openAiReasoningEffort!,
    pricing: { standard: pricing },
    fetchFn,
    sleep: async () => {},
  });
}

describe('Sol 6.1 migration and complete model receipts (no paid calls)', () => {
  it.each(['standard', 'advanced', 'fast'] as const)(
    'routes %s to the approved model without Astra fallback',
    async (tier) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json({ status: 'completed', output_text: 'OK', usage: receipt() }),
        );
      const out = await runtime(fetcher).run(options({ openAiModelTier: tier }), 'test');
      const expected = tier === 'fast' ? 'gpt-6-luna' : 'gpt-6.1-sol';
      expect(out.model).toBe(expected);
      expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toMatchObject({
        model: expected,
        store: false,
        service_tier: 'default',
        reasoning: { effort: 'high' },
      });
    },
  );

  it('preserves explicit deployment overrides and rejects empty model names', () => {
    expect(
      loadConfig({ ...baseEnv, OPENAI_MODEL_STANDARD: 'pinned-model' }).openAiModels?.standard,
    ).toBe('pinned-model');
    expect(loadConfig({ ...baseEnv, OPENAI_MODEL: 'legacy-model' }).openAiModels?.standard).toBe(
      'legacy-model',
    );
    expect(() => loadConfig({ ...baseEnv, OPENAI_MODEL_STANDARD: ' ' })).toThrow(
      /не можуть бути порожніми/,
    );
  });

  it('supports optional cache rates while retaining legacy input/output pairs', () => {
    const env = {
      ...baseEnv,
      OPENAI_PRICE_STANDARD_INPUT_USD_PER_1M: '2',
      OPENAI_PRICE_STANDARD_OUTPUT_USD_PER_1M: '10',
    };
    expect(loadConfig(env).openAiPricing?.standard).toEqual({
      inputPerMillionUsd: 2,
      outputPerMillionUsd: 10,
    });
    expect(
      loadConfig({
        ...env,
        OPENAI_PRICE_STANDARD_CACHED_INPUT_USD_PER_1M: '0.1',
        OPENAI_PRICE_STANDARD_CACHE_WRITE_USD_PER_1M: '2.5',
      }).openAiPricing?.standard,
    ).toEqual(solPrice);
    expect(() =>
      loadConfig({ ...env, OPENAI_PRICE_STANDARD_CACHED_INPUT_USD_PER_1M: '0.1' }),
    ).toThrow(/CACHED_INPUT\/CACHE_WRITE/);
    expect(() =>
      loadConfig({
        ...env,
        OPENAI_PRICE_STANDARD_CACHED_INPUT_USD_PER_1M: '-1',
        OPENAI_PRICE_STANDARD_CACHE_WRITE_USD_PER_1M: '2.5',
      }),
    ).toThrow(/CACHED_INPUT\/CACHE_WRITE/);
  });

  it('sums every function-loop receipt and does not double-charge cache writes or reasoning', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          status: 'completed',
          usage: receipt(),
          output: [
            { type: 'function_call', name: 'calendar_read', arguments: '{}', call_id: 'call_1' },
          ],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          status: 'completed',
          output_text: 'OK',
          usage: receipt(2000, 200, 1200, 400),
        }),
      );
    const out = await runtime(fetcher).run(options({ toolNames: ['calendar_read'] }), 'test');
    expect(out).toMatchObject({
      usage: {
        inputTokens: 3000,
        outputTokens: 300,
        totalTokens: 3300,
        cachedInputTokens: 1800,
        cacheWriteTokens: 600,
        reasoningTokens: 40,
      },
      usageComplete: true,
      apiAttempts: 2,
      modelResponses: 2,
    });
    expect(out.estimatedCostUsd).toBeCloseTo(0.00588, 8);
  });

  it('applies long-context multipliers per response rather than to the aggregate', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        status: 'completed',
        output_text: 'OK',
        usage: receipt(300000, 100, 0, 0),
      }),
    );
    expect((await runtime(fetcher).run(options(), 'test')).estimatedCostUsd).toBeCloseTo(1.2015, 8);
  });

  it.each([
    undefined,
    { input_tokens: 1000, output_tokens: 100 },
    receipt(1000, 100, 900, 200),
    receipt(1000, 100, -1, 0),
  ])('leaves cost unknown for absent or invalid cache receipts', async (usage) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ status: 'completed', output_text: 'OK', usage }));
    expect((await runtime(fetcher).run(options(), 'test')).estimatedCostUsd).toBeNull();
  });

  it('does not pass a final receipt off as a complete multi-turn run', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          status: 'completed',
          output: [
            { type: 'function_call', name: 'calendar_read', arguments: '{}', call_id: 'call_1' },
          ],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ status: 'completed', output_text: 'OK', usage: receipt() }),
      );
    expect(
      await runtime(fetcher).run(options({ toolNames: ['calendar_read'] }), 'test'),
    ).toMatchObject({
      usage: null,
      estimatedCostUsd: null,
      usageComplete: false,
      apiAttempts: 2,
      modelResponses: 2,
    });
  });

  it('retains billed incomplete-response metadata without any output text', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ status: 'incomplete', output_text: 'private output', usage: receipt() }),
      );
    try {
      await runtime(fetcher).run(options(), 'private input');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ModelRunError);
      const telemetry = (error as ModelRunError).telemetry;
      expect(telemetry).toMatchObject({ usageComplete: true, modelResponses: 1, apiAttempts: 1 });
      expect(telemetry.estimatedCostUsd).toBeCloseTo(0.00196, 8);
      expect(JSON.stringify(telemetry)).not.toContain('private');
    }
  });

  it('keeps unreceipted retries and post-tool HTTP failures incomplete, without retrying a write-capable continuation', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 500 }))
      .mockResolvedValueOnce(
        Response.json({
          status: 'completed',
          usage: receipt(),
          output: [
            { type: 'function_call', name: 'calendar_read', arguments: '{}', call_id: 'call_1' },
          ],
        }),
      )
      .mockResolvedValueOnce(new Response('', { status: 500 }));
    try {
      await runtime(fetcher).run(options({ toolNames: ['calendar_read'] }), 'test');
      expect.unreachable();
    } catch (error) {
      expect((error as ModelRunError).telemetry).toMatchObject({
        usage: { inputTokens: 1000, outputTokens: 100 },
        usageComplete: false,
        estimatedCostUsd: null,
        apiAttempts: 3,
        modelResponses: 1,
      });
    }
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
