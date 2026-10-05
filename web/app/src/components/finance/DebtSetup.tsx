import type { ReactNode } from 'react';
import { INTEREST_METHOD_LABELS } from '../../../../core/finance/payments.mjs';
import { moneyLabel } from '../../lib/financeView.ts';
import type { debtSetup } from '../../lib/debtSetup.ts';

export const DEBT_SETUP_HELP: Record<string, string> = {
  'total-cost':
    'Знаєш суму покупки, загальну переплату та повний термін. Найпростіший варіант для рівної розстрочки: 550 + 125 ₴ на 12 місяців.',
  interest:
    'У договорі є номінальна річна ставка й спосіб нарахування. Світанок моделює графік; реальна річна ставка та щоденне нарахування потребують графіка банку.',
  schedule:
    'Банк уже показує щомісячний платіж і поточний залишок. Використовуй для нерівних платежів, дострокових оплат або точного перенесення чинного кредиту.',
};
export function DebtSetup({
  v,
  step,
  field,
  select,
  plan,
  error,
}: {
  v: Record<string, string>;
  step: number;
  field: (key: string, label: string, type?: string, placeholder?: string) => ReactNode;
  select: (key: string, label: string, options: Array<[string, string]>) => ReactNode;
  plan: ReturnType<typeof debtSetup> | null;
  error: string;
}) {
  const cost = v.paymentSetup === 'total-cost';
  const interest = v.paymentSetup === 'interest';
  const calculated = cost || interest;
  const row = (label: string, value: string) => (
    <div className="flex justify-between gap-4">
      <span className="renewal-muted">{label}</span>
      <strong className="text-right">{value}</strong>
    </div>
  );
  return (
    <>
      {step === 0 && (
        <>
          {select('paymentSetup', 'Як додати борг', [
            ['total-cost', 'Сума покупки + загальна переплата'],
            ['schedule', 'Готовий графік із банку'],
            ['interest', 'Розрахунок за річною ставкою'],
          ])}
          <p className="renewal-inset renewal-chart-note">{DEBT_SETUP_HELP[v.paymentSetup]}</p>
          {calculated ? (
            <>
              {field(
                'total',
                cost ? 'Сума покупки / отриманого кредиту, ₴' : 'Початкова сума боргу, ₴',
              )}
              <div className="renewal-form-grid">
                {cost
                  ? field(
                      'overpayment',
                      'Загальна переплата за весь термін, ₴',
                      'text',
                      '0 — без переплати',
                    )
                  : field('rate', 'Річна ставка, %')}
                {field(
                  'termMonths',
                  cost ? 'Термін розстрочки, місяців' : 'Термін кредиту, місяців',
                )}
              </div>
              <p className="renewal-chart-note">
                Повний термін від початку договору, включно з уже сплаченими місяцями. Переплата —
                всі відсотки й комісії за цей термін, а не за один місяць.
              </p>
              {interest && (
                <>
                  {select(
                    'interestMethod',
                    'Як нараховуються відсотки',
                    Object.entries(INTEREST_METHOD_LABELS),
                  )}
                  <p className="renewal-chart-note">
                    {v.interestMethod === 'annuity'
                      ? 'Рівний загальний платіж; відсотки щомісяця на залишок боргу.'
                      : v.interestMethod === 'declining'
                        ? 'Щомісяця однакова частина основного боргу; відсотки й платіж зменшуються.'
                        : 'Відсотки кожного місяця рахуються від початкової суми, навіть після часткового погашення.'}
                  </p>
                  {field('fee', 'Щомісячна комісія, ₴', 'text', '0 — без комісії')}
                </>
              )}
            </>
          ) : (
            <>
              {field('amount', 'Сума одного платежу, ₴')}
              {field('total', 'Початкова сума боргу, ₴', 'text', 'Необов’язково')}
              <details className="renewal-inset">
                <summary className="renewal-link cursor-pointer">
                  У платежі є відсотки або комісія
                </summary>
                <div className="flex flex-col gap-3 mt-3">
                  {field('rate', 'Річна ставка, %')}
                  {field('fee', 'Комісія в повному платежі, ₴')}
                  <p className="renewal-chart-note">
                    Ставка тут для довідки. Якщо є відсотки, на наступному кроці потрібен залишок
                    основного боргу з банку.
                  </p>
                </div>
              </details>
            </>
          )}
        </>
      )}
      {step === 1 && (
        <>
          {calculated ? (
            <>
              {select('progressMode', 'Стан розстрочки / кредиту', [
                ['new', 'Нова — ще нічого не сплачено'],
                ['paid', 'Уже діє — вкажу кількість сплачених платежів'],
                ['bank', 'Уточню поточні залишки за банком'],
              ])}
              {v.progressMode === 'paid' && (
                <>
                  {field('paidCount', 'Уже сплачено платежів', 'text', 'Наприклад, 3')}
                  <p className="renewal-chart-note">
                    Порахуй завершені щомісячні платежі в графіку банку. Перший внесок враховуй,
                    якщо це один із платежів договору. Не вводь кількість майбутніх платежів — її
                    порахуємо самі.
                  </p>
                </>
              )}
              {v.progressMode === 'bank' && (
                <>
                  {field('months', 'Платежів ще залишилося')}
                  {field('remaining', 'Поточний залишок тіла, ₴')}
                  <p className="renewal-chart-note">
                    Тіло — неоплачена сума покупки / позики без майбутніх відсотків. Шукай у деталях
                    договору або графіку погашення банку.
                  </p>
                  {cost &&
                    field(
                      'extraRemaining',
                      'Переплати ще залишилося, ₴',
                      'text',
                      '0 — без майбутньої переплати',
                    )}
                  {field(
                    'amountOverride',
                    'Щомісячний платіж за банком, ₴',
                    'text',
                    'Необов’язково — порахуємо',
                  )}
                  {cost && (
                    <p className="renewal-chart-note">
                      Якщо банк показує тільки загальну суму до сплати, а поділ на тіло й переплату
                      невідомий — повернись і обери «Готовий графік із банку».
                    </p>
                  )}
                </>
              )}
              <p className="renewal-chart-note">
                Автоматичний розрахунок припускає вчасні платежі за початковим графіком. Після
                пропусків або дострокових оплат обери уточнення за банком.
              </p>
            </>
          ) : (
            <>
              {field('months', 'Кількість платежів')}
              <p className="renewal-chart-note">
                Лише платежі, які ще потрібно сплатити. Наприклад, із 12 уже сплачено 3 → тут 9.
                Шукай «залишилося платежів» у графіку банку.
              </p>
              {select('remainingMode', 'Як визначити залишок боргу', [
                ['auto', 'Порахувати за платежем і кількістю'],
                ['manual', 'Ввести точний залишок із банку'],
              ])}
              {field('remaining', 'Ще залишилось сплатити, ₴')}
              <p className="renewal-chart-note">
                Без відсотків: платіж × кількість, без окремої комісії. З відсотками введи залишок
                тіла боргу; повний майбутній графік показуємо як прогноз. Для іншого останнього
                платежу введи точний залишок.
              </p>
            </>
          )}
          {plan && (
            <div className="renewal-inset flex flex-col gap-3" aria-live="polite">
              {row('Платежів залишилося', String(plan.installmentsLeft))}
              {row('Ще до сплати', moneyLabel(plan.preview.futureTotal))}
            </div>
          )}
          <p className="renewal-inset renewal-chart-note">
            Минулі платежі потрібні для розрахунку залишку. Вони не створюють старих витрат і не
            списують гроші з твоїх рахунків.
          </p>
        </>
      )}
      {step === 2 && plan && (
        <section className="renewal-inset flex flex-col gap-4" aria-label="Перевірка графіка">
          <p className="renewal-eyebrow">Перевір перед збереженням</p>
          <h3 className="text-xl font-bold">{v.name}</h3>
          {plan.preview.contractTotal != null &&
            row('Усього за договором', moneyLabel(plan.preview.contractTotal))}
          {plan.preview.paidAmount != null &&
            row('Уже сплачено за графіком', moneyLabel(plan.preview.paidAmount))}
          {row('Платежів залишилося', String(plan.installmentsLeft))}
          {row('Найближчий платіж', moneyLabel(plan.preview.next))}
          {row('Ще до сплати', moneyLabel(plan.preview.futureTotal))}
          <details className="flex flex-col gap-3">
            <summary className="renewal-link cursor-pointer">Деталі розрахунку</summary>
            <div className="flex flex-col gap-3 mt-3">
              {row('Основний борг', moneyLabel(plan.remainingMinor))}
              {plan.overpaymentRemainingMinor != null &&
                row('Майбутня переплата', moneyLabel(plan.overpaymentRemainingMinor))}
              {row(
                'Останній платіж',
                calculated || plan.rateBps === 0
                  ? moneyLabel(plan.preview.last)
                  : 'За графіком банку',
              )}
              <p className="renewal-chart-note">
                Поділ на тіло й переплату розрахунковий. Якщо банк показує інші залишки, уточни їх
                на попередньому кроці.
              </p>
            </div>
          </details>
          {row('Наступна дата', v.nextDate)}
          <p className="renewal-chart-note">
            {v.paymentSetup === 'schedule' && plan.rateBps > 0
              ? 'Майбутня сума — прогноз за введеним платежем; уточнення банку мають пріоритет. '
              : ''}
            Звір із графіком банку. Збереження додасть зобов’язання та нагадування; гроші списуються
            в обліку лише при підтвердженні фактичної оплати.
          </p>
        </section>
      )}
      {error && step > 0 && (
        <p role="status" className="renewal-chart-note text-neg">
          {error}
        </p>
      )}
    </>
  );
}
