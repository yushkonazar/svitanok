// Deterministic accounting primitives shared by the dashboard and D1 service.
// Money is integer minor units, shares are integer basis points (100% = 10000).
export const MAX_MINOR = 9_000_000_000_000;

/** @param {unknown} value @param {boolean} [signed] @returns {number} */
export function minor(value, signed = false) {
  if (
    !Number.isSafeInteger(value) ||
    Math.abs(/** @type {number} */ (value)) > MAX_MINOR ||
    (!signed && /** @type {number} */ (value) < 0)
  )
    throw new Error('Некоректна сума в копійках');
  return /** @type {number} */ (value);
}
/** Parse currency text exactly, without binary floating-point multiplication.
 * @param {string} raw @param {boolean} [signed] @returns {number} */
export function parseMoney(raw, signed = false) {
  const text = String(raw)
    .trim()
    .replace(/[\s\u00a0\u202f]/g, '')
    .replace(',', '.');
  const match = (signed ? /^(-?)(\d+)(?:\.(\d{1,2}))?$/ : /^()(\d+)(?:\.(\d{1,2}))?$/).exec(text);
  if (!match) throw new Error('Вкажи суму: гривні та до двох знаків копійок');
  const amount = BigInt(match[2] ?? '0') * 100n + BigInt((match[3] ?? '').padEnd(2, '0'));
  if (amount > BigInt(MAX_MINOR)) throw new Error('Сума завелика');
  return Number(amount) * (match[1] === '-' ? -1 : 1);
}
/** @param {number} amount @param {number} bps */
export function share(amount, bps) {
  minor(amount, true);
  if (!Number.isInteger(bps) || bps < 0 || bps > 10000)
    throw new Error('Частка має бути від 0 до 100%');
  const absolute = BigInt(Math.abs(amount)) * BigInt(bps);
  return Number((absolute + 5000n) / 10000n) * (amount < 0 ? -1 : 1);
}
/** @param {number[]} amounts */
export function sumMoney(amounts) {
  return minor(
    amounts.reduce((total, n) => total + minor(n, true), 0),
    true,
  );
}

const DATE_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Kyiv',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});
/** @param {number} ms */
export function kyivParts(ms) {
  if (!Number.isFinite(ms)) throw new Error('Некоректний час');
  /** @type {Record<string, string>} */ const p = {};
  for (const part of DATE_FORMAT.formatToParts(new Date(ms))) p[part.type] = part.value;
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) };
}
/** @param {string} date @param {number} days */
export function shiftDate(date, days) {
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(ms) ||
    new Date(ms).toISOString().slice(0, 10) !== date
  )
    throw new Error('Некоректна дата');
  return new Date(ms + days * 86400000).toISOString().slice(0, 10);
}
/** Calendar date → an unambiguous Kyiv daytime instant, DST-aware.
 * @param {string} date @param {number} [hour] */
export function kyivInstant(date, hour = 13) {
  shiftDate(date, 0);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error('Некоректна година');
  const target = Date.parse(`${date}T${String(hour).padStart(2, '0')}:00:00Z`);
  let guess = target;
  for (let i = 0; i < 4; i++) {
    const p = kyivParts(guess);
    const local = Date.parse(
      `${p.date}T${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}:00Z`,
    );
    const delta = target - local;
    if (!delta) return guess;
    guess += delta;
  }
  throw new Error('Цей місцевий час неоднозначний або не існує');
}
/** Taxi business week starts Monday 13:00 Kyiv, never an assumed 168 hours.
 * @param {number} ms */
export function taxiWeek(ms) {
  const p = kyivParts(ms);
  const weekday = (new Date(`${p.date}T00:00:00Z`).getUTCDay() + 6) % 7;
  let key = shiftDate(p.date, -weekday);
  if (weekday === 0 && p.hour < 13) key = shiftDate(key, -7);
  return { key, from: kyivInstant(key), to: kyivInstant(shiftDate(key, 7)) };
}
/** @typedef {{ id: string, effectiveAt: string, fareBps: number, commissionBps: number, fuelBps: number, thresholdMinor: number|null, bonusFareBps: number }} TaxiPolicy */
/** @typedef {{ id: string, at: string, policyId: string, netCashMinor: number, commissionMinor: number, fuelMinor: number, tipsMinor: number, directMinor: number, receivedCashMinor?: number, paidWorkMinor?: number, commissionReported?: boolean, cashReported?: boolean, note?: string }} TaxiEntry */
/** @param {TaxiPolicy} policy */
export function validatePolicy(policy) {
  for (const bps of [policy.fareBps, policy.commissionBps, policy.fuelBps, policy.bonusFareBps])
    share(0, bps);
  if (policy.thresholdMinor !== null) minor(policy.thresholdMinor);
  if (!policy.id || !Number.isFinite(Date.parse(policy.effectiveAt)))
    throw new Error('Некоректні умови таксі');
  return policy;
}
/** The confirmed bonus applies to the ENTIRE business week. Recompute from
 * entries, never append a second income when the threshold is crossed.
 * @param {TaxiEntry[]} entries @param {TaxiPolicy[]} policies @param {number} nowMs */
export function calculateTaxiWeek(entries, policies, nowMs) {
  const week = taxiWeek(nowMs);
  const selected = entries.filter(
    (e) => Date.parse(e.at) >= week.from && Date.parse(e.at) < week.to,
  );
  const gross = sumMoney(
    selected.map((e) => sumMoney([minor(e.netCashMinor), minor(e.commissionMinor)])),
  );
  const groups = policies.map(validatePolicy).flatMap((policy) => {
    const rows = selected.filter((e) => e.policyId === policy.id);
    if (!rows.length) return [];
    const groupGross = sumMoney(rows.map((e) => e.netCashMinor + e.commissionMinor));
    const commission = sumMoney(rows.map((e) => e.commissionMinor));
    const fuel = sumMoney(rows.map((e) => e.fuelMinor));
    const extras = sumMoney(rows.map((e) => e.tipsMinor + e.directMinor));
    const boosted = policy.thresholdMinor !== null && gross > policy.thresholdMinor;
    const fareBps = boosted ? policy.bonusFareBps : policy.fareBps;
    // Round shares once per policy/week, not each day: no accumulated penny drift.
    const earned = sumMoney([
      share(groupGross, fareBps),
      -share(commission, policy.commissionBps),
      -share(fuel, policy.fuelBps),
      extras,
    ]);
    return [
      {
        policyId: policy.id,
        grossMinor: groupGross,
        commissionMinor: commission,
        fuelMinor: fuel,
        extrasMinor: extras,
        fareBps,
        boosted,
        earnedMinor: earned,
      },
    ];
  });
  if (selected.some((e) => !policies.some((p) => p.id === e.policyId)))
    throw new Error('Немає історичних умов для запису таксі');
  return {
    ...week,
    grossMinor: gross,
    earnedMinor: sumMoney(groups.map((g) => g.earnedMinor)),
    groups,
    entries: selected,
  };
}
/** @param {string} nextDate @param {number} anchorDay @param {'month'|'year'} period */
export function nextPaymentDate(nextDate, anchorDay, period) {
  shiftDate(nextDate, 0);
  if (!Number.isInteger(anchorDay) || anchorDay < 1 || anchorDay > 31)
    throw new Error('День списання: від 1 до 31');
  const [year = 0, month = 1] = nextDate.split('-').map(Number);
  const first = new Date(
    Date.UTC(year + (period === 'year' ? 1 : 0), month - 1 + (period === 'month' ? 1 : 0), 1),
  );
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return `${first.toISOString().slice(0, 7)}-${String(Math.min(anchorDay, last)).padStart(2, '0')}`;
}
