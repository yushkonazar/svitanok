import { json } from './http-core.mjs';
import { checkOwnerRead } from './auth-core.mjs';
import { kyivParts, shiftDate } from './core/finance/planning.mjs';
/** @param {unknown} raw @param {string} code @param {string} from @param {string} to */
export function currencyPoints(raw, code, from, to) {
  if (!Array.isArray(raw)) return [];
  const dates = new Map();
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(r.exchangedate ?? '');
    const date = m ? `${m[3]}-${m[2]}-${m[1]}` : '';
    if (
      !date ||
      !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== date
    )
      continue;
    const value = r.rate_per_unit ?? (r.units > 0 ? r.rate / r.units : r.rate);
    if (r.cc === code && date >= from && date <= to && Number.isFinite(value) && value > 0)
      dates.set(date, { date, value });
  }
  return [...dates.values()].sort((a, b) => a.date.localeCompare(b.date));
}
/** @param {Request} request @param {Env} env */
export async function handleCurrencyHistory(request, env) {
  if (request.method !== 'GET') return json({ ok: false, error: 'method-not-allowed' }, 405);
  const auth = await checkOwnerRead(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);
  const code = new URL(request.url).searchParams.get('code') ?? '';
  if (!/^[A-Z]{3}$/.test(code) || ['XAU', 'XAG', 'XPT', 'XPD'].includes(code))
    return json({ ok: false, error: 'invalid-currency' }, 400);
  const to = kyivParts(Date.now()).date,
    from = shiftDate(to, -89),
    key = `currency:nbu-history:v1:${code}:${to}`;
  try {
    const cached = await env.BRIEFING.get(key, 'json');
    if (cached) return json(cached);
    const ctrl = new AbortController(),
      timer = setTimeout(() => ctrl.abort(), 12000);
    try {
      const url = new URL('https://bank.gov.ua/NBU_Exchange/exchange_site');
      for (const [k, v] of Object.entries({
        start: from.replaceAll('-', ''),
        end: to.replaceAll('-', ''),
        valcode: code,
        sort: 'exchangedate',
        order: 'asc',
        json: '',
      }))
        url.searchParams.set(k, v);
      const response = await fetch(url, { signal: ctrl.signal });
      if (!response.ok) throw new Error('nbu-unavailable');
      const points = currencyPoints(await response.json(), code, from, to);
      const result = { ok: true, code, from, to, points, source: 'НБУ' };
      if (points.length)
        await env.BRIEFING.put(key, JSON.stringify(result), { expirationTtl: 21600 });
      return json(result);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return json({ ok: false, error: 'Історія НБУ тимчасово недоступна' }, 503);
  }
}
