/** Shared layout primitives for assistant result cards.
 * Keep selection, navigation, contextual actions, utilities, and feedback in
 * the same order everywhere; individual workers still own their semantics.
 */

const MAX_BUTTONS_PER_ROW = 2;
const MAX_CALLBACK_LENGTH = 64;

/** @param {ActionCardButton} button */
const isButton = (button) => {
  if (typeof button !== 'object' || button === null) return false;
  if (!button || typeof button.text !== 'string' || !button.text.trim()) return false;
  if (button.text.length > 64) return false;
  const callbackData = button.callback_data;
  const callback = typeof callbackData === 'string' && callbackData.length > 0;
  const url = typeof button.url === 'string' && /^https:\/\//iu.test(button.url);
  return (callback && callbackData.length <= MAX_CALLBACK_LENGTH) || url;
};

/** @param {ActionCardButton[]} buttons */
const pairs = (buttons) => {
  const valid = buttons.filter(isButton);
  const rows = [];
  for (let i = 0; i < valid.length; i += MAX_BUTTONS_PER_ROW) {
    rows.push(valid.slice(i, i + MAX_BUTTONS_PER_ROW));
  }
  return rows;
};

/** @typedef {{ text: string, callback_data?: string, url?: string }} ActionCardButton */

/**
 * Build a compact, predictable Telegram inline keyboard for a result card.
 * `choices` stay one-per-row (e.g. long email subjects or restaurant names).
 * Other button groups are paired, while utility and feedback controls stay
 * visually distinct at the bottom.
 * @param {{ choices?: ActionCardButton[], navigation?: ActionCardButton[], actions?: ActionCardButton[], utilities?: ActionCardButton[], feedbackId?: string }} options
 * @returns {ActionCardButton[][]}
 */
export function buildActionCardRows({
  choices = [],
  navigation = [],
  actions = [],
  utilities = [],
  feedbackId,
} = {}) {
  const rows = [
    ...choices.filter(isButton).map((button) => [button]),
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
