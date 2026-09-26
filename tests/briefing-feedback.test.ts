import { describe, expect, it } from 'vitest';
import {
  applyBriefingFeedback,
  briefingBlockPreference,
  parseBriefingFeedback,
} from '../web/core/brief/feedback.mjs';
import { ACTION_LEVELS, decideLevel } from '../web/core/policy/core.mjs';
import { EXECUTORS } from '../web/core/policy/proposals.mjs';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';

const NOW = Date.parse('2026-09-26T08:00:00.000Z');

describe('briefing feedback — bounded owner preference', () => {
  it('accepts only known blocks/verdicts and useful restores a hidden block', () => {
    const hidden = applyBriefingFeedback({}, { blockId: 'weather', verdict: 'hide' }, NOW);
    expect(hidden.result).toEqual({ block_id: 'weather', verdict: 'hide', preference: 'hidden' });
    expect(briefingBlockPreference(hidden.next, 'weather')).toBe('hidden');

    const restored = applyBriefingFeedback(
      hidden.next,
      { blockId: 'weather', verdict: 'useful' },
      NOW + 1,
    );
    expect(restored.result.preference).toBe('normal');
    expect(briefingBlockPreference(restored.next, 'weather')).toBe('normal');
    expect(() =>
      applyBriefingFeedback({}, { blockId: 'not-a-block', verdict: 'hide' }, NOW),
    ).toThrow('невідомий block_id');
    expect(() => applyBriefingFeedback({}, { blockId: 'weather', verdict: 'delete' }, NOW)).toThrow(
      'verdict',
    );
  });

  it('less only lowers presentation preference and a malformed stored blob is fail-open', () => {
    const useful = applyBriefingFeedback({}, { blockId: 'news', verdict: 'useful' }, NOW);
    const less = applyBriefingFeedback(useful.next, { blockId: 'news', verdict: 'less' }, NOW + 1);
    expect(briefingBlockPreference(less.next, 'news')).toBe('less');
    expect(less.next.blocks.news?.useful).toBe(1); // статистика зберігається, але не перемагає останній вибір
    expect(briefingBlockPreference({ blocks: { weather: { hidden: true } } }, 'weather')).toBe(
      'hidden',
    );
    expect(briefingBlockPreference({ blocks: { invented: { hidden: true } } }, 'weather')).toBe(
      'normal',
    );
    expect(parseBriefingFeedback({ version: 999, blocks: { weather: 'bad' } })).toEqual({
      version: 1,
      blocks: {},
    });
  });
});

describe('briefing.feedback policy executor', () => {
  it('is T0 with undo, but a tainted session escalates it to T1', () => {
    expect(ACTION_LEVELS['briefing.feedback']).toBe('T0');
    expect(decideLevel('briefing.feedback', false, { block_id: 'news', verdict: 'hide' })).toEqual({
      level: 'T0',
    });
    // External content may not silently change what the owner sees every
    // morning; the same request becomes a visible confirmation proposal.
    expect(decideLevel('briefing.feedback', true, { block_id: 'news', verdict: 'hide' })).toEqual({
      level: 'T1',
    });
  });

  it('writes only its narrow state key and restores the exact previous value on undo', async () => {
    const kv = new Map<string, string>([['state', JSON.stringify({ unrelated: { keep: true } })]]);
    const env = workerEnv({ BRIEFING: memoryKv(kv) });
    const executor = EXECUTORS['briefing.feedback'];
    if (!executor) throw new Error('briefing.feedback executor is missing');

    const out = await executor.execute(env, { block_id: 'mail', verdict: 'hide' }, NOW);
    expect(out.result).toEqual({ block_id: 'mail', verdict: 'hide', preference: 'hidden' });
    const stored = JSON.parse(kv.get('state') ?? '{}');
    expect(stored.unrelated).toEqual({ keep: true });
    expect(briefingBlockPreference(stored.briefingFeedback, 'mail')).toBe('hidden');
    // hide — це explicit dismiss повного блока, тому лягає в окремий
    // агрегований audit. Сам текст briefing-а чи назва нічого сюди не їдуть.
    const engagement = JSON.parse(kv.get('stats') ?? '{}').briefingEngagement;
    expect(engagement.days['2026-09-26'].blocks.mail).toMatchObject({ dismiss: 1 });

    await executor.undo?.(env, out.prev, NOW + 1);
    expect(JSON.parse(kv.get('state') ?? '{}')).toEqual({ unrelated: { keep: true } });
  });
});
