// Stateless OpenAI Responses runtime. `store:false` means provider state is
// never used as the application source of truth: the only continuation here
// is the current in-memory tool loop; thread summaries and policy stay in D1.

import { createHash } from 'node:crypto';
import {
  EngineStopError,
  type EngineOutcome,
  type EngineRunOptions,
  type ModelRuntime,
} from '../agent.js';
import { decodeOpenAiArguments, openAiFunctionTools } from './tools.js';

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
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
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

      for (let turn = 0; turn < opts.maxTurns; turn += 1) {
        const started = now();
        const response = await createResponse(fetchFn, config, opts, input, [
          ...tools,
          ...hostedTools,
        ]);
        apiMs += Math.max(0, now() - started);
        if (response.status !== 'completed') {
          throw new EngineStopError(`response-${String(response.status ?? 'unknown')}`, '');
        }
        const output = Array.isArray(response.output) ? response.output : [];
        // With store:false, Responses requires every prior output item to be
        // replayed before the next request; no previous_response_id is stored.
        input.push(...output);
        const calls = output.filter(isFunctionCall);
        if (calls.length === 0) {
          const finalText = responseText(response, output);
          if (finalText && opts.streamPartials) opts.onPartialText(finalText);
          return {
            finalText,
            sessionId: null,
            apiMs,
            provider: 'openai',
            model: typeof response.model === 'string' ? response.model : modelFor(config, opts),
            responseId: typeof response.id === 'string' ? response.id : null,
            usage: usage(response.usage),
            estimatedCostUsd: estimateCost(
              usage(response.usage),
              config.pricing?.[opts.openAiModelTier ?? 'standard'],
            ),
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
    tool_choice: 'auto',
    parallel_tool_calls: false,
    store: false,
    safety_identifier: hashSafetyIdentifier(opts.safetyIdentifier),
    reasoning: { effort: opts.effort ?? config.reasoningEffort },
    ...(opts.maxOutputTokens ? { max_output_tokens: opts.maxOutputTokens } : {}),
  });
  // Повторюємо лише перший запит run. Повтор після function_call може вдруге
  // породити write-tool, тому там правильніше завершити run чесною помилкою.
  const mayRetry = input.length === 1 && (input[0] as { role?: unknown }).role === 'user';
  for (let attempt = 0; ; attempt += 1) {
    let res: Response;
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
    if (mayRetry && attempt < 2 && retryableStatus(res.status) && !opts.abortSignal.aborted) {
      await waitBeforeRetry(config, attempt, opts.abortSignal, res.headers.get('retry-after'));
      continue;
    }
    // Provider error payloads may contain request fragments. Keep diagnostics
    // to a status only; users get the normal runner failure, never secrets.
    throw new Error(`OpenAI Responses HTTP ${res.status}`);
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

function responseText(response: ResponsesPayload, output: unknown[]): string | null {
  if (typeof response.output_text === 'string') return withCitations(response.output_text, output);
  for (const item of output) {
    if (!isRecord(item) || item.type !== 'message' || !Array.isArray(item.content)) continue;
    const text = item.content
      .filter(
        (part): part is Record<string, unknown> => isRecord(part) && part.type === 'output_text',
      )
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .join('');
    if (text) return withCitations(text, output);
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
  const number = (key: string) => (typeof value[key] === 'number' ? value[key] : undefined);
  return {
    inputTokens: number('input_tokens'),
    outputTokens: number('output_tokens'),
    totalTokens: number('total_tokens'),
  };
}

function estimateCost(
  value: EngineOutcome['usage'],
  pricing: OpenAiModelPricing | undefined,
): number | null {
  if (!pricing || value?.inputTokens == null || value.outputTokens == null) return null;
  const total =
    (value.inputTokens / 1_000_000) * pricing.inputPerMillionUsd +
    (value.outputTokens / 1_000_000) * pricing.outputPerMillionUsd;
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
