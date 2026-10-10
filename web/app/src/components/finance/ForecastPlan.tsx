import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Finance, FinanceCommand } from '../../api/finance-schema.ts';
import { postFinance } from '../../api/client.ts';
import { FINANCE_QUERY } from '../../api/finance-hooks.ts';
import { financeForecast } from '../../lib/financeForecast.ts';
import { periodWindow } from '../../lib/budgetPlanning.ts';
import { moneyLabel } from '../../lib/financeView.ts';
import { kyivParts, parseMoney } from '../../../../core/finance/planning.mjs';
import { Sheet } from '../ui/Sheet.tsx';
export function ForecastPlan({
  finance: f,
  nowMs,
  onCalendar,
}: {
  finance: Finance;
  nowMs: number;
  onCalendar: () => void;
}) {
  const [period, setPeriod] = useState('week'),
    [editing, setEditing] = useState(false);
  const today = kyivParts(nowMs).date;
  const days =
    period === '7'
      ? 7
      : Math.round(
          (Date.parse(periodWindow(period as 'week' | 'month', today).end) - Date.parse(today)) /
            86400000,
        ) + 1;
  const result = financeForecast(f, days, nowMs);
  const fmt = (date: string) =>
    new Date(date + 'T12:00:00Z').toLocaleDateString('uk-UA', { day: 'numeric', month: 'long' });
  return (
    <section className="renewal-card finance-forecast">
      <p className="renewal-eyebrow mb-2">ПОГЛЯД НАПЕРЕД</p>
      <h2 className="text-xl font-bold">Що залишиться після планів?</h2>
      <div className="renewal-segments mt-4">
        {[
          ['week', 'До неділі'],
          ['7', '7 днів'],
          ['month', 'До кінця місяця'],
        ].map(([id, label]) => (
          <button key={id} aria-pressed={period === id} onClick={() => setPeriod(id)}>
            {label}
          </button>
        ))}
      </div>
      <p className="renewal-muted mt-3">
        Від сьогодні до {fmt(result.until)} · {days} дн.
      </p>
      <div
        className={`renewal-big mt-3 ${result.result != null && result.result < 0 ? 'text-neg' : ''}`}
      >
        {result.result == null ? 'Потрібне уточнення' : '≈ ' + moneyLabel(result.result)}
      </div>
      <p className="renewal-muted">
        Орієнтовні вільні кошти після майбутніх платежів, бюджетів і відкладань.
      </p>
      <div className="finance-forecast-formula mt-4">
        {[
          ['Вільно зараз', result.available],
          ['Очікувані надходження', result.expectedIncome],
          ['Платежі та прострочені зобов’язання', -result.obligations],
          ['Ще заплановано на повсякденні витрати', -result.plannedExpense],
          ['Майбутні відкладання', -result.saving],
        ].map(([label, amount]) => (
          <div key={String(label)}>
            <span>{label}</span>
            <b>
              {Number(amount) > 0 && label === 'Очікувані надходження' ? '+ ' : ''}
              {moneyLabel(Number(amount))}
            </b>
          </div>
        ))}
      </div>
      {!!result.overlaps.length && (
        <p className="renewal-inset text-sm mt-3">
          Плани перетинаються за категоріями або цілями: {result.overlaps.join(', ')}. Уточни їхню
          ієрархію, розділи категорії або залиш один паралельний ліміт у прогнозі, щоб не рахувати
          ті самі витрати двічі.
        </p>
      )}
      {result.incomplete && !result.overlaps.length && (
        <p className="renewal-inset text-sm mt-3">
          Уточни невідомі залишки, неповні зміни таксі або графік боргу. За неповних даних точний
          підсумок приховано.
        </p>
      )}
      {!result.hasPlans && (
        <p className="renewal-inset text-sm mt-3">
          Поки враховано лише відомі платежі. Увімкни «Включати у прогноз» у потрібних бюджетах, щоб
          додати харчування та інші витрати.
        </p>
      )}
      {result.result != null && result.result < 0 && (
        <p className="text-neg text-sm mt-3">
          За цим сценарієм бракує {moneyLabel(-result.result)}. Переглянь план витрат, строки оплат
          або очікувані надходження.
        </p>
      )}
      <details className="renewal-inset mt-4">
        <summary className="font-semibold cursor-pointer">Звідки взялися майбутні суми?</summary>
        <div className="mt-3 flex flex-col gap-3">
          {result.plans.map((p) => (
            <p className="renewal-muted" key={p.id}>
              {p.name}: {moneyLabel(p.amount)}
              {p.covered > 0 ? ` · платежі на ${moneyLabel(p.covered)} враховано окремо` : ''}
            </p>
          ))}
          {result.goalPlans.map((g) => (
            <p className="renewal-muted" key={g.id}>
              Ціль «{g.name}»: {moneyLabel(g.amount)}
            </p>
          ))}
          {result.incomes.map((i, n) => (
            <p key={n} className="renewal-muted">
              {i.name} · {fmt(i.date)}: +{moneyLabel(i.amount)}
            </p>
          ))}
          <p className="renewal-chart-note">
            Невитрачений ліміт розподіляється на решту днів поточного періоду; новий період
            починається з повного плану. Минулі витрати вже змінили залишки й удруге не
            віднімаються. Внески, уже переказані в банку, та резерви цілей теж не віднімаємо
            повторно. Прогноз не виконує платежів; незаплановані витрати й майбутні зміни таксі
            невідомі. Дохід, указаний як база бюджету, не є авансовим надходженням. Майбутні гроші
            додаються лише через «Планові надходження» з конкретною датою.
          </p>
        </div>
      </details>
      <div className="finance-tool-grid mt-4">
        <button className="renewal-secondary" onClick={onCalendar}>
          Календар платежів
        </button>
        <button className="renewal-secondary" onClick={() => setEditing(true)}>
          Планові надходження
        </button>
      </div>
      {editing && <IncomePlan finance={f} onClose={() => setEditing(false)} today={today} />}
    </section>
  );
}
function IncomePlan({
  finance: f,
  onClose,
  today,
}: {
  finance: Finance;
  onClose: () => void;
  today: string;
}) {
  const query = useQueryClient();
  const [rows, setRows] = useState(f.forecast.incomes),
    [error, setError] = useState(''),
    [pending, setPending] = useState(false);
  const [amounts, setAmounts] = useState<Record<string, string>>(
    Object.fromEntries(f.forecast.incomes.map((r) => [r.id, String(r.amountMinor / 100)])),
  );
  const attempt = useRef<{ key: string; command: FinanceCommand } | null>(null);
  const expectedVersion = useRef(f.version).current;
  const save = async () => {
    if (pending) return;
    setError('');
    setPending(true);
    try {
      const payload = {
        incomes: rows.map((r) => {
          if (!r.name.trim()) throw new Error('Дай надходженню назву');
          const amountMinor = parseMoney(amounts[r.id] ?? String(r.amountMinor / 100));
          if (!amountMinor) throw new Error('Сума надходження має бути більшою за нуль');
          return { ...r, amountMinor };
        }),
      };
      const key = JSON.stringify([payload, expectedVersion]);
      if (attempt.current?.key !== key)
        attempt.current = {
          key,
          command: {
            id: crypto.randomUUID(),
            version: expectedVersion,
            type: 'forecast-settings',
            payload,
          },
        };
      const result = await postFinance(attempt.current.command);
      if (result.finance) query.setQueryData(FINANCE_QUERY, result);
      else void query.invalidateQueries({ queryKey: FINANCE_QUERY });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не вдалося зберегти');
    } finally {
      setPending(false);
    }
  };
  return (
    <Sheet label="Планові надходження" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <div className="renewal-section-head">
          <h2 className="text-xl font-bold">Що очікуєш отримати?</h2>
          <button
            className="renewal-secondary"
            aria-label="Закрити надходження"
            disabled={pending}
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <p className="renewal-muted">
          Зарплата, додатковий дохід або інше майбутнє надходження. Це лише сценарій; баланс
          рахунків не зміниться. Коли гроші надійшли, перенеси наступну дату або прибери одноразовий
          план.
        </p>
        {rows.map((r, i) => (
          <div className="renewal-inset flex flex-col gap-3" key={r.id}>
            <label className="renewal-field">
              Назва
              <input
                disabled={pending}
                maxLength={120}
                value={r.name}
                onChange={(e) =>
                  setRows(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))
                }
              />
            </label>
            <label className="renewal-field">
              Сума, ₴
              <input
                disabled={pending}
                inputMode="decimal"
                value={amounts[r.id] ?? String(r.amountMinor / 100)}
                onChange={(e) => {
                  setAmounts({ ...amounts, [r.id]: e.target.value });
                  setError('');
                }}
              />
            </label>
            <div className="renewal-form-grid">
              <label className="renewal-field">
                Наступна дата
                <input
                  disabled={pending}
                  type="date"
                  value={r.nextDate}
                  onChange={(e) =>
                    setRows(rows.map((x, j) => (j === i ? { ...x, nextDate: e.target.value } : x)))
                  }
                />
              </label>
              <label className="renewal-field">
                Повторення
                <select
                  disabled={pending}
                  value={r.recurrence}
                  onChange={(e) =>
                    setRows(
                      rows.map((x, j) =>
                        j === i ? { ...x, recurrence: e.target.value as typeof r.recurrence } : x,
                      ),
                    )
                  }
                >
                  <option value="once">Один раз</option>
                  <option value="week">Щотижня</option>
                  <option value="month">Щомісяця</option>
                </select>
              </label>
            </div>
            <button
              className="renewal-link text-neg"
              disabled={pending}
              onClick={() => setRows(rows.filter((_, j) => j !== i))}
            >
              Прибрати з прогнозу
            </button>
          </div>
        ))}
        <button
          className="renewal-secondary"
          disabled={pending || rows.length >= 30}
          onClick={() =>
            setRows([
              ...rows,
              {
                id: crypto.randomUUID(),
                name: '',
                amountMinor: 0,
                nextDate: today,
                recurrence: 'once',
              },
            ])
          }
        >
          Надходження +
        </button>
        {error && (
          <p className="text-neg text-sm" role="alert">
            {error}
          </p>
        )}
        <button className="renewal-button" disabled={pending} onClick={save}>
          {pending ? 'Зберігаю…' : 'Зберегти сценарій'}
        </button>
      </div>
    </Sheet>
  );
}
