import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Finance, FinanceCommand } from '../../api/finance-schema.ts';
import { postFinance } from '../../api/client.ts';
import { FINANCE_QUERY } from '../../api/finance-hooks.ts';
import {
  parseMoney,
  kyivInstant,
  kyivParts,
  taxiWeek,
} from '../../../../core/finance/planning.mjs';
import { haptic } from '../../telegram.ts';
import { Sheet } from '../ui/Sheet.tsx';
import { moneyLabel } from '../../lib/financeView.ts';
import { financeCategoryLabel } from '../../../../core/finance/categories.mjs';
import {
  PAYMENT_KIND_LABELS,
  isDebtKind,
  estimateRemaining,
} from '../../../../core/finance/payments.mjs';

export type FinanceFormKind =
  | 'expense'
  | 'income'
  | 'transfer'
  | 'adjustment'
  | 'account-balance'
  | 'credit-limit'
  | 'taxi-personal'
  | 'account'
  | 'taxi'
  | 'policy'
  | 'goal'
  | 'goal-move'
  | 'budget'
  | 'template'
  | 'payment'
  | 'payment-paid'
  | 'payment-close'
  | 'payment-cancel'
  | 'settings'
  | 'classify'
  | 'taxi-settle'
  | 'edit-transaction';
export interface FinanceFormRequest {
  kind: FinanceFormKind;
  id?: string;
}
const TITLES: Record<FinanceFormKind, string> = {
  expense: 'Записати витрату',
  income: 'Додати надходження',
  transfer: 'Переказ між рахунками',
  adjustment: 'Корекція залишку',
  'account-balance': 'Вказати поточний залишок',
  'credit-limit': 'Кредитний ліміт картки',
  'taxi-personal': 'Особистий дохід таксі',
  account: 'Додати рахунок',
  taxi: 'Записати зміну таксі',
  policy: 'Умови роботи таксі',
  goal: 'Нова фінансова ціль',
  'goal-move': 'Кошти на ціль',
  budget: 'Налаштувати бюджет',
  template: 'План 50 / 30 / 20',
  payment: 'Додати платіж',
  'payment-paid': 'Підтвердити оплату',
  'payment-close': 'Достроково погасити борг',
  'payment-cancel': 'Скасувати підписку',
  settings: 'Налаштування фінансів',
  classify: 'Категорія та тип операції',
  'taxi-settle': 'Розрахунок із парком',
  'edit-transaction': 'Уточнити операцію',
};

export function FinanceForm({
  request,
  finance: f,
  onClose,
  onOpenForm,
}: {
  request: FinanceFormRequest;
  finance: Finance;
  onClose: () => void;
  onOpenForm?: (request: FinanceFormRequest) => void;
}) {
  const query = useQueryClient();
  const today = kyivParts(Date.now());
  const budget = f.budgets.find((b) => b.id === request.id);
  const payment = f.payments.find((p) => p.id === request.id);
  const goal = request.kind === 'goal' ? f.goals.find((g) => g.id === request.id) : undefined;
  const transaction = f.transactions.find((t) => t.id === request.id);
  const selectedAccount = f.accounts.find((a) => a.id === request.id);
  const entry =
    request.kind === 'taxi' ? f.taxiEntries.find((e) => e.id === request.id) : undefined;
  const entryTime = entry ? kyivParts(Date.parse(entry.at)) : today;
  const policy = f.policies.filter((p) => Date.parse(p.effectiveAt) <= Date.now()).at(-1)!;
  const [v, setValues] = useState<Record<string, string>>({
    amount: goal
      ? String(goal.targetMinor / 100)
      : payment
        ? String(
            (request.kind === 'payment-close' && payment.remainingMinor != null
              ? payment.remainingMinor + (payment.feeMinor ?? 0)
              : request.kind === 'payment-paid' &&
                  payment.remainingMinor != null &&
                  (payment.rateBps ?? 0) === 0
                ? Math.min(payment.amountMinor, payment.remainingMinor + (payment.feeMinor ?? 0))
                : payment.amountMinor) / 100,
          )
        : request.kind === 'edit-transaction' && transaction
          ? String(Math.abs(transaction.amountMinor) / 100)
          : '',
    accountId:
      selectedAccount?.id ??
      entry?.accountId ??
      f.accounts.find((a) => a.kind === 'cash')?.id ??
      '',
    balance: '',
    credit:
      selectedAccount?.creditLimitMinor == null
        ? ''
        : String(selectedAccount.creditLimitMinor / 100),
    creditMode: selectedAccount?.creditLimitSource === 'bank' ? 'bank' : 'manual',
    personalType: 'change',
    toAccountId: f.accounts.find((a) => a.kind === 'bank')?.id ?? '',
    category: budget?.category ?? transaction?.category ?? payment?.category ?? 'продукти',
    name: goal?.name ?? budget?.category ?? payment?.name ?? '',
    goalStatus: goal?.status ?? 'active',
    description: request.kind === 'edit-transaction' ? (transaction?.description ?? '') : '',
    date: entryTime.date,
    time: `${String(entryTime.hour).padStart(2, '0')}:${String(entryTime.minute).padStart(2, '0')}`,
    cash: entry ? String(entry.netCashMinor / 100) : '',
    commission: entry?.commissionReported ? String(entry.commissionMinor / 100) : '',
    fuel: entry ? String(entry.fuelMinor / 100) : '',
    received: entry?.cashReported ? String(entry.receivedCashMinor / 100) : '',
    tips: entry ? String(entry.tipsMinor / 100) : '',
    direct: entry ? String(entry.directMinor / 100) : '',
    paidWork: entry?.paidWorkMinor ? String(entry.paidWorkMinor / 100) : '',
    note: entry?.note ?? '',
    opening: '',
    accountKind: 'bank',
    goalId: request.id ?? f.goals[0]?.id ?? '',
    direction: 'add',
    purpose: budget?.purpose ?? 'expense',
    period: budget?.period ?? 'month',
    budgetMode: budget?.shareBps != null ? 'percent' : 'fixed',
    limit: budget?.limitMinor != null ? String(budget.limitMinor / 100) : '',
    percent: budget?.shareBps != null ? String(budget.shareBps / 100) : '',
    base: budget?.incomeBaseMinor != null ? String(budget.incomeBaseMinor / 100) : '',
    categories: (budget?.categories ?? ['продукти']).join('|'),
    paymentKind: payment?.kind ?? 'subscription',
    nextDate: goal?.deadline ?? payment?.nextDate ?? today.date,
    recurrence: payment?.recurrence ?? 'month',
    anchorDay: String(payment?.anchorDay ?? Number(today.date.slice(8))),
    remaining: payment?.remainingMinor == null ? '' : String(payment.remainingMinor / 100),
    remainingMode: payment ? 'manual' : 'auto',
    months: payment?.installmentsLeft == null ? '' : String(payment.installmentsLeft),
    total: payment?.totalMinor == null ? '' : String(payment.totalMinor / 100),
    rate: String((payment?.rateBps ?? 0) / 100),
    fee: String((payment?.feeMinor ?? 0) / 100),
    lender: payment?.lender ?? '',
    paymentNote: payment?.note ?? '',
    principal:
      request.kind === 'payment-close' && payment?.remainingMinor != null
        ? String(payment.remainingMinor / 100)
        : '',
    remindDays: String(payment?.remindDays ?? 3),
    paymentStatus: payment?.status ?? 'active',
    paymentMode: 'manual',
    bankTransactionId: '',
    incomePeriod: f.settings.incomePeriod,
    taxiVisible: String(f.settings.taxiVisible),
    paymentReminders: String(f.settings.paymentReminders),
    checkinReminders: String(f.settings.checkinReminders),
    newCategory: '',
    fare: String(policy.fareBps / 100),
    feeShare: String(policy.commissionBps / 100),
    fuelShare: String(policy.fuelBps / 100),
    tipsShare: String(policy.tipsBps / 100),
    threshold: policy.thresholdMinor == null ? '' : String(policy.thresholdMinor / 100),
    bonus: String(policy.bonusFareBps / 100),
    effective: 'now',
    policyPreset: 'custom',
    transactionKind:
      transaction?.amountMinor != null && transaction.amountMinor < 0 ? 'expense' : 'income',
  });
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const attempt = useRef<{ fingerprint: string; command: FinanceCommand } | null>(null);
  const set = (key: string, value: string) =>
    setValues((prev) => {
      const next = { ...prev, [key]: value };
      if (key === 'nextDate' && request.kind === 'payment' && value)
        next.anchorDay = String(Number(value.slice(8)));
      if (key === 'paymentKind' && !payment) {
        if (value === 'installment') next.category = 'покупка частинами';
        if (value === 'card-installment') next.category = 'розстрочка';
      }
      if (key === 'remainingMode' && value === 'manual' && !prev.remaining) {
        try {
          const estimate = estimateRemaining(
            parseMoney(prev.amount),
            Number(prev.months),
            parseMoney(prev.fee || '0'),
            parseMoney(prev.rate || '0'),
          );
          if (estimate != null) next.remaining = String(estimate / 100);
        } catch {
          /* Incomplete inputs stay empty. */
        }
      }
      return next;
    });
  let automaticRemaining: number | null = null;
  try {
    automaticRemaining = estimateRemaining(
      parseMoney(v.amount),
      Number(v.months),
      parseMoney(v.fee || '0'),
      parseMoney(v.rate || '0'),
    );
  } catch {
    /* Calculation resumes when all numeric inputs are valid. */
  }
  const field = (key: string, label: string, type = 'text', placeholder = '') => (
    <label className="renewal-field" key={key}>
      {label}
      <input
        disabled={pending}
        type={type}
        inputMode={
          type === 'text' &&
          [
            'amount',
            'opening',
            'balance',
            'credit',
            'cash',
            'commission',
            'fuel',
            'received',
            'tips',
            'direct',
            'paidWork',
            'limit',
            'base',
            'remaining',
            'threshold',
            'total',
            'rate',
            'fee',
            'principal',
          ].includes(key)
            ? 'decimal'
            : undefined
        }
        maxLength={type === 'text' ? 300 : undefined}
        readOnly={key === 'remaining' && v.remainingMode === 'auto'}
        value={
          key === 'remaining' && v.remainingMode === 'auto'
            ? automaticRemaining == null
              ? ''
              : String(automaticRemaining / 100)
            : v[key]
        }
        onChange={(e) => set(key, e.target.value)}
        placeholder={placeholder}
      />
    </label>
  );
  const select = (key: string, label: string, options: Array<[string, string]>) => (
    <label className="renewal-field" key={key}>
      {label}
      <select disabled={pending} value={v[key]} onChange={(e) => set(key, e.target.value)}>
        {options.map(([id, label]) => (
          <option key={id} value={id}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
  const accountOptions = f.accounts
    .filter((a) => a.currency === 'UAH' && (request.kind === 'goal-move' || a.kind !== 'mono'))
    .map((a): [string, string] => [a.id, a.name]);
  const category = () =>
    select(
      'category',
      'Категорія',
      f.categories.map((c) => [c, financeCategoryLabel(c)]),
    );
  const account = () => select('accountId', 'Рахунок', accountOptions);
  const inputMoney = (key: string, optional = false, signed = false) =>
    optional && !v[key].trim() ? 0 : parseMoney(v[key], signed);
  const bps = (key: string) => {
    const n = parseMoney(v[key]);
    if (n > 10000) throw new Error('Частка має бути від 0 до 100%');
    return n;
  };
  const at = () => {
    if (
      !entry &&
      v.date === today.date &&
      v.time === `${String(today.hour).padStart(2, '0')}:${String(today.minute).padStart(2, '0')}`
    )
      return new Date().toISOString();
    const [h, m] = v.time.split(':').map(Number);
    if (!Number.isInteger(h) || !Number.isInteger(m) || m < 0 || m > 59)
      throw new Error('Вкажи час');
    return new Date(kyivInstant(v.date, h) + m * 60000).toISOString();
  };
  const submit = async () => {
    setError('');
    let type = request.kind as string;
    const p: Record<string, unknown> = {};
    try {
      if (['expense', 'income', 'transfer', 'adjustment'].includes(request.kind)) {
        type = 'transaction';
        Object.assign(p, {
          kind: request.kind,
          accountId: v.accountId,
          amountMinor: inputMoney('amount', false, request.kind === 'adjustment'),
          category: v.category,
          description: v.description || v.category,
          at: at(),
        });
        if (request.kind === 'transfer') p.toAccountId = v.toAccountId;
      } else if (request.kind === 'account-balance') {
        type = 'account-balance';
        Object.assign(p, {
          accountId: v.accountId,
          balanceMinor: inputMoney('balance', false, true),
        });
      } else if (request.kind === 'credit-limit') {
        type = 'credit-limit';
        Object.assign(p, {
          accountId: request.id,
          creditLimitMinor: v.creditMode === 'bank' ? null : inputMoney('credit'),
        });
      } else if (request.kind === 'taxi-personal') {
        type = 'taxi-personal-income';
        Object.assign(p, {
          accountId: v.accountId,
          amountMinor: inputMoney('amount'),
          personalType: v.personalType,
          at: at(),
        });
      } else if (request.kind === 'edit-transaction') {
        type = 'transaction-edit';
        Object.assign(p, {
          transactionId: request.id,
          kind: v.transactionKind,
          amountMinor: inputMoney('amount'),
          category: v.category,
          description: v.description || v.category,
        });
      } else if (request.kind === 'account')
        Object.assign(p, {
          name: v.name,
          kind: v.accountKind,
          openingMinor: inputMoney('opening', false, true),
        });
      else if (request.kind === 'taxi') {
        type = entry ? 'taxi-edit' : 'taxi-entry';
        Object.assign(p, {
          entryId: entry?.id,
          at: at(),
          accountId: v.accountId,
          netCashMinor: inputMoney('cash', true),
          commissionMinor: v.commission.trim() ? inputMoney('commission') : undefined,
          fuelMinor: inputMoney('fuel', true),
          receivedCashMinor: v.received.trim() ? inputMoney('received') : undefined,
          tipsMinor: inputMoney('tips', true),
          directMinor: inputMoney('direct', true),
          paidWorkMinor: inputMoney('paidWork', true),
          note: v.note,
        });
      } else if (request.kind === 'policy') {
        type = 'taxi-policy';
        const fixed = v.policyPreset === 'hybrid';
        Object.assign(p, {
          effectiveAt: new Date(
            v.effective === 'nextWeek' ? taxiWeek(Date.now()).to : Date.now(),
          ).toISOString(),
          fareBps: fixed ? 5000 : bps('fare'),
          commissionBps: fixed ? 5000 : bps('feeShare'),
          fuelBps: fixed ? 5000 : bps('fuelShare'),
          tipsBps: fixed ? 5000 : bps('tipsShare'),
          thresholdMinor: fixed || !v.threshold ? null : inputMoney('threshold'),
          bonusFareBps: fixed ? 5000 : bps('bonus'),
        });
      } else if (request.kind === 'goal')
        Object.assign(p, {
          goalId: goal?.id,
          name: v.name,
          targetMinor: inputMoney('amount'),
          deadline: v.nextDate || null,
          status: v.goalStatus,
        });
      else if (request.kind === 'goal-move')
        Object.assign(p, {
          goalId: v.goalId,
          accountId: v.accountId,
          amountMinor: inputMoney('amount') * (v.direction === 'return' ? -1 : 1),
        });
      else if (request.kind === 'budget')
        Object.assign(p, {
          budgetId: request.id,
          category: v.name || v.category,
          categories: v.categories ? v.categories.split('|') : [],
          purpose: v.purpose,
          period: v.period,
          limitMinor: v.budgetMode === 'fixed' ? inputMoney('limit') : null,
          shareBps: v.budgetMode === 'percent' ? bps('percent') : null,
          incomeBaseMinor: v.budgetMode === 'percent' ? inputMoney('base') : null,
        });
      else if (request.kind === 'template') {
        type = 'budget-template';
        p.incomeBaseMinor = inputMoney('base');
      } else if (request.kind === 'payment') {
        if (isDebtKind(v.paymentKind) && v.remainingMode === 'auto' && automaticRemaining == null)
          throw new Error(
            'Вкажи платіж і кількість без відсотків або обери точний залишок із банку',
          );
        Object.assign(p, {
          paymentId: request.id,
          name: v.name,
          kind: v.paymentKind,
          amountMinor: inputMoney('amount'),
          remainingMinor: isDebtKind(v.paymentKind)
            ? v.remainingMode === 'auto'
              ? automaticRemaining
              : v.remaining
                ? inputMoney('remaining')
                : null
            : null,
          installmentsLeft: isDebtKind(v.paymentKind) && v.months ? Number(v.months) : null,
          nextDate: v.nextDate,
          anchorDay: Number(v.anchorDay),
          recurrence: v.recurrence,
          category: v.category,
          remindDays: Number(v.remindDays),
          status: v.paymentStatus,
          totalMinor: v.total ? inputMoney('total') : null,
          rateBps: inputMoney('rate'),
          feeMinor: inputMoney('fee'),
          lender: v.lender,
          note: v.paymentNote,
        });
      } else if (request.kind === 'payment-cancel') {
        Object.assign(p, { paymentId: request.id });
      } else if (request.kind === 'payment-paid' || request.kind === 'payment-close') {
        type = 'payment-paid';
        const bank =
          v.paymentMode === 'bank'
            ? f.transactions.find((t) => t.id === v.bankTransactionId)
            : null;
        if (v.paymentMode === 'bank' && !bank) throw new Error('Обери банківську операцію');
        Object.assign(p, {
          paymentId: request.id,
          amountMinor: bank ? -bank.amountMinor : inputMoney('amount'),
          accountId: v.accountId,
          transactionId: bank?.id,
          principalMinor: v.principal ? inputMoney('principal') : undefined,
          close: request.kind === 'payment-close',
        });
      } else if (request.kind === 'settings')
        Object.assign(p, {
          incomePeriod: v.incomePeriod,
          taxiVisible: v.taxiVisible === 'true',
          paymentReminders: v.paymentReminders === 'true',
          checkinReminders: v.checkinReminders === 'true',
          categories: [
            ...new Set([...f.categories, ...(v.newCategory.trim() ? [v.newCategory.trim()] : [])]),
          ],
        });
      else if (request.kind === 'classify')
        Object.assign(p, {
          transactionId: request.id,
          kind: v.transactionKind,
          category: v.category,
        });
      else if (request.kind === 'taxi-settle') {
        if (v.paymentMode === 'bank' && !v.bankTransactionId)
          throw new Error('Обери банківську операцію');
        Object.assign(p, {
          weekKey: request.id,
          accountId: v.accountId,
          transactionId: v.paymentMode === 'bank' ? v.bankTransactionId : undefined,
        });
      }
      const fingerprint = JSON.stringify({ request, v });
      if (attempt.current?.fingerprint !== fingerprint)
        attempt.current = {
          fingerprint,
          command: { id: crypto.randomUUID(), version: f.version, type, payload: p },
        };
      setPending(true);
      await postFinance(attempt.current.command);
      await query.invalidateQueries({ queryKey: FINANCE_QUERY });
      haptic('success');
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не вдалося зберегти. Повтори дію.');
      // A known validation/conflict permits editing; an uncertain network
      // attempt keeps its id for an identical retry.
      if (
        e instanceof Error &&
        /Дані змінилися|Некорект|Обери|Вкажи|вже|Сума|Частка/.test(e.message)
      )
        attempt.current = null;
      await query.invalidateQueries({ queryKey: FINANCE_QUERY });
    } finally {
      setPending(false);
    }
  };
  const kind = request.kind;
  const close = () => {
    if (!pending) onClose();
  };
  const title = entry
    ? 'Уточнити зміну таксі'
    : goal
      ? 'Налаштувати ціль'
      : kind === 'payment' && payment
        ? 'Налаштувати платіж'
        : TITLES[kind];
  return (
    <Sheet label={title} onClose={close}>
      <div className="renewal-finance renewal-sheet-content">
        <div className="renewal-section-head">
          <h2 className="text-xl font-bold tracking-tight">{title}</h2>
          <button
            type="button"
            className="renewal-secondary"
            onClick={close}
            disabled={pending}
            aria-label="Закрити"
          >
            ×
          </button>
        </div>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {['expense', 'income', 'transfer', 'adjustment'].includes(kind) && (
            <>
              {field(
                'amount',
                kind === 'adjustment' ? 'Зміна залишку, ₴ (можна зі знаком −)' : 'Сума, ₴',
              )}
              {account()}
              {kind === 'transfer'
                ? select('toAccountId', 'На рахунок', accountOptions)
                : kind !== 'adjustment'
                  ? category()
                  : null}
              {field('description', 'Опис або причина')}
              <details>
                <summary className="renewal-link cursor-pointer">Дата й час</summary>
                <div className="renewal-form-grid mt-3">
                  {field('date', 'Дата', 'date')}
                  {field('time', 'Час · Київ', 'time')}
                </div>
              </details>
              <p className="renewal-muted">
                {kind === 'adjustment'
                  ? 'Корекція змінює баланс, але не вважається заробітком.'
                  : kind === 'transfer'
                    ? 'Переказ змінює два залишки, але не збільшує доходи й витрати.'
                    : 'Операції Monobank надходять автоматично. Тут записуються готівка та рахунки ручного обліку.'}
              </p>
            </>
          )}
          {kind === 'account-balance' && (
            <>
              {account()}
              {field(
                'balance',
                'Скільки зараз є на цьому рахунку, ₴',
                'text',
                'Повна сума, також зі знаком −',
              )}
              <p className="renewal-muted">
                Вкажи весь фактичний залишок, а не суму поповнення. Це не дохід. Спочатку додай
                минулі зміни та витрати, потім звір готівку — гроші за ці зміни вже можуть бути в
                тебе на руках.
              </p>
            </>
          )}
          {kind === 'credit-limit' && (
            <>
              <p className="font-bold">{selectedAccount?.name}</p>
              {select('creditMode', 'Як визначати ліміт', [
                ['bank', 'Автоматично з Monobank'],
                ['manual', 'Вкажу поточний ліміт сам'],
              ])}
              {v.creditMode === 'manual' &&
                field('credit', 'Повний кредитний ліміт, ₴', 'text', 'Наприклад, 7000')}
              <p className="renewal-muted">
                Власний баланс = доступний баланс банку мінус повний кредитний ліміт. Наприклад: 5
                100 − 7 000 = −1 900 ₴. Ліміт не є доходом і не входить у вільні кошти. Ручне
                значення діє, доки ти його не зміниш або не повернеш автоматичне визначення.
              </p>
            </>
          )}
          {kind === 'taxi-personal' && (
            <>
              {select('personalType', 'Що сталося', [
                ['change', 'Клієнт не забрав решту'],
                ['cash-tip', 'Чайові готівкою'],
                ['direct', 'Замовлення поза застосунком'],
                ['other', 'Інший особистий дохід'],
              ])}
              {field('amount', 'Скільки отримав особисто, ₴')}
              {select(
                'accountId',
                'Куди поклав гроші',
                f.accounts
                  .filter((a) => a.kind === 'cash' && a.currency === 'UAH')
                  .map((a) => [a.id, a.name]),
              )}
              <details>
                <summary className="renewal-link cursor-pointer">Дата й час</summary>
                <div className="renewal-form-grid mt-3">
                  {field('date', 'Дата', 'date')}
                  {field('time', 'Час · Київ', 'time')}
                </div>
              </details>
              <p className="renewal-muted">
                Це повністю твої гроші: вони додаються до готівки й особистих доходів. Не включай їх
                повторно в касу, готівку зміни чи чайові в застосунку — розрахунок із парком не
                змінюється.
              </p>
            </>
          )}
          {kind === 'edit-transaction' && (
            <>
              <p className="renewal-muted">
                {transaction?.at.slice(0, 10)} ·{' '}
                {f.accounts.find((a) => a.id === transaction?.accountId)?.name}. Уточнення оновить
                баланс і бюджети. Попередні дані зберігаються в історії обліку.
              </p>
              {select('transactionKind', 'Тип', [
                ['expense', 'Витрата'],
                ['income', 'Надходження'],
              ])}
              {field('amount', 'Правильна сума, ₴')}
              {category()}
              {field('description', 'Опис')}
            </>
          )}
          {kind === 'account' && (
            <>
              {field('name', 'Назва рахунку')}
              {select('accountKind', 'Тип', [
                ['bank', 'Банківський · ручний облік'],
                ['cash', 'Готівка'],
              ])}
              {field('opening', 'Початковий залишок, ₴ (також від’ємний)')}
              <p className="renewal-muted">
                Початковий залишок не є доходом. Підключена картка Monobank відображається окремо з
                банківським балансом.
              </p>
            </>
          )}
          {kind === 'taxi' && (
            <>
              <div className="renewal-form-grid">
                {field('date', 'Дата запису', 'date')}
                {field('time', 'Час · Київ', 'time')}
              </div>
              {field('cash', 'Каса після комісії, ₴', 'text', 'Наприклад, 4000')}
              <div className="renewal-form-grid">
                {field('commission', 'Комісія, ₴', 'text', '700')}
                {field('fuel', 'Пальне з картки парку, ₴', 'text', '0 або 1000')}
              </div>
              {field('received', 'Отримана готівка, ₴', 'text', 'Фактично від клієнтів')}
              {account()}
              <p className="renewal-muted">
                Каса й готівка — різні цифри. Комісія та пальне зменшують заробіток за формулою, без
                окремого списання з особистого рахунку. У готівці вкажи лише гроші за поїздки через
                застосунок. Особисті надходження, записані швидкою кнопкою, сюди повторно не
                додавай.
              </p>
              <details>
                <summary className="renewal-link cursor-pointer">
                  Чайові в застосунку та додаткові дані
                </summary>
                <div className="flex flex-col gap-3 pt-3">
                  {field('tips', 'Чайові через застосунок, ₴')}
                  <p className="renewal-muted">
                    Лише окремо показані чайові через застосунок. Частка визначається умовами,
                    чинними на дату зміни. Готівкові чайові записуй швидкою кнопкою «Особистий
                    дохід».
                  </p>
                  {entry &&
                    entry.directMinor > 0 &&
                    field('direct', 'Прямі замовлення в старому записі, ₴')}
                  {field('paidWork', 'Робочі витрати, сплачені особисто з обраного рахунку, ₴')}
                  <p className="renewal-muted">
                    Для паливної картки парку залиш порожнім. Це поле списує кошти з ручного рахунку
                    й враховує їх у розрахунку з парком; не дублюй ту саму витрату окремою
                    операцією.
                  </p>
                  {field('note', 'Нотатка')}
                </div>
              </details>
              <p className="renewal-muted">
                Можна записати лише пальне або частину даних. Якщо для каси ще не вказано комісію чи
                отриману готівку, підсумок буде попереднім. Доповни цей запис пізніше через
                «Уточнити».
              </p>
            </>
          )}
          {kind === 'policy' && (
            <>
              {select('policyPreset', 'Профіль', [
                ['custom', 'Власні умови'],
                ['hybrid', 'Гібрид · завжди 50/50'],
              ])}
              {v.policyPreset === 'custom' && (
                <>
                  <div className="renewal-form-grid">
                    {field('fare', 'Моя частка каси, %')}
                    {field('feeShare', 'Моя частка комісії, %')}
                    {field('fuelShare', 'Моя частка пального, %')}
                    {field('tipsShare', 'Моя частка чайових через застосунок, %')}
                    {field('bonus', 'Частка каси понад поріг, %')}
                  </div>
                  {field('threshold', 'Поріг брудної каси, ₴ (порожньо — вимкнено)')}
                </>
              )}
              {select('effective', 'Початок дії', [
                ['now', 'Від моменту підтвердження'],
                ['nextWeek', 'Наступна перезмінка · понеділок 13:00'],
              ])}
              <p className="renewal-muted">
                Підтвердження створить нову версію умов. Старі записи збережуть свої умови. За
                власного авто можна вказати частку каси 100%, а власних витрат — 100%.
              </p>
            </>
          )}
          {kind === 'goal' && (
            <>
              {field('name', 'На що збираєш?')}
              {field('amount', 'Цільова сума, ₴')}
              {field('nextDate', 'Бажана дата', 'date')}
              {goal && (
                <>
                  {select('goalStatus', 'Стан цілі', [
                    ['active', 'Активна'],
                    ['paused', 'Призупинити'],
                    ['done', 'Досягнута'],
                  ])}
                  <p className="renewal-muted">
                    Виділені кошти залишаться зарезервованими. Щоб повернути їх, обери «Внесок /
                    повернення».
                  </p>
                </>
              )}
            </>
          )}
          {kind === 'goal-move' && (
            <>
              {select(
                'goalId',
                'Ціль',
                f.goals.map((g) => [g.id, g.name]),
              )}
              {select('direction', 'Дія', [
                ['add', 'Виділити на ціль'],
                ['return', 'Повернути у вільні кошти'],
              ])}
              {field('amount', 'Сума, ₴')}
              {account()}
              <p className="renewal-muted">
                Це резерв на твоєму рахунку. Він зменшує вільну суму, але не є витратою або
                переказом у банк.
              </p>
            </>
          )}
          {kind === 'budget' && (
            <>
              {field('name', 'Назва бюджету')}
              {select('purpose', 'Що відстежуємо', [
                ['expense', 'Витрати за категоріями'],
                ['saving', 'Внески на фінансові цілі'],
              ])}
              {v.purpose === 'expense' && (
                <fieldset>
                  <legend className="renewal-muted mb-2">Пов’язані категорії</legend>
                  <div className="flex flex-wrap gap-2">
                    {f.categories
                      .filter((c) => !['дохід', 'зарплата', 'таксі', 'чайові'].includes(c))
                      .map((c) => {
                        const selected = v.categories.split('|').includes(c);
                        return (
                          <button
                            key={c}
                            type="button"
                            className="renewal-secondary"
                            aria-pressed={selected}
                            style={
                              selected
                                ? { color: 'var(--color-a2)', borderColor: 'var(--color-a2)' }
                                : undefined
                            }
                            onClick={() =>
                              set(
                                'categories',
                                selected
                                  ? v.categories
                                      .split('|')
                                      .filter((k) => k !== c)
                                      .join('|')
                                  : [...v.categories.split('|').filter(Boolean), c].join('|'),
                              )
                            }
                          >
                            {selected ? '✓ ' : ''}
                            {financeCategoryLabel(c)}
                          </button>
                        );
                      })}
                  </div>
                </fieldset>
              )}
              <div className="renewal-form-grid">
                {select('period', 'Період', [
                  ['day', 'День'],
                  ['week', 'Календарний тиждень'],
                  ['month', 'Місяць'],
                ])}
                {select('budgetMode', 'Ліміт', [
                  ['fixed', 'Фіксована сума'],
                  ['percent', 'Відсоток доходу'],
                ])}
              </div>
              {v.budgetMode === 'fixed' ? (
                field('limit', 'Ліміт за обраний період, ₴')
              ) : (
                <>
                  {field('percent', 'Частка, %')}
                  {field('base', 'Плановий дохід за цей період, ₴')}
                </>
              )}
              <p className="renewal-muted">
                Перевищення показується як факт. Запис витрат залишається доступним. Денний і
                місячний бюджети можуть одночасно відстежувати одну категорію.
              </p>
            </>
          )}
          {kind === 'template' && (
            <>
              <p className="renewal-muted">
                50% — основні витрати, 30% — бажання, 20% — заощадження. Категорії й відсотки можна
                змінити після додавання. Це початковий план.
              </p>
              {field('base', 'Плановий місячний дохід, ₴')}
            </>
          )}
          {kind === 'payment' && (
            <>
              {field('name', 'Назва платежу')}
              {select('paymentKind', 'Тип', Object.entries(PAYMENT_KIND_LABELS))}
              {field('amount', 'Сума одного платежу, ₴')}
              {isDebtKind(v.paymentKind) && (
                <>
                  {select('remainingMode', 'Як визначити залишок боргу', [
                    ['auto', 'Порахувати за платежем і кількістю'],
                    ['manual', 'Ввести точний залишок із банку'],
                  ])}
                  <div className="renewal-form-grid">
                    {field('months', 'Кількість платежів')}
                    {field('remaining', 'Ще залишилось сплатити, ₴')}
                    {field('total', 'Початкова сума боргу, ₴')}
                    {field('rate', 'Річна ставка, %')}
                    {field('fee', 'Комісія в повному платежі, ₴')}
                    {field('lender', 'Банк / кредитор')}
                  </div>
                  <p className="renewal-chart-note">
                    {v.remainingMode === 'auto'
                      ? Number(v.rate.replace(',', '.')) > 0
                        ? 'За наявності відсотків обери точний залишок із банку — ставка не визначає тіло боргу.'
                        : 'Рахуємо платіж × кількість. Якщо є комісія, віднімаємо її з кожного платежу. Для іншого останнього платежу вкажи точний залишок із банку.'
                      : 'Введений залишок зберігається точно; зміна платежу або кількості його не переписує.'}
                  </p>
                </>
              )}
              {field('paymentNote', 'Примітка до договору')}
              <p className="renewal-chart-note">
                Сума платежу — повна сума за договором, включно з комісією та відсотками. Ставка
                зберігається для довідки; банківський графік не вгадується.
              </p>
              {field('nextDate', 'Наступна дата списання', 'date')}
              {select('recurrence', 'Повторення', [
                ['month', 'Щомісяця'],
                ['year', 'Щороку'],
                ['once', 'Одноразово'],
              ])}
              <div className="renewal-form-grid">
                {field('anchorDay', 'Фіксований день списання (1–31)')}
                {field('remindDays', 'Нагадувати за стільки днів')}
              </div>
              {category()}
              <p className="renewal-muted">
                Це число місяця: 9 — платіж дев’ятого числа. Світанок веде облік і нагадує, а не
                списує гроші. Для 29–31 числа в короткому місяці береться останній день; наступний
                місяць повертається до вибраного дня.
              </p>
              {request.id &&
                select('paymentStatus', 'Стан', [
                  ['active', 'Активний'],
                  ['paused', 'Призупинити'],
                ])}
            </>
          )}
          {kind === 'payment-cancel' && (
            <p className="renewal-inset renewal-muted">
              {payment?.name}: приберемо підписку зі списку та зупинимо нагадування. Нової витрати
              не буде. Скасування в Світанку не відключає підписку в самого сервісу — зроби це також
              у ньому.
            </p>
          )}
          {(kind === 'payment-paid' || kind === 'payment-close') && (
            <>
              <p className="renewal-muted">
                {payment?.name} · оновимо залишок боргу та графік платежів після фактичної оплати.
              </p>
              {kind === 'payment-close' && (
                <p className="renewal-inset renewal-muted">
                  Підтверджуй після фактичного погашення. Вкажи повну суму з банку, включно з
                  остаточними відсотками й комісіями. Тіло боргу має бути погашене повністю; після
                  збереження цей борг зникне зі списку.
                </p>
              )}
              {payment?.remainingMinor != null && (
                <>
                  <label className="renewal-field">
                    Погашення тіла боргу, ₴
                    <input
                      inputMode="decimal"
                      required={(payment?.rateBps ?? 0) > 0}
                      value={v.principal}
                      onChange={(e) => set('principal', e.target.value)}
                      placeholder={
                        (payment.rateBps ?? 0) > 0
                          ? 'Обов’язково за договором'
                          : 'Без відсотків: повний платіж мінус комісія'
                      }
                    />
                  </label>
                  <p className="renewal-chart-note">
                    Відсотки та комісія є витратою, але не зменшують тіло боргу.
                  </p>
                </>
              )}
              {select('paymentMode', 'Як сплачено?', [
                ['manual', 'Готівка / ручний рахунок'],
                ['bank', 'Уже імпортована операція Monobank'],
              ])}
              {v.paymentMode === 'bank' ? (
                <>
                  {select('bankTransactionId', 'Банківська операція', [
                    ['', 'Обери завершений платіж'],
                    ...f.transactions
                      .filter(
                        (t) =>
                          t.bank &&
                          !t.bankHold &&
                          !t.reference &&
                          t.currency === 'UAH' &&
                          t.amountMinor < 0 &&
                          ['expense', 'unclassified'].includes(t.kind),
                      )
                      .map((t): [string, string] => [
                        t.id,
                        `${t.description} · ${moneyLabel(-t.amountMinor)} · ${t.at.slice(0, 10)}`,
                      ]),
                  ])}
                  <p className="renewal-muted">
                    Пов’яжемо наявну операцію. Друге списання не створюється.
                  </p>
                </>
              ) : (
                <>
                  {field('amount', 'Фактично сплачено, ₴')}
                  {account()}
                  <p className="renewal-muted">
                    Створиться одна витрата на вибраному ручному рахунку.
                  </p>
                </>
              )}
            </>
          )}
          {kind === 'settings' && (
            <>
              {select('incomePeriod', 'Режим доходу', [
                ['week', 'Тижневий'],
                ['month', 'Місячний'],
              ])}
              {select('taxiVisible', 'Модуль таксі', [
                ['true', 'Показувати'],
                ['false', 'Приховати й зберегти історію'],
              ])}
              {select('paymentReminders', 'Нагадування про платежі в Telegram', [
                ['true', 'Увімкнено'],
                ['false', 'Вимкнено'],
              ])}
              {select('checkinReminders', 'Нагадування про непідтверджений чек-ін', [
                ['true', 'Увімкнено · раз на актуальний слот'],
                ['false', 'Вимкнено'],
              ])}
              {field('newCategory', 'Додаткова власна категорія')}
              {f.accounts
                .filter((a) => a.kind === 'mono')
                .map((a) => (
                  <button
                    type="button"
                    key={a.id}
                    className="renewal-secondary"
                    disabled={pending}
                    onClick={() => onOpenForm?.({ kind: 'credit-limit', id: a.id })}
                  >
                    Кредитний ліміт · {a.name}
                  </button>
                ))}
              <p className="renewal-muted">
                Приховане таксі можна повернути тут. Борг перед парком залишається в обліку.
                Нагадування враховують тихі години; у демонстрації повідомлення не надсилаються.
              </p>
            </>
          )}
          {kind === 'classify' && (
            <>
              <p className="renewal-muted">
                {transaction?.description} · {moneyLabel(transaction?.amountUah ?? 0)}
              </p>
              {select('transactionKind', 'Тип', [
                ['expense', 'Витрата'],
                ['income', 'Надходження'],
                ['transfer', 'Власний переказ'],
                ['taxi-settlement', 'Розрахунок таксі'],
              ])}
              {category()}
            </>
          )}
          {kind === 'taxi-settle' && (
            <>
              <p className="renewal-muted">
                {request.id} ·{' '}
                {moneyLabel(f.taxiWeeks.find((w) => w.key === request.id)?.settlementMinor ?? 0)}.
                Позитивна сума — парк доплачує, від’ємна — ти повертаєш парку. Підтверджуй після
                фактичного розрахунку.
              </p>
              {select('paymentMode', 'Як розрахувались?', [
                ['manual', 'Готівка / ручний рахунок'],
                ['bank', 'Уже імпортована операція Monobank'],
              ])}
              {v.paymentMode === 'bank' ? (
                <>
                  {select('bankTransactionId', 'Операція з точною сумою', [
                    ['', 'Обери завершений розрахунок'],
                    ...f.transactions
                      .filter(
                        (t) =>
                          t.bank &&
                          !t.bankHold &&
                          !t.reference &&
                          t.currency === 'UAH' &&
                          t.amountMinor ===
                            f.taxiWeeks.find((w) => w.key === request.id)?.settlementMinor &&
                          ['income', 'expense', 'unclassified', 'taxi-settlement'].includes(
                            t.kind,
                          ) &&
                          Date.parse(t.at) >= taxiWeek(kyivInstant(request.id ?? '')).to,
                      )
                      .map((t): [string, string] => [
                        t.id,
                        `${t.description} · ${moneyLabel(t.amountMinor)} · ${t.at.slice(0, 10)}`,
                      ]),
                  ])}
                  <p className="renewal-muted">
                    Прив’яжемо наявну операцію й закриємо розрахунок. Другий дохід або витрата не
                    створюються.
                  </p>
                </>
              ) : (
                account()
              )}
            </>
          )}
          {error && (
            <p role="alert" className="text-sm text-neg">
              {error}
            </p>
          )}
          <button type="submit" className="renewal-button mt-2" disabled={pending}>
            {pending
              ? 'Зберігаю…'
              : kind === 'policy'
                ? 'Підтвердити нові умови'
                : 'Підтвердити й зберегти'}
          </button>
        </form>
      </div>
    </Sheet>
  );
}
