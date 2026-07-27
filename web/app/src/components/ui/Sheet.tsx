import type { ReactNode } from 'react';
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
export function Sheet({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return createPortal(
    <div
      onClick={onClose}
      className="fixed inset-0 z-40 flex items-end"
      style={{ background: 'rgba(6,4,12,.55)', animation: 'fadeIn .2s ease' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full px-5 pb-7 pt-2.5"
        style={{
          background: 'var(--color-bg2)',
          borderTop: '1px solid var(--color-glassb)',
          borderRadius: '26px 26px 0 0',
          animation: 'sheetUp .3s cubic-bezier(.2,.8,.2,1)',
          boxShadow: '0 -20px 60px rgba(0,0,0,.5)',
        }}
      >
        <div className="mx-auto mb-4 mt-1 h-1 w-[38px] rounded-full bg-glassb" />
        {children}
      </div>
    </div>,
    document.body,
  );
}
