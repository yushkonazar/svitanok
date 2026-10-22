import { useState } from 'react';
import {
  leisureDate,
  leisureTime,
  pairPrice,
  money,
  toKyivInput,
  type LeisureItem,
} from '../../api/leisure.ts';
import { leisureReactionHidden } from '../../../../core/leisure/identity.mjs';
import { leisureWorkKey, LEISURE_FREQUENCIES } from '../../../../core/leisure/selection.mjs';
import { LEISURE_EVENT_FORMATS } from '../../../../core/leisure/taxonomy.mjs';
import { selectionContext, distanceFromCentre, type BrowseProps } from './selection-view.ts';
import { LeisureMedia } from './LeisureMedia.tsx';

type Props = BrowseProps & {
  mode: string;
  onFollow: (series: string) => void;
  onCorrect: (item: LeisureItem) => void;
};
const headings: Record<string, [string, string]> = {
  concert: ['Концерти', 'Виконавці, напрями та підтверджені дати.'],
  cinema: ['Моя афіша', 'Обери фільм один раз. Сеанс і кінотеатр — коли визначишся з днем.'],
  show: [
    'Постановки й виступи',
    'Один твір — усі доступні дати. Обирай постановку, а не кожен показ окремо.',
  ],
  exhibition: ['Виставки, що тривають', 'Що можна побачити зараз і що незабаром завершиться.'],
  festival: ['Фестивалі попереду', 'Тематика, дати й час для великого спільного виходу.'],
  meetup: ['Спробувати разом', 'Майстер-класи, лекції та зустрічі — з умовами участі.'],
  place: ['Ідеї у місті', 'Музеї, парки й незвичні місця. Нове та знайоме зберігаються поруч.'],
  trip: [
    'Вибратися зі Львова',
    'Орієнтир за загальним часом: дорога туди й назад та сама прогулянка.',
  ],
  podcast: ['Послухати', 'Коротка черга випусків і серії, за якими хочеться стежити.'],
  event: ['Інші події', 'Уточнюємо формат за інформацією організатора.'],
};
function durationLabel(minutes: number | null) {
  if (!minutes) return null;
  return minutes >= 60
    ? `${Math.floor(minutes / 60)} год${minutes % 60 ? ' ' + (minutes % 60) + ' хв' : ''}`
    : minutes + ' хв';
}
function tripEffort(item: LeisureItem, transport: string) {
  const km = distanceFromCentre(item);
  if (km == null) return null;
  return (
    Math.ceil(
      (((km * 2) / (transport === 'walk' ? 4 : transport === 'transit' ? 25 : 40)) * 1.4 * 60 +
        (item.durationMinutes ?? 120)) /
        30,
    ) * 30
  );
}
function ended(item: LeisureItem, today: string, now: number) {
  if (['place', 'trip', 'podcast'].includes(item.category) || item.schedule?.kind === 'on-request')
    return false;
  if (item.category === 'cinema')
    return (
      !!item.endDate &&
      item.endDate < today &&
      !item.sessions.some((s) => Date.parse(s.endAt ?? s.startAt) > now)
    );
  if (item.schedule?.occurrences?.some((o) => Date.parse(o.endAt ?? o.startAt) > now)) return false;
  return !!item.endDate && item.endDate < today;
}
export function CategoryBrowse(props: Props) {
  const { data, items, mode, busy, onOpen, onChoose, onVisit, onExplain, onFollow, onCorrect } =
    props;
  const [scope, setScope] = useState(
      mode === 'show' ||
        mode === 'festival' ||
        mode === 'exhibition' ||
        mode === 'meetup' ||
        mode === 'event'
        ? 'all'
        : 'new',
    ),
    [limit, setLimit] = useState(mode === 'cinema' ? 5 : 8),
    [effort, setEffort] = useState('all');
  const context = selectionContext(data),
    now = Date.parse(data.generatedAt),
    today = toKyivInput(data.generatedAt).slice(0, 10);
  const grouped = new Map<string, { item: LeisureItem; variants: LeisureItem[] }>();
  for (const item of items) {
    const key = leisureWorkKey(item),
      existing = grouped.get(key);
    if (existing) {
      existing.variants.push(item);
      if (ended(existing.item, today, now) && !ended(item, today, now)) existing.item = item;
    } else grouped.set(key, { item, variants: [item] });
  }
  const rows = [...grouped.values()]
    .filter(({ item, variants }) => {
      const decision = context.decision(item),
        hidden = leisureReactionHidden(decision ?? {}, now),
        known = variants.some(context.known);
      if (scope === 'hidden') return hidden;
      if (hidden) return false;
      if (scope === 'want')
        return decision?.verdict === 'interested' || data.saved.includes(item.id);
      if (scope === 'seen') return known;
      if (variants.every((v) => ended(v, today, now))) return false;
      if (scope === 'new')
        return !known && decision?.verdict !== 'interested' && !data.saved.includes(item.id);
      return true;
    })
    .filter(({ item }) => {
      if (mode !== 'trip' || effort === 'all') return true;
      const total = tripEffort(item, data.settings.transport);
      return effort === 'unknown'
        ? total == null
        : total != null &&
            (effort === 'short'
              ? total <= 240
              : effort === 'half'
                ? total > 240 && total <= 420
                : total > 420);
    })
    .sort((a, b) => {
      if (mode === 'exhibition')
        return (a.item.endDate ?? '9999').localeCompare(b.item.endDate ?? '9999');
      if (mode === 'podcast') {
        const followed = data.settings.selection.followedPodcastSeries;
        return (
          Number(followed.includes(b.item.podcast?.series ?? '')) -
            Number(followed.includes(a.item.podcast?.series ?? '')) ||
          (a.item.podcast?.series || a.item.source).localeCompare(
            b.item.podcast?.series || b.item.source,
            'uk',
          ) ||
          (b.item.publishedAt ?? '').localeCompare(a.item.publishedAt ?? '')
        );
      }
      if (mode === 'trip')
        return (
          (tripEffort(a.item, data.settings.transport) ?? Infinity) -
          (tripEffort(b.item, data.settings.transport) ?? Infinity)
        );
      return 0;
    });
  const [heading, description] = headings[mode] ?? headings.event!;
  return (
    <section className={`leisure-category-browser is-${mode}`} aria-label={heading}>
      <div className="leisure-browse-intro">
        <p className="leisure-eyebrow">{mode === 'cinema' ? 'Твоє кіно' : 'Твоя колекція ідей'}</p>
        <h2>{heading}</h2>
        <p className="leisure-secondary">{description}</p>
      </div>
      <div className="leisure-pills leisure-browse-scope" aria-label="Показати варіанти">
        {(
          [
            [
              'new',
              mode === 'cinema'
                ? 'Нові фільми'
                : mode === 'podcast'
                  ? 'Нові випуски'
                  : 'Ще не були',
            ],
            ['want', mode === 'podcast' ? 'У черзі' : 'Хочу'],
            ['seen', mode === 'cinema' ? 'Дивився' : mode === 'podcast' ? 'Слухав' : 'Знайомі'],
            ['all', 'Усе'],
            ['hidden', 'Виключені'],
          ] as const
        ).map(([id, label]) => (
          <button
            type="button"
            className={`leisure-pill${scope === id ? ' is-active' : ''}`}
            key={id}
            aria-pressed={scope === id}
            onClick={() => {
              setScope(id);
              setLimit(mode === 'cinema' ? 5 : 8);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {mode === 'trip' && (
        <label className="leisure-field">
          Скільки часу готові виділити
          <select value={effort} onChange={(e) => setEffort(e.target.value)}>
            <option value="all">Усі варіанти</option>
            <option value="short">Кілька годин</option>
            <option value="half">Пів дня</option>
            <option value="day">Цілий день</option>
            <option value="unknown">Час потрібно уточнити</option>
          </select>
        </label>
      )}
      {mode === 'show' && (
        <p className="leisure-cadence-note">
          {(data.settings.selection.formatFrequency.opera ?? 'rare') === 'rare'
            ? 'Опера — зрідка, приблизно 1–2 виходи на півроку.'
            : `Опера — ${LEISURE_FREQUENCIES[data.settings.selection.formatFrequency.opera!]}.`}{' '}
          Частоту можна змінити в налаштуваннях.
        </p>
      )}
      <div className="leisure-browse-list">
        {rows.slice(0, limit).map(({ item, variants }, index) => {
          const decision = context.decision(item),
            known = variants.some(context.known),
            priority = decision?.verdict === 'interested' && decision.interestLevel === 'priority',
            wanted = decision?.verdict === 'interested',
            price = pairPrice(item);
          const series = item.podcast?.series || item.source,
            previous = rows[index - 1]?.item,
            showSeries =
              mode === 'podcast' && series !== (previous?.podcast?.series || previous?.source);
          const upcoming = item.sessions.filter((s) => Date.parse(s.startAt) > now);
          const dates = [
            ...new Set(
              variants.flatMap((v) =>
                v.schedule?.occurrences?.length
                  ? v.schedule.occurrences
                      .filter((o) => Date.parse(o.endAt ?? o.startAt) > now)
                      .map((o) => o.startAt)
                  : v.startAt
                    ? [v.startAt]
                    : v.startDate
                      ? [v.startDate]
                      : [],
              ),
            ),
          ].sort();
          const total = mode === 'trip' ? tripEffort(item, data.settings.transport) : null;
          return (
            <div key={item.id}>
              {showSeries && (
                <div className="leisure-series-heading">
                  <h3>{series}</h3>
                  <button
                    type="button"
                    disabled={busy}
                    aria-pressed={data.settings.selection.followedPodcastSeries.includes(series)}
                    onClick={() => onFollow(series)}
                  >
                    {data.settings.selection.followedPodcastSeries.includes(series)
                      ? 'Стежу за серією'
                      : 'Стежити за серією'}
                  </button>
                </div>
              )}
              <article className={`leisure-browse-row${priority ? ' is-priority' : ''}`}>
                <div className="leisure-browse-main">
                  <LeisureMedia item={item} variant="thumb" />
                  <button
                    type="button"
                    className="leisure-browse-open"
                    aria-label={`Деталі: ${item.title}`}
                    onClick={() => onOpen(item)}
                  >
                    <span className="leisure-browse-copy">
                      <span className="leisure-eyebrow">
                        {item.eventFormat
                          ? LEISURE_EVENT_FORMATS[item.eventFormat]
                          : mode === 'cinema'
                            ? item.genre || 'Кіно'
                            : mode === 'trip'
                              ? 'Поїздка'
                              : mode === 'podcast'
                                ? 'Випуск'
                                : item.venue || 'Місце у Львові'}
                      </span>
                      <strong>{item.title}</strong>
                      {mode === 'cinema' ? (
                        <>
                          <span className="leisure-secondary">
                            {[
                              durationLabel(item.durationMinutes),
                              item.age && item.age + ' років',
                              item.film?.year,
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </span>
                          {item.film?.imdbRating != null && (
                            <span>
                              IMDb {item.film.imdbRating.toFixed(1)}
                              {item.film.imdbVotes != null
                                ? ` · ${item.film.imdbVotes.toLocaleString('uk-UA')} оцінок`
                                : ''}
                            </span>
                          )}
                          <span className="leisure-secondary">
                            {upcoming.length
                              ? `${upcoming.length} підтверджених сеансів`
                              : 'Сеанси ще не опубліковані'}
                          </span>
                        </>
                      ) : (
                        <>
                          {mode === 'podcast' ? (
                            <span className="leisure-secondary">
                              {[
                                durationLabel(item.durationMinutes),
                                item.publishedAt && leisureDate(item.publishedAt),
                              ]
                                .filter(Boolean)
                                .join(' · ')}
                            </span>
                          ) : (
                            <span className="leisure-secondary">
                              {item.schedule?.kind === 'on-request'
                                ? 'За попереднім узгодженням'
                                : mode === 'exhibition' && item.endDate
                                  ? 'Триває до ' + leisureDate(item.endDate)
                                  : item.startDate
                                    ? leisureDate(item.startDate) +
                                      (item.startAt ? ' · ' + leisureTime(item.startAt) : '')
                                    : 'Можна обрати день'}
                            </span>
                          )}
                          {item.address && (
                            <span className="leisure-secondary">{item.address}</span>
                          )}
                          {total != null ? (
                            <span>≈ {durationLabel(total)} з дорогою від центру Львова</span>
                          ) : (
                            item.durationMinutes && (
                              <span>{durationLabel(item.durationMinutes)}</span>
                            )
                          )}
                          {mode !== 'podcast' && (
                            <span>
                              {price == null
                                ? 'Ціну потрібно уточнити'
                                : price === 0
                                  ? 'Безплатно'
                                  : `Від ${money(price)} на двох`}
                            </span>
                          )}
                        </>
                      )}
                    </span>
                  </button>
                </div>
                <p className="leisure-browse-summary">{item.summary}</p>
                <div className="leisure-browse-tags">
                  {variants.every((v) => ended(v, today, now)) && (
                    <span>Покази або подія вже завершилися</span>
                  )}
                  {priority && <span>Твій пріоритет</span>}
                  {known && (
                    <span>
                      {mode === 'cinema'
                        ? 'Уже дивився'
                        : mode === 'podcast'
                          ? 'Уже слухав'
                          : 'Бували раніше'}
                    </span>
                  )}
                  {item.schedule?.confirmationRequired && (
                    <span>Участь удвох потрібно узгодити</span>
                  )}
                  {item.status !== 'available' && (
                    <span>
                      {item.status === 'schedule-pending'
                        ? 'Очікуємо розклад'
                        : 'Доступність потрібно перевірити'}
                    </span>
                  )}
                </div>
                {mode === 'show' && dates.length > 0 && (
                  <details className="leisure-performance-dates">
                    <summary>Дати цієї постановки · {dates.length}</summary>
                    {dates.map((date) => (
                      <p key={date}>
                        {leisureDate(date)}
                        {date.includes('T') ? ' · ' + leisureTime(date) : ''}
                      </p>
                    ))}
                  </details>
                )}
                {mode === 'trip' && total != null && (
                  <p className="leisure-secondary leisure-estimate-note">
                    Орієнтовно: маршрут і час у дорозі уточнимо під час планування.
                  </p>
                )}
                <div className="leisure-browse-actions">
                  {scope === 'hidden' ? (
                    <button type="button" disabled={busy} onClick={() => onChoose(item, 'clear')}>
                      Повернути
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        disabled={busy}
                        aria-pressed={wanted}
                        onClick={() => onChoose(item, 'interested')}
                      >
                        {mode === 'podcast' ? 'У чергу' : mode === 'meetup' ? 'Спробувати' : 'Хочу'}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        aria-pressed={priority}
                        onClick={() => onChoose(item, 'priority')}
                      >
                        ☆ Насамперед
                      </button>
                      <button type="button" disabled={busy} onClick={() => onVisit(item)}>
                        {mode === 'cinema'
                          ? 'Бачив'
                          : mode === 'podcast'
                            ? 'Слухав'
                            : known
                              ? 'Мій досвід'
                              : 'Були'}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => onChoose(item, 'uninterested')}
                      >
                        {mode === 'place' ? 'Не пропонувати' : 'Пропустити'}
                      </button>
                    </>
                  )}
                  <button type="button" disabled={busy} onClick={() => onExplain(item)}>
                    Уточнити
                  </button>
                </div>
                {item.eventFormat && (
                  <button
                    type="button"
                    className="leisure-text-button leisure-correct-type"
                    disabled={busy}
                    onClick={() => onCorrect(item)}
                  >
                    Уточнити тип події
                  </button>
                )}
              </article>
            </div>
          );
        })}
      </div>
      {!rows.length && (
        <p className="leisure-empty">
          {scope === 'want'
            ? 'Тут будуть твої бажані варіанти.'
            : scope === 'seen'
              ? 'Позначені перегляди й відвідування з’являться тут.'
              : scope === 'hidden'
                ? 'Виключених варіантів немає.'
                : 'У цій добірці поки немає нових варіантів. Можна переглянути інші розділи.'}
        </p>
      )}
      {rows.length > limit && (
        <button type="button" className="leisure-button" onClick={() => setLimit((v) => v + 8)}>
          Переглянути ще · {rows.length - limit}
        </button>
      )}
    </section>
  );
}
