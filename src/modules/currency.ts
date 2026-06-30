// currency (consumer). Курс НБУ (USD/EUR). Лише дашборд (inMessage:false).
// Фіксований ендпоінт НБУ (не з контенту) -> прямий fetch, без allowlist.

import type { Module, Block, Ctx } from '../core/types.js';
import type { AppConfig } from '../core/config.js';

const CURRENCY_PRIORITY = 30;
const NBU_URL = 'https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?json';

interface NbuRate {
  cc?: string;
  rate?: number;
}

export function pickRates(json: unknown): { usd: number; eur: number } | null {
  if (!Array.isArray(json)) return null;
  const find = (cc: string) => (json as NbuRate[]).find((x) => x?.cc === cc)?.rate;
  const usd = find('USD');
  const eur = find('EUR');
  if (typeof usd !== 'number' || typeof eur !== 'number') return null;
  return { usd: Math.round(usd * 100) / 100, eur: Math.round(eur * 100) / 100 };
}

export interface CurrencyModuleOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function createCurrencyModule(opts: CurrencyModuleOptions = {}): Module<AppConfig> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30000;

  return {
    id: 'currency',
    kind: 'consumer',
    enabled: (config) => config.modules.currency.enabled,

    async run(ctx: Ctx<AppConfig>): Promise<Block | null> {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetchImpl(NBU_URL, { signal: ctrl.signal });
        if (!res.ok) throw new Error(`НБУ HTTP ${res.status}`);
        const rates = pickRates(await res.json());
        if (!rates) return null;
        return {
          id: 'currency',
          title: 'Курс',
          icon: '💱',
          summary: `USD ${rates.usd} · EUR ${rates.eur}`,
          data: rates,
          inMessage: false, // лише дашборд
          priority: CURRENCY_PRIORITY,
        };
      } catch (e) {
        ctx.log.warn(`currency: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
