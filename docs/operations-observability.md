# Operations observability

`GET /api/assistant-status` is the private, owner-authenticated snapshot for
routine operations. It is available only while `ASSISTANT_V2` is `shadow` or
`on`; each section is isolated, so one unavailable binding is returned as that
section's explicit `error` and does not hide the rest of the operational state.

## Run dashboard

`dashboard.recent` contains at most 50 recent runs and a `summary` of
`running`, `completed`, and `failed` terminal states. Every entry exposes only
operational metadata:

- terminal state, trigger, profile, timestamps, duration, queue wait and retry count;
- tool call count and aggregate/max tool latency;
- policy decision name, configured model, model-version snapshot when supplied,
  and a sanitized cost note;
- a short technical error when a run failed.

The dashboard deliberately never returns a thread identifier, prompt, model
output, step note, tool argument, or user text. Missing producer telemetry is
`null`, not a fabricated zero or success.

Queue wait and retry start markers are written to `run_steps` by
`RunRegistryDO.begin`. They are best-effort observability records: a telemetry
write cannot prevent the canonical run from beginning.

## Delivery SLOs

`delivery.reminders` reports the current number of due `pending`/`snoozed`
reminders and marks the objective `breached` when one remains undelivered more
than five minutes after `due_at`. A due reminder still inside that grace window
is `within_grace`; no due reminders is `ok`.

`delivery.briefing` uses Kyiv calendar time. The briefing is `ok` only after
the canonical state confirms `lastSentDate` is today. Before 11:00 Kyiv it is
`pending_window`; at or after 11:00 Kyiv without that confirmation it is
`breached`. This is a delivery signal, not an assertion that a job was merely
scheduled.

## Contract review

`docs/generated/tool-contract.json` is generated from the real core tool
registry. It records each JSON argument schema, tainting category and whether
a tool is executed by core or routed through policy. Run the following after a
tool definition change:

```sh
npm run contract:tools:write
npm run contract:tools
```

The normal test command checks this artifact before running tests, so a stale
reviewed contract cannot pass CI. The Node-only generator uses a tiny stub only
to load Cloudflare class declarations; all runtime behavior remains covered by
the isolated workerd suite.
