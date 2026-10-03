import type { DeliverButtons } from './core-client.js';

/** Core owns question labels and callback choices. Brain only validates the
 * bounded delivery envelope; it must not import Worker files at runtime. */
export function tripBriefCard(result: unknown): { text: string; buttons: DeliverButtons } | null {
  if (!result || typeof result !== 'object') return null;
  const envelope = result as { draft_id?: unknown; question_card?: unknown };
  if (typeof envelope.draft_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(envelope.draft_id))
    return null;
  const raw = envelope.question_card;
  if (!raw || typeof raw !== 'object') return null;
  const card = raw as { text?: unknown; buttons?: unknown };
  if (
    typeof card.text !== 'string' ||
    !card.text.trim() ||
    card.text.length > 2000 ||
    !Array.isArray(card.buttons)
  )
    return null;
  if (!card.buttons.length || card.buttons.length > 5) return null;
  const buttons: DeliverButtons = [];
  for (const row of card.buttons) {
    if (!Array.isArray(row) || !row.length || row.length > 2) return null;
    const clean: DeliverButtons[number] = [];
    for (const rawButton of row) {
      if (!rawButton || typeof rawButton !== 'object') return null;
      const button = rawButton as { text?: unknown; callback_data?: unknown };
      if (
        typeof button.text !== 'string' ||
        !button.text.trim() ||
        button.text.length > 40 ||
        typeof button.callback_data !== 'string' ||
        button.callback_data.length > 64 ||
        !button.callback_data.startsWith(`m:tb:${envelope.draft_id}:`) ||
        !/^m:tb:[0-9a-f-]{36}:[a-z_]+:[0-7]:[0-9a-f]{5}$/i.test(button.callback_data)
      )
        return null;
      clean.push({ text: button.text, callback_data: button.callback_data });
    }
    buttons.push(clean);
  }
  return { text: card.text, buttons };
}
