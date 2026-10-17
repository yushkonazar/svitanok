import { useId } from 'react';

export function readablePlanDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'Обрати дату';
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString('uk-UA', {
        weekday: 'short',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'Europe/Kyiv',
      })
    : 'Обрати дату';
}

/** Accept a clock or four digits from the iPhone numeric keyboard. */
export function normalizePlanClock(value: string) {
  const raw = value.trim();
  if (/^\d{1,2}$/.test(raw)) return `${raw.padStart(2, '0')}:00`;
  if (/^\d{3,4}$/.test(raw)) {
    const digits = raw.padStart(4, '0');
    return `${digits.slice(0, 2)}:${digits.slice(2)}`;
  }
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(raw);
  return match ? `${match[1]!.padStart(2, '0')}:${match[2]!.padStart(2, '0')}` : raw;
}

export function PlanDateInput({
  label,
  value,
  onChange,
  required = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
}) {
  const id = useId();
  return (
    <label className="plan-date-choice" htmlFor={id}>
      <span>{readablePlanDate(value)}</span>
      <span aria-hidden="true">▾</span>
      <input
        id={id}
        aria-label={label}
        type="date"
        lang="uk-UA"
        value={value}
        required={required}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

/** App-rendered Ukrainian date + a 24-hour clock; native picker locale cannot change the readout. */
export function PlanLocalTime({
  label,
  value,
  onChange,
  defaultDate,
  required = false,
  error,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  defaultDate: string;
  required?: boolean;
  error?: string;
}) {
  const [date, time = ''] = value.split('T');
  return (
    <fieldset className="plan-local-time" data-time-field={label}>
      <legend>{label}</legend>
      <div className="plan-local-time-row">
        <PlanDateInput
          label={`${label}: дата`}
          value={date || defaultDate}
          onChange={(next) => onChange(next ? `${next}T${time}` : '')}
        />
        <input
          aria-label={`${label}: час`}
          aria-invalid={Boolean(error)}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          placeholder="ГГ:ХХ"
          maxLength={5}
          value={time}
          aria-required={required || Boolean(value)}
          onChange={(event) =>
            onChange(
              !event.target.value && !required
                ? ''
                : `${date || defaultDate}T${event.target.value.replace(/[^\d:]/g, '')}`,
            )
          }
          onBlur={() => {
            if (time) onChange(`${date || defaultDate}T${normalizePlanClock(time)}`);
          }}
        />
      </div>
      <small>
        24-годинний час · Київ
        {!required && value ? (
          <button type="button" onClick={() => onChange('')} aria-label={`Очистити ${label}`}>
            Прибрати час ×
          </button>
        ) : null}
      </small>
      {error && (
        <p className="plan-error" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}
