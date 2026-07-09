// onthisday (consumer). «У цей день» — історичні події з Wikipedia (uk).
// Лише дашборд (inMessage:false). Фіксований REST-ендпоінт -> прямий fetch.

import type { Module, Block, Ctx } from '../core/types.js';
import type { AppConfig } from '../core/config.js';

const PRIORITY = 25;

export interface OnThisDayEvent {
  year: number;
  text: string;
}

/** Розпарсити й провалідувати сирі події з Wikipedia (без відбору/сортування). */
export function parseEvents(json: unknown): OnThisDayEvent[] {
  const events = (json as { events?: { year?: number; text?: string }[] })?.events;
  if (!Array.isArray(events)) return [];
  return events
    .filter((e) => typeof e.year === 'number' && typeof e.text === 'string' && e.text.trim())
    .map((e) => ({ year: e.year as number, text: (e.text as string).trim() }));
}

// Стратифікація епох (ідея власника, 2026-07-08): «стародавні» події рідкісні
// в сирих даних Wikipedia (на порядок менше, ніж XX–XXI ст. на кожен день),
// тому чисте сортування «новіші перші + cap» їх систематично вимиває. Натомість
// РЕЗЕРВУЄМО слоти під старі епохи й показуємо їх ПЕРШИМИ (найбільший
// «вау»-ефект + гарантія, що вони не сховані за «показати ще» на дашборді).
const ANCIENT_BEFORE_YEAR = 1900; // до цього року — «стародавні»
const MODERN_FROM_YEAR = 2000; // від цього року — «XXI ст.»
const ANCIENT_SLOTS = 3; // зарезервовано під стародавні (<1900)
const CENTURY20_SLOTS = 3; // зарезервовано під XX ст. (1900–1999)
// решта бюджету (limit - зайняті слоти) — XXI ст., найбільш насичена епоха.

/**
 * Стратифікований відбір із гарантією представленості старих епох. Порядок:
 * стародавні (найстаріші — найцінніші) → XX ст. → XXI ст. Якщо в епосі бракує
 * подій для своєї квоти — залишок бюджету переходить до наступної епохи.
 * Якщо ж, навпаки, епоха має БІЛЬШЕ подій за квоту, а бюджету після всіх трьох
 * проходів лишилось невикористаним (інша епоха була короткою) — добираємо
 * решту з надлишків понад квоту (той самий порядок пріоритету), щоб не
 * занижувати кількість без потреби, коли сирих подій вистачає. Звичайний день
 * без старих подій поводиться як проста сортовка «новіші перші».
 */
export function selectHistoric(events: OnThisDayEvent[], limit: number): OnThisDayEvent[] {
  if (limit <= 0) return [];

  const ancient = events
    .filter((e) => e.year < ANCIENT_BEFORE_YEAR)
    .sort((a, b) => a.year - b.year); // найстаріші перші (рідкісніші — цінніші)
  const century20 = events
    .filter((e) => e.year >= ANCIENT_BEFORE_YEAR && e.year < MODERN_FROM_YEAR)
    .sort((a, b) => b.year - a.year);
  const century21 = events
    .filter((e) => e.year >= MODERN_FROM_YEAR)
    .sort((a, b) => b.year - a.year);

  const pickedAncient = ancient.slice(0, Math.min(ANCIENT_SLOTS, limit));
  const pickedCentury20 = century20.slice(
    0,
    Math.max(0, Math.min(CENTURY20_SLOTS, limit - pickedAncient.length)),
  );
  const remainingForModern = Math.max(0, limit - pickedAncient.length - pickedCentury20.length);
  const pickedCentury21 = century21.slice(0, remainingForModern);

  const spare = limit - pickedAncient.length - pickedCentury20.length - pickedCentury21.length;
  const extra =
    spare > 0
      ? [
          ...ancient.slice(pickedAncient.length),
          ...century20.slice(pickedCentury20.length),
          ...century21.slice(pickedCentury21.length),
        ].slice(0, spare)
      : [];

  return [...pickedAncient, ...pickedCentury20, ...pickedCentury21, ...extra];
}

export interface OnThisDayOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  limit?: number;
}

export function createOnThisDayModule(opts: OnThisDayOptions = {}): Module<AppConfig> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30000;
  const limit = opts.limit ?? 10; // дашборд показує 8 + «показати ще»

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
        const events = selectHistoric(parseEvents(await res.json()), limit);
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
