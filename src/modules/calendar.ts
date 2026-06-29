// calendar (producer, §6). Події Google Calendar на сьогодні через OAuth refresh
// token (calendar.readonly). Межі дня будуються через TZ Europe/Kyiv —
// БЕЗ хардкоду +03:00 (§19.11): узимку Київ +02:00. 401/invalid_grant -> null
// (не валить брифінг). Пише calendar.today у RunBus для today-консьюмера.

import type { Module, Block, Ctx } from '../core/types.js';
import type { AppConfig } from '../core/config.js';
import { optionalSecret } from '../core/secrets.js';

export const CALENDAR_BUS_KEY = 'calendar.today';

export interface CalendarEvent {
  title: string;
  time: string | null; // "HH:MM" Київ, або null для подій на весь день
}

/** Зсув TZ у мс для конкретного інстанту (через toLocaleString-трюк). */
function tzOffsetMs(timeZone: string, date: Date): number {
  const utc = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
  const tz = new Date(date.toLocaleString('en-US', { timeZone }));
  return tz.getTime() - utc.getTime();
}

/** Межі київської доби todayKey як UTC-інстанти (RFC3339, DST-коректно §19.11). */
export function kyivDayBoundsUtc(todayKey: string): { timeMin: string; timeMax: string } {
  const [y, m, d] = todayKey.split('-').map(Number);
  const asUtcMidnight = Date.UTC(y!, m! - 1, d!, 0, 0, 0);
  const offset = tzOffsetMs('Europe/Kyiv', new Date(asUtcMidnight));
  const startUtc = asUtcMidnight - offset; // київська 00:00 у реальному UTC
  const endUtc = startUtc + 24 * 3600 * 1000;
  return { timeMin: new Date(startUtc).toISOString(), timeMax: new Date(endUtc).toISOString() };
}

interface GoogleEvent {
  summary?: string;
  start?: { dateTime?: string; date?: string };
}

function kyivHhMm(iso: string): string {
  const fmt = new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return fmt.format(new Date(iso));
}

export function parseEvents(json: unknown): CalendarEvent[] {
  const items = (json as { items?: GoogleEvent[] })?.items;
  if (!Array.isArray(items)) return [];
  return items.map((e) => ({
    title: e.summary?.trim() || '(без назви)',
    time: e.start?.dateTime ? kyivHhMm(e.start.dateTime) : null,
  }));
}

export interface CalendarModuleOptions {
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

interface OAuthCreds {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export function createCalendarModule(opts: CalendarModuleOptions = {}): Module<AppConfig> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const env = opts.env ?? process.env;
  const timeoutMs = opts.timeoutMs ?? 30000;

  function creds(): OAuthCreds | null {
    const clientId = optionalSecret('GOOGLE_CLIENT_ID', env);
    const clientSecret = optionalSecret('GOOGLE_CLIENT_SECRET', env);
    const refreshToken = optionalSecret('GOOGLE_REFRESH_TOKEN', env);
    if (!clientId || !clientSecret || !refreshToken) return null;
    return { clientId, clientSecret, refreshToken };
  }

  async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fn(ctrl.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  async function accessToken(c: OAuthCreds): Promise<string> {
    const body = new URLSearchParams({
      client_id: c.clientId,
      client_secret: c.clientSecret,
      refresh_token: c.refreshToken,
      grant_type: 'refresh_token',
    });
    const res = await withTimeout((signal) =>
      fetchImpl('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal,
      }),
    );
    if (!res.ok) {
      // 401/invalid_grant (протух refresh token — OAuth не в Production, §6)
      throw new Error(`Google token HTTP ${res.status}`);
    }
    const json = (await res.json()) as { access_token?: string };
    if (!json.access_token) throw new Error('Google token: немає access_token');
    return json.access_token;
  }

  async function fetchEvents(token: string, todayKey: string): Promise<CalendarEvent[]> {
    const { timeMin, timeMax } = kyivDayBoundsUtc(todayKey);
    const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
    url.searchParams.set('timeMin', timeMin);
    url.searchParams.set('timeMax', timeMax);
    url.searchParams.set('singleEvents', 'true');
    url.searchParams.set('orderBy', 'startTime');
    url.searchParams.set('timeZone', 'Europe/Kyiv');
    const res = await withTimeout((signal) =>
      fetchImpl(url.toString(), { headers: { Authorization: `Bearer ${token}` }, signal }),
    );
    if (!res.ok) throw new Error(`Google Calendar HTTP ${res.status}`);
    return parseEvents(await res.json());
  }

  return {
    id: 'calendar',
    kind: 'producer',
    enabled: (config) => config.modules.calendar.enabled,
    async run(ctx: Ctx<AppConfig>): Promise<Block | null> {
      const c = creds();
      if (!c) {
        ctx.log.warn('GOOGLE_* секрети відсутні — calendar пропущено');
        return null;
      }
      let events: CalendarEvent[];
      try {
        const token = await accessToken(c);
        events = await fetchEvents(token, ctx.clock.todayKey());
      } catch (e) {
        // Деградуємо тихо (§6): не валимо брифінг.
        ctx.log.warn(`calendar недоступний: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }

      ctx.bus.set(CALENDAR_BUS_KEY, events); // для today-консьюмера навіть якщо порожньо
      if (events.length === 0) return null;

      const lines = events.map((e) => (e.time ? `${e.time} ${e.title}` : `увесь день: ${e.title}`));
      return {
        id: 'calendar',
        title: 'Сьогодні в календарі',
        icon: '📅',
        summary: lines.join('\n'),
        priority: 30,
      };
    },
  };
}
