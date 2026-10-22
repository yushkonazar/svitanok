import { useState } from 'react';
import type { LeisureItem, LeisureReceipt, LeisureWorkspace } from '../../api/leisure.ts';
import {
  LEISURE_EVENT_FORMATS,
  LEISURE_FORMAT_CATEGORIES,
} from '../../../../core/leisure/taxonomy.mjs';
import { LEISURE_FREQUENCIES, type LeisureSelection } from '../../../../core/leisure/selection.mjs';

export function SelectionSettings({
  value,
  onChange,
}: {
  value: LeisureSelection;
  onChange: (next: LeisureSelection) => void;
}) {
  return (
    <section className="leisure-selection-settings" aria-label="Вимоги й частота добірок">
      <h3>Заклади за твоїми вимогами</h3>
      <div className="leisure-catalog-filters">
        <label className="leisure-field">
          Мінімальна оцінка Google
          <select
            value={value.minFoodRating}
            onChange={(e) => onChange({ ...value, minFoodRating: Number(e.target.value) })}
          >
            {[4, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 5].map((n) => (
              <option key={n} value={n}>
                {n.toFixed(1)}
              </option>
            ))}
          </select>
        </label>
        <label className="leisure-field">
          Паркування для виходу автомобілем
          <select
            value={value.parking}
            onChange={(e) =>
              onChange({ ...value, parking: e.target.value as LeisureSelection['parking'] })
            }
          >
            <option value="any">Не впливає на вибір</option>
            <option value="preferred">Бажано мати варіанти</option>
            <option value="required">Лише підтверджені варіанти</option>
          </select>
        </label>
      </div>
      <p className="leisure-secondary">
        Кухні рівноцінні. Зручність розташування оцінюємо для конкретного маршруту, а не як загальну
        якість закладу.
      </p>
      <h3>Як часто пропонувати</h3>
      <div className="leisure-catalog-filters">
        {Object.entries(LEISURE_EVENT_FORMATS)
          .filter(([id]) => id !== 'other')
          .map(([id, label]) => (
            <label className="leisure-field" key={id}>
              {label}
              <select
                value={value.formatFrequency[id] ?? 'sometimes'}
                onChange={(e) =>
                  onChange({
                    ...value,
                    formatFrequency: {
                      ...value.formatFrequency,
                      [id]: e.target.value as LeisureSelection['formatFrequency'][string],
                    },
                  })
                }
              >
                {Object.entries(LEISURE_FREQUENCIES).map(([frequency, name]) => (
                  <option key={frequency} value={frequency}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          ))}
      </div>
      <p className="leisure-secondary">
        «Зрідка» — менше звичайних рекомендацій і пауза після відвідування. Твої явні бажання й
        пріоритети залишаються доступними.
      </p>
      <label className="leisure-field">
        Нових ідей на тиждень, максимум
        <select
          value={value.weeklyLimit}
          onChange={(e) => onChange({ ...value, weeklyLimit: Number(e.target.value) })}
        >
          {[4, 6, 8, 10, 12].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
    </section>
  );
}
const categories = LEISURE_FORMAT_CATEGORIES;
export function CategoryCorrection({
  item,
  busy,
  send,
  done,
}: {
  item: LeisureItem;
  data?: LeisureWorkspace;
  busy: boolean;
  send: (op: string, payload: Record<string, unknown>, id?: string) => Promise<LeisureReceipt>;
  done: () => void;
}) {
  const [format, setFormat] = useState(item.eventFormat ?? 'other'),
    [error, setError] = useState('');
  return (
    <>
      <h2>Уточнити тип події</h2>
      <p>{item.title}</p>
      <label className="leisure-field">
        Що це за активність?
        <select value={format} onChange={(e) => setFormat(e.target.value)}>
          {Object.entries(LEISURE_EVENT_FORMATS).map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <p className="leisure-secondary">
        Зміниться лише класифікація. Твій вибір і відвідування залишаться.
      </p>
      {error && (
        <p role="alert" className="leisure-error">
          {error}
        </p>
      )}
      <button
        type="button"
        className="leisure-button is-primary"
        disabled={busy}
        onClick={() => {
          setError('');
          void send('settings', {
            selection: {
              categoryOverrides: {
                [item.id]: { category: categories[format], eventFormat: format },
              },
            },
          })
            .then(done)
            .catch((e) => setError(e instanceof Error ? e.message : 'Не вдалося зберегти.'));
        }}
      >
        Зберегти уточнення
      </button>
    </>
  );
}
