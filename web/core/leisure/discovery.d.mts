export const FEEDBACK_REASONS: string[];
export const FEATURE_LABELS: Record<string, string>;
export function explicitLeisureInterests(note: string): { feature: string; direction: number }[];
export function leisureFeatures(item: Record<string, any>): string[];
export interface LeisureProfile {
  signals: number;
  weights: Record<string, { positive: number; negative: number }>;
  interests: { feature: string; label: string; score: number; samples: number }[];
}
export interface KnownLeisurePlace {
  familiar: boolean;
  frequent: boolean;
  previousCount: number | null;
  trackedCount: number;
  legacyCount: number;
  since: string | null;
}
export function leisurePreferenceProfile(
  items: Record<string, any>[],
  records: Record<string, any>[],
  nowMs: number,
): LeisureProfile;
export function leisurePlaceIndex(records: Record<string, any>[]): Map<string, KnownLeisurePlace>;
export function knownLeisurePlace(
  item: Record<string, any>,
  records: Record<string, any>[],
  index?: Map<string, KnownLeisurePlace>,
): KnownLeisurePlace;
export function rankLeisureItems(
  items: Record<string, any>[],
  records: Record<string, any>[],
  previousIds: string[],
  settings: Record<string, any>,
  nowMs: number,
): { id: string; score: number; reasons: string[]; known: KnownLeisurePlace }[];
