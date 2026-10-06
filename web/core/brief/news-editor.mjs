import { requirePaidGemini } from '../adapters/gemini.mjs';
import { quotaUsed, bumpQuota, QUOTA_LIMITS } from '../quota/quota.mjs';
import { callOpenAiNewsEditor } from './news-openai.mjs';
export const NEWS_EDITOR_MODEL = 'gemini-3.1-flash-lite';
const NEWS_GEMINI_LIMIT = QUOTA_LIMITS.gemini_usd ?? 10;
/** One short, tool-free request; only public news text. Never sends check-in or finance data.
 * @param {Env} env @param {{prompt:string,systemPrompt:string,jsonSchema:KvBlob,maxOutputTokens?:number}} input
 * @param {typeof fetch} [fetchImpl] @returns {Promise<KvBlob>} */
export async function callNewsEditor(env, input, fetchImpl = fetch) {
  if (env.OPENAI_API_KEY) return callOpenAiNewsEditor(env, input, fetchImpl);
  let attempted = false;
  if (!env.GEMINI_API_KEY || env.GEMINI_TIER !== 'paid')
    return { ok: false, error: 'not-configured' };
  if (!env.DB) return { ok: false, error: 'quota-unavailable' };
  try {
    const key = requirePaidGemini(env);
    if ((await quotaUsed(env, 'gemini_usd')) >= NEWS_GEMINI_LIMIT)
      return { ok: false, error: 'quota' };
    attempted = true;
    const response = await fetchImpl(
      `https://generativelanguage.googleapis.com/v1beta/models/${NEWS_EDITOR_MODEL}:generateContent`,
      {
        method: 'POST',
        signal: AbortSignal.timeout(20000),
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: input.systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: input.prompt }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseJsonSchema: input.jsonSchema,
            maxOutputTokens: input.maxOutputTokens ?? 3500,
            thinkingConfig: { thinkingLevel: 'minimal' },
          },
        }),
      },
    );
    if (!response.ok) return { ok: false, attempted, error: `editor-http-${response.status}` };
    const body = /** @type {KvBlob} */ (await response.json());
    const inputTokens = Math.max(0, Number(body.usageMetadata?.promptTokenCount ?? 0));
    const outputTokens = Math.max(
      0,
      Number(body.usageMetadata?.candidatesTokenCount ?? 0) +
        Number(body.usageMetadata?.thoughtsTokenCount ?? 0),
    );
    // Standard Flash-Lite pricing, verified 2026-10-06. Shared paid Gemini accounting.
    const estimatedUsd = (inputTokens * 0.25 + outputTokens * 1.5) / 1_000_000;
    if (estimatedUsd > 0)
      await bumpQuota(env, { key: 'gemini_usd', amount: estimatedUsd, limit: NEWS_GEMINI_LIMIT });
    const text = (body.candidates?.[0]?.content?.parts ?? [])
      .filter((/** @type {KvBlob} */ p) => !p.thought && typeof p.text === 'string')
      .map((/** @type {KvBlob} */ p) => p.text)
      .join('');
    return {
      ok: true,
      attempted,
      structured: JSON.parse(text),
      usage: { inputTokens, outputTokens, estimatedUsd, model: NEWS_EDITOR_MODEL },
    };
  } catch {
    return { ok: false, attempted, error: 'editor-unavailable' };
  }
}
