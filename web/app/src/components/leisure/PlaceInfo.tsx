import { useState } from 'react';
import { z } from 'zod';
import { leisureDate, money, type LeisureItem } from '../../api/leisure.ts';
import {
  leisureLiveAvailable,
  useLeisureEnrichment,
  type LeisureLivePlace,
} from '../../api/leisure-enrichment.ts';
const amount = z.object({
  currencyCode: z.string(),
  units: z.union([z.string(), z.number()]),
  nanos: z.number().optional(),
});
const priceRange = z.object({ startPrice: amount.optional(), endPrice: amount.optional() });
const amenities: Record<string, string> = {
  outdoorSeating: 'Тераса',
  reservable: 'Приймають бронювання',
  servesBreakfast: 'Сніданки',
  servesBrunch: 'Бранч',
  servesLunch: 'Обіди',
  servesDinner: 'Вечері',
  servesCoffee: 'Кава',
  servesDessert: 'Десерти',
  servesCocktails: 'Коктейлі',
  servesVegetarianFood: 'Вегетаріанські страви',
  liveMusic: 'Жива музика',
  allowsDogs: 'Можна з собакою',
  goodForGroups: 'Підходить для компаній',
  goodForChildren: 'Підходить для дітей',
  restroom: 'Вбиральня',
};
const accessibility: Record<string, string> = {
  wheelchairAccessibleEntrance: 'Доступний вхід',
  wheelchairAccessibleSeating: 'Доступні місця',
  wheelchairAccessibleRestroom: 'Доступна вбиральня',
  wheelchairAccessibleParking: 'Доступне паркування',
};
const payments: Record<string, string> = {
  acceptsCreditCards: 'Кредитні картки',
  acceptsDebitCards: 'Дебетові картки',
  acceptsCashOnly: 'Лише готівка',
  acceptsNfc: 'Безконтактна оплата',
};
const parking: Record<string, string> = {
  freeParkingLot: 'Безкоштовна стоянка',
  paidParkingLot: 'Платна стоянка',
  freeStreetParking: 'Безкоштовне паркування на вулиці',
  paidStreetParking: 'Платне паркування на вулиці',
  valetParking: 'Послуга паркування',
  freeGarageParking: 'Безкоштовний паркінг',
  paidGarageParking: 'Платний паркінг',
};
function GooglePrice({ range, food }: { range: unknown; food: boolean }) {
  const parsed = priceRange.safeParse(range);
  const label = (v: z.infer<typeof amount> | undefined, pair = false) => {
    if (!v) return null;
    const n = Number(v.units) + (v.nanos ?? 0) / 1e9;
    if (!Number.isFinite(n)) return null;
    try {
      return new Intl.NumberFormat('uk-UA', {
        style: 'currency',
        currency: v.currencyCode,
        maximumFractionDigits: 0,
      }).format(n * (pair ? 2 : 1));
    } catch {
      return null;
    }
  };
  if (!parsed.success) return null;
  const low = label(parsed.data.startPrice),
    high = label(parsed.data.endPrice);
  if (!low && !high) return null;
  return (
    <div className="leisure-google-price">
      <strong>
        Орієнтир Google: {low && high ? low + ' — ' + high : low ? 'від ' + low : 'до ' + high}
      </strong>
      {food && (
        <p>
          Приблизно на двох:{' '}
          {label(parsed.data.startPrice, true) && label(parsed.data.endPrice, true)
            ? label(parsed.data.startPrice, true) + ' — ' + label(parsed.data.endPrice, true)
            : low
              ? 'від ' + label(parsed.data.startPrice, true)
              : 'до ' + label(parsed.data.endPrice, true)}
          .
        </p>
      )}
      <p className="leisure-secondary">
        Це орієнтир витрат від відвідувачів або закладу. Сума замовлення залежить від вибору; меню й
        актуальні ціни — на сайті закладу.
      </p>
    </div>
  );
}
function Features({
  values,
  labels,
}: {
  values: Record<string, boolean>;
  labels: Record<string, string>;
}) {
  const known = Object.entries(values).filter(([key, value]) => value === true && labels[key]);
  return known.length ? (
    <div className="leisure-fact-chips">
      {known.map(([key]) => (
        <span key={key}>{labels[key]}</span>
      ))}
    </div>
  ) : null;
}
function GoogleFacts({ place, item }: { place: LeisureLivePlace; item: LeisureItem }) {
  return (
    <div className="leisure-google-facts">
      <span className="leisure-google-attribution" translate="no">
        Google Maps
      </span>
      {place.rating != null && (
        <p className="leisure-google-rating">
          <strong>★ {place.rating.toFixed(1)}</strong>
          <span>
            {place.userRatingCount != null
              ? new Intl.NumberFormat('uk-UA').format(place.userRatingCount) + ' оцінок'
              : 'Кількість оцінок невідома'}
          </span>
        </p>
      )}
      <GooglePrice range={place.price_range} food={item.category === 'food'} />
      {place.businessStatus && place.businessStatus !== 'OPERATIONAL' && (
        <p className="leisure-notice">
          {place.businessStatus === 'CLOSED_PERMANENTLY'
            ? 'Google позначає місце як зачинене назавжди'
            : 'Google позначає місце як тимчасово зачинене'}
        </p>
      )}
      {place.movedPlaceId && (
        <p className="leisure-notice">
          Місце змінило адресу. Перед виходом перевір його в Google Maps.
        </p>
      )}
      {place.hours.length > 0 && (
        <details className="leisure-hours">
          <summary>Години роботи на найближчі дні</summary>
          <ul>
            {place.hours.map((h) => (
              <li key={h}>{h}</li>
            ))}
          </ul>
          <p className="leisure-secondary">
            Святковий графік і час на майбутні дати варто звірити перед виходом.
          </p>
        </details>
      )}
      <Features values={place.amenities} labels={amenities} />
      <Features values={place.accessibility} labels={accessibility} />
      <Features values={place.payment} labels={payments} />
      <Features values={place.parking} labels={parking} />
      {place.amenities.reservable === true && (
        <p className="leisure-secondary">
          Можливість бронювання не підтверджує вільного столика на вашу дату.
        </p>
      )}
      <div className="leisure-source-links">
        {place.site && (
          <a href={place.site} target="_blank" rel="noopener noreferrer">
            Сайт і меню ↗
          </a>
        )}
        {place.phone && <a href={'tel:' + place.phone.replace(/[^+\d]/g, '')}>{place.phone}</a>}
        {place.maps_uri && (
          <a href={place.maps_uri} target="_blank" rel="noopener noreferrer">
            Google Maps ↗
          </a>
        )}
      </div>
      <p className="leisure-secondary">
        Оновлено {leisureDate(place.fetched_at)} під час цього перегляду.
      </p>
    </div>
  );
}
function ExtendedPlace({ item }: { item: LeisureItem }) {
  const live = useLeisureEnrichment(item, true, true);
  if (live.isPending)
    return (
      <p className="leisure-secondary" role="status">
        Уточнюю зручності та умови…
      </p>
    );
  if (live.isError) return <p className="leisure-notice">{live.error.message}</p>;
  return live.data?.place ? <GoogleFacts item={item} place={live.data.place} /> : null;
}
function LivePlace({ item }: { item: LeisureItem }) {
  const live = useLeisureEnrichment(item);
  const [extended, setExtended] = useState(false);
  if (live.isPending)
    return (
      <p className="leisure-secondary" role="status">
        Перевіряю актуальні дані закладу…
      </p>
    );
  if (live.isError)
    return (
      <div className="leisure-notice">
        <p>{live.error.message}</p>
        <button type="button" className="leisure-text-button" onClick={() => void live.refetch()}>
          Спробувати ще раз
        </button>
      </div>
    );
  if (!live.data?.place) return null;
  return extended ? (
    <ExtendedPlace item={item} />
  ) : (
    <>
      <GoogleFacts item={item} place={live.data.place} />
      <button type="button" className="leisure-text-button" onClick={() => setExtended(true)}>
        Уточнити зручності, оплату й паркування
      </button>
    </>
  );
}
export function PlaceInfo({ item, now }: { item: LeisureItem; now: string }) {
  if (item.placeId && leisureLiveAvailable()) return <LivePlace key={item.id} item={item} />;
  return (
    <>
      <GooglePrice range={item.placeDetails?.price_range} food={item.category === 'food'} />
      {typeof item.placeDetails?.fetched_at === 'string' && (
        <p className="leisure-secondary">
          Дані закладу: {leisureDate(item.placeDetails.fetched_at)}
          {Date.parse(now) - Date.parse(item.placeDetails.fetched_at) > 7 * 86400000
            ? ' · потребують оновлення'
            : ''}
        </p>
      )}
    </>
  );
}
function LiveFilm({ item }: { item: LeisureItem }) {
  const live = useLeisureEnrichment(item);
  return <FilmFacts item={item} film={live.data?.film ?? item.film} summary={live.data?.summary} />;
}
function FilmFacts({
  item,
  film,
  summary,
}: {
  item: LeisureItem;
  film: LeisureItem['film'];
  summary?: string;
}) {
  if (!film) return null;
  return (
    <div className="leisure-film-facts">
      {film.originalTitle && (
        <p>
          {film.originalTitle}
          {film.year ? ' · ' + film.year : ''}
        </p>
      )}
      {film.imdbRating != null && (
        <p>
          <strong>IMDb {film.imdbRating.toFixed(1)}</strong>
          {film.imdbVotes
            ? ' · ' + new Intl.NumberFormat('uk-UA').format(film.imdbVotes) + ' оцінок'
            : ''}
          <span className="leisure-secondary"> · за даними {item.source}</span>
        </p>
      )}
      {film.countries && <p>Країни: {film.countries}</p>}
      {film.language && <p>Мова фільму: {film.language}</p>}
      {film.subtitles && <p>Субтитри: {film.subtitles}</p>}
      {(film.language || film.subtitles) && (
        <p className="leisure-secondary">
          Мова конкретного сеансу може відрізнятися — звір її під час вибору квитків.
        </p>
      )}
      {summary && summary !== item.summary && (
        <details>
          <summary>Більше про фільм</summary>
          <p>{summary}</p>
        </details>
      )}
    </div>
  );
}
export function ContentInfo({ item }: { item: LeisureItem }) {
  const weekdays = ['неділя', 'понеділок', 'вівторок', 'середа', 'четвер', 'п’ятниця', 'субота'];
  return (
    <>
      {!!item.qualityWarnings?.length && (
        <div className="leisure-quality-notice" role="note">
          <strong>Потрібне уточнення</strong>
          {item.qualityWarnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
        </div>
      )}
      {item.schedule?.kind === 'recurring' && (
        <p className="leisure-notice">
          Повторюється: {item.schedule.weekdays.map((d) => weekdays[d]).join(', ')}
          {item.schedule.startTime ? ' · ' + item.schedule.startTime : ''}
          {item.schedule.endTime ? '–' + item.schedule.endTime : ''}.
        </p>
      )}
      {item.schedule?.kind === 'on-request' && (
        <p className="leisure-notice">
          Активність за попереднім узгодженням. Час для двох потрібно підтвердити в організатора.
        </p>
      )}
      {!!item.schedule?.occurrences.length && (
        <div className="leisure-film-facts">
          <strong>Опубліковані покази</strong>
          {item.schedule.occurrences.slice(0, 8).map((o) => (
            <p key={o.startAt}>
              {leisureDate(o.startAt)} ·{' '}
              {new Intl.DateTimeFormat('uk-UA', {
                hour: '2-digit',
                minute: '2-digit',
                timeZone: 'Europe/Kyiv',
              }).format(new Date(o.startAt))}
            </p>
          ))}
        </div>
      )}
      {!!item.priceOffers?.length && (
        <details className="leisure-offers">
          <summary>Квитки й умови цін</summary>
          {item.priceOffers.map((o, n) => (
            <div key={n}>
              <strong>
                {o.currency === 'UAH' ? money(o.min) : o.min + ' ' + o.currency}
                {o.max != null && o.max !== o.min
                  ? '–' + (o.currency === 'UAH' ? money(o.max) : o.max + ' ' + o.currency)
                  : ''}
              </strong>
              <p>{o.eligibility}</p>
              {o.note && <p className="leisure-secondary">{o.note}</p>}
            </div>
          ))}
        </details>
      )}
      {item.category === 'cinema' &&
        (leisureLiveAvailable() && item.source === 'Планета кіно' ? (
          <LiveFilm item={item} />
        ) : (
          <FilmFacts item={item} film={item.film} />
        ))}
      {item.podcast && (
        <div className="leisure-film-facts">
          <strong>{item.podcast.series}</strong>
          <p>
            {item.podcast.publisher}
            {item.podcast.language ? ' · ' + item.podcast.language : ''}
          </p>
          {item.publishedAt && (
            <p className="leisure-secondary">Випуск від {leisureDate(item.publishedAt)}</p>
          )}
          {item.podcast.explicit && (
            <p className="leisure-secondary">Видавець позначив дорослий контент.</p>
          )}
        </div>
      )}
    </>
  );
}

function CompactPlace({ item }: { item: LeisureItem }) {
  const live = useLeisureEnrichment(item);
  const p = live.data?.place;
  if (!p) return null;
  const parsed = priceRange.safeParse(p.price_range);
  const label = (v: z.infer<typeof amount> | undefined) =>
    v && v.currencyCode === 'UAH' && Number.isFinite(Number(v.units))
      ? money((Number(v.units) + (v.nanos ?? 0) / 1e9) * 2)
      : null;
  const low = parsed.success ? label(parsed.data.startPrice) : null;
  const high = parsed.success ? label(parsed.data.endPrice) : null;
  return (
    <div className="leisure-card-live-facts">
      <span className="leisure-google-attribution" translate="no">
        Google Maps
      </span>
      {p.rating != null && (
        <span>
          ★ {p.rating.toFixed(1)}
          {p.userRatingCount != null
            ? ' · ' +
              new Intl.NumberFormat('uk-UA', { notation: 'compact' }).format(p.userRatingCount) +
              ' оцінок'
            : ''}
        </span>
      )}
      {item.category === 'food' && (low || high) && (
        <span>≈ {low && high ? low + '–' + high : low ? 'від ' + low : 'до ' + high} на двох</span>
      )}
      {p.businessStatus && p.businessStatus !== 'OPERATIONAL' && (
        <strong>Зачинено за даними Google</strong>
      )}
    </div>
  );
}
export function CardFacts({ item }: { item: LeisureItem }) {
  return (
    <>
      {item.placeId && leisureLiveAvailable() && <CompactPlace key={item.id} item={item} />}
      {item.qualityWarnings?.length ? (
        <p className="leisure-card-quality">Потрібно уточнити умови у джерелі</p>
      ) : null}
      {item.schedule?.kind === 'recurring' && (
        <p className="leisure-card-quality">Повторювана подія · перевір дні проведення</p>
      )}
      {item.category === 'cinema' && item.film?.imdbRating != null && (
        <p className="leisure-card-quality">
          IMDb {item.film.imdbRating.toFixed(1)} · за даними {item.source}
        </p>
      )}
    </>
  );
}
