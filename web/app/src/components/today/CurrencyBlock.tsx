import { useState } from 'react';
import type { CurrencyData } from '../../api/briefing-schema.ts';
import { amountInput } from '../../lib/amountInput.ts';
import { ObservationChart } from '../charts/ObservationChart.tsx';
import { SectionLabel, Ph } from '../ui/primitives.tsx';

const DEFAULTS = ['USD', 'EUR', 'PLN', 'GBP'];
const WATCH_KEY = 'svitanok:currency-watch:v1';
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
  const [code, setCode] = useState('USD');
  const [period, setPeriod] = useState(30);
  const [raw, setRaw] = useState('100');
  const [from, setFrom] = useState('USD');
  const [to, setTo] = useState('UAH');
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
  const rows = catalog
    .filter((r) => watch.includes(r.code))
    .sort((a, b) => watch.indexOf(a.code) - watch.indexOf(b.code));
  const observed = d?.observations ?? [];
  const latest = observed.at(-1)?.date;
  const cutoff = latest ? Date.parse(latest) - (period - 1) * 86_400_000 : 0;
  const points = observed
    .filter((p) => Date.parse(p.date) >= cutoff && p.rates[code] != null)
    .map((p) => ({ date: p.date, value: p.rates[code] }));
  const amount = amountInput(raw);
  const result =
    amount != null && rates[from] && rates[to] ? (amount * rates[from]) / rates[to] : null;
  const chosen = catalog.find((r) => r.code === code);
  const toggleWatch = (cc: string) => {
    const next = watch.includes(cc) ? watch.filter((c) => c !== cc) : [...watch, cc];
    if (!next.length) return;
    setWatch(next);
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
            {rows.map((r) => (
              <button
                key={r.code}
                type="button"
                className={`renewal-currency ${code === r.code ? 'is-selected' : ''}`}
                aria-pressed={code === r.code}
                onClick={() => {
                  setCode(r.code);
                  setHistoryOpen(true);
                }}
              >
                <span className="renewal-muted">
                  {SYMBOLS[r.code] ?? '¤'} {r.code}
                </span>
                <strong>{r.rate.toLocaleString('uk-UA', { maximumFractionDigits: 4 })}</strong>
                <small>{r.name}</small>
              </button>
            ))}
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
                      aria-pressed={watch.includes(r.code)}
                      onClick={() => toggleWatch(r.code)}
                    >
                      <span>
                        <b>{r.code}</b> {r.name}
                      </span>
                      <span>{watch.includes(r.code) ? '✓' : '+'}</span>
                    </button>
                  ))}
              </div>
              <p className="renewal-muted">
                Усі {catalog.length} валют джерела. Пошук та вибір не витрачають запити до API.
                Останню відстежувану валюту залишаємо.
              </p>
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
                <span className="text-sm font-semibold">{code} · історія спостережень</span>
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
              {!observed.length && (
                <p className="renewal-muted">
                  Старий брифінг не містить дат історії. Нові спостереження накопичуватимуться після
                  оновлення модуля.
                </p>
              )}
            </div>
          )}
          {converterOpen && (
            <div id="currency-converter" className="renewal-inset mt-4">
              <div className="renewal-section-head">
                <b className="text-sm">Конвертер</b>
                <button
                  type="button"
                  className="renewal-link"
                  onClick={() => {
                    setFrom(to);
                    setTo(from);
                  }}
                >
                  Поміняти ↔
                </button>
              </div>
              <div className="renewal-form-grid">
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
                  <select value={from} onChange={(e) => setFrom(e.target.value)}>
                    {all.map((r) => (
                      <option key={r.code}>{r.code}</option>
                    ))}
                  </select>
                </label>
                <label className="renewal-field">
                  У
                  <select value={to} onChange={(e) => setTo(e.target.value)}>
                    {all.map((r) => (
                      <option key={r.code}>{r.code}</option>
                    ))}
                  </select>
                </label>
              </div>
              <output className="renewal-converted" aria-live="polite">
                {result != null && Number.isFinite(result)
                  ? `${result.toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${to}`
                  : 'Введи коректну суму'}
              </output>
              <p className="renewal-muted">
                Орієнтовна конвертація. Банківський курс і комісії можуть відрізнятися.
              </p>
            </div>
          )}
        </>
      )}
    </section>
  );
}
