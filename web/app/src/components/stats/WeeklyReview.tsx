import { useState } from 'react';
import { weeklyReview } from '../../../../core/checkin/weekly-review.mjs';
export function WeeklyReview({
  records,
  today,
  onDay,
}: {
  records: Record<string, unknown>;
  today: string;
  onDay: (date: string) => void;
}) {
  const [completed, setCompleted] = useState(true);
  const report = weeklyReview(records, today, completed);
  const dateLabel = (d: string) =>
    new Date(d + 'T12:00:00Z').toLocaleDateString('uk-UA', { day: 'numeric', month: 'long' });
  return (
    <section className="renewal-card">
      <p className="renewal-eyebrow">ПОБАЧИТИ ЗМІНИ</p>
      <h2 className="text-lg font-semibold mt-2">Тиждень у кількох спостереженнях</h2>
      <div className="renewal-segments mt-4">
        {[true, false].map((v) => (
          <button key={String(v)} aria-pressed={completed === v} onClick={() => setCompleted(v)}>
            {v ? 'Минулий тиждень' : 'Цей тиждень'}
          </button>
        ))}
      </div>
      <p className="renewal-chart-note mt-3">
        {dateLabel(report.from)} — {dateLabel(report.to)} · {report.recordedDays}/{report.days} днів
        із записами. Уточнення можуть мати кілька відповідей.
      </p>
      <div className="flex flex-col gap-3 mt-4">
        {report.items.map((item) => (
          <details key={item.id} className="renewal-inset">
            <summary className="font-semibold cursor-pointer">{item.title}</summary>
            <p className="renewal-muted mt-3">{item.text}</p>
            <p className="renewal-chart-note mt-3">Перевірити записи:</p>
            <div className="flex flex-wrap gap-2 mt-2">
              {item.dates.map((date) => (
                <button key={date} className="renewal-secondary" onClick={() => onDay(date)}>
                  {dateLabel(date)}
                </button>
              ))}
            </div>
          </details>
        ))}
      </div>
      {!report.items.length && (
        <p className="renewal-muted mt-4">
          Поки мало підтверджених відповідей для спостережень. Для кожного висновку потрібно
          щонайменше три доречні записи; пропуски не рахуються як поганий стан.
        </p>
      )}
    </section>
  );
}
