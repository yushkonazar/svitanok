import { Link } from 'react-router-dom';
import type { Finance } from '../../api/finance-schema.ts';
import { nextTodayPayment } from '../../lib/todayPayment.ts';
import { moneyLabel } from '../../lib/financeView.ts';
import { pluralUk } from '../../lib/plural.ts';
import { UpdatedValue } from '../ui/UpdatedValue.tsx';

export function TodayPayment({
  finance,
  today,
  loading = false,
  failed = false,
}: {
  finance?: Finance;
  today: string;
  loading?: boolean;
  failed?: boolean;
}) {
  const next = finance ? nextTodayPayment(finance.payments, today) : null;
  const eyebrow = (
    <span className="today-side-eyebrow">
      Найближчий платіж <span aria-hidden="true">↗</span>
    </span>
  );
  if (loading && !finance)
    return (
      <div className="today-side-card today-payment-card" aria-busy="true">
        {eyebrow}
        <span className="today-side-copy" role="status">
          Завантажую…
        </span>
      </div>
    );
  if (!next || next.kind !== 'payment') {
    const empty = next?.kind === 'empty' && !failed;
    return (
      <Link
        to={empty ? '/finance?action=payment' : '/finance'}
        className="today-side-card today-payment-card"
      >
        {eyebrow}
        <span className="today-side-copy">
          {empty
            ? 'Немає запланованих'
            : next?.kind === 'invalid-date'
              ? 'Уточни дати платежів'
              : 'Не вдалося оновити'}
        </span>
        <small>{empty ? 'Додати платіж →' : 'Відкрити фінанси →'}</small>
      </Link>
    );
  }
  const { payment, amountMinor, days } = next;
  const status =
    days === 0
      ? 'Сьогодні'
      : days === 1
        ? 'Завтра'
        : days < 0
          ? 'Прострочено на ' + Math.abs(days) + ' ' + pluralUk(days, ['день', 'дні', 'днів'])
          : 'Через ' + days + ' ' + pluralUk(days, ['день', 'дні', 'днів']);
  const date = new Date(payment.nextDate + 'T12:00:00Z').toLocaleDateString('uk-UA', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    ...(payment.nextDate.slice(0, 4) !== today.slice(0, 4) ? { year: 'numeric' } : {}),
  });
  return (
    <Link
      to={'/finance?payment=' + encodeURIComponent(payment.id)}
      className="today-side-card today-payment-card"
      data-overdue={days < 0}
      aria-label={
        'Платіж ' +
        payment.name +
        '. ' +
        status +
        '. ' +
        (amountMinor == null ? 'Суму потрібно уточнити' : moneyLabel(amountMinor)) +
        '. ' +
        date
      }
    >
      {eyebrow}
      <span className="today-payment-name" title={payment.name}>
        {payment.name}
      </span>
      <strong>
        <UpdatedValue
          identity={'payment:' + payment.id}
          value={amountMinor}
          enabled={finance?.display?.animations !== false}
        >
          {amountMinor == null ? 'Уточнити суму' : moneyLabel(amountMinor).replace(/\s/g, ' ')}
        </UpdatedValue>
      </strong>
      <small className="today-payment-meta">
        <span>{status}</span>
        <time dateTime={payment.nextDate}>{date}</time>
        {failed && <span>Збережені дані</span>}
      </small>
    </Link>
  );
}
