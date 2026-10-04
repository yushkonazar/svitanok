import { z } from 'zod';
import { NEWS_SOURCE_IDS } from '../../../core/brief/news-catalog.mjs';

// Контракт /api/settings (роадмеп v3, F2). Форма списана з web/settings-core.mjs
// (normalizeSettings) + connectorStatus. Сервер уже нормалізує все, що віддає,
// тож defaults тут — страховка від старого/битого блоба, а не робоча логіка.

const hhmm = z.string().regex(/^\d{2}:\d{2}$/);

export const quietSchema = z.object({
  enabled: z.boolean().default(false),
  from: hhmm.default('22:00'),
  to: hhmm.default('08:00'),
});
export const checkinPreferencesSchema = z.object({
  modules: z.array(z.string()),
  schedule: z.object({ morning: hhmm, afternoon: hhmm, evening: hhmm, end: hhmm }),
  habits: z.array(
    z.object({ id: z.string(), name: z.string(), days: z.array(z.number().int().min(0).max(6)) }),
  ),
  categories: z.array(z.object({ id: z.string(), name: z.string(), group: z.string() })),
  hiddenCategories: z.array(z.string()),
});

export const settingsSchema = z.object({
  checkin: checkinPreferencesSchema.optional(),
  quiet: quietSchema.default({ enabled: false, from: '22:00', to: '08:00' }),
  /** Лише ЯВНІ оверрайди; відсутній id = дефолт config.yml (для перемикних — увімкнено). */
  // zod 4: обидві схеми обовʼязкові (див. коментар у schema.ts). Ключ — id модуля.
  modules: z.record(z.string(), z.boolean()).default({}),
  /** Приглушені теми новин (display-назви). Оркестратор ріже їх ДО запиту. */
  mutedTopics: z.array(z.string()).default([]),
  news: z
    .object({
      sources: z.array(z.enum(NEWS_SOURCE_IDS)),
      intervalHours: z.union([z.literal(3), z.literal(6), z.literal(12)]),
    })
    .optional(),
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
  checkin?: Settings['checkin'];
  news?: Settings['news'];
  quiet?: Partial<Settings['quiet']>;
  modules?: Record<string, boolean>;
  /** ПОВНИЙ новий список (не дельта) — тем мало, зводити дельту нема сенсу. */
  mutedTopics?: string[];
}
