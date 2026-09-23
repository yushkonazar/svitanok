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
  model: string;
  reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  fetchFn?: typeof fetch;
  now?: () => number;
}

type OutputItem = { type?: unknown; name?: unknown; arguments?: unknown; call_id?: unknown };
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
      if (opts.builtinTools?.length) {
        throw new Error('OpenAI runtime: provider built-in tools заборонені; використай core tool');
      }
      const tools = openAiFunctionTools(opts.toolNames);
      const encoded = new Map(tools.map((tool) => [tool.name, tool.encodedArguments]));
      const input: unknown[] = [{ role: 'user', content: inputText }];
      let apiMs = 0;
      let last: ResponsesPayload | null = null;

      for (let turn = 0; turn < opts.maxTurns; turn += 1) {
        const started = now();
        const response = await createResponse(fetchFn, config, opts, input, tools);
        apiMs += Math.max(0, now() - started);
        last = response;
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
            model: typeof response.model === 'string' ? response.model : config.model,
            responseId: typeof response.id === 'string' ? response.id : null,
            usage: usage(response.usage),
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
  tools: ReturnType<typeof openAiFunctionTools>,
): Promise<ResponsesPayload> {
  const res = await fetchFn(RESPONSES_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
    signal: opts.abortSignal,
    body: JSON.stringify({
      model: config.model,
      instructions: opts.systemPrompt,
      input,
      tools: tools.map(({ encodedArguments: _encodedArguments, ...tool }) => tool),
      tool_choice: 'auto',
      parallel_tool_calls: false,
      store: false,
      safety_identifier: hashSafetyIdentifier(opts.safetyIdentifier),
      reasoning: { effort: opts.effort ?? config.reasoningEffort },
    }),
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok || !isRecord(body)) {
    // Provider error payloads may contain request fragments. Keep diagnostics
    // to a status only; users get the normal runner failure, never secrets.
    throw new Error(`OpenAI Responses HTTP ${res.status}`);
  }
  return body as ResponsesPayload;
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
  if (typeof response.output_text === 'string') return response.output_text;
  for (const item of output) {
    if (!isRecord(item) || item.type !== 'message' || !Array.isArray(item.content)) continue;
    const text = item.content
      .filter(
        (part): part is Record<string, unknown> => isRecord(part) && part.type === 'output_text',
      )
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .join('');
    if (text) return text;
  }
  return null;
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
