import { z } from 'zod';
export const credentialEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  label: z.string(),
  location: z.string(),
  legacy: z.boolean(),
  configured: z.boolean().nullable(),
  recommendedRotationDays: z.number().nullable(),
  version: z.number().int(),
  rotatedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  expiryKind: z.enum(['unknown', 'date', 'non-expiring']).optional(),
  rotateAfterDays: z.number().nullable(),
  legacyRotationAt: z.string().nullable(),
  expiryDaysLeft: z.number().nullable(),
  rotationDaysLeft: z.number().nullable(),
});
export const credentialsSchema = z.object({
  available: z.boolean(),
  entries: z.array(credentialEntrySchema),
  google: z.object({
    known: z.boolean(),
    ok: z.boolean(),
    configured: z.boolean(),
    verified: z.boolean(),
    checkedAt: z.string().nullable(),
    missing: z.array(z.string()),
    extra: z.array(z.string()),
    redundant: z.array(z.string()),
    features: z.record(z.string(), z.boolean().nullable()),
  }),
});
export type CredentialEntry = z.infer<typeof credentialEntrySchema>;
export type Credentials = z.infer<typeof credentialsSchema>;
export type CredentialMetadata = Pick<
  CredentialEntry,
  'id' | 'version' | 'rotatedAt' | 'expiresAt' | 'rotateAfterDays' | 'expiryKind'
>;
