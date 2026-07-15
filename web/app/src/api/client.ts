import { tg, inTelegram } from '../telegram.ts';
import { statsSchema, type Stats } from './schema.ts';
import { SAMPLE_STATS } from './sample.ts';

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
