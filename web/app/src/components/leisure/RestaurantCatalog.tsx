import { useEffect, useRef, useState } from 'react';
import { fetchLeisureFoodQuality, useLeisureFoodQuality } from '../../api/leisure-quality.ts';
import { leisureLiveAvailable } from '../../api/leisure-enrichment.ts';
import { leisureFoodQuality } from '../../../../core/leisure/selection.mjs';
import { leisureReactionHidden } from '../../../../core/leisure/identity.mjs';
import { LeisureMedia } from './LeisureMedia.tsx';
import {
  selectionContext,
  foodCuisine,
  foodPairRange,
  distanceFromCentre,
  type BrowseProps,
} from './selection-view.ts';
import type { LeisureItem } from '../../api/leisure.ts';
import type { LeisureLivePlace } from '../../api/leisure-enrichment.ts';

export function RestaurantCatalog(props: BrowseProps) {
  const { data, busy, onOpen, onChoose, onVisit } = props;
  const [sort, setSort] = useState('recommended'),
    [cuisine, setCuisine] = useState(''),
    [budget, setBudget] = useState(''),
    [parking, setParking] = useState(false),
    [showExcluded, setShowExcluded] = useState(false);
  const [extra, setExtra] = useState<Record<string, LeisureLivePlace>>({}),
    [checking, setChecking] = useState(false),
    [error, setError] = useState(''),
    [limit, setLimit] = useState(12);
  const [attempted, setAttempted] = useState<Set<string>>(new Set());
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const live = useLeisureFoodQuality(parking || data.settings.selection.parking !== 'any');
  const context = selectionContext(data);
  const facts = new Map((live.data?.entries ?? []).map((row) => [row.itemId, row.place]));
  const items = props.items.map((item) => ({
    ...item,
    placeDetails:
      ((parking || data.settings.selection.parking !== 'any') && !extra[item.id]?.extended
        ? facts.get(item.id)
        : extra[item.id]) ??
      facts.get(item.id) ??
      item.placeDetails,
  }));
  const checked = items.filter((item) => typeof item.placeDetails?.rating === 'number').length;
  const matches = items
    .filter((item) => !cuisine || foodCuisine(item) === cuisine)
    .filter((item) => {
      const range = foodPairRange(item);
      return !budget || (range.max != null && range.max <= Number(budget));
    })
    .map((item) => ({
      item,
      quality: leisureFoodQuality(
        item,
        data.settings.selection,
        context.decision(item),
        data.settings.transport,
      ),
      hidden: leisureReactionHidden(context.decision(item) ?? {}, Date.parse(data.generatedAt)),
    }));
  const rows = matches
    .filter((row) =>
      showExcluded
        ? row.hidden
        : !row.hidden &&
          (row.quality.verified || row.quality.priority) &&
          row.quality.eligible &&
          (!parking || row.quality.hasParking === true) &&
          (sort !== 'priority' || row.quality.priority),
    )
    .sort((a, b) => {
      if (sort === 'rating')
        return (
          (b.quality.rating ?? 0) - (a.quality.rating ?? 0) ||
          (b.quality.count ?? 0) - (a.quality.count ?? 0)
        );
      if (sort === 'near')
        return (
          (distanceFromCentre(a.item) ?? Infinity) - (distanceFromCentre(b.item) ?? Infinity) ||
          b.quality.score - a.quality.score
        );
      return b.quality.score - a.quality.score || a.item.title.localeCompare(b.item.title, 'uk');
    });
  const unknown = matches.filter(
    (row) => !row.hidden && !row.quality.verified && !row.quality.priority,
  );
  const unchecked = items
    .filter(
      (item) =>
        item.placeId &&
        typeof item.placeDetails?.rating !== 'number' &&
        !attempted.has(item.id) &&
        !leisureReactionHidden(context.decision(item) ?? {}, Date.parse(data.generatedAt)),
    )
    .map((item) => item.id);
  const pendingIds = unchecked.slice(0, 4);
  const checkMore = async (all = false) => {
    if (checking || !pendingIds.length) return;
    const active = new AbortController();
    controller.current = active;
    const queue = all ? unchecked : pendingIds;
    setChecking(true);
    setError('');
    try {
      for (let index = 0; index < queue.length && !active.signal.aborted; index += 4) {
        const result = await fetchLeisureFoodQuality(
          { ids: queue.slice(index, index + 4), parking },
          AbortSignal.any([active.signal, AbortSignal.timeout(25000)]),
        );
        if (active.signal.aborted) break;
        setExtra((previous) => ({
          ...previous,
          ...Object.fromEntries(result.entries.map((row) => [row.itemId, row.place])),
        }));
        setAttempted(
          (previous) => new Set([...previous, ...result.entries.map((row) => row.itemId)]),
        );
        if (result.partial || !result.entries.length) {
          setError('Частину оцінок не вдалося перевірити. Можеш повторити.');
          break;
        }
      }
    } catch (e) {
      if (!active.signal.aborted)
        setError(e instanceof Error ? e.message : 'Не вдалося перевірити оцінки.');
    } finally {
      if (controller.current === active) {
        controller.current = null;
        setChecking(false);
      }
    }
  };
  const row = (item: LeisureItem) => {
    const decision = context.decision(item),
      quality = leisureFoodQuality(
        item,
        data.settings.selection,
        decision,
        data.settings.transport,
      ),
      range = foodPairRange(item),
      km = distanceFromCentre(item);
    const photos = (item.placeDetails?.photos as LeisureLivePlace['photos'] | undefined) ?? [];
    return (
      <article className="leisure-venue-row" key={item.id}>
        <div className="leisure-venue-main">
          <LeisureMedia item={item} variant="thumb" livePhotos={photos} />
          <button
            type="button"
            className="leisure-browse-open"
            onClick={() => onOpen(item)}
            aria-label={`Деталі: ${item.title}`}
          >
            <span className="leisure-venue-copy">
              <span className="leisure-eyebrow">{foodCuisine(item)}</span>
              <strong>{item.title}</strong>
              <span className="leisure-venue-rating">
                {quality.rating == null
                  ? attempted.has(item.id)
                    ? 'Google не повернув оцінку'
                    : 'Оцінку ще не перевірено'
                  : `★ ${quality.rating.toFixed(1)} · ${quality.count == null ? 'кількість оцінок невідома' : quality.count.toLocaleString('uk-UA') + ' оцінок'}`}
              </span>
              <span className="leisure-secondary">
                {item.address || 'Адресу потрібно уточнити'}
                {km != null ? ` · ≈ ${km.toFixed(1)} км до площі Ринок` : ''}
              </span>
              <span>
                {range.min != null
                  ? `≈ ${range.min.toLocaleString('uk-UA')}${range.max != null ? '–' + range.max.toLocaleString('uk-UA') : ''} ₴ на двох`
                  : 'Витрати на двох ще не уточнені'}
              </span>
              {quality.verified && (
                <span className="leisure-google-attribution" translate="no">
                  Google Maps
                </span>
              )}
            </span>
          </button>
        </div>
        <div className="leisure-browse-tags">
          {quality.count != null && quality.count < 30 && <span>Мало оцінок</span>}
          {context.known(item) && <span>Знайоме місце</span>}
          {quality.hasParking === true ? (
            <span>Є варіанти паркування</span>
          ) : (
            <span>
              Паркування {quality.hasParking === false ? 'не підтверджено' : 'не уточнено'}
            </span>
          )}
          {quality.priority &&
            quality.rating != null &&
            quality.rating < data.settings.selection.minFoodRating && (
              <span>Твій пріоритет нижче порога</span>
            )}
        </div>
        <div className="leisure-browse-actions">
          <button
            type="button"
            disabled={busy}
            aria-pressed={quality.priority}
            onClick={() => onChoose(item, 'priority')}
          >
            ☆ Насамперед
          </button>
          <button type="button" disabled={busy} onClick={() => onVisit(item)}>
            {context.known(item) ? 'Мій досвід' : 'Були'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onChoose(item, showExcluded ? 'clear' : 'uninterested')}
          >
            {showExcluded ? 'Повернути' : 'Не пропонувати'}
          </button>
          <button type="button" disabled={busy} onClick={() => props.onExplain(item)}>
            Уточнити
          </button>
        </div>
      </article>
    );
  };
  return (
    <section className="leisure-catalog" aria-label="Каталог закладів">
      <div className="leisure-browse-intro">
        <p className="leisure-eyebrow">За твоїми вимогами</p>
        <h2>Заклади, які варто розглянути</h2>
        <p className="leisure-secondary">
          Оцінка від {data.settings.selection.minFoodRating.toFixed(1)}. Позначай лише пріоритети й
          винятки — решту система добере сама.
        </p>
      </div>
      <div className="leisure-catalog-filters">
        <label className="leisure-field">
          Порядок
          <select
            value={sort}
            onChange={(e) => {
              setSort(e.target.value);
              setLimit(12);
            }}
          >
            <option value="recommended">Рекомендовані</option>
            <option value="rating">За оцінкою Google</option>
            <option value="near">Ближче до центру</option>
            <option value="priority">Мої пріоритети</option>
          </select>
        </label>
        <label className="leisure-field">
          Кухня або формат
          <select value={cuisine} onChange={(e) => setCuisine(e.target.value)}>
            <option value="">Усі кухні й формати</option>
            {[...new Set(items.map(foodCuisine))].sort().map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </label>
        <label className="leisure-field">
          Орієнтир на двох, ₴
          <input
            type="number"
            min="0"
            max="100000"
            inputMode="numeric"
            value={budget}
            placeholder="Без обмеження"
            onChange={(e) => setBudget(e.target.value)}
          />
        </label>
      </div>
      <label className="leisure-check">
        <input type="checkbox" checked={parking} onChange={(e) => setParking(e.target.checked)} />
        Лише з підтвердженими варіантами паркування
      </label>
      <label className="leisure-check">
        <input
          type="checkbox"
          checked={showExcluded}
          onChange={(e) => setShowExcluded(e.target.checked)}
        />
        Показати ті, що я виключив
      </label>
      <div className="leisure-catalog-status" aria-live="polite">
        <span>
          {live.isFetching
            ? 'Перевіряємо оцінки Google…'
            : `Оцінки перевірено: ${checked} із ${items.length}`}
        </span>
        <span className="leisure-secondary">
          Порядок серед перевірених закладів. Чек — орієнтир; паркування не означає вільного місця.
        </span>
        {live.error && (
          <>
            <p role="alert">{live.error.message}</p>
            <button type="button" className="leisure-button" onClick={() => void live.refetch()}>
              Повторити перевірку
            </button>
          </>
        )}
        {live.data?.partial && <p>Частина джерела недоступна; показуємо підтверджені дані.</p>}
      </div>
      <div className="leisure-venue-list">{rows.slice(0, limit).map(({ item }) => row(item))}</div>
      {!rows.length && !live.isFetching && (
        <p className="leisure-empty">
          {showExcluded
            ? 'Виключених закладів немає.'
            : 'Серед перевірених закладів поки немає збігів. Можна змінити фільтри або перевірити наступні.'}
        </p>
      )}
      {rows.length > limit && (
        <button type="button" className="leisure-button" onClick={() => setLimit((v) => v + 12)}>
          Ще заклади
        </button>
      )}
      {!showExcluded && (unknown.length > 0 || unchecked.length > 0) && (
        <details className="leisure-unverified" open={!leisureLiveAvailable()}>
          <summary>
            Без перевіреної оцінки ·{' '}
            {items.filter((item) => typeof item.placeDetails?.rating !== 'number').length}
          </summary>
          <p className="leisure-secondary">
            Це не низький рейтинг. Ці заклади ще не брали участі в порівнянні.
          </p>
          {leisureLiveAvailable() && pendingIds.length > 0 && (
            <button
              type="button"
              className="leisure-button"
              disabled={checking}
              onClick={() => void checkMore()}
            >
              {checking ? 'Перевіряємо…' : `Перевірити наступні ${pendingIds.length}`}
            </button>
          )}
          {leisureLiveAvailable() && unchecked.length > 4 && !checking && (
            <button type="button" className="leisure-button" onClick={() => void checkMore(true)}>
              Уточнити рейтинг усіх решти · {unchecked.length}
            </button>
          )}
          {checking && (
            <button
              type="button"
              className="leisure-button"
              onClick={() => controller.current?.abort()}
            >
              Зупинити перевірку
            </button>
          )}
          {error && (
            <p role="alert" className="leisure-error">
              {error}
            </p>
          )}
          {unknown.slice(0, 12).map(({ item }) => row(item))}
        </details>
      )}
    </section>
  );
}
