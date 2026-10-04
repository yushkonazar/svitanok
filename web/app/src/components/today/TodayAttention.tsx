import { Link } from 'react-router-dom';
import { useStats } from '../../api/hooks.ts';
import { useFinance } from '../../api/finance-hooks.ts';
import { useTick } from '../../lib/useTick.ts';
import { kyivParts } from '../../../../core/finance/planning.mjs';
import { financeView, moneyLabel } from '../../lib/financeView.ts';
import { PageHeading } from '../ui/PageHeading.tsx';

export function TodayAttention() {
  const nowMs = useTick(30_000);
  const { data: stats } = useStats();
  const { data: money } = useFinance();
  const now = kyivParts(nowMs);
  const slot = stats?.stats.checkinSlot;
  const confirmed = slot ? stats?.stats.checkinToday?.[slot]?.confirmed : false;
  const greeting =
    now.hour < 6
      ? 'Тиха ніч.'
      : now.hour < 12
        ? 'Доброго ранку.'
        : now.hour < 18
          ? 'День триває.'
          : 'Час сповільнитися.';
  const view = money ? financeView(money.finance, 7) : null;
  return (
    <div className="renewal-hero" data-night={now.hour < 6 || now.hour >= 20}>
      <PageHeading
        eyebrow={greeting}
        title="Твій день,"
        accent="у фокусі."
        description="Кілька важливих речей. І трохи простору для себе."
      />
      <div className="renewal-actions">
        <Link to="/checkin">
          <span>{confirmed ? '✓ Чек-ін підтверджено' : 'Як ти зараз?'}</span>
          <small>
            {confirmed
              ? 'Наступний слот з’явиться за розкладом'
              : slot
                ? 'Коротка зупинка для себе'
                : 'Переглянути ритм і наступний чек-ін'}
          </small>
        </Link>
        <Link to="/finance">
          <span className="renewal-pill">Фінанси</span>
          <strong>
            {view && !view.unknownBalances ? moneyLabel(view.available) : 'Мої рахунки'}
          </strong>
          <small>
            {view && !view.unknownBalances
              ? `Вільно ${moneyLabel(view.available)}`
              : 'Швидкий запис до фінансів'}
          </small>
        </Link>
      </div>
      <div className="renewal-form-grid mb-4">
        <Link className="renewal-secondary text-center" to="/finance?action=expense">
          ＋ Записати витрату
        </Link>
        <Link className="renewal-secondary text-center" to="/stats">
          ↗ Мій стан
        </Link>
      </div>
      {view && view.reminders.length > 0 && (
        <Link to="/finance" className="renewal-inset block text-sm">
          <span className="text-a2">Найближчі платежі{money?.demo ? ' · демо' : ''}</span>
          {view.reminders.slice(0, 3).map((p) => (
            <span key={p.id} className="mt-2 block text-xs text-tx2">
              {p.name} · {moneyLabel(p.amountMinor)} · {p.nextDate}
            </span>
          ))}
        </Link>
      )}
      {money && money.finance.reserveMinor > 0 && (
        <Link to="/finance" className="mt-3 block text-xs text-tx2">
          Для розрахунку з парком залишити {moneyLabel(money.finance.reserveMinor)}
          {money.demo ? ' · демо' : ''} ↗
        </Link>
      )}
    </div>
  );
}
