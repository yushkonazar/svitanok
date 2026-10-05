import { financeSchema, type Finance, type FinanceCommand } from './finance-schema.ts';
import { financeCategories } from '../../../core/finance/categories.mjs';
import { fixedDebtPayment, interestDebtPayment } from '../../../core/finance/payments.mjs';
import {
  calculateTaxiWeek,
  kyivInstant,
  kyivParts,
  nextPaymentDate,
  shiftDate,
  taxiWeek,
  sumMoney,
} from '../../../core/finance/planning.mjs';

const KEY = 'svitanok:finance-demo:v1';
let memory: Finance | null = null;
const applied = new Set<string>();
const categories = financeCategories();
function rebuild(f: Finance) {
  f.categories = financeCategories([
    ...f.categories,
    ...f.transactions.map((t) => t.category),
    ...f.budgets.flatMap((b) => b.categories),
    ...f.payments.map((p) => p.category),
  ]);
  const keys = [...new Set(f.taxiEntries.map((e) => taxiWeek(Date.parse(e.at)).key))]
    .sort()
    .reverse();
  f.taxiWeeks = keys.map((key) => {
    const w = calculateTaxiWeek(f.taxiEntries, f.policies, kyivInstant(key));
    const held = sumMoney(
      w.entries.map((e) => (e.receivedCashMinor ?? 0) - (e.paidWorkMinor ?? 0)),
    );
    const settlement = f.settlements.find((s) => s.weekKey === key);
    return {
      key,
      grossMinor: w.grossMinor,
      netCashMinor: w.netCashMinor,
      commissionMinor: sumMoney(w.entries.map((e) => e.commissionMinor)),
      fuelMinor: sumMoney(w.entries.map((e) => e.fuelMinor)),
      tipsMinor: sumMoney(w.entries.map((e) => e.tipsMinor)),
      actualSettlementMinor: settlement?.amountMinor ?? null,
      expectedSettlementMinor: settlement?.expectedMinor ?? w.earnedMinor - held,
      settlementDifferenceMinor: settlement
        ? settlement.amountMinor - (settlement.expectedMinor ?? w.earnedMinor - held)
        : null,
      settledAt: settlement?.at ?? null,
      earnedMinor: w.earnedMinor,
      heldMinor: held,
      settlementMinor: w.earnedMinor - held,
      complete: w.entries.every((e) => e.commissionReported !== false && e.cashReported !== false),
      settled: f.settlements.some((s) => s.weekKey === key),
      closed: Date.now() >= w.to,
    };
  });
  f.reserveMinor = sumMoney(
    f.taxiWeeks.filter((w) => !w.settled).map((w) => Math.max(0, -w.settlementMinor)),
  );
  f.generatedAt = new Date().toISOString();
  return f;
}
function seed(): Finance {
  const now = Date.now(),
    today = kyivParts(now).date;
  const f: Finance = {
    ok: true,
    version: 0,
    generatedAt: new Date(now).toISOString(),
    settings: {
      incomePeriod: 'week',
      taxiVisible: true,
      paymentReminders: true,
      checkinReminders: true,
    },
    categories,
    accounts: [
      {
        id: 'cash',
        name: 'Готівка',
        kind: 'cash',
        currency: 'UAH',
        balanceMinor: 840000,
        asOf: new Date(now).toISOString(),
        monoId: null,
        source: 'demo',
      },
      {
        id: 'bank',
        name: 'Картка · демонстрація',
        kind: 'bank',
        currency: 'UAH',
        balanceMinor: 1265000,
        asOf: new Date(now).toISOString(),
        monoId: null,
        source: 'demo',
      },
      {
        id: 'mono:demo',
        name: 'Monobank · кредитна картка (демо)',
        kind: 'mono',
        currency: 'UAH',
        balanceMinor: -190000,
        availableMinor: 510000,
        creditLimitMinor: 700000,
        creditLimitSource: 'bank',
        asOf: new Date(now).toISOString(),
        monoId: 'demo',
        source: 'demo',
      },
    ],
    policies: [
      {
        id: 'initial',
        effectiveAt: '1970-01-01T00:00:00.000Z',
        fareBps: 5000,
        commissionBps: 5000,
        fuelBps: 5000,
        tipsBps: 5000,
        thresholdMinor: 2700000,
        bonusFareBps: 5500,
      },
    ],
    transactions: [],
    taxiEntries: [],
    taxiWeeks: [],
    settlements: [],
    reserveMinor: 0,
    goals: [
      {
        id: 'laptop',
        name: 'Ноутбук для навчання',
        targetMinor: 4500000,
        deadline: shiftDate(today, 120),
        status: 'active',
      },
    ],
    goalMoves: [
      {
        id: 'seed-goal',
        goalId: 'laptop',
        accountId: 'bank',
        amountMinor: 300000,
        at: new Date(now).toISOString(),
      },
    ],
    budgets: [
      {
        id: 'groceries',
        category: 'Продукти на місяць',
        categories: ['продукти'],
        purpose: 'expense',
        period: 'month',
        limitMinor: 500000,
        shareBps: null,
        incomeBaseMinor: null,
      },
      {
        id: 'food',
        category: 'Їжа поза домом',
        categories: ['кафе й ресторани'],
        purpose: 'expense',
        period: 'day',
        limitMinor: 35000,
        shareBps: null,
        incomeBaseMinor: null,
      },
    ],
    payments: [
      {
        id: 'internet',
        name: 'Домашній інтернет',
        kind: 'subscription',
        amountMinor: 30000,
        remainingMinor: null,
        installmentsLeft: null,
        nextDate: shiftDate(today, 2),
        anchorDay: Number(shiftDate(today, 2).slice(8)),
        recurrence: 'month',
        category: 'звʼязок та інтернет',
        remindDays: 3,
        status: 'active',
      },
      {
        id: 'phone',
        name: 'Оплата частинами · телефон',
        kind: 'installment',
        amountMinor: 250000,
        remainingMinor: 1500000,
        installmentsLeft: 6,
        nextDate: shiftDate(today, 8),
        anchorDay: Number(shiftDate(today, 8).slice(8)),
        recurrence: 'month',
        category: 'техніка',
        remindDays: 3,
        status: 'active',
      },
    ],
    detectedSubscriptions: [],
  };
  for (let i = 0; i < 14; i++) {
    const at = new Date(
      i === 0 ? now - 300000 : kyivInstant(shiftDate(today, -i), 18),
    ).toISOString();
    const amount = -(12000 + (i % 4) * 4800);
    f.transactions.push({
      id: `sample-expense-${i}`,
      at,
      amountMinor: amount,
      amountUah: amount,
      currency: 'UAH',
      category: i % 2 ? 'продукти' : 'кафе й ресторани',
      description: i % 2 ? 'Продукти на кілька днів' : 'Обід та кава',
      kind: 'expense',
      accountId: i % 2 ? 'bank' : 'cash',
      bank: false,
      reference: null,
    });
  }
  // A sample workday before the current instant; history is visibly demo data.
  const at = new Date(now - 3600000).toISOString();
  f.taxiEntries.push({
    id: 'sample-shift',
    at,
    policyId: 'initial',
    netCashMinor: 400000,
    commissionMinor: 70000,
    fuelMinor: 100000,
    tipsMinor: 20000,
    directMinor: 0,
    receivedCashMinor: 260000,
    paidWorkMinor: 0,
    commissionReported: true,
    cashReported: true,
    accountId: 'cash',
    note: 'Демонстраційна зміна; пальне з картки парку',
    revision: 0,
  });
  return rebuild(f);
}
export function readFinanceDemo(): Finance {
  if (!memory) {
    try {
      const saved = financeSchema.safeParse(JSON.parse(localStorage.getItem(KEY) ?? 'null'));
      memory = saved.success ? saved.data : seed();
    } catch {
      memory = seed();
    }
  }
  return structuredClone(rebuild(memory));
}
export function resetFinanceDemo() {
  memory = seed();
  applied.clear();
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* unavailable */
  }
}

export function writeFinanceDemo(command: FinanceCommand) {
  if (applied.has(command.id)) return;
  const f = readFinanceDemo();
  if (f.version !== command.version) throw new Error('Дані змінилися. Онови екран.');
  const p = command.payload,
    id = command.id,
    now = new Date().toISOString();
  const str = (key: string) => String(p[key] ?? '');
  const num = (key: string) => Number(p[key] ?? 0);
  const account = f.accounts.find((a) => a.id === p.accountId);
  const tx = (
    amount: number,
    kind: string,
    accountId: string,
    suffix = '',
    reference: string | null = null,
  ) => {
    f.transactions.unshift({
      id: `${id}${suffix}`,
      at: str('at') || now,
      amountMinor: amount,
      amountUah: amount,
      currency: 'UAH',
      kind,
      category: str('category') || 'таксі',
      description: str('description') || str('name') || 'Операція',
      accountId,
      bank: false,
      reference,
    });
    const a = f.accounts.find((a) => a.id === accountId);
    if (a) a.balanceMinor = (a.balanceMinor ?? 0) + amount;
  };
  switch (command.type) {
    case 'credit-limit': {
      if (!account || account.kind !== 'mono') throw new Error('Обери картку Monobank');
      account.creditLimitMinor = p.creditLimitMinor === null ? 700000 : num('creditLimitMinor');
      account.creditLimitSource = p.creditLimitMinor === null ? 'bank' : 'manual';
      account.balanceMinor = (account.availableMinor ?? 0) - account.creditLimitMinor;
      break;
    }
    case 'account-balance': {
      if (!account || account.kind === 'mono') throw new Error('Обери рахунок ручного обліку');
      tx(num('balanceMinor') - (account.balanceMinor ?? 0), 'adjustment', account.id);
      break;
    }
    case 'taxi-personal-income': {
      if (!account || account.kind !== 'cash') throw new Error('Обери готівку');
      const descriptions: Record<string, string> = {
        change: 'Клієнт не забрав решту',
        'cash-tip': 'Готівкові чайові',
        direct: 'Замовлення поза застосунком',
        other: 'Інший особистий дохід таксі',
      };
      if (!descriptions[str('personalType')] || num('amountMinor') <= 0)
        throw new Error('Перевір тип і суму');
      tx(num('amountMinor'), 'income', account.id);
      f.transactions[0].personalTaxiType = str('personalType');
      f.transactions[0].category = 'таксі · особисте';
      f.transactions[0].description = descriptions[str('personalType')];
      break;
    }
    case 'bank-transfer': {
      const bank = f.transactions.find((t) => t.id === p.transactionId);
      if (
        !bank?.bank ||
        bank.bankHold ||
        bank.reference ||
        bank.currency !== 'UAH' ||
        !bank.amountMinor ||
        !account ||
        account.kind === 'mono'
      )
        throw new Error('Обери непов’язану операцію банку та ручний рахунок');
      const old = p.manualTransactionId
        ? f.transactions.find((t) => t.id === p.manualTransactionId)
        : null;
      if (
        p.manualTransactionId &&
        (!old ||
          old.bank ||
          old.reference ||
          old.kind !== 'transfer' ||
          old.accountId !== account.id ||
          old.amountMinor !== -bank.amountMinor)
      )
        throw new Error('Обери протилежну ручну операцію переказу');
      if (old) old.reference = bank.id;
      else {
        tx(-bank.amountMinor, 'transfer', account.id, ':counter', bank.id);
        f.transactions[0].at = bank.at;
      }
      bank.kind = 'transfer';
      bank.reference = id;
      bank.category = 'перекази й готівка';
      break;
    }
    case 'transaction': {
      if (!account) throw new Error('Обери рахунок');
      const kind = str('kind'),
        amount = num('amountMinor');
      tx(kind === 'expense' || kind === 'transfer' ? -amount : amount, kind, account.id);
      if (kind === 'transfer') tx(amount, kind, str('toAccountId'), ':to');
      break;
    }
    case 'transaction-edit': {
      const old = f.transactions.find((t) => t.id === p.transactionId);
      if (!old || old.bank || old.reference || !['expense', 'income'].includes(old.kind))
        throw new Error('Можна редагувати лише ручні витрати й надходження');
      const amount = num('amountMinor');
      if (amount <= 0) throw new Error('Вкажи правильну суму');
      const balance = f.accounts.find((a) => a.id === old.accountId);
      const corrected = str('kind') === 'expense' ? -amount : amount;
      if (balance?.balanceMinor != null) balance.balanceMinor += corrected - old.amountMinor;
      old.amountMinor = corrected;
      old.amountUah = corrected;
      old.kind = str('kind');
      old.category = str('category');
      old.description = str('description');
      break;
    }
    case 'account':
      f.accounts.push({
        id,
        name: str('name'),
        kind: str('kind') as 'cash' | 'bank',
        currency: 'UAH',
        balanceMinor: num('openingMinor'),
        asOf: now,
        monoId: null,
        source: 'demo',
      });
      break;
    case 'settings':
      f.settings = {
        incomePeriod: str('incomePeriod') as 'week' | 'month',
        taxiVisible: Boolean(p.taxiVisible),
        paymentReminders: Boolean(p.paymentReminders ?? f.settings.paymentReminders),
        checkinReminders: Boolean(p.checkinReminders ?? f.settings.checkinReminders),
      };
      f.categories = [...new Set([...categories, ...(p.categories as string[])])];
      break;
    case 'taxi-entry':
    case 'taxi-edit': {
      const previous =
        command.type === 'taxi-edit' ? f.taxiEntries.find((e) => e.id === p.entryId) : undefined;
      if (command.type === 'taxi-edit' && !previous) throw new Error('Запис не знайдено');
      if (previous) {
        if (f.settlements.some((s) => s.weekKey === taxiWeek(Date.parse(previous.at)).key))
          throw new Error('Розраховану зміну вже не можна змінити');
        tx(
          -(previous.receivedCashMinor - previous.paidWorkMinor),
          'taxi-custody',
          previous.accountId!,
          ':reverse',
          previous.id,
        );
        f.taxiEntries = f.taxiEntries.filter((e) => e.id !== previous.id);
      }
      const policy = f.policies.filter((s) => s.effectiveAt <= str('at')).at(-1)!;
      f.taxiEntries.unshift({
        id: previous?.id ?? id,
        at: str('at'),
        policyId: policy.id,
        netCashMinor: num('netCashMinor'),
        commissionMinor: num('commissionMinor'),
        fuelMinor: num('fuelMinor'),
        tipsMinor: num('tipsMinor'),
        directMinor: num('directMinor'),
        receivedCashMinor: num('receivedCashMinor'),
        paidWorkMinor: num('paidWorkMinor'),
        commissionReported: !num('netCashMinor') || p.commissionMinor != null,
        cashReported:
          (!num('netCashMinor') && !num('tipsMinor') && !num('directMinor')) ||
          p.receivedCashMinor != null,
        accountId: str('accountId'),
        note: str('note'),
        revision: previous ? previous.revision + 1 : 0,
      });
      if (num('receivedCashMinor') || num('paidWorkMinor'))
        tx(
          num('receivedCashMinor') - num('paidWorkMinor'),
          'taxi-custody',
          str('accountId'),
          ':cash',
          id,
        );
      break;
    }
    case 'taxi-policy':
      f.policies.push({
        id,
        effectiveAt: str('effectiveAt'),
        fareBps: num('fareBps'),
        commissionBps: num('commissionBps'),
        fuelBps: num('fuelBps'),
        tipsBps: p.tipsBps == null ? 5000 : num('tipsBps'),
        thresholdMinor: p.thresholdMinor == null ? null : num('thresholdMinor'),
        bonusFareBps: num('bonusFareBps'),
      });
      f.policies.sort((a, b) => a.effectiveAt.localeCompare(b.effectiveAt));
      break;
    case 'taxi-settle': {
      const w = f.taxiWeeks.find((w) => w.key === p.weekKey);
      if (!w || !w.closed || w.settled || !w.complete)
        throw new Error('Тиждень ще відкритий, неповний або вже розрахований');
      const actual = p.amountMinor == null ? w.settlementMinor : num('amountMinor');
      const bankTx = p.transactionId ? f.transactions.find((t) => t.id === p.transactionId) : null;
      if (
        p.transactionId &&
        (!bankTx ||
          !bankTx.bank ||
          bankTx.bankHold ||
          bankTx.reference ||
          bankTx.currency !== 'UAH' ||
          bankTx.amountMinor !== actual)
      )
        throw new Error('Обери непов’язаний банківський розрахунок із точною сумою');
      f.settlements.push({
        id,
        weekKey: w.key,
        amountMinor: actual,
        expectedMinor: w.settlementMinor,
        transactionId: bankTx?.id ?? null,
        note: str('note'),
        accountId: bankTx?.accountId ?? str('accountId'),
        at: now,
      });
      if (bankTx) {
        bankTx.kind = 'taxi-settlement';
        bankTx.reference = w.key;
        bankTx.category = 'таксі';
      } else if (actual) tx(actual, 'taxi-settlement', str('accountId'), ':settlement', w.key);
      break;
    }
    case 'taxi-settlement-edit': {
      const old = f.settlements.find((w) => w.weekKey === p.weekKey);
      if (!old || old.transactionId) throw new Error('Обери ручний розрахунок');
      const actual = num('amountMinor');
      if (actual !== old.amountMinor)
        tx(
          actual - old.amountMinor,
          'taxi-settlement',
          old.accountId,
          ':settlement-correction',
          old.weekKey,
        );
      old.expectedMinor ??= f.taxiWeeks.find((w) => w.key === old.weekKey)!.settlementMinor;
      old.amountMinor = actual;
      old.note = str('note');
      break;
    }
    case 'goal': {
      const old = f.goals.find((g) => g.id === p.goalId);
      const values = {
        id: old?.id ?? id,
        name: str('name'),
        targetMinor: num('targetMinor'),
        deadline: str('deadline') || null,
        status: str('status') || 'active',
        planAmountMinor: p.planAmountMinor == null ? null : num('planAmountMinor'),
        planPeriod: (p.planAmountMinor == null ? null : str('planPeriod')) as
          'day' | 'week' | 'month' | null,
      };
      if (old) Object.assign(old, values);
      else f.goals.push(values);
      break;
    }
    case 'goal-move': {
      const bank = p.transactionId ? f.transactions.find((t) => t.id === p.transactionId) : null;
      const kind = bank || p.movementKind === 'external' ? 'external' : 'reserve';
      const amount = num('amountMinor');
      if (
        p.transactionId &&
        (!bank?.bank ||
          bank.bankHold ||
          bank.reference ||
          bank.currency !== 'UAH' ||
          bank.amountMinor !== -amount)
      )
        throw new Error('Обери непов’язану операцію банки з точною сумою');
      const accountId = bank?.accountId ?? str('accountId');
      const allocated = sumMoney(
        f.goalMoves
          .filter(
            (m) =>
              m.goalId === p.goalId &&
              m.accountId === accountId &&
              (m.movementKind ?? 'reserve') === kind,
          )
          .map((m) => m.amountMinor),
      );
      if (!amount || allocated + amount < 0)
        throw new Error('Не можна повернути більше, ніж внесено цим способом');
      f.goalMoves.unshift({
        id,
        goalId: str('goalId'),
        accountId: accountId!,
        amountMinor: amount,
        at: bank?.at ?? now,
        movementKind: kind,
        transactionId: bank?.id ?? null,
      });
      if (bank) {
        bank.kind = 'transfer';
        bank.reference = `goal:${p.goalId}`;
        bank.category = 'заощадження';
      } else if (kind === 'external')
        tx(-amount, 'transfer', accountId!, ':goal', `goal:${p.goalId}`);
      break;
    }
    case 'budget': {
      const b = {
        id: str('budgetId') || id,
        category: str('category'),
        categories: p.categories as string[],
        purpose: str('purpose') as 'expense' | 'saving',
        period: str('period') as 'day' | 'week' | 'month',
        limitMinor: p.limitMinor == null ? null : num('limitMinor'),
        shareBps: p.shareBps == null ? null : num('shareBps'),
        incomeBaseMinor: p.incomeBaseMinor == null ? null : num('incomeBaseMinor'),
      };
      if (
        f.budgets.some((r) => r.category === b.category && r.period === b.period && r.id !== b.id)
      )
        throw new Error('Такий бюджет уже є');
      f.budgets = [...f.budgets.filter((r) => r.id !== b.id), b];
      break;
    }
    case 'budget-template': {
      if (f.budgets.some((b) => ['Основні витрати', 'Бажання', 'Заощадження'].includes(b.category)))
        throw new Error('Шаблон уже є. Відредагуй бюджети.');
      const needs = [
        'продукти',
        'транспорт',
        'авто',
        'дім',
        'звʼязок та інтернет',
        'здоровʼя',
        'освіта',
        'фінанси',
      ];
      [
        ['Основні витрати', 5000],
        ['Бажання', 3000],
        ['Заощадження', 2000],
      ].forEach(([name, bps], i) =>
        f.budgets.push({
          id: `${id}:${i}`,
          category: String(name),
          categories:
            i === 0
              ? needs
              : i === 1
                ? categories.filter(
                    (c) =>
                      !needs.includes(c) &&
                      !['дохід', 'зарплата', 'таксі', 'чайові', 'перекази й готівка'].includes(c),
                  )
                : [],
          purpose: i === 2 ? 'saving' : 'expense',
          period: 'month',
          limitMinor: null,
          shareBps: Number(bps),
          incomeBaseMinor: num('incomeBaseMinor'),
        }),
      );
      break;
    }
    case 'payment': {
      const previous = f.payments.find((s) => s.id === p.paymentId);
      if (
        p.totalMinor != null &&
        p.remainingMinor != null &&
        num('remainingMinor') > num('totalMinor')
      )
        throw new Error('Залишок не може перевищувати початкову суму');
      if (!Number.isInteger(num('rateBps')) || num('rateBps') < 0 || num('rateBps') > 30000)
        throw new Error('Некоректна річна ставка');
      if (num('feeMinor') >= num('amountMinor') || num('feeMinor') < 0)
        throw new Error('Перевір комісію та повний платіж');
      f.payments = [
        ...f.payments.filter((s) => s.id !== p.paymentId),
        {
          id: str('paymentId') || id,
          name: str('name'),
          kind: str('kind') as Finance['payments'][number]['kind'],
          amountMinor: num('amountMinor'),
          remainingMinor: p.remainingMinor == null ? null : num('remainingMinor'),
          installmentsLeft: p.installmentsLeft == null ? null : num('installmentsLeft'),
          nextDate: str('nextDate'),
          anchorDay: num('anchorDay'),
          recurrence: str('recurrence') as Finance['payments'][number]['recurrence'],
          category: str('category'),
          remindDays: num('remindDays'),
          status: str('status') || 'active',
          totalMinor: p.totalMinor == null ? null : num('totalMinor'),
          rateBps: num('rateBps'),
          feeMinor: num('feeMinor'),
          lender: str('lender'),
          note: str('note'),
          overpaymentTotalMinor:
            p.overpaymentTotalMinor == null ? null : num('overpaymentTotalMinor'),
          overpaymentRemainingMinor:
            p.overpaymentTotalMinor == null ? null : num('overpaymentRemainingMinor'),
          overpaymentPaidMinor:
            previous?.overpaymentPaidMinor ??
            (p.overpaymentTotalMinor == null
              ? 0
              : num('overpaymentTotalMinor') - num('overpaymentRemainingMinor')),
          termMonths:
            p.overpaymentTotalMinor == null && !p.interestMethod ? null : num('termMonths'),
          interestMethod: (p.interestMethod ??
            null) as Finance['payments'][number]['interestMethod'],
        },
      ];
      break;
    }
    case 'payment-cancel': {
      const pay = f.payments.find((s) => s.id === p.paymentId && s.status !== 'done');
      if (!pay || pay.kind !== 'subscription') throw new Error('Обери незавершену підписку');
      pay.status = 'done';
      break;
    }
    case 'payment-paid': {
      const pay = f.payments.find((s) => s.id === p.paymentId);
      if (!pay || pay.status !== 'active') throw new Error('Активний платіж не знайдено');
      const amount = num('amountMinor');
      if (
        pay.interestMethod &&
        p.close !== true &&
        p.principalMinor == null &&
        !interestDebtPayment(pay, amount)
      )
        throw new Error('Платіж має покривати відсотки й комісію; уточни тіло за банком');
      if (
        pay.remainingMinor != null &&
        (pay.rateBps ?? 0) > 0 &&
        !pay.interestMethod &&
        p.principalMinor == null
      )
        throw new Error('Вкажи погашення тіла кредиту');
      const principal =
        p.principalMinor == null
          ? p.close === true && (pay.overpaymentRemainingMinor != null || pay.interestMethod)
            ? (pay.remainingMinor ?? 0)
            : (fixedDebtPayment(pay, amount)?.principalMinor ??
              interestDebtPayment(pay, amount)?.principalMinor ??
              Math.max(0, amount - (pay.feeMinor ?? 0)))
          : num('principalMinor');
      if (principal > amount || (pay.remainingMinor != null && principal > pay.remainingMinor))
        throw new Error('Перевір частину платежу на погашення тіла');
      if (
        p.close === true &&
        (!['loan', 'installment', 'card-installment'].includes(pay.kind) ||
          pay.remainingMinor == null ||
          pay.remainingMinor === 0 ||
          principal !== pay.remainingMinor)
      )
        throw new Error('Для дострокового закриття потрібно погасити весь залишок тіла боргу');
      if (
        pay.overpaymentRemainingMinor != null &&
        p.close !== true &&
        amount - principal > pay.overpaymentRemainingMinor
      )
        throw new Error('Переплата перевищує погоджений залишок');
      const bankTx = p.transactionId ? f.transactions.find((t) => t.id === p.transactionId) : null;
      if (
        p.transactionId &&
        (!bankTx ||
          !bankTx.bank ||
          bankTx.bankHold ||
          bankTx.reference ||
          bankTx.currency !== 'UAH' ||
          bankTx.amountMinor !== -amount)
      )
        throw new Error('Обери непов’язаний завершений платіж');
      if (!bankTx) tx(-amount, 'expense', str('accountId'), ':payment', pay.id);
      const transaction = bankTx ?? f.transactions[0];
      transaction.kind = 'expense';
      transaction.reference = pay.id;
      transaction.category = pay.category;
      transaction.description = pay.name;
      if (pay.remainingMinor != null)
        pay.remainingMinor = Math.max(0, pay.remainingMinor - principal);
      if (pay.overpaymentRemainingMinor != null) {
        pay.overpaymentRemainingMinor =
          p.close === true ? 0 : pay.overpaymentRemainingMinor - (amount - principal);
        pay.overpaymentPaidMinor = (pay.overpaymentPaidMinor ?? 0) + amount - principal;
      }
      const fullyPaid = pay.remainingMinor === 0 && (pay.overpaymentRemainingMinor ?? 0) === 0;
      if (fullyPaid) pay.installmentsLeft = 0;
      else if (pay.installmentsLeft != null)
        pay.installmentsLeft = Math.max(0, pay.installmentsLeft - 1);
      if (
        fullyPaid ||
        (pay.remainingMinor == null && (pay.recurrence === 'once' || pay.installmentsLeft === 0))
      )
        pay.status = 'done';
      else if (pay.recurrence !== 'once')
        pay.nextDate = nextPaymentDate(pay.nextDate, pay.anchorDay, pay.recurrence);
      break;
    }
    case 'classify': {
      const t = f.transactions.find((t) => t.id === p.transactionId);
      if (t) {
        t.kind = str('kind');
        t.category = str('category');
      }
      break;
    }
    default:
      throw new Error('Невідома дія демо');
  }
  f.version++;
  memory = rebuild(f);
  applied.add(id);
  try {
    localStorage.setItem(KEY, JSON.stringify(memory));
  } catch {
    /* Session remains usable. */
  }
}
