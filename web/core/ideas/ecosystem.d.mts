export const IDEA_AREAS: { id: string; label: string; description: string; sources: string[] }[];
export const IDEA_KINDS: Record<string, string>;
export function ideaEcosystemContext(): {
  version: string;
  reviewedOn: string;
  scope: string;
  areas: typeof IDEA_AREAS;
};
