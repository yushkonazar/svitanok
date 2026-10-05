import {
  calculateTaxiWeek,
  kyivInstant,
  kyivParts,
  shiftDate,
  taxiWeek,
  sumMoney,
  share,
} from './planning.mjs';
/** @param {string} from @param {string} to @param {number} [nowMs] */
export function validateReportRange(from, to, nowMs = Date.now()) {
  const start = kyivInstant(from, 0),
    end = kyivInstant(shiftDate(to, 1), 0);
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 + 1;
  if (days < 1 || days > 366 || to > kyivParts(nowMs).date)
    throw new Error('Некоректний період: обери до 366 днів без майбутніх дат');
  return { from, to, start, end, days };
}
/** Only requested period is summarized; taxi thresholds still use the full business week.
 * @param {import('./reporting.mjs').ReportSource} state @param {string} from @param {string} to @param {number} [nowMs] */
export function buildFinanceReport(state, from, to, nowMs = Date.now()) {
  const range = validateReportRange(from, to, nowMs);
  const within = (/** @type {string} */ at) =>
    Date.parse(at) >= range.start && Date.parse(at) < range.end && Date.parse(at) <= nowMs;
  const txs = state.transactions.filter((t) => within(t.at));
  const otherIncome = sumMoney(
    txs.filter((t) => t.kind === 'income' && t.amountUah != null).map((t) => t.amountUah ?? 0),
  );
  const expense =
    -sumMoney(
      txs.filter((t) => t.kind === 'expense' && t.amountUah != null).map((t) => t.amountUah ?? 0),
    ) || 0;
  /** @type {Map<string, import('./planning.mjs').TaxiEntry[]>} */
  const entriesByWeek = new Map();
  for (const entry of state.taxiEntries) {
    const key = taxiWeek(Date.parse(entry.at)).key;
    const rows = entriesByWeek.get(key) ?? [];
    rows.push(entry);
    entriesByWeek.set(key, rows);
  }
  const keys = [...entriesByWeek.keys()].sort().reverse();
  /** @type {Map<string, {expenseMinor:number,incomeMinor:number}>} */
  const dailyTotals = new Map();
  for (const tx of txs) {
    if (!['expense', 'income'].includes(tx.kind) || tx.amountUah == null) continue;
    const date = kyivParts(Date.parse(tx.at)).date;
    const totals = dailyTotals.get(date) ?? { expenseMinor: 0, incomeMinor: 0 };
    if (tx.kind === 'expense') totals.expenseMinor = sumMoney([totals.expenseMinor, -tx.amountUah]);
    else totals.incomeMinor = sumMoney([totals.incomeMinor, tx.amountUah]);
    dailyTotals.set(date, totals);
  }
  let periodEarned = 0;
  const weeks = keys.flatMap((key) => {
    const w = calculateTaxiWeek(entriesByWeek.get(key) ?? [], state.policies, kyivInstant(key));
    if (w.to <= range.start || w.from >= range.end) return [];
    for (const group of w.groups) {
      const rows = w.entries
        .filter((e) => e.policyId === group.policyId)
        .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
      const policy = state.policies.find((p) => p.id === group.policyId);
      if (!policy) continue;
      // Allocate weekly rounding in chronological order. Adjacent date reports
      // add back to the complete week without creating extra earned kopecks.
      let gross = 0,
        commission = 0,
        fuel = 0,
        tips = 0,
        direct = 0,
        previous = 0;
      for (const row of rows) {
        gross += row.netCashMinor + row.commissionMinor;
        commission += row.commissionMinor;
        fuel += row.fuelMinor;
        tips += row.tipsMinor;
        direct += row.directMinor;
        const earned = sumMoney([
          share(gross, group.fareBps),
          -share(commission, policy.commissionBps),
          -share(fuel, policy.fuelBps),
          share(tips, policy.tipsBps ?? 5000),
          direct,
        ]);
        if (within(row.at)) periodEarned = sumMoney([periodEarned, earned - previous]);
        previous = earned;
      }
    }
    const held = sumMoney(
      w.entries.map((e) => (e.receivedCashMinor ?? 0) - (e.paidWorkMinor ?? 0)),
    );
    const settlement = state.settlements.find((s) => s.weekKey === key);
    const expected = settlement?.expectedMinor ?? w.earnedMinor - held;
    return [
      {
        key,
        grossMinor: w.grossMinor,
        netCashMinor: w.netCashMinor,
        commissionMinor: sumMoney(w.entries.map((e) => e.commissionMinor)),
        fuelMinor: sumMoney(w.entries.map((e) => e.fuelMinor)),
        tipsMinor: sumMoney(w.entries.map((e) => e.tipsMinor)),
        earnedMinor: w.earnedMinor,
        heldMinor: held,
        expectedMinor: expected,
        actualMinor: settlement?.amountMinor ?? null,
        differenceMinor: settlement ? settlement.amountMinor - expected : null,
        complete: w.entries.every(
          (e) => e.cashReported !== false && e.commissionReported !== false,
        ),
        closed: nowMs >= w.to,
      },
    ];
  });
  const difference = sumMoney(
    state.settlements
      .filter((s) => within(s.at))
      .map((s) => {
        const w = calculateTaxiWeek(
          entriesByWeek.get(s.weekKey) ?? [],
          state.policies,
          kyivInstant(s.weekKey),
        );
        const held = sumMoney(
          w.entries.map((e) => (e.receivedCashMinor ?? 0) - (e.paidWorkMinor ?? 0)),
        );
        return s.amountMinor - (s.expectedMinor ?? w.earnedMinor - held);
      }),
  );
  const categories = [...new Set(txs.filter((t) => t.kind === 'expense').map((t) => t.category))]
    .map((category) => {
      const rows = txs.filter(
        (t) => t.kind === 'expense' && t.category === category && t.amountUah != null,
      );
      return {
        category,
        amountMinor: -sumMoney(rows.map((t) => t.amountUah ?? 0)) || 0,
        count: rows.length,
      };
    })
    .sort((a, b) => b.amountMinor - a.amountMinor);
  return {
    ok: true,
    from,
    to,
    generatedAt: new Date(nowMs).toISOString(),
    otherIncomeMinor: otherIncome,
    expenseMinor: expense,
    taxiEarnedMinor: sumMoney([periodEarned]),
    settlementDifferenceMinor: difference,
    resultMinor: sumMoney([otherIncome, periodEarned, difference, -expense]),
    goalContributionsMinor: sumMoney(
      state.goalMoves.filter((m) => within(m.at)).map((m) => m.amountMinor),
    ),
    unclassifiedCount: txs.filter((t) => t.kind === 'unclassified').length,
    unknownCurrencyCount: txs.filter(
      (t) => ['expense', 'income'].includes(t.kind) && t.amountUah == null,
    ).length,
    bankRetentionDays: 720,
    categories,
    daily: Array.from({ length: range.days }, (_, i) => {
      const date = shiftDate(from, i);
      return { date, ...(dailyTotals.get(date) ?? { expenseMinor: 0, incomeMinor: 0 }) };
    }),
    taxiWeeks: weeks,
  };
}
