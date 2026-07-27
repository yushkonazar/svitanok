// Тумблери модулів брифінгу з Mini App (роадмеп v3, F2).
//
// Власник перемикає модуль у Mini App -> Worker пише блоб KV `settings`
// (web/settings-core.mjs) -> оркестратор читає ТОЙ САМИЙ ключ і накладає
// оверрайд поверх config.yml ПЕРЕД фільтром `m.enabled(config)`. Без цього
// тумблер був би намальованою кнопкою: config.yml — файл репозиторію, і
// GitHub Actions-ран нічого про натискання в Mini App не знає.
//
// Оверрайд діє в ОБИДВА боки, але лише для id, які реально є в config.modules
// і мають boolean `enabled`. Дозволений перелік id перевіряє сторона запису
// (TOGGLEABLE_MODULE_IDS у settings-core.mjs) — тут навмисно не дублюємо його,
// щоб два списки не розʼїхались; тутешня перевірка структурна.
//
// Відсутність id у settings.modules = дефолт config.yml. Mini App показує таку
// відсутність як «увімкнено», що чесно лише поки перемикні модулі в config.yml
// стоять enabled:true — інваріант закріплено тестом у tests/config.test.ts.

import type { AppConfig } from './config.js';

export interface ModuleOverrideResult {
  config: AppConfig;
  /** Що саме перевизначили (для логу рану) — лише реальні зміни. */
  changes: Array<{ id: string; enabled: boolean }>;
}

/** Накласти settings.modules на config.modules.*.enabled. Чиста функція. */
export function applyModuleOverrides(config: AppConfig, settings: unknown): ModuleOverrideResult {
  const raw = (settings as { modules?: unknown } | null | undefined)?.modules;
  if (!raw || typeof raw !== 'object') return { config, changes: [] };

  const modules = { ...config.modules } as unknown as Record<string, { enabled?: unknown }>;
  const changes: Array<{ id: string; enabled: boolean }> = [];

  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'boolean') continue;
    const cur = modules[id];
    // Невідомий модуль або нетипова форма -> ігноруємо (config лишається як є).
    if (!cur || typeof cur !== 'object' || typeof cur.enabled !== 'boolean') continue;
    if (cur.enabled === value) continue; // збіг із дефолтом — не зміна
    modules[id] = { ...cur, enabled: value };
    changes.push({ id, enabled: value });
  }

  if (changes.length === 0) return { config, changes: [] };
  return { config: { ...config, modules } as unknown as AppConfig, changes };
}

/** Рядок для логу: «news вимкнено, jobs вимкнено (Mini App)». */
export function formatOverrides(changes: Array<{ id: string; enabled: boolean }>): string {
  return changes.map((c) => `${c.id} ${c.enabled ? 'увімкнено' : 'вимкнено'}`).join(', ');
}

export interface TopicMuteResult {
  config: AppConfig;
  /** Які теми відкинули (для логу рану). */
  muted: string[];
}

/**
 * Прибрати приглушені теми новин (settings.mutedTopics) з config ПЕРЕД прогоном.
 *
 * Ріжемо саме тут, а не на клієнті: кожна тема — це окремий запит до NewsData
 * (кредит із денного ліміту). Клієнтський фільтр сховав би картки, але кредит
 * усе одно був би витрачений, а стрічка щодня наповнювалась би тим, що власник
 * просив не показувати.
 *
 * Порівняння за ТОЧНОЮ display-назвою теми — тим самим ключем, яким ідуть ваги,
 * інтереси й голоси.
 *
 * `source: 'rss'`-рядки — ВИНЯТОК (фідбек власника, редизайн новин): rss не
 * коштує кредиту NewsData, тож немає причини різати ЙОГО, а нова Mini App
 * дозволяє «підглянути» приглушену тему (тап на сірий чіп) без зняття
 * приглушення — назавжди, не один день. Без винятку rss-тема зникла б із
 * briefing.json наступного ж прогону, і сірий чіп показував би порожньо
 * назавжди. newsdata-рядки лишаються під різом як і раніше — кредит
 * економиться, приглушена newsdata-тема просто застаріє за день (фронтенд
 * деградує graceful, sheet покаже порожньо).
 */
export function applyTopicMutes(config: AppConfig, settings: unknown): TopicMuteResult {
  const raw = (settings as { mutedTopics?: unknown } | null | undefined)?.mutedTopics;
  if (!Array.isArray(raw) || raw.length === 0) return { config, muted: [] };

  const mute = new Set(raw.filter((t): t is string => typeof t === 'string' && Boolean(t.trim())));
  if (mute.size === 0) return { config, muted: [] };

  const news = config.modules?.news;
  if (!news || !Array.isArray(news.topics)) return { config, muted: [] };

  // muted — за приналежністю до mute-сету, НЕ за тим, чи рядок фактично
  // вирізаний: приглушена rss-тема лишається в масиві (нижче), але для логу
  // рану вона й досі "приглушена". Рахуємо ДО early-return, інакше "усе
  // приглушене виявилось rss" (kept.length===topics.length) хибно повернуло б
  // muted:[] — рядок не вирізаний, але власник таки приглушив тему.
  const muted = news.topics.filter((t) => mute.has(t.topic)).map((t) => t.topic);
  if (muted.length === 0) return { config, muted: [] };

  const kept = news.topics.filter((t) => !mute.has(t.topic) || t.source === 'rss');
  if (kept.length === news.topics.length) return { config, muted };

  return {
    config: {
      ...config,
      modules: { ...config.modules, news: { ...news, topics: kept } },
    } as AppConfig,
    muted,
  };
}
