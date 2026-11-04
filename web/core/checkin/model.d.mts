import type { Card } from './catalog.mjs';
import type { AdaptiveContext } from './adaptive-v4.mjs';
type Answers = Record<string, unknown>;
export function adaptiveModel(a: Answers): {
  cards: Record<string, Card[]>;
  details: Card[];
  clean(slot: string, raw: Answers): { set: Answers; clear: string[] };
  clearHidden(slot: string, a: Answers, context?: Partial<AdaptiveContext>): Answers;
  complete(slot: string, a: Answers): boolean;
  followups(slot: string, a: Answers, context?: Partial<AdaptiveContext>): Card[];
  context(records: Answers, date: string, slot: string): AdaptiveContext;
};
export const adaptiveCatalog: Card[];
