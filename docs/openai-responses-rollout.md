# OpenAI Responses rollout

The brain now has two provider runtimes behind the same `ModelRuntime` and
canonical tool registry. `claude` remains the default while the deployment is
unchanged. Selecting `openai` is an explicit VPS configuration decision, not a
Worker code deploy and not a secret rotation performed by this repository.

## Runtime guarantees

- `AI_PROVIDER=openai` requires `OPENAI_API_KEY`; it does not require a Claude
  subscription token. `OPENAI_MODEL` defaults to `gpt-6-astra` and
  `OPENAI_REASONING_EFFORT` defaults to `high`.
- Every Responses request sets `store:false`, uses a SHA-256 safety identifier
  derived from the internal thread identity, and never sends a
  `previous_response_id`.
- Function schemas are strict. Optional simple values become nullable and are
  removed before the core validates them. Tools with a genuinely dynamic map
  use one strict `arguments_json` string instead of weakening the schema.
- The model has no provider built-ins in this runtime. Every requested function
  is executed by `agent.ts`, then signed to the Cloudflare core; policy,
  provenance and confirmation boundaries therefore do not move to OpenAI.
- D1 `sessions.summary_md` remains the durable memory used to build prompts.
  Provider response IDs are never persisted as conversation state.
- Telemetry contains only a model-step allowlist: provider/model snapshot,
  response ID, token counters and latency. It has no prompt, output, function
  arguments, tool result or API error body.

## Controlled rollout

1. Put `AI_PROVIDER=openai`, `OPENAI_API_KEY`, and optionally a pinned
   `OPENAI_MODEL`/effort in `/opt/svitanok-brain-shared/brain.env` with mode
   `0600`. Do not add the key to Worker bindings, GitHub Actions, D1, or logs.
2. Deploy the already-tested brain release, restart the service, then verify
   `/ready` and the private assistant status endpoint.
3. Start with a manually selected, read-only request; compare tool choice,
   Ukrainian response quality, latency and token counters with the prior
   baseline. Do not enable scheduled or write-capable traffic in this step.
4. Expand through a canary only after the owner accepts the evidence. Rollback
   is `AI_PROVIDER=claude` plus a service restart; it does not require a data
   migration because conversations were never stored by the provider.

Before enabling the provider, archive or deliberately retire existing Claude
SDK transcripts: they are local implementation artifacts, while current D1
summaries stay authoritative. The daily legacy transcript summarizer must not
be scheduled against an OpenAI-only runtime until its input is migrated to a
first-party D1 transcript/event projection.

The adapter contract is tested locally with fake Responses only. A real request,
cost comparison, canary decision and external secret placement require owner
authorization and a real API key.
