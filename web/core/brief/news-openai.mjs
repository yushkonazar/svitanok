import { quotaUsed, bumpQuota } from '../quota/quota.mjs';
export const NEWS_OPENAI_MODEL = 'gpt-4.1-mini-2025-04-14';
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
        instructions: input.systemPrompt,
        input: input.prompt,
        store: false,
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
    const inputTokens = Math.max(0, Number(body.usage?.input_tokens ?? 0));
    const outputTokens = Math.max(0, Number(body.usage?.output_tokens ?? 0));
    const estimatedUsd = (inputTokens * 0.4 + outputTokens * 1.6) / 1_000_000;
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
