# OpenAI Responses rollout

The brain has two provider runtimes behind the same `ModelRuntime` and
canonical tool registry. `hybrid` is the safe first mode: Claude stays default
and only explicitly listed private threads/profiles run on OpenAI. `openai`
is an explicit full-cutover decision, not a Worker code deploy.

## Runtime guarantees

- `AI_PROVIDER=hybrid` requires both provider credentials and
  `OPENAI_CANARY_THREAD_IDS`; `AI_PROVIDER=openai` requires
  `OPENAI_ROLLOUT=full` and OpenAI credentials only.
- Models are selected per task class: `OPENAI_MODEL_FAST`,
  `OPENAI_MODEL_STANDARD`, and `OPENAI_MODEL_ADVANCED`. Every profile also has
  a `max_output_tokens` ceiling. `OPENAI_MODEL` remains a compatibility
  fallback for the standard class only.
- Every Responses request sets `store:false`, uses a SHA-256 safety identifier
  derived from the internal thread identity, and never sends a
  `previous_response_id`.
- Function schemas are strict. Optional simple values become nullable and are
  removed before the core validates them. Tools with a genuinely dynamic map
  use one strict `arguments_json` string instead of weakening the schema.
- Every requested function is executed by `agent.ts`, then signed to the
  Cloudflare core; policy, provenance and confirmation boundaries therefore do
  not move to OpenAI. The one narrow exception is hosted web search for the
  isolated researcher with zero Core tools. Its output is tainted before it can
  return to a chat; the price worker has no write-tool surface.
- D1 `sessions.summary_md` remains the durable memory used to build prompts.
  Provider response IDs are never persisted as conversation state.
- Telemetry contains only a model-step allowlist: provider/model snapshot,
  response ID, token counters and latency. It has no prompt, output, function
  arguments, tool result or API error body.

## Controlled rollout

1. Copy `brain/.env.example` to `/opt/svitanok-brain-shared/brain.env`, set
   `brain:brain` ownership and mode `0600`. Start with `AI_PROVIDER=hybrid`,
   `OPENAI_ROLLOUT=canary`, one private thread ID, and only `chat,quick`.
   Do not add the key to Worker bindings, GitHub Actions, D1, or logs.
2. Deploy the already-tested brain release, restart the service, then verify
   `/ready` and the private assistant status endpoint.
3. Run `npm run eval:openai` on the VPS with the same process environment.
   It is an explicit, read-only seven-case corpus (intent, tool choice,
   policy, injection, Ukrainian quality, uncertainty, owner-memory conflict),
   contains no owner data, and prints no model text. Review every failure;
   compare the passing run's tool choice, Ukrainian quality, latency and token
   counters with the prior baseline. Do not enable scheduled or write-capable
   traffic in this step.
4. Expand profile-by-profile only after the owner accepts the evidence. Full
   cutover is the separate pair `AI_PROVIDER=openai` and
   `OPENAI_ROLLOUT=full`. Rollback is `AI_PROVIDER=claude` plus restart; it
   does not require a provider data migration.

### Optional shadow lane

Before a canary, `AI_PROVIDER=claude` may set both
`OPENAI_SHADOW_THREAD_IDS` and `OPENAI_SHADOW_PROFILES=quick`. The router
accepts only a named thread and a tool-free profile; it runs Claude and OpenAI
in parallel, delivers only Claude's answer, gives OpenAI no Core or hosted
tools, and discards OpenAI text. The run dashboard records only sanitized
model/response ID/token/latency metadata as `shadow:openai:*`. Empty settings
mean no second provider request. A shadow result is evidence, not automatic
permission to advance rollout.

OpenAI chat turns are recorded as a bounded first-party D1 transcript containing
only owner input and delivered assistant output. The daily summarizer uses it
for clean sessions, stores the durable summary, then clears the rolling source.
Claude SDK transcripts remain readable only for legacy cleanup/summarization.

The adapter contract is tested locally with fake Responses only. A real request,
cost comparison, canary decision and external secret placement require owner
authorization and a real API key.
