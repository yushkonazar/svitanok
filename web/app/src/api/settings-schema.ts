import { z } from 'zod';

// Контракт /api/settings (роадмеп v3, F2). Форма списана з web/settings-core.mjs
// (normalizeSettings) + connectorStatus. Сервер уже нормалізує все, що віддає,
// тож defaults тут — страховка від старого/битого блоба, а не робоча логіка.

const hhmm = z.string().regex(/^\d{2}:\d{2}$/);

export const quietSchema = z.object({
  enabled: z.boolean().default(false),
  from: hhmm.default('22:00'),
  to: hhmm.default('08:00'),
});

export const settingsSchema = z.object({
  quiet: quietSchema.default({ enabled: false, from: '22:00', to: '08:00' }),
  /** Лише ЯВНІ оверрайди; відсутній id = дефолт config.yml (для перемикних — увімкнено). */
  modules: z.record(z.boolean()).default({}),
});

export const connectorsSchema = z.object({
  google: z.boolean().default(false),
  calendar: z.boolean().default(false),
  gmail: z.boolean().default(false),
});

export const settingsResponseSchema = z.object({
  settings: settingsSchema,
  connectors: connectorsSchema,
});

export type Settings = z.infer<typeof settingsSchema>;
export type Connectors = z.infer<typeof connectorsSchema>;
export type SettingsResponse = z.infer<typeof settingsResponseSchema>;

/** Частковий патч, який шле екран; у повний блоб його зводить useSaveSettings. */
export interface SettingsPatch {
  quiet?: Partial<Settings['quiet']>;
  modules?: Record<string, boolean>;
}
