# OpenAI model policy and metering

Owner decision: 2026-10-12. Replace Astra with GPT-6.1 Sol immediately in the
prepared code, without paid Astra/Sol comparison. Preserve the task router,
tool policy, first-party memory and confirmation boundaries.

## Workload roles

| Workload                                                    | Default model | Reasoning                                  |
| ----------------------------------------------------------- | ------------- | ------------------------------------------ |
| Chat, day planner, standard delegated workers               | `gpt-6.1-sol` | Existing effective setting, unchanged      |
| Weekly review and price research (advanced class)           | `gpt-6.1-sol` | Existing effective setting, unchanged      |
| Quick replies, summaries, inbox digest, lightweight workers | `gpt-6-luna`  | Existing per-profile/worker settings       |
| Public news selection and fallback translation              | `gpt-6-luna`  | `none`, strict structured output, no tools |
| GitHub idea/code review                                     | `gpt-6.1-sol` | Provider default (medium), unchanged       |
| GitHub briefing                                             | `gpt-6-luna`  | Existing configuration                     |

Sol 6.1 does not support `none` or `minimal`. Brain already uses Responses for
tools and supports low through max. Do not change global reasoning settings as
an accidental side effect of a model swap. No new endpoints, SDK, provider
fallback, extra calls, Fast/Ultrafast tier or paid shadow evaluation are enabled.
News keeps its existing $3 monthly quota and output ceiling.

Source: [Sol 6.1](https://developers.openai.com/api/docs/models/gpt-6.1-sol),
[Luna](https://developers.openai.com/api/docs/models/gpt-6-luna),
[migration guidance](https://developers.openai.com/api/docs/guides/latest-model).

## Prices and receipts

Standard short-context USD per million tokens, verified 2026-10-12:

| Model       | Ordinary input | Cached input | Cache write | Output |
| ----------- | -------------- | ------------ | ----------- | ------ |
| GPT-6.1 Sol | 2              | 0.10         | 2.50        | 10     |
| GPT-6 Luna  | 0.10           | 0.01         | 0.125       | 0.50   |

Brain prices remain deployment-owned configuration, not hard-coded invoice
claims. Each tier accepts `OPENAI_PRICE_<TIER>_INPUT_USD_PER_1M` and
`..._OUTPUT_USD_PER_1M`, plus the paired `..._CACHED_INPUT_USD_PER_1M` and
`..._CACHE_WRITE_USD_PER_1M`. Unknown prices or cache receipts remain null.
After changing a model, update all its prices too; old Astra rates must not be
left attached to Sol. The legacy two-price pair remains valid configuration,
but cannot price nonzero cache usage without the corresponding rates.

The runtime sums all received Responses usage in the tool loop, including
incomplete responses. Input is partitioned into ordinary, cached and cache-write
tokens. Cache writes replace ordinary input pricing; they are not an extra fee.
Reasoning is already included in output, never added again. Long-context rates
are selected per request, not from the sum across requests. Model overrides or
non-Standard provider receipts cannot silently reuse an incompatible price.

`model_responses`, `api_attempts` and `usage_complete` distinguish full receipts
from missing/retried requests. Unreceipted attempts may have incurred costs and
cannot be reconstructed locally. Failed runs emit allowlisted model metadata;
they do not leak prompts, outputs, arguments or API error bodies. Run dashboard
parses only explicitly allowlisted counters. An absent cost is null, never zero.

Token estimates exclude hosted tool fees, taxes, regional premiums and other
services. The dashboard currently exposes one model-step's usage per run, not a
consolidated invoice across main and delegated workers. Costs CSV/Platform is
the billing source of truth. News uses the higher write rate when its cache
breakdown is absent; missing total input/output usage is a visible failure.

Source: [prompt-cache accounting](https://developers.openai.com/api/docs/guides/prompt-caching).

## Release boundary

Code defaults do not overwrite `/opt/svitanok-brain-shared/brain.env`.
The production switch requires a separate reviewed Brain deployment, explicit
VPS standard/advanced model overrides set to `gpt-6.1-sol`, updated prices and
readiness verification. Worker deployment is required for the news editor.
GitHub's optional `IDEA_ANALYSIS_OPENAI_MODEL` override must also be checked.
Never print secret values while checking non-secret model settings.

Offline mocked API tests check routing, tools, JSON output, metering and policy.
They do not establish identical model answer quality or account access. No paid
comparison is required or authorized by this decision. Keep rollback deployment
and prior configuration available; do not delete the legacy provider path.
