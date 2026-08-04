// Завантаження + zod-валідація config.yml (§7). Невалідний конфіг падає ГУЧНО
// на старті (на відміну від рантайм-помилок модулів, що деградують тихо).
// `load` безпечний за замовчуванням — без кастомних конструкторів (§8).
//
// js-yaml v5 прибрав default-експорт: лише іменовані. Пакет тепер везе власні
// типи, тож @types/js-yaml видалено — застарілий @types описував v4 і мовчки
// перекривав справжні типи, через що `tsc` пропускав `import yaml from` як
// валідний, а Node падав уже в рантаймі («does not provide an export named
// default»). Зловили тести config.test.ts, не typecheck.

import { readFileSync } from 'node:fs';
import { load, JSON_SCHEMA } from 'js-yaml';
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
        perTopic: z.number().int().positive().default(3),
        dedupDays: z.number().int().nonnegative(),
        retentionDays: z.number().int().nonnegative(),
        // NewsData.io: теми = scope (world/ua) × category (+опц. country/language).
        //
        // `q` — пошук за ключовими словами замість/на додачу до category. Потрібен
        // темам, яких у переліку категорій NewsData ПРОСТО НЕМА (оборона/фронт).
        // Тому category став опційним, але рефайн вимагає хоч щось із двох:
        // тема без обох звелася б до «віддай усе підряд».
        // `source: rss` — тема з довільної стрічки (Hacker News, GitHub Releases).
        // Такі теми НЕ витрачають кредитів NewsData, тож живуть за іншими
        // правилами: їм потрібен `url`, а не category/q.
        topics: z
          .array(
            z
              .object({
                scope: z.enum(['world', 'ua']),
                topic: z.string(),
                source: z.enum(['newsdata', 'rss']).default('newsdata'),
                url: z.string().optional(),
                category: z.string().optional(),
                q: z.string().optional(),
                country: z.string().optional(),
                language: z.string().default('uk'),
                // Кастомні заголовки фетчу (лише rss) — напр. User-Agent для
                // джерел за bot-захистом (HLTV: 403 з мінімальним UA, 200 з
                // повним браузерним).
                headers: z.record(z.string(), z.string()).optional(),
                // Фільтр шуму монорепо-стрічок релізів (Vite/Cloudflare Workers
                // SDK мішають core-теги з саб-пакетами) чи beta/rc-тегів.
                includePattern: z.string().optional(),
                excludePattern: z.string().optional(),
                // Прозова англомовна новина (BBC/Guardian/NewsData-категорії) ->
                // перекласти title+why на uk (Google Cloud Translation, §GOOGLE_
                // TRANSLATE_API_KEY). НЕ ставити на терсі/proper-noun стрічки
                // (HN-заголовки, GitHub-релізи, кіберспорт-команди/турніри) —
                // переклад там або нема що перекладати, або сплутає власні назви.
                translate: z.boolean().optional(),
              })
              .refine((t) => (t.source === 'rss' ? Boolean(t.url) : Boolean(t.category || t.q)), {
                message: 'rss-тема мусить мати url; newsdata-тема — category або q',
              }),
          )
          .default([]),
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
      mail: z.object({
        enabled: z.boolean(),
        dedupDays: z.number().int().nonnegative().default(3), // коротший за jobs(7) — листи не «переоцінюємо»
        maxCandidates: z.number().int().positive().default(15),
        query: z.string().default('in:inbox newer_than:3d -category:promotions -category:social'),
      }),
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
  const raw = load(readFileSync(path, 'utf8'), { schema: JSON_SCHEMA }) ?? {};
  return parseConfig(raw);
}
