import { describe, expect, it, vi } from 'vitest';
import { createLLMClient, formatLlmDegradedMessage, isUsageLimitError } from '../src/core/llm.js';

describe('briefing OpenAI client', () => {
  it('stops network calls after a confirmed project budget limit', async () => {
    const fetchFn = vi.fn(async () =>
      Response.json({ error: { code: 'project_spend_limit_exceeded' } }, { status: 429 }),
    );
    const llm = createLLMClient({
      model: 'gpt-6-luna',
      defaultTimeoutMs: 1000,
      maxCallsPerRun: 5,
      apiKey: 'test-key',
      fetchFn: fetchFn as typeof fetch,
    });
    await expect(llm.complete('x', { tag: 'mail' })).rejects.toThrow(
      'project_spend_limit_exceeded',
    );
    await expect(llm.complete('y', { tag: 'jobs' })).rejects.toThrow(
      'project_spend_limit_exceeded',
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(formatLlmDegradedMessage(llm.failures())).toContain('аналіз пошти, аналіз вакансій');
  });
  it('uses a stateless tool-free Responses request and never puts the key in its body', async () => {
    const fetchSpy = vi.fn(async () => Response.json({ output_text: 'готово' }));
    const fetchFn = fetchSpy as unknown as typeof fetch;
    const llm = createLLMClient({
      model: 'gpt-6-luna',
      defaultTimeoutMs: 1_000,
      maxCallsPerRun: 2,
      apiKey: 'sk-test-secret',
      fetchFn,
    });

    await expect(llm.complete('Скороти цей текст', { maxTokens: 80, tag: 'jobs' })).resolves.toBe(
      'готово',
    );
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer sk-test-secret' });
    expect(body).toMatchObject({
      model: 'gpt-6-luna',
      store: false,
      input: 'Скороти цей текст',
      max_output_tokens: 80,
    });
    expect(body).not.toHaveProperty('tools');
    expect(JSON.stringify(body)).not.toContain('sk-test-secret');
  });

  it('records a safe provider failure and enforces the per-run call ceiling', async () => {
    const llm = createLLMClient({
      model: 'gpt-6-luna',
      defaultTimeoutMs: 1_000,
      maxCallsPerRun: 1,
      apiKey: 'key',
      fetchFn: vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: 'insufficient_quota' } }), { status: 429 }),
      ) as unknown as typeof fetch,
    });
    await expect(llm.complete('x', { tag: 'mail' })).rejects.toThrow(
      /HTTP 429: insufficient_quota/,
    );
    expect(llm.failures()).toEqual([
      { tag: 'mail', message: 'OpenAI Responses HTTP 429: insufficient_quota' },
    ]);
    await expect(llm.complete('y')).rejects.toThrow(/maxCallsPerRun/);
  });
});

describe('OpenAI degradation status', () => {
  it('calls out quota/rate limits rather than the removed Claude subscription', () => {
    expect(isUsageLimitError('OpenAI Responses HTTP 429: insufficient_quota')).toBe(true);
    const message = formatLlmDegradedMessage([
      { tag: 'mail', message: 'OpenAI Responses HTTP 429: insufficient_quota' },
    ])!;
    expect(message).toContain('ліміт витрат');
    expect(message).toContain('пошти');
    expect(message).not.toMatch(/HTTP|insufficient_quota|співбесід|LLM|деградували/);
    expect(message).not.toContain('Claude');
  });
});
