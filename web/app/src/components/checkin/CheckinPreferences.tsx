import { useState } from 'react';
import { useSettings, useSaveSettings } from '../../api/hooks.ts';
import {
  normalizeCheckinPreferences,
  validSchedule,
  CHECKIN_MODULES,
  ACTIVITY_GROUPS,
  ACTIVITIES,
  type CheckinPreferences as Preferences,
} from '../../../../core/checkin/catalog.mjs';

export function CheckinPreferences() {
  const query = useSettings(),
    save = useSaveSettings();
  const p = normalizeCheckinPreferences(query.data?.settings.checkin);
  const [schedule, setSchedule] = useState<Preferences['schedule'] | null>(null);
  const [habit, setHabit] = useState(''),
    [category, setCategory] = useState(''),
    [group, setGroup] = useState(ACTIVITY_GROUPS[0] ?? '');
  const [message, setMessage] = useState('');
  function update(next: Preferences) {
    save.mutate(
      { checkin: next },
      {
        onSuccess: () => setMessage('Збережено'),
        onError: () => setMessage('Не вдалося зберегти. Спробуй ще раз.'),
      },
    );
  }
  return (
    <details className="renewal-card">
      <summary className="cursor-pointer font-semibold">Мій чек-ін: модулі, час і звички</summary>
      <div className="mt-5 flex flex-col gap-5">
        <p className="renewal-muted">
          Основні питання залишаються короткими. Увімкнені модулі доступні в «Додати деталі» й не
          додаються до ядра автоматично.
        </p>
        <div className="flex flex-col gap-3">
          {CHECKIN_MODULES.map(([id, name]) => (
            <label key={id} className="flex gap-3 items-center">
              <input
                type="checkbox"
                checked={p.modules.includes(id!)}
                onChange={(e) =>
                  update({
                    ...p,
                    modules: e.target.checked
                      ? [...p.modules, id!]
                      : p.modules.filter((x) => x !== id),
                  })
                }
              />
              <span>{name}</span>
            </label>
          ))}
        </div>
        <fieldset className="renewal-inset">
          <legend className="font-semibold">Вікна за Києвом</legend>
          <p className="renewal-chart-note mb-3">
            Початок ранку → дня → вечора → завершення вечора. Новий розклад застосовується до
            наступних відповідей, попередні не переміщуються.
          </p>
          <div className="renewal-form-grid">
            {(['morning', 'afternoon', 'evening', 'end'] as const).map((key, i) => (
              <label key={key} className="renewal-field">
                <span>{['Ранок', 'День', 'Вечір', 'Кінець вечора'][i]}</span>
                <input
                  type="time"
                  value={(schedule ?? p.schedule)[key]}
                  onChange={(e) =>
                    setSchedule({ ...(schedule ?? p.schedule), [key]: e.target.value })
                  }
                />
              </label>
            ))}
          </div>
          {schedule && !validSchedule(schedule) && (
            <p role="alert" className="text-neg text-sm mt-3">
              Вікна мають йти по черзі, тривати хоча б годину та не перекриватися.
            </p>
          )}
          <button
            type="button"
            className="renewal-secondary mt-3"
            disabled={!schedule || !validSchedule(schedule) || save.isPending}
            onClick={() => {
              if (schedule) {
                update({ ...p, schedule });
                setSchedule(null);
              }
            }}
          >
            Зберегти розклад
          </button>
        </fieldset>
        <fieldset className="renewal-inset">
          <legend className="font-semibold">Власні звички</legend>
          <p className="renewal-chart-note">
            Відмітки окремі від оцінки дня. Графік визначає, у які дні звичка з’являється.
          </p>
          {p.habits.map((h) => (
            <div key={h.id} className="mt-4">
              <div className="flex justify-between gap-2">
                <b>{h.name}</b>
                <button
                  className="renewal-link"
                  onClick={() => update({ ...p, habits: p.habits.filter((x) => x.id !== h.id) })}
                >
                  Прибрати
                </button>
              </div>
              <div className="flex flex-wrap gap-2 mt-2">
                {['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'].map((label, d) => (
                  <button
                    key={d}
                    className="renewal-pill"
                    aria-pressed={h.days.includes(d)}
                    onClick={() =>
                      update({
                        ...p,
                        habits: p.habits.map((x) =>
                          x.id === h.id
                            ? {
                                ...x,
                                days: h.days.includes(d)
                                  ? h.days.filter((v) => v !== d)
                                  : [...h.days, d],
                              }
                            : x,
                        ),
                      })
                    }
                  >
                    {h.days.includes(d) ? '✓ ' : ''}
                    {label}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <label className="renewal-field mt-4">
            <span>Нова звичка</span>
            <input
              value={habit}
              maxLength={80}
              onChange={(e) => setHabit(e.target.value)}
              placeholder="Наприклад, 15 хв читання"
            />
          </label>
          <button
            className="renewal-secondary mt-3"
            disabled={!habit.trim() || p.habits.length >= 12}
            onClick={() => {
              update({
                ...p,
                modules: [...new Set([...p.modules, 'habits'])],
                habits: [
                  ...p.habits,
                  { id: crypto.randomUUID(), name: habit.trim(), days: [0, 1, 2, 3, 4, 5, 6] },
                ],
              });
              setHabit('');
            }}
          >
            Додати звичку
          </button>
          <button
            className="renewal-link block mt-3"
            disabled={p.habits.length > 7}
            onClick={() =>
              update({
                ...p,
                modules: [...new Set([...p.modules, 'habits'])],
                habits: [
                  ...p.habits,
                  ...['TikTok', 'Duolingo', 'Snapchat', 'BeReal', 'Шахи']
                    .filter((name) => !p.habits.some((h) => h.name === name))
                    .map((name, i) => ({ id: `legacy_${i}`, name, days: [0, 1, 2, 3, 4, 5, 6] })),
                ],
              })
            }
          >
            Додати попередні п’ять трекерів
          </button>
        </fieldset>
        <fieldset className="renewal-inset">
          <legend className="font-semibold">Мої категорії занять</legend>
          <div className="flex flex-wrap gap-2 mt-2">
            {ACTIVITIES.map((c) => (
              <label key={c.id} className="renewal-pill flex gap-2">
                <input
                  type="checkbox"
                  checked={!p.hiddenCategories.includes(c.id)}
                  onChange={(e) =>
                    update({
                      ...p,
                      hiddenCategories: e.target.checked
                        ? p.hiddenCategories.filter((id) => id !== c.id)
                        : [...p.hiddenCategories, c.id],
                    })
                  }
                />
                {c.name}
              </label>
            ))}
          </div>
          {p.categories.map((c) => (
            <div key={c.id} className="renewal-list-row">
              <span>
                {c.name} · {c.group}
              </span>
              <button
                className="renewal-link"
                onClick={() =>
                  update({ ...p, categories: p.categories.filter((x) => x.id !== c.id) })
                }
              >
                Прибрати
              </button>
            </div>
          ))}
          <label className="renewal-field mt-3">
            <span>Назва власної категорії</span>
            <input value={category} maxLength={80} onChange={(e) => setCategory(e.target.value)} />
          </label>
          <label className="renewal-field mt-3">
            <span>Стабільна група для порівнянь</span>
            <select value={group} onChange={(e) => setGroup(e.target.value)}>
              {ACTIVITY_GROUPS.map((g) => (
                <option key={g}>{g}</option>
              ))}
            </select>
          </label>
          <button
            className="renewal-secondary mt-3"
            disabled={!category.trim() || p.categories.length >= 20}
            onClick={() => {
              update({
                ...p,
                categories: [
                  ...p.categories,
                  {
                    id: `custom_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`,
                    name: category.trim(),
                    group,
                  },
                ],
              });
              setCategory('');
            }}
          >
            Додати категорію
          </button>
        </fieldset>
        {message && (
          <p role="status" className="text-sm text-tx2">
            {message}
          </p>
        )}
        {save.error && (
          <p role="alert" className="text-neg text-sm">
            {save.error.message}
          </p>
        )}
      </div>
    </details>
  );
}
