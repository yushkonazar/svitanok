// The reconciliation state crosses scheduler invocations and external Mono
// calls. KV is retained only as a rollback seed/mirror, never its lease owner.

export const MONO_RECONCILE_DO_NAME = 'mono-reconcile';
export const MONO_RECONCILE_KEY = 'monoReconcile';
export const MONO_RECONCILE_LEASE_MS = 10 * 60_000;
