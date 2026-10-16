import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Finance, FinanceCommand } from '../../api/finance-schema.ts';
import { postFinance } from '../../api/client.ts';
import { FINANCE_QUERY } from '../../api/finance-hooks.ts';
import {
  calculateTaxiWeek,
  kyivInstant,
  kyivParts,
  prepareTaxiTransition,
  taxiEntryWeek,
  type TaxiPolicy,
} from '../../../../core/finance/planning.mjs';
import { taxiPeriodLabel, taxiScheduleLabel } from '../../lib/taxiPeriods.ts';
import { moneyLabel } from '../../lib/financeView.ts';
import { Sheet } from '../ui/Sheet.tsx';

export function TaxiTransition({ finance: f, onClose }: { finance: Finance; onClose: () => void }) {
  const [nowMs] = useState(Date.now);
  const query = useQueryClient(),
    today = kyivParts(nowMs);
  const current = f.policies.filter((p) => Date.parse(p.effectiveAt) <= nowMs).at(-1)!;
  const epoch = f.policies
    .filter((p) => p.periodStart && Date.parse(p.effectiveAt) <= nowMs)
    .at(-1);
  const [v, setV] = useState({
    date: today.date,
    time: `${String(today.hour).padStart(2, '0')}:${String(today.minute).padStart(2, '0')}`,
    name: 'Гібрид',
    day: String(epoch?.weekDay ?? 2),
    rollover: `${String(epoch?.weekHour ?? 12).padStart(2, '0')}:${String(epoch?.weekMinute ?? 0).padStart(2, '0')}`,
    profile: 'hybrid',
  });
  const [sides, setSides] = useState<Record<string, 'old' | 'new'>>({});
  const [review, setReview] = useState(false),
    [pending, setPending] = useState(false),
    [error, setError] = useState('');
  const busy = useRef(false),
    command = useRef<FinanceCommand | null>(null);
  let preview: ReturnType<typeof prepareTaxiTransition> | undefined,
    policy: TaxiPolicy | undefined,
    previewError = '';
  let affected: Finance['taxiEntries'] = [];
  try {
    const [hour, minute] = v.time.split(':').map(Number),
      [weekHour, weekMinute] = v.rollover.split(':').map(Number);
    const effectiveAt = new Date(kyivInstant(v.date, hour, minute)).toISOString();
    affected = f.taxiEntries.filter(
      (e) =>
        Date.parse(e.at) >= Date.parse(effectiveAt) &&
        taxiEntryWeek(e, f.policies).to > Date.parse(effectiveAt),
    );
    policy = {
      ...current,
      id: 'transition-preview',
      effectiveAt,
      periodStart: true,
      vehicleName: v.name.trim(),
      weekDay: Number(v.day),
      weekHour,
      weekMinute,
    };
    if (v.profile === 'hybrid')
      Object.assign(policy, {
        fareBps: 5000,
        commissionBps: 5000,
        fuelBps: 5000,
        tipsBps: 5000,
        thresholdMinor: null,
        bonusFareBps: 5000,
      });
    preview = prepareTaxiTransition(
      f.taxiEntries,
      f.policies,
      f.settlements,
      policy,
      affected.filter((e) => sides[e.id] === 'old').map((e) => e.id),
    );
  } catch (e) {
    previewError = e instanceof Error ? e.message : 'Перевір дані переходу';
  }
  const changed = (key: keyof typeof v, value: string) => {
    setV((old) => ({ ...old, [key]: value }));
    setReview(false);
    setError('');
    command.current = null;
  };
  const updatePreviewEntries = () =>
    f.taxiEntries.map((e) => {
      const update = preview?.updates.find((u) => u.id === e.id);
      return update ? { ...e, ...update } : e;
    });
  const oldWeek =
    preview && policy
      ? calculateTaxiWeek(updatePreviewEntries(), [...f.policies, policy], preview.previous.from)
      : null;
  const newWeek =
    preview && policy
      ? calculateTaxiWeek(updatePreviewEntries(), [...f.policies, policy], preview.next.from)
      : null;
  const held =
    oldWeek?.entries.reduce(
      (sum, e) => sum + (e.receivedCashMinor ?? 0) - (e.paidWorkMinor ?? 0),
      0,
    ) ?? 0;
  const chooseAll = affected.every((e) => sides[e.id]);
  async function submit() {
    if (busy.current) return;
    if (!preview || !policy || !chooseAll) {
      setError(previewError || 'Для кожного наявного запису обери попереднє або нове авто.');
      return;
    }
    if (!review) {
      setReview(true);
      setError('');
      return;
    }
    const { id: _id, ...payload } = policy;
    const data = {
      ...payload,
      keepPreviousEntryIds: affected.filter((e) => sides[e.id] === 'old').map((e) => e.id),
    };
    const next: FinanceCommand = {
      id: crypto.randomUUID(),
      version: f.version,
      type: 'taxi-transition',
      payload: data,
    };
    if (
      !command.current ||
      command.current.version !== next.version ||
      JSON.stringify(command.current.payload) !== JSON.stringify(data)
    )
      command.current = next;
    busy.current = true;
    setPending(true);
    setError('');
    try {
      await postFinance(command.current);
      await query.invalidateQueries({ queryKey: FINANCE_QUERY });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не вдалося зберегти перехід');
      await query.invalidateQueries({ queryKey: FINANCE_QUERY });
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  const field = (key: 'date' | 'time' | 'name' | 'rollover', label: string, type = 'text') => (
    <label className="renewal-field">
      {label}
      <input
        value={v[key]}
        type={type}
        maxLength={key === 'name' ? 80 : undefined}
        onChange={(e) => changed(key, e.target.value)}
        disabled={pending}
      />
    </label>
  );
  return (
    <Sheet
      label="Зміна авто й перезмінки"
      onClose={() => {
        if (!busy.current) onClose();
      }}
      resetKey={review ? 1 : 0}
    >
      <div className="renewal-finance flex flex-col gap-4">
        <div className="renewal-section-head">
          <h2 className="text-xl font-bold">Зміна авто й перезмінки</h2>
          <button
            type="button"
            className="renewal-secondary"
            aria-label="Закрити"
            onClick={onClose}
            disabled={pending}
          >
            ×
          </button>
        </div>
        <p className="renewal-chart-note">
          {review ? 'Крок 2 з 2 · перевір розділення' : 'Крок 1 з 2 · час і нові умови'}
        </p>
        {!review ? (
          <>
            <p className="renewal-muted">
              Використовуй при зміні авто посеред тижня або зміні дня перезмінки. Поточний період
              завершиться у вказаний час; історія залишиться окремо.
            </p>
            {field('name', 'Назва нового авто / режиму')}
            <div className="renewal-form-grid">
              {field('date', 'Дата переходу', 'date')}
              {field('time', 'Час переходу · Київ', 'time')}
            </div>
            <label className="renewal-field">
              Умови нового авто
              <select value={v.profile} onChange={(e) => changed('profile', e.target.value)}>
                <option value="hybrid">Гібрид · завжди 50/50</option>
                <option value="same">Зберегти чинні відсотки</option>
              </select>
            </label>
            <p className="renewal-chart-note">
              {v.profile === 'hybrid'
                ? 'Каса, комісія, пальне й чайові в застосунку — 50/50. Підвищення частки за порогом вимкнене.'
                : 'Чинні частки й поріг переходять у новий період; попередня історія не змінюється.'}
            </p>
            <label className="renewal-field">
              День регулярної перезмінки
              <select value={v.day} onChange={(e) => changed('day', e.target.value)}>
                {['Понеділок', 'Вівторок', 'Середа', 'Четвер', 'П’ятниця', 'Субота', 'Неділя'].map(
                  (d, i) => (
                    <option key={d} value={i}>
                      {d}
                    </option>
                  ),
                )}
              </select>
            </label>
            {field('rollover', 'Час регулярної перезмінки · Київ', 'time')}
            {!!affected.length && (
              <fieldset className="renewal-inset flex flex-col gap-3">
                <legend>Записи після часу переходу</legend>
                <p className="renewal-muted">
                  Час запису не завжди означає час роботи. Для кожного запису вкажи авто; початковий
                  час і суми збережуться.
                </p>
                {affected.map((e) => (
                  <label className="renewal-field" key={e.id}>
                    <span>
                      {new Date(e.at).toLocaleString('uk-UA', {
                        timeZone: 'Europe/Kyiv',
                        day: 'numeric',
                        month: 'short',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}{' '}
                      · каса {moneyLabel(e.netCashMinor)} · пальне {moneyLabel(e.fuelMinor)}
                    </span>
                    <select
                      value={sides[e.id] ?? ''}
                      onChange={(ev) => {
                        setSides((old) => ({ ...old, [e.id]: ev.target.value as 'old' | 'new' }));
                        command.current = null;
                      }}
                    >
                      <option value="" disabled>
                        До якого авто належить запис?
                      </option>
                      <option value="old">Попереднє авто</option>
                      <option value="new">Нове авто</option>
                    </select>
                  </label>
                ))}
              </fieldset>
            )}
          </>
        ) : preview && policy && oldWeek ? (
          <>
            <div className="renewal-inset flex flex-col gap-2">
              <b>Попереднє авто</b>
              <p>{taxiPeriodLabel(preview.previous.key, [...f.policies, policy])}</p>
              <p className="renewal-muted">
                Записів: {oldWeek.entries.length} · заробіток {moneyLabel(oldWeek.earnedMinor)}
              </p>
              {oldWeek.entries.some(
                (e) => e.cashReported === false || e.commissionReported === false,
              ) && (
                <p className="text-neg">
                  Попередній розрахунок: доповни комісію або готівку перед оплатою парку.
                </p>
              )}
              <b>
                {oldWeek.earnedMinor - held < 0 ? 'Повернути парку' : 'Отримати від парку'}:{' '}
                {moneyLabel(Math.abs(oldWeek.earnedMinor - held))}
              </b>
            </div>
            <div className="renewal-inset flex flex-col gap-2">
              <b>{policy.vehicleName}</b>
              <p>{taxiPeriodLabel(preview.next.key, [...f.policies, policy])}</p>
              <p className="renewal-muted">
                Записів: {newWeek?.entries.length ?? 0} · заробіток{' '}
                {moneyLabel(newWeek?.earnedMinor ?? 0)}
              </p>
              <p className="renewal-muted">
                Далі: {taxiScheduleLabel(Date.parse(policy.effectiveAt), [...f.policies, policy])}
              </p>
              <p>
                Частка каси {policy.fareBps / 100}% · комісії {policy.commissionBps / 100}% ·
                пального {policy.fuelBps / 100}%
                {policy.thresholdMinor === null ? ' · без підвищення частки' : ''}
              </p>
            </div>
            <p className="renewal-muted">
              Це розділить облік, але не підтвердить оплату парку. Фактичний розрахунок зі старим
              авто вкажеш окремо в історії перезмінок.
            </p>
            <button
              type="button"
              className="renewal-secondary"
              disabled={pending}
              onClick={() => setReview(false)}
            >
              ← Змінити дані
            </button>
          </>
        ) : null}
        {error && (
          <p className="text-neg" role="alert">
            {error}
          </p>
        )}
        <button
          type="button"
          className="renewal-button w-full"
          disabled={pending}
          onClick={() => void submit()}
        >
          {pending ? 'Зберігаю…' : review ? 'Підтвердити перехід' : 'Перевірити розділення'}
        </button>
      </div>
    </Sheet>
  );
}
