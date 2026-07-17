import { useRef, useState } from 'react';
import { useJobStage } from '../../api/hooks.ts';
import { haptic, setVerticalSwipes } from '../../telegram.ts';
import { prettyJobTitle } from '../../lib/jobTitle.ts';
import { FUNNEL_STAGES, fitStyle, type FunnelStage } from './stages.ts';
import { Cascade } from '../ui/Cascade.tsx';
import type { StageEvent } from '../../api/schema.ts';

// Канбан воронки (дизайн v2, Svitanok.dc.html): лейни-стадії, картки
// перетягуються між ними. Джерело карток — stats.funnelList (а не блок
// брифінгу), тож видно й вакансії з минулих днів.
//
// Drag&drop — на pointer-подіях, як у макеті (без @dnd-kit): setPointerCapture
// на картці + document.elementFromPoint для визначення лейна під пальцем.
// touch-action:none обов'язковий, інакше браузер з'їсть жест скролом.
// Тап без руху (dragging=false) відкриває шторку картки.
//
// Свайп Telegram: на час жесту гасимо нативний pull-to-dismiss
// (setVerticalSwipes) — інакше тяг картки вниз від верху списку закривав апку.

const LANE_DOT: Record<FunnelStage, string> = {
  saved: '#9BA6FF',
  applied: 'var(--color-a2)',
  interview: 'var(--color-a1)',
  offer: 'var(--color-pos)',
  // Термінальні (F1): приглушені — це закриті історії, не активна робота.
  rejected: 'var(--color-neg)',
  failed: 'var(--color-tx3)',
};

export interface KanbanCard {
  url: string;
  title: string;
  stage: FunnelStage;
  score: number | null;
  /** Дата ПЕРШОГО входу у воронку (F1). */
  ts: string;
  /** Журнал переходів; порожній у легасі-вакансій (до F1). */
  history: StageEvent[];
}

export function KanbanBoard({
  cards,
  onOpenCard,
}: {
  cards: KanbanCard[];
  onOpenCard: (url: string) => void;
}) {
  const stageMut = useJobStage();
  const [dragUrl, setDragUrl] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [overCol, setOverCol] = useState<FunnelStage | null>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const off = useRef({ x: 0, y: 0, w: 150 });

  const dragCard = cards.find((c) => c.url === dragUrl) ?? null;

  const onDown = (e: React.PointerEvent, card: KanbanCard) => {
    const el = e.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    off.current = { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width };
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* деякі середовища не дають capture — drag просто працюватиме без нього */
    }
    // Гасимо нативний свайп Telegram на час жесту: інакше тяг картки ВНИЗ від
    // верху списку читається як pull-to-dismiss і апка починає закриватись.
    setVerticalSwipes(false);
    setDragUrl(card.url);
    setDragging(false);
    setOverCol(card.stage);
    setPos({ x: e.clientX, y: e.clientY });
  };

  const onMove = (e: React.PointerEvent) => {
    if (!dragUrl) return;
    // Клон має pointer-events:none, тож elementFromPoint бачить лейн під пальцем.
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const lane = under?.closest('[data-col]');
    const col = lane?.getAttribute('data-col') as FunnelStage | null;
    setDragging(true);
    setPos({ x: e.clientX, y: e.clientY });
    if (col) setOverCol(col);
  };

  /** Кінець жесту (успіх або скасування): повернути свайпи й скинути стан. */
  const endDrag = () => {
    setVerticalSwipes(true);
    setDragUrl(null);
    setDragging(false);
    setOverCol(null);
  };

  const onUp = () => {
    if (dragUrl && dragging && overCol && dragCard && overCol !== dragCard.stage) {
      stageMut.mutate({ url: dragCard.url, title: dragCard.title, stage: overCol });
      haptic('success');
    } else if (dragUrl && !dragging) {
      onOpenCard(dragUrl); // тап без руху — відкрити шторку
    }
    endDrag();
  };

  // ⚠️ onPointerCancel обовʼязковий саме через setVerticalSwipes: скасований жест
  // (вхідний дзвінок, системний свайп) не дає pointerup, і без цього свайпи
  // лишились би вимкненими ДО КІНЦЯ СЕСІЇ — власник більше не зміг би закрити
  // апку жестом. Доти хендлера не було: він лише лишав dragUrl висіти.
  const onCancel = () => endDrag();

  return (
    <>
      <div className="flex items-center gap-1.5 text-[10.5px] font-medium leading-[1.4] text-tx3">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-a2)" strokeWidth="1.7" strokeLinecap="round">
          <path d="M9 3v18M15 3v18M3 9h18M3 15h18" />
        </svg>
        Перетягуй картки між стадіями
      </div>

      <div className="flex flex-col gap-3">
        {FUNNEL_STAGES.map((st) => {
          const laneCards = cards.filter((c) => c.stage === st.key);
          const over = dragging && overCol === st.key;
          return (
            <div
              key={st.key}
              data-col={st.key}
              className="rounded-2xl border p-3 transition-all duration-[180ms]"
              style={{
                borderColor: over ? 'var(--color-a2)' : 'var(--color-glassb)',
                background: over ? 'rgba(255,164,92,.10)' : 'var(--color-glass)',
              }}
            >
              <div className={`flex items-center gap-2 ${laneCards.length ? 'mb-2.5' : 'mb-0.5'}`}>
                <div className="h-2 w-2 rounded-[3px]" style={{ background: LANE_DOT[st.key] }} />
                <span className="text-[12.5px] font-bold">{st.label}</span>
                <span className="rounded-md bg-bg2 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-tx3">
                  {laneCards.length}
                </span>
              </div>

              <div className="flex flex-col gap-2">
                {/* Cascade дає два ефекти одразу: хвилю при відкритті дошки і
                    мʼяке «всідання» картки в новий лейн після перетягування
                    (зміна лейна = ремоунт = свіжий fadeUp). */}
                {laneCards.map((c, i) => {
                  const fit = c.score != null && c.score >= 0 ? fitStyle(c.score) : null;
                  const dim = dragging && dragUrl === c.url;
                  return (
                    <Cascade key={c.url} i={i} step={40} cap={5}>
                    <div
                      onPointerDown={(e) => onDown(e, c)}
                      onPointerMove={onMove}
                      onPointerUp={onUp}
                      onPointerCancel={onCancel}
                      className="flex select-none items-center gap-2 rounded-xl border border-glassb bg-bg2 px-[11px] py-2.5 transition-opacity duration-150"
                      style={{ cursor: 'grab', touchAction: 'none', opacity: dim ? 0.35 : 1 }}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[12.5px] font-bold leading-[1.25]">
                          {prettyJobTitle(c.url, c.title)}
                        </div>
                      </div>
                      {fit && (
                        <span className="flex-none font-mono text-[10px] font-bold" style={{ color: fit.tx }}>
                          {c.score}%
                        </span>
                      )}
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="var(--color-tx3)" className="flex-none opacity-50">
                        <circle cx="8" cy="7" r="1.6" />
                        <circle cx="8" cy="12" r="1.6" />
                        <circle cx="8" cy="17" r="1.6" />
                        <circle cx="15" cy="7" r="1.6" />
                        <circle cx="15" cy="12" r="1.6" />
                        <circle cx="15" cy="17" r="1.6" />
                      </svg>
                    </div>
                    </Cascade>
                  );
                })}
                {!laneCards.length && (
                  <div className="px-0.5 py-1.5 text-[10.5px] font-medium text-tx3">— порожньо —</div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Клон, що їде за пальцем. left/top — ЧИСЛАМИ (React додає 'px' лише до
          чисел; рядок CSS відкинув би). pointer-events:none — щоб
          elementFromPoint бачив лейн, а не клон. */}
      {dragging && dragCard && (
        <div
          className="pointer-events-none fixed z-50 flex items-center gap-2 rounded-xl px-3 py-2.5"
          style={{
            left: pos.x - off.current.x,
            top: pos.y - off.current.y,
            width: off.current.w,
            background: 'var(--color-bg2)',
            border: '1px solid var(--color-a2)',
            boxShadow: '0 18px 44px rgba(0,0,0,.6),0 0 0 1px rgba(255,164,92,.3)',
            transform: 'rotate(-2deg) scale(1.03)',
          }}
        >
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-bold">
            {prettyJobTitle(dragCard.url, dragCard.title)}
          </span>
          {dragCard.score != null && dragCard.score >= 0 && (
            <span className="flex-none font-mono text-[10px] font-bold" style={{ color: fitStyle(dragCard.score).tx }}>
              {dragCard.score}%
            </span>
          )}
        </div>
      )}
    </>
  );
}
