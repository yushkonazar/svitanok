import { describe, expect, it, vi } from 'vitest';
import { createRuntimeRouter } from '../brain/src/runtime-router.js';
import type { EngineRunOptions, ModelRuntime } from '../brain/src/agent.js';

function options(over: Partial<EngineRunOptions> = {}): EngineRunOptions {
  return {
    systemPrompt: 'test',
    model: 'legacy',
    safetyIdentifier: 'thread-1',
    maxTurns: 1,
    toolNames: [],
    resumeSessionId: null,
    streamPartials: false,
    abortSignal: new AbortController().signal,
    onToolCall: async () => ({ text: '', isError: false }),
    onPartialText: () => undefined,
    ...over,
  };
}

function runtime(name: string): ModelRuntime {
  return {
    run: vi.fn(async () => ({ finalText: name, sessionId: null })),
    readTranscript: vi.fn(async () => `${name}-transcript`),
  };
}

describe('runtime router', () => {
  it('hybrid sends only named canary thread and allowed profile to OpenAI', async () => {
    const claude = runtime('claude');
    const openai = runtime('openai');
    const router = createRuntimeRouter(
      {
        provider: 'hybrid',
        rollout: 'canary',
        canaryTargets: ['-100123:42'],
        canaryProfiles: ['chat'],
        shadowTargets: [],
        shadowProfiles: [],
      },
      { claude, openai },
    );
    await expect(
      router.run(options({ safetyIdentifier: '-100123:42', profileName: 'chat' }), 'hi'),
    ).resolves.toMatchObject({
      finalText: 'openai',
    });
    await expect(
      router.run(options({ safetyIdentifier: '-100123:42', profileName: 'weekly-review' }), 'hi'),
    ).resolves.toMatchObject({
      finalText: 'claude',
    });
    await expect(
      router.run(options({ safetyIdentifier: '-100999:42', profileName: 'chat' }), 'hi'),
    ).resolves.toMatchObject({
      finalText: 'claude',
    });
  });

  it('full OpenAI never silently falls back to Claude and old transcripts stay Claude-only', async () => {
    const claude = runtime('claude');
    const openai = runtime('openai');
    const router = createRuntimeRouter(
      {
        provider: 'openai',
        rollout: 'full',
        canaryTargets: [],
        canaryProfiles: [],
        shadowTargets: [],
        shadowProfiles: [],
      },
      { claude, openai },
    );
    await expect(router.run(options(), 'hi')).resolves.toMatchObject({ finalText: 'openai' });
    await expect(router.readTranscript('sdk-1')).resolves.toBe('claude-transcript');
  });

  it('shadows only a named, tool-free Claude profile and returns no model text', async () => {
    const claude = runtime('claude');
    const openai = runtime('openai');
    const router = createRuntimeRouter(
      {
        provider: 'claude',
        rollout: null,
        canaryTargets: [],
        canaryProfiles: [],
        shadowTargets: ['-100123:42'],
        shadowProfiles: ['quick'],
      },
      { claude, openai },
    );
    const outcome = await router.run(
      options({ safetyIdentifier: '-100123:42', profileName: 'quick' }),
      '2 + 2',
    );
    expect(outcome.finalText).toBe('claude');
    expect(outcome.shadow).toMatchObject({ provider: 'openai', toolCalls: 0 });
    expect(openai.run).toHaveBeenCalledWith(
      expect.objectContaining({
        toolNames: [],
        builtinTools: [],
        streamPartials: false,
        maxTurns: 1,
      }),
      '2 + 2',
    );
    await router.run(options({ profileName: 'quick', toolNames: ['calendar_read'] }), 'calendar');
    expect(openai.run).toHaveBeenCalledTimes(1);
  });
});
