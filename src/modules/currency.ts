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
  txt?: string;
  exchangedate?: string;
}

export interface CatalogRate {
  code: string;
  name: string;
  rate: number;
  asOf?: string;
}
export function pickCatalog(json: unknown): CatalogRate[] {
  if (!Array.isArray(json)) return [];
  const unique = new Map<string, CatalogRate>();
  for (const row of json as NbuRate[]) {
    if (
      !row ||
      !/^[A-Z]{3}$/.test(row.cc ?? '') ||
      !Number.isFinite(row.rate) ||
      (row.rate ?? 0) <= 0
    )
      continue;
    if (['XAU', 'XAG', 'XPT', 'XPD'].includes(row.cc!)) continue;
    const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(row.exchangedate ?? '');
    unique.set(row.cc!, {
      code: row.cc!,
      name: row.txt || row.cc!,
      rate: row.rate!,
      ...(m ? { asOf: `${m[3]}-${m[2]}-${m[1]}` } : {}),
    });
  }
  return [...unique.values()].sort((a, b) => a.code.localeCompare(b.code));
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
  const r2 = (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : undefined;
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
        const raw = await res.json();
        const rates = pickRates(raw);
        if (!rates) return null;
        const catalog = pickCatalog(raw);

        // Історія в стані: додаємо сьогодні (дедуп за датою), тримаємо останні 14 днів.
        const today = ctx.clock.todayKey();
        const prev = ctx.state.get<HistEntry[]>('currencyHistory') ?? [];
        const hist = [...prev.filter((h) => h.date !== today), { date: today, ...rates }].slice(
          -HISTORY_DAYS,
        );
        ctx.state.set('currencyHistory', hist);
        // One shared request already contains every supported currency. Keep
        // dated observations; no network request on search or chart gestures.
        const old =
          ctx.state.get<Array<{ date: string; rates: Record<string, number> }>>(
            'currencyCatalogHistory',
          ) ?? [];
        const observations = [
          ...old.filter((h) => h.date < today),
          {
            date: today,
            rates: Object.fromEntries(catalog.map((r) => [r.code, r.rate])),
          },
        ]
          .sort((a, b) => a.date.localeCompare(b.date))
          .slice(-90);
        ctx.state.set('currencyCatalogHistory', observations);

        const series = (k: keyof Rates) =>
          hist.map((h) => h[k]).filter((v): v is number => typeof v === 'number');

        return {
          id: 'currency',
          title: 'Курс',
          icon: '💱',
          summary: `USD ${rates.usd} · EUR ${rates.eur}`,
          data: {
            ...rates,
            catalog,
            observations,
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
