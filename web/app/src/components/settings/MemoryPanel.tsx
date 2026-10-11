import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { fetchMemory, changeMemory } from '../../api/client.ts';
import {
  MemoryChangeError,
  type MemoryPreferences,
  type MemoryEntry,
  type MemoryCommand,
  type MemoryWorkspace,
} from '../../api/memory-schema.ts';
import { inTelegram } from '../../telegram.ts';
import { useTick } from '../../lib/useTick.ts';

const categories: Array<{ id: MemoryPreferences['categories'][number]; label: string }> = [
  { id: 'preferences', label: 'Вподобання' },
  { id: 'schedule', label: 'Звичні часи дня' },
  { id: 'style', label: 'Стиль відповідей' },
];
const sources = {
  owner_assertion: 'Твої слова',
  observed_event: 'Спостереження',
  model_hypothesis: 'Припущення — перевір',
};
function isPreference(value: unknown): value is { preference: string; stance: 'like' | 'dislike' } {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as { preference?: unknown }).preference === 'string' &&
    ['like', 'dislike'].includes(String((value as { stance?: unknown }).stance))
  );
}
function editable(entry: MemoryEntry) {
  return (
    entry.editable &&
    (entry.value == null ||
      ['string', 'number', 'boolean'].includes(typeof entry.value) ||
      isPreference(entry.value))
  );
}

export function MemoryPreferencesForm({
  workspace,
  disabled,
  save,
  reset,
}: {
  workspace: MemoryWorkspace;
  disabled: boolean;
  save: (command: MemoryCommand) => void;
  reset: () => void;
}) {
  const [draft, setDraft] = useState<MemoryPreferences>({
    ...workspace.preferences,
    categories: [...workspace.preferences.categories],
  });
  const [token] = useState(workspace.preferencesToken);
  const changedElsewhere = token !== workspace.preferencesToken;
  return (
    <form
      className="renewal-inset"
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled || changedElsewhere || (draft.mode === 'explicit' && !draft.categories.length))
          return;
        save({ type: 'preferences', preferences: draft, token });
      }}
    >
      <label className="renewal-field">
        Режим пам’яті
        <select
          aria-label="Режим пам’яті"
          disabled={disabled}
          value={draft.mode}
          onChange={(event) =>
            setDraft({ ...draft, mode: event.target.value as MemoryPreferences['mode'] })
          }
        >
          <option value="confirm">Питати перед записом</option>
          <option value="explicit">Явні факти автоматично</option>
        </select>
      </label>
      <p className="renewal-chart-note mt-3">
        Асистент пам’ятає твої слова, а не вчиться на них заново. Припущення завжди потребують
        підтвердження. Нові джерела даних не підключаються.
      </p>
      <fieldset className="mt-4 space-y-3" disabled={disabled || draft.mode !== 'explicit'}>
        <legend className="mb-3 font-semibold text-sm">Що можна записувати автоматично</legend>
        {categories.map((category) => (
          <label key={category.id} className="flex gap-3 items-center text-sm">
            <input
              type="checkbox"
              checked={draft.categories.includes(category.id)}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  categories: event.target.checked
                    ? [...draft.categories, category.id]
                    : draft.categories.filter((item) => item !== category.id),
                })
              }
            />
            {category.label}
          </label>
        ))}
      </fieldset>
      <p className="renewal-chart-note mt-3">
        Приклади: «Люблю азійську кухню», «Зазвичай прокидаюся о 08:00», «Відповідай коротко».
        Цитати, тимчасові плани й неоднозначні фрази не записуються автоматично.
      </p>
      {changedElsewhere && (
        <p role="alert" className="mt-3 text-sm">
          Режим уже змінився в іншому місці. Чернетку зберіг; перечитай актуальний режим перед
          записом.
        </p>
      )}
      <div className="mt-4 flex flex-wrap gap-3">
        <button
          className="renewal-primary"
          disabled={
            disabled || changedElsewhere || (draft.mode === 'explicit' && !draft.categories.length)
          }
        >
          Зберегти режим
        </button>
        <button type="button" className="renewal-secondary" disabled={disabled} onClick={reset}>
          Скинути чернетку
        </button>
      </div>
    </form>
  );
}

export function MemoryFactEditor({
  entry,
  latestToken,
  disabled,
  save,
  cancel,
}: {
  entry: MemoryEntry;
  latestToken: string | null;
  disabled: boolean;
  save: (command: MemoryCommand) => void;
  cancel: () => void;
}) {
  const [text, setText] = useState(
    String(isPreference(entry.value) ? entry.value.preference : (entry.value ?? '')),
  );
  const [stance, setStance] = useState<'like' | 'dislike'>(
    isPreference(entry.value) ? entry.value.stance : 'like',
  );
  const [renew, setRenew] = useState(entry.stale || entry.reviewDue);
  const [error, setError] = useState('');
  const changedElsewhere = latestToken !== entry.token;
  const fixedSubject =
    isPreference(entry.value) && /^profile:preference\.[a-f0-9]{32}$/.test(entry.id);
  return (
    <form
      className="renewal-inset mt-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled || changedElsewhere) return;
        let value: unknown = text;
        if (isPreference(entry.value)) value = { preference: text.trim(), stance };
        else if (typeof entry.value === 'number') {
          value = Number(text);
          if (!text.trim() || !Number.isFinite(value)) {
            setError('Вкажи число.');
            return;
          }
        } else if (typeof entry.value === 'boolean') value = text === 'true';
        if (typeof value === 'string' && !value.trim()) {
          setError('Вкажи нове значення або прибери факт.');
          return;
        }
        save({ type: 'update', id: entry.id, token: entry.token, value, confirm: true, renew });
      }}
    >
      <h4 className="font-semibold text-sm">Змінити: {entry.label}</h4>
      {isPreference(entry.value) && (
        <label className="renewal-field mt-3">
          Ставлення
          <select
            aria-label="Ставлення"
            disabled={disabled}
            value={stance}
            onChange={(event) => setStance(event.target.value as 'like' | 'dislike')}
          >
            <option value="like">Подобається</option>
            <option value="dislike">Не подобається</option>
          </select>
        </label>
      )}
      <label className="renewal-field mt-3">
        Значення
        {typeof entry.value === 'boolean' ? (
          <select
            aria-label="Значення факту"
            disabled={disabled}
            value={text}
            onChange={(event) => setText(event.target.value)}
          >
            <option value="true">Так</option>
            <option value="false">Ні</option>
          </select>
        ) : (
          <textarea
            aria-label="Значення факту"
            disabled={disabled || fixedSubject}
            rows={3}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setError('');
            }}
            maxLength={500}
          />
        )}
      </label>
      {fixedSubject && (
        <p className="renewal-chart-note mt-2">
          Тут змінюється ставлення. Нове вподобання додай у чаті, а старе за потреби прибери.
        </p>
      )}
      <label className="flex gap-3 mt-3 items-start text-sm">
        <input
          type="checkbox"
          checked={renew}
          disabled={disabled}
          onChange={(event) => setRenew(event.target.checked)}
        />
        Підтверджую актуальність і прибираю попередній строк перегляду/дії цього факту
      </label>
      {changedElsewhere && (
        <p role="alert" className="mt-3 text-sm">
          Факт уже змінився або зник. Чернетку не перезаписував; закрий її й перевір актуальний
          запис.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-3 mt-4">
        <button className="renewal-primary" disabled={disabled || changedElsewhere}>
          Зберегти факт
        </button>
        <button type="button" className="renewal-secondary" onClick={cancel} disabled={disabled}>
          Скасувати
        </button>
      </div>
    </form>
  );
}

export function MemoryPanel() {
  const nowMs = useTick(30_000);
  const [params] = useSearchParams();
  const [open, setOpen] = useState(params.get('panel') === 'memory'),
    [offset, setOffset] = useState(0),
    [generation, setGeneration] = useState(0);
  const [editing, setEditing] = useState<MemoryEntry | null>(null),
    [removing, setRemoving] = useState<MemoryEntry | null>(null);
  const [notice, setNotice] = useState(''),
    [refreshRequired, setRefreshRequired] = useState(false);
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ['memory', offset],
    queryFn: () => fetchMemory(offset),
    enabled: open && inTelegram(),
    staleTime: 30000,
    retry: false,
  });
  const mutation = useMutation({
    mutationFn: changeMemory,
    retry: false,
    onSuccess: (receipt) => {
      setEditing(null);
      setRemoving(null);
      setNotice(receipt.message);
      if (receipt.snapshot) {
        qc.setQueryData(['memory', 0], receipt.snapshot);
        setOffset(0);
        setRefreshRequired(false);
        setGeneration((value) => value + 1);
      } else {
        setRefreshRequired(true);
        setNotice(`${receipt.message} Показ не оновився — онови пам’ять.`);
      }
    },
    onError: (error) => {
      setNotice(error.message);
      if (error instanceof MemoryChangeError && error.refreshRequired) setRefreshRequired(true);
    },
  });
  const data = query.data;
  const blocked = mutation.isPending || refreshRequired;
  const choosing = !!editing || !!removing;
  const refresh = async () => {
    const refreshed = await query.refetch();
    if (refreshed.data && !refreshed.error) {
      setRefreshRequired(false);
      setGeneration((value) => value + 1);
      setNotice('Пам’ять оновлено. Перевір актуальні записи.');
      mutation.reset();
    }
  };
  return (
    <section className="renewal-card">
      <button
        className="w-full text-left font-semibold"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        Пам’ять асистента
      </button>
      {open && (
        <div className="mt-5 space-y-5">
          {!inTelegram() ? (
            <p className="renewal-chart-note">
              Відкрий цей розділ в особистому чаті з ботом. У демо персональна пам’ять не
              завантажується.
            </p>
          ) : (
            <>
              <p className="renewal-chart-note">
                Факти, пропозиції й режим — спільні для чату та Mini App. /new починає нову нитку,
                але не стирає пам’ять.
              </p>
              <button
                className="renewal-secondary"
                disabled={query.isFetching || mutation.isPending}
                onClick={() => void refresh()}
              >
                {query.isFetching ? 'Оновлюю…' : 'Оновити пам’ять'}
              </button>
              {query.isPending && <p role="status">Завантажую пам’ять…</p>}
              {query.error && <p role="alert">{query.error.message}</p>}
              {notice && (
                <p role={mutation.isError ? 'alert' : 'status'} className="text-sm">
                  {notice}
                </p>
              )}
              {mutation.isPending && <p role="status">Зберігаю рішення…</p>}
              {refreshRequired && (
                <p role="alert" className="text-sm">
                  Перед наступною зміною онови пам’ять. Не повторюю непідтверджений запис
                  автоматично.
                </p>
              )}
              {data && (
                <>
                  {!data.preferencesValid && (
                    <p role="alert">
                      Попередній режим не підтверджений або має старий формат. Автоматичний запис
                      вимкнений — обери режим заново.
                    </p>
                  )}
                  <MemoryPreferencesForm
                    key={generation}
                    workspace={data}
                    disabled={blocked || choosing}
                    save={(command) => mutation.mutate(command)}
                    reset={() => setGeneration((value) => value + 1)}
                  />
                  <div>
                    <h3 className="font-semibold mb-3">Пропозиції асистента</h3>
                    {!data.candidates.length && (
                      <p className="renewal-chart-note">Немає відкритих пропозицій пам’яті.</p>
                    )}
                    {data.candidates.map((candidate) => (
                      <article className="renewal-inset mb-3" key={candidate.id}>
                        <h4 className="text-sm font-semibold">{candidate.label}</h4>
                        <p className="text-sm mt-2 whitespace-pre-wrap break-words">
                          {candidate.text}
                        </p>
                        {candidate.stale && (
                          <p className="renewal-chart-note mt-2">
                            Дані вже змінилися. Потрібна нова пропозиція.
                          </p>
                        )}
                        {Date.parse(candidate.expiresAt) <= nowMs && (
                          <p className="renewal-chart-note mt-2">
                            Час підтвердження минув. Надішли новий запит.
                          </p>
                        )}
                        <div className="flex gap-3 flex-wrap mt-3">
                          <button
                            className="renewal-primary"
                            disabled={
                              blocked ||
                              choosing ||
                              candidate.stale ||
                              Date.parse(candidate.expiresAt) <= nowMs
                            }
                            onClick={() =>
                              mutation.mutate({ type: 'resolve', id: candidate.id, choice: 'ok' })
                            }
                          >
                            {candidate.type === 'save' ? 'Зберегти' : 'Прибрати'}
                          </button>
                          <button
                            className="renewal-secondary"
                            disabled={blocked || choosing}
                            onClick={() =>
                              mutation.mutate({ type: 'resolve', id: candidate.id, choice: 'no' })
                            }
                          >
                            Відхилити
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                  <div>
                    <h3 className="font-semibold mb-3">Що асистент пам’ятає</h3>
                    {!data.entries.length && (
                      <p className="renewal-chart-note">
                        На цій сторінці немає персональних фактів.
                      </p>
                    )}
                    {data.entries.map((entry) => (
                      <article className="renewal-inset mb-3" key={entry.id}>
                        <h4 className="text-sm font-semibold">{entry.label}</h4>
                        <p className="text-sm mt-2 whitespace-pre-wrap break-words">{entry.text}</p>
                        <p className="renewal-chart-note mt-2">
                          {sources[entry.source]}
                          {entry.stale
                            ? ' · Неактуальний'
                            : entry.reviewDue
                              ? ' · Час переглянути'
                              : ''}
                        </p>
                        <div className="flex gap-3 flex-wrap mt-3">
                          {editable(entry) && (
                            <button
                              className="renewal-secondary"
                              disabled={blocked || choosing}
                              onClick={() => {
                                setEditing(entry);
                                setNotice('');
                              }}
                            >
                              Змінити
                            </button>
                          )}
                          <button
                            className="renewal-secondary"
                            disabled={blocked || choosing}
                            onClick={() => {
                              setRemoving(entry);
                              setNotice('');
                            }}
                          >
                            Прибрати
                          </button>
                        </div>
                        {entry.editable && !editable(entry) && (
                          <p className="renewal-chart-note mt-2">
                            Складений запис можна уточнити в чаті.
                          </p>
                        )}
                      </article>
                    ))}
                  </div>
                  {editing && (
                    <MemoryFactEditor
                      entry={editing}
                      latestToken={
                        data.entries.find((entry) => entry.id === editing.id)?.token ?? null
                      }
                      disabled={blocked}
                      save={(command) => mutation.mutate(command)}
                      cancel={() => setEditing(null)}
                    />
                  )}
                  {removing && (
                    <div
                      className="renewal-inset"
                      role="group"
                      aria-label="Підтвердження прибирання факту"
                    >
                      <p className="font-semibold text-sm">Прибрати цей факт?</p>
                      <p className="text-sm mt-2 whitespace-pre-wrap">{removing.text}</p>
                      <p className="renewal-chart-note mt-2">
                        Прибирає поточний запис, але не стирає історію. Для повного видалення є
                        /forget з окремим підтвердженням.
                      </p>
                      {data.entries.find((entry) => entry.id === removing.id)?.token !==
                        removing.token && (
                        <p role="alert" className="mt-3 text-sm">
                          Факт уже змінився або зник. Закрий підтвердження й перевір актуальний
                          запис.
                        </p>
                      )}
                      <div className="mt-3 flex gap-3">
                        <button
                          className="renewal-primary"
                          disabled={
                            blocked ||
                            data.entries.find((entry) => entry.id === removing.id)?.token !==
                              removing.token
                          }
                          onClick={() =>
                            mutation.mutate({
                              type: 'remove',
                              id: removing.id,
                              token: removing.token,
                              confirm: true,
                            })
                          }
                        >
                          Так, прибрати
                        </button>
                        <button
                          className="renewal-secondary"
                          disabled={mutation.isPending}
                          onClick={() => setRemoving(null)}
                        >
                          Залишити
                        </button>
                      </div>
                    </div>
                  )}
                  <div className="flex gap-3 justify-between">
                    <button
                      className="renewal-secondary"
                      disabled={offset === 0 || blocked || choosing}
                      onClick={() => setOffset((value) => Math.max(0, value - 25))}
                    >
                      Попередні
                    </button>
                    <button
                      className="renewal-secondary"
                      disabled={data.nextOffset == null || blocked || choosing}
                      onClick={() => setOffset(data.nextOffset ?? offset)}
                    >
                      Наступні
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
