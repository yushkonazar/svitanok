/** Shared layout primitives for assistant action cards.
 * Keep choices, navigation, contextual actions, utilities, and feedback in
 * predictable groups; each feature still owns its callbacks and semantics.
 */

const MAX_BUTTONS_PER_ROW = 2;
const MAX_CALLBACK_LENGTH = 64;

/** @param {ActionCardButton} button */
export const isActionCardButton = (button) => {
  if (typeof button !== 'object' || button === null) return false;
  if (typeof button.text !== 'string' || !button.text.trim() || button.text.length > 64)
    return false;
  const callbackData = button.callback_data;
  const callback = typeof callbackData === 'string' && callbackData.length > 0;
  const url = typeof button.url === 'string' && /^https:\/\//iu.test(button.url);
  return (callback && callbackData.length <= MAX_CALLBACK_LENGTH) || url;
};

/** @param {ActionCardButton[]} buttons */
const pairs = (buttons) => {
  const valid = buttons.filter(isActionCardButton);
  const rows = [];
  for (let i = 0; i < valid.length; i += MAX_BUTTONS_PER_ROW) {
    rows.push(valid.slice(i, i + MAX_BUTTONS_PER_ROW));
  }
  return rows;
};

/** @typedef {{ text: string, callback_data?: string, url?: string }} ActionCardButton */
/** @typedef {{ text: string, callback_data: string }} CallbackActionCardButton */

/**
 * Build a compact, predictable Telegram inline keyboard for a result card.
 * `choices` (long labels) and `checklist` items get their own row. Compact
 * `choicePairs`, navigation, actions, and utilities are paired; feedback stays
 * visually distinct at the bottom.
 * @param {{ choices?: ActionCardButton[], checklist?: ActionCardButton[], choicePairs?: ActionCardButton[], navigation?: ActionCardButton[], actions?: ActionCardButton[], utilities?: ActionCardButton[], feedbackId?: string }} options
 * @returns {ActionCardButton[][]}
 */
export function buildActionCardRows({
  choices = [],
  checklist = [],
  choicePairs = [],
  navigation = [],
  actions = [],
  utilities = [],
  feedbackId,
} = {}) {
  const rows = [
    ...choices.filter(isActionCardButton).map((button) => [button]),
    ...checklist.filter(isActionCardButton).map((button) => [button]),
    ...pairs(choicePairs),
    ...pairs(navigation),
    ...pairs(actions),
    ...pairs(utilities),
  ];
  if (feedbackId) {
    rows.push([
      { text: '👍 Корисно', callback_data: `m:w:${feedbackId}:good` },
      { text: '👎 Не те', callback_data: `m:w:${feedbackId}:bad` },
    ]);
  }
  return rows;
}

/**
 * Callback-only variant for stateful workflows. Keeping callback_data required
 * lets chain I/O remain strongly typed without weakening URL-card support.
 * @param {{ choices?: CallbackActionCardButton[], checklist?: CallbackActionCardButton[], choicePairs?: CallbackActionCardButton[], navigation?: CallbackActionCardButton[], actions?: CallbackActionCardButton[], utilities?: CallbackActionCardButton[] }} options
 * @returns {CallbackActionCardButton[][]}
 */
export function buildCallbackActionCardRows(options) {
  return /** @type {CallbackActionCardButton[][]} */ (buildActionCardRows(options));
}
