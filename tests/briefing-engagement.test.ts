import { describe, expect, it } from 'vitest';
import {
  briefingBlockIdsFromSnapshot,
  formatBriefingEngagementDigest,
  recordBriefingInteraction,
  recordBriefingOpen,
  summarizeBriefingEngagement,
} from '../web/core/brief/engagement.mjs';
import { recordEvent } from '../web/stats-core.mjs';

const NOW = Date.parse('2026-09-26T08:00:00.000Z');

describe('briefing engagement — bounded private aggregate', () => {
  it('counts the current briefing and every shown block once per Kyiv day', () => {
    const first = recordBriefingOpen(null, {
      dateKey: '2026-09-26',
      blockIds: ['news', 'weather', 'invented'],
      nowMs: NOW,
    });
    const repeat = recordBriefingOpen(first, {
      dateKey: '2026-09-26',
      blockIds: ['news', 'weather'],
      nowMs: NOW + 1,
    });

    expect(repeat.days['2026-09-26']).toMatchObject({ opened: true });
    expect(repeat.days['2026-09-26']?.blocks).toEqual({
      news: { exposed: 1, action: 0, save: 0, dismiss: 0 },
      weather: { exposed: 1, action: 0, save: 0, dismiss: 0 },
    });
    expect(briefingBlockIdsFromSnapshot({ blocks: [{ id: 'news' }, { id: 'unknown' }] })).toEqual([
      'news',
    ]);
  });

  it('keeps only allowlisted counters and does not let malformed data nominate a noisy block', () => {
    const afterAction = recordBriefingInteraction(
      { days: { '2026-09-01': { opened: true, blocks: { invented: { exposed: 999 } } } } },
      { dateKey: '2026-09-01', blockId: 'news', event: 'action', nowMs: NOW },
    );
    expect(afterAction.days['2026-09-01']?.blocks).toEqual({
      news: { exposed: 0, action: 1, save: 0, dismiss: 0 },
    });
    expect(
      recordBriefingInteraction(afterAction, {
        dateKey: 'bad-date',
        blockId: 'news',
        event: 'save',
        nowMs: NOW,
      }),
    ).toEqual(afterAction);
  });

  it('covers existing action/save/dismiss event paths without storing their URL, title or content', () => {
    let stats: Record<string, unknown> = {};
    stats = recordEvent(
      stats,
      { type: 'news_click', url: 'https://private.example', category: 'x' },
      '2026-09-26',
      null,
      new Date(NOW).toISOString(),
    );
    stats = recordEvent(
      stats,
      { type: 'save_item', kind: 'quote', id: 'private-text', title: 'private' },
      '2026-09-26',
      null,
      new Date(NOW).toISOString(),
    );
    stats = recordEvent(
      stats,
      { type: 'job_dismiss', url: 'https://private.example/job' },
      '2026-09-26',
      null,
      new Date(NOW).toISOString(),
    );

    const blocks = (
      stats.briefingEngagement as {
        days: Record<string, { blocks: Record<string, Record<string, number>> }>;
      }
    ).days['2026-09-26']!.blocks;
    expect(blocks.news).toMatchObject({ action: 1 });
    expect(blocks.stoic).toMatchObject({ save: 1 });
    expect(blocks.jobs).toMatchObject({ dismiss: 1 });
    expect(JSON.stringify(stats.briefingEngagement)).not.toContain('private');
  });

  it('recommends less only after seven shown days with no interaction and never applies it itself', () => {
    let engagement: unknown = null;
    for (let day = 1; day <= 7; day += 1) {
      engagement = recordBriefingOpen(engagement, {
        dateKey: `2026-09-0${day}`,
        blockIds: ['weather', 'news'],
        nowMs: NOW,
      });
    }
    engagement = recordBriefingInteraction(engagement, {
      dateKey: '2026-09-07',
      blockId: 'news',
      event: 'save',
      nowMs: NOW,
    });

    const summary = summarizeBriefingEngagement(engagement, {
      todayKey: '2026-09-07',
      days: 7,
    });
    expect(summary?.noisy_candidates).toEqual([{ block_id: 'weather', verdict: 'less' }]);
    expect(summary?.apply_automatically).toBe(false);
    expect(
      formatBriefingEngagementDigest(engagement, { todayKey: '2026-09-07', days: 7 }),
    ).toContain('не застосовано автоматично');
  });
});
