export const CHECKIN_FLOW_REVISION: 2;
export const STATE_RATING_LABELS: Record<'energy' | 'mood', string[]>;
export type RecordedStateRating = { value: number; scale: number };
export function coarseRatingV4(value: unknown): number | null;
export function recordedStateRating(
  record: Record<string, unknown>,
  metric: 'energy' | 'mood',
): RecordedStateRating | null;
export function stateRatingBand(rating: RecordedStateRating): 0 | 1 | 2;
export function stateRatingDirection(a: RecordedStateRating, b: RecordedStateRating): number;
