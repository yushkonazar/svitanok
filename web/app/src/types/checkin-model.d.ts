declare module '*checkin-model.mjs' {
  export function flattenCheckinDay(
    rec: import('../api/schema.ts').CheckinDay,
    asList: (value: unknown) => unknown[],
    categories: string[],
  ): Record<string, unknown>;
  export function dayIndices(
    day: Record<string, unknown>,
  ): Record<'recovery' | 'resource' | 'work' | 'agency' | 'body', number | null>;
}
