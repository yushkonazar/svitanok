// briefing.json — структуровані дані для Mini App (дашборд). Містить УСІ блоки
// (зокрема inMessage:false), кожен зі своїм `data`. Сторінка читає це й рендерить.

import type { Block } from './types.js';

export interface BriefingBlock {
  id: string;
  title: string;
  icon?: string;
  summary: string;
  data?: unknown;
  priority: number;
}

export interface BriefingData {
  generatedAt: string; // ISO
  dateLabel: string; // «Вівторок, 30 червня» (uk-UA)
  blocks: BriefingBlock[];
}

export function buildBriefingData(
  blocks: Block[],
  dateLabel: string,
  generatedAt: string,
): BriefingData {
  return {
    generatedAt,
    dateLabel,
    blocks: [...blocks]
      .sort((a, b) => a.priority - b.priority)
      .map((b) => ({
        id: b.id,
        title: b.title,
        ...(b.icon ? { icon: b.icon } : {}),
        summary: b.summary,
        ...(b.data !== undefined ? { data: b.data } : {}),
        priority: b.priority,
      })),
  };
}
