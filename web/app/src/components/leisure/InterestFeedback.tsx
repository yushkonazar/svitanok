import { useEffect, useState } from 'react';
import { leisureFeedbackChoices } from '../../../../core/leisure/feedback.mjs';
import {
  leisureDate,
  fromKyivInput,
  toKyivInput,
  type LeisureItem,
  type LeisureReceipt,
  type LeisureWorkspace,
} from '../../api/leisure.ts';
import { CategoryArtwork } from './CategoryArtwork.tsx';

type Reaction = Extract<LeisureWorkspace['records'][number], { kind: 'reaction' }>;
type Props = {
  item: LeisureItem;
  positive?: boolean;
  current?: Reaction;
  known?: boolean;
  revisitInitially?: boolean;
  busy: boolean;
  send: (op: string, payload: Record<string, unknown>, id?: string) => Promise<LeisureReceipt>;
  done: () => void;
  back: () => void;
  onSeen?: () => void;
};
export function InterestFeedback({
  item,
  positive = false,
  current,
  known = false,
  revisitInitially = false,
  busy,
  send,
  done,
  back,
  onSeen,
}: Props) {
  const storageKey =
    'svitanok-leisure-feedback:' + item.id + ':' + (positive ? 'positive' : 'negative');
  const [minimumReturnDate] = useState(() =>
    toKyivInput(new Date(Date.now() + 86400000).toISOString()).slice(0, 10),
  );
  const [initial] = useState(() => {
    try {
      const value = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null');
      if (value && Array.isArray(value.codes))
        return value as {
          level: string;
          codes: string[];
          note: string;
          revisit: boolean;
          defer: boolean;
          returnOn: string;
        };
    } catch {
      /* unavailable storage */
    }
    return {
      level:
        positive && current?.verdict === 'interested'
          ? (current.interestLevel ?? 'interested')
          : '',
      codes: positive && current?.verdict === 'interested' ? (current.reasonCodes ?? []) : [],
      note: positive && current?.verdict === 'interested' ? current.reason : '',
      revisit: revisitInitially || current?.revisit || false,
      defer: false,
      returnOn: '',
    };
  });
  const [level, setLevel] = useState(initial.level),
    [codes, setCodes] = useState<string[]>(initial.codes),
    [note, setNote] = useState(initial.note);
  const [revisit, setRevisit] = useState(revisitInitially || initial.revisit),
    [defer, setDefer] = useState(initial.defer),
    [returnOn, setReturnOn] = useState(initial.returnOn);
  const [saving, setSaving] = useState(false),
    [error, setError] = useState('');
  const choices = leisureFeedbackChoices(item.category, positive);
  const disabled = busy || saving;
  useEffect(() => {
    try {
      sessionStorage.setItem(
        storageKey,
        JSON.stringify({ level, codes, note, revisit, defer, returnOn }),
      );
    } catch {
      /* storage is optional */
    }
  }, [storageKey, level, codes, note, revisit, defer, returnOn]);
  const submit = async () => {
    if (disabled) return;
    if (!positive && !defer && codes.includes('seen') && onSeen) {
      onSeen();
      return;
    }
    setSaving(true);
    setError('');
    try {
      await send(
        'reaction',
        {
          verdict: positive ? 'interested' : defer ? 'later' : 'uninterested',
          interestLevel: positive ? level : null,
          reasonCodes: defer ? ['not-now'] : codes,
          reason: note,
          revisit,
          snoozeUntil: defer && returnOn ? fromKyivInput(returnOn + 'T08:00') : null,
          ...(current ? { revision: current.revision } : {}),
        },
        item.id,
      );
      try {
        sessionStorage.removeItem(storageKey);
      } catch {
        /* optional */
      }
      done();
    } catch (e) {
      setError(
        e instanceof Error && 'inlineRecovery' in e
          ? ''
          : e instanceof Error
            ? e.message
            : 'Не вдалося зберегти вибір.',
      );
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="leisure-feedback-v2">
      <div className="leisure-feedback-item">
        <CategoryArtwork category={item.category} variant="thumb" />
        <div>
          <p className="leisure-eyebrow">{positive ? 'Твоя колекція' : 'Твій вибір'}</p>
          <h2>{positive ? 'Що тобі відгукується?' : 'Чому нецікаво?'}</h2>
          <p className="leisure-secondary">{item.title}</p>
        </div>
      </div>
      {positive ? (
        <div className="leisure-interest-levels" aria-label="Рівень інтересу">
          <button
            type="button"
            className="leisure-level"
            aria-pressed={level === 'priority'}
            disabled={disabled}
            onClick={() => setLevel('priority')}
          >
            <span className="leisure-level-symbol" aria-hidden="true">
              ☆
            </span>
            <span>
              <strong>Хочу насамперед</strong>
              <small>Обирати для найближчих виходів</small>
            </span>
            <span className="leisure-selection-dot" aria-hidden="true" />
          </button>
          <button
            type="button"
            className="leisure-level"
            aria-pressed={level === 'interested'}
            disabled={disabled}
            onClick={() => setLevel('interested')}
          >
            <span className="leisure-level-symbol" aria-hidden="true">
              ♡
            </span>
            <span>
              <strong>Просто цікаво</strong>
              <small>Зберегти можливість і врахувати смаки</small>
            </span>
            <span className="leisure-selection-dot" aria-hidden="true" />
          </button>
        </div>
      ) : (
        <div className="leisure-segment" aria-label="Як врахувати вибір">
          <button
            type="button"
            aria-pressed={!defer}
            disabled={disabled}
            onClick={() => setDefer(false)}
          >
            Прибрати варіант
          </button>
          <button
            type="button"
            aria-pressed={defer}
            disabled={disabled}
            onClick={() => setDefer(true)}
          >
            Відкласти
          </button>
        </div>
      )}
      {defer ? (
        <div className="leisure-defer-panel">
          <p>Повернути до карток</p>
          <div className="leisure-pills">
            <button
              type="button"
              className="leisure-feedback-choice"
              aria-pressed={!returnOn}
              onClick={() => setReturnOn('')}
              disabled={disabled}
            >
              За моїм запитом
            </button>
            <button
              type="button"
              className="leisure-feedback-choice"
              aria-pressed={!!returnOn}
              disabled={disabled}
              onClick={() =>
                setReturnOn(
                  toKyivInput(new Date(Date.now() + 7 * 86400000).toISOString()).slice(0, 10),
                )
              }
            >
              Обрати дату
            </button>
          </div>
          {returnOn && (
            <label className="leisure-field">
              Дата повернення
              <input
                type="date"
                value={returnOn}
                min={minimumReturnDate}
                onChange={(e) => setReturnOn(e.target.value)}
              />
            </label>
          )}
          <p className="leisure-secondary">
            {returnOn
              ? 'Картка повернеться ' + leisureDate(returnOn) + ', якщо ще буде актуальна.'
              : 'Залишиться відкладеною, поки ти сам не повернеш її.'}{' '}
            Смаки не змінюються.
          </p>
        </div>
      ) : (
        <>
          <div className="leisure-feedback-heading">
            <h3>{positive ? 'Чому цікаво?' : 'Що саме не підходить?'}</h3>
            <span className="leisure-secondary" aria-live="polite">
              {codes.length}/3
            </span>
          </div>
          <p className="leisure-secondary">
            {positive
              ? 'Обери до трьох причин або залиш без уточнення.'
              : 'Причина стосується цієї картки та обраної ознаки.'}
          </p>
          <div className="leisure-reason-grid">
            {choices.map((choice) => (
              <button
                key={choice.code}
                type="button"
                className="leisure-feedback-choice"
                aria-pressed={codes.includes(choice.code)}
                disabled={disabled || (!codes.includes(choice.code) && codes.length >= 3)}
                onClick={() =>
                  setCodes((old) =>
                    old.includes(choice.code)
                      ? old.filter((c) => c !== choice.code)
                      : [...old, choice.code],
                  )
                }
              >
                {choice.label}
              </button>
            ))}
          </div>
        </>
      )}
      {positive && known && (
        <label className="leisure-check leisure-return-check">
          <input
            type="checkbox"
            checked={revisit}
            onChange={(e) => setRevisit(e.target.checked)}
            disabled={disabled}
          />
          {item.category === 'cinema'
            ? 'Хочу переглянути ще'
            : item.category === 'podcast'
              ? 'Хочу послухати ще'
              : 'Хочу повернутися сюди'}
        </label>
      )}
      <details className="leisure-feedback-note" open={note ? true : undefined}>
        <summary>Додати уточнення</summary>
        <label className="leisure-field">
          Що для тебе важливо?
          <textarea
            value={note}
            maxLength={300}
            placeholder={
              positive ? 'Наприклад, подобається тиха атмосфера' : 'Що саме не підходить?'
            }
            disabled={disabled}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
      </details>
      {!positive && !defer && codes.length > 0 && (
        <p className="leisure-feedback-impact">
          Дата, ціна й обставини не знижують інтерес до всього жанру. «Саме цей варіант» прибирає
          лише цю картку.
        </p>
      )}
      {error && (
        <p role="alert" className="leisure-error">
          {error}
        </p>
      )}
      <div className="leisure-feedback-footer">
        <button type="button" className="leisure-button" disabled={disabled} onClick={back}>
          Назад до варіанта
        </button>
        <button
          type="button"
          className="leisure-button is-primary"
          aria-busy={disabled}
          disabled={disabled || (positive ? !level : !defer && !codes.length)}
          onClick={() => void submit()}
        >
          {disabled
            ? 'Зберігаю…'
            : positive
              ? 'Зберегти вибір'
              : defer
                ? 'Відкласти'
                : 'Підтвердити й прибрати'}
        </button>
      </div>
      {disabled && (
        <p role="status" className="leisure-secondary">
          Чекаю підтвердження. Вікно закриється після збереження.
        </p>
      )}
    </div>
  );
}
