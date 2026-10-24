import { useRef, useState, useMemo } from 'react';
import { useQueryClient, useQuery } from '@tanstack/react-query';
import type { Finance, FinanceCommand } from '../../api/finance-schema.ts';
import { postFinance, fetchFinanceProjection } from '../../api/client.ts';
import { FINANCE_QUERY } from '../../api/finance-hooks.ts';
import { financeForecast } from '../../lib/financeForecast.ts';
import { periodWindow } from '../../lib/budgetPlanning.ts';
import { moneyLabel } from '../../lib/financeView.ts';
import { kyivParts, parseMoney, shiftDate } from '../../../../core/finance/planning.mjs';
import { ProjectionChart } from './ProjectionChart.tsx';
import { Sheet } from '../ui/Sheet.tsx';
import { ForecastSteps } from './ForecastSteps.tsx';
import { taxiWeek } from '../../../../core/finance/planning.mjs';
export function ForecastPlan({
  finance: f,
  nowMs,
  onCalendar,
  onPayment,
}: {
  finance: Finance;
  nowMs: number;
  onCalendar: () => void;
  onPayment?: (id: string) => void;
}) {
  const [period, setPeriod] = useState(f.policies.length ? 'handover' : 'week'),
    [editing, setEditing] = useState(false);
  const today = kyivParts(nowMs).date;
  const [customDate, setCustomDate] = useState(shiftDate(today, 13));
  const days =
    period === 'custom'
      ? Math.max(
          1,
          Math.min(93, Math.round((Date.parse(customDate) - Date.parse(today)) / 86400000) + 1),
        )
      : period === 'handover'
        ? Math.max(
            1,
            Math.round(
              (Date.parse(kyivParts(taxiWeek(nowMs, f.policies).to).date) - Date.parse(today)) /
                86400000,
            ) + 1,
          )
        : period === '7'
          ? 7
          : Math.round(
              (Date.parse(periodWindow(period as 'week' | 'month', today).end) -
                Date.parse(today)) /
                86400000,
            ) + 1;
  const local = useMemo(() => financeForecast(f, days, nowMs), [f, days, nowMs]);
  const forecast = useQuery({
    queryKey: [
      ...FINANCE_QUERY,
      'projection',
      days,
      f.version,
      f.generatedAt,
      f.bankSync?.completedAt,
      Math.floor(nowMs / 60000),
    ],
    queryFn: () => fetchFinanceProjection(days),
    staleTime: 60000,
    retry: 1,
    refetchOnWindowFocus: false,
  });
  const result = forecast.data ?? local;
  const [comparison, setComparison] = useState(() => ({
    finance: f,
    days,
    baseline: local,
    changes: [] as string[],
  }));
  if (comparison.finance !== f || comparison.days !== days) {
    const changes =
      comparison.days === days
        ? (
            [
              ['Кошти зараз', result.available - comparison.baseline.available],
              ['Очікувані надходження', result.expectedIncome - comparison.baseline.expectedIncome],
              ['Відомі оплати', result.obligations - comparison.baseline.obligations],
              ['Повсякденні витрати', result.plannedExpense - comparison.baseline.plannedExpense],
              ['Очікувані внески', result.saving - comparison.baseline.saving],
            ] as const
          )
            .filter(([, delta]) => delta !== 0)
            .map(([label, delta]) => `${label}: ${delta > 0 ? '+' : ''}${moneyLabel(delta)}`)
        : [];
    setComparison({ finance: f, days, baseline: result, changes });
  }
  const fmt = (date: string) =>
    new Date(date + 'T12:00:00Z').toLocaleDateString('uk-UA', { day: 'numeric', month: 'long' });
  return (
    <section className="renewal-card finance-forecast">
      <p className="renewal-eyebrow mb-2">ПОГЛЯД НАПЕРЕД</p>
      <h2 className="text-xl font-bold">Що залишиться після планів?</h2>
      <div className="renewal-segments mt-4">
        {[
          ...(f.policies.length ? [['handover', 'До перезмінки']] : []),
          ['week', 'До неділі'],
          ['7', '7 днів'],
          ['month', 'До кінця місяця'],
          ['custom', 'До дати'],
        ].map(([id, label]) => (
          <button key={id} aria-pressed={period === id} onClick={() => setPeriod(id)}>
            {label}
          </button>
        ))}
      </div>
      {period === 'custom' && (
        <label className="renewal-field mt-3">
          Кінцева дата
          <input
            type="date"
            min={today}
            max={shiftDate(today, 92)}
            value={customDate}
            onChange={(e) => {
              if (e.target.value)
                setCustomDate(
                  e.target.value < today
                    ? today
                    : e.target.value > shiftDate(today, 92)
                      ? shiftDate(today, 92)
                      : e.target.value,
                );
            }}
          />
        </label>
      )}
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
      {result.minimum && (
        <p className={result.minimum.amount < 0 ? 'text-neg mt-3' : 'renewal-inset mt-3'}>
          Найменший очікуваний залишок: <b>{moneyLabel(result.minimum.amount)}</b> ·{' '}
          {fmt(result.minimum.date)}
        </p>
      )}
      <p className="renewal-chart-note mt-2">
        Перераховано{' '}
        {new Date(result.asOf).toLocaleString('uk-UA', {
          timeZone: 'Europe/Kyiv',
          dateStyle: 'short',
          timeStyle: 'short',
        })}
        .{forecast.isFetching ? ' Оновлюю…' : ''}
      </p>
      {forecast.error && (
        <p role="status" className="renewal-chart-note">
          {forecast.error.message}
        </p>
      )}
      {comparison.changes.length > 0 && (
        <p className="renewal-inset mt-3" role="status">
          Прогноз оновився після зміни обліку. {comparison.changes.join(' · ')}.
        </p>
      )}
      <ProjectionChart projection={result} />
      {result.unlinkedPaymentCount > 0 && (
        <div className="renewal-inset mt-3">
          <p>
            У збереженій історії є {result.unlinkedPaymentCount} оплат розстрочок або кредитів без
            прив’язки. Вони не повторюються як щоденні витрати. Перевірте, чи всі майбутні оплати
            враховано у графіках.
          </p>
          <button className="renewal-link mt-2" onClick={onCalendar}>
            Перевірити графіки оплат ↗
          </button>
        </div>
      )}
      <ForecastSteps result={result} finance={f} onPayment={onPayment} />
      {f.policies.length > 0 && (
        <div className="renewal-inset mt-3 text-sm">
          <strong>Таксі · на {fmt(result.taxi.date ?? result.until)}</strong>
          <p className="renewal-muted mt-2">{result.taxi.reason}</p>
          {result.taxi.status === 'estimated' && (
            <p className="renewal-muted mt-2">
              Сценарії: {moneyLabel(result.taxi.lowerMinor ?? 0)} —{' '}
              {moneyLabel(result.taxi.upperMinor ?? 0)}. Повних попередніх періодів:{' '}
              {result.taxi.historyPeriods}. Це сценарна оцінка, а не гарантований дохід.
            </p>
          )}
          {result.taxiCovered && (
            <p className="renewal-muted mt-2">
              Ручні надходження «Таксі» та старі надходження без уточненого джерела замінюють
              розрахунок із парком у відповідні дати. Для іншого доходу оберіть джерело «Інший
              дохід».
            </p>
          )}
          <p className="renewal-muted mt-2">
            Готівка, яка вже в тебе, повторно не додається. Очікувані гроші не змінюють сьогоднішній
            залишок.
          </p>
        </div>
      )}
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
          Для повсякденних витрат і внесків поки недостатньо даних. Додай історію або налаштуй плани
          витрат і цілей.
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
              Ціль «{g.name}»: {moneyLabel(g.amount)} · {g.description}{' '}
              {g.gap > 0 ? `Різниця до обраного темпу: ${moneyLabel(g.gap)}.` : ''}
            </p>
          ))}
          {result.incomes.map((i, n) => (
            <p key={n} className="renewal-muted">
              {i.name} · {fmt(i.date)}: +{moneyLabel(i.amount)}
            </p>
          ))}
          <p className="renewal-chart-note">
            Оцінка змінних витрат адаптується до історії. Відомі платежі рахуються за графіками;
            очікувані внески мають гнучкий час без дедлайнів. Власні перекази, минулі витрати та вже
            враховані резерви не віднімаються вдруге. Прогноз не виконує реальних платежів.
          </p>
          {result.plans.map((p) => (
            <p key={`model:${p.id}`} className="renewal-chart-note">
              {p.name}:{' '}
              {p.model === 'plan'
                ? 'За планом'
                : p.model === 'kalman-weekly'
                  ? 'Адаптивний рівень і ритм тижня'
                  : 'Адаптивний рівень ETS'}{' '}
              · записаних днів {p.count}.
            </p>
          ))}
          {result.warnings.map((w) => (
            <p key={w} className="renewal-chart-note">
              {w}
            </p>
          ))}
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
              Джерело
              <select
                disabled={pending}
                value={r.source ?? 'unspecified'}
                onChange={(e) =>
                  setRows(
                    rows.map((x, j) =>
                      j === i
                        ? { ...x, source: e.target.value as 'taxi' | 'other' | 'unspecified' }
                        : x,
                    ),
                  )
                }
              >
                <option value="unspecified">Не визначено · замінює оцінку таксі в цю дату</option>
                <option value="taxi">Таксі · очікувана виплата від парку</option>
                <option value="other">Інший дохід · додати окремо</option>
              </select>
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
                source: 'other',
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
