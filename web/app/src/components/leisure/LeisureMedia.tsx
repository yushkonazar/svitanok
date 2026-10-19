import { useCallback, useEffect, useRef, useState } from 'react';
import { CategoryArtwork } from './CategoryArtwork.tsx';
import type { LeisureItem } from '../../api/leisure.ts';
import {
  useLeisureImage,
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
  const [loadedBlob, setLoadedBlob] = useState<Blob | null>(null);
  const [failedBlob, setFailedBlob] = useState<Blob | null>(null);
  const [visible, setVisible] = useState(variant !== 'thumb');
  const ref = useRef<HTMLElement>(null);
  const image = useLeisureImage(item, index, photo, visible);
  const photoRef = useCallback(
    (node: HTMLImageElement | null) => {
      if (!node || !image.data) return;
      const objectUrl = URL.createObjectURL(image.data);
      node.src = objectUrl;
      return () => URL.revokeObjectURL(objectUrl);
    },
    [image.data],
  );
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
  const loaded = !!image.data && loadedBlob === image.data;
  const unavailable = image.isError || (!!image.data && failedBlob === image.data);
  return (
    <figure
      ref={ref}
      className={`leisure-media is-${variant}${loaded && !unavailable ? ' has-photo' : ''}`}
      aria-busy={visible && leisureLiveAvailable() && !loaded && !unavailable}
    >
      <CategoryArtwork category={item.category} variant={variant} eager={variant !== 'thumb'} />
      {image.data && !unavailable && (
        <img
          ref={photoRef}
          className="leisure-real-photo"
          alt={
            item.media?.[index]?.alt ||
            (photo ? `Фото місця «${item.title}»` : `Афіша «${item.title}»`)
          }
          draggable={false}
          decoding="async"
          onLoad={() => {
            setLoadedBlob(image.data);
            setFailedBlob(null);
          }}
          onError={() => setFailedBlob(image.data)}
        />
      )}
      {visible && leisureLiveAvailable() && !loaded && !unavailable && variant !== 'thumb' && (
        <span className="leisure-media-state is-loading" role="status">
          {image.fetchStatus === 'paused'
            ? 'Фото завантажиться після відновлення зв’язку'
            : 'Завантажуємо фото…'}
        </span>
      )}
      {loaded && !unavailable && (
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
      {unavailable && variant !== 'thumb' && (
        <span
          className="leisure-media-state"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          Фото зараз недоступне
          <button
            type="button"
            onClick={() => {
              void image.refetch();
            }}
          >
            Повторити
          </button>
        </span>
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
    <MediaGallery
      item={item}
      variant={variant}
      active
      photos={live.data?.place?.photos ?? []}
      state={live.isPending ? 'loading' : live.isError ? 'unavailable' : undefined}
      onRetry={() => void live.refetch()}
    />
  );
}
function MediaGallery({
  item,
  variant,
  active,
  photos,
  state,
  onRetry,
}: {
  item: LeisureItem;
  variant: 'cover' | 'thumb' | 'detail';
  active: boolean;
  photos: Array<{ name: string; authors: Array<{ name: string; url: string | null }> }>;
  state?: 'loading' | 'unavailable';
  onRetry?: () => void;
}) {
  const [index, setIndex] = useState(0);
  const count = item.placeId ? photos.length : (item.media?.length ?? 0);
  const selected = Math.min(index, Math.max(0, count - 1));
  if (!count)
    return (
      <div className={`leisure-media is-${variant}`} aria-busy={state === 'loading'}>
        <CategoryArtwork
          category={item.category}
          variant={variant}
          eager={active || variant === 'detail'}
        />
        {state && variant !== 'thumb' && (
          <span
            className={`leisure-media-state${state === 'loading' ? ' is-loading' : ''}`}
            role="status"
          >
            {state === 'loading' ? 'Завантажуємо фото…' : 'Фото зараз недоступне'}
            {state === 'unavailable' && onRetry && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onRetry();
                }}
                onPointerDown={(e) => e.stopPropagation()}
              >
                Повторити
              </button>
            )}
          </span>
        )}
      </div>
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
