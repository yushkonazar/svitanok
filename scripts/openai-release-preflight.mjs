// Explicit release smoke only. Synthetic public input, no owner data, no Core
// tools, no Astra comparison, no credential values or response text in output.
import { pathToFileURL } from 'node:url';

const TARGETS = [
  { model: 'gpt-6.1-sol', effort: 'low', maxOutput: 256 },
  { model: 'gpt-6-luna', effort: 'none', maxOutput: 64 },
];
const count = (value) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const identifier = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(value) ? value : null;

/** @param {string} apiKey @param {typeof fetch} [fetchFn] */
export async function probeOpenAiRelease(apiKey, fetchFn = fetch) {
  if (!apiKey?.trim()) throw new Error('OPENAI_API_KEY is absent; no probes sent');
  const checks = [];
  for (const target of TARGETS) {
    const headers = {
      authorization: `Bearer ${apiKey.trim()}`,
      'content-type': 'application/json',
    };
    let catalogueHttp = null;
    try {
      catalogueHttp = (
        await fetchFn(`https://api.openai.com/v1/models/${target.model}`, {
          headers,
          signal: AbortSignal.timeout(15000),
        })
      ).status;
    } catch {
      /* Restricted keys may deny the catalogue but allow Responses. */
    }
    const isSol = target.model === 'gpt-6.1-sol';
    const contract = isSol
      ? {
          tools: [
            {
              type: 'function',
              name: 'release_probe',
              description: 'Synthetic read-only probe. No action is executed.',
              strict: true,
              parameters: {
                type: 'object',
                properties: { ready: { type: 'boolean' } },
                required: ['ready'],
                additionalProperties: false,
              },
            },
          ],
          tool_choice: { type: 'function', name: 'release_probe' },
          parallel_tool_calls: false,
        }
      : {
          text: {
            format: {
              type: 'json_schema',
              name: 'release_news_probe',
              strict: true,
              schema: {
                type: 'object',
                properties: { items: { type: 'array', items: { type: 'string' } } },
                required: ['items'],
                additionalProperties: false,
              },
            },
          },
        };
    try {
      const response = await fetchFn('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(30000),
        body: JSON.stringify({
          model: target.model,
          reasoning: { effort: target.effort },
          store: false,
          service_tier: 'default',
          max_output_tokens: target.maxOutput,
          input: isSol
            ? 'Call release_probe with ready=true. This is synthetic and executes no action.'
            : 'Return a JSON object with items equal to ["0"].',
          ...contract,
        }),
      });
      const body = await response.json().catch(() => null);
      let contractOk = false;
      if (isSol) {
        const call = body?.output?.find(
          (item) => item.type === 'function_call' && item.name === 'release_probe',
        );
        try {
          contractOk = JSON.parse(call?.arguments ?? '{}').ready === true;
        } catch {
          /* invalid contract */
        }
      } else {
        const text =
          body?.output_text ??
          body?.output
            ?.flatMap((item) => item.content ?? [])
            .filter((item) => item.type === 'output_text')
            .map((item) => item.text)
            .join('');
        try {
          contractOk = JSON.stringify(JSON.parse(text).items) === '["0"]';
        } catch {
          /* invalid contract */
        }
      }
      const model = identifier(body?.model);
      const modelOk = model === target.model || model?.startsWith(`${target.model}-`) === true;
      checks.push({
        requestedModel: target.model,
        catalogueHttp,
        responsesHttp: response.status,
        ok: response.ok && body?.status === 'completed' && modelOk && contractOk,
        model,
        status: identifier(body?.status),
        errorCode: identifier(body?.error?.code),
        usage: {
          inputTokens: count(body?.usage?.input_tokens),
          outputTokens: count(body?.usage?.output_tokens),
          cachedTokens: count(body?.usage?.input_tokens_details?.cached_tokens),
          cacheWriteTokens: count(body?.usage?.input_tokens_details?.cache_write_tokens),
        },
      });
    } catch {
      checks.push({
        requestedModel: target.model,
        catalogueHttp,
        ok: false,
        errorCode: 'transport-failure',
      });
    }
  }
  return { ok: checks.every((check) => check.ok), checks };
}

if (
  process.argv[1] === '-' ||
  (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
) {
  probeOpenAiRelease(process.env.OPENAI_API_KEY ?? '')
    .then((result) => {
      console.log(JSON.stringify(result));
      if (!result.ok) process.exitCode = 1;
    })
    .catch(() => {
      console.error('OpenAI release probe could not start; credentials not printed');
      process.exitCode = 1;
    });
}
