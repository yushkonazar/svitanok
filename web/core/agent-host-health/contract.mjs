// Singleton control plane for the operational VPS health transition. The KV
// value stays a compatibility/status mirror, never the alert-dedup authority.

export const AGENT_HOST_HEALTH_DO_NAME = 'agent-host-health';
export const AGENT_HOST_HEALTH_KEY = 'agentHostHealth';
