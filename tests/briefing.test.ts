import { describe, it, expect } from 'vitest';
import { buildBriefingData } from '../src/core/briefing.js';
import type { Block } from '../src/core/types.js';

const b = (over: Partial<Block> & { id: string; priority: number }): Block => ({
  title: 'T',
  summary: 'S',
  ...over,
});

describe('buildBriefingData', () => {
  it('сортує за priority, містить data й УСІ блоки (зокрема inMessage:false)', () => {
    const data = buildBriefingData(
      [
        b({ id: 'jobs', priority: 55, title: 'Вакансії', data: { items: [{ score: 92 }] } }),
        b({ id: 'fact', priority: 20, title: 'Факт', inMessage: false, summary: 'цікаво' }),
      ],
      'Вівторок, 30 червня',
      '2026-06-30T05:00:00.000Z',
    );
    expect(data.dateLabel).toBe('Вівторок, 30 червня');
    expect(data.generatedAt).toBe('2026-06-30T05:00:00.000Z');
    // відсортовано: fact (20) перед jobs (55)
    expect(data.blocks.map((x) => x.id)).toEqual(['fact', 'jobs']);
    // inMessage:false блок присутній у даних дашборда
    expect(data.blocks[0]!.summary).toBe('цікаво');
    expect(data.blocks[1]!.data).toEqual({ items: [{ score: 92 }] });
  });

  it('пропускає icon/data, коли їх немає', () => {
    const data = buildBriefingData([b({ id: 'x', priority: 1 })], 'д', 'iso');
    expect(data.blocks[0]).toEqual({ id: 'x', title: 'T', summary: 'S', priority: 1 });
  });
});
