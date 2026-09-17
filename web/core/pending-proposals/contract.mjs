// Контракт singleton Durable Object для legacy pending-proposal slot.
// Константи винесені з класу: клієнти/cleanup не мають імпортувати
// `cloudflare:workers`, а ім'я binding не повинно роз'їхатися з wrangler.

/** Один слот на owner: нова пропозиція свідомо замінює стару, але claim/update
 * мають бути серіалізовані, бо після них можливий зовнішній запис. */
export const PENDING_PROPOSALS_DO_NAME = 'pending-proposals';

/** Compatibility snapshot до повного завершення rollout/rollback. */
export const ASSISTANT_PENDING_KEY = 'assistantPending';
