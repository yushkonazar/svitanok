// onthisday (consumer). «У цей день» — історичні події з Wikipedia (uk).
// Лише дашборд (inMessage:false). Фіксований REST-ендпоінт -> прямий fetch.

import type { Module, Block, Ctx } from '../core/types.js';
import type { AppConfig } from '../core/config.js';

const PRIORITY = 25;

export interface OnThisDayEvent {
  year: number;
  text: string;
}

export function parseEvents(json: unknown, limit: number): OnThisDayEvent[] {
  const events = (json as { events?: { year?: number; text?: string }[] })?.events;
  if (!Array.isArray(events)) return [];
  return events
    .filter((e) => typeof e.year === 'number' && typeof e.text === 'string' && e.text.trim())
    .sort((a, b) => (b.year ?? 0) - (a.year ?? 0)) // новіші перші
    .slice(0, limit)
    .map((e) => ({ year: e.year as number, text: (e.text as string).trim() }));
}

export interface OnThisDayOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  limit?: number;
}

export function createOnThisDayModule(opts: OnThisDayOptions = {}): Module<AppConfig> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30000;
  const limit = opts.limit ?? 4;

  return {
    id: 'onthisday',
    kind: 'consumer',
    enabled: (config) => config.modules.onthisday.enabled,

    async run(ctx: Ctx<AppConfig>): Promise<Block | null> {
      const [, mm, dd] = ctx.clock.todayKey().split('-'); // YYYY-MM-DD
      const url = `https://uk.wikipedia.org/api/rest_v1/feed/onthisday/events/${mm}/${dd}`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetchImpl(url, {
          signal: ctrl.signal,
          headers: { 'user-agent': 'svitanok-bot/1.0' },
        });
        if (!res.ok) throw new Error(`Wikipedia HTTP ${res.status}`);
        const events = parseEvents(await res.json(), limit);
        if (events.length === 0) return null;
        return {
          id: 'onthisday',
          title: 'У цей день',
          icon: '📜',
          summary: events.map((e) => `${e.year}: ${e.text}`).join('\n'),
          data: { events },
          inMessage: false, // лише дашборд
          priority: PRIORITY,
        };
      } catch (e) {
        ctx.log.warn(`onthisday: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
