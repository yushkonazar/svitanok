import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Finance, FinanceCommand } from '../../api/finance-schema.ts';
import { FINANCE_QUERY } from '../../api/finance-hooks.ts';
import { postFinance } from '../../api/client.ts';
import { budgetRows, orderedBudgets, budgetLimit, type Budget } from '../../lib/budgetPlanning.ts';
import { moneyLabel } from '../../lib/financeView.ts';
import { parseMoney, kyivParts } from '../../../../core/finance/planning.mjs';
import { financeCategoryLabel } from '../../../../core/finance/categories.mjs';
import { Sheet } from '../ui/Sheet.tsx';

export function BudgetPlan({ finance: f, nowMs }: { finance: Finance; nowMs: number }) {
  const query = useQueryClient();
  const [editing, setEditing] = useState<{
    id?: string;
    parentId?: string;
    template?: boolean;
  } | null>(null);
  const [pending, setPending] = useState(false),
    [error, setError] = useState('');
  const attempt = useRef<{ key: string; command: FinanceCommand } | null>(null);
  const run = async (
    type: string,
    payload: Record<string, unknown>,
    expectedVersion = f.version,
  ) => {
    if (pending) return;
    setPending(true);
    setError('');
    const key = JSON.stringify([type, payload, expectedVersion]);
    if (attempt.current?.key !== key)
      attempt.current = {
        key,
        command: { id: crypto.randomUUID(), version: expectedVersion, type, payload },
      };
    try {
      const result = await postFinance(attempt.current.command);
      if (result.finance) query.setQueryData(FINANCE_QUERY, result);
      else void query.invalidateQueries({ queryKey: FINANCE_QUERY });
      setEditing(null);
      attempt.current = null;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не вдалося зберегти');
    } finally {
      setPending(false);
    }
  };
  const rows = orderedBudgets(budgetRows(f, nowMs));
  const move = (b: Budget, direction: number) => {
    const ids = orderedBudgets(f.budgets).map((x) => x.id);
    const siblings = rows.filter((x) => (x.parentId ?? null) === (b.parentId ?? null));
    const index = siblings.findIndex((x) => x.id === b.id),
      other = siblings[index + direction];
    if (!other) return;
    const i = ids.indexOf(b.id),
      j = ids.indexOf(other.id);
    [ids[i], ids[j]] = [ids[j], ids[i]];
    void run('budget-reorder', { ids });
  };
  return (
    <section className="renewal-card">
      <div className="renewal-section-head">
        <h2 className="text-lg font-bold">План витрат</h2>
        <button
          className="renewal-link"
          onClick={() => {
            setError('');
            setEditing({});
          }}
        >
          Бюджет +
        </button>
      </div>
      <p className="renewal-muted mb-4">
        Основний план можна розкласти на підплани. Додаткові ліміти контролюють витрати; у прогноз
        входять лише ввімкнені плани.
      </p>
      {!rows.length && (
        <p className="renewal-muted mb-4">Почни з основного плану або однієї категорії.</p>
      )}
      {rows.map((b) => {
        const siblings = rows.filter((x) => (x.parentId ?? null) === (b.parentId ?? null));
        const i = siblings.findIndex((x) => x.id === b.id);
        return (
          <article
            key={b.id}
            className="finance-budget-row"
            style={{ marginLeft: Math.min(b.depth, 3) * 10 }}
          >
            <div className="renewal-section-head">
              <div className="min-w-0">
                <b>{b.category}</b>
                <p className="renewal-muted">
                  {b.parentId ? 'Підплан · ' : ''}
                  {b.purpose === 'saving' ? 'Відкладання' : 'Витрати'} ·{' '}
                  {b.period === 'day' ? 'день' : b.period === 'week' ? 'тиждень' : 'місяць'}
                  {b.forecastEnabled ? ' · у прогнозі' : ''}
                </p>
              </div>
              <button
                className="renewal-link"
                onClick={() => {
                  setError('');
                  setEditing({ id: b.id });
                }}
              >
                Налаштувати
              </button>
            </div>
            <div className="finance-budget-amount">
              <span>
                {moneyLabel(b.spent)}{' '}
                <small className="renewal-muted">із {moneyLabel(b.limit)}</small>
              </span>
              <b className={b.left < 0 ? 'text-neg' : 'text-pos'}>
                {b.left < 0 ? '+' + moneyLabel(-b.left) : moneyLabel(b.left)}
              </b>
            </div>
            <div className="renewal-progress">
              <span style={{ width: `${b.progress}%` }} />
            </div>
            <p className="renewal-chart-note">
              {b.left < 0 ? 'Понад план' : 'Ще доступно в цьому періоді'}
              {b.goalId ? ` · ${f.goals.find((g) => g.id === b.goalId)?.name ?? 'Ціль'}` : ''}
            </p>
            {b.children > 0 && (
              <p className={`renewal-chart-note ${b.childAllocation > b.limit ? 'text-neg' : ''}`}>
                Підпланам виділено {moneyLabel(b.childAllocation)} із {moneyLabel(b.limit)} за
                період основного плану.
                {b.childAllocation > b.limit
                  ? ' Підплани перевищують основний ліміт; прогноз врахує більшу суму.'
                  : ''}
              </p>
            )}
            <div className="finance-budget-actions">
              <button className="renewal-link" onClick={() => setEditing({ parentId: b.id })}>
                Підплан +
              </button>
              <div className="flex gap-2">
                <button
                  className="renewal-secondary"
                  aria-label={`Підняти ${b.category}`}
                  disabled={pending || i === 0}
                  onClick={() => move(b, -1)}
                >
                  ↑
                </button>
                <button
                  className="renewal-secondary"
                  aria-label={`Опустити ${b.category}`}
                  disabled={pending || i === siblings.length - 1}
                  onClick={() => move(b, 1)}
                >
                  ↓
                </button>
              </div>
            </div>
          </article>
        );
      })}
      {error && !editing && (
        <p role="alert" className="text-neg text-sm">
          {error}
        </p>
      )}
      <button
        className="renewal-secondary w-full"
        onClick={() => {
          setError('');
          setEditing({ template: true });
        }}
      >
        Налаштувати основний план · 50 / 30 / 20
      </button>
      {editing && (
        <BudgetEditor
          key={JSON.stringify(editing)}
          finance={f}
          request={editing}
          pending={pending}
          error={error}
          nowMs={nowMs}
          onClose={() => setEditing(null)}
          onSave={run}
        />
      )}
    </section>
  );
}

function BudgetEditor({
  finance: f,
  request,
  pending,
  error,
  nowMs,
  onClose,
  onSave,
}: {
  finance: Finance;
  request: { id?: string; parentId?: string; template?: boolean };
  pending: boolean;
  error: string;
  nowMs: number;
  onClose: () => void;
  onSave: (
    type: string,
    payload: Record<string, unknown>,
    expectedVersion?: number,
  ) => Promise<void>;
}) {
  const expectedVersion = useRef(f.version).current;
  const old = f.budgets.find((b) => b.id === request.id);
  const templateRoots = ['Основні витрати', 'Бажання', 'Заощадження'].map((name, i) =>
    f.budgets.find(
      (b) =>
        (b.templateRole === ['needs', 'wants', 'saving'][i] || b.category === name) &&
        b.period === 'month',
    ),
  );
  const [name, setName] = useState(old?.category ?? '');
  const [parentId, setParent] = useState(old?.parentId ?? request.parentId ?? '');
  const initialParent = f.budgets.find((b) => b.id === parentId);
  const [purpose, setPurpose] = useState(old?.purpose ?? initialParent?.purpose ?? 'expense');
  const [period, setPeriod] = useState(old?.period ?? 'month');
  const [mode, setMode] = useState(old?.shareBps != null ? 'percent' : 'fixed'),
    [amount, setAmount] = useState(String((old?.limitMinor ?? 0) / 100));
  const [percent, setPercent] = useState(String((old?.shareBps ?? 1000) / 100)),
    [base, setBase] = useState(
      String(
        (old?.incomeBaseMinor ??
          (request.template ? templateRoots.find(Boolean)?.incomeBaseMinor : 0) ??
          0) / 100,
      ),
    );
  const [goalId, setGoal] = useState(old?.goalId ?? ''),
    [forecast, setForecast] = useState(old?.forecastEnabled ?? Boolean(parentId));
  const [categories, setCategories] = useState(old?.categories ?? []),
    [search, setSearch] = useState('');
  const [shares, setShares] = useState(
      templateRoots.map((b, i) => String((b?.shareBps ?? [5000, 3000, 2000][i]) / 100)),
    ),
    [remove, setRemove] = useState(false),
    [inputError, setInputError] = useState('');
  const parent = f.budgets.find((b) => b.id === parentId);
  const today = kyivParts(nowMs).date;
  const field = (label: string, value: string, set: (s: string) => void, decimal = false) => (
    <label className="renewal-field">
      {label}
      <input
        disabled={pending}
        value={value}
        maxLength={120}
        inputMode={decimal ? 'decimal' : undefined}
        onChange={(e) => set(e.target.value)}
      />
    </label>
  );
  const descendants = new Set<string>(old ? [old.id] : []);
  for (let i = 0; i < f.budgets.length; i++)
    f.budgets.forEach((b) => {
      if (b.parentId && descendants.has(b.parentId)) descendants.add(b.id);
    });
  let preview: number | null = null;
  try {
    preview = request.template
      ? parseMoney(base)
      : budgetLimit(
          {
            id: old?.id ?? 'preview',
            category: name,
            categories,
            purpose,
            period: period as Budget['period'],
            limitMinor: mode === 'fixed' ? parseMoney(amount) : null,
            shareBps: mode === 'percent' ? parseMoney(percent) : null,
            incomeBaseMinor: parent ? 0 : parseMoney(base),
            parentId,
          },
          f.budgets,
          today,
        );
  } catch {
    /* Input is incomplete. */
  }
  const submit = async () => {
    setInputError('');
    try {
      if (request.template) {
        await onSave(
          'budget-template',
          {
            incomeBaseMinor: parseMoney(base),
            shares: shares.map((s) => parseMoney(s)),
            updateExisting: true,
          },
          expectedVersion,
        );
        return;
      }
      if (!name.trim()) throw new Error('Дай плану назву');
      if (purpose === 'expense' && !categories.length)
        throw new Error('Обери хоча б одну категорію');
      await onSave(
        'budget',
        {
          budgetId: old?.id,
          category: name,
          categories: purpose === 'saving' ? [] : categories,
          purpose,
          period,
          parentId: parentId || null,
          goalId: goalId || null,
          forecastEnabled: forecast,
          limitMinor: mode === 'fixed' ? parseMoney(amount) : null,
          shareBps: mode === 'percent' ? parseMoney(percent) : null,
          incomeBaseMinor: mode === 'percent' ? (parent ? 0 : parseMoney(base)) : null,
        },
        expectedVersion,
      );
    } catch (e) {
      setInputError(e instanceof Error ? e.message : 'Перевір числа');
    }
  };
  return (
    <Sheet
      label={
        request.template ? 'Основний фінансовий план' : old ? 'Налаштувати план' : 'Створити план'
      }
      onClose={onClose}
    >
      <div className="flex flex-col gap-4">
        <div className="renewal-section-head">
          <h2 className="text-xl font-bold">
            {request.template ? 'Твій розподіл коштів' : old ? 'Налаштувати план' : 'Новий план'}
          </h2>
          <button
            className="renewal-secondary"
            aria-label="Закрити план"
            disabled={pending}
            onClick={onClose}
          >
            ×
          </button>
        </div>
        {request.template ? (
          <>
            {field('Плановий дохід за місяць, ₴', base, setBase, true)}
            {shares.map((value, i) => (
              <div key={i} className="renewal-inset">
                {field(
                  ['Основні витрати, %', 'Бажання, %', 'Відкладання, %'][i],
                  value,
                  (s) => setShares(shares.map((v, j) => (j === i ? s : v))),
                  true,
                )}
                <p className="renewal-muted mt-2">
                  {preview != null && Number.isFinite(Number(value.replace(',', '.')))
                    ? moneyLabel(Math.round((preview * Number(value.replace(',', '.'))) / 100))
                    : '—'}
                </p>
              </div>
            ))}
            <p className="renewal-muted">
              Частки мають давати 100%. Після створення налаштуй категорії, цілі та підплани кожної
              частини. Наявні фіксовані ліміти відповідних категорій стануть підпланами. Окремі
              відсоткові ліміти збережуть свою базу й залишаться додатковим контролем. Це
              планування, гроші автоматично не списуються.
            </p>
          </>
        ) : (
          <>
            {field('Назва плану', name, setName)}
            <label className="renewal-field">
              Основний план
              <select
                disabled={pending}
                value={parentId}
                onChange={(e) => {
                  setParent(e.target.value);
                  const p = f.budgets.find((b) => b.id === e.target.value);
                  if (p) {
                    setPurpose(p.purpose);
                    setCategories(categories.filter((c) => p.categories.includes(c)));
                  }
                }}
              >
                <option value="">Окремий план</option>
                {f.budgets
                  .filter((b) => !descendants.has(b.id))
                  .map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.category}
                    </option>
                  ))}
              </select>
            </label>
            <label className="renewal-field">
              Призначення
              <select
                disabled={pending || !!parent}
                value={purpose}
                onChange={(e) => setPurpose(e.target.value as Budget['purpose'])}
              >
                <option value="expense">Особисті витрати</option>
                <option value="saving">Відкладання на цілі</option>
              </select>
            </label>
            <div className="renewal-form-grid">
              <label className="renewal-field">
                Період
                <select
                  disabled={pending}
                  value={period}
                  onChange={(e) => setPeriod(e.target.value as Budget['period'])}
                >
                  <option value="day">День</option>
                  <option value="week">Тиждень</option>
                  <option value="month">Місяць</option>
                </select>
              </label>
              <label className="renewal-field">
                Як задаємо суму
                <select disabled={pending} value={mode} onChange={(e) => setMode(e.target.value)}>
                  <option value="fixed">Фіксована сума</option>
                  <option value="percent">
                    {parent ? 'Частка основного плану' : 'Частка доходу'}
                  </option>
                </select>
              </label>
            </div>
            {mode === 'fixed' ? (
              field('Сума на обраний період, ₴', amount, setAmount, true)
            ) : (
              <>
                {field('Частка, %', percent, setPercent, true)}
                {!parent && field('Плановий дохід за цей період, ₴', base, setBase, true)}
                {parent && (
                  <p className="renewal-muted">
                    Частка від «{parent.category}». Для іншого періоду сума перераховується
                    пропорційно кількості днів.
                  </p>
                )}
              </>
            )}
            <p className="renewal-inset">
              Розрахований ліміт: <b>{preview == null ? '—' : moneyLabel(preview)}</b>
            </p>
            {purpose === 'saving' ? (
              <label className="renewal-field">
                Куди відкладаємо
                <select disabled={pending} value={goalId} onChange={(e) => setGoal(e.target.value)}>
                  <option value="">Усі фінансові цілі</option>
                  {f.goals
                    .filter((g) => g.status === 'active')
                    .map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                </select>
              </label>
            ) : (
              <fieldset>
                <legend className="renewal-muted mb-2">
                  Які витрати враховувати · {categories.length} категорій
                </legend>
                {field('Знайти категорію', search, setSearch)}
                <div className="finance-category-picker mt-3">
                  {(parent ? parent.categories : f.categories)
                    .filter(
                      (c) =>
                        ![
                          'дохід',
                          'зарплата',
                          'таксі',
                          'чайові',
                          'заощадження',
                          'перекази й готівка',
                        ].includes(c) &&
                        financeCategoryLabel(c)
                          .toLocaleLowerCase('uk-UA')
                          .includes(search.toLocaleLowerCase('uk-UA')),
                    )
                    .map((c) => (
                      <button
                        disabled={pending}
                        type="button"
                        className="renewal-secondary"
                        key={c}
                        aria-pressed={categories.includes(c)}
                        onClick={() =>
                          setCategories(
                            categories.includes(c)
                              ? categories.filter((k) => k !== c)
                              : [...categories, c],
                          )
                        }
                      >
                        {categories.includes(c) ? '✓ ' : ''}
                        {financeCategoryLabel(c)}
                      </button>
                    ))}
                </div>
              </fieldset>
            )}
            <label className="finance-toggle">
              <input
                type="checkbox"
                disabled={pending}
                checked={forecast}
                onChange={(e) => setForecast(e.target.checked)}
              />
              <span>Включати майбутні витрати у прогноз</span>
            </label>
            <p className="renewal-chart-note">
              Підплани деталізують суму батьківського плану, а не додаються повторно. Для окремого
              альтернативного ліміту вимкни прогноз. Відкладання відстежують внески на ціль; план
              сам не переказує гроші.
            </p>
          </>
        )}
        {(inputError || error) && (
          <p role="alert" className="text-neg text-sm">
            {inputError || error}
          </p>
        )}
        <button className="renewal-button" disabled={pending} onClick={submit}>
          {pending ? 'Зберігаю…' : 'Перевірив — зберегти план'}
        </button>
        {old &&
          (remove ? (
            <div className="renewal-inset">
              <p className="renewal-muted">
                Прибрати «{old.category}»{descendants.size > 1 ? ' разом із його підпланами' : ''}?
                Історія витрат і внесків залишиться.
              </p>
              <div className="renewal-form-grid mt-3">
                <button
                  className="renewal-secondary"
                  disabled={pending}
                  onClick={() => setRemove(false)}
                >
                  Залишити
                </button>
                <button
                  className="renewal-secondary text-neg"
                  disabled={pending}
                  onClick={() => onSave('budget-remove', { budgetId: old.id }, expectedVersion)}
                >
                  Прибрати план
                </button>
              </div>
            </div>
          ) : (
            <button
              className="renewal-link text-neg"
              disabled={pending}
              onClick={() => setRemove(true)}
            >
              Видалити план
            </button>
          ))}
      </div>
    </Sheet>
  );
}
