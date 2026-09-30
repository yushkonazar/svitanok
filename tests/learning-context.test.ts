import { describe, expect, it } from 'vitest';
import { buildLearningContext } from '../web/core/tools/learning-context.mjs';

describe('learning context for tutor', () => {
  it('exposes real roadmap state and dated ratings without treating difficulty as correctness', () => {
    const result = buildLearningContext(
      { 'frontend.html-semantics': '2026-09-28T12:00:00.000Z' },
      { old: 'hard', new: { r: 'easy', at: '2026-09-29', topic: 'frontend' } },
      { frontend: { seen: 3, weak: 2 } },
    );
    const frontend = result.topics.find((topic) => topic.id === 'frontend');
    expect(frontend?.done).toBe(1);
    expect(frontend?.subtopics.find((topic) => topic.id === 'html-semantics')?.completed_at).toBe(
      '2026-09-28T12:00:00.000Z',
    );
    expect(result.recent_ratings).toEqual([
      { question_id: 'new', rating: 'easy', at: '2026-09-29', topic: 'frontend' },
      { question_id: 'old', rating: 'hard', at: null, topic: null },
    ]);
    expect(result.mock_difficulty).toEqual([{ name: 'frontend', seen: 3, hard: 2 }]);
    expect(result.caveat).toContain('not scored answers');
  });
});
