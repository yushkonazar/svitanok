// Звʼязка mock↔roadmap (Фаза A4): ЯВНА таблиця мапінгу словника mock-тем
// (src/modules/mock.ts MOCK_TOPICS — вони ж ключі mockWeights) на СТАБІЛЬНІ id
// тем роадмепу (web/roadmap-data.mjs). Назви не рівні рядково (mock 'HTTP' vs
// roadmap '📡 HTTP / мережі (поглиблено)'), тож рівність назв — не механізм.
// Мапінг many-to-many і свідомо lossy: tools/ecosystem/testing-adv/perf-a11y
// не мають mock-теми — «тема тижня» з них показується без mock-зв'язки.
// mockWeights і roadmapProgress ЛИШАЮТЬСЯ незалежними KV-стейтами; звʼязок —
// лише через ці чисті функції (жодної нової синхронізації станів).
//
// Споживачі: worker.js (handleStats -> stats.mastery для дашборда;
// scheduled -> state.masteryFocus для оркестратора). Оркестратор (mock.ts)
// web-код НЕ імпортує — читає готовий masteryFocus зі state (межа src/↔web/).

import { ROADMAP_TOPICS } from './roadmap-data.mjs';
import { findTopic, topicProgress } from './roadmap-core.mjs';
import { weekStartKey } from './stats-core.mjs';

/** mock-тема (ключ MOCK_TOPICS/mockWeights) -> id тем роадмепу. */
export const MOCK_TO_ROADMAP = {
  Мова: ['frontend', 'typescript'],
  Фреймворк: ['react'],
  HTTP: ['networking', 'backend'],
  'Бази даних': ['databases'],
  Алгоритми: ['algorithms'],
  Патерни: ['backend'],
  Безпека: ['security'],
  'AI/LLM': ['ai-dev'],
};

/** Зворотна мапа: id теми роадмепу -> mock-теми (порожньо для roadmap-only тем). */
export function roadmapToMock() {
  const out = {};
  for (const t of ROADMAP_TOPICS) out[t.id] = [];
  for (const [mockTopic, ids] of Object.entries(MOCK_TO_ROADMAP)) {
    for (const id of ids) if (out[id]) out[id].push(mockTopic);
  }
  return out;
}

/**
 * Підказки «куди вчитись» для слабких mock-тем (дашборд, C · Майстерність):
 * weakTopics = [{name, value}] з aggregateStats -> для кожної слабкої теми
 * повʼязані теми роадмепу з прогресом. Теми без мапінгу відпадають.
 */
export function masteryHints(weakTopics, progress) {
  const p = progress && typeof progress === 'object' ? progress : {};
  return (Array.isArray(weakTopics) ? weakTopics : [])
    .filter((w) => w && typeof w.name === 'string')
    .map((w) => ({
      mockTopic: w.name,
      themes: (MOCK_TO_ROADMAP[w.name] ?? [])
        .map((id) => {
          const t = findTopic(id);
          if (!t) return null;
          const { done, total } = topicProgress(p, t);
          return { id, title: t.title, done, total };
        })
        .filter(Boolean),
    }))
    .filter((h) => h.themes.length > 0);
}

/**
 * «Тема тижня»: детермінована ротація НЕзавершених тем роадмепу за індексом
 * ISO-тижня (той самий результат для будь-якого dateKey одного тижня — тому
 * щоденний перезапис state.masteryFocus безпечний). Все завершено -> null.
 */
export function themeOfWeek(progress, dateKey) {
  const p = progress && typeof progress === 'object' ? progress : {};
  const incomplete = ROADMAP_TOPICS.filter((t) => topicProgress(p, t).done < t.subtopics.length);
  if (!incomplete.length) return null;
  const week = weekStartKey(dateKey);
  const weekIdx = Math.round(Date.parse(week + 'T00:00:00Z') / 604800000);
  const t = incomplete[((weekIdx % incomplete.length) + incomplete.length) % incomplete.length];
  const { done, total } = topicProgress(p, t);
  return {
    week,
    topicId: t.id,
    title: t.title,
    done,
    total,
    mockTopics: roadmapToMock()[t.id] ?? [],
  };
}
