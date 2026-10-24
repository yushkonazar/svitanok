import { adaptiveForecast, MODEL_VERSION } from './adaptive-model.mjs';
import { savingsForecast } from './savings-forecast.mjs';
import { budgetPeriod, budgetPlanLimit } from './budget-history.mjs';
import { paymentSchedule } from './payments.mjs';
import { financeDisplay } from './display.mjs';
import {
  kyivParts,
  kyivInstant,
  shiftDate,
  sumMoney,
  nextPaymentDate,
  taxiWeek,
  taxiEntryWeek,
  calculateTaxiWeek,
} from './planning.mjs';
/** @param {string} d */ const weekday = (d) => (new Date(d + 'T12:00Z').getUTCDay() + 6) % 7;

/** Passengers' cash and handover cash are separate flows; reserves change after each event.
 * @param {any} f @param {string[]} dates @param {number} nowMs @param {{date:string;source?:string}[]} incomes */
function taxiProjection(f, dates, nowMs, incomes) {
  const entries = f.taxiEntries
    .filter((/** @type {any} */ e) => Date.parse(e.at) <= nowMs)
    .map((/** @type {any} */ e) => ({ ...e, periodKey: taxiEntryWeek(e, f.policies).key }));
  if (!f.policies.some((/** @type {any} */ p) => Date.parse(p.effectiveAt) <= nowMs))
    return {
      flows: dates.map(() => 0),
      low: dates.map(() => 0),
      high: dates.map(() => 0),
      status: 'unavailable',
      reason: 'Немає чинних умов таксі.',
      count: 0,
    };
  /** @type {Map<string,any[]>} */ const byDate = new Map();
  entries.forEach((/** @type {any} */ e) => {
    const key = kyivParts(Date.parse(e.at)).date;
    byDate.set(key, [...(byDate.get(key) ?? []), e]);
  });
  const recorded = [...byDate.keys()].sort();
  const policy = f.policies
    .filter((/** @type {any} */ p) => Date.parse(p.effectiveAt) <= nowMs)
    .at(-1);
  const recent = recorded.filter((d) => d >= policy.effectiveAt.slice(0, 10));
  const today = dates[0] ?? kyivParts(nowMs).date;
  const firstRecorded = (recent.length >= 7 ? recent : recorded).at(0) ?? today;
  const first = firstRecorded < shiftDate(today, -90) ? shiftDate(today, -90) : firstRecorded;
  /** @type {string[]} */ const history = [];
  for (let d = first; d < today; d = shiftDate(d, 1)) history.push(d);
  const fields = ['netCashMinor', 'commissionMinor', 'fuelMinor', 'tipsMinor', 'receivedCashMinor'];
  const models = Object.fromEntries(
    fields.map((field) => [
      field,
      adaptiveForecast(
        history.map((d) =>
          byDate.has(d) ? sumMoney((byDate.get(d) ?? []).map((e) => e[field] ?? 0)) : null,
        ),
        dates.length,
        weekday(first),
      ),
    ]),
  );
  const completedToday = (byDate.get(today) ?? []).some((e) => e.dayComplete !== false);
  const uncertainty = Math.max(
    0.15,
    Math.min(
      0.75,
      (models.netCashMinor?.noise ?? 0) / Math.max(1, models.netCashMinor?.points[0] ?? 0),
    ),
  );
  /** @param {number} scale */
  const simulate = (scale) => {
    const accumulated = [...entries],
      settled = new Set(f.settlements.map((/** @type {any} */ s) => s.weekKey));
    /** @type {Map<string,any>} */ const periods = new Map(
      f.taxiWeeks.map((/** @type {any} */ w) => [w.key, { key: w.key, from: w.from, to: w.to }]),
    );
    for (const d of dates) {
      const w = taxiWeek(kyivInstant(d, 23), f.policies);
      periods.set(w.key, w);
    }
    /** @type {Map<string,{earned:number;held:number;settlement:number}>} */ const calculated =
      new Map();
    /** @param {any} w */ const calc = (w) => {
      const cached = calculated.get(w.key);
      if (cached) return cached;
      const values = accumulated.filter((e) => e.periodKey === w.key);
      const earned = calculateTaxiWeek(
        values,
        f.policies,
        w.from ?? kyivInstant(w.key.slice(0, 10)),
      ).earnedMinor;
      const held = sumMoney(values.map((e) => (e.receivedCashMinor ?? 0) - (e.paidWorkMinor ?? 0)));
      const value = { earned, held, settlement: earned - held };
      calculated.set(w.key, value);
      return value;
    };
    const reserve = () =>
      sumMoney(
        [...periods.values()]
          .filter((w) => !settled.has(w.key))
          .map((w) => Math.max(0, -calc(w).settlement)),
      );
    return dates.map((d, i) => {
      let flow = 0;
      for (const w of periods.values()) {
        if (settled.has(w.key) || !Number.isFinite(w.to) || w.to > kyivInstant(shiftDate(d, 1), 0))
          continue;
        const before = reserve(),
          settlement = calc(w).settlement;
        const override = incomes.some((p) => p.source !== 'other' && p.date === d);
        settled.add(w.key);
        flow += (override ? 0 : settlement) + before - reserve();
      }
      if ((i === 0 && completedToday) || !history.length) return Math.round(flow);
      const sameDays = history.filter((day) => weekday(day) === weekday(d));
      const probability =
        (sameDays.filter((day) => byDate.has(day)).length + 1) / (sameDays.length + 2);
      const at = kyivInstant(d, 21),
        active = f.policies
          .filter((/** @type {any} */ p) => Date.parse(p.effectiveAt) <= at)
          .at(-1);
      if (!active) return Math.round(flow);
      const projected = Object.fromEntries(
        fields.map((field) => {
          const already = i === 0 ? sumMoney((byDate.get(d) ?? []).map((e) => e[field] ?? 0)) : 0;
          return [
            field,
            Math.max(
              0,
              Math.round((models[field]?.points[i] ?? 0) * probability * scale) - already,
            ),
          ];
        }),
      );
      const before = reserve();
      const periodKey = taxiWeek(at, f.policies).key;
      accumulated.push({
        periodKey,
        id: `forecast:${d}`,
        at: new Date(at).toISOString(),
        policyId: active.id,
        ...projected,
        directMinor: 0,
        paidWorkMinor: 0,
        commissionReported: true,
        cashReported: true,
      });
      calculated.delete(periodKey);
      flow += (projected.receivedCashMinor ?? 0) + before - reserve();
      return Math.round(flow);
    });
  };
  return {
    flows: simulate(1),
    low: simulate(1 - uncertainty),
    high: simulate(1 + uncertainty),
    count: recorded.length,
    status: recorded.length < 7 ? 'insufficient' : 'estimated',
    reason:
      'Денні оцінки роботи, чинні умови, готівка й резерв парку. Розрахунок із парком не додає вже отримані кошти вдруге.',
  };
}

/** Shared server / demo projection. Source facts never change; bands are scenarios, not probabilities.
 * @param {any} f @param {number} days @param {number} [nowMs] */
export function projectFinances(f, days, nowMs = Date.now()) {
  if (!Number.isInteger(days) || days < 1 || days > 366)
    throw new Error('Прогноз: від 1 до 366 днів');
  const today = kyivParts(nowMs).date,
    until = shiftDate(today, days - 1),
    dates = Array.from({ length: days }, (_, i) => shiftDate(today, i));
  const display = financeDisplay(f.display);
  const owned = sumMoney(
    f.accounts
      .filter((/** @type {any} */ a) => a.currency === 'UAH' && a.balanceMinor != null)
      .map((/** @type {any} */ a) => a.balanceMinor),
  );
  const reserved = sumMoney(
    f.goalMoves
      .filter((/** @type {any} */ m) => m.movementKind !== 'external')
      .map((/** @type {any} */ m) => m.amountMinor),
  );
  const available = sumMoney([owned, -reserved, -f.reserveMinor]);
  const unknown =
    f.accounts.some((/** @type {any} */ a) => a.currency === 'UAH' && a.balanceMinor == null) ||
    f.taxiWeeks.some((/** @type {any} */ w) => !w.settled && !w.complete);
  const payments = f.payments
    .filter((/** @type {any} */ p) => p.status === 'active')
    .flatMap((/** @type {any} */ p) =>
      paymentSchedule(p, 1200)
        .filter((r) => r.date <= until)
        .map((r) => ({ ...r, id: p.id, name: p.name, category: p.category })),
    );
  const obligations = sumMoney(payments.map((/** @type {any} */ r) => r.payment));
  const contractIds = new Set(f.payments.map((/** @type {any} */ p) => p.id));
  // Banking products follow repayment schedules, not a daily consumption model.
  // Never silently link a receipt or infer a loan from a purchase merchant.
  const debtCategories = new Set(['покупка частинами', 'розстрочка', 'кредити']);
  const observed = f.transactions
    .filter((/** @type {any} */ t) => Date.parse(t.at) <= nowMs)
    .map((/** @type {any} */ t) => ({ ...t, projectionDate: kyivParts(Date.parse(t.at)).date }));
  const expenses = observed.filter(
    (/** @type {any} */ t) =>
      t.kind === 'expense' &&
      t.amountUah < 0 &&
      !contractIds.has(t.reference) &&
      !debtCategories.has(t.category),
  );
  const oldest = observed.map((/** @type {any} */ t) => t.projectionDate).sort()[0] ?? today;
  const first = oldest > shiftDate(today, -90) ? oldest : shiftDate(today, -90);
  /** @type {string[]} */ const history = [];
  for (let d = first; d < today; d = shiftDate(d, 1)) history.push(d);
  const recorded = new Set(observed.map((/** @type {any} */ t) => t.projectionDate));
  const categories = [
    ...new Set([
      ...expenses.map((/** @type {any} */ t) => t.category),
      ...f.budgets
        .filter((/** @type {any} */ b) => b.purpose === 'expense')
        .flatMap((/** @type {any} */ b) => b.categories),
    ]),
  ];
  let plans = categories
    .filter((category) => !debtCategories.has(category))
    .map((category) => {
      const txs = expenses.filter((/** @type {any} */ t) => t.category === category);
      const totals = new Map(
        history.map((d) => [
          d,
          -sumMoney(
            txs
              .filter((/** @type {any} */ t) => t.projectionDate === d)
              .map((/** @type {any} */ t) => t.amountUah),
          ),
        ]),
      );
      const model = adaptiveForecast(
        history.map((d) => (recorded.has(d) ? (totals.get(d) ?? 0) : null)),
        days,
        weekday(first),
      );
      const budgets = f.budgets.filter(
        (/** @type {any} */ b) => b.purpose === 'expense' && b.categories.includes(category),
      );
      const fallback = budgets.length
        ? Math.max(
            ...budgets.map((/** @type {any} */ b) =>
              Math.round(
                budgetPlanLimit(b, f.budgets, today) /
                  budgetPeriod(b.period, today).days /
                  Math.max(1, b.categories.length),
              ),
            ),
          )
        : 0;
      const values = model.count >= 7 ? model.points : dates.map(() => fallback);
      const spent = -sumMoney(
        txs
          .filter((/** @type {any} */ t) => t.projectionDate === today)
          .map((/** @type {any} */ t) => t.amountUah),
      );
      values[0] = Math.max(0, (values[0] ?? 0) - spent);
      let covered = 0;
      if (model.count < 7)
        for (const p of payments.filter((/** @type {any} */ p) => p.category === category)) {
          const index = Math.max(0, dates.indexOf(p.date));
          const deduction = Math.min(values[index] ?? 0, p.payment);
          values[index] = (values[index] ?? 0) - deduction;
          covered += deduction;
        }
      return {
        id: category,
        name: category,
        purpose: 'expense',
        categories: [category],
        amount: sumMoney(values),
        covered,
        goalIds: [],
        values,
        model: model.model,
        count: model.count,
        noise: model.noise,
        status: model.count < 7 ? 'За планом: мало історії' : model.status,
      };
    });
  /** @type {string[]} */ const overlaps = [];
  if (display.expenseForecast === 'plan') {
    const enabled = f.budgets.filter(
      (/** @type {any} */ b) => b.purpose === 'expense' && b.forecastEnabled,
    );
    /** @param {any} child @param {string} parent */
    const descends = (child, parent) => {
      let node = child;
      const seen = new Set();
      while (node?.parentId && !seen.has(node.id)) {
        if (node.parentId === parent) return true;
        seen.add(node.id);
        node = f.budgets.find((/** @type {any} */ b) => b.id === node.parentId);
      }
      return false;
    };
    for (let i = 0; i < enabled.length; i++)
      for (let j = i + 1; j < enabled.length; j++) {
        const a = enabled[i],
          b = enabled[j];
        if (
          !descends(a, b.id) &&
          !descends(b, a.id) &&
          a.categories.some((/** @type {string} */ c) => b.categories.includes(c))
        )
          overlaps.push(a.category, b.category);
      }
    /** @param {any} b @param {string} d @param {Set<string>} [seen] @returns {number} */
    const dailyLimit = (b, d, seen = new Set()) => {
      if (seen.has(b.id)) return 0;
      seen.add(b.id);
      return Math.max(
        budgetPlanLimit(b, f.budgets, d) / budgetPeriod(b.period, d).days,
        sumMoney(
          enabled
            .filter((/** @type {any} */ c) => c.parentId === b.id)
            .map((/** @type {any} */ c) => Math.round(dailyLimit(c, d, new Set(seen)))),
        ),
      );
    };
    plans = enabled
      .filter(
        (/** @type {any} */ b) => !enabled.some((/** @type {any} */ p) => p.id === b.parentId),
      )
      .map((/** @type {any} */ b) => {
        const categories = [
          ...new Set(
            f.budgets
              .filter((/** @type {any} */ c) => c.id === b.id || descends(c, b.id))
              .flatMap((/** @type {any} */ c) => c.categories),
          ),
        ];
        const values = dates.map((d) => {
          const w = budgetPeriod(b.period, d),
            left =
              Math.round(
                (Date.parse(w.end) - Date.parse(w.start < today ? today : w.start)) / 86400000,
              ) + 1;
          const spent = -sumMoney(
            observed
              .filter(
                (/** @type {any} */ t) =>
                  t.kind === 'expense' &&
                  t.amountUah < 0 &&
                  categories.includes(t.category) &&
                  t.projectionDate >= w.start &&
                  t.projectionDate <= w.end,
              )
              .map((/** @type {any} */ t) => t.amountUah),
          );
          const remaining = Math.max(0, Math.round(dailyLimit(b, d) * w.days) - spent);
          const elapsed = Math.round(
            (Date.parse(d) - Date.parse(w.start < today ? today : w.start)) / 86400000,
          );
          return (
            Math.round((remaining * (elapsed + 1)) / left) -
            Math.round((remaining * elapsed) / left)
          );
        });
        const covered = sumMoney(
          payments
            .filter((/** @type {any} */ p) => categories.includes(p.category))
            .map((/** @type {any} */ p) => p.payment),
        );
        let rest = covered;
        values.forEach((/** @type {number} */ v, /** @type {number} */ i) => {
          const n = Math.min(rest, v);
          values[i] = (values[i] ?? 0) - n;
          rest -= n;
        });
        return {
          id: b.id,
          name: b.category,
          purpose: 'expense',
          categories,
          amount: sumMoney(values),
          covered,
          goalIds: [],
          values,
          model: 'plan',
          count: 0,
          noise: 0,
          status: 'За вашим планом',
        };
      });
  }
  for (let i = 0; i < plans.length; i++)
    for (let j = i + 1; j < plans.length; j++) {
      const a = plans[i],
        b = plans[j];
      if (a && b && a.categories.some((/** @type {string} */ c) => b.categories.includes(c)))
        overlaps.push(a.name, b.name);
    }
  const goalPlans = savingsForecast(f, days, nowMs);
  const generic = f.budgets.filter(
    (/** @type {any} */ b) =>
      b.purpose === 'saving' && b.forecastEnabled && !b.parentId && !b.goalId,
  );
  const genericSaving = sumMoney(
    generic.map((/** @type {any} */ b) =>
      Math.round(
        (budgetPlanLimit(b, f.budgets, today) * days) / budgetPeriod(b.period, today).days,
      ),
    ),
  );
  const saving = Math.max(genericSaving, sumMoney(goalPlans.map((g) => g.amount))),
    extraSaving = saving - sumMoney(goalPlans.map((g) => g.amount));
  /** @type {{name:string;date:string;amount:number;source?:string}[]} */ const incomes = [];
  for (const p of f.forecast.incomes) {
    let d = p.nextDate;
    for (let i = 0; i < 1200 && d <= until; i++) {
      if (d >= today)
        incomes.push({ name: p.name, date: d, amount: p.amountMinor, source: p.source });
      if (p.recurrence === 'once') break;
      d = nextPaymentDate(d, Number(p.nextDate.slice(8)), p.recurrence);
    }
  }
  const taxi = taxiProjection(f, dates, nowMs, incomes);
  let balance = available,
    low = available,
    high = available;
  const daily = dates.map((date, i) => {
    const payment = sumMoney(
      payments
        .filter((/** @type {any} */ p) => (p.date < today ? today : p.date) === date)
        .map((/** @type {any} */ p) => p.payment),
    );
    const expense = sumMoney(plans.map((p) => p.values[i] ?? 0));
    const saved =
      sumMoney(
        goalPlans.flatMap((g) => g.events.filter((e) => e.date === date).map((e) => e.amount)),
      ) + (i === days - 1 ? extraSaving : 0);
    const income = sumMoney(incomes.filter((p) => p.date === date).map((p) => p.amount));
    const noise = Math.round(Math.sqrt(plans.reduce((n, p) => n + p.noise * p.noise, 0)));
    const earlySaving =
      sumMoney(
        goalPlans.flatMap((g) => g.earlyEvents.filter((e) => e.date === date).map((e) => e.amount)),
      ) + (i === days - 1 ? extraSaving : 0);
    const lateSaving =
      sumMoney(
        goalPlans.flatMap((g) => g.events.filter((e) => e.latest === date).map((e) => e.amount)),
      ) + (i === days - 1 ? extraSaving : 0);
    balance = sumMoney([balance, income, taxi.flows[i] ?? 0, -payment, -expense, -saved]);
    low = sumMoney([low, income, taxi.low[i] ?? 0, -payment, -expense, -noise, -earlySaving]);
    high = sumMoney([
      high,
      income,
      taxi.high[i] ?? 0,
      -payment,
      -Math.max(0, expense - noise),
      -lateSaving,
    ]);
    return {
      date,
      income: income + (taxi.flows[i] ?? 0),
      taxi: taxi.flows[i] ?? 0,
      payment,
      expense,
      saving: saved,
      balance,
      lower: Math.min(low, balance, high),
      upper: Math.max(low, balance, high),
    };
  });
  const incomplete =
    unknown ||
    overlaps.length > 0 ||
    f.payments.some(
      (/** @type {any} */ p) =>
        p.status === 'active' &&
        p.installmentsLeft === 0 &&
        (p.remainingMinor ?? 0) + (p.overpaymentRemainingMinor ?? 0) > 0,
    );
  const warnings = [
    'Сценарний діапазон не є каліброваним імовірнісним інтервалом.',
    'Оцінка за записаною історією; відсутній запис не завжди означає нуль.',
  ];
  const unmatchedDebt = observed.filter(
    (/** @type {any} */ t) =>
      t.kind === 'expense' &&
      t.amountUah < 0 &&
      debtCategories.has(t.category) &&
      !contractIds.has(t.reference) &&
      t.projectionDate >= first,
  );
  if (unmatchedDebt.length)
    warnings.push(
      `Є ${unmatchedDebt.length} записів погашення без прив’язки до договору. Вони не повторюються як повсякденні витрати; звірте, чи всі майбутні погашення внесено у графіки.`,
    );
  if (taxi.count < 14)
    warnings.push('Коротка історія таксі: очікувані зміни мають високу невизначеність.');
  if (goalPlans.some((g) => g.adaptive))
    warnings.push('Очікувані внески адаптовано до фактичного темпу; ваш план не змінено.');
  const minimum = daily.reduce((best, d) => (d.balance < best.balance ? d : best), {
    date: today,
    balance: available,
  });
  return {
    today,
    until,
    asOf: new Date(nowMs).toISOString(),
    algorithmVersion: MODEL_VERSION,
    available,
    obligations,
    plannedExpense: sumMoney(plans.map((p) => p.amount)),
    saving,
    expectedIncome: sumMoney([...incomes.map((i) => i.amount), ...taxi.flows]),
    result: incomplete ? null : (daily.at(-1)?.balance ?? available),
    conservativeResult: incomplete ? null : (daily.at(-1)?.lower ?? available),
    currentSafe: incomplete
      ? null
      : available - obligations - sumMoney(plans.map((p) => p.amount)) - saving,
    daily,
    minimum: incomplete ? null : { date: minimum.date, amount: minimum.balance },
    warnings,
    unlinkedPaymentCount: unmatchedDebt.length,
    taxi: {
      ...taxi,
      date: kyivParts(taxiWeek(nowMs, f.policies).to).date,
      historyPeriods: f.taxiWeeks.filter((/** @type {any} */ w) => w.closed).length,
      estimateMinor: sumMoney(taxi.flows),
      lowerMinor: sumMoney(taxi.low),
      upperMinor: sumMoney(taxi.high),
    },
    taxiCovered: incomes.some((p) => p.source !== 'other'),
    plans,
    goalPlans,
    incomes,
    payments,
    overlaps: [...new Set(overlaps)],
    incomplete,
    hasPlans: plans.length > 0 || goalPlans.length > 0,
  };
}
