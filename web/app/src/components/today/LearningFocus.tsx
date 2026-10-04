import { useState } from 'react';
import { useTick } from '../../lib/useTick.ts';
import { haptic } from '../../telegram.ts';

const KEY = 'svitanok:learning-focus';
function read(): { task?: string; minutes?: number; until?: number } {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return {
      task: typeof v?.task === 'string' ? v.task.slice(0, 180) : undefined,
      minutes: [15, 25, 45, 60].includes(v?.minutes) ? v.minutes : 25,
      until: Number.isFinite(v?.until) && v.until > 0 ? v.until : undefined,
    };
  } catch {
    return {};
  }
}
export function LearningFocus() {
  const [plan, setPlan] = useState(read);
  const [editing, setEditing] = useState(false);
  const now = useTick(1000);
  const remaining = plan.until ? Math.max(0, Math.ceil((plan.until - now) / 1000)) : null;
  const save = (next: typeof plan) => {
    setPlan(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* Keep the session usable. */
    }
  };
  return (
    <section>
      <div className="renewal-section-label">
        Твій наступний крок<span className="renewal-pill">Mate Academy</span>
      </div>
      <div className="renewal-card">
        <h2 className="text-lg font-semibold">Залишити місце для навчання</h2>
        <p className="renewal-muted mt-2">
          {plan.task || 'Один зосереджений блок для того, що зараз важливо.'}
        </p>
        {remaining != null && (
          <div className="renewal-focus-clock" role="timer">
            {String(Math.floor(remaining / 60)).padStart(2, '0')}:
            {String(remaining % 60).padStart(2, '0')}
          </div>
        )}
        {remaining === 0 && (
          <p className="text-pos text-sm mb-3">✨ Блок завершено. Зроби коротку паузу.</p>
        )}
        {editing && (
          <div className="flex flex-col gap-3 mt-4">
            <label className="renewal-field">
              Що хочеш зробити?
              <input
                maxLength={180}
                value={plan.task ?? ''}
                onChange={(e) => save({ ...plan, task: e.target.value })}
              />
            </label>
            <label className="renewal-field">
              Тривалість
              <select
                value={plan.minutes ?? 25}
                onChange={(e) => save({ ...plan, minutes: Number(e.target.value) })}
              >
                {[15, 25, 45, 60].map((n) => (
                  <option key={n} value={n}>
                    {n} хвилин
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        <div className="renewal-actions mb-0">
          <button
            className="renewal-button"
            onClick={() => {
              save({
                ...plan,
                until:
                  remaining != null && remaining > 0
                    ? undefined
                    : Date.now() + (plan.minutes ?? 25) * 60000,
              });
              haptic('light');
            }}
          >
            {remaining != null && remaining > 0 ? 'Зупинити' : `Почати ${plan.minutes ?? 25} хв`}
          </button>
          <button
            className="renewal-secondary"
            aria-expanded={editing}
            onClick={() => setEditing(!editing)}
          >
            {editing ? 'Готово' : 'Змінити план'}
          </button>
        </div>
      </div>
    </section>
  );
}
