import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
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
import { Sheet } from '../ui/Sheet.tsx';
import {
  isMemoryRecord,
  MEMORY_TYPES,
  MEMORY_DOMAINS,
  MEMORY_TYPE_LABELS,
  memoryRecordText,
} from '../../../../core/memory/semantics.mjs';

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
      isPreference(entry.value) ||
      isMemoryRecord(entry.value))
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
    String(
      isMemoryRecord(entry.value)
        ? entry.value.subject
        : isPreference(entry.value)
          ? entry.value.preference
          : (entry.value ?? ''),
    ),
  );
  const [stance, setStance] = useState<'like' | 'dislike'>(
    isPreference(entry.value) ? entry.value.stance : 'like',
  );
  const [renew, setRenew] = useState(entry.stale || entry.reviewDue);
  const [structured, setStructured] = useState(isMemoryRecord(entry.value));
  const [recordType, setRecordType] = useState(
    String(isMemoryRecord(entry.value) ? entry.value.type : (entry.semantics?.type ?? 'fact')),
  );
  const [domain, setDomain] = useState(
    String(
      isMemoryRecord(entry.value) ? entry.value.domain : (entry.semantics?.domain ?? 'general'),
    ),
  );
  const [relation, setRelation] = useState(
    String(
      isMemoryRecord(entry.value) ? entry.value.relation : (entry.semantics?.relation ?? 'none'),
    ),
  );
  const [details, setDetails] = useState(
    String(isMemoryRecord(entry.value) ? (entry.value.details ?? '') : ''),
  );
  const relationOptions: Record<string, string[]> = {
    fact: ['none'],
    preference: ['likes', 'dislikes'],
    routine: ['none'],
    aspiration: ['wants'],
    relationship: ['knows'],
    resource: ['owns', 'family', 'work', 'rented'],
    event: ['completed'],
    technical: ['none'],
  };
  const relationLabels: Record<string, string> = {
    none: 'Без окремого зв’язку',
    likes: 'Подобається',
    dislikes: 'Не подобається',
    wants: 'Хочу в майбутньому',
    owns: 'Моє',
    family: 'Сімейне',
    work: 'Робоче',
    rented: 'Орендоване',
    knows: 'Стосунки',
    completed: 'Відбулося',
  };
  const domainLabels: Record<string, string> = {
    general: 'Загальне',
    food: 'Їжа',
    transport: 'Транспорт',
    relationships: 'Стосунки',
    work: 'Робота',
    learning: 'Навчання',
    leisure: 'Дозвілля',
    health: 'Здоров’я',
    schedule: 'Розклад',
    communication: 'Спілкування',
    testing: 'Тестування',
  };
  const [error, setError] = useState('');
  const changedElsewhere = latestToken !== entry.token;
  const fixedSubject = /^profile:preference\.[a-f0-9]{32}$/.test(entry.id);
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
        if (structured) {
          const previous: { entityId?: string; properties?: { per100?: number; fuel?: string } } =
            isMemoryRecord(entry.value) ? entry.value : {};
          if (!text.trim()) {
            setError('Вкажи предмет запису.');
            return;
          }
          value = {
            schemaVersion: 2,
            type: recordType,
            domain,
            subject: text.trim(),
            relation,
            ...(details.trim() ? { details: details.trim() } : {}),
            ...(previous.entityId ? { entityId: previous.entityId } : {}),
            ...(recordType === 'resource' && domain === 'transport' && previous.properties
              ? { properties: previous.properties }
              : {}),
          };
        }
        save({ type: 'update', id: entry.id, token: entry.token, value, confirm: true, renew });
      }}
    >
      <h4 className="font-semibold text-sm">Змінити: {entry.label}</h4>
      {!structured &&
        !/^(habit:(day_start|day_end|lunch_at)|profile:reply_(style|language))$/.test(entry.id) && (
          <button
            type="button"
            className="renewal-secondary mt-3"
            disabled={disabled}
            onClick={() => setStructured(true)}
          >
            Уточнити тип і категорію
          </button>
        )}
      {structured && (
        <div className="mt-3 space-y-3">
          <label className="renewal-field">
            Тип запису
            <select
              aria-label="Тип запису"
              disabled={disabled}
              value={recordType}
              onChange={(e) => {
                setRecordType(e.target.value);
                setRelation(relationOptions[e.target.value]![0]!);
              }}
            >
              {MEMORY_TYPES.filter((type) => !fixedSubject || type === 'preference').map((type) => (
                <option key={type} value={type}>
                  {MEMORY_TYPE_LABELS[type as keyof typeof MEMORY_TYPE_LABELS]}
                </option>
              ))}
            </select>
          </label>
          <label className="renewal-field">
            Категорія
            <select
              aria-label="Категорія пам’яті"
              disabled={disabled}
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
            >
              {MEMORY_DOMAINS.map((item) => (
                <option key={item} value={item}>
                  {domainLabels[item]}
                </option>
              ))}
            </select>
          </label>
          <label className="renewal-field">
            Що це означає
            <select
              aria-label="Зв’язок із записом"
              disabled={disabled}
              value={relation}
              onChange={(e) => setRelation(e.target.value)}
            >
              {relationOptions[recordType]!.map((item) => (
                <option key={item} value={item}>
                  {relationLabels[item]}
                </option>
              ))}
            </select>
          </label>
          <p className="renewal-chart-note">
            Вподобання — що любиш. Ціль — чого хочеш. Ресурс — що можеш використовувати. Подія — що
            сталося одного разу; це не постійна звичка.
          </p>
        </div>
      )}
      {!structured && isPreference(entry.value) && (
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
      {structured && (
        <label className="renewal-field mt-3">
          Уточнення (необов’язково)
          <textarea
            aria-label="Уточнення запису"
            rows={3}
            maxLength={500}
            disabled={disabled}
            value={details}
            onChange={(e) => setDetails(e.target.value)}
          />
        </label>
      )}
      {!structured && fixedSubject && (
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
      {structured && (
        <p className="renewal-chart-note mt-3">
          Перед збереженням:{' '}
          {memoryRecordText({
            schemaVersion: 2,
            type: recordType,
            domain,
            subject: text,
            relation,
            details,
          })}
        </p>
      )}
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

export function MemoryPanel({
  catalog = true,
  standalone = false,
}: {
  catalog?: boolean;
  standalone?: boolean;
}) {
  const nowMs = useTick(30_000);
  const [params] = useSearchParams();
  const [open, setOpen] = useState(standalone || params.get('panel') === 'memory'),
    [offset, setOffset] = useState(0),
    [generation, setGeneration] = useState(0);
  const [editing, setEditing] = useState<MemoryEntry | null>(null),
    [removing, setRemoving] = useState<MemoryEntry | null>(null);
  const [showTechnical, setShowTechnical] = useState(false);
  const [search, setSearch] = useState('');
  const [group, setGroup] = useState('all');
  const [notice, setNotice] = useState(''),
    [refreshRequired, setRefreshRequired] = useState(false);
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ['memory', offset, group, search],
    queryFn: () => fetchMemory(offset, group, search),
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
      void qc.invalidateQueries({ queryKey: ['memory'] });
      if (receipt.snapshot) {
        qc.setQueryData(['memory', 0, 'all', ''], receipt.snapshot);
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
      {!standalone && (
        <button
          className="w-full text-left font-semibold"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          Пам’ять асистента
        </button>
      )}
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
                  {!catalog && (
                    <Link className="renewal-primary" to="/memory">
                      Переглянути й упорядкувати записи →
                    </Link>
                  )}
                  {catalog && (
                    <>
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
                                  mutation.mutate({
                                    type: 'resolve',
                                    id: candidate.id,
                                    choice: 'ok',
                                  })
                                }
                              >
                                {candidate.type === 'save' ? 'Зберегти' : 'Прибрати'}
                              </button>
                              <button
                                className="renewal-secondary"
                                disabled={blocked || choosing}
                                onClick={() =>
                                  mutation.mutate({
                                    type: 'resolve',
                                    id: candidate.id,
                                    choice: 'no',
                                  })
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
                        {data.truncated && (
                          <p className="renewal-chart-note">
                            Каталог обмежено першими 1000 записів. Пошук у цій версії охоплює лише
                            ці записи.
                          </p>
                        )}
                        {!data.entries.length && (
                          <p className="renewal-chart-note">
                            На цій сторінці немає персональних фактів.
                          </p>
                        )}
                        <label className="renewal-field mb-3">
                          Знайти в пам’яті
                          <input
                            type="search"
                            aria-label="Знайти запис пам’яті"
                            value={search}
                            maxLength={80}
                            onChange={(e) => {
                              setSearch(e.target.value);
                              setOffset(0);
                            }}
                          />
                        </label>
                        <label className="renewal-field mb-3">
                          Група
                          <select
                            aria-label="Група пам’яті"
                            value={group}
                            onChange={(e) => {
                              setGroup(e.target.value);
                              setOffset(0);
                              if (e.target.value === 'technical') setShowTechnical(true);
                            }}
                          >
                            <option value="all">Усі записи</option>
                            <option value="review">Потребує уточнення</option>
                            {MEMORY_TYPES.map((type) => (
                              <option key={type} value={type}>
                                {MEMORY_TYPE_LABELS[type]}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="flex items-center gap-3 text-sm mb-3">
                          <input
                            type="checkbox"
                            checked={showTechnical}
                            onChange={(e) => setShowTechnical(e.target.checked)}
                          />
                          Показувати технічні й тестові записи
                        </label>
                        {data.entries
                          .filter(
                            (entry) =>
                              (showTechnical || entry.semantics?.type !== 'technical') &&
                              `${entry.label} ${entry.text}`
                                .toLocaleLowerCase('uk-UA')
                                .includes(search.toLocaleLowerCase('uk-UA')),
                          )
                          .map((entry) => (
                            <article className="renewal-inset mb-3" key={entry.id}>
                              <h4 className="text-sm font-semibold">{entry.label}</h4>
                              <p className="text-sm mt-2 whitespace-pre-wrap break-words">
                                {entry.text}
                              </p>
                              <p className="renewal-chart-note mt-2">
                                {sources[entry.source]}
                                {entry.stale
                                  ? ' · Неактуальний'
                                  : entry.reviewDue
                                    ? ' · Час переглянути'
                                    : ''}
                              </p>
                              <div className="flex gap-3 flex-wrap mt-3">
                                {entry.semantics?.needsReview && (
                                  <p className="renewal-chart-note">
                                    Старий формат — уточни тип і категорію.
                                  </p>
                                )}
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
                        <Sheet
                          label="Редагування пам’яті"
                          onClose={() => {
                            if (!mutation.isPending) setEditing(null);
                          }}
                        >
                          <div className="flex items-center justify-between gap-3 mt-3">
                            <h3 className="font-semibold">Редагування пам’яті</h3>
                            <button
                              className="renewal-secondary"
                              aria-label="Закрити редагування пам’яті"
                              disabled={mutation.isPending}
                              onClick={() => setEditing(null)}
                            >
                              ×
                            </button>
                          </div>
                          <MemoryFactEditor
                            entry={editing}
                            latestToken={
                              data.entries.find((entry) => entry.id === editing.id)?.token ?? null
                            }
                            disabled={blocked}
                            save={(command) => mutation.mutate(command)}
                            cancel={() => setEditing(null)}
                          />
                          {mutation.isError && (
                            <p role="alert" className="mt-3">
                              {notice}
                            </p>
                          )}
                        </Sheet>
                      )}
                      {removing && (
                        <Sheet
                          label="Прибрати факт"
                          onClose={() => {
                            if (!mutation.isPending) setRemoving(null);
                          }}
                        >
                          <div
                            className="renewal-inset"
                            role="group"
                            aria-label="Підтвердження прибирання факту"
                          >
                            <p className="font-semibold text-sm">Прибрати цей факт?</p>
                            <p className="text-sm mt-2 whitespace-pre-wrap">{removing.text}</p>
                            <p className="renewal-chart-note mt-2">
                              Прибирає поточний запис, але не стирає історію. Для повного видалення
                              є /forget з окремим підтвердженням.
                            </p>
                            {data.entries.find((entry) => entry.id === removing.id)?.token !==
                              removing.token && (
                              <p role="alert" className="mt-3 text-sm">
                                Факт уже змінився або зник. Закрий підтвердження й перевір
                                актуальний запис.
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
                          {mutation.isError && (
                            <p role="alert" className="mt-3">
                              {notice}
                            </p>
                          )}
                        </Sheet>
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
            </>
          )}
        </div>
      )}
    </section>
  );
}
