export const XP_CATEGORIES: { xp: number; title: string; detail: string }[];
export const PLAN_AREAS: Record<string, string>;
export function suggestTaskScore(input?: {
  effort?: number;
  contribution?: number;
  challenge?: number;
  estimateMinutes?: number;
  routine?: boolean;
}): { xp: number; title: string; detail: string; reasons: string[] };
