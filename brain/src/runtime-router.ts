// Вибір provider-а на межі runtime. Hybrid не є «тихим fallback» після
// помилки OpenAI: canary або працює через OpenAI, або чесно завершується. Це
// не дозволяє непомітно відправляти той самий запит в іншого провайдера.

import type { EngineRunOptions, EngineOutcome, ModelRuntime } from './agent.js';

export interface RuntimeRouterConfig {
  provider: 'claude' | 'openai' | 'hybrid';
  rollout: 'canary' | 'full' | null;
  canaryTargets: readonly string[];
  canaryProfiles: readonly string[];
  shadowTargets: readonly string[];
  shadowProfiles: readonly string[];
}

export function createRuntimeRouter(
  config: RuntimeRouterConfig,
  runtimes: { claude?: ModelRuntime; openai?: ModelRuntime },
): ModelRuntime {
  const requireRuntime = (name: 'claude' | 'openai') => {
    const runtime = runtimes[name];
    if (!runtime) throw new Error(`runtime-router: ${name} runtime не налаштований`);
    return runtime;
  };
  const useOpenAi = (opts: EngineRunOptions) => {
    if (config.provider === 'openai') return true;
    if (config.provider !== 'hybrid' || config.rollout !== 'canary') return false;
    const targetOk = config.canaryTargets.includes(opts.safetyIdentifier);
    const profileOk =
      config.canaryProfiles.length === 0 || config.canaryProfiles.includes(opts.profileName ?? '');
    return targetOk && profileOk;
  };
  const useShadow = (opts: EngineRunOptions) => {
    // Shadow is deliberately narrower than canary: a second provider may see
    // only a named private thread, a named profile and a tool-free request.
    // There is no synthetic Core call, therefore it cannot read/write data or
    // produce an external effect even if a future profile changes by mistake.
    if (config.provider === 'openai' || config.shadowTargets.length === 0) return false;
    return (
      config.shadowTargets.includes(opts.safetyIdentifier) &&
      config.shadowProfiles.includes(opts.profileName ?? '') &&
      opts.toolNames.length === 0 &&
      (opts.builtinTools?.length ?? 0) === 0
    );
  };

  return {
    async run(opts: EngineRunOptions, inputText: string): Promise<EngineOutcome> {
      const primary = useOpenAi(opts) ? requireRuntime('openai') : requireRuntime('claude');
      if (!useShadow(opts) || primary === runtimes.openai) return primary.run(opts, inputText);
      // The primary result remains authoritative. Shadow gets no tools and
      // cannot stream/deliver; only sanitized latency/usage metadata returns.
      const shadow = requireRuntime('openai')
        .run(
          {
            ...opts,
            maxTurns: 1,
            maxOutputTokens: Math.min(opts.maxOutputTokens ?? 500, 500),
            streamPartials: false,
            toolNames: [],
            builtinTools: [],
            onToolCall: async () => ({ text: 'shadow-tools-disabled', isError: true }),
            onPartialText: () => undefined,
          },
          inputText,
        )
        .then((outcome) => ({
          provider: 'openai' as const,
          model: outcome.model,
          responseId: outcome.responseId,
          apiMs: outcome.apiMs,
          usage: outcome.usage,
          toolCalls: 0,
        }))
        .catch((error: unknown) => ({
          provider: 'openai' as const,
          toolCalls: 0,
          error: error instanceof Error ? error.name : 'unknown',
        }));
      const [primaryOutcome, shadowOutcome] = await Promise.all([
        primary.run(opts, inputText),
        shadow,
      ]);
      return { ...primaryOutcome, shadow: shadowOutcome };
    },
    // Локальні Claude transcripts мають бути доступні для cleanup старих
    // сесій навіть у full OpenAI mode; OpenAI transcript ніколи не підміняє їх.
    readTranscript(sessionId: string): Promise<string | null> {
      return runtimes.claude?.readTranscript(sessionId) ?? Promise.resolve(null);
    },
  };
}
