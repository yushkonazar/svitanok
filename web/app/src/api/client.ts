import { tg, inTelegram } from '../telegram.ts';
import { statsSchema, archiveSchema, type Stats, type ArchiveMonth } from './schema.ts';
import { SAMPLE_STATS, EMPTY_STATS, SAMPLE_SAVED_ARCHIVE, SAMPLE_ARCHIVE } from './sample.ts';
import {
  briefSchema,
  liveWeatherResponseSchema,
  settlementsSchema,
  type Brief,
  type LiveWeatherResponse,
  type Settlement,
  type SettlementTuple,
} from './briefing-schema.ts';
import { SAMPLE_BRIEF } from './briefing-sample.ts';
import { settingsResponseSchema, type SettingsResponse, type Settings } from './settings-schema.ts';
import { savedPageSchema, type SavedPage } from './schema.ts';

// API-клієнт дашборда (роадмеп v3, E1). Апка живе на /app, а API — на /api (корінь
// origin), тож шляхи абсолютні (/api/...); у dev Vite проксі /api -> wrangler :8787.
// Авторизація власника — заголовок X-Telegram-Init-Data (як у vanilla,
// index.html:1447); Worker валідує HMAC+owner (checkOwnerRead).

/** Заголовки авторизації: initData всередині Telegram, інакше порожньо (демо). */
function authHeaders(): Record<string, string> {
  return inTelegram() && tg ? { 'X-Telegram-Init-Data': tg.initData } : {};
}

/* ── Демо-стани (F2) ────────────────────────────────────────────────────────
   Перемикач у налаштуваннях, видимий ЛИШЕ поза Telegram: дає подивитись
   скелетон / порожньо / помилку на реальних екранах, не чіпаючи прод і не
   чекаючи, поки такий стан трапиться сам. У Telegram не діє взагалі —
   demoGate викликається тільки з гілки !inTelegram(). */

export type DemoState = 'ready' | 'loading' | 'empty' | 'error';

let demoState: DemoState = 'ready';
export const getDemoState = (): DemoState => demoState;
export const setDemoState = (s: DemoState): void => {
  demoState = s;
};

async function demoGate<T>(ready: () => T, empty: () => T): Promise<T> {
  switch (demoState) {
    case 'loading':
      // Проміс, який НІКОЛИ не резолвиться -> черга лишається pending -> скелетон.
      // Кинутий проміс безпечний: ні таймера, ні підписки; перемикання назад
      // інвалідує чергу й запускає новий запит.
      return new Promise<T>(() => {});
    case 'error':
      throw new Error('Демо-стан «Помилка» — перемкни в налаштуваннях');
    case 'empty':
      return empty();
    default:
      return ready();
  }
}

/** Дані статистики + прапор демо (SAMPLE замість реального контракту). */
export interface StatsResult {
  stats: Stats;
  demo: boolean;
}

/**
 * Завантажити /api/stats. Поза Telegram або при відмові авторизації (401/403) —
 * SAMPLE (demo:true), щоб UI був заповнений. Серверні/мережеві збої (5xx, offline)
 * і дрейф контракту (провал валідації) кидають помилку -> стан помилки з ретраєм.
 */
export async function fetchStats(): Promise<StatsResult> {
  if (!inTelegram())
    return demoGate(
      () => ({ stats: SAMPLE_STATS, demo: true }),
      () => ({ stats: EMPTY_STATS, demo: true }),
    );

  const res = await fetch('/api/stats', { cache: 'no-store', headers: authHeaders() });
  if (res.status === 401 || res.status === 403) {
    // Немає доступу до реальних даних (не власник / бита initData) — показуємо демо.
    return { stats: SAMPLE_STATS, demo: true };
  }
  if (!res.ok) throw new Error(`Не вдалося завантажити статистику (${res.status})`);

  const parsed = statsSchema.safeParse(await res.json());
  if (!parsed.success) {
    throw new Error('Формат статистики змінився — оновіть застосунок');
  }
  return { stats: parsed.data, demo: false };
}

/**
 * Холодний архів місячних згорток (GET /api/archive).
 *
 * ⚠️ Тут НЕМАЄ демо-фолбека, на відміну від fetchStats. Архів — це «що було за
 * роки», і показувати замість нього вигадані місяці означало б підсунути
 * фальшиву історію там, де вся цінність саме в тому, що вона справжня. Немає
 * доступу — немає блоку.
 */
export async function fetchArchive(): Promise<ArchiveMonth[]> {
  if (!inTelegram()) return SAMPLE_ARCHIVE;
  const res = await fetch('/api/archive', { cache: 'no-store', headers: authHeaders() });
  if (res.status === 401 || res.status === 403) return [];
  if (!res.ok) throw new Error(`Не вдалося завантажити історію (${res.status})`);
  const parsed = archiveSchema.safeParse(await res.json());
  if (!parsed.success) throw new Error('Формат історії змінився — оновіть застосунок');
  return parsed.data.months;
}

/** Брифінг дня + прапор демо. Та сама політика, що й fetchStats. */
export interface BriefResult {
  brief: Brief;
  demo: boolean;
}

/**
 * Завантажити briefing.json (щоденний знімок). Поза Telegram/401/403 — SAMPLE;
 * 5xx/мережа/дрейф контракту — помилка з ретраєм.
 */
export async function fetchBriefing(): Promise<BriefResult> {
  if (!inTelegram())
    return demoGate(
      () => ({ brief: SAMPLE_BRIEF, demo: true }),
      // Порожній брифінг — рівно те, що сервер віддає до першого крону ('{}').
      () => ({ brief: briefSchema.parse({}), demo: true }),
    );

  const res = await fetch('/briefing.json', { cache: 'no-store', headers: authHeaders() });
  if (res.status === 401 || res.status === 403) return { brief: SAMPLE_BRIEF, demo: true };
  if (!res.ok) throw new Error(`Не вдалося завантажити брифінг (${res.status})`);

  const parsed = briefSchema.safeParse(await res.json());
  if (!parsed.success) throw new Error('Формат брифінгу змінився — оновіть застосунок');
  return { brief: parsed.data, demo: false };
}

/**
 * GET /api/weather — жива погода (PR-7, фідбек власника: статична температура
 * з ранкового брифінгу вже за обідом не відповідала дійсності).
 *
 * Навмисно М'ЯКШИЙ контракт, ніж fetchStats/fetchBriefing: ЖОДНА помилка тут
 * не кидає — WeatherBlock і так має робочий фолбек (снапшот брифінгу), тож
 * live-шар лишається чистим покращенням, не критичним шляхом. null означає
 * «покажи снапшот» — не «сталась помилка».
 */
export async function fetchLiveWeather(): Promise<LiveWeatherResponse | null> {
  if (!inTelegram()) return null;
  try {
    const res = await fetch('/api/weather', { cache: 'no-store', headers: authHeaders() });
    if (!res.ok) return null;
    const parsed = liveWeatherResponseSchema.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * POST /api/weather/location {city} -> ручне перевизначення локації
 * (фідбек власника: IP-геолокація не встигає за реальним рухом). Поза Telegram
 * — null (як postSettings/postEvent: демо не персиститься, і живої погоди в
 * демо однаково немає — редагувати нічого). УСЕРЕДИНІ Telegram цей шлях
 * КИДАЄ на помилку — форма вводу міста мусить показати «місто не знайдено»,
 * а не мовчки проковтнути її.
 */
export async function setWeatherLocation(city: string): Promise<{ name: string } | null> {
  if (!inTelegram() || !tg) return null;
  const res = await fetch('/api/weather/location', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ city }),
  });
  if (res.status === 404) throw new Error('Місто не знайдено');
  if (!res.ok) throw new Error(`Не вдалося встановити локацію (${res.status})`);
  const data = (await res.json()) as { manualGeo: { name: string } };
  return data.manualGeo;
}

/**
 * Той самий POST /api/weather/location, але з ГОТОВИМИ координатами
 * (обраний варіант з автозаповнення) — обходить повторне геокодування на
 * Worker-боці, яке за назвою могло б повернути ІНШЕ місто при однойменних
 * населених пунктах у різних областях/країнах.
 */
export async function setWeatherLocationExact(
  pick: Pick<Settlement, 'lat' | 'lon' | 'name'>,
): Promise<{ name: string } | null> {
  if (!inTelegram() || !tg) return null;
  const res = await fetch('/api/weather/location', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify(pick),
  });
  if (!res.ok) throw new Error(`Не вдалося встановити локацію (${res.status})`);
  const data = (await res.json()) as { manualGeo: { name: string } };
  return data.manualGeo;
}

function tupleToSettlement([name, lat, lon, country, region]: SettlementTuple): Settlement {
  return { name, lat, lon, country, region };
}

/**
 * /settlements.json — статичний ассет (НЕ /api/*, без auth — публічні
 * геодані, той самий рівень доступу, що JS/CSS-бандл додатку), для
 * автозаповнення локації (фідбек власника: пошук ЦІЛКОМ на клієнті, без
 * мережевого запиту на кожен keystroke). Один фетч на сесію (TanStack кешує
 * необмежено, gcTime у useSettlements) — 35к+ записів, ~570КБ gzip, тож
 * лінивий і лише коли власник реально відкрив редактор локації.
 *
 * import.meta.env.BASE_URL — той самий шлях, що Vite `base` (/app/), єдиний
 * і для dev-сервера, і для прод-білда (файл лежить у web/app/public/).
 */
export async function fetchSettlements(): Promise<Settlement[]> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}settlements.json`, {
      cache: 'force-cache',
    });
    if (!res.ok) return [];
    const parsed = settlementsSchema.safeParse(await res.json());
    return parsed.success ? parsed.data.map(tupleToSettlement) : [];
  } catch {
    return [];
  }
}

/** DELETE /api/weather/location -> прибрати ручне перевизначення, повернутись
 *  до авто-детекції по IP. */
export async function clearWeatherLocation(): Promise<void> {
  if (!inTelegram() || !tg) return;
  const res = await fetch('/api/weather/location', {
    method: 'DELETE',
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`Не вдалося прибрати локацію (${res.status})`);
}

/**
 * POST /api/weather/locate-prompt -> просить бота проактивно надіслати
 * /locate-промпт (кнопка request_location) У ЧАТ. Mini App сама не вміє
 * показати цю кнопку (WebView, request_location — виключно KeyboardButton
 * у чаті, Bot API), тож лише скорочує шлях до неї.
 */
export async function requestLocatePrompt(): Promise<void> {
  if (!inTelegram() || !tg) return;
  const res = await fetch('/api/weather/locate-prompt', {
    method: 'POST',
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`Не вдалося надіслати запит (${res.status})`);
}

/**
 * Мутація POST /api/event (роадмеп v3, E2). initData їде заголовком — тим самим,
 * що й у GET-читаннях (M3); сервер валідує owner.
 * Поза Telegram — no-op (демо не персиститься; оптимістичне оновлення кешу
 * робить хук-мутація локально).
 */
export async function postEvent(type: string, payload: Record<string, unknown>): Promise<void> {
  if (!inTelegram() || !tg) return;
  const res = await fetch('/api/event', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ type, ...payload }),
  });
  if (!res.ok) throw new Error(`Подію не збережено (${res.status})`);
}

/* ── Налаштування (F2) ─────────────────────────────────────────────────── */

/** Демо-налаштування: те, що показує екран поза Telegram (нічого не персиститься). */
const DEMO_SETTINGS: SettingsResponse = {
  settings: { quiet: { enabled: false, from: '22:00', to: '08:00' }, modules: {}, mutedTopics: [] },
  connectors: { google: true, calendar: true, gmail: true },
};

/**
 * GET /api/settings. Політика та сама, що у fetchStats: поза Telegram / 401 /
 * 403 -> демо; 5xx і дрейф контракту -> помилка з ретраєм.
 *
 * СВІДОМО повз demoGate: перемикач демо-стану живе на екрані налаштувань, тож
 * якби цей запит теж підкорявся demoState, вибір «Помилка» завалив би сам екран
 * — разом із перемикачем, яким тільки й можна вимкнути демо-стан назад.
 * Демо-стани демонструють ЕКРАНИ ДАНИХ, а не пульт керування собою.
 */
export async function fetchSettings(): Promise<SettingsResponse> {
  if (!inTelegram()) return DEMO_SETTINGS;

  const res = await fetch('/api/settings', { cache: 'no-store', headers: authHeaders() });
  if (res.status === 401 || res.status === 403) return DEMO_SETTINGS;
  if (!res.ok) throw new Error(`Не вдалося завантажити налаштування (${res.status})`);

  const parsed = settingsResponseSchema.safeParse(await res.json());
  if (!parsed.success) throw new Error('Формат налаштувань змінився — оновіть застосунок');
  return parsed.data;
}

/**
 * POST /api/settings — ПОВНИЙ стан (PUT-семантика), не патч: KV не має ні CAS,
 * ні read-your-writes, тож серверний read-modify-write губив би тумблери при
 * швидких тапах. Писар один (власник), і повний стан у нього вже є в кеші.
 * Поза Telegram — null (оптимістичне значення в кеші лишається).
 */
export async function postSettings(next: Settings): Promise<SettingsResponse | null> {
  if (!inTelegram() || !tg) return null;
  const res = await fetch('/api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ settings: next }),
  });
  if (!res.ok) throw new Error(`Налаштування не збережено (${res.status})`);

  const parsed = settingsResponseSchema.safeParse(await res.json());
  if (!parsed.success) throw new Error('Формат налаштувань змінився — оновіть застосунок');
  return parsed.data;
}

/* ── Архів збереженого (F3) ────────────────────────────────────────────── */

/** Скільки записів тягнемо за раз. Сервер клампить limit до 50 (SAVED_PAGE_MAX
    у stats-core), тож просити більше — марно: віддасть однаково 50. */
export const SAVED_PAGE = 50;

/**
 * GET /api/saved — повний архів сторінками. Окремо від /api/stats, бо там
 * savedList свідомо обрізаний до 8 як прев'ю: тягти сотні записів у кожне
 * відкриття апки заради рядка «Ти зберіг N» — марно.
 * Поза Telegram — демо-архів із SAMPLE (щоб «показати ще» було що показати).
 *
 * ⚠️ offset ОБОВʼЯЗКОВИЙ. Доти тут було зашито `offset=0`, а виклик просив
 * дедалі більший limit (20→40→60…) — і на 51-му записі архів мовчки впирався
 * в стелю: сервер клампить limit до 50, тож «Показати ще (N)» рахував N чесно,
 * але не додавав НІЧОГО. Гортаємо offset'ом, а не ростом limit.
 */
export async function fetchSaved(offset: number, limit: number = SAVED_PAGE): Promise<SavedPage> {
  if (!inTelegram()) {
    return {
      items: SAMPLE_SAVED_ARCHIVE.slice(offset, offset + limit),
      total: SAMPLE_SAVED_ARCHIVE.length,
    };
  }
  const res = await fetch(`/api/saved?offset=${offset}&limit=${limit}`, {
    cache: 'no-store',
    headers: authHeaders(),
  });
  if (res.status === 401 || res.status === 403) {
    return {
      items: SAMPLE_SAVED_ARCHIVE.slice(offset, offset + limit),
      total: SAMPLE_SAVED_ARCHIVE.length,
    };
  }
  if (!res.ok) throw new Error(`Не вдалося завантажити збережене (${res.status})`);

  const parsed = savedPageSchema.safeParse(await res.json());
  if (!parsed.success) throw new Error('Формат збереженого змінився — оновіть застосунок');
  return parsed.data;
}

/**
 * Авторитетний напрямок голосу від сервера (C3): re-click того ж = null.
 *
 * ⚠️ 'down' лишається в типі свідомо, хоч ❤️ його вже не створює: у KV живуть
 * старі дизлайки, і сервер віддає їх у stats.votes як є. Звузиш тип до
 * 'up'|null — і TypeScript почне брехати про дані, які реально приходять.
 */
export type VoteDir = 'up' | 'down' | null;
export interface VoteResult {
  weight: number;
  voted: VoteDir;
}

/**
 * ❤️ на новині (роадмеп v3, E3) — окремий ендпоінт /api/vote (не /api/event):
 * інша відповідь {ok,category,weight,voted}. `voted` авторитетний (сервер сам
 * рахує toggle). Поза Telegram — null (оптимістичне значення лишається).
 *
 * dir не параметр: напрямок завжди 'up' (фідбек власника, п.5 — дизлайків
 * більше немає). Лишаємо його в ТІЛІ запиту, бо контракт /api/vote спільний
 * із легасі-клієнтами й тестами.
 */
export async function postVote(category: string, url: string): Promise<VoteResult | null> {
  if (!inTelegram() || !tg) return null;
  const res = await fetch('/api/vote', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ category, dir: 'up', url }),
  });
  if (!res.ok) throw new Error(`Голос не зараховано (${res.status})`);
  const data = (await res.json()) as { weight?: number; voted?: VoteDir };
  return { weight: data.weight ?? 0, voted: data.voted ?? null };
}
