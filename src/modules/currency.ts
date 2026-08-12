// currency (consumer). Курс НБУ (USD/EUR/PLN/GBP) + історія (rolling 14 днів у
// стані для спарклайнів дашборда). Лише дашборд. Фіксований
// ендпоінт НБУ (не з контенту) -> прямий fetch, без allowlist.

import type { Module, Block, Ctx } from '../core/types.js';
import type { AppConfig } from '../core/config.js';

const CURRENCY_PRIORITY = 30;
const NBU_URL = 'https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?json';
const HISTORY_DAYS = 14;

interface NbuRate {
  cc?: string;
  rate?: number;
}

export interface Rates {
  usd: number;
  eur: number;
  pln?: number;
  gbp?: number;
}

interface HistEntry extends Rates {
  date: string; // YYYY-MM-DD
}

/** Витягти USD/EUR (обов'язкові) + PLN/GBP (опційні), округлити до копійок. */
export function pickRates(json: unknown): Rates | null {
  if (!Array.isArray(json)) return null;
  const r2 = (v: unknown) => (typeof v === 'number' ? Math.round(v * 100) / 100 : undefined);
  const find = (cc: string) => r2((json as NbuRate[]).find((x) => x?.cc === cc)?.rate);
  const usd = find('USD');
  const eur = find('EUR');
  if (usd === undefined || eur === undefined) return null;
  const out: Rates = { usd, eur };
  const pln = find('PLN');
  const gbp = find('GBP');
  if (pln !== undefined) out.pln = pln;
  if (gbp !== undefined) out.gbp = gbp;
  return out;
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

        // Історія в стані: додаємо сьогодні (дедуп за датою), тримаємо останні 14 днів.
        const today = ctx.clock.todayKey();
        const prev = ctx.state.get<HistEntry[]>('currencyHistory') ?? [];
        const hist = [...prev.filter((h) => h.date !== today), { date: today, ...rates }].slice(
          -HISTORY_DAYS,
        );
        ctx.state.set('currencyHistory', hist);

        const series = (k: keyof Rates) =>
          hist.map((h) => h[k]).filter((v): v is number => typeof v === 'number');

        return {
          id: 'currency',
          title: 'Курс',
          icon: '💱',
          summary: `USD ${rates.usd} · EUR ${rates.eur}`,
          data: {
            ...rates,
            usdHistory: series('usd'),
            eurHistory: series('eur'),
            plnHistory: series('pln'),
            gbpHistory: series('gbp'),
          },
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
