import { z } from 'zod';
export const memoryPreferencesSchema = z.object({
  version: z.literal(1),
  mode: z.enum(['confirm', 'explicit']),
  categories: z.array(z.enum(['preferences', 'schedule', 'style'])),
});
export const memoryEntrySchema = z.object({
  id: z.string(),
  label: z.string(),
  value: z.unknown(),
  semantics: z
    .object({
      type: z.string(),
      domain: z.string(),
      relation: z.string(),
      structured: z.boolean(),
      needsReview: z.boolean(),
    })
    .optional(),
  text: z.string(),
  editable: z.boolean(),
  source: z.enum(['owner_assertion', 'observed_event', 'model_hypothesis']),
  token: z.string(),
  updatedAt: z.string(),
  stale: z.boolean(),
  reviewDue: z.boolean(),
  expiresAt: z.string().nullable(),
  reviewAt: z.string().nullable(),
});
export const memoryWorkspaceSchema = z.object({
  preferences: memoryPreferencesSchema,
  preferencesToken: z.string(),
  preferencesValid: z.boolean(),
  entries: z.array(memoryEntrySchema),
  candidates: z.array(
    z.object({
      id: z.string(),
      type: z.enum(['save', 'remove']),
      label: z.string(),
      text: z.string(),
      expiresAt: z.string(),
      stale: z.boolean().optional(),
    }),
  ),
  offset: z.number().int().nonnegative(),
  truncated: z.boolean().optional(),
  nextOffset: z.number().int().nonnegative().nullable(),
});
export type MemoryPreferences = z.infer<typeof memoryPreferencesSchema>;
export type MemoryEntry = z.infer<typeof memoryEntrySchema>;
export type MemoryWorkspace = z.infer<typeof memoryWorkspaceSchema>;
export type MemoryCommand =
  | { type: 'preferences'; preferences: MemoryPreferences; token: string }
  | { type: 'update'; id: string; value: unknown; token: string; confirm: true; renew: boolean }
  | { type: 'remove'; id: string; token: string; confirm: true }
  | { type: 'resolve'; id: string; choice: 'ok' | 'no' };
export type MemoryMutationReceipt = { message: string; snapshot: MemoryWorkspace | null };
export class MemoryChangeError extends Error {
  refreshRequired: boolean;
  constructor(message: string, refreshRequired = false) {
    super(message);
    this.refreshRequired = refreshRequired;
  }
}
