// Stateless OpenAI Responses runtime. `store:false` means provider state is
// never used as the application source of truth: the only continuation here
// is the current in-memory tool loop; thread summaries and policy stay in D1.

import { createHash } from 'node:crypto';
import {
  EngineStopError,
  ModelRunError,
  type EngineOutcome,
  type EngineRunOptions,
  type ModelRuntime,
  type ModelTelemetry,
} from '../agent.js';
import { decodeOpenAiArguments, openAiFunctionTools } from './tools.js';
import { TRIP_SEARCH_FORMAT } from '../trip-search-schema.js';

const RESPONSES_URL = 'https://api.openai.com/v1/responses';

export interface OpenAiRuntimeConfig {
  apiKey: string;
  models: { fast: string; standard: string; advanced: string };
  reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  fetchFn?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Optional deployment-owned price table. If absent, cost stays unknown
   * instead of inventing a price that may no longer match billing. */
  pricing?: Partial<Record<'fast' | 'standard' | 'advanced', OpenAiModelPricing>>;
}

export interface OpenAiModelPricing {
  modelId?: string;
  priceVersion?: string;
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  cachedInputPerMillionUsd?: number;
  cacheWritePerMillionUsd?: number;
}

type OutputItem = { type?: unknown; name?: unknown; arguments?: unknown; call_id?: unknown };
type ResponsesTool =
  | ReturnType<typeof openAiFunctionTools>[number]
  | { type: 'web_search'; search_context_size: 'medium' };
type ResponsesPayload = {
  id?: unknown;
  model?: unknown;
  status?: unknown;
  output?: unknown;
  output_text?: unknown;
  usage?: unknown;
  service_tier?: unknown;
};

export function createOpenAiEngine(config: OpenAiRuntimeConfig): ModelRuntime {
  const fetchFn = config.fetchFn ?? fetch;
  const now = config.now ?? Date.now;
  return {
    async run(opts: EngineRunOptions, inputText: string): Promise<EngineOutcome> {
      const tools = openAiFunctionTools(opts.toolNames);
      const hostedTools = allowedHostedTools(opts, tools);
      const encoded = new Map(tools.map((tool) => [tool.name, tool.encodedArguments]));
      const input: unknown[] = [{ role: 'user', content: inputText }];
      let apiMs = 0;
      let apiAttempts = 0;
      let modelResponses = 0;
      let allUsageReported = true;
      let totalUsage: EngineOutcome['usage'] = null;
      let totalCost: number | null = 0;
      let lastModel = modelFor(config, opts);
      let responseId: string | null = null;
      const telemetry = (): ModelTelemetry => {
        const usageComplete =
          modelResponses > 0 && allUsageReported && apiAttempts === modelResponses;
        return {
          provider: 'openai',
          model: lastModel,
          responseId,
          apiMs,
          usage: totalUsage,
          usageComplete,
          modelResponses,
          apiAttempts,
          estimatedCostUsd: usageComplete ? totalCost : null,
          priceVersion:
            config.pricing?.[opts.openAiModelTier ?? 'standard']?.priceVersion ??
            'unversioned-deployment-config',
        };
      };
      try {
        for (let turn = 0; turn < opts.maxTurns; turn += 1) {
          const started = now();
          let response: ResponsesPayload;
          try {
            response = await createResponse(
              fetchFn,
              config,
              opts,
              input,
              [...tools, ...hostedTools],
              () => {
                apiAttempts += 1;
              },
            );
          } finally {
            apiMs += Math.max(0, now() - started);
          }
          const responseUsage = usage(response.usage);
          totalUsage = combineUsage(totalUsage, responseUsage, modelResponses > 0);
          modelResponses += 1;
          allUsageReported &&=
            responseUsage?.inputTokens != null && responseUsage.outputTokens != null;
          lastModel = typeof response.model === 'string' ? response.model : modelFor(config, opts);
          responseId = typeof response.id === 'string' ? response.id : null;
          const expectedModel = modelFor(config, opts);
          const modelMatches =
            lastModel === expectedModel || lastModel.startsWith(`${expectedModel}-`);
          const standardTier =
            response.service_tier == null ||
            ['default', 'standard'].includes(String(response.service_tier));
          const cost =
            modelMatches &&
            standardTier &&
            (!config.pricing?.[opts.openAiModelTier ?? 'standard']?.modelId ||
              config.pricing?.[opts.openAiModelTier ?? 'standard']?.modelId === expectedModel)
              ? estimateCost(
                  responseUsage,
                  config.pricing?.[opts.openAiModelTier ?? 'standard'],
                  expectedModel,
                )
              : null;
          totalCost = totalCost != null && cost != null ? totalCost + cost : null;
          if (response.status !== 'completed') {
            throw new EngineStopError(`response-${String(response.status ?? 'unknown')}`, '');
          }
          const output = Array.isArray(response.output) ? response.output : [];
          // With store:false, Responses requires every prior output item to be
          // replayed before the next request; no previous_response_id is stored.
          input.push(...output);
          const calls = output.filter(isFunctionCall);
          if (calls.length === 0) {
            const finalText = responseText(response, output, opts.profileName === 'trip-research');
            if (finalText && opts.streamPartials) opts.onPartialText(finalText);
            return {
              finalText,
              sessionId: null,
              ...telemetry(),
            };
          }
          for (const call of calls) {
            const name = String(call.name);
            let result: { text: string; isError: boolean };
            try {
              const args = decodeOpenAiArguments(
                String(call.arguments ?? ''),
                encoded.get(name) === true,
              );
              result = await opts.onToolCall(name, args);
            } catch (error) {
              result = {
                text: `Аргументи інструмента відхилено: ${shortError(error)}`,
                isError: true,
              };
            }
            input.push({
              type: 'function_call_output',
              call_id: String(call.call_id),
              output: JSON.stringify({ text: result.text, is_error: result.isError }),
            });
          }
        }
        throw new EngineStopError('max-turns', '');
      } catch (error) {
        throw new ModelRunError(
          error instanceof Error ? error.message : 'OpenAI runtime failed',
          telemetry(),
        );
      }
    },

    // OpenAI responses are intentionally not a transcript store. D1 summaries
    // are the durable memory; old Claude session cleanup remains compatible.
    async readTranscript(): Promise<string | null> {
      return null;
    },
  };
}

async function createResponse(
  fetchFn: typeof fetch,
  config: OpenAiRuntimeConfig,
  opts: EngineRunOptions,
  input: unknown[],
  tools: ResponsesTool[],
  onAttempt: () => void,
): Promise<ResponsesPayload> {
  const body = JSON.stringify({
    model: modelFor(config, opts),
    instructions: opts.systemPrompt,
    input,
    tools: tools.map((tool) => {
      if ('encodedArguments' in tool) {
        const { encodedArguments: _encodedArguments, ...wire } = tool;
        return wire;
      }
      return tool;
    }),
    tool_choice:
      opts.profileName === 'trip-research' &&
      input.length === 1 &&
      tools.some((t) => t.type === 'web_search')
        ? { type: 'web_search' }
        : 'auto',
    ...(opts.profileName === 'trip-research'
      ? { text: { format: TRIP_SEARCH_FORMAT }, include: ['web_search_call.action.sources'] }
      : {}),
    parallel_tool_calls: false,
    store: false,
    service_tier: 'default',
    safety_identifier: hashSafetyIdentifier(opts.safetyIdentifier),
    reasoning: { effort: opts.effort ?? config.reasoningEffort },
    ...(opts.maxOutputTokens ? { max_output_tokens: opts.maxOutputTokens } : {}),
  });
  // Повторюємо лише перший запит run. Повтор після function_call може вдруге
  // породити write-tool, тому там правильніше завершити run чесною помилкою.
  const mayRetry = input.length === 1 && (input[0] as { role?: unknown }).role === 'user';
  for (let attempt = 0; ; attempt += 1) {
    let res: Response;
    onAttempt();
    try {
      res = await fetchFn(RESPONSES_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
        signal: opts.abortSignal,
        body,
      });
    } catch (error) {
      if (mayRetry && attempt < 2 && !opts.abortSignal.aborted) {
        await waitBeforeRetry(config, attempt, opts.abortSignal);
        continue;
      }
      throw error;
    }
    const parsed: unknown = await res.json().catch(() => null);
    if (res.ok && isRecord(parsed)) return parsed as ResponsesPayload;
    const errorCode =
      isRecord(parsed) && isRecord(parsed.error)
        ? String(parsed.error.code ?? parsed.error.type ?? '')
            .replace(/[^a-zA-Z0-9_-]/g, '')
            .slice(0, 80)
        : '';
    const billing =
      /spend_limit_exceeded|usage_limit_exceeded|insufficient_quota|credit_balance_exhausted/.test(
        errorCode,
      );
    if (
      !billing &&
      mayRetry &&
      attempt < 2 &&
      retryableStatus(res.status) &&
      !opts.abortSignal.aborted
    ) {
      await waitBeforeRetry(config, attempt, opts.abortSignal, res.headers.get('retry-after'));
      continue;
    }
    // Provider error payloads may contain request fragments. Keep diagnostics
    // to a status only; users get the normal runner failure, never secrets.
    throw new Error(`OpenAI Responses HTTP ${res.status}${errorCode ? `: ${errorCode}` : ''}`);
  }
}

/** OpenAI hosted web search is the sole provider-native exception. It is
 * available only to isolated researcher runs with no Core tools, so fetched
 * text cannot immediately trigger a write. Delegate output is tainted before
 * it returns to chat; price-check has no write-capable tool surface. */
function allowedHostedTools(
  opts: EngineRunOptions,
  functionTools: ReturnType<typeof openAiFunctionTools>,
): ResponsesTool[] {
  const builtin = opts.builtinTools ?? [];
  if (builtin.length === 0) return [];
  const onlyResearch = builtin.every((name) => name === 'WebSearch' || name === 'WebFetch');
  if (!onlyResearch || functionTools.length !== 0) {
    throw new Error('OpenAI runtime: provider built-in tools заборонені; використай core tool');
  }
  return [{ type: 'web_search', search_context_size: 'medium' }];
}

function modelFor(config: OpenAiRuntimeConfig, opts: EngineRunOptions): string {
  return config.models[opts.openAiModelTier ?? 'standard'];
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

async function waitBeforeRetry(
  config: OpenAiRuntimeConfig,
  attempt: number,
  signal: AbortSignal,
  retryAfter: string | null = null,
): Promise<void> {
  const seconds = Number(retryAfter);
  const ms =
    Number.isFinite(seconds) && seconds > 0
      ? Math.min(seconds * 1_000, 10_000)
      : 500 * 2 ** attempt;
  if (config.sleep) return config.sleep(ms, signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error('aborted'));
      },
      { once: true },
    );
  });
}

function isFunctionCall(
  value: unknown,
): value is OutputItem & { name: string; arguments: string; call_id: string } {
  return (
    isRecord(value) &&
    value.type === 'function_call' &&
    typeof value.name === 'string' &&
    typeof value.arguments === 'string' &&
    typeof value.call_id === 'string'
  );
}

function responseText(
  response: ResponsesPayload,
  output: unknown[],
  structured = false,
): string | null {
  // Structured cards already carry their own source URLs. A prose citation appendix
  // would make an otherwise valid JSON response unreadable by the completion handler.
  const format = (text: string) => (structured ? text : withCitations(text, output));
  if (typeof response.output_text === 'string') return format(response.output_text);
  for (const item of output) {
    if (!isRecord(item) || item.type !== 'message' || !Array.isArray(item.content)) continue;
    const text = item.content
      .filter(
        (part): part is Record<string, unknown> => isRecord(part) && part.type === 'output_text',
      )
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .join('');
    if (text) return format(text);
  }
  return null;
}

/** Telegram does not render Responses API annotations, so make provider-native
 * web citations visible as a compact, sanitized sources list. */
function withCitations(text: string, output: unknown[]): string {
  const citations = output.flatMap((item) => {
    if (!isRecord(item) || !Array.isArray(item.content)) return [];
    return item.content.flatMap((part) => {
      if (!isRecord(part) || !Array.isArray(part.annotations)) return [];
      return part.annotations.flatMap((annotation) => citation(annotation));
    });
  });
  const unique = [...new Map(citations.map((item) => [item.url, item])).values()].slice(0, 6);
  if (unique.length === 0) return text;
  const lines = unique.map((item, index) => `${index + 1}. ${item.title} — ${item.url}`);
  return `${text.trim()}\n\nДжерела:\n${lines.join('\n')}`;
}

function citation(value: unknown): Array<{ title: string; url: string }> {
  if (!isRecord(value) || value.type !== 'url_citation' || typeof value.url !== 'string') return [];
  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    return [];
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return [];
  const rawTitle = typeof value.title === 'string' ? value.title : url.hostname;
  const title = rawTitle
    .replace(/[\r\n<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return [{ title: title || url.hostname, url: url.toString() }];
}

function usage(value: unknown): EngineOutcome['usage'] {
  if (!isRecord(value)) return null;
  const count = (n: unknown) =>
    typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
  const inputTokens = count(value.input_tokens);
  const outputTokens = count(value.output_tokens);
  const details = isRecord(value.input_tokens_details) ? value.input_tokens_details : {};
  const outputDetails = isRecord(value.output_tokens_details) ? value.output_tokens_details : {};
  return {
    inputTokens,
    outputTokens,
    totalTokens: count(value.total_tokens),
    cachedInputTokens: count(details.cached_tokens),
    cacheWriteTokens: count(details.cache_write_tokens),
    reasoningTokens: count(outputDetails.reasoning_tokens),
  };
}

function combineUsage(
  previous: EngineOutcome['usage'],
  current: EngineOutcome['usage'],
  hasPrevious: boolean,
): EngineOutcome['usage'] {
  if (!hasPrevious) return current;
  if (!previous || !current) return null;
  const merged: NonNullable<EngineOutcome['usage']> = {};
  for (const key of [
    'inputTokens',
    'outputTokens',
    'totalTokens',
    'cachedInputTokens',
    'cacheWriteTokens',
    'reasoningTokens',
  ] as const) {
    const a = previous[key];
    const b = current[key];
    if (a != null && b != null && Number.isSafeInteger(a + b)) merged[key] = a + b;
  }
  return merged;
}

function estimateCost(
  value: EngineOutcome['usage'],
  pricing: OpenAiModelPricing | undefined,
  model: string,
): number | null {
  if (!pricing || value?.inputTokens == null || value.outputTokens == null) return null;
  const cached = value.cachedInputTokens;
  const written = value.cacheWriteTokens;
  if (cached == null || written == null || cached + written > value.inputTokens) return null;
  if (
    (cached > 0 && pricing.cachedInputPerMillionUsd == null) ||
    (written > 0 && pricing.cacheWritePerMillionUsd == null)
  )
    return null;
  const longContext = value.inputTokens > 272_000;
  // These multipliers are verified for GPT-6 only, not guessed for arbitrary overrides.
  if (longContext && !/^gpt-6(?:\.1)?-(?:sol|luna|astra)$/.test(model)) return null;
  const input =
    (value.inputTokens - cached - written) * pricing.inputPerMillionUsd +
    cached * (pricing.cachedInputPerMillionUsd ?? 0) +
    written * (pricing.cacheWritePerMillionUsd ?? 0);
  const total =
    (input * (longContext ? 2 : 1) +
      value.outputTokens * pricing.outputPerMillionUsd * (longContext ? 1.5 : 1)) /
    1_000_000;
  return Number.isFinite(total) && total >= 0 ? total : null;
}

function hashSafetyIdentifier(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function shortError(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
    .replace(/\s+/g, ' ')
    .slice(0, 120);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
