import { useEffect, useState } from 'react';
import type { LeisureItem, LeisureReceipt, LeisureWorkspace } from '../../api/leisure.ts';
type Send = (op: string, payload: Record<string, unknown>, id?: string) => Promise<LeisureReceipt>;
export function LeisureFeedback({
  item,
  busy,
  send,
  done,
  back,
}: {
  item: LeisureItem;
  busy: boolean;
  send: Send;
  done: () => void;
  back: () => void;
}) {
  useEffect(() => {
    const panel = document.querySelector('[role=dialog]');
    if (panel instanceof HTMLElement) panel.scrollTop = 0;
  }, []);
  const [reason, setReason] = useState(''),
    [note, setNote] = useState(''),
    [error, setError] = useState('');
  const choices = [
    ['genre', 'Жанр'],
    ['format', 'Формат'],
    ['topic', 'Тема / виконавець'],
    ['audience', 'Аудиторія'],
    ['place', 'Місце'],
    ['price', 'Ціна'],
    ['time', 'Не на цей тиждень'],
    ['other', 'Інша причина'],
  ];
  return (
    <>
      <h2>Чому нецікаво?</h2>
      <p>{item.title}</p>
      <p className="leisure-secondary">
        Обереш причину — варіант сховається, а вікно закриється. «Не на цей тиждень» не погіршує
        профіль інтересів.
      </p>
      <div className="leisure-pills">
        {choices.map(([id, label]) => (
          <button
            key={id}
            type="button"
            className="leisure-feedback-choice"
            aria-pressed={reason === id}
            onClick={() => setReason(id!)}
          >
            {label}
          </button>
        ))}
      </div>
      <label className="leisure-field">
        Уточнення · необов’язково
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={300}
          placeholder="Що саме не підходить?"
        />
      </label>
      <div className="leisure-actions">
        <button type="button" className="leisure-button" onClick={back}>
          Назад до варіанта
        </button>
        <button
          type="button"
          className="leisure-button is-primary"
          disabled={busy || !reason}
          onClick={() => {
            setError('');
            void send(
              'reaction',
              {
                verdict: reason === 'time' ? 'later' : 'uninterested',
                reasonCode: reason,
                reason: note,
              },
              item.id,
            )
              .then(done)
              .catch((e) => setError(e.message));
          }}
        >
          Приховати варіант
        </button>
      </div>
      {error && (
        <p role="alert" className="leisure-error">
          {error}
        </p>
      )}
    </>
  );
}
export function PreviousVisits({
  item,
  data,
  busy,
  send,
  done,
}: {
  item: LeisureItem;
  data: LeisureWorkspace;
  busy: boolean;
  send: Send;
  done: () => void;
}) {
  const old = data.records.find(
    (r) =>
      r.kind === 'familiarity' &&
      (item.venueId ? r.venueId === item.venueId : r.itemId === item.id),
  );
  const initial = old?.kind === 'familiarity' && !old.cleared ? old : undefined;
  const [mode, setMode] = useState(initial?.mode ?? 'unknown'),
    [count, setCount] = useState(initial?.previousCount?.toString() ?? ''),
    [error, setError] = useState('');
  const known =
    data.knownPlaces[item.id] ?? data.edition?.rankings.find((r) => r.id === item.id)?.known;
  return (
    <>
      <h2>Були тут раніше</h2>
      <h3>{item.title}</h3>
      <p className="leisure-secondary">
        Йдеться про відвідування до початку обліку в Світанку. Ця позначка не створює вигаданих
        окремих візитів.
      </p>
      <div className="leisure-pills">
        {[
          ['unknown', 'Були, кількість не пам’ятаю'],
          ['many', 'Були багато разів'],
          ['count', 'Пам’ятаю точну кількість'],
        ].map(([id, label]) => (
          <button
            key={id}
            className="leisure-feedback-choice"
            type="button"
            aria-pressed={mode === id}
            onClick={() => setMode(id as typeof mode)}
          >
            {label}
          </button>
        ))}
      </div>
      {mode === 'count' && (
        <label className="leisure-field">
          Кількість попередніх відвідувань
          <input
            inputMode="numeric"
            type="number"
            min="1"
            max="100000"
            step="1"
            value={count}
            onChange={(e) => setCount(e.target.value)}
          />
        </label>
      )}
      <p className="leisure-notice">
        ★{' '}
        {mode === 'many'
          ? 'Знайоме місце · раніше бували багато разів'
          : mode === 'count'
            ? `До обліку: ${count || '…'} відвідувань`
            : 'Знайоме місце · попередня кількість невідома'}
        <br />
        Окремо записано у Світанку: {known?.trackedCount ?? 0}.
      </p>
      <button
        type="button"
        className="leisure-button is-primary"
        disabled={
          busy || (mode === 'count' && (!Number.isSafeInteger(Number(count)) || Number(count) < 1))
        }
        onClick={() => {
          setError('');
          void send(
            'familiarity',
            {
              mode,
              previousCount: mode === 'count' ? Number(count) : null,
              revision: old?.revision ?? 0,
            },
            item.id,
          )
            .then(done)
            .catch((e) => setError(e.message));
        }}
      >
        Зберегти попередній досвід
      </button>
      {initial && (
        <button
          type="button"
          className="leisure-text-button"
          disabled={busy}
          onClick={() =>
            void send('familiarity', { mode: 'clear', revision: old?.revision ?? 0 }, item.id)
              .then(done)
              .catch((e) => setError(e.message))
          }
        >
          Прибрати позначку попереднього досвіду
        </button>
      )}
      {error && (
        <p role="alert" className="leisure-error">
          {error}
        </p>
      )}
    </>
  );
}
