import { matchesAnalytics } from './analytics.mjs';
import { isDebtKind, fixedDebtPayment, interestDebtPayment } from './payments.mjs';
import { kyivParts, shiftDate, sumMoney } from './planning.mjs';

/** @typedef {Awaited<ReturnType<typeof import('./workspace.mjs').readFinanceWorkspace>>} Workspace */
const DETAIL_LIMIT = 40;

/** Extra report evidence uses the same selection and ledger interpretation as analytics.
 * Amount alone never establishes that an expense is debt repayment or a duplicate.
 * @param {import('./analytics.mjs').AnalyticsSelection} selection
 * @param {Workspace['payments']} payments @param {Record<string,string>} aliases */
export function financeReviewAccumulator(selection, payments, aliases) {
  const contracts = new Map(payments.map((p) => [p.id, p]));
  /** @type {any[]} */ const exclusions = [];
  /** @type {any[]} */ const unverified = [];
  /** @type {any[]} */ const pending = [];
  /** @type {any[]} */ const unusual = [];
  let expenseMinor = 0,
    count = 0,
    pendingExpenseMinor = 0,
    pendingExpenseCount = 0,
    pendingCount = 0,
    ownerConfirmedCount = 0,
    principalMinor = 0,
    interestAndFeesMinor = 0,
    exclusionCount = 0,
    unverifiedCount = 0,
    unusualCount = 0,
    subscriptionExpenseMinor = 0,
    subscriptionCount = 0,
    subscriptionPendingMinor = 0;
  /** Keep the largest evidence rows, with exact totals and explicit detail limits.
   * @param {any[]} list @param {any} row */
  const retain = (list, row) => {
    list.push(row);
    list.sort(
      (a, b) =>
        Math.abs(b.amountMinor ?? 0) - Math.abs(a.amountMinor ?? 0) || a.id.localeCompare(b.id),
    );
    if (list.length > DETAIL_LIMIT) list.pop();
  };
  /** @param {import('./analytics.mjs').AnalyticsTransaction} tx */
  function consume(tx) {
    const date = kyivParts(Date.parse(tx.at)).date;
    if (
      date < selection.from ||
      date > selection.to ||
      (selection.period && Date.parse(tx.at) >= Date.parse(selection.period.to)) ||
      !matchesAnalytics(tx, selection, aliases)
    )
      return;
    const held = Boolean(tx.bankHold && !tx.bankVerifiedByOwner);
    const row = {
      id: tx.id,
      at: tx.at,
      description: tx.description,
      category: tx.category,
      amountMinor: tx.amountUah,
      originalAmountMinor: tx.amountMinor,
      currency: tx.currency,
      kind: tx.kind,
      bankHold: Boolean(tx.bankHold),
      ownerVerified: Boolean(tx.bankVerifiedByOwner),
      checkedAt: tx.bankCheckedAt ?? null,
      checkSource: tx.bankCheckSource ?? null,
      missingFromStatement: Boolean(tx.bankMissingFromStatement),
    };
    if (held) {
      pendingCount++;
      retain(pending, row);
    }
    const flags = (tx.flags ?? []).filter(
      (f) =>
        ['new_merchant', 'over_threshold', 'duplicate', 'foreign'].includes(f) &&
        !(f === 'duplicate' && tx.attention?.status === 'different'),
    );
    if (tx.bankAmountChanged) flags.push('bank_amount_changed');
    if (flags.length) {
      unusualCount++;
      retain(unusual, { ...row, flags });
    }
    if (tx.kind !== 'expense' || tx.amountUah == null || tx.amountUah >= 0) return;
    const value = -tx.amountUah;
    expenseMinor = sumMoney([expenseMinor, value]);
    count++;
    if (held) {
      pendingExpenseMinor = sumMoney([pendingExpenseMinor, value]);
      pendingExpenseCount++;
    }
    if (tx.bankHold && tx.bankVerifiedByOwner) ownerConfirmedCount++;
    const contract = tx.reference ? contracts.get(tx.reference) : null;
    if (contract?.kind === 'subscription' || tx.flags?.includes('subscription')) {
      subscriptionExpenseMinor = sumMoney([subscriptionExpenseMinor, value]);
      subscriptionCount++;
      if (held) subscriptionPendingMinor = sumMoney([subscriptionPendingMinor, value]);
    }
    const debt = contract && isDebtKind(contract.kind);
    const split =
      Number.isSafeInteger(tx.principalMinor) &&
      (tx.principalMinor ?? -1) >= 0 &&
      Number.isSafeInteger(tx.overpaymentMinor) &&
      (tx.overpaymentMinor ?? -1) >= 0 &&
      (tx.principalMinor ?? 0) + (tx.overpaymentMinor ?? 0) === value;
    // A linked, exact split proves the principal component, not prior recognition
    // of the original purchase. Fees remain in both comparison views.
    if (debt && split && !tx.bankAmountChanged) {
      principalMinor = sumMoney([principalMinor, tx.principalMinor ?? 0]);
      interestAndFeesMinor = sumMoney([interestAndFeesMinor, tx.overpaymentMinor ?? 0]);
      exclusionCount++;
      retain(exclusions, {
        ...row,
        contract: contract.name,
        principalMinor: tx.principalMinor,
        interestAndFeesMinor: tx.overpaymentMinor,
        reason: 'linked-debt-principal',
        originalPurchaseAccounting: 'not-established',
      });
    } else if (
      debt ||
      /погашенн|покупка частинами|оплата частинами|розстрочк|кредит/iu.test(
        `${tx.category} ${tx.description}`,
      )
    ) {
      unverifiedCount++;
      retain(unverified, {
        ...row,
        contract: contract?.name ?? null,
        excludedMinor: 0,
        reason: debt
          ? 'missing-or-changed-principal-split'
          : 'repayment-text-without-linked-contract',
        originalPurchaseAccounting: 'not-established',
      });
    }
  }
  return {
    consume,
    finish: () => ({
      outflows: {
        expenseMinor,
        count,
        confirmedExpenseMinor: expenseMinor - pendingExpenseMinor,
        confirmedExpenseCount: count - pendingExpenseCount,
        pendingExpenseMinor,
        pendingExpenseCount,
        ownerConfirmedCount,
        pendingIncludedInTotal: true,
      },
      repayment: {
        policy: 'linked-exact-debt-principal-only',
        principalMinor,
        interestAndFeesMinor,
        withoutPrincipalMinor: expenseMinor - principalMinor,
        exclusionCount,
        exclusions,
        exclusionsTruncated: exclusionCount > exclusions.length,
        unverifiedCount,
        unverified,
        unverifiedTruncated: unverifiedCount > unverified.length,
      },
      pending: {
        count: pendingCount,
        expenseMinor: pendingExpenseMinor,
        operations: pending,
        truncated: pendingCount > pending.length,
      },
      unusual: {
        count: unusualCount,
        operations: unusual,
        truncated: unusualCount > unusual.length,
      },
      subscriptions: {
        scope: 'linked-or-tagged-operations',
        expenseMinor: subscriptionExpenseMinor,
        count: subscriptionCount,
        pendingMinor: subscriptionPendingMinor,
        includedInExpenses: true,
      },
    }),
  };
}

/** Stock values are current cached snapshots with their own dates, not historical
 * balances reconstructed from a spending window. Foreign currencies stay separate.
 * @param {Workspace} f @param {number} nowMs @param {any} [nightly] */
export function financeReviewContext(f, nowMs, nightly = null) {
  const today = kyivParts(nowMs).date,
    to = shiftDate(today, 6);
  const uah = f.accounts.filter((a) => a.currency === 'UAH');
  const knownOwned = sumMoney(uah.map((a) => a.balanceMinor ?? 0));
  const goalReserve = sumMoney(
    f.goalMoves.filter((m) => m.movementKind !== 'external').map((m) => m.amountMinor),
  );
  const balancesComplete = uah.length > 0 && uah.every((a) => a.balanceMinor != null);
  const reserveComplete = !f.taxiWeeks.some((w) => !w.settled && !w.complete);
  const dues = f.payments
    .filter((p) => p.status === 'active' && p.nextDate <= to)
    .map((p) => {
      const calculated = interestDebtPayment(p) ?? fixedDebtPayment(p);
      const amount =
        p.interestMethod && !calculated ? null : (calculated?.amountMinor ?? p.amountMinor);
      return {
        id: p.id,
        name: p.name,
        kind: p.kind,
        date: p.nextDate,
        overdue: p.nextDate < today,
        amountMinor: amount,
        currency: 'UAH',
        amountSource: calculated
          ? 'debt-schedule'
          : amount == null
            ? 'unavailable'
            : 'stored-payment',
        recurrence: p.recurrence,
      };
    });
  const subscriptionDate = (/** @type {string|null} */ at) =>
    at && Number.isFinite(Date.parse(at)) ? kyivParts(Date.parse(at)).date : null;
  const detected = f.detectedSubscriptions
    .filter((s) => !subscriptionDate(s.nextAt) || (subscriptionDate(s.nextAt) ?? '') <= to)
    .map((s) => ({
      ...s,
      date: subscriptionDate(s.nextAt),
      overdue: Boolean(subscriptionDate(s.nextAt) && (subscriptionDate(s.nextAt) ?? '') < today),
      source: 'detected-pattern',
      possiblePaymentIds: f.payments
        .filter(
          (p) =>
            p.kind === 'subscription' &&
            p.status === 'active' &&
            p.name.trim().toLocaleLowerCase('uk-UA') ===
              s.merchant.trim().toLocaleLowerCase('uk-UA'),
        )
        .map((p) => p.id),
    }));
  const upcoming = dues.filter((p) => !p.overdue),
    overdue = dues.filter((p) => p.overdue);
  const manualComplete =
    f.bankSync?.phase === 'done' &&
    !f.bankSync.active &&
    !f.bankSync.balancesOnly &&
    (f.bankSync.statementAccounts?.length > 0 || f.bankSync.total > 1);
  const latest = [
    manualComplete
      ? {
          at: f.bankSync?.completedAt,
          scope: { source: 'manual-refresh', accountIds: f.bankSync?.statementAccounts ?? null },
        }
      : null,
    {
      at: nightly?.completedAt,
      scope: {
        source: 'nightly-reconcile',
        accountIds: 'all',
        from: nightly?.from ?? null,
        to: nightly?.to ?? null,
      },
    },
  ]
    .filter((row) => typeof row?.at === 'string' && Number.isFinite(Date.parse(row.at)))
    .sort((a, b) => Date.parse(a?.at) - Date.parse(b?.at))
    .at(-1);
  const completedAt = latest?.at ?? null;
  return {
    snapshotPolicy: 'current-cached-state-not-historical',
    asOf: f.generatedAt,
    balances: {
      currency: 'UAH',
      complete: balancesComplete,
      ownedMinor: balancesComplete ? knownOwned : null,
      knownOwnedMinor: knownOwned,
      accounts: f.accounts.map((a) => ({
        id: a.id,
        name: a.name,
        currency: a.currency,
        ownedMinor: a.balanceMinor,
        asOf: a.asOf,
        creditLimitMinor: 'creditLimitMinor' in a ? a.creditLimitMinor : null,
        availableMinor: 'availableMinor' in a ? a.availableMinor : a.balanceMinor,
      })),
    },
    reserves: {
      fleetMinor: f.reserveMinor,
      goalsMinor: goalReserve,
      complete: reserveComplete,
      alreadyPartOfOwnedFunds: true,
      availableAfterReservesMinor:
        balancesComplete && reserveComplete
          ? sumMoney([knownOwned, -goalReserve, -f.reserveMinor])
          : null,
    },
    upcoming: {
      from: today,
      to,
      scope: 'next-unpaid-per-contract',
      currency: 'UAH',
      count: upcoming.length,
      knownTotalMinor: sumMoney(upcoming.map((p) => p.amountMinor ?? 0)),
      complete: upcoming.every((p) => p.amountMinor != null),
      payments: upcoming.slice(0, DETAIL_LIMIT),
      truncated: upcoming.length > DETAIL_LIMIT,
    },
    overdue: {
      count: overdue.length,
      payments: overdue.slice(0, DETAIL_LIMIT),
      truncated: overdue.length > DETAIL_LIMIT,
    },
    detectedSubscriptions: {
      count: detected.length,
      items: detected.slice(0, DETAIL_LIMIT),
      truncated: f.detectedSubscriptionsTruncated || detected.length > DETAIL_LIMIT,
      combinedWithPayments: false,
      reason: 'detected-patterns-may-overlap-owner-contracts',
    },
    bankFreshness: {
      lastCompletedStatementRefreshAt: completedAt,
      lastStatementScope: latest?.scope ?? null,
      statementAgeHours: completedAt
        ? Math.max(0, Math.floor((nowMs - Date.parse(completedAt)) / 3_600_000))
        : null,
      refreshActive: Boolean(f.bankSync?.active),
      refreshPhase: f.bankSync?.phase ?? null,
      accounts: f.accounts
        .filter((a) => a.kind === 'mono')
        .map((a) => ({
          id: a.id,
          asOf: a.asOf,
          ageHours: a.asOf
            ? Math.max(0, Math.floor((nowMs - Date.parse(a.asOf)) / 3_600_000))
            : null,
        })),
    },
  };
}
