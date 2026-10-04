import { demoObservations, shiftCheckinDate } from '../../../core/checkin/observations.mjs';
import { tg, inTelegram } from '../telegram.ts';
import { statsSchema, archiveSchema, deletionsSchema, leversSchema } from './schema.ts';
import { readCheckinDemo, writeCheckinDemo } from './checkin-demo.ts';
import type { Stats, ArchiveMonth, DeletionReceipts, LeversResult } from './schema.ts';
import { SAMPLE_STATS, EMPTY_STATS, SAMPLE_ARCHIVE } from './sample.ts';
import { SAMPLE_LEVERS, EMPTY_LEVERS } from './sample.ts';
import {
  briefSchema,
  liveWeatherResponseSchema,
  settlementsSchema,
  newsSnapshotSchema,
  type Brief,
  type LiveWeatherResponse,
  type Settlement,
  type SettlementTuple,
} from './briefing-schema.ts';
import { SAMPLE_BRIEF } from './briefing-sample.ts';
import { settingsResponseSchema, type SettingsResponse, type Settings } from './settings-schema.ts';
import { savedPageSchema, type SavedPage } from './schema.ts';
import { workerQualityResponseSchema, type WorkerQuality } from './worker-quality-schema.ts';
import { financeSchema, type FinanceCommand } from './finance-schema.ts';
import { readFinanceDemo, writeFinanceDemo } from './finance-demo.ts';
import { readSavedDemo, writeSavedDemo } from './saved-demo.ts';
import { kyivParts } from '../../../core/finance/planning.mjs';

// API-клієнт дашборда (роадмеп v3, E1). Апка живе на /app, а API — на /api (корінь
// origin), тож шляхи абсолютні (/api/...); у dev Vite проксі /api -> wrangler :8787.
// Авторизація власника — заголовок X-Telegram-Init-Data (як у vanilla,
// index.html:1447); Worker валідує HMAC+owner (checkOwnerRead).

/** Заголовки авторизації: initData всередині Telegram, інакше порожньо (демо). */
function authHeaders(): Record<string, string> {
  return inTelegram() && tg ? { 'X-Telegram-Init-Data': tg.initData } : {};
}
export async function fetchNewsSnapshot() {
  if (!inTelegram()) return null;
  const res = await fetch('/api/news', { headers: authHeaders() });
  throwIfSessionExpired(res);
  if (!res.ok) throw new Error('Не вдалося оновити стрічку. Показано останній брифінг.');
  return newsSnapshotSchema.parse(await res.json());
}

export async function fetchFinance() {
  if (!inTelegram()) return { finance: readFinanceDemo(), demo: true };
  const res = await fetch('/api/finance', { headers: authHeaders() });
  throwIfSessionExpired(res);
  if (!res.ok) throw new Error('Не вдалося завантажити фінанси. Спробуй знову.');
  return { finance: financeSchema.parse(await res.json()), demo: false };
}
export async function postFinance(command: FinanceCommand) {
  if (!inTelegram()) {
    writeFinanceDemo(command);
    return;
  }
  const res = await fetch('/api/finance', {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  throwIfSessionExpired(res);
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    throw new Error(
      body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
        ? body.error
        : 'Не вдалося зберегти операцію',
    );
  }
}

/**
 * Сервер уже перевірив Telegram initData і відмовив. Це не «дані порожні» і
 * не звичайна мережева помилка: застосунок мусить заблокувати персональний UI,
 * а власник — відкрити Mini App заново з чату, щоб отримати новий initData.
 */
export class SessionExpiredError extends Error {
  readonly status: 401 | 403;

  constructor(status: 401 | 403) {
    super('Сесію Telegram завершено. Відкрий застосунок заново з чату.');
    this.name = 'SessionExpiredError';
    this.status = status;
  }
}

export const isSessionExpired = (error: unknown): error is SessionExpiredError =>
  error instanceof SessionExpiredError ||
  (typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'SessionExpiredError');

function throwIfSessionExpired(res: Response): void {
  if (res.status === 401 || res.status === 403) throw new SessionExpiredError(res.status);
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
 * Завантажити /api/stats. Поза Telegram — явне demo; 401/403 у Telegram —
 * SessionExpiredError, ніколи не підставні персональні дані.
 */
export async function fetchStats(): Promise<StatsResult> {
  if (!inTelegram())
    return demoGate(
      () => ({ stats: demoStats(), demo: true }),
      () => ({ stats: EMPTY_STATS, demo: true }),
    );

  const res = await fetch('/api/stats', { cache: 'no-store', headers: authHeaders() });
  throwIfSessionExpired(res);
  if (!res.ok) throw new Error(`Не вдалося завантажити статистику (${res.status})`);

  const parsed = statsSchema.safeParse(await res.json());
  if (!parsed.success) {
    throw new Error('Формат статистики змінився — оновіть застосунок');
  }
  return { stats: parsed.data, demo: false };
}

function demoStats(): Stats {
  const today = kyivParts(Date.now()).date,
    checkinToday = { ...SAMPLE_STATS.checkinToday, ...readCheckinDemo() };
  const energyCurve = [
    checkinToday.morning?.energy ?? null,
    checkinToday.afternoon?.energy ?? null,
    checkinToday.evening?.energy ?? null,
  ];
  const moodCurve = [
    checkinToday.morning?.mood ?? null,
    checkinToday.afternoon?.mood ?? null,
    checkinToday.evening?.mood ?? null,
  ];
  const values = energyCurve.filter((v): v is number => v != null),
    saved = readSavedDemo();
  const records = { ...demoObservations(today), [today]: checkinToday };
  return {
    ...SAMPLE_STATS,
    checkinToday,
    savedList: saved.slice(0, 8),
    savedCount: saved.length,
    checkinRaw: { days: 180, from: shiftCheckinDate(today, -179), to: today, records },
    checkinSeries: [
      ...SAMPLE_STATS.checkinSeries.filter((p) => p.d !== today),
      {
        d: today,
        energy: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
        moodCurve,
        energyCurve,
        sleepH:
          checkinToday.morning?.sleepH ?? (checkinToday.morning?.sleepKind === 'none' ? 0 : null),
        dayScore: checkinToday.evening?.dayScore ?? null,
        slots: Object.values(checkinToday).filter((slot) => slot && Object.keys(slot).length > 0)
          .length,
      },
    ],
  };
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
  throwIfSessionExpired(res);
  if (!res.ok) throw new Error(`Не вдалося завантажити історію (${res.status})`);
  const parsed = archiveSchema.safeParse(await res.json());
  if (!parsed.success) throw new Error('Формат історії змінився — оновіть застосунок');
  return parsed.data.months;
}

/**
 * Історія T2 «забудь усе» (GET /api/deletions). Поза Telegram навмисно
 * порожня: вигадана квитанція виглядала б як доказ реального стирання.
 */
export async function fetchDeletionReceipts(): Promise<DeletionReceipts> {
  if (!inTelegram()) return { receipts: [], retentionDays: 90 };
  const res = await fetch('/api/deletions', { cache: 'no-store', headers: authHeaders() });
  throwIfSessionExpired(res);
  if (!res.ok) throw new Error(`Не вдалося завантажити квитанції видалення (${res.status})`);
  const parsed = deletionsSchema.safeParse(await res.json());
  if (!parsed.success) throw new Error('Формат квитанцій видалення змінився — оновіть застосунок');
  return parsed.data;
}

/** Приватний технічний огляд якості працівників за 30 днів. */
export async function fetchWorkerQuality(): Promise<WorkerQuality[]> {
  if (!inTelegram()) return [];
  const res = await fetch('/api/assistant-status', { cache: 'no-store', headers: authHeaders() });
  throwIfSessionExpired(res);
  if (!res.ok) throw new Error(`Не вдалося завантажити огляд працівників (${res.status})`);
  const parsed = workerQualityResponseSchema.safeParse(await res.json());
  if (!parsed.success) throw new Error('Огляд працівників тимчасово недоступний');
  return parsed.data.dashboard.worker_quality;
}

/**
 * Шар звʼязків «Важелі» (GET /api/levers).
 *
 * ⚠️ 401/403 -> SessionExpiredError, а не порожній список рядків. Порожній
 * список означав би «перевірили й звʼязків немає» — твердження, якого ми не
 * робили. Немає доступу — застосунок чесно зупиняє персональний UI.
 *
 * ⚠️ Поза Telegram демо показує ОБИДВА стани через demoGate, і «замало даних»
 * тут не менш важливий за заповнений: саме його видно на екрані місяцями.
 */
export async function fetchLevers(): Promise<LeversResult> {
  if (!inTelegram())
    return demoGate(
      () => SAMPLE_LEVERS,
      () => EMPTY_LEVERS,
    );
  const res = await fetch('/api/levers', { cache: 'no-store', headers: authHeaders() });
  throwIfSessionExpired(res);
  if (!res.ok) throw new Error(`Не вдалося завантажити важелі (${res.status})`);
  const parsed = leversSchema.safeParse(await res.json());
  if (!parsed.success) throw new Error('Формат важелів змінився — оновіть застосунок');
  return parsed.data;
}

/** Брифінг дня + прапор демо. Та сама політика, що й fetchStats. */
export interface BriefResult {
  brief: Brief;
  demo: boolean;
}

/**
 * Завантажити briefing.json. Поза Telegram — SAMPLE; 401/403 у Telegram
 * переходить у blocking SessionExpired state, а не в псевдо-брифінг.
 */
export async function fetchBriefing(): Promise<BriefResult> {
  if (!inTelegram())
    return demoGate(
      () => ({ brief: SAMPLE_BRIEF, demo: true }),
      // Порожній брифінг — рівно те, що сервер віддає до першого крону ('{}').
      () => ({ brief: briefSchema.parse({}), demo: true }),
    );

  const res = await fetch('/briefing.json', { cache: 'no-store', headers: authHeaders() });
  throwIfSessionExpired(res);
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
 * Поза Telegram чек-ін підтверджується лише в локальному демо; інші події
 * оновлюють React-кеш, мережевих записів немає.
 */
export async function postEvent(type: string, payload: Record<string, unknown>): Promise<void> {
  if (!inTelegram() || !tg) {
    if (type === 'checkin') writeCheckinDemo(payload);
    if (['save_item', 'unsave_item', 'save_news', 'unsave_news'].includes(type))
      writeSavedDemo(type, payload);
    return;
  }
  const res = await fetch('/api/event', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ type, ...payload }),
  });
  throwIfSessionExpired(res);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(
      typeof body?.error === 'string' ? body.error : `Подію не збережено (${res.status})`,
    );
  }
  if (type === 'checkin') {
    const result = await res.json();
    if (result.locked) throw new Error('Цей чек-ін уже підтверджений. Онови екран.');
    if (result.expired) throw new Error('Вікно чек-іну вже закрилось. Онови екран.');
    if (result.incomplete) throw new Error('Для підтвердження дай відповіді на основні питання.');
  }
}

/* ── Налаштування (F2) ─────────────────────────────────────────────────── */

/** Демо-налаштування: те, що показує екран поза Telegram (нічого не персиститься). */
const DEMO_SETTINGS: SettingsResponse = {
  settings: { quiet: { enabled: false, from: '22:00', to: '08:00' }, modules: {}, mutedTopics: [] },
  connectors: { google: true, calendar: true, gmail: true },
};

/**
 * GET /api/settings. Поза Telegram — demo; 401/403 у Telegram зупиняє весь
 * персональний UI через SessionExpiredError, не маскується DEMO_SETTINGS.
 *
 * СВІДОМО повз demoGate: перемикач демо-стану живе на екрані налаштувань, тож
 * якби цей запит теж підкорявся demoState, вибір «Помилка» завалив би сам екран
 * — разом із перемикачем, яким тільки й можна вимкнути демо-стан назад.
 * Демо-стани демонструють ЕКРАНИ ДАНИХ, а не пульт керування собою.
 */
export async function fetchSettings(): Promise<SettingsResponse> {
  if (!inTelegram()) {
    try {
      const saved = settingsResponseSchema.safeParse(
        JSON.parse(localStorage.getItem('svitanok:demo-settings:v1') ?? 'null'),
      );
      return saved.success ? saved.data : DEMO_SETTINGS;
    } catch {
      return DEMO_SETTINGS;
    }
  }

  const res = await fetch('/api/settings', { cache: 'no-store', headers: authHeaders() });
  throwIfSessionExpired(res);
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
  if (!inTelegram() || !tg) {
    try {
      localStorage.setItem(
        'svitanok:demo-settings:v1',
        JSON.stringify({ ...DEMO_SETTINGS, settings: next }),
      );
    } catch {
      /* Current cache still works. */
    }
    return null;
  }
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
    const saved = readSavedDemo();
    return {
      items: saved.slice(offset, offset + limit),
      total: saved.length,
    };
  }
  const res = await fetch(`/api/saved?offset=${offset}&limit=${limit}`, {
    cache: 'no-store',
    headers: authHeaders(),
  });
  throwIfSessionExpired(res);
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
