import { quotaUsed, bumpQuota } from '../quota/quota.mjs';
export const NEWS_OPENAI_MODEL = 'gpt-6-luna';
export const NEWS_OPENAI_LIMIT = 3;
/** Public RSS only; no tools, stored responses, private profile or uncapped requests.
 * @param {Env} env @param {{prompt:string,systemPrompt:string,jsonSchema:KvBlob,maxOutputTokens?:number}} input
 * @param {typeof fetch} [fetchImpl] @returns {Promise<KvBlob>} */
export async function callOpenAiNewsEditor(env, input, fetchImpl = fetch) {
  let attempted = false;
  if (!env.OPENAI_API_KEY || !env.DB) return { ok: false, error: 'not-configured' };
  try {
    if ((await quotaUsed(env, 'news_editor_usd')) >= NEWS_OPENAI_LIMIT)
      return { ok: false, error: 'quota' };
    attempted = true;
    const response = await fetchImpl('https://api.openai.com/v1/responses', {
      method: 'POST',
      signal: AbortSignal.timeout(20000),
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.OPENAI_API_KEY.trim()}`,
      },
      body: JSON.stringify({
        model: NEWS_OPENAI_MODEL,
        reasoning: { effort: 'none' },
        instructions: input.systemPrompt,
        input: input.prompt,
        store: false,
        service_tier: 'default',
        max_output_tokens: input.maxOutputTokens ?? 3500,
        text: {
          format: {
            type: 'json_schema',
            name: 'news_editor',
            strict: true,
            schema: input.jsonSchema,
          },
        },
      }),
    });
    if (!response.ok) return { ok: false, attempted, error: `editor-http-${response.status}` };
    const body = /** @type {KvBlob} */ (await response.json());
    const inputTokens = tokenCount(body.usage?.input_tokens);
    const outputTokens = tokenCount(body.usage?.output_tokens);
    if (inputTokens == null || outputTokens == null)
      return { ok: false, attempted, error: 'editor-usage-unavailable' };
    // Standard Luna rates verified 2026-10-12. Cache writes replace the
    // ordinary input rate, not an additional fee. Missing cache breakdown
    // uses the higher write rate for a conservative quota estimate.
    const details = body.usage?.input_tokens_details;
    const cachedTokens = tokenCount(details?.cached_tokens);
    const cacheWriteTokens = tokenCount(details?.cache_write_tokens);
    const validPartition =
      cachedTokens != null &&
      cacheWriteTokens != null &&
      cachedTokens + cacheWriteTokens <= inputTokens;
    const inputUsd = validPartition
      ? (inputTokens - cachedTokens - cacheWriteTokens) * 0.1 +
        cachedTokens * 0.01 +
        cacheWriteTokens * 0.125
      : inputTokens * 0.125;
    const longContext = inputTokens > 272_000;
    const estimatedUsd =
      (inputUsd * (longContext ? 2 : 1) + outputTokens * 0.5 * (longContext ? 1.5 : 1)) / 1_000_000;
    const usage = { inputTokens, outputTokens, estimatedUsd, model: NEWS_OPENAI_MODEL };
    if (estimatedUsd > 0)
      await bumpQuota(env, {
        key: 'news_editor_usd',
        amount: estimatedUsd,
        limit: NEWS_OPENAI_LIMIT,
      });
    if (body.status !== 'completed')
      return { ok: false, attempted, error: 'editor-incomplete', usage };
    const text = (body.output ?? [])
      .flatMap((/** @type {KvBlob} */ m) => m.content ?? [])
      .filter((/** @type {KvBlob} */ p) => p.type === 'output_text' && typeof p.text === 'string')
      .map((/** @type {KvBlob} */ p) => p.text)
      .join('');
    try {
      return { ok: true, attempted, provider: 'openai', structured: JSON.parse(text), usage };
    } catch {
      return { ok: false, attempted, error: 'editor-invalid-output', usage };
    }
  } catch {
    return { ok: false, attempted, error: 'editor-unavailable' };
  }
}

/** @param {unknown} value @returns {number|null} */
function tokenCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
