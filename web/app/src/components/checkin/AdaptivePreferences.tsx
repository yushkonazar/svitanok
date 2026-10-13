import { useState } from 'react';
import { useSettings, useSaveSettings } from '../../api/hooks.ts';
import { adaptivePreferences } from '../../../../core/checkin/adaptive.mjs';
import { validSchedule, type CheckinPreferences } from '../../../../core/checkin/catalog.mjs';

export function AdaptivePreferences() {
  const query = useSettings(),
    save = useSaveSettings();
  const p = adaptivePreferences(query.data?.settings.checkin);
  const [schedule, setSchedule] = useState<CheckinPreferences['schedule'] | null>(null);
  const [message, setMessage] = useState('');
  const shown = schedule ?? p.schedule;
  const morningEnd =
    shown.morning < '13:00' && shown.afternoon > '13:00' ? '13:00' : shown.afternoon;
  return (
    <details className="renewal-card">
      <summary className="cursor-pointer font-semibold">Мій ритм і джерела даних</summary>
      <div className="mt-5 flex flex-col gap-5">
        <p className="renewal-muted">
          Питання пов’язані автоматично. Напрямки обирати не потрібно. Уточнення можна пропускати.
        </p>
        <fieldset className="renewal-inset">
          <legend className="font-semibold">Час за Києвом</legend>
          <p className="renewal-chart-note mb-3">
            Початки вікон визначають, коли доступний кожен чек-ін. Після опівночі до межі ночі
            вечірній запис належить попередньому дню. Нагадування вмикаються окремо у фінансових
            налаштуваннях.
          </p>
          <div className="renewal-form-grid">
            {(['morning', 'afternoon', 'evening', 'end'] as const).map((key, i) => (
              <label className="renewal-field" key={key}>
                <span>
                  {
                    [
                      'Початок ранкового вікна',
                      'Початок денного',
                      'Початок вечірнього',
                      'Межа ночі',
                    ][i]
                  }
                </span>
                <input
                  type="time"
                  disabled={save.isPending}
                  value={shown[key]}
                  onChange={(e) =>
                    setSchedule({ ...(schedule ?? p.schedule), [key]: e.target.value })
                  }
                />
              </label>
            ))}
          </div>
          {validSchedule(shown) && (
            <p className="renewal-chart-note mt-3">
              Ранок {shown.morning}–{morningEnd}; день {shown.afternoon}–{shown.evening}; вечір{' '}
              {shown.evening}–{shown.end}
              {shown.end <= shown.morning ? ' наступного дня' : ''}.
              {morningEnd < shown.afternoon
                ? ` Між ${morningEnd} та ${shown.afternoon} — пауза.`
                : ''}
            </p>
          )}
          {schedule && !validSchedule(schedule) && (
            <p role="alert" className="text-neg mt-3">
              Вікна мають йти по черзі й тривати щонайменше годину.
            </p>
          )}
          <button
            className="renewal-secondary mt-4"
            disabled={!schedule || !validSchedule(schedule) || save.isPending}
            onClick={() => {
              setMessage('');
              if (schedule)
                save.mutate(
                  { checkin: { ...p, version: 3, schedule } },
                  {
                    onSuccess: () => {
                      setMessage('Розклад збережено');
                      setSchedule(null);
                    },
                    onError: () => setMessage('Не вдалося зберегти. Спробуй ще раз.'),
                  },
                );
            }}
          >
            {save.isPending ? 'Зберігаю…' : 'Зберегти розклад'}
          </button>
          {schedule && (
            <button
              className="renewal-link mt-2"
              disabled={save.isPending}
              onClick={() => {
                setSchedule(null);
                setMessage('');
              }}
            >
              Скасувати зміни розкладу
            </button>
          )}
          {message && (
            <p role="status" className="renewal-chart-note mt-3">
              {message}
            </p>
          )}
        </fieldset>
        <div className="renewal-inset">
          <h3 className="font-semibold">Apple «Здоров’я»</h3>
          <span className="renewal-pill mt-3">Не підключено</span>
          <p className="renewal-chart-note mt-3">
            До налаштування передачі з iPhone тривалість сну вказується вручну. Самопочуття й
            пояснення завжди залишаються твоїми відповідями.
          </p>
          <p className="renewal-chart-note mt-2">
            Підключення потребує окремого налаштування на телефоні; наявність Apple Watch сама по
            собі не передає дані у Світанок.
          </p>
        </div>
      </div>
    </details>
  );
}
