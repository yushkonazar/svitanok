export type MemoryRecord = {
  schemaVersion: 2;
  type: string;
  domain: string;
  subject: string;
  relation: string;
  details?: string;
  entityId?: string;
  properties?: { per100?: number; fuel?: string };
};
export const MEMORY_TYPES: string[];
export const MEMORY_DOMAINS: string[];
export const MEMORY_RELATIONS: string[];
export const MEMORY_TYPE_LABELS: Record<string, string>;
export function isMemoryRecord(value: unknown): value is MemoryRecord;
export function assertMemoryRecord(value: unknown): void;
export function memorySemantics(
  kind: string,
  key: string,
  value: unknown,
): { type: string; domain: string; relation: string; structured: boolean; needsReview: boolean };
export function memoryRecordText(value: MemoryRecord): string;
