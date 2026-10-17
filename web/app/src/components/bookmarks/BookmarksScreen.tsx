import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  useBookmark,
  useBookmarks,
  useBookmarkChange,
  fetchBookmark,
  readPendingBookmark,
  type Bookmark,
  type BookmarkCommand,
  type BookmarkDetail,
  type Formulation,
  BookmarkCommandError,
} from '../../api/bookmarks.ts';
import { IDEA_AREAS, IDEA_KINDS } from '../../../../core/ideas/ecosystem.mjs';
import { IDEA_STATUSES } from '../../../../core/ideas/registry.mjs';
import { Sheet } from '../ui/Sheet.tsx';
import { LoadingSkeleton, ErrorState } from '../ui/states.tsx';
import { SessionExpired } from '../ui/SessionExpired.tsx';
import { isSessionExpired } from '../../api/client.ts';
import { inTelegram, haptic } from '../../telegram.ts';
import './bookmarks.css';

type Act = (op: string, payload?: Record<string, unknown>, item?: Bookmark) => Promise<void>;
const dateLabel = (value: string) =>
  new Date(value).toLocaleString('uk-UA', {
    timeZone: 'Europe/Kyiv',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
const draftKey = (id = 'new') => 'svitanok:bookmark:draft:' + id;
function savedDraft(id?: string) {
  try {
    const value = JSON.parse(localStorage.getItem(draftKey(id)) ?? 'null');
    return value &&
      typeof value.body === 'string' &&
      typeof value.title === 'string' &&
      typeof value.area === 'string' &&
      typeof value.kind === 'string'
      ? value
      : null;
  } catch {
    return null;
  }
}
function forgetDraft(id?: string) {
  try {
    localStorage.removeItem(draftKey(id));
  } catch {
    /* input remains visible */
  }
}
export async function copyBookmarkText(text: string, onFallback: () => void) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    onFallback();
    return false;
  }
}

export function BookmarksScreen() {
  const [params, setParams] = useSearchParams(),
    id = params.get('idea');
  const [search, setSearch] = useState(''),
    [q, setQ] = useState(''),
    [status, setStatus] = useState('active'),
    [editor, setEditor] = useState<'new' | 'edit' | null>(null),
    [notice, setNotice] = useState(''),
    [error, setError] = useState(''),
    [recovery, setRecovery] = useState(readPendingBookmark);
  useEffect(() => {
    const timer = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);
  const list = useBookmarks(q, status),
    detail = useBookmark(id),
    mutation = useBookmarkChange(),
    submitting = useRef(false);
  const select = (value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set('idea', value);
    else next.delete('idea');
    setParams(next);
    setError('');
  };
  const run = async (command: BookmarkCommand) => {
    if (submitting.current) throw new Error('Зачекай на підтвердження поточного запису.');
    submitting.current = true;
    setError('');
    try {
      const result = await mutation.mutateAsync(command);
      setRecovery(null);
      setNotice(result.receipt.message);
      haptic('success');
      if (command.op === 'create' || command.op === 'edit')
        forgetDraft(command.op === 'create' ? undefined : command.id);
      select(result.receipt.id);
      return result;
    } catch (cause) {
      setRecovery(readPendingBookmark());
      setError((cause as Error).message);
      throw cause;
    } finally {
      submitting.current = false;
    }
  };
  const act: Act = async (op, payload = {}, item) => {
    if (recovery) throw new Error('Спершу перевір останній непідтверджений запис.');
    await run({
      op,
      commandId: crypto.randomUUID(),
      ...(item ? { id: item.id, version: item.version } : {}),
      payload,
    });
  };
  if (isSessionExpired(list.error) || isSessionExpired(detail.error)) return <SessionExpired />;
  const rows = [
    ...new Map(
      (list.data?.pages.flatMap((p) => p.items) ?? []).map((row) => [row.id, row]),
    ).values(),
  ];
  return (
    <section className="bookmarks-screen">
      <header className="bookmarks-heading">
        <span className="renewal-eyebrow">МАЙБУТНЄ СВІТАНКУ</span>
        <h1>
          Думка зараз.
          <br />
          <em>Чіткий наступний крок.</em>
        </h1>
        <p>Занотуй ідею чи поправку. Повернися, уточни й сформуй запит для роботи над нею.</p>
      </header>
      {!inTelegram() && (
        <p className="bookmarks-demo">Демо на цьому пристрої · особисті закладки не змінюються</p>
      )}
      <div className="bookmarks-top-actions">
        <button
          className="renewal-button"
          onClick={() => {
            setEditor('new');
            setError('');
          }}
        >
          ＋ Додати закладку
        </button>
        <Link className="renewal-secondary" to="/saved">
          Збережені матеріали ↗
        </Link>
      </div>
      {notice && (
        <p className="bookmarks-notice" role="status">
          {notice}
        </p>
      )}
      {recovery && (
        <div className="bookmarks-recovery">
          <p>
            Підтвердження попереднього запису не надійшло. Перевіримо ту саму спробу, щоб не
            створити дублікат.
          </p>
          <button
            disabled={mutation.isPending}
            className="renewal-secondary"
            onClick={() =>
              void run(recovery)
                .then(() => setEditor(null))
                .catch(() => {})
            }
          >
            Перевірити останній запис
          </button>
        </div>
      )}
      {error && !id && !editor && (
        <p className="bookmarks-error" role="alert">
          {error}
        </p>
      )}
      <label className="renewal-field bookmarks-search">
        Знайти ідею
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="За назвою або початковим записом…"
        />
      </label>
      <div className="bookmarks-filters" aria-label="Показати закладки">
        {[
          ['active', 'Актуальні'],
          ['all', 'Усі'],
          ['план готовий', 'Сформовані'],
          ['зроблено', 'Зроблено'],
        ].map(([key, label]) => (
          <button key={key} aria-pressed={status === key} onClick={() => setStatus(key)}>
            {label}
          </button>
        ))}
      </div>
      {list.isLoading ? (
        <LoadingSkeleton />
      ) : list.isError && !list.data ? (
        <ErrorState message={list.error.message} onRetry={() => void list.refetch()} />
      ) : !rows.length ? (
        <div className="bookmarks-empty">
          <span>◇</span>
          <h2>{q ? 'Поки немає збігів' : 'Тут починаються майбутні зміни'}</h2>
          <p>
            {q
              ? 'Спробуй інші слова або покажи всі записи.'
              : 'Достатньо кількох слів: що заважає, чого бракує або що хочеться покращити.'}
          </p>
        </div>
      ) : (
        <div className="bookmarks-list">
          {rows.map((row) => (
            <button
              className="bookmark-card"
              key={row.id}
              onClick={() => {
                setEditor(null);
                select(row.id);
              }}
            >
              <div>
                <span className="bookmark-number">
                  #{row.number} · {IDEA_KINDS[row.kind] ?? 'Ідея'}
                </span>
                <span className="bookmark-status">{row.status}</span>
              </div>
              <h2>{row.title}</h2>
              <p>{row.body}</p>
              <footer>
                <span>{IDEA_AREAS.find((a) => a.id === row.area)?.label ?? 'Світанок'}</span>
                <time>{dateLabel(row.updatedAt)}</time>
              </footer>
            </button>
          ))}
        </div>
      )}
      {list.hasNextPage && (
        <button
          className="renewal-secondary bookmarks-more"
          disabled={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          {list.isFetchingNextPage ? 'Завантажую…' : 'Раніші закладки'}
        </button>
      )}
      {list.isError && list.data && (
        <p className="bookmarks-error" role="alert">
          Не вдалося оновити список. Уже завантажені записи залишилися тут.
        </p>
      )}
      {(editor === 'new' || id) && (
        <Sheet
          label={editor ? 'Запис закладки' : 'Закладка Світанку'}
          onClose={() => {
            setEditor(null);
            if (id) select(null);
          }}
        >
          <div className="bookmarks-sheet">
            <button
              className="bookmarks-close"
              onClick={() => {
                setEditor(null);
                select(null);
              }}
            >
              Закрити закладку ×
            </button>
            {recovery && (
              <div className="bookmarks-recovery">
                <p>Перевір ту саму спробу збереження. Текст лишається у формі.</p>
                <button
                  disabled={mutation.isPending}
                  onClick={() =>
                    void run(recovery)
                      .then(() => setEditor(null))
                      .catch(() => {})
                  }
                >
                  Перевірити останній запис
                </button>
              </div>
            )}
            {editor === 'new' ? (
              <BookmarkEditor
                act={act}
                busy={mutation.isPending || Boolean(recovery)}
                onSaved={() => setEditor(null)}
              />
            ) : detail.isPending ? (
              <LoadingSkeleton />
            ) : detail.isError && !detail.data ? (
              <ErrorState message={detail.error.message} onRetry={() => void detail.refetch()} />
            ) : detail.data ? (
              editor === 'edit' ? (
                <BookmarkEditor
                  key={id}
                  initial={detail.data.item}
                  act={act}
                  busy={mutation.isPending || Boolean(recovery)}
                  onSaved={() => setEditor(null)}
                  onCancel={() => setEditor(null)}
                />
              ) : (
                <BookmarkView
                  key={id}
                  data={detail.data}
                  act={act}
                  busy={mutation.isPending || Boolean(recovery)}
                  onEdit={() => setEditor('edit')}
                />
              )
            ) : null}
            {error && (
              <p role="alert" className="bookmarks-error">
                {error}
              </p>
            )}
          </div>
        </Sheet>
      )}
    </section>
  );
}

function BookmarkEditor({
  initial,
  act,
  busy,
  onSaved,
  onCancel,
}: {
  initial?: Bookmark;
  act: Act;
  busy: boolean;
  onSaved: () => void;
  onCancel?: () => void;
}) {
  const [cached] = useState(() => savedDraft(initial?.id));
  const [body, setBody] = useState<string>(cached?.body ?? initial?.body ?? ''),
    [title, setTitle] = useState<string>(cached?.title ?? initial?.title ?? ''),
    [area, setArea] = useState<string>(cached?.area ?? initial?.area ?? 'ecosystem'),
    [kind, setKind] = useState<string>(cached?.kind ?? initial?.kind ?? 'idea'),
    [conflict, setConflict] = useState(false),
    [version, setVersion] = useState<string | undefined>(cached?.version ?? initial?.version),
    [error, setError] = useState('');
  useEffect(() => {
    try {
      localStorage.setItem(
        draftKey(initial?.id),
        JSON.stringify({ body, title, area, kind, version }),
      );
    } catch {
      /* the visible form remains intact */
    }
  }, [initial?.id, body, title, area, kind, version]);
  const save = async () => {
    setError('');
    try {
      await act(
        initial ? 'edit' : 'create',
        { body, title, area, kind },
        initial ? { ...initial, version: version ?? initial.version } : undefined,
      );
      onSaved();
    } catch (cause) {
      setError((cause as Error).message);
      if (cause instanceof BookmarkCommandError && cause.status === 409) setConflict(true);
    }
  };
  return (
    <form
      className="bookmark-editor"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <span className="renewal-eyebrow">{initial ? 'УТОЧНЕННЯ ЗАПИСУ' : 'ШВИДКА ДУМКА'}</span>
      <h2>{initial ? 'Розвинути думку' : 'Що хочеться змінити?'}</h2>
      <p className="renewal-muted">
        Пиши своїми словами. Помічник зможе розгорнути запис після збереження.
      </p>
      <fieldset disabled={busy}>
        <label className="renewal-field">
          Суть ідеї або проблеми
          <textarea
            required
            autoFocus
            maxLength={20000}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Наприклад: хочу бачити майбутні платежі поруч із винагородою, щоб розуміти, коли покупка буде доречною."
          />
        </label>
        <details open={Boolean(initial)}>
          <summary>Назва й деталі</summary>
          <label className="renewal-field">
            Коротка назва · за бажанням
            <input
              maxLength={200}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Без назви використаємо початок запису"
            />
          </label>
          <div className="bookmarks-form-row">
            <label className="renewal-field">
              Напрям
              <select value={area} onChange={(e) => setArea(e.target.value)}>
                {IDEA_AREAS.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="renewal-field">
              Тип
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                {Object.entries(IDEA_KINDS).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </details>
        <p className="bookmarks-local-draft">Незбережена чернетка лишається на цьому пристрої.</p>
        {conflict && initial && (
          <div className="bookmarks-recovery">
            <p>Запис змінився в іншому місці. Твої уточнення залишилися у формі.</p>
            <details>
              <summary>Порівняти з актуальним записом</summary>
              <p className="bookmarks-preserve">{initial.body}</p>
            </details>
            <button
              type="button"
              onClick={() => {
                setVersion(initial.version);
                setConflict(false);
                setError('');
              }}
            >
              Використати актуальну версію як основу
            </button>
          </div>
        )}
        {error && (
          <p className="bookmarks-error" role="alert">
            {error}
          </p>
        )}
        <button className="renewal-button" disabled={!body.trim()}>
          {busy ? 'Зберігаю…' : 'Зберегти закладку'}
        </button>
        {onCancel && (
          <button className="renewal-secondary" type="button" onClick={onCancel}>
            Повернутися до закладки
          </button>
        )}
      </fieldset>
    </form>
  );
}

function BookmarkView({
  data,
  act,
  busy,
  onEdit,
}: {
  data: BookmarkDetail;
  act: Act;
  busy: boolean;
  onEdit: () => void;
}) {
  const { item } = data,
    [selected, setSelected] = useState<string | null>(null),
    [older, setOlder] = useState<Formulation[]>([]),
    [cursor, setCursor] = useState(data.historyCursor),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [copyStatus, setCopyStatus] = useState('');
  const raw = useRef<HTMLTextAreaElement>(null);
  const versions = [...new Map([...data.formulations, ...older].map((r) => [r.id, r])).values()];
  const pending = versions.find((r) => r.status === 'queued' || r.status === 'running'),
    ready = versions.filter((r) => r.status === 'ready'),
    formulation = ready.find((r) => r.id === selected) ?? ready[0];
  const stale = formulation && formulation.sourceHash !== item.sourceHash;
  const copyOriginal = async () => {
    const copied = await copyBookmarkText(`${item.title}\n\n${item.body}`, () => {
      raw.current?.focus();
      raw.current?.select();
    });
    setCopyStatus(
      copied
        ? 'Початковий запис скопійовано.'
        : 'Автокопіювання недоступне. Виділи текст у полі нижче та скопіюй його.',
    );
  };
  return (
    <article className="bookmark-detail">
      <span className="bookmark-number">
        ЗАКЛАДКА #{item.number} · {IDEA_KINDS[item.kind] ?? 'Ідея'}
      </span>
      <h2>{item.title}</h2>
      <p className="bookmark-detail-meta">
        {IDEA_AREAS.find((a) => a.id === item.area)?.label ?? 'Світанок'} ·{' '}
        {dateLabel(item.updatedAt)}
      </p>
      <label className="renewal-field">
        Статус запису
        <select
          value={item.status}
          disabled={busy}
          onChange={(e) => void act('status', { status: e.target.value }, item).catch(() => {})}
        >
          {IDEA_STATUSES.filter((s) => s !== 'в аналізі' || item.status === s).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <section className="bookmark-source">
        <h3>Мій початковий запис</h3>
        <p className="bookmarks-preserve">{item.body}</p>
        <div className="bookmarks-inline-actions">
          <button onClick={onEdit} disabled={busy}>
            Уточнити запис
          </button>
          <button onClick={() => void copyOriginal()}>Копіювати запис</button>
        </div>
        {copyStatus && <p role="status">{copyStatus}</p>}
        <details>
          <summary>Текст для ручного копіювання</summary>
          <textarea
            ref={raw}
            readOnly
            aria-label="Початковий текст для копіювання"
            value={`${item.title}\n\n${item.body}`}
            onFocus={(e) => e.currentTarget.select()}
          />
        </details>
      </section>
      {pending ? (
        <div className="bookmark-generating" role="status">
          <span />
          <div>
            <strong>Формую пропозицію</strong>
            <p>
              Можна закрити мініапку. Результат збережеться тут; початковий запис залишиться твоїм.
            </p>
          </div>
        </div>
      ) : (
        <button
          className={formulation ? 'renewal-secondary' : 'renewal-button'}
          disabled={busy || item.status === 'в аналізі'}
          onClick={() => void act('formulate', {}, item).catch(() => {})}
        >
          {formulation ? 'Сформувати ще варіант' : '✧ Сформувати з помічником'}
        </button>
      )}
      <p className="bookmark-formulation-note">
        Помічник враховує карту модулів і зв’язків Світанку. Це підготовка пропозиції; зміни в
        застосунку самі не впроваджуються.
      </p>
      {versions
        .slice(0, 1)
        .filter((r) => r.status === 'failed')
        .map((r) => (
          <p key={r.id} className="bookmarks-error" role="alert">
            {r.error ?? 'Не вдалося сформувати. Початковий запис збережений.'}
          </p>
        ))}
      {ready.length > 1 && (
        <label className="renewal-field">
          Сформовані версії
          <select value={formulation?.id ?? ''} onChange={(e) => setSelected(e.target.value)}>
            {ready.map((r, index) => (
              <option key={r.id} value={r.id}>
                {dateLabel(r.createdAt)}
                {index === 0 ? ' · остання' : ''}
                {r.sourceHash !== item.sourceHash ? ' · попередній запис' : ''}
              </option>
            ))}
          </select>
        </label>
      )}
      {stale && (
        <p className="bookmarks-recovery">
          Цю версію сформовано з попереднього тексту. Нові уточнення не були перезаписані; за
          потреби сформуй наступний варіант.
        </p>
      )}
      {formulation?.result && (
        <FormulationView
          key={formulation.id}
          formulation={formulation}
          item={item}
          act={act}
          busy={busy}
        />
      )}
      {(cursor ?? data.historyCursor) && (
        <button
          className="renewal-secondary"
          disabled={loading}
          onClick={async () => {
            setLoading(true);
            setError('');
            try {
              const page = await fetchBookmark(item.id, (cursor ?? data.historyCursor)!);
              setOlder((rows) => [...rows, ...page.formulations]);
              setCursor(page.historyCursor ?? '');
            } catch (cause) {
              setError((cause as Error).message);
            } finally {
              setLoading(false);
            }
          }}
        >
          {loading ? 'Завантажую…' : 'Раніші версії'}
        </button>
      )}
      {error && (
        <p role="alert" className="bookmarks-error">
          {error}
        </p>
      )}
    </article>
  );
}

function FormulationView({
  formulation: f,
  item,
  act,
  busy,
}: {
  formulation: Formulation;
  item: Bookmark;
  act: Act;
  busy: boolean;
}) {
  const promptKey = 'svitanok:bookmark:prompt:' + f.id;
  const [cachedPrompt] = useState(() => {
    try {
      const value = JSON.parse(localStorage.getItem(promptKey) ?? 'null');
      return value && typeof value.prompt === 'string' && Number.isSafeInteger(value.revision)
        ? value
        : null;
    } catch {
      return null;
    }
  });
  const brief = f.result!,
    [prompt, setPrompt] = useState<string>(cachedPrompt?.prompt ?? f.prompt ?? ''),
    [promptRevision, setPromptRevision] = useState<number>(cachedPrompt?.revision ?? f.revision),
    [editing, setEditing] = useState(false),
    [notice, setNotice] = useState(''),
    text = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    try {
      if (prompt === f.prompt && promptRevision === f.revision) localStorage.removeItem(promptKey);
      else localStorage.setItem(promptKey, JSON.stringify({ prompt, revision: promptRevision }));
    } catch {
      /* The open editor retains unsaved refinements. */
    }
  }, [promptKey, prompt, promptRevision, f.prompt, f.revision]);
  const sections = [
    ['Сценарій використання', brief.userFlow],
    ['Перша версія', brief.minimumScope],
    ['Зв’язки у Світанку', brief.integrations],
    ['Кроки реалізації', brief.implementation],
    ['Критерії готовності', brief.acceptance],
    ['Потребує уточнення', brief.questions],
    ['Ризики й припущення', brief.risks],
    ['Можна додати пізніше', brief.futureScope],
  ] as const;
  const copy = async () => {
    const ok = await copyBookmarkText(prompt, () => {
      setEditing(true);
      setTimeout(() => {
        text.current?.focus();
        text.current?.select();
      }, 0);
    });
    setNotice(
      ok ? 'Текст для GPT скопійовано.' : 'Текст відкрито нижче. Виділи його й скопіюй вручну.',
    );
  };
  return (
    <section className="bookmark-formulation">
      <div className="bookmark-result-heading">
        <span>СФОРМОВАНА ПРОПОЗИЦІЯ</span>
        <small>Світанок {f.contextVersion}</small>
      </div>
      <h3>{brief.title}</h3>
      <p>{brief.problem}</p>
      <div className="bookmark-outcome">
        <strong>Бажаний результат</strong>
        <p>{brief.outcome}</p>
      </div>
      <button className="renewal-button" onClick={() => void copy()}>
        Копіювати для GPT
      </button>
      {notice && (
        <p role="status" className="bookmark-copy-notice">
          {notice}
        </p>
      )}
      {sections
        .filter(([, values]) => values.length)
        .map(([title, values], index) => (
          <details key={title} open={index < 2}>
            <summary>
              {title}
              <span>{values.length}</span>
            </summary>
            <ul>
              {values.map((value, i) => (
                <li key={i}>{value}</li>
              ))}
            </ul>
          </details>
        ))}
      <button className="renewal-secondary" onClick={() => setEditing(!editing)}>
        {editing ? 'Згорнути текст для GPT' : 'Переглянути й відредагувати запит'}
      </button>
      {editing && (
        <div className="bookmark-prompt-editor">
          {promptRevision !== f.revision && (
            <div className="bookmarks-recovery">
              <p>Запит змінився в іншому місці. Твої правки залишилися нижче.</p>
              <details>
                <summary>Порівняти з актуальною редакцією</summary>
                <p className="bookmarks-preserve">{f.prompt}</p>
              </details>
              <button onClick={() => setPromptRevision(f.revision)}>
                Використати актуальну редакцію як основу
              </button>
            </div>
          )}
          <label className="renewal-field">
            Текст для GPT
            <textarea
              ref={text}
              maxLength={50000}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </label>
          <button
            className="renewal-secondary"
            disabled={busy || !prompt.trim()}
            onClick={() =>
              void act(
                'save-prompt',
                { formulationId: f.id, revision: promptRevision, prompt },
                item,
              )
                .then(() => {
                  setPromptRevision(promptRevision + 1);
                  setNotice('Твою редакцію запиту збережено.');
                })
                .catch(() => {})
            }
          >
            Зберегти мою редакцію запиту
          </button>
        </div>
      )}
      <p className="bookmark-formulation-note">
        Початковий запис і попередні версії збережені. Копіювання не надсилає текст у сторонній чат
        автоматично.
      </p>
      <details>
        <summary>Початковий запис цієї версії</summary>
        <p className="bookmarks-preserve">{f.source.body}</p>
      </details>
    </section>
  );
}
