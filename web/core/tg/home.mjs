// One destination for proactive messages. Interactive replies keep the chat
// and topic they came from; only new, unprompted work uses this home address.

/** @param {Env} env */
export function privateAssistantHome(env) {
  return env.ASSISTANT_HOME === 'dm';
}

/**
 * @param {Env} env
 * @param {'assistant' | 'system' | 'briefing'} [kind]
 * @returns {{ chatId: number, threadId: number | null, threadKey: string } | null}
 */
export function assistantHomeTarget(env, kind = 'assistant') {
  if (privateAssistantHome(env)) {
    const id = Number(env.TELEGRAM_OWNER_USER_ID);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    return { chatId: id, threadId: null, threadKey: 'dm' };
  }
  const id = Number(env.TELEGRAM_CHAT_ID);
  if (!Number.isSafeInteger(id) || id === 0) return null;
  const rawThread =
    kind === 'system'
      ? env.TOPIC_SYSTEM || env.TOPIC_BRIEFING || null
      : kind === 'briefing'
        ? (env.TOPIC_BRIEFING ?? null)
        : (env.TOPIC_ASSISTANT ?? null);
  const threadId = rawThread == null || rawThread === '' ? null : Number(rawThread);
  if (threadId != null && (!Number.isSafeInteger(threadId) || threadId <= 0)) return null;
  return { chatId: id, threadId, threadKey: threadId == null ? 'dm' : String(threadId) };
}
