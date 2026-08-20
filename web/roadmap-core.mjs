// @ts-check
// Чиста логіка IT-роадмепу (Блок P3, 🗺Роадмеп): callback_data кодек,
// прогрес (чистий state-transform), форматування Telegram-повідомлень.
// Без I/O — Worker робить KV/editMessageText (worker.js:resolveRoadmapCallback).
// 100% Worker-side — жодного orchestrator-модуля, roadmap.json нема,
// TOPIC_ROADMAP не читається (усі відповіді реактивні, echo в чат/тему
// вхідного апдейту, той самий sendTo-патерн що й решта команд).

import { escapeHtml, progressBar } from './tg-core.mjs';
import { ROADMAP_TOPICS } from './roadmap-data.mjs';
import { weekStartKey, lastWeekStarts } from './stats-core.mjs';

// Окремий простір callback_data від v1:<dateKey>:... (P1), rm:<id> (P2a),
// pd:<action>:<id> (P2b/P2c).
export const ROADMAP_CB_PREFIX = 'rd:';

/** Глобальний ключ прогресу — ОДНЕ джерело істини (дерево ROADMAP_TOPICS), не дублювати в даних. */
export function progressKey(/** @type {string} */ topicId, /** @type {string} */ subtopicId) {
  return `${topicId}.${subtopicId}`;
}

/** Знайти тему за id; null якщо невідома (застарілий контент/чужа кнопка). */
export function findTopic(/** @type {string} */ topicId) {
  return ROADMAP_TOPICS.find((t) => t.id === topicId) ?? null;
}

/** Знайти підпункт у вже знайденій темі; null якщо тема відсутня чи підпункт невідомий. */
export function findSubtopic(/** @type {KvBlob} */ topic, /** @type {string} */ subtopicId) {
  if (!topic) return null;
  return topic.subtopics.find((/** @type {KvBlob} */ s) => s.id === subtopicId) ?? null;
}

/** callback_data кореня («список тем»). */
export function buildRootCallbackData() {
  return `${ROADMAP_CB_PREFIX}r`;
}

/** callback_data теми («список підпунктів»); ≤64 байти (Telegram-ліміт), інакше null. */
export function buildTopicCallbackData(/** @type {string} */ topicId) {
  const s = `${ROADMAP_CB_PREFIX}t:${topicId}`;
  return new TextEncoder().encode(s).length <= 64 ? s : null;
}

/** callback_data toggle конкретного підпункту; ≤64 байти, інакше null. */
export function buildToggleCallbackData(
  /** @type {string} */ topicId,
  /** @type {string} */ subtopicId,
) {
  const s = `${ROADMAP_CB_PREFIX}s:${topicId}:${subtopicId}`;
  return new TextEncoder().encode(s).length <= 64 ? s : null;
}

/**
 * Розібрати `rd:...` callback_data ->
 * {kind:'root'} | {kind:'topic',topicId} | {kind:'toggle',topicId,subtopicId} | null.
 */
export function parseRoadmapCallbackData(/** @type {unknown} */ data) {
  if (typeof data !== 'string' || !data.startsWith(ROADMAP_CB_PREFIX)) return null;
  const rest = data.slice(ROADMAP_CB_PREFIX.length);
  if (rest === 'r') return { kind: 'root' };
  const parts = rest.split(':');
  if (parts[0] === 't' && parts.length === 2 && parts[1]) {
    return { kind: 'topic', topicId: parts[1] };
  }
  if (parts[0] === 's' && parts.length === 3 && parts[1] && parts[2]) {
    return { kind: 'toggle', topicId: parts[1], subtopicId: parts[2] };
  }
  return null;
}

/** Чистий touch — справжній toggle (додає якщо нема, прибирає якщо є). Новий об'єкт. */
export function toggleProgress(
  /** @type {KvBlob} */ progress,
  /** @type {string} */ topicId,
  /** @type {string} */ subtopicId,
  /** @type {string} */ nowIso,
) {
  const key = progressKey(topicId, subtopicId);
  const next = { ...progress };
  if (key in next) delete next[key];
  else next[key] = nowIso;
  return next;
}

/** {done,total} для однієї теми. */
export function topicProgress(/** @type {KvBlob} */ progress, /** @type {KvBlob} */ topic) {
  const total = topic.subtopics.length;
  const done = topic.subtopics.filter(
    (/** @type {KvBlob} */ s) => progressKey(topic.id, s.id) in progress,
  ).length;
  return { done, total };
}

/** {done,total} по всіх темах разом. */
export function totalProgress(/** @type {KvBlob} */ progress) {
  let done = 0;
  let total = 0;
  for (const topic of ROADMAP_TOPICS) {
    const p = topicProgress(progress, topic);
    done += p.done;
    total += p.total;
  }
  return { done, total };
}

/**
 * Скільки підпунктів позначено ЗАВЕРШЕНИМИ в кожному з останніх `weeks`
 * тижнів — не нова статистика, а сурфейс уже наявних даних: toggleProgress
 * (вище) і так пише ISO-таймстемп у progress[key] при позначенні, просто
 * totalProgress його ніколи не читав (лише {done,total}, без часу). Той
 * самий {week,count}-шейп, що appliedWeekly (stats-core.mjs) — не вигадую
 * нову форму контракту.
 */
export function roadmapWeekly(
  /** @type {KvBlob} */ progress,
  /** @type {string} */ todayKey,
  weeks = 12,
) {
  const starts = lastWeekStarts(todayKey, weeks);
  const counts = Object.fromEntries(starts.map((k) => [k, 0]));
  for (const iso of Object.values(progress)) {
    if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(iso)) continue;
    const wk = weekStartKey(iso.slice(0, 10));
    if (counts[wk] != null) counts[wk]++;
  }
  return starts.map((k) => ({ week: k, count: counts[k] }));
}

/** Перший невідмічений підпункт у канонічному порядку тем/підпунктів; null якщо все зроблено. */
export function findNextIncomplete(/** @type {KvBlob} */ progress) {
  for (const topic of ROADMAP_TOPICS) {
    for (const sub of topic.subtopics) {
      if (!(progressKey(topic.id, sub.id) in progress)) {
        return { topicId: topic.id, subtopicId: sub.id };
      }
    }
  }
  return null;
}

/** Повідомлення кореня: загальний прогрес + список тем. */
export function formatRootMessage(/** @type {KvBlob} */ progress) {
  const { done, total } = totalProgress(progress);
  const bar = progressBar(done, total);
  return `🗺 <b>IT-роадмеп</b> — ${bar ? bar + ' ' : ''}${done}/${total}\n\nОбери тему:`;
}

/** Inline-клавіатура кореня: рядок на тему + рядок «▶️ Наступний». */
export function buildRootKeyboard(/** @type {KvBlob} */ progress) {
  const rows = ROADMAP_TOPICS.map((topic) => {
    const { done, total } = topicProgress(progress, topic);
    const cb = buildTopicCallbackData(topic.id);
    return cb ? [{ text: `${topic.title} (${done}/${total})`, callback_data: cb }] : [];
  }).filter((row) => row.length > 0);

  const next = findNextIncomplete(progress);
  if (next) {
    const cb = buildTopicCallbackData(next.topicId);
    if (cb) rows.push([{ text: '▶️ Наступний', callback_data: cb }]);
  }
  return { inline_keyboard: rows };
}

/** Повідомлення теми: назва+прогрес теми + інструкція. */
export function formatTopicMessage(/** @type {KvBlob} */ topic, /** @type {KvBlob} */ progress) {
  const { done, total } = topicProgress(progress, topic);
  const bar = progressBar(done, total);
  return `${escapeHtml(topic.title)} — ${bar ? bar + ' ' : ''}${done}/${total}\n\nТисни на пункт, щоб позначити пройденим:`;
}

/** Матеріали теми (F5): [{title,url}] або порожньо, якщо не курували. */
export function topicMaterials(/** @type {KvBlob} */ topic) {
  return (Array.isArray(topic?.materials) ? topic.materials : []).filter(
    (/** @type {KvBlob} */ m) =>
      m && typeof m.title === 'string' && /^https:\/\//.test(m.url ?? ''),
  );
}

/**
 * Inline-клавіатура теми: рядок на підпункт (✅/▫️+назва) + матеріали + «⬅️ Назад».
 *
 * Матеріали — URL-кнопки ({text,url}), не callback: Telegram відкриє їх сам, без
 * зайвого раунду до воркера. Лише https — url-кнопка з чимось іншим (або з
 * битим значенням) валить увесь sendMessage помилкою Telegram, а не тихо
 * зникає, тож фільтр у topicMaterials боронить усе повідомлення.
 */
export function buildTopicKeyboard(/** @type {KvBlob} */ topic, /** @type {KvBlob} */ progress) {
  const rows = topic.subtopics
    .map((/** @type {KvBlob} */ sub) => {
      const done = progressKey(topic.id, sub.id) in progress;
      const cb = buildToggleCallbackData(topic.id, sub.id);
      if (!cb) return [];
      return [{ text: `${done ? '✅' : '▫️'} ${sub.title}`, callback_data: cb }];
    })
    .filter((/** @type {unknown[]} */ row) => row.length > 0);
  for (const m of topicMaterials(topic)) rows.push([{ text: `📚 ${m.title}`, url: m.url }]);
  rows.push([{ text: '⬅️ Назад', callback_data: buildRootCallbackData() }]);
  return { inline_keyboard: rows };
}
