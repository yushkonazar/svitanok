/** @param {unknown} value */
function person(value) {
  const id = String(value ?? 'owner');
  if (!/^[\w-]{1,64}$/.test(id)) throw new Error('Обери учасника витрати.');
  return id;
}
/** Deterministic largest-remainder allocation; integer minor units always sum exactly.
 * @param {number} minor @param {{person_id:string,weight:number}[]} weights */
export function splitTripAmount(minor, weights) {
  const sorted = [...weights].sort((a, b) => a.person_id.localeCompare(b.person_id)),
    sum = sorted.reduce((s, r) => s + r.weight, 0);
  if (!sorted.length || sum <= 0) throw new Error('Укажи учасників розподілу.');
  const denominator = BigInt(sum),
    amount = BigInt(minor);
  const allocated = sorted.map((r) => ({
    ...r,
    minor: Number((amount * BigInt(r.weight)) / denominator),
    remainder: (amount * BigInt(r.weight)) % denominator,
  }));
  let left = minor - allocated.reduce((s, r) => s + r.minor, 0);
  for (const r of [...allocated].sort((a, b) =>
    a.remainder === b.remainder
      ? a.person_id.localeCompare(b.person_id)
      : a.remainder > b.remainder
        ? -1
        : 1,
  )) {
    if (left-- <= 0) break;
    r.minor++;
  }
  return allocated.map(({ person_id, minor }) => ({ person_id, minor }));
}
/** @param {any} args @param {number} minor @param {any[]} entries */
export function tripLedgerFields(args, minor, entries) {
  const kind = String(args.kind ?? 'expense');
  if (!['expense', 'refund', 'deposit', 'settlement'].includes(kind))
    throw new Error('Уточни вид фінансового запису.');
  const paid_by = person(args.paid_by);
  if (kind === 'settlement') {
    const paid_to = person(args.paid_to);
    if (paid_by === paid_to) throw new Error('Платник і одержувач мають відрізнятися.');
    return { kind, paid_by, paid_to, shares: [], refers_to: null };
  }
  if (kind === 'refund') {
    const original = entries.find(
      (e) => e.id === args.refers_to && ['expense', 'deposit'].includes(e.kind ?? 'expense'),
    );
    if (!original || original.currency !== String(args.currency ?? 'UAH').toUpperCase())
      throw new Error('Повернення має посилатися на витрату або заставу в тій самій валюті.');
    const refunded = entries
      .filter((e) => e.kind === 'refund' && e.refers_to === original.id)
      .reduce((s, e) => s + e.minor, 0);
    if (refunded + minor > original.minor)
      throw new Error('Повернення перевищує залишок початкової суми.');
    const weights = (original.shares ?? [])
      .filter((/** @type {any} */ s) => s.minor > 0)
      .map((/** @type {any} */ s) => ({ person_id: s.person_id, weight: s.minor }));
    const before = weights.length ? splitTripAmount(refunded, weights) : [],
      after = weights.length ? splitTripAmount(refunded + minor, weights) : [];
    const shares = after.map((s) => ({
      ...s,
      minor: s.minor - (before.find((b) => b.person_id === s.person_id)?.minor ?? 0),
    }));
    return {
      kind,
      paid_by: original.paid_by ?? 'owner',
      paid_to: null,
      refers_to: original.id,
      shares,
    };
  }
  /** @type {{person_id:string,minor:number}[]} */ let shares = [];
  if (args.split_with != null) {
    if (!Array.isArray(args.split_with) || !args.split_with.length || args.split_with.length > 100)
      throw new Error('Укажи від одного до 100 учасників розподілу.');
    const weights = args.split_with.map((/** @type {any} */ r) => ({
      person_id: person(typeof r === 'string' ? r : r.person_id),
      weight: Number(typeof r === 'string' ? 1 : (r.weight ?? 1)),
    }));
    if (
      new Set(weights.map((/** @type {any} */ r) => r.person_id)).size !== weights.length ||
      weights.some(
        (/** @type {any} */ r) => !Number.isInteger(r.weight) || r.weight < 1 || r.weight > 10000,
      )
    )
      throw new Error('Перевір учасників і частки розподілу.');
    shares = splitTripAmount(minor, weights);
  }
  return { kind, paid_by, paid_to: null, refers_to: null, shares };
}
/** Balances are accounting suggestions, never transfers. Missing splits stay explicitly unallocated.
 * @param {any[]} entries */
export function tripGroupSummary(entries) {
  /** @type {Record<string,Record<string,number>>} */ const balances = {};
  /** @type {Record<string,number>} */ const deposits = {};
  /** @type {Record<string,number>} */ const cash = {};
  /** @type {Record<string,number>} */ const unallocated = {};
  for (const e of entries) {
    const kind = e.kind ?? 'expense',
      currency = e.currency,
      sign = kind === 'refund' ? -1 : 1;
    const b = balances[currency] ?? (balances[currency] = {});
    if (kind === 'settlement') {
      b[e.paid_by] = (b[e.paid_by] ?? 0) + e.minor;
      b[e.paid_to] = (b[e.paid_to] ?? 0) - e.minor;
      continue;
    }
    cash[currency] = (cash[currency] ?? 0) + sign * e.minor;
    const original = kind === 'refund' ? entries.find((r) => r.id === e.refers_to) : e;
    if ((original?.kind ?? 'expense') === 'deposit')
      deposits[currency] = (deposits[currency] ?? 0) + sign * e.minor;
    if (!e.shares?.length) {
      unallocated[currency] = (unallocated[currency] ?? 0) + sign * e.minor;
      continue;
    }
    b[e.paid_by ?? 'owner'] = (b[e.paid_by ?? 'owner'] ?? 0) + sign * e.minor;
    for (const s of e.shares) b[s.person_id] = (b[s.person_id] ?? 0) - sign * s.minor;
  }
  const settlement = [];
  for (const [currency, b] of Object.entries(balances)) {
    const creditors = Object.entries(b)
        .filter(([, n]) => n > 0)
        .map(([id, n]) => ({ id, n })),
      debtors = Object.entries(b)
        .filter(([, n]) => n < 0)
        .map(([id, n]) => ({ id, n: -n }));
    for (const d of debtors)
      for (const c of creditors) {
        const amount = Math.min(d.n, c.n);
        if (amount > 0) {
          settlement.push({ from: d.id, to: c.id, minor: amount, currency });
          d.n -= amount;
          c.n -= amount;
        }
      }
  }
  return {
    balances_minor_by_currency: balances,
    cash_out_minor_by_currency: cash,
    pending_deposits_minor_by_currency: deposits,
    unallocated_minor_by_currency: unallocated,
    suggested_settlement: settlement,
  };
}
