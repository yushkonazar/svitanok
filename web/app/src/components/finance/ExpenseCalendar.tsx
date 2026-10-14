import { useId, useState } from 'react';
import { moneyLabel } from '../../lib/financeView.ts';

export function ExpenseCalendar({
  daily,
  onSelect,
}: {
  daily: { date: string; expenseMinor: number; count: number }[];
  onSelect: (date: string) => void;
}) {
  const id = useId();
  const months = [...new Set(daily.map((day) => day.date.slice(0, 7)))];
  const [chosenMonth, setChosenMonth] = useState(months.at(-1) ?? '');
  const month = months.includes(chosenMonth) ? chosenMonth : (months.at(-1) ?? '');
  if (!month) return null;
  const [year, number] = month.split('-').map(Number);
  const first = new Date(Date.UTC(year!, number! - 1, 1));
  const offset = (first.getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(year!, number!, 0)).getUTCDate();
  const records = new Map(daily.map((day) => [day.date, day]));
  const max = Math.max(1, ...daily.map((day) => day.expenseMinor));
  return (
    <section className="renewal-card">
      <details>
        <summary className="font-bold">Календар витрат</summary>
        <label className="renewal-field mt-4" htmlFor={id}>
          Місяць
          <select id={id} value={month} onChange={(event) => setChosenMonth(event.target.value)}>
            {months.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <p className="renewal-chart-note mt-3">
          Яскравіше — більша сума. Натисни день, щоб побачити операції. Нуль означає відсутність
          записаних витрат у вибраному обліку.
        </p>
        <div className="analytics-calendar" aria-label="Витрати за календарними днями">
          {['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'].map((label) => (
            <span className="analytics-calendar-weekday" key={label}>
              {label}
            </span>
          ))}
          {Array.from({ length: offset }, (_, i) => (
            <span aria-hidden="true" key={`empty-${i}`} />
          ))}
          {Array.from({ length: days }, (_, i) => {
            const date = `${month}-${String(i + 1).padStart(2, '0')}`;
            const record = records.get(date);
            const intensity = record?.expenseMinor ? 15 + (record.expenseMinor / max) * 65 : 0;
            return (
              <button
                key={date}
                disabled={!record}
                aria-label={`${date}: ${record ? moneyLabel(record.expenseMinor) : 'поза вибраним періодом'}`}
                onClick={() => onSelect(date)}
                style={{
                  background: `color-mix(in srgb, var(--color-a2) ${intensity}%, var(--color-bg2))`,
                }}
                className={intensity > 45 ? 'analytics-calendar-bright' : ''}
              >
                <b>{i + 1}</b>
                <small>
                  {record
                    ? (record.expenseMinor / 100).toLocaleString('uk-UA', {
                        notation: 'compact',
                        maximumFractionDigits: 0,
                      })
                    : '·'}
                </small>
              </button>
            );
          })}
        </div>
      </details>
    </section>
  );
}
