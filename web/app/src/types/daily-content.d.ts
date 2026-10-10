declare module '*core/brief/daily-content.mjs' {
  export const CONTENT_TOPICS: Record<string, string>;
  export function contentIdentity(
    item: { id?: string; fact?: string; text?: string; author?: string; reference?: string },
    kind: 'fact' | 'quote',
  ): string;
}
