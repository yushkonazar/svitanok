import { financeCategories } from './categories.mjs';
import { bankPaymentAmount } from './payment-link.mjs';
import { fixedDebtPayment, isDebtKind, interestDebtPayment, interestQuote } from './payments.mjs';
import { NOT_TEST_SQL, readMonoAccounts } from './store.mjs';
import {
  minor,
  sumMoney,
  kyivParts,
  shiftDate,
  kyivInstant,
  calculateTaxiWeek,
  validatePolicy,
  taxiWeek,
  nextPaymentDate,
} from './planning.mjs';

export class FinanceConflict extends Error {}
export class FinanceValidation extends Error {}
/** @param {Env} env */
function database(env) {
  if (!env.DB) throw new Error('Finance DB unavailable');
  return env.DB;
}
/** @param {unknown} value @param {number} [max] */
function text(value, max = 120) {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new FinanceValidation('Вкажи коректний текст');
  return value.trim();
}
/** @param {unknown} value */
function date(value) {
  const result = text(value, 10);
  try {
    shiftDate(result, 0);
  } catch {
    throw new FinanceValidation('Некоректна дата');
  }
  return result;
}
/** @param {unknown} value */
function iso(value) {
  const result = text(value, 40);
  const ms = Date.parse(result);
  if (!Number.isFinite(ms)) throw new FinanceValidation('Некоректний час');
  return new Date(ms).toISOString();
}
/** @param {unknown} value @param {string[]} options */
function choice(value, options) {
  const result = text(value);
  if (!options.includes(result)) throw new FinanceValidation('Невідомий варіант');
  return result;
}
/** @param {unknown} value */
function jsonObject(value) {
  try {
    const x = JSON.parse(String(value ?? '{}'));
    return x && typeof x === 'object' && !Array.isArray(x) ? x : {};
  } catch {
    return {};
  }
}
/** @param {unknown} value @returns {string[]} */
function categoryArray(value) {
  try {
    const parsed = JSON.parse(String(value ?? '[]'));
    return Array.isArray(parsed) ? parsed.filter((c) => typeof c === 'string') : [];
  } catch {
    return [];
  }
}
/** @param {KvBlob} row */
function policyOf(row) {
  return {
    id: String(row.id),
    effectiveAt: String(row.effective_at),
    fareBps: Number(row.fare_bps),
    commissionBps: Number(row.commission_bps),
    fuelBps: Number(row.fuel_bps),
    tipsBps: Number(row.tips_bps ?? 5000),
    thresholdMinor: row.threshold_minor == null ? null : Number(row.threshold_minor),
    bonusFareBps: Number(row.bonus_fare_bps),
  };
}
/** @param {KvBlob} row */
function taxiOf(row) {
  return {
    id: String(row.id),
    at: String(row.at),
    policyId: String(row.policy_id),
    netCashMinor: Number(row.net_cash_minor),
    commissionMinor: Number(row.commission_minor),
    fuelMinor: Number(row.fuel_minor),
    tipsMinor: Number(row.tips_minor),
    directMinor: Number(row.direct_minor),
    receivedCashMinor: Number(row.received_cash_minor),
    paidWorkMinor: Number(row.paid_work_minor),
    commissionReported: Boolean(row.commission_reported),
    cashReported: Boolean(row.cash_reported),
    accountId: row.account_id == null ? null : String(row.account_id),
    note: String(row.note ?? ''),
    revision: Number(row.revision),
  };
}

/** Read bounded recent detail plus ALL-time balance aggregates. Never sum a
 * paginated transaction list as the account balance.
 * @param {Env} env @param {number} [nowMs] @param {{from:string,to:string}} [range] */
export async function readFinanceWorkspace(env, nowMs = Date.now(), range) {
  const db = database(env);
  const result = await db.batch([
    db.prepare('SELECT * FROM finance_settings WHERE id = ?').bind('owner'),
    db
      .prepare(
        `SELECT a.*, a.opening_minor + COALESCE((SELECT SUM(t.amount) FROM transactions t WHERE json_extract(t.raw_json, '$.financeAccount') = a.id AND t.at >= a.opening_at AND ${NOT_TEST_SQL}), 0) AS balance_minor FROM finance_accounts a ORDER BY created_at, id`,
      )
      .bind(),
    db.prepare('SELECT * FROM finance_taxi_policies ORDER BY effective_at').bind(),
    db.prepare('SELECT * FROM finance_taxi_entries ORDER BY at DESC LIMIT 5001').bind(),
    db.prepare('SELECT * FROM finance_taxi_settlements ORDER BY at DESC LIMIT 5001').bind(),
    db.prepare('SELECT * FROM finance_goals ORDER BY created_at').bind(),
    db.prepare('SELECT * FROM finance_goal_moves ORDER BY at DESC LIMIT 10001').bind(),
    db.prepare('SELECT * FROM finance_budgets ORDER BY category, period').bind(),
    db.prepare('SELECT * FROM finance_payments ORDER BY next_date').bind(),
    db
      .prepare(
        `SELECT id, at, amount, currency, amount_uah, category, description, raw_json, balance FROM transactions WHERE at >= ? AND at < ? AND ${NOT_TEST_SQL} ORDER BY at DESC LIMIT 20001`,
      )
      .bind(
        new Date(
          kyivInstant(range?.from ?? shiftDate(kyivParts(nowMs).date, -90), 0),
        ).toISOString(),
        range
          ? new Date(kyivInstant(shiftDate(range.to, 1), 0)).toISOString()
          : new Date(nowMs + 1).toISOString(),
      ),
    db
      .prepare('SELECT * FROM subscriptions WHERE status = ? ORDER BY next_at LIMIT 100')
      .bind('active'),
  ]);
  /** @type {(index: number) => KvBlob[]} */
  const rows = (index) => /** @type {KvBlob[]} */ (result[index]?.results ?? []);
  const settings = rows(0)[0];
  if (!settings) throw new Error('Finance migration required');
  const creditLimits = jsonObject(settings.credit_limits_json);
  // Refuse misleading incomplete arithmetic instead of silently truncating it.
  if (
    rows(3).length > 5000 ||
    rows(4).length > 5000 ||
    rows(6).length > 10000 ||
    rows(9).length > 20000
  )
    throw new Error('Finance detail window requires pagination');
  const policies = rows(2).map(policyOf);
  const taxiEntries = rows(3).map(taxiOf);
  const settlements = rows(4).map((r) => ({
    id: String(r.id),
    weekKey: String(r.week_key),
    amountMinor: Number(r.amount_minor),
    expectedMinor: r.expected_minor == null ? null : Number(r.expected_minor),
    note: String(r.note ?? ''),
    transactionId: r.bank_tx_id == null ? null : String(r.bank_tx_id),
    accountId: String(r.account_id),
    at: String(r.at),
  }));
  const weekKeys = [...new Set(taxiEntries.map((e) => taxiWeek(Date.parse(e.at)).key))]
    .sort()
    .reverse();
  const taxiWeeks = weekKeys.map((key) => {
    const week = calculateTaxiWeek(taxiEntries, policies, kyivInstant(key));
    const held = sumMoney(
      week.entries.map((e) => (e.receivedCashMinor ?? 0) - (e.paidWorkMinor ?? 0)),
    );
    const settlement = settlements.find((s) => s.weekKey === key);
    return {
      key,
      grossMinor: week.grossMinor,
      netCashMinor: week.netCashMinor,
      commissionMinor: sumMoney(week.entries.map((e) => e.commissionMinor)),
      fuelMinor: sumMoney(week.entries.map((e) => e.fuelMinor)),
      tipsMinor: sumMoney(week.entries.map((e) => e.tipsMinor)),
      actualSettlementMinor: settlement?.amountMinor ?? null,
      expectedSettlementMinor: settlement?.expectedMinor ?? week.earnedMinor - held,
      settlementDifferenceMinor: settlement
        ? settlement.amountMinor - (settlement.expectedMinor ?? week.earnedMinor - held)
        : null,
      settledAt: settlement?.at ?? null,
      earnedMinor: week.earnedMinor,
      heldMinor: held,
      settlementMinor: week.earnedMinor - held,
      complete: week.entries.every(
        (e) => e.commissionReported !== false && e.cashReported !== false,
      ),
      settled: Boolean(settlement),
      closed: nowMs >= week.to,
    };
  });
  const reserveMinor = sumMoney(
    taxiWeeks.filter((w) => !w.settled).map((w) => Math.max(0, -w.settlementMinor)),
  );
  const accounts = rows(1).map((r) => ({
    id: String(r.id),
    name: String(r.name),
    kind: String(r.kind),
    currency: String(r.currency),
    balanceMinor: Number(r.balance_minor),
    asOf: String(r.opening_at),
    monoId: r.mono_id == null ? null : String(r.mono_id),
    source: 'ledger',
  }));
  // Reads only cached metadata and our D1; never calls Monobank on Mini App open.
  for (const bank of await readMonoAccounts(env)) {
    const latest = await db
      .prepare(
        `SELECT balance, at FROM transactions WHERE json_extract(raw_json, '$.account') = ? AND balance IS NOT NULL AND ${NOT_TEST_SQL} ORDER BY at DESC LIMIT 1`,
      )
      .bind(bank.id)
      .first();
    const row = accounts.find((a) => a.monoId === bank.id);
    const accountId = row?.id ?? `mono:${bank.id}`;
    const override = creditLimits[accountId];
    const manualLimit = Number.isSafeInteger(override) && override >= 0;
    const creditLimit = manualLimit ? override : (bank.creditLimitMinor ?? null);
    const freshSnapshot =
      bank.asOf && (!latest?.at || Date.parse(bank.asOf) > Date.parse(String(latest.at)));
    const available = freshSnapshot
      ? (bank.balanceMinor ?? null)
      : latest?.balance == null
        ? (bank.balanceMinor ?? null)
        : Number(latest.balance);
    const account = {
      id: accountId,
      name: row?.name ?? `Monobank ${bank.maskedPan ?? bank.currency}`,
      kind: 'mono',
      currency: bank.currency,
      balanceMinor:
        available === null || creditLimit === null ? null : sumMoney([available, -creditLimit]),
      availableMinor: available,
      creditLimitMinor: creditLimit,
      creditLimitSource: manualLimit ? 'manual' : creditLimit === null ? 'unknown' : 'bank',
      asOf: freshSnapshot
        ? bank.asOf
        : latest?.at == null
          ? (bank.asOf ?? null)
          : String(latest.at),
      monoId: bank.id,
      source: latest ? 'monobank' : 'opening',
    };
    if (row) Object.assign(row, account);
    else accounts.push(/** @type {any} */ (account));
  }
  const transactions = rows(9).map((r) => {
    const raw = jsonObject(r.raw_json);
    const inferred =
      Number(r.amount) < 0
        ? r.category === 'перекази й готівка'
          ? 'unclassified'
          : 'expense'
        : 'unclassified';
    return {
      id: String(r.id),
      at: String(r.at),
      amountMinor: Number(r.amount),
      currency: String(r.currency),
      amountUah: r.amount_uah == null ? null : Number(r.amount_uah),
      category: String(r.category ?? 'інше'),
      description: String(r.description ?? ''),
      kind: String(raw.financeKind ?? inferred),
      accountId: raw.financeAccount ?? (raw.account ? `mono:${raw.account}` : null),
      bank: Boolean(raw.account),
      bankHold: Boolean(raw.hold),
      reference: raw.financeReference ?? null,
      personalTaxiType: raw.financePersonalTaxiType ?? null,
    };
  });
  /** @type {string[]} */ let custom = [];
  try {
    const parsed = JSON.parse(String(settings.categories_json));
    if (Array.isArray(parsed)) custom = parsed.filter((s) => typeof s === 'string');
  } catch {
    /* Empty user catalog. */
  }
  return {
    ok: true,
    version: Number(settings.version),
    generatedAt: new Date(nowMs).toISOString(),
    settings: {
      incomePeriod: String(settings.income_period),
      taxiVisible: Boolean(settings.taxi_visible),
      paymentReminders: Boolean(settings.payment_reminders),
      checkinReminders: Boolean(settings.checkin_reminders),
    },
    categories: financeCategories([
      ...custom,
      ...transactions.map((t) => t.category),
      ...rows(7).flatMap((b) => categoryArray(b.categories_json)),
      ...rows(8).map((p) => String(p.category)),
    ]),
    accounts,
    transactions,
    policies,
    taxiEntries,
    taxiWeeks,
    settlements,
    reserveMinor,
    forecast: {
      incomes: Array.isArray(jsonObject(settings.forecast_json).incomes)
        ? jsonObject(settings.forecast_json).incomes
        : [],
    },
    goals: rows(5).map((r) => ({
      id: String(r.id),
      name: String(r.name),
      targetMinor: Number(r.target_minor),
      deadline: r.deadline == null ? null : String(r.deadline),
      status: String(r.status),
      planAmountMinor: r.plan_amount_minor == null ? null : Number(r.plan_amount_minor),
      planPeriod: r.plan_period == null ? null : String(r.plan_period),
    })),
    goalMoves: rows(6).map((r) => ({
      id: String(r.id),
      goalId: String(r.goal_id),
      accountId: String(r.account_id),
      amountMinor: Number(r.amount_minor),
      movementKind: String(r.movement_kind ?? 'reserve'),
      transactionId: r.bank_tx_id == null ? null : String(r.bank_tx_id),
      at: String(r.at),
    })),
    budgets: rows(7).map((r) => ({
      id: String(r.id),
      category: String(r.category),
      categories: /** @type {string[]} */ (JSON.parse(String(r.categories_json ?? '[]'))),
      purpose: String(r.purpose),
      period: String(r.period),
      limitMinor: r.limit_minor == null ? null : Number(r.limit_minor),
      shareBps: r.share_bps == null ? null : Number(r.share_bps),
      incomeBaseMinor: r.income_base_minor == null ? null : Number(r.income_base_minor),
      parentId: r.parent_id == null ? null : String(r.parent_id),
      goalId: r.goal_id == null ? null : String(r.goal_id),
      sortOrder: Number(r.sort_order ?? 0),
      forecastEnabled: Boolean(r.forecast_enabled),
      templateRole: r.template_role == null ? null : String(r.template_role),
    })),
    payments: rows(8).map((r) => ({
      id: String(r.id),
      name: String(r.name),
      kind: String(r.kind),
      amountMinor: Number(r.amount_minor),
      remainingMinor: r.remaining_minor == null ? null : Number(r.remaining_minor),
      installmentsLeft: r.installments_left == null ? null : Number(r.installments_left),
      nextDate: String(r.next_date),
      anchorDay: Number(r.anchor_day),
      recurrence: String(r.interval_period ?? r.recurrence),
      category: String(r.category),
      remindDays: Number(r.remind_days),
      status: String(r.status),
      totalMinor: r.total_minor == null ? null : Number(r.total_minor),
      rateBps: Number(r.rate_bps ?? 0),
      feeMinor: Number(r.fee_minor ?? 0),
      lender: String(r.lender ?? ''),
      note: String(r.note ?? ''),
      overpaymentTotalMinor:
        r.overpayment_total_minor == null ? null : Number(r.overpayment_total_minor),
      overpaymentRemainingMinor:
        r.overpayment_remaining_minor == null ? null : Number(r.overpayment_remaining_minor),
      overpaymentPaidMinor: Number(r.overpayment_paid_minor ?? 0),
      interestMethod: r.interest_method == null ? null : String(r.interest_method),
      termMonths: r.term_months == null ? null : Number(r.term_months),
    })),
    detectedSubscriptions: rows(10).map((r) => ({
      id: String(r.id),
      merchant: String(r.merchant),
      amountMinor: Number(r.amount ?? 0),
      currency: String(r.currency ?? 'UAH'),
      nextAt: r.next_at == null ? null : String(r.next_at),
    })),
  };
}

/** All commands carry a stable UUID and expected version. Claim, ledger
 * changes and version increment run in a single D1 transaction.
 * @param {Env} env @param {KvBlob} command @param {number} [nowMs] */
export async function executeFinanceCommand(env, command, nowMs = Date.now()) {
  const db = database(env);
  const id = text(command.id, 80);
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(id)) throw new FinanceValidation('Некоректний ID операції');
  const type = text(command.type, 40);
  const payload = command.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    throw new FinanceValidation('Некоректні дані операції');
  const version = command.version;
  if (!Number.isSafeInteger(version) || version < 0)
    throw new FinanceValidation('Некоректна версія');
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify({ id, type, payload, version })),
  );
  const hash = Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, '0')).join('');
  const existing = await db
    .prepare('SELECT payload_hash FROM finance_commands WHERE id = ?')
    .bind(id)
    .first();
  if (existing) {
    if (existing.payload_hash !== hash)
      throw new FinanceConflict('ID вже використано для іншої операції');
    return { ok: true, duplicate: true };
  }
  const state = await readFinanceWorkspace(env, nowMs);
  if (state.version !== version)
    throw new FinanceConflict('Дані змінилися. Онови екран і повтори дію.');
  const now = new Date(nowMs).toISOString();
  const guard =
    'EXISTS (SELECT 1 FROM finance_commands WHERE id = ? AND payload_hash = ? AND at = ?)';
  /** @type {D1PreparedStatement[]} */ const statements = [
    db
      .prepare(
        `INSERT INTO finance_commands(id,payload_hash,at) SELECT ?,?,? WHERE (SELECT version FROM finance_settings WHERE id = 'owner') = ? ON CONFLICT(id) DO NOTHING`,
      )
      .bind(id, hash, now, version),
  ];
  /** @param {string} table @param {KvBlob} values */
  const insert = (table, values) => {
    const columns = Object.keys(values);
    statements.push(
      db
        .prepare(
          `INSERT INTO ${table} (${columns.join(',')}) SELECT ${columns.map(() => '?').join(',')} WHERE ${guard} ON CONFLICT DO NOTHING`,
        )
        .bind(...Object.values(values), id, hash, now),
    );
  };
  /** @param {string} sql @param {unknown[]} values */
  const update = (sql, values) =>
    statements.push(db.prepare(`${sql} AND ${guard}`).bind(...values, id, hash, now));
  /** @param {unknown} accountId @param {boolean} [manualOnly] */
  const account = (accountId, manualOnly = false) => {
    const found = state.accounts.find((a) => a.id === accountId);
    if (!found || found.currency !== 'UAH' || (manualOnly && found.kind === 'mono'))
      throw new FinanceValidation('Обери гривневий рахунок ручного обліку');
    if (found.kind === 'mono') {
      if (found.balanceMinor == null)
        throw new FinanceValidation('Для цього рахунку ще немає підтвердженого залишку');
      insert('finance_accounts', {
        id: found.id,
        name: found.name,
        kind: 'mono',
        currency: found.currency,
        opening_minor: found.balanceMinor,
        opening_at: now,
        mono_id: found.monoId,
        created_at: now,
      });
    }
    return found;
  };
  /** @param {string} txId @param {number} amount @param {string} kind @param {string} accountId @param {string} category @param {string} description @param {string} at @param {string|null} [reference] */
  const ledger = (txId, amount, kind, accountId, category, description, at, reference = null) =>
    insert('transactions', {
      id: txId,
      at,
      amount: minor(amount, true),
      currency: 'UAH',
      amount_uah: amount,
      description,
      category,
      flags_json: '[]',
      raw_json: JSON.stringify({
        financeKind: kind,
        financeAccount: accountId,
        financeReference: reference,
      }),
    });

  if (type === 'credit-limit') {
    const found = state.accounts.find((a) => a.id === payload.accountId && a.kind === 'mono');
    if (!found) throw new FinanceValidation('Обери підключену картку Monobank');
    const row = await db
      .prepare('SELECT credit_limits_json FROM finance_settings WHERE id = ?')
      .bind('owner')
      .first();
    const limits = jsonObject(row?.credit_limits_json);
    if (payload.creditLimitMinor === null) delete limits[found.id];
    else limits[found.id] = minor(payload.creditLimitMinor);
    update('UPDATE finance_settings SET credit_limits_json = ?, updated_at = ? WHERE id = ?', [
      JSON.stringify(limits),
      now,
      'owner',
    ]);
  } else if (type === 'account-balance') {
    const src = account(payload.accountId, true);
    if (src.balanceMinor === null) throw new FinanceValidation('Немає залишку рахунку');
    const target = minor(payload.balanceMinor, true);
    ledger(
      `balance:${id}`,
      sumMoney([target, -src.balanceMinor]),
      'adjustment',
      src.id,
      'корекція',
      'Уточнення поточного залишку',
      now,
    );
  } else if (type === 'taxi-personal-income') {
    const src = account(payload.accountId, true);
    if (src.kind !== 'cash') throw new FinanceValidation('Обери рахунок готівки');
    const personalType = choice(payload.personalType, ['direct', 'change', 'cash-tip', 'other']);
    const amount = minor(payload.amountMinor);
    if (!amount) throw new FinanceValidation('Сума має бути більшою за нуль');
    const at = iso(payload.at ?? now);
    if (Date.parse(at) > nowMs + 60000 || Date.parse(at) < Date.parse(src.asOf))
      throw new FinanceValidation('Перевір дату надходження');
    /** @type {Record<string, string>} */
    const descriptions = {
      direct: 'Замовлення поза застосунком',
      change: 'Клієнт не забрав решту',
      'cash-tip': 'Готівкові чайові',
      other: 'Інший особистий дохід таксі',
    };
    insert('transactions', {
      id: `personal-taxi:${id}`,
      at,
      amount,
      amount_uah: amount,
      currency: 'UAH',
      category: 'таксі · особисте',
      description: descriptions[personalType],
      flags_json: '[]',
      raw_json: JSON.stringify({
        financeKind: 'income',
        financeAccount: src.id,
        financePersonalTaxiType: personalType,
      }),
    });
  } else if (type === 'transaction') {
    const kind = choice(payload.kind, ['expense', 'income', 'transfer', 'adjustment']);
    const src = account(payload.accountId, true);
    const amount = minor(payload.amountMinor, kind === 'adjustment');
    if (!amount && kind !== 'adjustment')
      throw new FinanceValidation('Сума має бути більшою за нуль');
    const at = iso(payload.at ?? now);
    if (Date.parse(at) > nowMs + 60000 || Date.parse(at) < Date.parse(src.asOf))
      throw new FinanceValidation('Операція має бути після початкового залишку й не в майбутньому');
    const category =
      kind === 'expense' || kind === 'income'
        ? text(payload.category)
        : kind === 'transfer'
          ? 'перекази й готівка'
          : 'корекція';
    const description = text(payload.description ?? category, 300);
    if (kind === 'transfer') {
      const target = account(payload.toAccountId, true);
      if (target.id === src.id) throw new FinanceValidation('Обери інший рахунок');
      ledger(`manual:${id}:from`, -amount, kind, src.id, category, description, at, id);
      ledger(`manual:${id}:to`, amount, kind, target.id, category, description, at, id);
    } else
      ledger(
        `manual:${id}`,
        kind === 'expense' ? -amount : amount,
        kind,
        src.id,
        category,
        description,
        at,
      );
  } else if (type === 'bank-transfer') {
    const bankTx = state.transactions.find((t) => t.id === payload.transactionId);
    if (
      !bankTx ||
      !bankTx.bank ||
      bankTx.bankHold ||
      bankTx.reference ||
      bankTx.currency !== 'UAH' ||
      !bankTx.amountMinor ||
      !['income', 'expense', 'unclassified', 'transfer'].includes(bankTx.kind)
    )
      throw new FinanceValidation('Обери завершений непов’язаний переказ Monobank');
    const counterpart = account(payload.accountId, true);
    if (
      counterpart.id === bankTx.accountId ||
      Date.parse(bankTx.at) < Date.parse(counterpart.asOf) ||
      Date.parse(bankTx.at) > nowMs
    )
      throw new FinanceValidation('Перевір другий рахунок і дату переказу');
    const previousLegId = payload.manualTransactionId;
    if (previousLegId) {
      const leg = state.transactions.find((t) => t.id === previousLegId);
      if (
        !leg ||
        leg.bank ||
        leg.reference ||
        leg.accountId !== counterpart.id ||
        leg.kind !== 'transfer' ||
        leg.amountMinor !== -bankTx.amountMinor
      )
        throw new FinanceValidation('Ручна сторона переказу не відповідає операції банку');
      update("UPDATE transactions SET raw_json=json_patch(COALESCE(raw_json,'{}'),?) WHERE id=?", [
        JSON.stringify({ financeReference: id }),
        leg.id,
      ]);
    } else
      ledger(
        `bank-transfer:${id}`,
        -bankTx.amountMinor,
        'transfer',
        counterpart.id,
        'перекази й готівка',
        'Друга сторона власного переказу Monobank',
        bankTx.at,
        id,
      );
    update(
      "UPDATE transactions SET category=?,raw_json=json_patch(COALESCE(raw_json,'{}'),?) WHERE id=?",
      [
        'перекази й готівка',
        JSON.stringify({ financeKind: 'transfer', financeReference: id }),
        bankTx.id,
      ],
    );
  } else if (type === 'transaction-edit') {
    const transaction = state.transactions.find((t) => t.id === payload.transactionId);
    if (
      !transaction ||
      transaction.bank ||
      transaction.reference ||
      !['expense', 'income'].includes(transaction.kind)
    )
      throw new FinanceValidation('Можна редагувати лише власні ручні витрати й надходження');
    account(transaction.accountId, true);
    const amount = minor(payload.amountMinor),
      kind = choice(payload.kind, ['expense', 'income']);
    if (!amount) throw new FinanceValidation('Сума має бути більшою за нуль');
    const category = text(payload.category),
      description = text(payload.description ?? category, 300);
    const stored = await db
      .prepare('SELECT raw_json FROM transactions WHERE id = ?')
      .bind(transaction.id)
      .first();
    const raw = jsonObject(stored?.raw_json);
    const revisions = Array.isArray(raw.financeRevisions) ? raw.financeRevisions : [];
    revisions.push({
      commandId: id,
      at: now,
      amountMinor: transaction.amountMinor,
      kind: transaction.kind,
      category: transaction.category,
      description: transaction.description,
    });
    update(
      'UPDATE transactions SET amount = ?, amount_uah = ?, category = ?, description = ?, raw_json = ? WHERE id = ?',
      [
        kind === 'expense' ? -amount : amount,
        kind === 'expense' ? -amount : amount,
        category,
        description,
        JSON.stringify({ ...raw, financeKind: kind, financeRevisions: revisions }),
        transaction.id,
      ],
    );
  } else if (type === 'account') {
    insert('finance_accounts', {
      id: `account:${id}`,
      name: text(payload.name),
      kind: choice(payload.kind, ['cash', 'bank']),
      currency: 'UAH',
      opening_minor: minor(payload.openingMinor, true),
      opening_at: now,
      created_at: now,
    });
  } else if (type === 'settings') {
    const incomePeriod = choice(payload.incomePeriod, ['week', 'month']);
    if (typeof payload.taxiVisible !== 'boolean')
      throw new FinanceValidation('Некоректний перемикач таксі');
    if (!Array.isArray(payload.categories) || payload.categories.length > 100)
      throw new FinanceValidation('Некоректний список категорій');
    const categories = [
      ...new Set(payload.categories.map((/** @type {unknown} */ c) => text(c, 80))),
    ];
    const paymentReminders = payload.paymentReminders ?? state.settings.paymentReminders;
    const checkinReminders = payload.checkinReminders ?? state.settings.checkinReminders;
    if (typeof paymentReminders !== 'boolean' || typeof checkinReminders !== 'boolean')
      throw new FinanceValidation('Некоректний перемикач нагадувань');
    update(
      'UPDATE finance_settings SET income_period = ?, taxi_visible = ?, payment_reminders = ?, checkin_reminders = ?, categories_json = ?, updated_at = ? WHERE id = ?',
      [
        incomePeriod,
        Number(payload.taxiVisible),
        Number(paymentReminders),
        Number(checkinReminders),
        JSON.stringify(categories),
        now,
        'owner',
      ],
    );
  } else if (type === 'taxi-policy') {
    const effectiveAt = iso(payload.effectiveAt);
    if (Date.parse(effectiveAt) < nowMs - 60000)
      throw new FinanceValidation('Нові умови можуть діяти відтепер або з майбутньої дати');
    if (state.policies.some((p) => p.effectiveAt === effectiveAt))
      throw new FinanceValidation('На цей момент вже є умови');
    const policy = validatePolicy({
      id,
      effectiveAt,
      fareBps: payload.fareBps,
      commissionBps: payload.commissionBps,
      fuelBps: payload.fuelBps,
      tipsBps: payload.tipsBps ?? 5000,
      thresholdMinor: payload.thresholdMinor,
      bonusFareBps: payload.bonusFareBps,
    });
    insert('finance_taxi_policies', {
      id,
      effective_at: effectiveAt,
      fare_bps: policy.fareBps,
      commission_bps: policy.commissionBps,
      fuel_bps: policy.fuelBps,
      tips_bps: policy.tipsBps,
      threshold_minor: policy.thresholdMinor,
      bonus_fare_bps: policy.bonusFareBps,
      created_at: now,
    });
  } else if (type === 'taxi-entry' || type === 'taxi-edit') {
    const previous =
      type === 'taxi-edit' ? state.taxiEntries.find((e) => e.id === payload.entryId) : null;
    if (type === 'taxi-edit' && !previous) throw new FinanceValidation('Запис зміни не знайдено');
    if (
      previous &&
      state.settlements.some((s) => s.weekKey === taxiWeek(Date.parse(previous.at)).key)
    )
      throw new FinanceValidation('Розраховану зміну вже не можна змінити');
    const at = iso(payload.at);
    if (Date.parse(at) > nowMs + 60000)
      throw new FinanceValidation('Не можна записати майбутню зміну');
    const policy = state.policies.filter((p) => p.effectiveAt <= at).at(-1);
    if (!policy) throw new FinanceValidation('Немає умов для дати зміни');
    if (state.settlements.some((s) => s.weekKey === taxiWeek(Date.parse(at)).key))
      throw new FinanceValidation('Цей тиждень уже розраховано з парком');
    const src = account(payload.accountId, true);
    if (Date.parse(at) < Date.parse(src.asOf))
      throw new FinanceValidation('Дата зміни має бути після початкового залишку рахунку');
    const received = minor(payload.receivedCashMinor ?? 0),
      paid = minor(payload.paidWorkMinor ?? 0);
    const values = {
      net_cash_minor: minor(payload.netCashMinor ?? 0),
      commission_minor: minor(payload.commissionMinor ?? 0),
      fuel_minor: minor(payload.fuelMinor ?? 0),
      tips_minor: minor(payload.tipsMinor ?? 0),
      direct_minor: minor(payload.directMinor ?? 0),
    };
    if (!Object.values(values).some((n) => n > 0) && !received && !paid)
      throw new FinanceValidation('Вкажи хоча б одне значення зміни');
    const entryValues = {
      at,
      policy_id: policy.id,
      ...values,
      commission_reported: Number(!values.net_cash_minor || payload.commissionMinor != null),
      cash_reported: Number(
        (!values.net_cash_minor && !values.tips_minor && !values.direct_minor) ||
          payload.receivedCashMinor != null,
      ),
      received_cash_minor: received,
      paid_work_minor: paid,
      account_id: src.id,
      note: typeof payload.note === 'string' ? payload.note.slice(0, 500) : '',
      updated_at: now,
    };
    if (previous) {
      const columns = Object.keys(entryValues);
      update(
        `UPDATE finance_taxi_entries SET ${columns.map((c) => `${c} = ?`).join(',')}, revision = revision + 1 WHERE id = ?`,
        [...Object.values(entryValues), previous.id],
      );
      const oldCash = (previous.receivedCashMinor ?? 0) - (previous.paidWorkMinor ?? 0);
      if (oldCash && previous.accountId)
        ledger(
          `taxi-correction:${id}:reverse`,
          -oldCash,
          'taxi-custody',
          previous.accountId,
          'таксі',
          'Скасування попередньої готівки зміни',
          now,
          previous.id,
        );
    } else insert('finance_taxi_entries', { id, ...entryValues, created_at: now });
    if (received || paid)
      ledger(
        `taxi-cash:${id}`,
        received - paid,
        'taxi-custody',
        src.id,
        'таксі',
        previous ? 'Уточнена готівка зміни таксі' : 'Готівка зміни таксі після робочих витрат',
        previous ? now : at,
        previous?.id ?? id,
      );
  } else if (type === 'taxi-settle') {
    const key = date(payload.weekKey);
    const week = state.taxiWeeks.find((w) => w.key === key);
    if (!week || !week.closed || week.settled || !week.complete)
      throw new FinanceValidation('Тиждень ще відкритий, неповний або вже розрахований');
    const actual =
      payload.amountMinor == null ? week.settlementMinor : minor(payload.amountMinor, true);
    const note = typeof payload.note === 'string' ? payload.note.trim().slice(0, 500) : '';
    const bankTx = payload.transactionId
      ? state.transactions.find((t) => t.id === payload.transactionId)
      : null;
    if (
      payload.transactionId &&
      (!bankTx ||
        !bankTx.bank ||
        bankTx.bankHold ||
        bankTx.reference ||
        bankTx.currency !== 'UAH' ||
        bankTx.amountMinor !== actual ||
        !['expense', 'income', 'unclassified', 'taxi-settlement'].includes(bankTx.kind) ||
        Date.parse(bankTx.at) < taxiWeek(kyivInstant(key)).to ||
        Date.parse(bankTx.at) > nowMs)
    )
      throw new FinanceValidation(
        'Обери завершену непов’язану банківську операцію після закриття тижня з точною сумою розрахунку',
      );
    const src = account(bankTx ? bankTx.accountId : payload.accountId, !bankTx);
    insert('finance_taxi_settlements', {
      id,
      week_key: key,
      amount_minor: actual,
      expected_minor: week.settlementMinor,
      note,
      account_id: src.id,
      at: now,
      bank_tx_id: bankTx?.id ?? null,
    });
    if (bankTx)
      update(
        "UPDATE transactions SET category = ?, raw_json = json_patch(COALESCE(raw_json, '{}'), ?) WHERE id = ?",
        [
          'таксі',
          JSON.stringify({ financeKind: 'taxi-settlement', financeReference: key }),
          bankTx.id,
        ],
      );
    else if (actual)
      ledger(
        `taxi-settlement:${id}`,
        actual,
        'taxi-settlement',
        src.id,
        'таксі',
        `Розрахунок із парком за ${key}`,
        now,
        key,
      );
  } else if (type === 'taxi-settlement-edit') {
    const key = date(payload.weekKey);
    const previous = state.settlements.find((s) => s.weekKey === key);
    const week = state.taxiWeeks.find((w) => w.key === key);
    if (!previous || !week) throw new FinanceValidation('Розрахунок не знайдений');
    if (previous.transactionId)
      throw new FinanceValidation(
        'Банківський розрахунок уже містить фактичну суму операції; його не можна змінювати вручну',
      );
    const actual = minor(payload.amountMinor, true);
    const src = account(previous.accountId, true);
    const note =
      typeof payload.note === 'string' ? payload.note.trim().slice(0, 500) : previous.note;
    update(
      'UPDATE finance_taxi_settlements SET amount_minor=?,expected_minor=?,note=? WHERE id=?',
      [actual, previous.expectedMinor ?? week.settlementMinor, note, previous.id],
    );
    const delta = sumMoney([actual, -previous.amountMinor]);
    if (delta)
      ledger(
        `taxi-settlement-correction:${id}`,
        delta,
        'taxi-settlement',
        src.id,
        'таксі',
        `Уточнення фактичного розрахунку за ${key}`,
        now,
        key,
      );
  } else if (type === 'goal') {
    const target = minor(payload.targetMinor);
    if (!target) throw new FinanceValidation('Ціль має бути більшою за нуль');
    const previousGoal = payload.goalId ? state.goals.find((g) => g.id === payload.goalId) : null;
    if (payload.goalId && !previousGoal) throw new FinanceValidation('Ціль не знайдена');
    const status = choice(payload.status ?? previousGoal?.status ?? 'active', [
      'active',
      'paused',
      'done',
    ]);
    const name = text(payload.name),
      deadline = payload.deadline ? date(payload.deadline) : null;
    const planAmount =
      payload.planAmountMinor === undefined
        ? (previousGoal?.planAmountMinor ?? null)
        : payload.planAmountMinor == null
          ? null
          : minor(payload.planAmountMinor);
    const planPeriod =
      planAmount == null
        ? null
        : choice(payload.planPeriod ?? previousGoal?.planPeriod ?? 'week', [
            'day',
            'week',
            'month',
          ]);
    if (previousGoal)
      update(
        'UPDATE finance_goals SET name=?,target_minor=?,deadline=?,status=?,plan_amount_minor=?,plan_period=? WHERE id=?',
        [name, target, deadline, status, planAmount, planPeriod, previousGoal.id],
      );
    else
      insert('finance_goals', {
        id,
        name,
        target_minor: target,
        deadline,
        status,
        plan_amount_minor: planAmount,
        plan_period: planPeriod,
        created_at: now,
      });
  } else if (type === 'goal-move') {
    const goal = state.goals.find((g) => g.id === payload.goalId);
    if (!goal) throw new FinanceValidation('Ціль не знайдена');
    const bankTx = payload.transactionId
      ? state.transactions.find((t) => t.id === payload.transactionId)
      : null;
    const movementKind = bankTx
      ? 'external'
      : choice(payload.movementKind ?? 'reserve', ['reserve', 'external']);
    const amount = minor(payload.amountMinor, true);
    if (
      payload.transactionId &&
      (!bankTx ||
        !bankTx.bank ||
        bankTx.bankHold ||
        bankTx.reference ||
        bankTx.currency !== 'UAH' ||
        bankTx.amountMinor !== -amount ||
        Date.parse(bankTx.at) > nowMs ||
        !['income', 'expense', 'unclassified', 'transfer'].includes(bankTx.kind))
    )
      throw new FinanceValidation(
        'Обери непов’язану операцію банки з точною сумою внеску або повернення',
      );
    const src = account(
      bankTx ? bankTx.accountId : payload.accountId,
      movementKind === 'external' && !bankTx,
    );
    const allocated = sumMoney(
      state.goalMoves
        .filter(
          (m) => m.goalId === goal.id && m.accountId === src.id && m.movementKind === movementKind,
        )
        .map((m) => m.amountMinor),
    );
    if (!amount || allocated + amount < 0)
      throw new FinanceValidation(
        'Не можна повернути більше, ніж внесено цим способом із цього рахунку',
      );
    insert('finance_goal_moves', {
      id,
      goal_id: goal.id,
      account_id: src.id,
      amount_minor: amount,
      at: bankTx?.at ?? now,
      note: '',
      movement_kind: movementKind,
      bank_tx_id: bankTx?.id ?? null,
    });
    if (bankTx)
      update(
        "UPDATE transactions SET category=?,raw_json=json_patch(COALESCE(raw_json,'{}'),?) WHERE id=?",
        [
          'заощадження',
          JSON.stringify({ financeKind: 'transfer', financeReference: `goal:${goal.id}` }),
          bankTx.id,
        ],
      );
    else if (movementKind === 'external')
      ledger(
        `goal-transfer:${id}`,
        -amount,
        'transfer',
        src.id,
        'заощадження',
        `Внесок / повернення: ${goal.name}`,
        now,
        `goal:${goal.id}`,
      );
  } else if (type === 'budget-remove') {
    const target = state.budgets.find((b) => b.id === payload.budgetId);
    if (!target) throw new FinanceValidation('Бюджет не знайдено');
    const ids = new Set([target.id]);
    for (let i = 0; i < state.budgets.length; i++)
      state.budgets.forEach((b) => {
        if (b.parentId && ids.has(b.parentId)) ids.add(b.id);
      });
    for (const budgetId of ids) update('DELETE FROM finance_budgets WHERE id = ?', [budgetId]);
  } else if (type === 'budget-reorder') {
    if (
      !Array.isArray(payload.ids) ||
      payload.ids.length !== state.budgets.length ||
      new Set(payload.ids).size !== state.budgets.length ||
      payload.ids.some((/** @type {unknown} */ x) => !state.budgets.some((b) => b.id === x))
    )
      throw new FinanceValidation('Онови список бюджетів перед зміною порядку');
    payload.ids.forEach((/** @type {string} */ budgetId, /** @type {number} */ i) =>
      update('UPDATE finance_budgets SET sort_order = ? WHERE id = ?', [i, budgetId]),
    );
  } else if (type === 'forecast-settings') {
    if (!Array.isArray(payload.incomes) || payload.incomes.length > 30)
      throw new FinanceValidation('До 30 планових надходжень');
    const incomes = payload.incomes.map((/** @type {KvBlob} */ x, /** @type {number} */ i) => ({
      id: `${id}:${i}`,
      name: text(x.name),
      amountMinor: minor(x.amountMinor),
      nextDate: date(x.nextDate),
      recurrence: choice(x.recurrence, ['once', 'week', 'month']),
    }));
    update('UPDATE finance_settings SET forecast_json = ? WHERE id = ?', [
      JSON.stringify({ incomes }),
      'owner',
    ]);
  } else if (type === 'budget') {
    const category = text(payload.category),
      period = choice(payload.period, ['day', 'week', 'month']);
    const existingBudget = payload.budgetId
      ? state.budgets.find((b) => b.id === payload.budgetId)
      : null;
    if (payload.budgetId && !existingBudget) throw new FinanceValidation('Бюджет не знайдено');
    if (
      state.budgets.some(
        (b) => b.category === category && b.period === period && b.id !== existingBudget?.id,
      )
    )
      throw new FinanceValidation('Такий бюджет уже є');
    const limit = payload.limitMinor == null ? null : minor(payload.limitMinor);
    const bps = payload.shareBps == null ? null : payload.shareBps;
    if (
      (limit === null) === (bps === null) ||
      (bps !== null && (!Number.isInteger(bps) || bps < 0 || bps > 10000))
    )
      throw new FinanceValidation('Обери суму або відсоток бюджету');
    if (!Array.isArray(payload.categories) || payload.categories.length > 100)
      throw new FinanceValidation('Обери категорії бюджету');
    const categories = payload.categories.map((/** @type {unknown} */ c) => text(c));
    const purpose = choice(payload.purpose ?? 'expense', ['expense', 'saving']);
    const base = bps == null ? null : minor(payload.incomeBaseMinor);
    const parentId =
      payload.parentId === undefined
        ? (existingBudget?.parentId ?? null)
        : payload.parentId
          ? text(payload.parentId)
          : null;
    const parent = parentId ? state.budgets.find((b) => b.id === parentId) : null;
    if (parentId && (!parent || parent.purpose !== purpose))
      throw new FinanceValidation('Обери основний план того самого типу');
    const ancestors = new Set([existingBudget?.id ?? id]);
    let ancestor = parent;
    while (ancestor) {
      if (ancestors.has(ancestor.id))
        throw new FinanceValidation('План не може бути частиною самого себе');
      ancestors.add(ancestor.id);
      if (ancestors.size > 4) throw new FinanceValidation('До чотирьох рівнів плану');
      const ancestorParent = ancestor.parentId;
      ancestor = state.budgets.find((b) => b.id === ancestorParent);
    }
    if (parent && categories.some((/** @type {string} */ c) => !parent.categories.includes(c)))
      throw new FinanceValidation('Категорії підплану мають входити в основний план');
    if (
      existingBudget &&
      state.budgets.some(
        (b) =>
          b.parentId === existingBudget.id &&
          (b.purpose !== purpose || b.categories.some((c) => !categories.includes(c))),
      )
    )
      throw new FinanceValidation('Спершу уточни категорії й тип дочірніх планів');
    const goalId =
      purpose === 'saving'
        ? payload.goalId === undefined
          ? (existingBudget?.goalId ?? null)
          : payload.goalId
            ? text(payload.goalId)
            : null
        : null;
    if (goalId && !state.goals.some((g) => g.id === goalId && g.status === 'active'))
      throw new FinanceValidation('Обери активну ціль');
    const sortOrder = existingBudget?.sortOrder ?? state.budgets.length;
    const forecastEnabled =
      (payload.forecastEnabled ?? existingBudget?.forecastEnabled ?? false) === true ? 1 : 0;
    if (existingBudget)
      update(
        'UPDATE finance_budgets SET category = ?, categories_json = ?, purpose = ?, period = ?, limit_minor = ?, share_bps = ?, income_base_minor = ?, parent_id = ?, goal_id = ?, sort_order = ?, forecast_enabled = ? WHERE id = ?',
        [
          category,
          JSON.stringify(categories),
          purpose,
          period,
          limit,
          bps,
          base,
          parentId,
          goalId,
          sortOrder,
          forecastEnabled,
          existingBudget.id,
        ],
      );
    else
      insert('finance_budgets', {
        id,
        category,
        categories_json: JSON.stringify(categories),
        purpose,
        period,
        limit_minor: limit,
        share_bps: bps,
        income_base_minor: base,
        parent_id: parentId,
        goal_id: goalId,
        sort_order: sortOrder,
        forecast_enabled: forecastEnabled,
        created_at: now,
      });
  } else if (type === 'budget-template') {
    const base = minor(payload.incomeBaseMinor);
    const shares = payload.shares ?? [5000, 3000, 2000];
    const roles = ['needs', 'wants', 'saving'];
    if (
      !Array.isArray(shares) ||
      shares.length !== 3 ||
      shares.some((s) => !Number.isInteger(s) || s < 0 || s > 10000) ||
      shares.reduce((a, b) => a + b, 0) !== 10000
    )
      throw new FinanceValidation('Три частки основного плану мають давати 100%');
    const definitions = [
      {
        category: 'Основні витрати',
        categories: [
          'продукти',
          'транспорт',
          'авто',
          'дім',
          'звʼязок та інтернет',
          'здоровʼя',
          'освіта',
          'фінанси',
        ],
        share: 5000,
        purpose: 'expense',
      },
      {
        category: 'Бажання',
        categories: [
          'кафе й ресторани',
          'подорожі',
          'краса',
          'одяг і взуття',
          'техніка',
          'розваги',
          'спорт',
          'книги й преса',
          'цифрові сервіси',
          'подарунки й квіти',
          'тварини',
          'благодійність',
          'інше',
        ],
        share: 3000,
        purpose: 'expense',
      },
      { category: 'Заощадження', categories: [], share: 2000, purpose: 'saving' },
    ];
    if (
      definitions.some((d) =>
        state.budgets.some((b) => b.category === d.category && b.period === 'month'),
      ) &&
      payload.updateExisting !== true
    )
      throw new FinanceValidation('Шаблон уже додано; відредагуй його бюджети');
    definitions.forEach((d, i) => {
      const previous = state.budgets.find(
        (b) => (b.templateRole === roles[i] || b.category === d.category) && b.period === 'month',
      );
      if (previous) {
        update(
          'UPDATE finance_budgets SET limit_minor = ?, share_bps = ?, income_base_minor = ? WHERE id = ?',
          [null, shares[i], base, previous.id],
        );
        return;
      }
      insert('finance_budgets', {
        id: `${id}:${i}`,
        category: d.category,
        categories_json: JSON.stringify(d.categories),
        purpose: d.purpose,
        period: 'month',
        limit_minor: null,
        share_bps: shares[i],
        income_base_minor: base,
        forecast_enabled: 1,
        template_role: roles[i],
        sort_order: state.budgets.length + i,
        created_at: now,
      });
    });
    for (const budget of state.budgets.filter(
      (b) =>
        !b.parentId &&
        !b.templateRole &&
        !definitions.some((d) => d.category === b.category && b.period === 'month'),
    )) {
      const index = definitions.findIndex((d, i) => {
        const root = state.budgets.find(
          (b) => b.templateRole === roles[i] || (b.category === d.category && b.period === 'month'),
        );
        return (
          d.purpose === budget.purpose &&
          (d.purpose === 'saving' ||
            (budget.categories.length > 0 &&
              budget.categories.every((c) => (root?.categories ?? d.categories).includes(c))))
        );
      });
      if (index < 0) continue;
      const definition = definitions[index];
      if (!definition) continue;
      const root = state.budgets.find(
        (b) =>
          b.templateRole === roles[index] ||
          (b.category === definition.category && b.period === 'month'),
      );
      if (budget.limitMinor != null)
        update('UPDATE finance_budgets SET parent_id = ? WHERE id = ?', [
          root?.id ?? `${id}:${index}`,
          budget.id,
        ]);
      else update('UPDATE finance_budgets SET forecast_enabled = ? WHERE id = ?', [0, budget.id]);
    }
  } else if (type === 'payment') {
    const previous = payload.paymentId
      ? state.payments.find((p) => p.id === payload.paymentId)
      : null;
    if (payload.paymentId && !previous) throw new FinanceValidation('Платіж не знайдено');
    const kind = choice(payload.kind, [
      'subscription',
      'loan',
      'installment',
      'card-installment',
      'bill',
    ]);
    const nextDate = date(payload.nextDate);
    const anchor = payload.anchorDay ?? Number(nextDate.slice(8));
    if (!Number.isInteger(anchor) || anchor < 1 || anchor > 31)
      throw new FinanceValidation('Некоректний день списання');
    const remind = payload.remindDays ?? 3;
    if (!Number.isInteger(remind) || remind < 0 || remind > 30)
      throw new FinanceValidation('Некоректний строк нагадування');
    const left = payload.installmentsLeft ?? null;
    if (left !== null && (!Number.isSafeInteger(left) || left < 0 || left > 1200))
      throw new FinanceValidation('Некоректна кількість платежів');
    const values = {
      name: text(payload.name),
      kind,
      amount_minor: minor(payload.amountMinor),
      remaining_minor: payload.remainingMinor == null ? null : minor(payload.remainingMinor),
      installments_left: left,
      next_date: nextDate,
      anchor_day: anchor,
      recurrence: ['day', 'week'].includes(payload.recurrence)
        ? 'month'
        : choice(payload.recurrence, ['month', 'year', 'once']),
      interval_period: ['day', 'week'].includes(payload.recurrence)
        ? choice(payload.recurrence, ['day', 'week'])
        : null,
      category: text(payload.category),
      remind_days: remind,
      status: choice(payload.status ?? 'active', ['active', 'paused', 'done']),
      total_minor:
        payload.totalMinor === undefined
          ? (previous?.totalMinor ?? null)
          : payload.totalMinor == null
            ? null
            : minor(payload.totalMinor),
      rate_bps: payload.rateBps ?? previous?.rateBps ?? 0,
      fee_minor: minor(payload.feeMinor ?? previous?.feeMinor ?? 0),
      lender:
        payload.lender === undefined
          ? (previous?.lender ?? '')
          : payload.lender
            ? text(payload.lender, 120)
            : '',
      note:
        payload.note === undefined
          ? (previous?.note ?? '')
          : payload.note
            ? text(payload.note, 500)
            : '',
    };
    const extraTotal =
      payload.overpaymentTotalMinor === undefined
        ? (previous?.overpaymentTotalMinor ?? null)
        : payload.overpaymentTotalMinor == null
          ? null
          : minor(payload.overpaymentTotalMinor);
    const extraLeft =
      extraTotal == null
        ? null
        : minor(
            payload.overpaymentRemainingMinor ?? previous?.overpaymentRemainingMinor ?? extraTotal,
          );
    if (payload.overpaymentTotalMinor !== undefined || previous?.overpaymentTotalMinor != null) {
      const term = extraTotal == null ? null : (payload.termMonths ?? previous?.termMonths);
      if (
        extraTotal != null &&
        (!isDebtKind(kind) ||
          values.remaining_minor == null ||
          values.total_minor == null ||
          values.total_minor <= 0 ||
          !Number.isInteger(term) ||
          term < 1 ||
          term > 1200 ||
          left == null ||
          left > term ||
          (extraLeft ?? 0) > extraTotal ||
          values.rate_bps !== 0 ||
          values.fee_minor !== 0 ||
          values.recurrence !== 'month' ||
          values.interval_period != null)
      )
        throw new FinanceValidation(
          'Перевір суму покупки, переплату та місячний термін розстрочки',
        );
      if (
        extraTotal != null &&
        (!Number.isSafeInteger((values.remaining_minor ?? 0) + (extraLeft ?? 0)) ||
          !Number.isSafeInteger((values.total_minor ?? 0) + extraTotal))
      )
        throw new FinanceValidation('Некоректна загальна сума розстрочки');
      Object.assign(values, {
        overpayment_total_minor: extraTotal,
        overpayment_remaining_minor: extraLeft,
        overpayment_paid_minor:
          previous?.overpaymentTotalMinor != null
            ? previous.overpaymentPaidMinor
            : extraTotal == null
              ? 0
              : extraTotal - (extraLeft ?? 0),
        term_months: term,
      });
    }
    const interestMethod =
      payload.interestMethod === undefined
        ? (previous?.interestMethod ?? null)
        : payload.interestMethod;
    if (payload.interestMethod !== undefined || previous?.interestMethod != null) {
      if (interestMethod != null) {
        const term = payload.termMonths ?? previous?.termMonths;
        const estimate = interestQuote(
          values.remaining_minor ?? 0,
          left ?? 0,
          values.rate_bps,
          interestMethod,
          values.fee_minor,
          values.total_minor ?? 0,
        );
        if (
          !isDebtKind(kind) ||
          extraTotal != null ||
          values.recurrence !== 'month' ||
          values.interval_period != null ||
          !estimate ||
          !Number.isInteger(term) ||
          term < 1 ||
          term > 1200 ||
          left > term
        )
          throw new FinanceValidation(
            'Перевір суму, річну ставку, спосіб нарахування і місячний термін',
          );
        Object.assign(values, { term_months: term });
        if (
          !interestDebtPayment({
            amountMinor: values.amount_minor,
            remainingMinor: values.remaining_minor,
            totalMinor: values.total_minor,
            installmentsLeft: left,
            rateBps: values.rate_bps,
            feeMinor: values.fee_minor,
            interestMethod,
          })
        )
          throw new FinanceValidation('Платіж має покривати відсотки, комісію та частину тіла');
      }
      Object.assign(values, { interest_method: interestMethod });
    }
    if (!Number.isInteger(values.rate_bps) || values.rate_bps < 0 || values.rate_bps > 30000)
      throw new FinanceValidation('Некоректна річна ставка');
    if (
      values.total_minor != null &&
      values.remaining_minor != null &&
      values.total_minor < values.remaining_minor
    )
      throw new FinanceValidation('Залишок не може перевищувати початкову суму');
    if (!values.amount_minor) throw new FinanceValidation('Сума платежу має бути більшою за нуль');
    if (values.fee_minor >= values.amount_minor)
      throw new FinanceValidation('Комісія має бути меншою за повний платіж');
    if (['loan', 'installment', 'card-installment'].includes(kind)) {
      if (values.remaining_minor === 0 && (extraLeft ?? 0) === 0) {
        values.status = 'done';
        values.installments_left = 0;
      } else if (values.status === 'done')
        throw new FinanceValidation('Для закриття боргу підтвердь фактичне погашення залишку');
    }
    if (previous)
      update(
        `UPDATE finance_payments SET ${Object.keys(values)
          .map((k) => `${k} = ?`)
          .join(',')} WHERE id = ?`,
        [...Object.values(values), previous.id],
      );
    else insert('finance_payments', { id, ...values, created_at: now });
  } else if (type === 'payment-cancel') {
    const payment = state.payments.find((p) => p.id === payload.paymentId && p.status !== 'done');
    if (!payment || payment.kind !== 'subscription')
      throw new FinanceValidation('Обери незавершену підписку');
    // Cancelling a subscription stops reminders; it is not a financial operation.
    update("UPDATE finance_payments SET status = 'done' WHERE id = ?", [payment.id]);
  } else if (type === 'payment-paid') {
    const payment = state.payments.find((p) => p.id === payload.paymentId && p.status === 'active');
    if (!payment) throw new FinanceValidation('Активний платіж не знайдено');
    const amount = minor(payload.amountMinor);
    if (!amount) throw new FinanceValidation('Сума платежу має бути більшою за нуль');
    const existingTx = payload.transactionId
      ? state.transactions.find((t) => t.id === payload.transactionId)
      : null;
    if (
      payload.transactionId &&
      (!existingTx ||
        !existingTx.bank ||
        existingTx.bankHold ||
        existingTx.reference ||
        bankPaymentAmount(existingTx) !== -amount ||
        !['expense', 'unclassified', 'transfer'].includes(existingTx.kind))
    )
      throw new FinanceValidation(
        'Обери завершений непов’язаний банківський платіж із відповідною сумою',
      );
    if (
      payment.remainingMinor != null &&
      payment.rateBps > 0 &&
      !payment.interestMethod &&
      payload.principalMinor == null
    )
      throw new FinanceValidation('Вкажи частину платежу, яка погашає тіло кредиту за договором');
    const fixed = fixedDebtPayment(payment, amount);
    const calculated = interestDebtPayment(payment, amount);
    if (
      payment.interestMethod &&
      payload.close !== true &&
      payload.principalMinor == null &&
      !calculated
    )
      throw new FinanceValidation(
        'Платіж має покривати відсотки й комісію; для іншого графіка вкажи тіло за банком',
      );
    const principal =
      payload.principalMinor == null
        ? payload.close === true &&
          (payment.overpaymentRemainingMinor != null || payment.interestMethod)
          ? (payment.remainingMinor ?? 0)
          : (fixed?.principalMinor ??
            calculated?.principalMinor ??
            Math.max(0, amount - payment.feeMinor))
        : minor(payload.principalMinor);
    if (
      principal > amount ||
      (payment.remainingMinor != null && principal > payment.remainingMinor)
    )
      throw new FinanceValidation('Погашення тіла не може перевищувати платіж або залишок боргу');
    if (
      payload.close === true &&
      (!['loan', 'installment', 'card-installment'].includes(payment.kind) ||
        payment.remainingMinor == null ||
        payment.remainingMinor === 0 ||
        principal !== payment.remainingMinor)
    )
      throw new FinanceValidation(
        'Для дострокового закриття потрібно погасити весь залишок тіла боргу',
      );
    if (payload.close != null && typeof payload.close !== 'boolean')
      throw new FinanceValidation('Некоректне підтвердження закриття');
    const remaining =
      payment.remainingMinor == null ? null : Math.max(0, payment.remainingMinor - principal);
    const extraPaid = amount - principal;
    if (
      payment.overpaymentRemainingMinor != null &&
      payload.close !== true &&
      extraPaid > payment.overpaymentRemainingMinor
    )
      throw new FinanceValidation(
        'Переплата перевищує погоджений залишок — звір розстрочку з банком',
      );
    const extraRemaining =
      payment.overpaymentRemainingMinor == null
        ? null
        : payload.close === true
          ? 0
          : payment.overpaymentRemainingMinor - extraPaid;
    const fullyPaid = remaining === 0 && (extraRemaining ?? 0) === 0;
    const count = fullyPaid
      ? 0
      : payment.installmentsLeft == null
        ? null
        : Math.max(0, payment.installmentsLeft - 1);
    const done = fullyPaid || (remaining == null && (payment.recurrence === 'once' || count === 0));
    const next =
      done || payment.recurrence === 'once'
        ? payment.nextDate
        : nextPaymentDate(
            payment.nextDate,
            payment.anchorDay,
            /** @type {'day'|'week'|'month'|'year'} */ (payment.recurrence),
          );
    if (existingTx)
      update(
        "UPDATE transactions SET category = ?, raw_json = json_patch(COALESCE(raw_json, '{}'), ?) WHERE id = ?",
        [
          payment.category,
          JSON.stringify({
            financeKind: 'expense',
            financeReference: payment.id,
            financePrincipalMinor: principal,
            financeOverpaymentMinor: extraPaid,
          }),
          existingTx.id,
        ],
      );
    else {
      const src = account(payload.accountId, true);
      ledger(
        `payment:${id}`,
        -amount,
        'expense',
        src.id,
        payment.category,
        payment.name,
        now,
        payment.id,
      );
      update('UPDATE transactions SET raw_json = json_patch(raw_json, ?) WHERE id = ?', [
        JSON.stringify({ financePrincipalMinor: principal, financeOverpaymentMinor: extraPaid }),
        `payment:${id}`,
      ]);
    }
    update(
      'UPDATE finance_payments SET remaining_minor = ?, installments_left = ?, next_date = ?, status = ? WHERE id = ?',
      [remaining, count, next, done ? 'done' : 'active', payment.id],
    );
    if (extraRemaining != null)
      update(
        'UPDATE finance_payments SET overpayment_remaining_minor = ?, overpayment_paid_minor = ? WHERE id = ?',
        [extraRemaining, (payment.overpaymentPaidMinor ?? 0) + extraPaid, payment.id],
      );
  } else if (type === 'classify') {
    const tx = state.transactions.find((t) => t.id === payload.transactionId);
    if (!tx) throw new FinanceValidation('Операція не знайдена у доступному періоді');
    if (tx.reference || (!tx.bank && !['expense', 'income', 'unclassified'].includes(tx.kind)))
      throw new FinanceValidation(
        'Ця операція створена обліком. Змінюй її через відповідний розділ',
      );
    const kind = choice(payload.kind, ['expense', 'income', 'transfer', 'taxi-settlement']);
    if ((kind === 'expense' && tx.amountMinor >= 0) || (kind === 'income' && tx.amountMinor <= 0))
      throw new FinanceValidation('Тип не відповідає напряму операції');
    update(
      "UPDATE transactions SET category = ?, raw_json = json_patch(COALESCE(raw_json, '{}'), ?) WHERE id = ?",
      [text(payload.category), JSON.stringify({ financeKind: kind }), tx.id],
    );
  } else throw new FinanceValidation('Невідома фінансова дія');
  statements.push(
    db
      .prepare(
        `UPDATE finance_settings SET version = version + 1, updated_at = ? WHERE id = 'owner' AND version = ? AND ${guard}`,
      )
      .bind(now, version, id, hash, now),
  );
  const outcome = await db.batch(statements);
  if (!outcome.at(-1)?.meta?.changes)
    throw new FinanceConflict('Дані змінилися. Онови екран і повтори дію.');
  return { ok: true, duplicate: false };
}
