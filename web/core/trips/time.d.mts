export function tripZone(value: unknown, fallback?: string): string;
export function tripLocalParts(ms: number, zone: string): { date: string; clock: string };
export function tripInstant(local: string, zone: string): number;
export function tripSlot(date: string, clock: string, zone: string): number | null;
