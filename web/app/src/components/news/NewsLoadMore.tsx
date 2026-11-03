import { useEffect, useRef } from 'react';

/** One observed batch at a time; the button remains available without IntersectionObserver. */
export function NewsLoadMore({ remaining, onMore }: { remaining: number; onMore: () => void }) {
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = sentinel.current;
    if (!element || typeof IntersectionObserver === 'undefined') return;
    let active = true;
    const observer = new IntersectionObserver(
      (entries) => {
        if (active && entries.some((entry) => entry.isIntersecting)) {
          active = false;
          observer.disconnect();
          onMore();
        }
      },
      { rootMargin: '0px 0px 180px 0px' },
    );
    observer.observe(element);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [onMore, remaining]);
  return (
    <div ref={sentinel} className="news-load-more">
      <button type="button" className="renewal-secondary" onClick={onMore}>
        Ще події · {remaining}
      </button>
    </div>
  );
}
