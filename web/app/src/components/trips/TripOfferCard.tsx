import { useState } from 'react';
import type { TravelOption } from '../../api/trips.ts';
import { openLink } from '../../telegram.ts';

const UNITS: Record<string, string> = {
  person: 'за людину',
  group: 'за групу',
  room_night: 'за номер / ніч',
  stay: 'за проживання',
  ticket: 'за квиток',
  entry: 'за вхід',
};
export function offerPrice(option: TravelOption) {
  const p = option.price;
  if (!p) return null;
  const total = p.total_confirmed === true;
  return {
    amount: new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 2 }).format(
      p.amount * (total ? p.quantity : 1),
    ),
    currency: p.currency,
    total,
    label: total
      ? option.kind === 'stay'
        ? 'за весь період і групу'
        : 'за вказану кількість'
      : (UNITS[p.unit] ?? 'за одиницю'),
  };
}
export function TripOfferCard({
  option: o,
  selected,
  focused,
  disabled,
  running,
  onChoose,
  onMap,
}: {
  option: TravelOption;
  selected: boolean;
  focused?: boolean;
  disabled: boolean;
  running: boolean;
  onChoose: () => void;
  onMap: () => void;
}) {
  const [photo, setPhoto] = useState(0),
    [brokenPhoto, setBrokenPhoto] = useState(false);
  const photos = o.stale ? [] : (o.photos ?? []),
    price = offerPrice(o);
  const isBooking = /^https:\/\/(?:[^/]+\.)?booking\.com\//.test(o.source_url),
    isAirbnb = /^https:\/\/(?:[^/]+\.)?airbnb\.com\//.test(o.source_url);
  const preferred =
    o.kind === 'stay'
      ? o.service_links?.find((link) => link.id === (isAirbnb ? 'airbnb' : 'booking'))
      : null;
  return (
    <article
      className={`journey-offer journey-offer-compact ${selected || focused ? 'is-picked' : ''}`}
    >
      {!!photos.length && !brokenPhoto && (
        <figure className="journey-offer-photo">
          <img
            src={photos[photo]?.url}
            alt={photos[photo]?.alt ?? o.title}
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setBrokenPhoto(true)}
          />
          <figcaption>Фото об’єкта · {photos[photo]?.credit}</figcaption>
          {photos.length > 1 && (
            <div className="journey-photo-controls">
              <button
                aria-label={`Попереднє фото: ${o.title}`}
                onClick={() => setPhoto((old) => (old + photos.length - 1) % photos.length)}
              >
                ‹
              </button>
              <span>
                {photo + 1} / {photos.length}
              </span>
              <button
                aria-label={`Наступне фото: ${o.title}`}
                onClick={() => setPhoto((old) => (old + 1) % photos.length)}
              >
                ›
              </button>
            </div>
          )}
        </figure>
      )}
      <div className="journey-offer-top">
        <span>{o.provider || 'Відкрите джерело'}</span>
        <span>
          {o.stale
            ? 'Оновити умови'
            : o.availability === 'provider_quote'
              ? 'Перевірено сервісом'
              : 'Перевірити на сайті'}
        </span>
      </div>
      <h3>{o.title}</h3>
      {price ? (
        <p
          className={`journey-price ${price.total && !o.stale && o.availability !== 'unverified' ? 'is-total' : ''}`}
        >
          <span>
            {price.amount} {price.currency}
          </span>
          <small>{price.label}</small>
        </p>
      ) : (
        <p className="journey-price-pending">Ціну потрібно перевірити</p>
      )}
      <div className="journey-offer-facts">
        {o.duration_minutes != null && (
          <span>
            {Math.floor(o.duration_minutes / 60)} год {o.duration_minutes % 60} хв за розкладом
          </span>
        )}
        {o.rating && (
          <span>
            ★ {o.rating.value}/{o.rating.scale} · {o.rating.source} ({o.rating.count})
          </span>
        )}
        {(o.highlights ?? []).slice(0, 3).map((fact) => (
          <span key={fact}>{fact}</span>
        ))}
      </div>
      {o.location && <p className="journey-offer-location">{o.location}</p>}
      <div className="journey-offer-controls">
        <a
          href={preferred?.url ?? o.source_url}
          target="_blank"
          rel="noreferrer noopener"
          onClick={(event) => {
            event.preventDefault();
            openLink(preferred?.url ?? o.source_url);
          }}
        >
          {preferred
            ? isAirbnb
              ? 'На Airbnb ↗'
              : isBooking
                ? 'На Booking ↗'
                : 'Знайти на Booking ↗'
            : 'Переглянути ↗'}
        </a>
        {o.kind !== 'transport' && (
          <button className="journey-text-button" onClick={onMap}>
            На мапі
          </button>
        )}
        <button
          disabled={disabled || o.stale || running}
          aria-pressed={selected}
          onClick={onChoose}
        >
          {o.kind === 'activity' ? (selected ? '✓ У плані' : '＋ До плану') : 'Обрати й далі →'}
        </button>
      </div>
      <details className="journey-offer-details">
        <summary>Деталі й умови</summary>
        {o.dates && <p>{o.dates}</p>}
        {o.schedule && <p>{o.schedule}</p>}
        {o.price?.includes && <p>У ціні: {o.price.includes}</p>}
        {o.price?.excludes && <p>Окремо: {o.price.excludes}</p>}
        {o.tradeoffs && <p>{o.tradeoffs}</p>}
        {o.cancellation && <p>Скасування: {o.cancellation}</p>}
        {o.missing && <p>Уточнити: {o.missing}</p>}
        <a
          href={o.source_url}
          target="_blank"
          rel="noreferrer noopener"
          onClick={(event) => {
            event.preventDefault();
            openLink(o.source_url);
          }}
        >
          Джерело ↗
        </a>
        <p>
          Перевірено {new Date(o.checked_at).toLocaleString('uk-UA')}. Обрати варіант — зберегти
          задум; квитки й житло бронюєш на сайті сервісу.
        </p>
      </details>
    </article>
  );
}
