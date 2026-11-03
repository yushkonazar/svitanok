export function decodeNewsText(text: string): string;
export function cleanNewsText(text: string): string;
export function newsSourceExcerpt(html: string): string;
export function safeNewsImage(value: string): string | null;
export function newsFingerprint(text: string): Promise<string>;
export function canonicalNewsText(text: string): string;
export function newsContext(title: string, text: string, limit?: number): string;
