# Memory projection contract

`memory_chunks` in D1 is the source of truth for assistant summaries.
Vectorize is a rebuildable projection and must never be the only copy of a
summary.

Each summary write creates an immutable `(thread_id, projection_version)` in
`memory_projection_versions` and stages its chunks with the same version.

```text
D1 pending → Vectorize upsert → D1 indexed → D1 ready → retire old → delete old vectors
```

Only chunks with `projection_status = ready` are returned by `memory.search`.
That gives these failure rules:

- AI embedding or Vectorize failure leaves the new D1 generation `failed`; the
  previous `ready` generation remains searchable.
- A crash after Vectorize upsert but before `indexed` is safe: reconciliation
  repeats an idempotent upsert using the stable D1 chunk ids.
- A crash after `indexed` is safe: reconciliation completes the D1-only ready
  switch.
- A failure while deleting retired vectors does not invalidate the new ready
  generation. Retired chunks are invisible and reconciliation retries external
  deletion before removing their D1 rows.
- If an older asynchronous write completes after a newer ready generation, the
  older version is retired rather than replacing newer memory.

`reconcileMemoryProjection` runs via the five-minute
`memory-projection-reconcile` scheduler task. `rebuildMemoryProjection` is a
trusted maintenance entrypoint that re-indexes a ready generation from D1
without changing its text or vector ids. Retention removes version metadata
only after every associated chunk has been removed.
