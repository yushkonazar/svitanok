// Агреговане залучення до блоків briefing-а.
//
// Зберігаємо ЛИШЕ дату, allowlisted id блока та лічильники подій. Тут ніколи
// не буває тексту briefing-а, URL, назв вакансій, тем новин чи будь-якого
// іншого персонального вмісту. Дані потрібні не для тихого «автоприбирання»,
// а щоб асистент міг чесно запропонувати `briefing.feedback(..., less)` після
// достатньої кількості безрезультатних показів.

import { BRIEFING_BLOCK_IDS, isBriefingBlockId } from './feedback.mjs';

export const BRIEFING_ENGAGEMENT_KEY = 'briefingEngagement';
export const BRIEFING_ENGAGEMENT_RETENTION_DAYS = 120;
export const BRIEFING_NOISY_MIN_EXPOSURES = 7;

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const COUNT_MAX = 10_000;
const INTERACTION_EVENTS = Object.freeze(['action', 'save', 'dismiss']);

/** @param {unknown} value */
const asCount = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? Math.min(n, COUNT_MAX) : 0;
};

/** @param {unknown} value */
const isDateKey = (value) => typeof value === 'string' && DATE_KEY_RE.test(value);

/** @param {unknown} value */
function asUpdatedAt(value) {
  return typeof value === 'string' ? value.slice(0, 40) : '';
}

/** @param {unknown} raw */
function normalizeBlock(raw) {
  const value =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? /** @type {any} */ (raw) : {};
  // `exposed` — не число показів UI: це максимум один підтверджений показ
  // блока за календарну добу. Релоад не може накрутити знаменник.
  return {
    exposed: Math.min(1, asCount(value.exposed)),
    action: asCount(value.action),
    save: asCount(value.save),
    dismiss: asCount(value.dismiss),
  };
}

/** @param {unknown} raw */
function normalizeDay(raw) {
  const value =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? /** @type {any} */ (raw) : {};
  const rawBlocks =
    value.blocks && typeof value.blocks === 'object' && !Array.isArray(value.blocks)
      ? value.blocks
      : {};
  /** @type {Record<string, { exposed: number, action: number, save: number, dismiss: number }>} */
  const blocks = {};
  for (const blockId of BRIEFING_BLOCK_IDS) {
    if (rawBlocks[blockId] == null) continue;
    blocks[blockId] = normalizeBlock(rawBlocks[blockId]);
  }
  return { opened: value.opened === true, blocks, updatedAt: asUpdatedAt(value.updatedAt) };
}

/**
 * Межа даних для stats-блоба. Старі, побиті або навмисно підкладені поля не
 * потрапляють у наступний запис і не можуть створити «шумний» блок.
 * @param {unknown} raw
 */
export function normalizeBriefingEngagement(raw) {
  const value =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? /** @type {any} */ (raw) : {};
  const rawDays =
    value.days && typeof value.days === 'object' && !Array.isArray(value.days) ? value.days : {};
  /** @type {Record<string, ReturnType<typeof normalizeDay>>} */
  const days = {};
  for (const dateKey of Object.keys(rawDays)
    .filter(isDateKey)
    .sort()
    .slice(-BRIEFING_ENGAGEMENT_RETENTION_DAYS)) {
    days[dateKey] = normalizeDay(rawDays[dateKey]);
  }
  return { version: 1, days };
}

/** @param {Record<string, any>} days */
function capDays(days) {
  for (const dateKey of Object.keys(days)
    .sort()
    .slice(0, Math.max(0, Object.keys(days).length - BRIEFING_ENGAGEMENT_RETENTION_DAYS))) {
    delete days[dateKey];
  }
}

/** @param {number} nowMs */
const updatedAt = (nowMs) => new Date(Number.isFinite(nowMs) ? nowMs : Date.now()).toISOString();

/**
 * Позначити перегляд поточного briefing-а. Кожен блок рахується показаним
 * максимум раз на київську добу; тому повторні GET/reload не створюють шуму.
 * @param {unknown} raw
 * @param {{ dateKey: unknown, blockIds?: unknown, nowMs?: number }} input
 */
export function recordBriefingOpen(raw, input) {
  const next = normalizeBriefingEngagement(raw);
  const candidateDateKey = input?.dateKey;
  if (!isDateKey(candidateDateKey)) return next;
  const dateKey = /** @type {string} */ (candidateDateKey);
  const rawIds = Array.isArray(input?.blockIds) ? input.blockIds : [];
  const blockIds = /** @type {string[]} */ ([...new Set(rawIds.filter(isBriefingBlockId))]);
  const previous = next.days[dateKey] ?? { opened: false, blocks: {}, updatedAt: '' };
  const blocks = { ...previous.blocks };
  for (const blockId of blockIds) {
    const entry = normalizeBlock(blocks[blockId]);
    blocks[blockId] = { ...entry, exposed: 1 };
  }
  next.days[dateKey] = {
    ...previous,
    opened: true,
    blocks,
    updatedAt: updatedAt(input?.nowMs ?? Date.now()),
  };
  capDays(next.days);
  return next;
}

/**
 * Додати агреговану взаємодію, уже відображену у чинній події застосунку.
 * Взаємодія може бути без `exposed` (наприклад, після старого клієнта), але
 * така аномалія ніколи не стане приводом радити прибрати блок.
 * @param {unknown} raw
 * @param {{ dateKey: unknown, blockId: unknown, event: unknown, nowMs?: number }} input
 */
export function recordBriefingInteraction(raw, input) {
  const next = normalizeBriefingEngagement(raw);
  const candidateDateKey = input?.dateKey;
  const candidateBlockId = input?.blockId;
  const candidateEvent = input?.event;
  if (
    !isDateKey(candidateDateKey) ||
    !isBriefingBlockId(candidateBlockId) ||
    !INTERACTION_EVENTS.includes(/** @type {any} */ (candidateEvent))
  ) {
    return next;
  }
  const dateKey = /** @type {string} */ (candidateDateKey);
  const blockId = /** @type {string} */ (candidateBlockId);
  const event = /** @type {'action'|'save'|'dismiss'} */ (candidateEvent);
  const previous = next.days[dateKey] ?? { opened: false, blocks: {}, updatedAt: '' };
  const entry = normalizeBlock(previous.blocks[blockId]);
  next.days[dateKey] = {
    ...previous,
    blocks: {
      ...previous.blocks,
      [blockId]: { ...entry, [event]: Math.min(COUNT_MAX, entry[event] + 1) },
    },
    updatedAt: updatedAt(input?.nowMs ?? Date.now()),
  };
  capDays(next.days);
  return next;
}

/**
 * Вивести блок і тип взаємодії з уже валідованої/виконаної події stats.
 * Повертаємо null для не пов'язаних з briefing-ом подій, щоб не змішувати
 * загальну активність Mini App з корисністю конкретного блока.
 * @param {any} event
 */
export function briefingInteractionFromEvent(event) {
  switch (event?.type) {
    case 'news_click':
    case 'vote':
      return { blockId: 'news', event: 'action' };
    case 'save_news':
      return { blockId: 'news', event: 'save' };
    case 'job_stage':
      return typeof event.url === 'string' && event.url
        ? { blockId: 'jobs', event: 'action' }
        : null;
    case 'job_dismiss':
      return typeof event.url === 'string' && event.url
        ? { blockId: 'jobs', event: 'dismiss' }
        : null;
    case 'mock_answer':
      return event.rating === 'easy' || event.rating === 'hard'
        ? { blockId: 'mock', event: 'action' }
        : null;
    case 'save_item':
      if (event.kind === 'fact') return { blockId: 'fact', event: 'save' };
      if (event.kind === 'quote') return { blockId: 'stoic', event: 'save' };
      if (event.kind === 'question') return { blockId: 'mock', event: 'save' };
      return null;
    default:
      return null;
  }
}

/** @param {unknown} snapshot */
export function briefingBlockIdsFromSnapshot(snapshot) {
  const blocks = Array.isArray(/** @type {any} */ (snapshot)?.blocks)
    ? /** @type {any} */ (snapshot).blocks
    : [];
  return /** @type {string[]} */ ([
    ...new Set(blocks.map((/** @type {any} */ block) => block?.id).filter(isBriefingBlockId)),
  ]);
}

/** @param {string} dateKey @param {number} days */
function fromDateKey(dateKey, days) {
  if (!isDateKey(dateKey)) return null;
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() - Math.max(0, days - 1));
  return date.toISOString().slice(0, 10);
}

/**
 * Компактний власний зріз для `data.read(scope=briefing)`. Рекомендація
 * `less` — лише кандидат: вона НЕ змінює state і не приховує жоден блок.
 * @param {unknown} raw
 * @param {{ todayKey: string, days?: number }} input
 */
export function summarizeBriefingEngagement(raw, input) {
  const days = Math.min(90, Math.max(1, Math.trunc(input?.days ?? 30)));
  const from = fromDateKey(input?.todayKey, days);
  if (!from) return null;
  const engagement = normalizeBriefingEngagement(raw);
  const totals = new Map(
    BRIEFING_BLOCK_IDS.map((blockId) => [
      blockId,
      { block_id: blockId, exposed: 0, action: 0, save: 0, dismiss: 0 },
    ]),
  );
  let openDays = 0;
  for (const [dateKey, day] of Object.entries(engagement.days)) {
    if (dateKey < from || dateKey > input.todayKey) continue;
    if (day.opened) openDays += 1;
    for (const [blockId, values] of Object.entries(day.blocks)) {
      const total = totals.get(blockId);
      if (!total) continue;
      total.exposed += values.exposed;
      total.action += values.action;
      total.save += values.save;
      total.dismiss += values.dismiss;
    }
  }
  const blocks = [...totals.values()].filter(
    (entry) => entry.exposed || entry.action || entry.save || entry.dismiss,
  );
  if (!openDays && blocks.length === 0) return null;
  const noisyCandidates = blocks
    .filter(
      (entry) =>
        entry.exposed >= BRIEFING_NOISY_MIN_EXPOSURES &&
        entry.action + entry.save + entry.dismiss === 0,
    )
    .map((entry) => ({ block_id: entry.block_id, verdict: 'less' }));
  return {
    period: { from, to: input.todayKey, days },
    open_days: openDays,
    blocks,
    noisy_candidates: noisyCandidates,
    // Маркер для prompt/викликача: це спостереження, не наказ змінити UI.
    apply_automatically: false,
  };
}

/** @param {unknown} raw @param {{ todayKey: string, days?: number }} input */
export function formatBriefingEngagementDigest(raw, input) {
  const summary = summarizeBriefingEngagement(raw, input);
  if (!summary) return '';
  const rows = summary.blocks
    .map(
      (entry) =>
        `${entry.block_id}: показано ${entry.exposed} дн., дії ${entry.action}, збереження ${entry.save}, відхилення ${entry.dismiss}`,
    )
    .join('; ');
  const candidates = summary.noisy_candidates.length
    ? ` Кандидати на «менше такого» (не застосовано автоматично): ${summary.noisy_candidates.map((entry) => entry.block_id).join(', ')}.`
    : '';
  return `Залучення до брифінгу (${summary.period.from}…${summary.period.to}): відкрито у ${summary.open_days} дн.; ${rows}.${candidates}`;
}
