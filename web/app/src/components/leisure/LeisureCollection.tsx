import { useMemo, useState } from 'react';
import {
  categoryLabels,
  leisureDate,
  toKyivInput,
  type LeisureItem,
  type LeisureWorkspace,
  type LeisureReceipt,
} from '../../api/leisure.ts';
import { CategoryArtwork } from './CategoryArtwork.tsx';
type Props = {
  data: LeisureWorkspace;
  items: LeisureItem[];
  busy: boolean;
  onOpen: (item: LeisureItem) => void;
  onFeedback: (item: LeisureItem) => void;
  send: (op: string, payload: Record<string, unknown>, id?: string) => Promise<LeisureReceipt>;
};
export function LeisureCollection({ data, items, busy, onOpen, onFeedback, send }: Props) {
  const reactions = useMemo(
    () => new Map(data.records.filter((r) => r.kind === 'reaction').map((r) => [r.itemId, r])),
    [data.records],
  );
  const [level, setLevel] = useState<'priority' | 'interested'>(() =>
    data.records.some((r) => r.kind === 'reaction' && r.interestLevel === 'priority')
      ? 'priority'
      : 'interested',
  );
  const [period, setPeriod] = useState('active'),
    [selected, setSelected] = useState<string[]>([]),
    [selecting, setSelecting] = useState(false),
    [working, setWorking] = useState(false),
    [error, setError] = useState(''),
    [shown, setShown] = useState(12);
  const today = toKyivInput(data.generatedAt).slice(0, 10);
  const expired = (i: LeisureItem) =>
    (!!i.endDate && i.endDate < today) || ['cancelled', 'sold-out', 'postponed'].includes(i.status);
  const positive = items.filter(
    (i) => reactions.get(i.id)?.verdict === 'interested' || data.saved.includes(i.id),
  );
  const rows =
    period === 'bookmarks'
      ? items.filter((i) => data.saved.includes(i.id))
      : period === 'later'
        ? items.filter((i) => reactions.get(i.id)?.verdict === 'later')
        : period === 'hidden'
          ? items.filter((i) => reactions.get(i.id)?.verdict === 'uninterested')
          : positive.filter(
              (i) =>
                (reactions.get(i.id)?.interestLevel ?? 'interested') === level &&
                (period === 'past' ? expired(i) : !expired(i)) &&
                (period === 'revisit'
                  ? reactions.get(i.id)?.revisit
                  : period === 'new-to-us'
                    ? !data.knownPlaces[i.id]?.familiar
                    : true),
            );
  const disabled = busy || working;
  const prioritize = async (id: string, next: 'priority' | 'interested') => {
    const current = reactions.get(id);
    await send(
      'reaction',
      {
        verdict: 'interested',
        interestLevel: next,
        reasonCodes: current?.reasonCodes ?? (current?.reasonCode ? [current.reasonCode] : []),
        reason: current?.reason ?? '',
        revisit: current?.revisit ?? false,
        ...(current ? { revision: current.revision } : {}),
      },
      id,
    );
  };
  const batch = async () => {
    setWorking(true);
    setError('');
    try {
      for (const id of selected) {
        await prioritize(id, level === 'priority' ? 'interested' : 'priority');
        setSelected((old) => old.filter((v) => v !== id));
      }
      setSelecting(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не вдалося зберегти всі пріоритети.');
    } finally {
      setWorking(false);
    }
  };
  return (
    <section className="leisure-collection-v2" aria-label="Моя колекція дозвілля">
      <div className="leisure-segment leisure-collection-levels">
        {(['priority', 'interested'] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={level === value}
            onClick={() => {
              setLevel(value);
              setSelected([]);
              setShown(12);
            }}
          >
            {value === 'priority' ? '☆ Хочу насамперед' : '♡ Просто цікаво'}
            <span>
              {
                positive.filter(
                  (i) =>
                    (reactions.get(i.id)?.interestLevel ?? 'interested') === value && !expired(i),
                ).length
              }
            </span>
          </button>
        ))}
      </div>
      <div className="leisure-collection-toolbar">
        <label className="leisure-field">
          <span className="sr-only">Показати у колекції</span>
          <select
            value={period}
            onChange={(e) => {
              setPeriod(e.target.value);
              setSelected([]);
              setSelecting(false);
              setShown(12);
            }}
          >
            <option value="active">Актуальне</option>
            <option value="past">Минуле</option>
            <option value="new-to-us">Нове для нас</option>
            <option value="revisit">Хочу повернутися</option>
            <option value="bookmarks">Лише закладки</option>
            <option value="later">Відкладене</option>
            <option value="hidden">Прибране</option>
          </select>
        </label>
        {['active', 'past', 'new-to-us', 'revisit'].includes(period) && rows.length > 0 && (
          <button
            className="leisure-text-button"
            type="button"
            disabled={disabled}
            onClick={() => {
              setSelecting(!selecting);
              setSelected([]);
            }}
          >
            {selecting ? 'Скасувати вибір' : 'Обрати кілька'}
          </button>
        )}
      </div>
      {selecting && (
        <div className="leisure-bulk-bar" role="group" aria-label="Зміна кількох пріоритетів">
          <label className="leisure-check">
            <input
              type="checkbox"
              checked={selected.length > 0 && selected.length === rows.length}
              disabled={disabled}
              onChange={(e) => setSelected(e.target.checked ? rows.map((i) => i.id) : [])}
            />
            Усі · {selected.length}
          </label>
          <button
            type="button"
            className="leisure-button is-primary"
            disabled={disabled || !selected.length}
            onClick={() => void batch()}
          >
            {working ? 'Зберігаю…' : level === 'priority' ? 'Залишити цікавими' : '☆ До пріоритету'}
          </button>
        </div>
      )}
      {error && (
        <p className="leisure-error" role="alert">
          {error}
        </p>
      )}
      <div className="leisure-collection-list">
        {rows.slice(0, shown).map((item, index) => {
          const reaction = reactions.get(item.id);
          return (
            <article
              key={item.id}
              className="leisure-collection-card"
              style={{ '--leisure-order': Math.min(index, 5) } as React.CSSProperties}
            >
              {selecting && (
                <label className="leisure-collection-select">
                  <input
                    type="checkbox"
                    aria-label={'Обрати ' + item.title}
                    checked={selected.includes(item.id)}
                    disabled={disabled}
                    onChange={(e) =>
                      setSelected((old) =>
                        e.target.checked ? [...old, item.id] : old.filter((id) => id !== item.id),
                      )
                    }
                  />
                </label>
              )}
              <button
                type="button"
                className="leisure-collection-open"
                onClick={() => onOpen(item)}
                aria-label={'Деталі: ' + item.title}
              >
                <CategoryArtwork category={item.category} variant="thumb" />
                <span className="leisure-collection-copy">
                  <small>{categoryLabels[item.category]}</small>
                  <strong>{item.title}</strong>
                  <span>
                    {item.venue ??
                      item.address ??
                      (item.startDate ? leisureDate(item.startDate) : 'Можна обрати день')}
                  </span>
                  {reaction?.revisit && <em>Хочу повернутися</em>}
                  {['cancelled', 'postponed', 'sold-out'].includes(item.status) && (
                    <em>
                      {item.status === 'cancelled'
                        ? 'Скасовано'
                        : item.status === 'postponed'
                          ? 'Перенесено'
                          : 'Квитки закінчилися'}
                    </em>
                  )}
                  {item.catalogChangedAt &&
                    Date.parse(item.catalogChangedAt) >
                      Date.parse(reaction?.at ?? '1970-01-01') && (
                      <em>{item.catalogChanges?.join(' · ')}</em>
                    )}
                </span>
              </button>
              <div className="leisure-collection-actions">
                {['later', 'hidden'].includes(period) ? (
                  <button
                    type="button"
                    className="leisure-text-button"
                    disabled={disabled}
                    onClick={() =>
                      void send('reaction', { verdict: 'clear' }, item.id).catch((e) =>
                        setError(e.message),
                      )
                    }
                  >
                    Повернути до нового
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      className={
                        'leisure-priority-toggle' +
                        (reaction?.interestLevel === 'priority' ? ' is-priority' : '')
                      }
                      aria-label={
                        (reaction?.interestLevel === 'priority'
                          ? 'Залишити цікавим: '
                          : 'Хочу насамперед: ') + item.title
                      }
                      aria-pressed={reaction?.interestLevel === 'priority'}
                      disabled={disabled}
                      onClick={() =>
                        void prioritize(
                          item.id,
                          reaction?.interestLevel === 'priority' ? 'interested' : 'priority',
                        ).catch((e) => setError(e.message))
                      }
                    >
                      <span aria-hidden="true">
                        {reaction?.interestLevel === 'priority' ? '★' : '☆'}
                      </span>
                      {reaction?.interestLevel === 'priority' ? 'Насамперед' : 'У пріоритет'}
                    </button>
                    <button
                      type="button"
                      className="leisure-text-button"
                      disabled={disabled}
                      onClick={() => onFeedback(item)}
                    >
                      Уточнити інтерес
                    </button>
                    <button
                      type="button"
                      className="leisure-text-button"
                      aria-label={
                        data.saved.includes(item.id)
                          ? 'Прибрати ' + item.title + ' зі збереженого'
                          : 'Зберегти ' + item.title
                      }
                      aria-pressed={data.saved.includes(item.id)}
                      disabled={disabled}
                      onClick={() =>
                        void send('save', { saved: !data.saved.includes(item.id) }, item.id).catch(
                          (e) => setError(e.message),
                        )
                      }
                    >
                      {data.saved.includes(item.id) ? 'Закладка ✓' : 'У закладки'}
                    </button>
                  </>
                )}
              </div>
            </article>
          );
        })}
      </div>
      {!rows.length && (
        <div className="leisure-collection-empty">
          <span aria-hidden="true">
            {period === 'past' ? '◷' : level === 'priority' ? '☆' : '♡'}
          </span>
          <h3>
            {period === 'later'
              ? 'Нічого не відкладено'
              : period === 'hidden'
                ? 'Немає прибраних варіантів'
                : period === 'past'
                  ? 'Тут зберігатиметься минуле'
                  : level === 'priority'
                    ? 'Що хочеться найбільше?'
                    : 'Тут буде цікаве для тебе'}
          </h3>
          <p>
            {level === 'priority' && period === 'active'
              ? 'Виділи бажані місця у «Просто цікаво». Вони стануть першими кандидатами для спільного виходу.'
              : 'Твій вибір залишається в колекції, до нього можна повернутися будь-коли.'}
          </p>
          {level === 'priority' && period === 'active' && (
            <button type="button" className="leisure-button" onClick={() => setLevel('interested')}>
              Переглянути цікаве
            </button>
          )}
        </div>
      )}
      {rows.length > shown && (
        <button type="button" className="leisure-button" onClick={() => setShown((v) => v + 12)}>
          Ще варіанти · {rows.length - shown}
        </button>
      )}
    </section>
  );
}
