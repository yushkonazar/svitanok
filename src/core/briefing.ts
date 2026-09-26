// briefing.json — структуровані дані для Mini App (дашборд). Містить УСІ блоки
// всі блоки, кожен зі своїм `data`. Сторінка читає це й рендерить.

import type { Block } from './types.js';
import type { DecisionBrief } from './decision-brief.js';

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
  // Нова top-level секція. Поточний Mini App її ігнорує, тому контракт UI не
  // змінюється; Telegram уже показує стислий critical headline.
  decision?: DecisionBrief;
}

export function buildBriefingData(
  blocks: Block[],
  dateLabel: string,
  generatedAt: string,
  decision?: DecisionBrief,
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
    ...(decision && decision.signals.length > 0 ? { decision } : {}),
  };
}
