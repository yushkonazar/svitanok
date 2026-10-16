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
import { financeSchema, financeReportSchema, type FinanceCommand } from './finance-schema.ts';
import { readFinanceDemo, writeFinanceDemo } from './finance-demo.ts';
import { FinanceCommandRejectedError, FinanceSaveUncertainError } from './finance-errors.ts';
import { readSavedDemo, writeSavedDemo } from './saved-demo.ts';
import { buildFinanceReport } from '../../../core/finance/reporting.mjs';
import {
  analyticsSelection,
  buildExpenseAnalytics,
  matchesAnalytics,
  matchesAnalyticsIssue,
  analyticsAccumulator,
} from '../../../core/finance/analytics.mjs';
import {
  financeAnalyticsSchema,
  analyticsOperationsSchema,
  type AnalyticsRequest,
} from './finance-analytics-schema.ts';
import { kyivParts } from '../../../core/finance/planning.mjs';
import {
  credentialsSchema,
  type Credentials,
  type CredentialMetadata,
} from './credentials-schema.ts';

// API-клієнт дашборда (роадмеп v3, E1). Апка живе на /app, а API — на /api (корінь
// origin), тож шляхи абсолютні (/api/...); у dev Vite проксі /api -> wrangler :8787.
// Авторизація власника — заголовок X-Telegram-Init-Data (як у vanilla,
// index.html:1447); Worker валідує HMAC+owner (checkOwnerRead).

/** Заголовки авторизації: initData всередині Telegram, інакше порожньо (демо). */
function authHeaders(): Record<string, string> {
  return inTelegram() && tg ? { 'X-Telegram-Init-Data': tg.initData } : {};
}

export async function fetchMemory(
  offset = 0,
  group = 'all',
  search = '',
): Promise<import('./memory-schema.ts').MemoryWorkspace> {
  if (!inTelegram()) throw new Error('Пам’ять доступна в особистому чаті з ботом.');
  const response = await fetch(
    `/api/memory?offset=${offset}${group === 'all' && !search ? '' : `&group=${encodeURIComponent(group)}&search=${encodeURIComponent(search)}`}`,
    {
      cache: 'no-store',
      headers: authHeaders(),
    },
  ).catch(() => {
    throw new Error('Не вдалося завантажити пам’ять. Спробуй ще раз.');
  });
  throwIfSessionExpired(response);
  if (!response.ok) throw new Error('Не вдалося завантажити пам’ять. Доступ має основний власник.');
  const { memoryWorkspaceSchema } = await import('./memory-schema.ts');
  const parsed = memoryWorkspaceSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new Error('Формат пам’яті змінився. Онови застосунок.');
  return parsed.data;
}
export async function changeMemory(
  command: import('./memory-schema.ts').MemoryCommand,
): Promise<import('./memory-schema.ts').MemoryMutationReceipt> {
  const { MemoryChangeError, memoryWorkspaceSchema } = await import('./memory-schema.ts');
  if (!inTelegram())
    throw new MemoryChangeError('Цю зміну можна зробити лише в особистому чаті з ботом.');
  const response = await fetch('/api/memory', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify(command),
  }).catch(() => {
    throw new MemoryChangeError(
      'Не отримав підтвердження зміни. Онови пам’ять перед повтором.',
      true,
    );
  });
  throwIfSessionExpired(response);
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new MemoryChangeError(
      typeof body?.error === 'string' ? body.error : 'Не вдалося змінити пам’ять.',
      response.status === 409 || response.status >= 500,
    );
  if (body?.acknowledged !== true)
    throw new MemoryChangeError(
      'Не отримав підтвердження зміни. Онови пам’ять перед повтором.',
      true,
    );
  const snapshot = memoryWorkspaceSchema.safeParse(body);
  return {
    message: typeof body.message === 'string' && body.message ? body.message : 'Рішення збережено.',
    snapshot: snapshot.success ? snapshot.data : null,
  };
}

/** Private metadata only. Demo never reads/writes the owner's registry. */
export async function fetchCredentials(): Promise<Credentials> {
  if (!inTelegram()) throw new Error('Відкрий налаштування в особистому чаті з ботом.');
  const response = await fetch('/api/credentials', {
    cache: 'no-store',
    headers: authHeaders(),
  }).catch(() => {
    throw new Error('Не вдалося завантажити реєстр доступів. Спробуй ще раз.');
  });
  throwIfSessionExpired(response);
  if (!response.ok) throw new Error('Не вдалося завантажити реєстр доступів.');
  const parsed = credentialsSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new Error('Формат реєстру змінився. Онови застосунок.');
  return parsed.data;
}
export async function saveCredentialMetadata(value: CredentialMetadata): Promise<Credentials> {
  if (!inTelegram()) throw new Error('Цю зміну можна зробити лише в особистому чаті з ботом.');
  const response = await fetch('/api/credentials', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify(value),
  }).catch(() => {
    throw new Error('Не отримав підтвердження збереження. Онови реєстр перед повтором.');
  });
  throwIfSessionExpired(response);
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(typeof body?.error === 'string' ? body.error : 'Не вдалося зберегти дати.');
  const parsed = credentialsSchema.safeParse(body);
  if (!parsed.success)
    throw new Error(
      body?.saved === true
        ? 'Дати збережено, але не вдалося оновити їхній показ. Онови реєстр.'
        : 'Не отримав підтвердження збереження. Онови реєстр перед повтором.',
    );
  return parsed.data;
}
export async function fetchCurrencyHistory(
  code: string,
): Promise<Array<{ date: string; value: number }> | null> {
  if (!inTelegram()) return null;
  const response = await fetch(`/api/currency/history?code=${encodeURIComponent(code)}`, {
    headers: authHeaders(),
  });
  throwIfSessionExpired(response);
  if (!response.ok) throw new Error('Історія НБУ тимчасово недоступна');
  const data = await response.json();
  if (!Array.isArray(data.points)) throw new Error('Неповні дані історії');
  return data.points.filter(
    (p: { date: string; value: number }) =>
      typeof p?.date === 'string' && Number.isFinite(p?.value) && p.value > 0,
  );
}
export async function fetchNewsSnapshot() {
  if (!inTelegram()) return null;
  const res = await fetch('/api/news', { headers: authHeaders() });
  throwIfSessionExpired(res);
  if (!res.ok) throw new Error('Не вдалося оновити стрічку. Показано останній брифінг.');
  return newsSnapshotSchema.parse(await res.json());
}
export async function postNewsAction(
  action:
    | { type: 'refresh' | 'seen' }
    | {
        type: 'feedback';
        url: string;
        kind: 'like' | 'less' | 'clear';
        reason?: 'topic' | 'repeat' | 'weak' | 'source';
      },
) {
  if (!inTelegram()) return { ok: true, demo: true };
  const response = await fetch('/api/news', {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(action),
  });
  throwIfSessionExpired(response);
  if (!response.ok) throw new Error('Не вдалося оновити новини. Спробуй ще раз.');
  return (await response.json()) as {
    ok: boolean;
    skipped?: string;
    updated?: boolean;
    retryAfterSeconds?: number;
    feedback?: Record<string, 'like' | 'less' | 'clear'>;
    lastSeenAt?: string;
    demo?: boolean;
  };
}

export async function fetchFinance() {
  return readFinanceSnapshot();
}
async function readFinanceSnapshot(signal?: AbortSignal) {
  if (!inTelegram()) return { finance: readFinanceDemo(), demo: true };
  const res = await fetch('/api/finance', {
    headers: authHeaders(),
    cache: 'no-store',
    ...(signal ? { signal } : {}),
  }).catch(() => {
    throw new Error('Не вдалося зв’язатися із сервером. Перевір інтернет і спробуй знову.');
  });
  throwIfSessionExpired(res);
  if (!res.ok) throw new Error('Не вдалося завантажити фінанси. Спробуй знову.');
  return { finance: financeSchema.parse(await res.json()), demo: false };
}
export async function refreshFinanceBank(accountId: string, transactionId?: string) {
  if (!inTelegram()) return fetchFinance();
  const res = await fetch('/api/finance', {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json', 'X-Finance-Sync': '2' },
    body: JSON.stringify({ type: 'bank-refresh', payload: { accountId, transactionId } }),
  });
  throwIfSessionExpired(res);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(
      typeof body?.error === 'string'
        ? body.error
        : 'Не вдалося звірити операції з Monobank. Спробуй ще раз.',
    );
  }
  return { finance: financeSchema.parse(await res.json()), demo: false };
}
function analyticsParams(input: AnalyticsRequest) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) if (value != null) params.set(key, value);
  return params;
}
export async function fetchFinanceAnalytics(input: AnalyticsRequest) {
  const params = analyticsParams(input);
  if (!inTelegram()) {
    const f = readFinanceDemo(),
      selection = analyticsSelection(params);
    return financeAnalyticsSchema.parse({
      ok: true,
      generatedAt: new Date().toISOString(),
      ...buildExpenseAnalytics(f.transactions, selection, f.merchantAliases),
      report: buildFinanceReport(f, selection.from, selection.to),
      reportScope: 'all-accounts',
      coverage: {
        bankRetentionDays: 720,
        oldestTransactionAt: f.transactions.map((t) => t.at).sort()[0] ?? null,
        beyondBankRetention: false,
      },
    });
  }
  params.set('view', 'analytics');
  const res = await fetch(`/api/finance?${params}`, { headers: authHeaders(), cache: 'no-store' });
  throwIfSessionExpired(res);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(
      typeof body?.error === 'string' ? body.error : 'Аналітика недоступна. Спробуй ще раз.',
    );
  }
  return financeAnalyticsSchema.parse(await res.json());
}
export async function fetchAnalyticsOperations(
  input: AnalyticsRequest,
  options: {
    cursor?: string | null;
    day?: string;
    kind?: string;
    issue?: string;
    weekday?: string;
    transactionId?: string;
    categories?: string;
  } = {},
) {
  const params = analyticsParams(input);
  for (const [key, value] of Object.entries(options)) if (value) params.set(key, value);
  if (!inTelegram()) {
    const f = readFinanceDemo(),
      selection = analyticsSelection(params),
      cursor = options.cursor ? JSON.parse(options.cursor) : null;
    const rows = f.transactions
      .filter((t) => {
        const date = kyivParts(Date.parse(t.at)).date;
        return (
          matchesAnalytics(t, selection, f.merchantAliases) &&
          matchesAnalyticsIssue(t, options.issue) &&
          (!options.transactionId || t.id === options.transactionId) &&
          (!options.categories ||
            (JSON.parse(options.categories) as string[]).includes(t.category)) &&
          (options.weekday == null ||
            String((new Date(date + 'T12:00:00Z').getUTCDay() + 6) % 7) === options.weekday) &&
          date >= selection.from &&
          date <= selection.to &&
          (!options.day || date === options.day) &&
          ((options.kind ?? 'expense') === 'all' || t.kind === (options.kind ?? 'expense')) &&
          ((options.kind ?? 'expense') !== 'expense' || (t.amountUah != null && t.amountUah < 0)) &&
          (!cursor || t.at < cursor.at || (t.at === cursor.at && t.id < cursor.id))
        );
      })
      .sort((a, b) => (a.at === b.at ? (a.id > b.id ? -1 : 1) : a.at > b.at ? -1 : 1));
    const items = rows.slice(0, 50),
      last = items.at(-1);
    return analyticsOperationsSchema.parse({
      ok: true,
      generatedAt: new Date().toISOString(),
      items,
      nextCursor: rows.length > 50 && last ? JSON.stringify({ at: last.at, id: last.id }) : null,
    });
  }
  params.set('view', 'analytics-operations');
  const res = await fetch(`/api/finance?${params}`, { headers: authHeaders(), cache: 'no-store' });
  throwIfSessionExpired(res);
  if (!res.ok) throw new Error('Не вдалося завантажити операції. Повтори спробу.');
  return analyticsOperationsSchema.parse(await res.json());
}
export async function fetchFinanceMerchants(
  input: AnalyticsRequest,
  options: { search?: string; sort?: string; after?: string | null; ungrouped?: string } = {},
) {
  const { financeMerchantsSchema } = await import('./finance-analytics-schema.ts');
  const params = analyticsParams(input);
  for (const [key, value] of Object.entries(options)) if (value) params.set(key, value);
  if (!inTelegram()) {
    const f = readFinanceDemo(),
      acc = analyticsAccumulator(
        analyticsSelection(params),
        options.ungrouped === '1' ? {} : f.merchantAliases,
        true,
      );
    f.transactions.forEach(acc.consume);
    const rows = acc
      .finish()
      .merchants.filter((m) =>
        m.merchant
          .toLocaleLowerCase('uk-UA')
          .includes((options.search ?? '').toLocaleLowerCase('uk-UA')),
      )
      .sort((a, b) =>
        options.sort === 'count'
          ? b.count - a.count ||
            b.amountMinor - a.amountMinor ||
            a.merchant.localeCompare(b.merchant, 'uk')
          : b.amountMinor - a.amountMinor || a.merchant.localeCompare(b.merchant, 'uk'),
      );
    const start = options.after
        ? rows.findIndex((m) => m.merchant === JSON.parse(options.after!).merchant) + 1
        : 0,
      items = rows.slice(start, start + 50);
    return financeMerchantsSchema.parse({
      ok: true,
      items,
      total: rows.length,
      nextCursor:
        start + 50 < rows.length
          ? JSON.stringify({ merchant: items.at(-1)?.merchant ?? '' })
          : null,
    });
  }
  params.set('view', 'analytics-merchants');
  const r = await fetch(`/api/finance?${params}`, { headers: authHeaders(), cache: 'no-store' });
  throwIfSessionExpired(r);
  if (!r.ok) throw new Error('Не вдалося завантажити продавців.');
  return financeMerchantsSchema.parse(await r.json());
}
export async function fetchFinanceReport(from: string, to: string) {
  if (!inTelegram())
    return financeReportSchema.parse(buildFinanceReport(readFinanceDemo(), from, to));
  const params = new URLSearchParams({ from, to });
  const res = await fetch(`/api/finance?${params}`, { headers: authHeaders(), cache: 'no-store' });
  throwIfSessionExpired(res);
  if (!res.ok) throw new Error('Не вдалося завантажити звіт. Перевір період і спробуй знову.');
  return financeReportSchema.parse(await res.json());
}
export async function postFinance(command: FinanceCommand) {
  if (!inTelegram()) {
    writeFinanceDemo(command);
    return { finance: readFinanceDemo(), demo: true };
  }
  // Freeze ID, version, timestamp and body for both attempts. The server checks
  // the command receipt before its version, so an accepted retry is a no-op.
  const body = JSON.stringify(command);
  let acknowledged = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch('/api/finance', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });
      throwIfSessionExpired(res);
      if (!res.ok) {
        if (res.status >= 500) throw new FinanceSaveUncertainError();
        const error: unknown = await res.json().catch(() => null);
        throw new FinanceCommandRejectedError(
          res.status,
          error && typeof error === 'object' && 'error' in error && typeof error.error === 'string'
            ? error.error
            : 'Не вдалося зберегти операцію',
        );
      }
      const receipt: unknown = await res.json();
      if (!receipt || typeof receipt !== 'object' || !('ok' in receipt) || receipt.ok !== true)
        throw new FinanceSaveUncertainError();
      acknowledged = true;
      break;
    } catch (error) {
      if (error instanceof SessionExpiredError || error instanceof FinanceCommandRejectedError)
        throw error;
    } finally {
      clearTimeout(timer);
    }
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!acknowledged) throw new FinanceSaveUncertainError();
  // A lost GET after the receipt cannot turn an accepted write into a failure.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    return await readFinanceSnapshot(controller.signal).catch(() => ({
      finance: null,
      demo: false,
    }));
  } finally {
    clearTimeout(timer);
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

export function throwIfSessionExpired(res: Response): void {
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
  /** Server countdowns belong to this snapshot, not subsequent optimistic cache writes. */
  receivedAtMs?: number;
}

/**
 * Завантажити /api/stats. Поза Telegram — явне demo; 401/403 у Telegram —
 * SessionExpiredError, ніколи не підставні персональні дані.
 */
export async function fetchStats(): Promise<StatsResult> {
  if (!inTelegram())
    return demoGate(
      () => ({ stats: demoStats(), demo: true, receivedAtMs: Date.now() }),
      () => ({ stats: EMPTY_STATS, demo: true, receivedAtMs: Date.now() }),
    );

  const res = await fetch('/api/stats', { cache: 'no-store', headers: authHeaders() });
  throwIfSessionExpired(res);
  if (!res.ok) throw new Error(`Не вдалося завантажити статистику (${res.status})`);

  const parsed = statsSchema.safeParse(await res.json());
  if (!parsed.success) {
    throw new Error('Формат статистики змінився — оновіть застосунок');
  }
  return { stats: parsed.data, demo: false, receivedAtMs: Date.now() };
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

/** Демо-налаштування: поза Telegram зберігаються локально, не змінюють профіль власника. */
const DEMO_SETTINGS: SettingsResponse = {
  settings: { quiet: { enabled: false, from: '22:00', to: '08:00' }, modules: {}, mutedTopics: [] },
  connectors: {
    google: true,
    calendar: true,
    gmail: true,
    scopeKnown: true,
    calendarWrite: true,
    mono: true,
  },
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
  throwIfSessionExpired(res);
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

export type SystemSelection = {
  range: 'today' | '7d' | 'month' | 'custom';
  from?: string;
  to?: string;
  before?: string;
};
function systemQuery(selection?: SystemSelection, refresh = false) {
  const params = new URLSearchParams();
  if (selection)
    for (const [key, value] of Object.entries(selection)) if (value) params.set(key, value);
  if (refresh) params.set('refresh', '1');
  return params.size ? `?${params}` : '';
}
export async function fetchSystem(
  selection?: SystemSelection,
  refresh = false,
): Promise<import('./system-schema.ts').SystemSnapshot> {
  if (!inTelegram()) throw new Error('Відкрий панель в особистому чаті з ботом.');
  const response = await fetch(`/api/system${systemQuery(selection, refresh)}`, {
    cache: 'no-store',
    headers: authHeaders(),
  }).catch(() => {
    throw new Error('Не вдалося оновити стан системи.');
  });
  throwIfSessionExpired(response);
  if (!response.ok)
    throw new Error(
      response.status === 403
        ? 'Панель доступна лише основному власнику.'
        : 'Системний огляд зараз недоступний.',
    );
  const { systemSchema } = await import('./system-schema.ts');
  const parsed = systemSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new Error('Формат системного огляду змінився. Онови застосунок.');
  return parsed.data;
}

export async function postSystem(action: Record<string, unknown>, selection?: SystemSelection) {
  if (!inTelegram()) throw new Error('Відкрий панель в особистому чаті з ботом.');
  const response = await fetch(`/api/system${systemQuery(selection)}`, {
    method: 'POST',
    cache: 'no-store',
    headers: { ...authHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify(action),
  });
  throwIfSessionExpired(response);
  const body = (await response.json().catch(() => null)) as {
    ok?: boolean;
    error?: string;
    retryAfterSeconds?: number;
    refreshing?: boolean;
  } | null;
  if (!response.ok || body?.ok !== true) {
    const errors: Record<string, string> = {
      conflict: 'Налаштування вже змінено. Онови огляд і повтори.',
      cooldown: `${body?.refreshing ? 'Рахунок ще оновлюється.' : 'Пауза між спробами оновлення.'} Повтори через ${Number.isFinite(body?.retryAfterSeconds) ? Math.max(1, Math.ceil(body!.retryAfterSeconds!)) : 60} с.`,
      'not-configured': 'Спершу підключи окремий доступ до білінгу.',
      access: 'Провайдер відхилив доступ до білінгу.',
      scope: 'Дані не відповідають обраному проєкту або валюті.',
      incomplete: 'Провайдер повернув неповний рахунок. Попередні дані збережено.',
      invalid: 'Перевір суми бюджету.',
      unsupported: 'Цей конектор ще потребує окремого підключення.',
      configuration:
        'Перевір ключ білінгу та Project ID у Cloudflare: без лапок і переносів усередині значення.',
      timeout: 'Провайдер не відповів вчасно. Спробуй оновити рахунок після паузи.',
      network: 'Не вдалося встановити з’єднання з провайдером.',
      format: 'Провайдер повернув неочікуваний формат рахунку.',
      request: 'Провайдер відхилив параметри запиту. Перевір Project ID.',
      redirect:
        'Провайдер перенаправив запит. Оновлення зупинено, ключ не передано на іншу адресу.',
      internal: 'Не вдалося обробити рахунок у Світанку. Повтори після паузи.',
      storage: 'Не вдалося зберегти рахунок. Попередні дані залишилися доступними.',
    };
    throw new Error(
      errors[body?.error ?? ''] ?? 'Не вдалося виконати дію. Попередні дані збережено.',
    );
  }
  return body;
}
