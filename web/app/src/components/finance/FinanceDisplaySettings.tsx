import { useEffect, useState } from 'react';
import type { Finance } from '../../api/finance-schema.ts';
import {
  financeDisplay,
  recommendThresholds,
  DEFAULT_THRESHOLDS,
} from '../../../../core/finance/display.mjs';
import { parseMoney } from '../../../../core/finance/planning.mjs';
import { expensePalette } from '../../lib/expensePalette.ts';
import { moneyLabel } from '../../lib/financeView.ts';
import { Sheet } from './FinanceSheet.tsx';
import { useFinanceAction } from './useFinanceAction.ts';
import { savePresentation, usePresentation } from '../../lib/presentation.ts';
export function FinanceDisplaySettings({
  finance,
  onClose,
  embedded = false,
  onLockChange,
}: {
  finance: Finance;
  onClose: () => void;
  embedded?: boolean;
  onLockChange?: (locked: boolean) => void;
}) {
  const initial = financeDisplay(finance.display),
    [display, setDisplay] = useState(initial);
  const [direction, setDirection] = useState<'out' | 'in'>('out');
  const [ranges, setRanges] = useState({
    out: initial.expenseThresholds.map((n) => String(n / 100)),
    in: initial.inflowThresholds.map((n) => String(n / 100)),
  });
  const [validation, setValidation] = useState('');
  const { explanations } = usePresentation();
  const bounds = ranges[direction];
  const setBounds = (next: string[]) =>
    setRanges((previous) => ({ ...previous, [direction]: next }));
  const action = useFinanceAction(finance),
    suggestion = recommendThresholds(finance.transactions, bounds.length || 3);
  const palette = expensePalette(bounds.length + 1, direction);
  const examples = palette.map((_, i) => {
    const value = bounds[Math.min(i, bounds.length - 1)];
    try {
      return moneyLabel(
        value === undefined ? 10000 : parseMoney(value) + (i === bounds.length ? 100 : 0),
      );
    } catch {
      return '…';
    }
  });
  const locked = action.pending || action.uncertain;
  useEffect(() => onLockChange?.(locked), [locked, onLockChange]);
  const save = async () => {
    try {
      const parsed = financeDisplay({
        ...display,
        expenseThresholds: ranges.out.map((v) => parseMoney(v)),
        inflowThresholds: ranges.in.map((v) => parseMoney(v)),
      });
      setValidation('');
      if (await action.run('display-settings', { ...parsed })) onClose();
    } catch (e) {
      setValidation(e instanceof Error ? e.message : 'Перевір межі');
    }
  };
  const editor = (
    <div className="flex flex-col gap-3 mt-3">
      <div className="renewal-segments" role="group" aria-label="Напрямок суми">
        <button
          type="button"
          aria-pressed={direction === 'out'}
          onClick={() => setDirection('out')}
        >
          Списання
        </button>
        <button type="button" aria-pressed={direction === 'in'} onClick={() => setDirection('in')}>
          Надходження
        </button>
      </div>
      <button
        type="button"
        className="renewal-secondary"
        onClick={() => setBounds(DEFAULT_THRESHOLDS.map((n) => String(n / 100)))}
      >
        Детальна шкала · 11 відтінків
      </button>
      {explanations && (
        <p className="renewal-chart-note">Гранична сума входить у нижній діапазон.</p>
      )}
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
        type="button"
        onClick={() => setBounds([...bounds, ''])}
        disabled={bounds.length >= 20}
      >
        Додати межу
      </button>
      <details>
        <summary className="renewal-link">Палітра в обох темах</summary>
        <div className="finance-palette-preview">
          {(['dark', 'light'] as const).map((mode) => (
            <div key={mode} data-mode={mode}>
              <b>{mode === 'dark' ? 'Темна' : 'Світла'}</b>
              {palette.map((p, i) => (
                <span key={i} style={{ color: p[mode] }}>
                  {direction === 'in' ? '+' : '−'}
                  {examples[i]}
                </span>
              ))}
            </div>
          ))}
        </div>
      </details>
      {direction === 'out' && (
        <button
          type="button"
          className="renewal-link"
          disabled={!suggestion.values.length}
          onClick={() => setBounds(suggestion.values.map((n) => String(n / 100)))}
        >
          Рекомендації з історії · {suggestion.observations} витрат
        </button>
      )}
    </div>
  );
  const body = (
    <div className="renewal-finance flex flex-col gap-4">
      {!embedded && <h2 className="text-xl font-bold">Вигляд і прогноз</h2>}
      <fieldset disabled={locked} className="border-0 p-0 flex flex-col gap-4">
        <label className="renewal-field">
          Додатковий показник першого екрана
          <select
            value={display.overviewMetric}
            onChange={(e) =>
              setDisplay({
                ...display,
                overviewMetric: e.target.value as typeof display.overviewMetric,
              })
            }
          >
            <option value="payment">Найближча оплата</option>
            <option value="savings">Заощадження на цілях</option>
            <option value="taxi">Таксопарк</option>
          </select>
        </label>
        <label className="flex gap-3">
          <input
            type="checkbox"
            checked={explanations}
            onChange={(e) => savePresentation({ explanations: e.target.checked })}
          />
          Пояснення в блоках
        </label>
        <label className="flex gap-3">
          <input
            type="checkbox"
            checked={display.currencyCycle}
            onChange={(e) => setDisplay({ ...display, currencyCycle: e.target.checked })}
          />
          Перемикати валюту й гривню кожні 1,5 секунди
        </label>
        <label className="flex gap-3">
          <input
            type="checkbox"
            checked={display.animations}
            onChange={(e) => setDisplay({ ...display, animations: e.target.checked })}
          />
          Плавні анімації фінансів
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
        {embedded ? (
          <details className="renewal-inset">
            <summary className="renewal-link">Шкали сум</summary>
            {editor}
          </details>
        ) : (
          editor
        )}
      </fieldset>
      {(validation || action.error) && (
        <p role="alert" className="text-neg">
          {validation || action.error}
        </p>
      )}
      <button className="renewal-button" disabled={action.pending} onClick={() => void save()}>
        {action.pending ? 'Зберігаю…' : action.uncertain ? 'Перевірити збереження' : 'Зберегти'}
      </button>
      {!embedded && (
        <button
          className="renewal-secondary"
          disabled={action.pending || action.uncertain}
          onClick={onClose}
        >
          Закрити
        </button>
      )}
    </div>
  );
  return embedded ? (
    body
  ) : (
    <Sheet
      label="Вигляд і прогноз фінансів"
      onClose={() => {
        if (!locked) onClose();
      }}
    >
      {body}
    </Sheet>
  );
}
