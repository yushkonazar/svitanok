import { useEffect, useRef, useState } from 'react';
import { CategoryArtwork } from './CategoryArtwork.tsx';
import type { LeisureItem } from '../../api/leisure.ts';
import {
  fetchLeisureImage,
  leisureLiveAvailable,
  useLeisureEnrichment,
} from '../../api/leisure-enrichment.ts';

function Photo({
  item,
  index,
  photo,
  authors,
  variant,
}: {
  item: LeisureItem;
  index: number;
  photo?: string;
  authors: Array<{ name: string; url: string | null }>;
  variant: 'cover' | 'detail' | 'thumb';
}) {
  const [loaded, setLoaded] = useState(false);
  const [url, setUrl] = useState('');
  const [failed, setFailed] = useState(false);
  const [visible, setVisible] = useState(variant !== 'thumb');
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (visible || !ref.current || !('IntersectionObserver' in window)) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '120px' },
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [visible]);
  useEffect(() => {
    if (!visible || !leisureLiveAvailable() || (!photo && !item.media?.[index])) return;
    const controller = new AbortController();
    let objectUrl = '';
    const timer = setTimeout(
      () => {
        void fetchLeisureImage(item.id, index, photo, controller.signal)
          .then((blob) => {
            if (controller.signal.aborted) return;
            objectUrl = URL.createObjectURL(blob);
            setUrl(objectUrl);
          })
          .catch(() => {
            if (!controller.signal.aborted) setFailed(true);
          });
      },
      variant === 'cover' ? 200 : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [item.id, item.media, index, photo, visible, variant]);
  return (
    <figure
      ref={ref}
      className={`leisure-media is-${variant}${loaded && !failed ? ' has-photo' : ''}`}
    >
      <CategoryArtwork category={item.category} variant={variant} eager={variant !== 'thumb'} />
      {url && !failed && (
        <img
          className="leisure-real-photo"
          src={url}
          alt={
            item.media?.[index]?.alt ||
            (photo ? `Фото місця «${item.title}»` : `Афіша «${item.title}»`)
          }
          draggable={false}
          decoding="async"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
        />
      )}
      {loaded && !failed && (
        <figcaption
          className={variant === 'thumb' && !photo ? 'leisure-media-credit-compact' : undefined}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {photo ? (
            <>
              <span className="leisure-google-attribution" translate="no">
                Google Maps
              </span>
              {authors.map((a, n) =>
                a.url ? (
                  <a key={n} href={a.url} target="_blank" rel="noopener noreferrer">
                    {a.name}
                  </a>
                ) : (
                  <span key={n}>{a.name}</span>
                ),
              )}
            </>
          ) : (
            <span>{item.media?.[index]?.credit || item.source}</span>
          )}
        </figcaption>
      )}
      {failed && variant === 'detail' && (
        <span className="leisure-media-state">Фото зараз недоступне</span>
      )}
    </figure>
  );
}

export function LeisureMedia({
  item,
  variant = 'cover',
  active = false,
}: {
  item: LeisureItem;
  variant?: 'cover' | 'thumb' | 'detail';
  active?: boolean;
}) {
  if (item.placeId && leisureLiveAvailable() && (active || variant === 'detail'))
    return <LiveMedia key={item.id} item={item} variant={variant} />;
  return <MediaGallery key={item.id} item={item} variant={variant} active={active} photos={[]} />;
}
function LiveMedia({
  item,
  variant,
}: {
  item: LeisureItem;
  variant: 'cover' | 'thumb' | 'detail';
}) {
  const live = useLeisureEnrichment(item);
  return (
    <MediaGallery item={item} variant={variant} active photos={live.data?.place?.photos ?? []} />
  );
}
function MediaGallery({
  item,
  variant,
  active,
  photos,
}: {
  item: LeisureItem;
  variant: 'cover' | 'thumb' | 'detail';
  active: boolean;
  photos: Array<{ name: string; authors: Array<{ name: string; url: string | null }> }>;
}) {
  const [index, setIndex] = useState(0);
  const count = item.placeId ? photos.length : (item.media?.length ?? 0);
  const selected = Math.min(index, Math.max(0, count - 1));
  if (!count)
    return (
      <CategoryArtwork
        category={item.category}
        variant={variant}
        eager={active || variant === 'detail'}
      />
    );
  return (
    <div className={`leisure-gallery is-${variant}`}>
      <Photo
        key={`${item.id}:${selected}:${photos[selected]?.name ?? ''}`}
        item={item}
        index={selected}
        photo={photos[selected]?.name}
        authors={photos[selected]?.authors ?? []}
        variant={variant}
      />
      {variant === 'detail' && count > 1 && (
        <div className="leisure-gallery-controls" aria-label="Фотографії">
          <button
            type="button"
            aria-label="Попереднє фото"
            disabled={selected === 0}
            onClick={() => setIndex(selected - 1)}
          >
            ←
          </button>
          <span aria-live="polite">
            {selected + 1} / {count}
          </span>
          <button
            type="button"
            aria-label="Наступне фото"
            disabled={selected === count - 1}
            onClick={() => setIndex(selected + 1)}
          >
            →
          </button>
        </div>
      )}
    </div>
  );
}
