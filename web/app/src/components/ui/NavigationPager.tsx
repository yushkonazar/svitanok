import { useRef, useState, type ReactNode } from 'react';
import { haptic } from '../../telegram.ts';
import './navigation-pager.css';

export interface NavigationTab {
  id: string;
  path: string;
  label: string;
}

/** Paging changes the navigation bar only; the open screen and its draft stay mounted. */
export function NavigationPager({
  tabs,
  activePath,
  hidden,
  onNavigate,
  icon,
}: {
  tabs: readonly NavigationTab[];
  activePath: string;
  hidden: boolean;
  onNavigate: (path: string) => void;
  icon: (id: string, active: boolean) => ReactNode;
}) {
  const pages = Math.ceil(tabs.length / 5);
  const activePage = Math.max(0, Math.floor(tabs.findIndex((t) => t.path === activePath) / 5));
  const [selection, setSelection] = useState({ route: activePath, page: activePage });
  const page = selection.route === activePath ? selection.page : activePage;
  const touch = useRef<{ x: number; y: number } | null>(null);
  const swipeAt = useRef(0);
  const select = (value: number) => {
    const next = Math.min(pages - 1, Math.max(0, value));
    if (next !== page) {
      setSelection({ route: activePath, page: next });
      haptic('light');
    }
  };
  return (
    <nav
      hidden={hidden}
      aria-label="Розділи застосунку"
      className="renewal-navigation pointer-events-none fixed inset-x-0 z-30 flex justify-center"
    >
      <div
        className="navigation-pager pointer-events-auto border border-glassb bg-bg2 backdrop-blur-[28px]"
        onTouchStart={(e) => {
          const t = e.touches[0];
          touch.current = t ? { x: t.clientX, y: t.clientY } : null;
        }}
        onTouchEnd={(e) => {
          const t = e.changedTouches[0],
            start = touch.current;
          touch.current = null;
          if (!t || !start) return;
          const dx = t.clientX - start.x,
            dy = t.clientY - start.y;
          if (Math.abs(dx) > 42 && Math.abs(dx) > Math.abs(dy) * 2) {
            swipeAt.current = Date.now();
            select(page + (dx < 0 ? 1 : -1));
          }
        }}
        onTouchCancel={() => {
          touch.current = null;
        }}
      >
        <div
          className="navigation-pager-tabs"
          aria-label={`Сторінка навігації ${page + 1} з ${pages}`}
        >
          {tabs.slice(page * 5, page * 5 + 5).map((t) => {
            const active = t.path === activePath;
            return (
              <button
                type="button"
                key={t.id}
                className={`renewal-nav-tab${active ? ' is-active' : ' text-tx3'}`}
                aria-current={active ? 'page' : undefined}
                aria-label={t.label}
                style={
                  active ? { background: 'var(--grad)', color: 'var(--color-onacc)' } : undefined
                }
                onClick={(e) => {
                  if (e.detail > 0 && Date.now() - swipeAt.current < 350) return;
                  onNavigate(t.path);
                  haptic('light');
                }}
              >
                {icon(t.id, active)}
                <span>{t.label}</span>
              </button>
            );
          })}
        </div>
        {pages > 1 && (
          <div className="navigation-pager-controls">
            <button
              type="button"
              aria-label="Попередні розділи"
              disabled={page === 0}
              onClick={() => select(page - 1)}
            >
              ‹
            </button>
            <span aria-live="polite">
              {Array.from({ length: pages }, (_, i) => (
                <i key={i} className={page === i ? 'is-current' : ''} />
              ))}
              <span className="sr-only">
                Сторінка {page + 1} з {pages}
              </span>
            </span>
            <button
              type="button"
              aria-label="Наступні розділи"
              disabled={page === pages - 1}
              onClick={() => select(page + 1)}
            >
              ›
            </button>
          </div>
        )}
      </div>
    </nav>
  );
}
