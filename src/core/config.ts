// Завантаження + zod-валідація config.yml (§7). Невалідний конфіг падає ГУЧНО
// на старті (на відміну від рантайм-помилок модулів, що деградують тихо).
// js-yaml v4 `load` безпечний за замовчуванням — без кастомних конструкторів (§8).

import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { z } from 'zod';

const LocationSchema = z.object({
  lat: z.number(),
  lon: z.number(),
  name: z.string().min(1),
});

const ConfigSchema = z
  .object({
    timezone: z.string(),
    // Вікно [sendHour, sendHour+sendWindowHours), верх невключний.
    sendHour: z.number().int().min(0).max(23),
    sendWindowHours: z.number().int().min(1).max(23), // до 23 — тестовий період (§19.6)
    locations: z.array(LocationSchema).min(1),
    quietDay: z.object({
      triggerOn: z.array(z.string()),
    }),
    modules: z.object({
      stoic: z.object({ enabled: z.boolean() }),
      weather: z.object({ enabled: z.boolean() }),
      calendar: z.object({ enabled: z.boolean() }),
      news: z.object({
        enabled: z.boolean(),
        categories: z.array(z.string()),
        perCategory: z.number().int().positive(),
        dedupDays: z.number().int().nonnegative(),
        retentionDays: z.number().int().nonnegative(),
        sources: z.record(z.string(), z.array(z.string())).default({}),
      }),
      nextStep: z.object({
        enabled: z.boolean(),
        steps: z.array(z.string()),
      }),
      weeklyReview: z.object({
        enabled: z.boolean(),
        day: z.string(),
      }),
      fact: z.object({
        enabled: z.boolean(),
        batchSize: z.number().int().positive().default(30),
      }),
      mock: z.object({
        enabled: z.boolean(),
        batchSize: z.number().int().positive().default(15),
        profile: z.string().default(''),
      }),
      jobs: z.object({
        enabled: z.boolean(),
        perRun: z.number().int().positive().default(3),
        dedupDays: z.number().int().nonnegative().default(7),
        profile: z.string().default(''), // для LLM-скорингу релевантності
        sources: z.array(z.string()).default([]),
      }),
      currency: z.object({ enabled: z.boolean() }),
      onthisday: z.object({ enabled: z.boolean() }),
    }),
    llm: z.object({
      model: z.string().min(1),
      maxCallsPerRun: z.number().int().positive(),
      timeoutMs: z.number().int().positive(),
    }),
    fetch: z.object({
      timeoutMs: z.number().int().positive(),
      retries: z.number().int().nonnegative(),
    }),
    telegram: z.object({
      maxMessageChars: z.number().int().positive(),
    }),
  })
  // Без wraparound через північ (§7): вікно не перетинає 24:00.
  .refine((c) => c.sendHour + c.sendWindowHours <= 24, {
    message: 'sendHour + sendWindowHours має бути <= 24 (вікно не перетинає північ)',
    path: ['sendWindowHours'],
  });

export type AppConfig = z.infer<typeof ConfigSchema>;
export type LocationConfig = z.infer<typeof LocationSchema>;

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => `  • ${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`)
    .join('\n');
}

/** Розпарсити й провалідувати конфіг із готового об'єкта (для тестів). */
export function parseConfig(raw: unknown): AppConfig {
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Невалідний config.yml:\n${formatIssues(parsed.error)}`);
  }
  return parsed.data;
}

/** Завантажити й провалідувати config.yml із диска. */
export function loadConfig(path = 'config.yml'): AppConfig {
  // JSON_SCHEMA — лише JSON-сумісні типи: жодних кастомних тегів/конструкторів (§8).
  const raw = yaml.load(readFileSync(path, 'utf8'), { schema: yaml.JSON_SCHEMA }) ?? {};
  return parseConfig(raw);
}
