import { useState } from 'react';
import type { Finance } from '../../api/finance-schema.ts';
import { financeDisplay, recommendThresholds } from '../../../../core/finance/display.mjs';
import { parseMoney } from '../../../../core/finance/planning.mjs';
import { expensePalette } from '../../lib/expensePalette.ts';
import { Sheet } from '../ui/Sheet.tsx';
import { useFinanceAction } from './useFinanceAction.ts';
export function FinanceDisplaySettings({
  finance,
  onClose,
}: {
  finance: Finance;
  onClose: () => void;
}) {
  const initial = financeDisplay(finance.display),
    [display, setDisplay] = useState(initial);
  const [bounds, setBounds] = useState(initial.expenseThresholds.map((n) => String(n / 100))),
    [validation, setValidation] = useState('');
  const action = useFinanceAction(finance),
    suggestion = recommendThresholds(finance.transactions, bounds.length || 3);
  const palette = expensePalette(bounds.length + 1);
  const save = async () => {
    try {
      const parsed = financeDisplay({
        ...display,
        expenseThresholds: bounds.map((v) => parseMoney(v)),
      });
      setValidation('');
      if (await action.run('display-settings', { ...parsed })) onClose();
    } catch (e) {
      setValidation(e instanceof Error ? e.message : 'Перевір межі');
    }
  };
  return (
    <Sheet label="Вигляд і прогноз фінансів" onClose={onClose}>
      <div className="renewal-finance flex flex-col gap-4">
        <h2 className="text-xl font-bold">Вигляд і прогноз</h2>
        <fieldset
          disabled={action.pending || action.uncertain}
          className="border-0 p-0 flex flex-col gap-4"
        >
          <h3 className="font-bold">Ваші межі витрат</h3>
          <p className="renewal-chart-note">
            Від найменшої до найбільшої, у гривнях. Гранична сума входить у нижній діапазон.
            Відтінки перебудовуються автоматично.
          </p>
          {bounds.map((v, i) => (
            <label className="renewal-field" key={i}>
              До суми, ₴
              <div className="flex gap-2">
                <input
                  inputMode="decimal"
                  value={v}
                  onChange={(e) => setBounds(bounds.map((x, j) => (j === i ? e.target.value : x)))}
                />
                <button
                  type="button"
                  className="renewal-secondary"
                  aria-label={`Прибрати межу ${i + 1}`}
                  onClick={() => setBounds(bounds.filter((_, j) => j !== i))}
                >
                  −
                </button>
              </div>
            </label>
          ))}
          <button
            className="renewal-secondary"
            onClick={() => setBounds([...bounds, ''])}
            disabled={bounds.length >= 20}
          >
            Додати межу
          </button>
          <div
            className="finance-palette-preview"
            aria-label={`${palette.length} діапазонів витрат`}
          >
            {palette.map((p, i) => (
              <span key={i} style={{ background: p.dark, color: 'oklch(0.2 0.02 25)' }}>
                {i + 1}
              </span>
            ))}
          </div>
          <button
            className="renewal-link"
            disabled={!suggestion.values.length}
            onClick={() => setBounds(suggestion.values.map((n) => String(n / 100)))}
          >
            Рекомендації з історії · {suggestion.observations} витрат
          </button>
          <p className="renewal-chart-note">
            Рекомендації замінять межі лише після вашого вибору й збереження.
          </p>
          <label className="flex gap-3">
            <input
              type="checkbox"
              checked={display.currencyCycle}
              onChange={(e) => setDisplay({ ...display, currencyCycle: e.target.checked })}
            />
            Перемикати валюту й гривню кожні 3 секунди
          </label>
          <label className="flex gap-3">
            <input
              type="checkbox"
              checked={display.animations}
              onChange={(e) => setDisplay({ ...display, animations: e.target.checked })}
            />
            Плавні анімації та підсвічування оплати
          </label>
          <label className="renewal-field">
            Повсякденні витрати у прогнозі
            <select
              value={display.expenseForecast}
              onChange={(e) =>
                setDisplay({ ...display, expenseForecast: e.target.value as 'history' | 'plan' })
              }
            >
              <option value="history">За історією · адаптивна оцінка</option>
              <option value="plan">За ввімкненими планами витрат</option>
            </select>
          </label>
          <label className="renewal-field">
            Орієнтовний день тижневого внеску
            <select
              value={display.savingWeekday}
              onChange={(e) => setDisplay({ ...display, savingWeekday: Number(e.target.value) })}
            >
              {['Понеділок', 'Вівторок', 'Середа', 'Четвер', 'П’ятниця', 'Субота', 'Неділя'].map(
                (day, i) => (
                  <option value={i} key={day}>
                    {day}
                  </option>
                ),
              )}
            </select>
          </label>
          <p className="renewal-chart-note">
            Орієнтир для прогнозу, без дедлайнів. Неповні внески переносяться; очікуваний темп
            адаптується до історії.
          </p>
        </fieldset>
        {(validation || action.error) && (
          <p role="alert" className="text-neg">
            {validation || action.error}
          </p>
        )}
        <button className="renewal-button" disabled={action.pending} onClick={() => void save()}>
          {action.pending ? 'Зберігаю…' : action.uncertain ? 'Перевірити збереження' : 'Зберегти'}
        </button>
        <button
          className="renewal-secondary"
          disabled={action.pending || action.uncertain}
          onClick={onClose}
        >
          Закрити
        </button>
      </div>
    </Sheet>
  );
}
