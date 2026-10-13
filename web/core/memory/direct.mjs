import { extractExplicitFact, resolveExplicitFact } from './explicit.mjs';
import { readMemoryPreferences } from './preferences.mjs';
import { applyPolicy, proposalExecutionError } from '../policy/proposals.mjs';
import { memoryValueText } from './workspace.mjs';

/** @param {string} text */
export function explicitMemoryInstruction(text) {
  return /^(?:запам[’'ʼ]?ят(?:ай|ати)\s*:|(?:надалі\s+)?відповідай\s+)/iu.test(text);
}

/** A tiny, owner-only first-party path; no model or external call.
 * @param {Env} env @param {{fromId?: string|number|null, messageId?: number|null,
 * chatId?: number|null, threadId?: number|string|null, ownerComposed?: boolean,
 * memoryOrigin?: string}} parsed @param {string} text @param {number} nowMs */
export async function directOwnerMemory(env, parsed, text, nowMs) {
  if (
    env.ASSISTANT_V2 !== 'on' ||
    parsed.ownerComposed !== true ||
    String(parsed.fromId) !== String(env.TELEGRAM_OWNER_USER_ID ?? '') ||
    !env.TELEGRAM_OWNER_USER_ID ||
    !Number.isSafeInteger(parsed.messageId) ||
    Number(parsed.messageId) < 1
  )
    return null;
  let fact = await extractExplicitFact(text);
  if (!fact) return null;
  const consent = await readMemoryPreferences(env, nowMs);
  if (
    consent.preferences.mode !== 'explicit' ||
    !consent.preferences.categories.includes(fact.category)
  )
    return null;
  fact = await resolveExplicitFact(env, fact, nowMs);
  if (!fact) return null;
  // A standalone preference must not steal an answer to a previous question.
  // An explicit remember command is a separate owner instruction.
  if (!explicitMemoryInstruction(text)) {
    if (!env.DB) return null;
    const session = (
      await env.DB.prepare('SELECT transcript_md FROM sessions WHERE thread_id=?')
        .bind(parsed.threadId == null ? 'dm' : String(parsed.threadId))
        .all()
    ).results?.[0];
    if (session) {
      try {
        const replies = [
          ...String(session.transcript_md ?? '').matchAll(/(?:^|\n)Світанок:\s*([^\n]*)/gu),
        ];
        if (String(replies.at(-1)?.[1] ?? '').includes('?')) return null;
      } catch {
        return null;
      }
    }
  }
  try {
    const out = await applyPolicy(
      env,
      {
        kind: 'facts.set',
        payload: { kind: fact.kind, key: fact.key, value: fact.value },
        tainted: false,
        chatId: parsed.chatId,
        threadId: parsed.threadId ?? 'dm',
        internal: {
          ownerFactEvidence: {
            ownerComposed: true,
            ownerId: parsed.fromId,
            messageId: parsed.messageId,
            origin: parsed.memoryOrigin ?? 'text',
            text,
          },
        },
      },
      nowMs,
    );
    if (out.mode === 'error')
      return { text: 'Не зміг зберегти факт. Перевір пам’ять і повтори запит.' };
    if (out.mode === 'proposed')
      return {
        text: `Зберегти: ${memoryValueText(fact.value)}?`,
        reply_markup: { inline_keyboard: out.proposal.buttons },
      };
    const result = /** @type {{alreadySaved?:boolean}} */ (out.result);
    return {
      text: result?.alreadySaved
        ? 'Це вже пам’ятаю.'
        : `Пам’ятаю: ${fact.label.toLocaleLowerCase('uk-UA')} — ${memoryValueText(fact.value)}.`,
      ...(out.undo ? { reply_markup: { inline_keyboard: out.undo.buttons } } : {}),
    };
  } catch (error) {
    return { text: proposalExecutionError(error) };
  }
}
