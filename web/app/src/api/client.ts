import { tg, inTelegram } from '../telegram.ts';
import { statsSchema, type Stats } from './schema.ts';
import { SAMPLE_STATS, EMPTY_STATS } from './sample.ts';
import { briefSchema, type Brief } from './briefing-schema.ts';
import { SAMPLE_BRIEF } from './briefing-sample.ts';
import { settingsResponseSchema, type SettingsResponse, type Settings } from './settings-schema.ts';

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
 * Мутація POST /api/event (роадмеп v3, E2). На відміну від GET-читань, initData
 * їде В ТІЛІ JSON (як vanilla sendEvent), не заголовком; сервер валідує owner.
 * Поза Telegram — no-op (демо не персиститься; оптимістичне оновлення кешу
 * робить хук-мутація локально).
 */
export async function postEvent(type: string, payload: Record<string, unknown>): Promise<void> {
  if (!inTelegram() || !tg) return;
  const res = await fetch('/api/event', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type, ...payload, initData: tg.initData }),
  });
  if (!res.ok) throw new Error(`Подію не збережено (${res.status})`);
}

/* ── Налаштування (F2) ─────────────────────────────────────────────────── */

/** Демо-налаштування: те, що показує екран поза Telegram (нічого не персиститься). */
const DEMO_SETTINGS: SettingsResponse = {
  settings: { quiet: { enabled: false, from: '22:00', to: '08:00' }, modules: {} },
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
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: next, initData: tg.initData }),
  });
  if (!res.ok) throw new Error(`Налаштування не збережено (${res.status})`);

  const parsed = settingsResponseSchema.safeParse(await res.json());
  if (!parsed.success) throw new Error('Формат налаштувань змінився — оновіть застосунок');
  return parsed.data;
}

/** Авторитетний напрямок голосу від сервера (C3): re-click того ж = null. */
export type VoteDir = 'up' | 'down' | null;
export interface VoteResult {
  weight: number;
  voted: VoteDir;
}

/**
 * Голос за новину (роадмеп v3, E3) — окремий ендпоінт /api/vote (не /api/event):
 * інша відповідь {ok,category,weight,voted}. `voted` авторитетний (сервер сам
 * рахує toggle). Поза Telegram — null (оптимістичне значення лишається).
 */
export async function postVote(
  category: string,
  dir: 'up' | 'down',
  url: string,
): Promise<VoteResult | null> {
  if (!inTelegram() || !tg) return null;
  const res = await fetch('/api/vote', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ category, dir, url, initData: tg.initData }),
  });
  if (!res.ok) throw new Error(`Голос не зараховано (${res.status})`);
  const data = (await res.json()) as { weight?: number; voted?: VoteDir };
  return { weight: data.weight ?? 0, voted: data.voted ?? null };
}
