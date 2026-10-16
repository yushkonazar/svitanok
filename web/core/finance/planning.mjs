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
export function kyivInstant(date, hour = 13, minute = 0) {
  shiftDate(date, 0);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error('Некоректна година');
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) throw new Error('Некоректна хвилина');
  const target = Date.parse(
    `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`,
  );
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
/** Historical schedule epochs split work periods without changing settled history.
 * @param {number} ms @param {TaxiPolicy[]} [policies] */
export function taxiWeek(ms, policies = []) {
  const p = kyivParts(ms);
  const epochs = policies
    .filter((policy) => policy.periodStart)
    .sort((a, b) => Date.parse(a.effectiveAt) - Date.parse(b.effectiveAt));
  const epoch = epochs.filter((policy) => Date.parse(policy.effectiveAt) <= ms).at(-1);
  const next = epochs.find((policy) => Date.parse(policy.effectiveAt) > ms);
  const day = epoch?.weekDay ?? 0,
    hour = epoch?.weekHour ?? 13,
    minute = epoch?.weekMinute ?? 0;
  const weekday = (new Date(`${p.date}T00:00:00Z`).getUTCDay() + 6) % 7;
  let date = shiftDate(p.date, -((weekday - day + 7) % 7));
  if (ms < kyivInstant(date, hour, minute)) date = shiftDate(date, -7);
  const regularFrom = kyivInstant(date, hour, minute);
  const from = Math.max(regularFrom, epoch ? Date.parse(epoch.effectiveAt) : -Infinity);
  const to = Math.min(
    kyivInstant(shiftDate(date, 7), hour, minute),
    next ? Date.parse(next.effectiveAt) : Infinity,
  );
  return { key: from === regularFrom ? date : new Date(from).toISOString(), from, to };
}
/** Resolve a legacy date key or an exact, possibly same-day transition key.
 * @param {string} key @param {TaxiPolicy[]} [policies] */
export function taxiPeriodStart(key, policies = []) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(key)) {
    const schedules = [{ weekHour: 13, weekMinute: 0 }, ...policies.filter((p) => p.periodStart)];
    for (const schedule of schedules) {
      const candidate = kyivInstant(key, schedule.weekHour ?? 13, schedule.weekMinute ?? 0);
      if (taxiWeek(candidate, policies).key === key) return taxiWeek(candidate, policies).from;
    }
  } else {
    const candidate = Date.parse(key);
    if (
      Number.isFinite(candidate) &&
      new Date(candidate).toISOString() === key &&
      taxiWeek(candidate, policies).key === key
    )
      return candidate;
  }
  throw new Error('Робочий період не знайдено');
}
/** Explicit attribution preserves late-entered old-car records, including their original time.
 * @param {TaxiEntry} entry @param {TaxiPolicy[]} [policies] */
export function taxiEntryWeek(entry, policies = []) {
  return entry.periodKey
    ? taxiWeek(taxiPeriodStart(entry.periodKey, policies), policies)
    : taxiWeek(Date.parse(entry.at), policies);
}
/** @typedef {{ id: string, effectiveAt: string, fareBps: number, commissionBps: number, fuelBps: number, tipsBps?: number, thresholdMinor: number|null, bonusFareBps: number, periodStart?: boolean, weekDay?:number, weekHour?:number, weekMinute?:number, vehicleName?:string }} TaxiPolicy */
/** @typedef {{ id: string, at: string, policyId: string, periodKey?: string|null, netCashMinor: number, commissionMinor: number, fuelMinor: number, tipsMinor: number, directMinor: number, receivedCashMinor?: number, paidWorkMinor?: number, commissionReported?: boolean, cashReported?: boolean, note?: string }} TaxiEntry */
/** @param {TaxiPolicy} policy */
export function validatePolicy(policy) {
  for (const bps of [policy.fareBps, policy.commissionBps, policy.fuelBps, policy.bonusFareBps])
    share(0, bps);
  share(0, policy.tipsBps ?? 5000);
  if (policy.thresholdMinor !== null) minor(policy.thresholdMinor);
  if (!policy.id || !Number.isFinite(Date.parse(policy.effectiveAt)))
    throw new Error('Некоректні умови таксі');
  if (
    policy.periodStart &&
    (!Number.isInteger(policy.weekDay) ||
      (policy.weekDay ?? -1) < 0 ||
      (policy.weekDay ?? 7) > 6 ||
      !Number.isInteger(policy.weekHour) ||
      (policy.weekHour ?? -1) < 0 ||
      (policy.weekHour ?? 24) > 23 ||
      !Number.isInteger(policy.weekMinute) ||
      (policy.weekMinute ?? -1) < 0 ||
      (policy.weekMinute ?? 60) > 59 ||
      typeof policy.vehicleName !== 'string' ||
      !policy.vehicleName.trim() ||
      policy.vehicleName.length > 80)
  )
    throw new Error('Вкажи авто, день і час перезмінки');
  return policy;
}
/** Prepare an explicit car/schedule transition; never invent settlement or cash movements.
 * @param {TaxiEntry[]} entries @param {TaxiPolicy[]} policies @param {{weekKey:string}[]} settlements
 * @param {TaxiPolicy} policy @param {unknown} keepPreviousEntryIds */
export function prepareTaxiTransition(
  entries,
  policies,
  settlements,
  policy,
  keepPreviousEntryIds,
) {
  validatePolicy(policy);
  if (!policy.periodStart) throw new Error('Не вказано початок нового періоду');
  const boundary = Date.parse(policy.effectiveAt);
  if (policies.some((p) => Date.parse(p.effectiveAt) >= boundary))
    throw new Error('На цю або пізнішу дату вже є умови. Спочатку звір їх.');
  if (
    !Array.isArray(keepPreviousEntryIds) ||
    keepPreviousEntryIds.length > 5000 ||
    keepPreviousEntryIds.some((id) => typeof id !== 'string') ||
    new Set(keepPreviousEntryIds).size !== keepPreviousEntryIds.length
  )
    throw new Error('Перевір перелік записів попереднього авто');
  const previous = taxiWeek(boundary - 1, policies);
  const nextPolicies = [...policies, policy];
  for (const settlement of settlements) {
    const old = taxiWeek(taxiPeriodStart(settlement.weekKey, policies), policies);
    if (old.to > boundary)
      throw new Error('Перехід змінює вже розрахований період. Обери дату після його завершення.');
  }
  const keep = new Set(keepPreviousEntryIds);
  for (const id of keep) {
    const entry = entries.find((e) => e.id === id);
    if (!entry || taxiEntryWeek(entry, policies).key !== previous.key)
      throw new Error('Запис не належить попередньому авто цього періоду');
  }
  const updates = entries
    .filter((e) => Date.parse(e.at) >= boundary && taxiEntryWeek(e, policies).to > boundary)
    .map((entry) => ({
      id: entry.id,
      policyId: keep.has(entry.id) ? entry.policyId : policy.id,
      periodKey: keep.has(entry.id) ? previous.key : null,
    }));
  return {
    policy,
    previous: taxiWeek(boundary - 1, nextPolicies),
    next: taxiWeek(boundary, nextPolicies),
    updates,
  };
}
/** The confirmed bonus applies to the ENTIRE business week. Recompute from
 * entries, never append a second income when the threshold is crossed.
 * @param {TaxiEntry[]} entries @param {TaxiPolicy[]} policies @param {number} nowMs */
export function calculateTaxiWeek(entries, policies, nowMs) {
  const week = taxiWeek(nowMs, policies);
  const selected = entries.filter((e) =>
    e.periodKey
      ? e.periodKey === week.key
      : Date.parse(e.at) >= week.from && Date.parse(e.at) < week.to,
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
    const extras = sumMoney([
      share(sumMoney(rows.map((e) => e.tipsMinor)), policy.tipsBps ?? 5000),
      sumMoney(rows.map((e) => e.directMinor)),
    ]);
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
    netCashMinor: sumMoney(selected.map((e) => e.netCashMinor)),
    earnedMinor: sumMoney(groups.map((g) => g.earnedMinor)),
    groups,
    entries: selected,
  };
}
/** @param {string} nextDate @param {number} anchorDay @param {'day'|'week'|'month'|'year'} period */
export function nextPaymentDate(nextDate, anchorDay, period) {
  shiftDate(nextDate, 0);
  if (period === 'day' || period === 'week') return shiftDate(nextDate, period === 'day' ? 1 : 7);
  if (!['month', 'year'].includes(period)) throw new Error('Невідомий період платежу');
  if (!Number.isInteger(anchorDay) || anchorDay < 1 || anchorDay > 31)
    throw new Error('День списання: від 1 до 31');
  const [year = 0, month = 1] = nextDate.split('-').map(Number);
  const first = new Date(
    Date.UTC(year + (period === 'year' ? 1 : 0), month - 1 + (period === 'month' ? 1 : 0), 1),
  );
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return `${first.toISOString().slice(0, 7)}-${String(Math.min(anchorDay, last)).padStart(2, '0')}`;
}
