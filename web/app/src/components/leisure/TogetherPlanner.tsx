import { useEffect, useRef, useState } from 'react';
import {
  fetchLeisureSuggestions,
  leisureDate,
  leisureTime,
  money,
  toKyivInput,
  type LeisurePlanSeed,
  type LeisureReceipt,
  type LeisureSuggestion,
  type LeisureSuggestions,
  type LeisureWorkspace,
} from '../../api/leisure.ts';
import { CategoryArtwork } from './CategoryArtwork.tsx';
import { isSessionExpired } from '../../api/client.ts';
import { SessionExpired } from '../ui/SessionExpired.tsx';
type Form = {
  mode: 'day' | 'range';
  from: string;
  to: string;
  startTime: string;
  endTime: string;
  transport: 'car' | 'walk' | 'transit';
  budget: string;
  pace: string;
  startLocation: string;
  allowNew: boolean;
  includeFamiliar: boolean;
  perDay: Record<string, { startTime: string; endTime: string }>;
};
type Props = {
  data: LeisureWorkspace;
  busy: boolean;
  onChoose: (seed: LeisurePlanSeed) => void;
  send: (op: string, payload: Record<string, unknown>, id?: string) => Promise<LeisureReceipt>;
};
const FORM_KEY = 'svitanok-leisure-together-v1';
function initialForm(data: LeisureWorkspace): Form {
  const today = toKyivInput(new Date().toISOString()).slice(0, 10);
  const fallback: Form = {
    mode: 'day',
    from: today,
    to: today,
    startTime: '17:30',
    endTime: '22:00',
    transport: data.settings.transport === 'walk' ? 'walk' : 'car',
    budget: '',
    pace: 'balanced',
    startLocation: '',
    allowNew: false,
    includeFamiliar: false,
    perDay: {},
  };
  try {
    const saved = JSON.parse(localStorage.getItem(FORM_KEY) ?? 'null');
    if (saved && saved.from >= today) return { ...fallback, ...saved };
  } catch {
    /* optional draft */
  }
  return fallback;
}
function seed(plan: LeisureSuggestion): LeisurePlanSeed {
  return { title: plan.title, stops: plan.stops, transport: plan.transport };
}
function weekday(date: string) {
  return new Intl.DateTimeFormat('uk-UA', { weekday: 'long', timeZone: 'Europe/Kyiv' }).format(
    new Date(date + 'T12:00:00Z'),
  );
}
export function TogetherPlanner({ data, busy, onChoose, send }: Props) {
  const [form, setForm] = useState(() => initialForm(data)),
    [result, setResult] = useState<LeisureSuggestions | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState<Error | null>(null),
    [expandedDay, setExpandedDay] = useState<string | null>(null),
    [expanded, setExpanded] = useState(''),
    [notice, setNotice] = useState(''),
    [manualCopy, setManualCopy] = useState('');
  const controller = useRef<AbortController | null>(null),
    version = useRef(0),
    resultHeading = useRef<HTMLDivElement>(null);
  const [drafting, setDrafting] = useState<string | null>(null);
  const [savedDrafts, setSavedDrafts] = useState<Record<string, string>>({});
  useEffect(() => {
    try {
      localStorage.setItem(FORM_KEY, JSON.stringify(form));
    } catch {
      /* optional */
    }
  }, [form]);
  useEffect(() => () => controller.current?.abort(), []);
  const edit = (patch: Partial<Form>) => {
    version.current++;
    controller.current?.abort();
    setForm((old) => ({ ...old, ...patch }));
    setResult(null);
    setError(null);
    setNotice('');
    setLoading(false);
  };
  const payload = () => {
    const budget = form.budget.trim() ? Number(form.budget.replace(',', '.')) : null;
    if (budget != null && (!Number.isFinite(budget) || budget < 0))
      throw new Error('Перевір бюджет на двох.');
    return {
      ...form,
      to: form.mode === 'day' ? form.from : form.to,
      budgetMinor: budget == null ? null : Math.round(budget * 100),
    };
  };
  const generate = async (preferredFoodId?: string, original?: LeisureSuggestion) => {
    const anchorId = original?.anchorId,
      lockedStop = original?.stops.find((s) => s.itemId === anchorId);
    controller.current?.abort();
    const current = ++version.current,
      abort = new AbortController();
    controller.current = abort;
    setLoading(true);
    setError(null);
    setNotice('');
    setManualCopy('');
    try {
      const response = await fetchLeisureSuggestions(
        {
          ...payload(),
          ...(preferredFoodId ? { preferredFoodId } : {}),
          ...(anchorId ? { anchorId } : {}),
          ...(original ? { from: original.date, to: original.date, lockedStop } : {}),
        },
        abort.signal,
      );
      if (current !== version.current) return;
      const chosen = response.days
        .flatMap((day) => day.plans)
        .find((plan) => (anchorId ? plan.anchorId === anchorId : true));
      if (original && preferredFoodId) {
        if (!chosen?.stops.some((s) => s.itemId === preferredFoodId))
          throw new Error(
            'Цей заклад не поєднується з рештою виходу в обраний час. Попередній план збережено.',
          );
        setResult((old) => {
          if (!old) return response;
          const days = old.days.map((day) =>
            day.date === original.date
              ? {
                  ...day,
                  plans: day.plans
                    .map((plan) =>
                      plan.id === original.id ? { ...chosen, id: original.id } : plan,
                    )
                    .sort((a, b) => b.score - a.score),
                }
              : day,
          );
          const ranked = days
              .flatMap((day) => day.plans.slice(0, 1))
              .sort((a, b) => b.score - a.score || a.date.localeCompare(b.date)),
            best = ranked[0];
          return {
            ...old,
            generatedAt: response.generatedAt,
            days,
            recommendedDate: best?.date ?? null,
            recommendedReason: best
              ? ranked.filter((p) => p.score === best.score).length > 1
                ? 'Можливості рівноцінні — можна обрати ранішу зручну дату.'
                : best.reasons.slice(0, 2).join('. ')
              : null,
          };
        });
        setSavedDrafts((old) => {
          const next = { ...old };
          delete next[original.id];
          return next;
        });
      } else {
        setResult(response);
        setSavedDrafts({});
      }
      setExpanded(original?.id ?? chosen?.id ?? '');
      if (!preferredFoodId) setExpandedDay(form.mode === 'day' ? form.from : null);
      requestAnimationFrame(() =>
        resultHeading.current?.scrollIntoView?.({
          block: 'nearest',
          behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
            ? 'auto'
            : 'smooth',
        }),
      );
    } catch (e) {
      if (current === version.current && !abort.signal.aborted)
        setError(e instanceof Error ? e : new Error('Не вдалося підібрати вихід.'));
    } finally {
      if (current === version.current) setLoading(false);
    }
  };
  const saveDraft = async (plan: LeisureSuggestion) => {
    if (drafting || busy) return;
    setDrafting(plan.id);
    setNotice('');
    try {
      const receipt = await send('draft', { ...seed(plan), calendar: false });
      if (receipt.id) setSavedDrafts((old) => ({ ...old, [plan.id]: receipt.id! }));
      setNotice('Чернетку збережено. До неї можна повернутися нижче.');
    } catch (e) {
      setError(e instanceof Error ? e : new Error('Не вдалося зберегти чернетку.'));
    } finally {
      setDrafting(null);
    }
  };
  const copy = async (plan: LeisureSuggestion) => {
    const text = [
      plan.title,
      leisureDate(plan.date),
      ...plan.stops.map(
        (stop) =>
          leisureTime(stop.startAt) +
          '–' +
          leisureTime(stop.endAt) +
          ' · ' +
          stop.title +
          (stop.address ? ' · ' + stop.address : ''),
      ),
      ...plan.warnings.map((w) => 'Уточнити: ' + w),
    ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setNotice('Пропозицію скопійовано.');
    } catch {
      setManualCopy(text);
    }
  };
  if (isSessionExpired(error)) return <SessionExpired />;
  const drafts = data.records.filter(
    (r): r is Extract<LeisureWorkspace['records'][number], { kind: 'draft' }> =>
      r.kind === 'draft' && !r.discarded,
  );
  const renderPlan = (plan: LeisureSuggestion, compact = false) => {
    const open = expanded === plan.id && !compact;
    const first = data.items.find((i) => i.id === plan.stops[0]?.itemId);
    return (
      <article className={'leisure-scenario' + (open ? ' is-open' : '')} key={plan.id}>
        <button
          type="button"
          className="leisure-scenario-heading"
          aria-expanded={open}
          onClick={() => {
            setExpandedDay(plan.date);
            setExpanded(open ? '' : plan.id);
          }}
        >
          {first && <CategoryArtwork category={first.category} variant="thumb" />}
          <span>
            <small>
              {plan.confidence === 'checked'
                ? 'Перевірено для цього часу'
                : 'Є деталі для уточнення'}
            </small>
            <strong>{plan.title}</strong>
            <em>
              {leisureTime(plan.stops[0]!.startAt)}–{leisureTime(plan.stops.at(-1)!.endAt)} ·{' '}
              {plan.stops.length === 1 ? 'одна активність' : plan.stops.length + ' зупинки'}
            </em>
          </span>
          <span className="leisure-scenario-chevron" aria-hidden="true">
            ⌄
          </span>
        </button>
        {open && (
          <div className="leisure-scenario-body">
            <ol className="leisure-scenario-timeline">
              {plan.stops.map((stop, index) => (
                <li key={stop.itemId + stop.startAt}>
                  {index > 0 && (
                    <p className="leisure-scenario-transfer">
                      {plan.legs.filter((l) => !l.boundary)[index - 1]?.verified
                        ? 'Дорога'
                        : 'Орієнтовно'}{' '}
                      · {plan.legs.filter((l) => !l.boundary)[index - 1]?.minutes ?? '…'} хв + пауза
                    </p>
                  )}
                  <div className="leisure-scenario-stop">
                    <time>{leisureTime(stop.startAt)}</time>
                    <div>
                      <strong>{stop.title}</strong>
                      <p>
                        {stop.address ?? 'Місце уточнюється'} · до {leisureTime(stop.endAt)}
                      </p>
                    </div>
                  </div>
                </li>
              ))}
            </ol>
            {plan.legs
              .filter((l) => l.boundary)
              .map((l) => (
                <p key={l.boundary} className="leisure-scenario-transfer">
                  {l.boundary === 'outbound' ? 'До першої зупинки' : 'Назад до місця старту'} ·{' '}
                  {l.verified ? '' : 'орієнтовно '}
                  {l.minutes} хв
                </p>
              ))}
            <p className="leisure-scenario-reason">{plan.reasons.slice(0, 2).join(' · ')}</p>
            <div className="leisure-scenario-cost">
              <span>Для двох</span>
              <strong>
                {plan.knownCostMinor > 0
                  ? 'Від ' + money(plan.knownCostMinor / 100)
                  : plan.unknownPrices
                    ? 'Сума уточнюється'
                    : 'Вхід безплатний'}
              </strong>
              {plan.unknownPrices > 0 && (
                <small>Без підтвердженої ціни: {plan.unknownPrices}</small>
              )}
            </div>
            {plan.warnings.length > 0 && (
              <details className="leisure-scenario-warnings">
                <summary>Потрібно уточнити · {plan.warnings.length}</summary>
                <ul>
                  {plan.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </details>
            )}
            {(plan.weather ?? []).map((line) => (
              <p className="leisure-secondary" key={line}>
                Погода · {line}
              </p>
            ))}
            {plan.stops.length > 1 && plan.alternatives.length > 0 && (
              <label className="leisure-field">
                Замінити заклад
                <select
                  value=""
                  disabled={loading}
                  onChange={(e) => {
                    if (e.target.value) void generate(e.target.value, plan);
                  }}
                >
                  <option value="">Залишити запропонований</option>
                  {plan.alternatives.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.priority ? '☆ ' : ''}
                      {i.title}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="leisure-scenario-actions">
              <button
                type="button"
                className="leisure-button is-primary"
                disabled={busy || loading}
                onClick={() =>
                  onChoose({
                    ...seed(plan),
                    ...(savedDrafts[plan.id] ? { sourceDraftId: savedDrafts[plan.id] } : {}),
                  })
                }
              >
                Обрати й перевірити
              </button>
              <button
                type="button"
                className="leisure-button"
                disabled={busy || !!drafting || !!savedDrafts[plan.id]}
                onClick={() => void saveDraft(plan)}
              >
                {drafting === plan.id
                  ? 'Зберігаю…'
                  : savedDrafts[plan.id]
                    ? 'Збережено в чернетках'
                    : 'У чернетки'}
              </button>
              <button type="button" className="leisure-text-button" onClick={() => void copy(plan)}>
                Скопіювати пропозицію
              </button>
            </div>
          </div>
        )}
      </article>
    );
  };
  return (
    <section className="leisure-together">
      <div className="leisure-together-intro">
        <span aria-hidden="true">✧</span>
        <p className="leisure-eyebrow">Ваш час</p>
        <h2>Сплануємо час разом</h2>
        <p className="leisure-secondary">Від твоїх бажань — до готового виходу.</p>
      </div>
      <div className="leisure-segment">
        <button
          type="button"
          aria-pressed={form.mode === 'day'}
          onClick={() => edit({ mode: 'day' })}
        >
          Конкретний день
        </button>
        <button
          type="button"
          aria-pressed={form.mode === 'range'}
          onClick={() => edit({ mode: 'range' })}
        >
          Кілька днів на вибір
        </button>
      </div>
      <div className={form.mode === 'range' ? 'leisure-time-grid' : ''}>
        <label className="leisure-field">
          {form.mode === 'range' ? 'Від' : 'Дата зустрічі'}
          <input
            type="date"
            min={toKyivInput(new Date().toISOString()).slice(0, 10)}
            value={form.from}
            onChange={(e) =>
              edit({
                from: e.target.value,
                to: form.to < e.target.value ? e.target.value : form.to,
              })
            }
          />
        </label>
        {form.mode === 'range' && (
          <label className="leisure-field">
            До
            <input
              type="date"
              min={form.from}
              value={form.to}
              onChange={(e) => edit({ to: e.target.value })}
            />
          </label>
        )}
      </div>
      <div className="leisure-time-grid">
        <label className="leisure-field">
          Зустрічаємося приблизно
          <input
            type="time"
            value={form.startTime}
            onChange={(e) => edit({ startTime: e.target.value })}
          />
        </label>
        <label className="leisure-field">
          Маємо час до
          <input
            type="time"
            value={form.endTime}
            onChange={(e) => edit({ endTime: e.target.value })}
          />
        </label>
      </div>
      <p className="leisure-secondary leisure-time-zone">Час за Києвом · для двох</p>
      <details className="leisure-together-options">
        <summary>Побажання до виходу</summary>
        <div className="leisure-time-grid">
          <label className="leisure-field">
            Пересування
            <select
              value={form.transport}
              onChange={(e) => edit({ transport: e.target.value as Form['transport'] })}
            >
              <option value="car">Автомобілем</option>
              <option value="walk">Пішки</option>
              <option value="transit">Громадським транспортом</option>
            </select>
          </label>
          <label className="leisure-field">
            Темп
            <select value={form.pace} onChange={(e) => edit({ pace: e.target.value })}>
              <option value="balanced">Збалансований</option>
              <option value="relaxed">Без поспіху</option>
            </select>
          </label>
        </div>
        <label className="leisure-field">
          Бюджет на двох, ₴ · необов’язково
          <input
            inputMode="decimal"
            value={form.budget}
            onChange={(e) => edit({ budget: e.target.value })}
            placeholder="Уточнити під час вибору"
          />
        </label>
        <label className="leisure-field">
          Місце старту · необов’язково
          <input
            value={form.startLocation}
            onChange={(e) => edit({ startLocation: e.target.value })}
            placeholder="Адреса або місце зустрічі"
          />
        </label>
        <label className="leisure-check">
          <input
            type="checkbox"
            checked={form.includeFamiliar}
            onChange={(e) => edit({ includeFamiliar: e.target.checked })}
          />
          Можна повернутися у знайомі місця
        </label>
        <label className="leisure-check">
          <input
            type="checkbox"
            checked={form.allowNew}
            onChange={(e) => edit({ allowNew: e.target.checked })}
          />
          Дозволити нові, ще не оцінені варіанти
        </label>
        {form.mode === 'range' && (
          <details>
            <summary>Інші години для окремих днів</summary>
            {Array.from(
              {
                length: Math.max(
                  0,
                  Math.min(
                    14,
                    Math.round((Date.parse(form.to) - Date.parse(form.from)) / 86400000) + 1,
                  ),
                ),
              },
              (_, index) =>
                new Date(Date.parse(form.from + 'T12:00Z') + index * 86400000)
                  .toISOString()
                  .slice(0, 10),
            ).map((date) => (
              <div className="leisure-per-day" key={date}>
                <p>{leisureDate(date)}</p>
                <div className="leisure-time-grid">
                  <label className="leisure-field">
                    Від
                    <input
                      type="time"
                      value={form.perDay[date]?.startTime ?? form.startTime}
                      onChange={(e) =>
                        edit({
                          perDay: {
                            ...form.perDay,
                            [date]: {
                              startTime: e.target.value,
                              endTime: form.perDay[date]?.endTime ?? form.endTime,
                            },
                          },
                        })
                      }
                    />
                  </label>
                  <label className="leisure-field">
                    До
                    <input
                      type="time"
                      value={form.perDay[date]?.endTime ?? form.endTime}
                      onChange={(e) =>
                        edit({
                          perDay: {
                            ...form.perDay,
                            [date]: {
                              startTime: form.perDay[date]?.startTime ?? form.startTime,
                              endTime: e.target.value,
                            },
                          },
                        })
                      }
                    />
                  </label>
                </div>
              </div>
            ))}
          </details>
        )}
      </details>
      <button
        type="button"
        className="leisure-button is-primary leisure-generate"
        disabled={loading || busy}
        aria-busy={loading}
        onClick={() => void generate()}
      >
        {loading ? (
          <>
            <span className="leisure-spinner" aria-hidden="true" />
            Підбираю варіанти…
          </>
        ) : (
          'Підібрати варіанти'
        )}
      </button>
      {error && (
        <p className="leisure-error" role="alert">
          {error.message}
        </p>
      )}
      {notice && (
        <p className="leisure-notice" role="status">
          {notice}
        </p>
      )}
      {manualCopy && (
        <label className="leisure-field">
          Текст пропозиції
          <textarea readOnly value={manualCopy} onFocus={(e) => e.target.select()} />
        </label>
      )}
      {loading && !result && (
        <div className="leisure-suggestion-loading" role="status">
          <p>Зіставляю твою колекцію, час і доступні події.</p>
          <div />
          <div />
        </div>
      )}
      {result && (
        <div className="leisure-suggestion-results" ref={resultHeading} aria-busy={loading}>
          <div className="leisure-result-heading">
            <p className="leisure-eyebrow">
              {form.mode === 'range' ? 'Обираємо день' : 'Ваші можливості'}
            </p>
            <h3>{form.mode === 'range' ? 'Коли зустрінемося?' : 'Як провести цей час'}</h3>
          </div>
          {result.days.map((day) => (
            <section className="leisure-result-day" key={day.date}>
              <div className="leisure-result-date">
                <div>
                  <strong>{weekday(day.date)}</strong>
                  <span>{leisureDate(day.date)}</span>
                </div>
                {form.mode === 'range' && result.recommendedDate === day.date && (
                  <span className="leisure-recommended">Вдалий день</span>
                )}
              </div>
              {form.mode === 'range' &&
                result.recommendedDate === day.date &&
                result.recommendedReason && (
                  <p className="leisure-secondary">{result.recommendedReason}</p>
                )}
              {day.notes.map((note) => (
                <p className="leisure-secondary" key={note}>
                  {note}
                </p>
              ))}
              {(form.mode === 'day' || expandedDay === day.date
                ? day.plans
                : day.plans.slice(0, 1)
              ).map((plan) => renderPlan(plan, form.mode === 'range' && expandedDay !== day.date))}
              {form.mode === 'range' && day.plans.length > 0 && (
                <button
                  type="button"
                  className="leisure-text-button"
                  onClick={() => {
                    setExpandedDay(expandedDay === day.date ? null : day.date);
                    setExpanded(day.plans[0]!.id);
                  }}
                >
                  {expandedDay === day.date
                    ? 'Згорнути цей день'
                    : 'Варіанти цього дня · ' + day.plans.length}
                </button>
              )}
            </section>
          ))}
          <p className="leisure-secondary leisure-suggestion-note">{result.note}</p>
          {result.sources.length > 0 && (
            <details className="leisure-source-coverage">
              <summary>
                Джерела й актуальність
                {result.sources.some((s) => s.status === 'unavailable') ? ' · є прогалини' : ''}
              </summary>
              {result.sources.map((s, index) => (
                <p key={s.name + index}>
                  {s.name} ·{' '}
                  {s.status === 'ok'
                    ? 'перевірено'
                    : s.status === 'empty'
                      ? 'нічого не отримано'
                      : 'недоступно'}{' '}
                  · {leisureDate(s.checkedAt)}
                </p>
              ))}
            </details>
          )}
        </div>
      )}
      {drafts.length > 0 && (
        <details className="leisure-drafts">
          <summary>Мої чернетки · {drafts.length}</summary>
          {drafts.map((draft) => (
            <article key={draft.id}>
              <strong>{draft.title}</strong>
              <p className="leisure-secondary">
                {draft.stops[0] ? leisureDate(draft.stops[0].startAt) : 'Уточнити час'}
              </p>
              <div className="leisure-actions">
                <button
                  type="button"
                  className="leisure-button"
                  onClick={() => onChoose({ ...draft, sourceDraftId: draft.id })}
                >
                  Продовжити
                </button>
                <button
                  type="button"
                  className="leisure-text-button"
                  disabled={busy}
                  onClick={() =>
                    void send('discard-draft', { revision: draft.revision }, draft.id).catch((e) =>
                      setError(e),
                    )
                  }
                >
                  Прибрати
                </button>
              </div>
            </article>
          ))}
        </details>
      )}
    </section>
  );
}
