// A bounded, explicit learning read model for the tutor. Ratings are self-reported
// difficulty, not correctness; legacy ratings without dates/topics stay separate.
import { ROADMAP_TOPICS } from '../../roadmap-data.mjs';
import { progressKey } from '../../roadmap-core.mjs';

/** @param {Record<string, unknown>} progress @param {Record<string, unknown>} ratings @param {Record<string, any>} mockTopics */
export function buildLearningContext(progress, ratings, mockTopics) {
  const topics = ROADMAP_TOPICS.map((topic) => ({
    id: topic.id,
    title: topic.title,
    done: topic.subtopics.filter((s) => progress[progressKey(topic.id, s.id)] != null).length,
    total: topic.subtopics.length,
    subtopics: topic.subtopics.map((s) => ({
      id: s.id,
      title: s.title,
      completed_at:
        typeof progress[progressKey(topic.id, s.id)] === 'string'
          ? progress[progressKey(topic.id, s.id)]
          : null,
    })),
    materials: topic.materials.slice(0, 2),
  }));
  const recent = Object.entries(ratings ?? {})
    .flatMap(([questionId, value]) => {
      const record = /** @type {{ r?: unknown, at?: unknown, topic?: unknown }} */ (
        typeof value === 'object' && value !== null ? value : { r: value }
      );
      if (record.r !== 'easy' && record.r !== 'hard') return [];
      return [
        {
          question_id: questionId,
          rating: record.r,
          at: typeof record.at === 'string' ? record.at : null,
          topic: typeof record.topic === 'string' ? record.topic : null,
        },
      ];
    })
    .sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')))
    .slice(0, 60);
  const difficulty = Object.entries(mockTopics ?? {})
    .filter(([, value]) => Number(value?.seen) > 0)
    .map(([name, value]) => ({
      name,
      seen: Number(value.seen),
      hard: Number(value.weak ?? 0),
    }));
  return {
    source: 'saved_roadmap_and_mock_ratings',
    caveat:
      'ratings are self-reported difficulty, not scored answers; topic names may not match roadmap IDs',
    topics,
    mock_difficulty: difficulty,
    recent_ratings: recent,
    ratings_truncated_to: 60,
  };
}
