// Власний feedback до блоків ранкового briefing-а.
//
// Це не telemetry стороннього провайдера і не вільний текст: зберігаємо лише
// allowlist id блока, один із чотирьох контрольованих verdict-ів та лічильники.
// Модуль виконуваний і у Worker (запис через policy), і в node-оркестраторі
// (застосування приховування/нижчого пріоритету) — отже два рантайми не
// отримують різну інтерпретацію переваги власника.

export const BRIEFING_FEEDBACK_KEY = 'briefingFeedback';

/** Відомі producer ids: довільний id від моделі ніколи не стає preference. */
export const BRIEFING_BLOCK_IDS = Object.freeze([
  'weather',
  'calendar',
  'mail',
  'stoic',
  'fact',
  'news',
  'jobs',
  'mock',
  'currency',
  'onthisday',
  'weekly-review',
]);

/** `useful` також повертає раніше прихований блок у видимий briefing. */
export const BRIEFING_FEEDBACK_VERDICTS = Object.freeze(['useful', 'less', 'hide']);

/** @typedef {'normal'|'less'|'hidden'} BriefingBlockPreference */
/** @typedef {{ useful: number, less: number, hidden: boolean, preference: 'normal'|'less', updatedAt: string }} BriefingFeedbackEntry */
/** @typedef {{ version: 1, blocks: Record<string, BriefingFeedbackEntry> }} BriefingFeedback */

const COUNT_MAX = 10_000;

/** @param {unknown} value */
function asCount(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? Math.min(n, COUNT_MAX) : 0;
}

/** @param {unknown} blockId */
export function isBriefingBlockId(blockId) {
  return typeof blockId === 'string' && BRIEFING_BLOCK_IDS.includes(blockId);
}

/** @param {unknown} verdict */
export function isBriefingFeedbackVerdict(verdict) {
  return typeof verdict === 'string' && BRIEFING_FEEDBACK_VERDICTS.includes(verdict);
}

/**
 * Межа даних, які ми визнаємо feedback-ом. Побитий/старий запис не може
 * приховати блок лише тому, що в ньому випадково є `hidden: true`.
 * @param {unknown} raw
 * @returns {BriefingFeedback}
 */
export function parseBriefingFeedback(raw) {
  const value =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? /** @type {any} */ (raw) : null;
  const rawBlocks =
    value?.blocks && typeof value.blocks === 'object' && !Array.isArray(value.blocks)
      ? value.blocks
      : {};
  /** @type {Record<string, BriefingFeedbackEntry>} */
  const blocks = {};
  for (const id of BRIEFING_BLOCK_IDS) {
    const entry = rawBlocks[id];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    blocks[id] = {
      useful: asCount(entry.useful),
      less: asCount(entry.less),
      hidden: entry.hidden === true,
      // Старі записи не мали `preference`; перехід не змінює їхній сенс.
      preference: entry.preference === 'less' || entry.less > entry.useful ? 'less' : 'normal',
      updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt.slice(0, 40) : '',
    };
  }
  return { version: 1, blocks };
}

/** @param {unknown} raw @param {string} blockId @returns {BriefingBlockPreference} */
export function briefingBlockPreference(raw, blockId) {
  if (!isBriefingBlockId(blockId)) return 'normal';
  const entry = parseBriefingFeedback(raw).blocks[blockId];
  if (!entry) return 'normal';
  if (entry.hidden) return 'hidden';
  return entry.preference;
}

/**
 * Чиста трансформація для CAS-safe `updateState`: результат не містить
 * повідомлень, titles чи іншого контенту briefing-а.
 * @param {unknown} raw
 * @param {{ blockId: unknown, verdict: unknown }} input
 * @param {number} nowMs
 * @returns {{ next: BriefingFeedback, result: { block_id: string, verdict: string, preference: BriefingBlockPreference } }}
 */
export function applyBriefingFeedback(raw, input, nowMs) {
  const candidateBlockId = input?.blockId;
  const candidateVerdict = input?.verdict;
  if (typeof candidateBlockId !== 'string' || !isBriefingBlockId(candidateBlockId)) {
    throw new Error('briefing.feedback: невідомий block_id');
  }
  if (typeof candidateVerdict !== 'string' || !isBriefingFeedbackVerdict(candidateVerdict)) {
    throw new Error('briefing.feedback: verdict має бути useful, less або hide');
  }
  const blockId = candidateBlockId;
  const verdict = candidateVerdict;

  const current = parseBriefingFeedback(raw);
  const previous = current.blocks[blockId] ?? {
    useful: 0,
    less: 0,
    hidden: false,
    preference: 'normal',
    updatedAt: '',
  };
  /** @type {BriefingFeedbackEntry} */
  const entry = { ...previous, updatedAt: new Date(nowMs).toISOString() };
  if (verdict === 'useful') {
    entry.useful = Math.min(COUNT_MAX, entry.useful + 1);
    // «Корисно» є явним поверненням блока після попереднього «сховай».
    entry.hidden = false;
    entry.preference = 'normal';
  } else if (verdict === 'less') {
    entry.less = Math.min(COUNT_MAX, entry.less + 1);
    entry.hidden = false;
    entry.preference = 'less';
  } else {
    entry.hidden = true;
  }

  const next = { ...current, blocks: { ...current.blocks, [blockId]: entry } };
  return {
    next,
    result: { block_id: blockId, verdict, preference: briefingBlockPreference(next, blockId) },
  };
}
