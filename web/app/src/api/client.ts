import { tg, inTelegram } from '../telegram.ts';
import { statsSchema, type Stats } from './schema.ts';
import { SAMPLE_STATS } from './sample.ts';
import { briefSchema, type Brief } from './briefing-schema.ts';
import { SAMPLE_BRIEF } from './briefing-sample.ts';

// API-клієнт дашборда (роадмеп v3, E1). Апка живе на /app, а API — на /api (корінь
// origin), тож шляхи абсолютні (/api/...); у dev Vite проксі /api -> wrangler :8787.
// Авторизація власника — заголовок X-Telegram-Init-Data (як у vanilla,
// index.html:1447); Worker валідує HMAC+owner (checkOwnerRead).

/** Заголовки авторизації: initData всередині Telegram, інакше порожньо (демо). */
function authHeaders(): Record<string, string> {
  return inTelegram() && tg ? { 'X-Telegram-Init-Data': tg.initData } : {};
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
  if (!inTelegram()) return { stats: SAMPLE_STATS, demo: true };

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
  if (!inTelegram()) return { brief: SAMPLE_BRIEF, demo: true };

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
