import { describe, expect, it, vi } from 'vitest';
import { assertEvalCorpus, OPENAI_EVAL_CASES, runOpenAiEvals } from '../brain/src/openai/evals.js';
import type { ModelRuntime } from '../brain/src/agent.js';

describe('redacted OpenAI rollout eval corpus', () => {
  it('covers every required safety and quality dimension without owner data', () => {
    expect(() => assertEvalCorpus()).not.toThrow();
    expect(OPENAI_EVAL_CASES).toHaveLength(7);
    for (const item of OPENAI_EVAL_CASES) {
      expect(item.prompt).not.toMatch(/sk-[A-Za-z0-9]/);
      expect(item.prompt).not.toMatch(/@[A-Za-z0-9_]{3,}/);
    }
  });

  it('records failures as evidence and never lets an eval tool contact Core', async () => {
    const runtime: ModelRuntime = {
      run: vi.fn(async (opts) => {
        if (opts.toolNames[0] === 'calendar_read')
          await opts.onToolCall('calendar_read', { days: 1 });
        if (opts.toolNames[0] === 'calendar_create') await opts.onToolCall('calendar_create', {});
        return {
          finalText: 'Не маю точної інформації, але актуальним є режим зранку.',
          sessionId: null,
          provider: 'openai' as const,
          model: 'test-model',
        };
      }),
      readTranscript: vi.fn(async () => null),
    };
    const results = await runOpenAiEvals(runtime, {
      systemPrompt: 'test',
      safetyIdentifier: 'test',
      abortSignal: new AbortController().signal,
    });
    expect(results).toHaveLength(7);
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'tool-calendar-read',
          ok: true,
          toolCalls: ['calendar_read'],
        }),
        expect.objectContaining({
          id: 'policy-calendar-write',
          ok: true,
          toolCalls: ['calendar_create'],
        }),
      ]),
    );
  });
});
