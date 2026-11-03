import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchCurrencyHistory } from '../../api/client.ts';
import type { CurrencyData } from '../../api/briefing-schema.ts';
import { amountInput } from '../../lib/amountInput.ts';
import { ObservationChart } from '../charts/ObservationChart.tsx';
import { SectionLabel, Ph } from '../ui/primitives.tsx';
import { Explanation } from '../ui/Explanation.tsx';
import { UpdatedValue } from '../ui/UpdatedValue.tsx';

const DEFAULTS = ['USD', 'EUR', 'PLN', 'GBP'];
const WATCH_KEY = 'svitanok:currency-watch:v1';
const CONTEXT_KEY = 'svitanok:currency-context:v1';
function initialContext(): { code: string; raw: string } {
  try {
    const value = JSON.parse(sessionStorage.getItem(CONTEXT_KEY) ?? '{}');
    return {
      code: /^[A-Z]{3}$/.test(value.code) ? value.code : 'USD',
      raw: typeof value.raw === 'string' ? value.raw.slice(0, 24) : '100',
    };
  } catch {
    return { code: 'USD', raw: '100' };
  }
}
/** A gap is labelled by its actual date, never presented as yesterday. */
export function currencyChange(d: CurrencyData, code: string, rate: number, asOf: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || !Number.isFinite(Date.parse(asOf))) return null;
  const previous = (d.observations ?? [])
    .filter(
      (p) =>
        /^\d{4}-\d{2}-\d{2}$/.test(p.date) &&
        Number.isFinite(Date.parse(p.date)) &&
        p.date < asOf &&
        Number.isFinite(p.rates[code]) &&
        p.rates[code] > 0,
    )
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  if (!previous) return null;
  const delta = rate - previous.rates[code];
  const yesterday = new Date(Date.parse(asOf) - 86400000).toISOString().slice(0, 10);
  return {
    delta,
    percent: (delta / previous.rates[code]) * 100,
    label:
      previous.date === yesterday
        ? 'до вчора'
        : `до ${new Date(previous.date + 'T12:00:00Z').toLocaleDateString('uk-UA', { day: 'numeric', month: 'short' })}`,
  };
}
const NAMES: Record<string, string> = {
  USD: 'Долар США',
  EUR: 'Євро',
  PLN: 'Польський злотий',
  GBP: 'Фунт стерлінгів',
  UAH: 'Гривня',
};
const SYMBOLS: Record<string, string> = { USD: '$', EUR: '€', PLN: 'zł', GBP: '£', UAH: '₴' };
function initialWatch(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(WATCH_KEY) ?? 'null');
    if (
      Array.isArray(stored) &&
      stored.length &&
      stored.every((s) => typeof s === 'string' && /^[A-Z]{3}$/.test(s))
    )
      return [...new Set(stored)].slice(0, 100);
  } catch {
    /* Storage can be unavailable in a WebView. */
  }
  return DEFAULTS;
}

export function CurrencyBlock({ d, date }: { d: CurrencyData | null; date: string | null }) {
  const [watch, setWatch] = useState(initialWatch);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [converterOpen, setConverterOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedCode, setCode] = useState(() => initialContext().code);
  const [period, setPeriod] = useState(30);
  const [raw, setRaw] = useState(() => initialContext().raw);
  const legacy = DEFAULTS.flatMap((cc) => {
    const k = cc.toLowerCase() as 'usd' | 'eur' | 'pln' | 'gbp';
    const rate = d?.[k];
    return rate != null && Number.isFinite(rate) && rate > 0
      ? [{ code: cc, name: NAMES[cc], rate, asOf: undefined }]
      : [];
  });
  const catalog = d?.catalog?.length ? d.catalog : legacy;
  const all = [{ code: 'UAH', name: NAMES.UAH, rate: 1 }, ...catalog];
  const rates = Object.fromEntries(all.map((r) => [r.code, r.rate]));
  const availableWatch = watch.filter((cc) => catalog.some((r) => r.code === cc));
  const defaultWatch = DEFAULTS.filter((cc) => catalog.some((r) => r.code === cc));
  const effectiveWatch = availableWatch.length
    ? availableWatch
    : defaultWatch.length
      ? defaultWatch
      : catalog.slice(0, 1).map((r) => r.code);
  const rows = catalog
    .filter((r) => effectiveWatch.includes(r.code))
    .sort((a, b) => effectiveWatch.indexOf(a.code) - effectiveWatch.indexOf(b.code));
  const code = rows.some((r) => r.code === selectedCode)
    ? selectedCode
    : (rows[0]?.code ?? catalog[0]?.code ?? 'USD');
  const history = useQuery({
    queryKey: ['currency-history', code],
    queryFn: () => fetchCurrencyHistory(code),
    enabled: historyOpen && catalog.length > 0,
    staleTime: 6 * 60 * 60 * 1000,
    retry: 1,
  });
  useEffect(() => {
    try {
      sessionStorage.setItem(CONTEXT_KEY, JSON.stringify({ code, raw }));
    } catch {
      /* In-memory context remains usable. */
    }
  }, [code, raw]);
  const observed = d?.observations ?? [];
  const dated = history.data?.length
    ? history.data
    : observed
        .filter((p) => p.rates[code] != null)
        .map((p) => ({ date: p.date, value: p.rates[code] }));
  const latest = dated.at(-1)?.date;
  const cutoff = latest ? Date.parse(latest) - (period - 1) * 86_400_000 : 0;
  const points = dated.filter((p) => Date.parse(p.date) >= cutoff);
  const amount = amountInput(raw);
  const result = amount != null && rates[code] ? amount * rates[code] : null;
  const chosen = catalog.find((r) => r.code === code);
  const toggleWatch = (cc: string) => {
    const next = effectiveWatch.includes(cc)
      ? effectiveWatch.filter((c) => c !== cc)
      : [...effectiveWatch, cc];
    if (!next.length) return;
    setWatch(next);
    if (cc === code && !next.includes(cc))
      setCode(next.find((c) => catalog.some((r) => r.code === c)) ?? catalog[0]?.code ?? 'USD');
    try {
      localStorage.setItem(WATCH_KEY, JSON.stringify(next));
    } catch {
      /* Session still works. */
    }
  };
  return (
    <section className="renewal-card">
      <div className="renewal-section-head">
        <SectionLabel>ВАЛЮТИ</SectionLabel>
        <button
          type="button"
          onClick={() => setCatalogOpen((v) => !v)}
          className="renewal-link"
          aria-expanded={catalogOpen}
        >
          Налаштувати +
        </button>
      </div>
      {!catalog.length ? (
        <Ph>Курс валют недоступний</Ph>
      ) : (
        <>
          <p className="renewal-muted">
            Офіційний курс НБУ · {chosen?.asOf ?? date ?? 'дата недоступна'}
          </p>
          <div className="renewal-currency-grid">
            {rows.map((r) => {
              const change = d ? currencyChange(d, r.code, r.rate, r.asOf ?? date ?? '') : null;
              return (
                <button
                  key={r.code}
                  type="button"
                  className={`renewal-currency ${code === r.code ? 'is-selected' : ''}`}
                  aria-pressed={code === r.code}
                  onClick={() => {
                    setCode(r.code);
                  }}
                >
                  <span className="renewal-muted">
                    {SYMBOLS[r.code] ?? '¤'} {r.code}
                  </span>
                  <strong>
                    <UpdatedValue value={r.rate} identity={r.code}>
                      {r.rate.toLocaleString('uk-UA', { maximumFractionDigits: 4 })}
                    </UpdatedValue>
                  </strong>
                  <small>{r.name}</small>
                  {change && (
                    <span
                      className="currency-change"
                      data-direction={change.delta > 0 ? 'up' : change.delta < 0 ? 'down' : 'flat'}
                      title={`${change.delta > 0 ? '+' : ''}${change.delta.toLocaleString('uk-UA', { maximumFractionDigits: 4 })} ₴ ${change.label}`}
                    >
                      {change.delta > 0 ? '↗ +' : change.delta < 0 ? '↘ ' : '→ '}
                      {change.percent.toLocaleString('uk-UA', { maximumFractionDigits: 2 })}%{' '}
                      <small>{change.label}</small>
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          {catalogOpen && (
            <div className="renewal-inset">
              <label className="renewal-field">
                Знайти валюту
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Код або назва"
                />
              </label>
              <div className="renewal-catalog">
                {catalog
                  .filter((r) =>
                    `${r.code} ${r.name}`
                      .toLocaleLowerCase('uk-UA')
                      .includes(search.toLocaleLowerCase('uk-UA')),
                  )
                  .map((r) => (
                    <button
                      key={r.code}
                      type="button"
                      aria-pressed={effectiveWatch.includes(r.code)}
                      onClick={() => toggleWatch(r.code)}
                    >
                      <span>
                        <b>{r.code}</b> {r.name}
                      </span>
                      <span>{effectiveWatch.includes(r.code) ? '✓' : '+'}</span>
                    </button>
                  ))}
              </div>
              <Explanation>
                Усі {catalog.length} валют джерела. Пошук та вибір не витрачають запити до API.
                Останню відстежувану валюту залишаємо.
              </Explanation>
            </div>
          )}
          <div className="flex flex-wrap gap-2 mt-4">
            <button
              type="button"
              className="renewal-secondary"
              aria-expanded={historyOpen}
              aria-controls="currency-history"
              onClick={() => setHistoryOpen((v) => !v)}
            >
              {historyOpen ? 'Сховати графік' : `Історія ${code}`}
            </button>
            <button
              type="button"
              className="renewal-secondary"
              aria-expanded={converterOpen}
              aria-controls="currency-converter"
              onClick={() => setConverterOpen((v) => !v)}
            >
              {converterOpen ? 'Закрити конвертер' : 'Конвертер валют'}
            </button>
          </div>
          {historyOpen && (
            <div id="currency-history">
              {' '}
              <div className="renewal-section-head mt-4">
                <span className="text-sm font-semibold">{code} · історія курсу</span>
                <div className="renewal-segments">
                  {[7, 30, 90].map((n) => (
                    <button
                      key={n}
                      type="button"
                      aria-pressed={period === n}
                      onClick={() => setPeriod(n)}
                    >
                      {n}д
                    </button>
                  ))}
                </div>
              </div>
              <ObservationChart
                key={`${code}-${period}`}
                points={points}
                label={`Курс ${code}`}
                unit="₴"
              />
              {history.isFetching && (
                <p className="renewal-chart-note" role="status">
                  Оновлюю історію…
                </p>
              )}
              {history.error && (
                <p className="renewal-chart-note" role="status">
                  НБУ тимчасово недоступний.
                  {points.length ? ' Показані збережені значення.' : ' Спробуй пізніше.'}
                </p>
              )}
            </div>
          )}
          {converterOpen && (
            <div id="currency-converter" className="renewal-inset mt-4">
              <div className="renewal-section-head">
                <b className="text-sm">Конвертер</b>
                <span className="renewal-pill">{code} → UAH</span>
              </div>
              <div className="currency-converter-inputs" data-input-viewport-group>
                <label className="renewal-field">
                  Сума
                  <input
                    inputMode="decimal"
                    value={raw}
                    onChange={(e) => setRaw(e.target.value)}
                    maxLength={24}
                    placeholder="0"
                  />
                </label>
                <label className="renewal-field">
                  З
                  <select
                    value={code}
                    onChange={(e) => {
                      setCode(e.target.value);
                      if (!effectiveWatch.includes(e.target.value)) {
                        const next = [...effectiveWatch, e.target.value];
                        setWatch(next);
                        try {
                          localStorage.setItem(WATCH_KEY, JSON.stringify(next));
                        } catch {
                          /* Optional device storage. */
                        }
                      }
                    }}
                  >
                    {catalog.map((r) => (
                      <option key={r.code}>{r.code}</option>
                    ))}
                  </select>
                </label>
              </div>
              <span className="currency-result-label">Еквівалент у гривні</span>
              <output className="renewal-converted" aria-live="polite">
                {result != null && Number.isFinite(result)
                  ? `${result.toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₴`
                  : raw.trim()
                    ? 'Перевір суму'
                    : '—'}
              </output>
              <Explanation>
                Орієнтовна конвертація. Банківський курс і комісії можуть відрізнятися.
              </Explanation>
            </div>
          )}
        </>
      )}
    </section>
  );
}
