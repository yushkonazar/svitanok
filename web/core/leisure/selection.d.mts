export type LeisureSelection = {
  minFoodRating: number;
  parking: 'any' | 'preferred' | 'required';
  weeklyLimit: number;
  formatFrequency: Record<string, 'often' | 'sometimes' | 'rare' | 'manual'>;
  followedPodcastSeries: string[];
  categoryOverrides: Record<string, { category: string; eventFormat: string }>;
};
export const DEFAULT_LEISURE_SELECTION: LeisureSelection;
export const LEISURE_FREQUENCIES: Record<string, string>;
export function normalizeLeisureSelection(input: any, previous?: any): LeisureSelection;
export function leisureFoodQuality(
  item: any,
  preferences?: any,
  decision?: any,
  transport?: string,
): {
  rating: number | null;
  count: number | null;
  hasParking: boolean | null;
  eligible: boolean;
  priority: boolean;
  verified: boolean;
  score: number;
  reasons: string[];
};
export function leisureWorkKey(item: any): string;
export function leisureFormatAvailable(
  item: any,
  records: any[],
  settings: any,
  nowMs: number,
  explicit?: boolean,
): boolean;
export function selectLeisureHighlights<T>(
  items: T[],
  records: any[],
  settings: any,
  nowMs: number,
): T[];
