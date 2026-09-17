// Контракт Durable Object для structured legacy JSON-блобів `state`, `stats`
// та `settings`.
// Константа живе окремо від класу, щоб Worker-клієнти не імпортували
// `cloudflare:workers` лише заради імені singleton-а.

/** Єдиний per-owner інстанс: два ключі мусять проходити крізь один
 * serializable control plane, а не дві незалежні KV-колонії. */
export const STATE_STORE_DO_NAME = 'mutable-state';

/** @type {readonly ['state', 'stats', 'settings']} */
export const MUTABLE_STATE_KEYS = Object.freeze(['state', 'stats', 'settings']);
