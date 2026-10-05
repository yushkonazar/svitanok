import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

// Спільний bottom-sheet (витягнуто з JobSheet.tsx, редизайн новин — другий
// реальний споживач): затемнення + панель знизу (sheetUp), портал у
// document.body. Сам вміст — на споживачі, тут лише механіка шторки.
//
// Портал у document.body — щоб шторка вийшла зі stacking-контексту контенту
// (обгортка z-[1] над туманом). Інакше таб-бар (fixed z-30, сусід тієї
// обгортки) малюється ПОВЕРХ усієї шторки: z-40 всередині z-[1] програє
// z-30 на корені сторінки. Портал ставить її на корінь, де z-40 > z-30.
// Заразом рятує від transform на motion.main (fixed-нащадок інакше
// прив'язується до трансформованого предка, а не до вьюпорта).
//
// ⚠️ F8 з аудиту C2: доти це був звичайний <div> із onClick. Візуально —
// модальне вікно, для клавіатури й екранного читача — ніщо: Escape не
// закривав, фокус лишався під шторкою (можна було табом «вийти» в контент, що
// його ж і затуляє), а читач не оголошував ні того, що відкрився діалог, ні
// того, що решта сторінки більше не активна.
//
// Три речі, яких для цього достатньо, і всі три робляться руками, бо власного
// <dialog> у React тут немає: роль+модальність, повернення фокуса й пастка
// фокуса всередині.

/** Що взагалі може отримати фокус усередині шторки. */
const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

let scrollLocks = 0;
let restoreScroll: (() => void) | undefined;
function lockPageScroll() {
  if (scrollLocks++ === 0) {
    const y = window.scrollY;
    const body = document.body;
    const root = document.documentElement;
    const previous = {
      position: body.style.position,
      top: body.style.top,
      width: body.style.width,
      overflow: body.style.overflow,
      rootOverflow: root.style.overflow,
    };
    body.style.position = 'fixed';
    body.style.top = `-${y}px`;
    body.style.width = '100%';
    body.style.overflow = 'hidden';
    root.style.overflow = 'hidden';
    restoreScroll = () => {
      Object.assign(body.style, {
        position: previous.position,
        top: previous.top,
        width: previous.width,
        overflow: previous.overflow,
      });
      root.style.overflow = previous.rootOverflow;
      window.scrollTo(0, y);
    };
  }
  return () => {
    if (--scrollLocks === 0) {
      restoreScroll?.();
      restoreScroll = undefined;
    }
  };
}

export function Sheet({
  onClose,
  children,
  label = 'Панель',
  resetKey,
}: {
  onClose: () => void;
  children: ReactNode;
  /** Назва діалогу для екранного читача — без неї він читає «діалог» і мовчить далі. */
  label?: string;
  /** Start each wizard step at the top without unlocking the page behind it. */
  resetKey?: number;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  // Куди повернути фокус: після закриття він мусить опинитись там, звідки
  // шторку відкрили, інакше читач починає з початку сторінки, а тапальник
  // «губить місце».
  const returnTo = useRef<Element | null>(null);
  useEffect(() => {
    if (resetKey === undefined) return;
    const panel = panelRef.current;
    if (panel) {
      panel.scrollTop = 0;
      panel.focus({ preventScroll: true });
    }
  }, [resetKey]);

  useEffect(() => {
    const unlock = lockPageScroll();
    const overlay = overlayRef.current!;
    let x = 0,
      y = 0;
    const start = (e: TouchEvent) => {
      x = e.touches[0]?.clientX ?? 0;
      y = e.touches[0]?.clientY ?? 0;
    };
    const move = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const touch = e.touches[0]!;
      const dx = touch.clientX - x,
        dy = touch.clientY - y;
      x = touch.clientX;
      y = touch.clientY;
      if (Math.abs(dx) > Math.abs(dy)) {
        e.preventDefault();
        return;
      }
      let target = e.target instanceof Element ? e.target : null;
      while (target && target !== overlay) {
        const scrollable = /auto|scroll/.test(getComputedStyle(target).overflowY);
        if (
          scrollable &&
          ((dy > 0 && target.scrollTop > 0) ||
            (dy < 0 && target.scrollTop + target.clientHeight < target.scrollHeight - 1))
        )
          return;
        target = target.parentElement;
      }
      // Contain gestures even on iOS versions that ignore overscroll-behavior.
      e.preventDefault();
    };
    overlay.addEventListener('touchstart', start, { passive: true });
    overlay.addEventListener('touchmove', move, { passive: false });
    return () => {
      overlay.removeEventListener('touchstart', start);
      overlay.removeEventListener('touchmove', move);
      unlock();
    };
  }, []);

  const focusables = useCallback(
    () => Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []),
    [],
  );

  useEffect(() => {
    returnTo.current = document.activeElement;
    // Фокус усередину — на перший інтерактивний елемент, а як його немає, то
    // на саму панель (тому в неї tabIndex={-1}).
    const first = focusables()[0] ?? panelRef.current;
    first?.focus({ preventScroll: true });
    return () => {
      const back = returnTo.current;
      if (back instanceof HTMLElement && document.contains(back))
        back.focus({ preventScroll: true });
    };
  }, [focusables]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      // Пастка фокуса: без неї Tab виводить у контент ПІД шторкою — той
      // затулений, тож фокус видно лише читачеві, і виглядає це як зникнення.
      const items = focusables();
      if (!items.length) {
        e.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panelRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, focusables]);

  return createPortal(
    <div
      ref={overlayRef}
      onClick={onClose}
      className="fixed inset-0 z-40 flex items-end overflow-hidden overscroll-none"
      style={{ background: 'rgba(6,4,12,.55)', animation: 'fadeIn .2s ease' }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="w-full min-w-0 max-h-[90dvh] overflow-x-hidden overflow-y-auto overscroll-contain touch-pan-y px-5 pb-7 pt-2.5 outline-none"
        style={{
          background: 'var(--color-bg2)',
          borderTop: '1px solid var(--color-glassb)',
          borderRadius: '26px 26px 0 0',
          animation: 'sheetUp .3s cubic-bezier(.2,.8,.2,1)',
          boxShadow: '0 -20px 60px rgba(0,0,0,.5)',
        }}
      >
        <div className="mx-auto mb-4 mt-1 h-1 w-[38px] rounded-full bg-glassb" aria-hidden="true" />
        {children}
      </div>
    </div>,
    document.body,
  );
}
