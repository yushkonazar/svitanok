// One short-lived continuation note per chat/thread. The legacy key remains a
// rollback mirror only; the singleton DO owns atomic single-consumer semantics.

import { historyKey } from '../../assistant-memory-core.mjs';

export const ASSISTANT_RESUME_DO_NAME = 'assistant-resume';
/** Півгодини — це відповідь на щойно поставлене уточнення, а не контекст для
 * наступного ранку. */
export const ASSISTANT_RESUME_TTL_MS = 30 * 60_000;

/** @param {string|number|null|undefined} chatId @param {string|number|null|undefined} threadId */
export function assistantResumeSlot(chatId, threadId) {
  return historyKey(chatId, threadId);
}

/** @param {string} slot */
export function assistantResumeLegacyKey(slot) {
  return `assistantResume:${slot}`;
}
