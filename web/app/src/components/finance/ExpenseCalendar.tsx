import { useId, useState } from 'react';
import { moneyLabel } from '../../lib/financeView.ts';
import { expenseBand } from '../../lib/expensePalette.ts';
import { quantile } from '../../../../core/finance/adaptive-model.mjs';

export function ExpenseCalendar({
  daily,
  onSelect,
  thresholds,
  dailyLimit,
  knownSince,
  issueDates = [],
}: {
  daily: { date: string; expenseMinor: number; count: number }[];
  onSelect: (date: string) => void;
  thresholds?: number[];
  dailyLimit?: number;
  knownSince?: string | null;
  issueDates?: string[];
}) {
  const id = useId();
  const months = [...new Set(daily.map((day) => day.date.slice(0, 7)))];
  const [chosenMonth, setChosenMonth] = useState(months.at(-1) ?? '');
  const [selected, setSelected] = useState(''),
    [scale, setScale] = useState<'relative' | 'personal'>('relative');
  const month = months.includes(chosenMonth) ? chosenMonth : (months.at(-1) ?? '');
  if (!month) return null;
  const [year, number] = month.split('-').map(Number);
  const first = new Date(Date.UTC(year!, number! - 1, 1));
  const offset = (first.getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(year!, number!, 0)).getUTCDate();
  const records = new Map(daily.map((day) => [day.date, day]));
  const monthRows = daily.filter((d) => d.date.startsWith(month));
  const max = Math.max(
    1,
    quantile(
      monthRows.map((day) => day.expenseMinor).filter((v) => v > 0),
      0.9,
    ),
  );
  const selectedDay = monthRows.find((d) => d.date === selected);
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
        <div className="analytics-row mt-3">
          <span>Записано за місяць</span>
          <b>{moneyLabel(monthRows.reduce((n, d) => n + d.expenseMinor, 0))}</b>
        </div>
        <div className="renewal-segments mt-3" aria-label="Кольорова шкала календаря">
          <button aria-pressed={scale === 'relative'} onClick={() => setScale('relative')}>
            Відносна інтенсивність
          </button>
          <button aria-pressed={scale === 'personal'} onClick={() => setScale('personal')}>
            Мої межі сум
          </button>
        </div>
        <p className="renewal-chart-note mt-3">
          {scale === 'relative'
            ? 'Яскравість відносна до днів цього місяця; великі винятки не знебарвлюють решту.'
            : 'Денні суми за вашими межами, однакова шкала для різних місяців.'}{' '}
          Натисни день, щоб побачити операції. Нуль означає відсутність записаних витрат, а не
          підтверджену повноту обліку.
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
            const intensity = record?.expenseMinor
              ? 15 + Math.min(1, Math.sqrt(record.expenseMinor / max)) * 65
              : 0;
            const tone =
              record && record.expenseMinor > 0 && scale === 'personal'
                ? expenseBand(record.expenseMinor, thresholds)
                : null;
            const limited = knownSince === null || (!!knownSince && date < knownSince),
              issue = issueDates.includes(date);
            return (
              <button
                key={date}
                disabled={!record}
                aria-label={`${date}: ${record ? (limited && !record.count ? 'повнота історії невідома' : moneyLabel(record.expenseMinor)) : 'поза вибраним періодом'}`}
                aria-pressed={selected === date}
                onClick={() => {
                  setSelected(date);
                  onSelect(date);
                }}
                style={{
                  background: tone
                    ? `color-mix(in srgb, ${tone.dark} 20%, var(--color-bg2))`
                    : `color-mix(in srgb, var(--color-a2) ${intensity}%, var(--color-bg2))`,
                }}
                className={`${intensity > 45 && scale === 'relative' ? 'analytics-calendar-bright' : ''}${limited || issue ? ' finance-calendar-incomplete' : ''}`}
                title={
                  record
                    ? `${date}: ${moneyLabel(record.expenseMinor)} · ${record.count} операцій${limited ? ' · раніше збереженої історії' : issue ? ' · є записи для перевірки' : ''}`
                    : 'Поза вибраним періодом'
                }
              >
                <b>{i + 1}</b>
                <small>
                  {record
                    ? limited && !record.count
                      ? '?'
                      : (record.expenseMinor / 100).toLocaleString('uk-UA', {
                          notation: 'compact',
                          maximumFractionDigits: 0,
                        })
                    : '·'}
                </small>
              </button>
            );
          })}
        </div>
        {selectedDay && (
          <div className="renewal-inset mt-3">
            <b>
              {selectedDay.date} · {moneyLabel(selectedDay.expenseMinor)}
            </b>
            <p className="renewal-chart-note">
              Операцій: {selectedDay.count}.
              {dailyLimit != null
                ? ` Нинішній денний ліміт для порівняння: ${moneyLabel(dailyLimit)}; ${selectedDay.expenseMinor > dailyLimit ? 'вище' : 'нижче'} на ${moneyLabel(Math.abs(dailyLimit - selectedDay.expenseMinor))}. Історичний ліміт міг відрізнятися.`
                : ''}
            </p>
            <button className="renewal-link" onClick={() => onSelect(selectedDay.date)}>
              Операції цього дня ↗
            </button>
          </div>
        )}
        <p className="renewal-chart-note mt-2">
          Пунктирна рамка — записи потребують перевірки або дата раніше збереженої історії. «?» не
          дорівнює нулю.
        </p>
      </details>
    </section>
  );
}
