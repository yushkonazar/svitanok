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

/**
 * Геопозиція власника з KV поверх config.locations (22.08.2026).
 *
 * ⚠️ ПРИВІД. Локацію можна задати ТРЬОМА способами — авто-детекція Cloudflare,
 * «Вказати локацію вручну» й пошук міста в Mini App, — і жоден із них не
 * доходив до ранкового брифінгу. Той крутиться в GitHub Actions о 08:00: ні
 * браузера, ні власника, ні `request.cf`. Єдиним його джерелом лишався
 * `config.locations`, тобто змінна `OWNER_LOCATIONS`. Виходило, що власник
 * щодня вказує локацію в застосунку, а брифінг щоранку шле інше місто — і
 * ніде не видно, чому.
 *
 * ⚠️ ПРАВИЛО ТЕ САМЕ, ЩО В MINI APP (`handleLiveWeather`), і це головне: не
 * заміна, а ЗСУВ. Локація з KV стає першою, налаштована — другою. Два екрани,
 * що показують погоду одного ранку, мусять узгоджуватись; окреме правило тут
 * означало б, що вони розходяться, і жодна зі сторін не буде «неправильною».
 *
 * ⚠️ ІМʼЯ ОБОВʼЯЗКОВЕ. Ручний вибір несе назву, підтверджену власником при
 * встановленні; авто-детекція — лише координати, і назву їй проставляє Worker
 * тоді, коли й так робить зворотне геокодування для Mini App. Немає назви —
 * оверрайд НЕ застосовується: краще лишити налаштоване місто, ніж написати в
 * брифінгу «Поточна локація» або вигадати назву тут другим шляхом.
 */
const GEO_MATCH_TOLERANCE = 0.02; // ~2 км, той самий поріг, що sameGeo у Worker'і

export interface OwnerGeo {
  lat: number;
  lon: number;
  name: string;
}

export interface OwnerGeoResult {
  config: AppConfig;
  /** Звідки взялась перша локація — для логу рану; null = нічого не змінили. */
  source: 'manual' | 'auto' | null;
  name: string | null;
}

/** Валідний {lat, lon, name} із KV-блоба, або null. Блоб пише Worker, але межу
 *  процесу він перетнув — перевіряємо структурно, а не на віру. */
function parseGeo(raw: unknown): OwnerGeo | null {
  if (!raw || typeof raw !== 'object') return null;
  const g = raw as Record<string, unknown>;
  const { lat, lon, name } = g;
  if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) return null;
  if (typeof lon !== 'number' || !Number.isFinite(lon) || lon < -180 || lon > 180) return null;
  if (typeof name !== 'string' || name.trim() === '') return null;
  return { lat, lon, name: name.trim() };
}

/** Накласти геопозицію власника на config.locations. Чиста функція. */
export function applyOwnerGeo(
  config: AppConfig,
  manualRaw: unknown,
  autoRaw: unknown,
): OwnerGeoResult {
  const manual = parseGeo(manualRaw);
  const auto = manual ? null : parseGeo(autoRaw);
  const pick = manual ?? auto;
  if (!pick) return { config, source: null, name: null };

  const configured = config.locations;
  const first = configured[0];
  // Власник ТАМ, де вже налаштовано, — оверрайд лише продублював би місто в
  // обох слотах брифінгу. Нічого не міняємо: це не «не спрацювало», а «нема
  // чого міняти».
  if (
    first &&
    Math.abs(first.lat - pick.lat) < GEO_MATCH_TOLERANCE &&
    Math.abs(first.lon - pick.lon) < GEO_MATCH_TOLERANCE
  ) {
    return { config, source: null, name: null };
  }

  // Друга локація — ПЕРША налаштована, не друга: той самий 2-слотовий вміст,
  // що в Mini App, тож обидва екрани показують одну пару.
  const locations = first ? [pick, first] : [pick];
  return {
    config: { ...config, locations } as AppConfig,
    source: manual ? 'manual' : 'auto',
    name: pick.name,
  };
}
