import { useRef, useState } from 'react';
import { LeisureMedia } from './LeisureMedia.tsx';
import { CardFacts } from './PlaceInfo.tsx';
import {
  categoryLabels,
  leisureDate,
  pairPrice,
  money,
  type LeisureItem,
} from '../../api/leisure.ts';

export function SwipeDeck({
  items,
  busy,
  reasons,
  onLike,
  onReject,
  onVisit,
  onOpen,
  deferLike = false,
  newCount = 0,
}: {
  items: LeisureItem[];
  busy: boolean;
  reasons: (id: string) => string[];
  onLike: (item: LeisureItem) => Promise<unknown>;
  onReject: (item: LeisureItem) => void;
  onVisit: (item: LeisureItem) => void;
  onOpen: (item: LeisureItem) => void;
  deferLike?: boolean;
  newCount?: number;
}) {
  const [anchor] = useState(items[0]?.id);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [held, setHeld] = useState<LeisureItem | null>(null);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const gesture = useRef<{ id: number; x: number; y: number; distance: number } | null>(null);
  const ignoreClick = useRef(false);
  const submitting = useRef(false);
  const available = items.filter((i) => !dismissed.has(i.id));
  const item = held ?? available.find((i) => i.id === anchor) ?? available[0];
  const choose = async (direction: 'right' | 'left' | 'down') => {
    if (!item || busy || submitting.current) return;
    setDragging(false);
    gesture.current = null;
    if (direction === 'right' && deferLike) {
      setPosition({ x: 0, y: 0 });
      setHeld(null);
      void onLike(item);
      return;
    }
    if (direction !== 'right') {
      setPosition({ x: 0, y: 0 });
      setHeld(null);
      if (direction === 'left') onReject(item);
      else onVisit(item);
      return;
    }
    submitting.current = true;
    setSaving(true);
    setError('');
    setHeld(item);
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    setPosition(reduced ? { x: 0, y: 0 } : { x: 450, y: -20 });
    try {
      await Promise.all([
        onLike(item),
        new Promise((resolve) => setTimeout(resolve, reduced ? 0 : 180)),
      ]);
      setDismissed((old) => new Set([...old, item.id]));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не вдалося зберегти вибір.');
    } finally {
      submitting.current = false;
      setSaving(false);
      setHeld(null);
      setPosition({ x: 0, y: 0 });
    }
  };
  if (!item)
    return (
      <div className="leisure-deck-empty" role="status">
        <span aria-hidden="true">✓</span>
        <h3>Нове переглянуто</h3>
        <p>
          Перейди в «Моє», щоб обрати вихід і скласти план. Або зміни категорію — добірка має й інші
          напрямки.
        </p>
      </div>
    );
  const price = pairPrice(item);
  const direction =
    position.y > 55 && Math.abs(position.y) > Math.abs(position.x) * 1.2
      ? 'down'
      : position.x > 40
        ? 'right'
        : position.x < -40
          ? 'left'
          : null;
  return (
    <div className="leisure-deck">
      <div className="leisure-deck-counter">
        <span>
          Ще {available.length} {available.length === 1 ? 'варіант' : 'варіантів'}
          {newCount > 0 && <small> · нових цього тижня: {newCount}</small>}
        </span>
        <span>Ліворуч / праворуч / униз</span>
      </div>
      <section className="leisure-swipe-surface">
        <article
          key={item.id}
          className={`leisure-swipe-card category-${item.category}${dragging ? ' is-dragging' : ''}`}
          style={{
            transform: `translate3d(${position.x}px, ${position.y}px, 0) rotate(${position.x / 28}deg)`,
          }}
        >
          <button
            type="button"
            className="leisure-card-target"
            onPointerDown={(e) => {
              if (
                busy ||
                submitting.current ||
                gesture.current ||
                e.button !== 0 ||
                (e.pointerType === 'touch' && e.isPrimary === false)
              )
                return;
              ignoreClick.current = false;
              gesture.current = { id: e.pointerId, x: e.clientX, y: e.clientY, distance: 0 };
              setHeld(item);
              setDragging(true);
              e.currentTarget.setPointerCapture?.(e.pointerId);
            }}
            onPointerMove={(e) => {
              const g = gesture.current;
              if (!g || g.id !== e.pointerId) return;
              g.distance = Math.max(g.distance, Math.hypot(e.clientX - g.x, e.clientY - g.y));
              setPosition({
                x: Math.max(-450, Math.min(450, e.clientX - g.x)),
                y: Math.max(-25, Math.min(220, e.clientY - g.y)),
              });
            }}
            onPointerUp={(e) => {
              const g = gesture.current;
              if (!g || g.id !== e.pointerId) return;
              const x = e.clientX - g.x,
                y = e.clientY - g.y;
              ignoreClick.current = Math.max(g.distance, Math.hypot(x, y)) > 8;
              gesture.current = null;
              setDragging(false);
              if (Math.abs(x) > 70 && Math.abs(x) > Math.abs(y) * 1.2)
                void choose(x > 0 ? 'right' : 'left');
              else if (y > 85 && y > Math.abs(x) * 1.2) void choose('down');
              else {
                setPosition({ x: 0, y: 0 });
                setHeld(null);
              }
            }}
            onPointerCancel={() => {
              ignoreClick.current = true;
              gesture.current = null;
              setDragging(false);
              if (!submitting.current) {
                setHeld(null);
                setPosition({ x: 0, y: 0 });
              }
            }}
            onLostPointerCapture={() => {
              if (gesture.current) {
                ignoreClick.current = true;
                gesture.current = null;
                setDragging(false);
                setHeld(null);
                setPosition({ x: 0, y: 0 });
              }
            }}
            aria-describedby={'card-title-' + item.id}
            aria-label="Картка дозвілля"
            aria-haspopup="dialog"
            aria-disabled={busy || saving}
            onClick={() => {
              if (ignoreClick.current) {
                ignoreClick.current = false;
                return;
              }
              if (!busy && !submitting.current) onOpen(item);
            }}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget) return;
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                if (!busy && !submitting.current) onOpen(item);
                return;
              }
              const d =
                e.key === 'ArrowRight'
                  ? 'right'
                  : e.key === 'ArrowLeft'
                    ? 'left'
                    : e.key === 'ArrowDown'
                      ? 'down'
                      : null;
              if (d) {
                e.preventDefault();
                void choose(d);
              }
            }}
          />
          <LeisureMedia item={item} active />
          {direction && (
            <span className={`leisure-swipe-verdict is-${direction}`}>
              {direction === 'right'
                ? 'ЦІКАВО'
                : direction === 'left'
                  ? 'НЕЦІКАВО'
                  : item.category === 'cinema'
                    ? 'ВЖЕ ДИВИВСЯ'
                    : item.category === 'podcast'
                      ? 'ВЖЕ СЛУХАВ'
                      : 'ВЖЕ БУЛИ'}
            </span>
          )}
          <div className="leisure-swipe-copy">
            <small>
              {categoryLabels[item.category]} {item.genre ? `· ${item.genre}` : ''}
            </small>
            <h3 id={'card-title-' + item.id}>{item.title}</h3>
            <CardFacts item={item} />
            <p className="leisure-swipe-place">
              {item.venue ?? item.address ?? 'Місце уточнюється у джерелі'}
            </p>
            <p className="leisure-swipe-summary">
              {item.summary || 'Відкрий деталі, щоб перевірити програму й актуальність.'}
            </p>
            <div className="leisure-swipe-facts">
              <span>
                {item.startDate ? leisureDate(item.startDate) : 'Обери зручний день'}
                {item.endDate && item.endDate !== item.startDate
                  ? ` — ${leisureDate(item.endDate)}`
                  : ''}
              </span>
              <b>
                {price == null
                  ? item.placeId && item.category === 'food'
                    ? 'Точна сума — за замовленням'
                    : 'Ціна невідома'
                  : price === 0
                    ? 'Безплатно'
                    : `Від ${money(price)} за двох`}
              </b>
            </div>
            <p className="leisure-swipe-reason">
              {reasons(item.id)[0] ?? 'Новий варіант для знайомства з твоїми інтересами'}
            </p>
          </div>
        </article>
      </section>
      <div className="leisure-deck-controls">
        <button
          type="button"
          className="leisure-deck-choice is-no"
          aria-label="Нецікаво"
          disabled={busy || saving}
          onClick={() => void choose('left')}
        >
          <span aria-hidden="true">×</span>
          <small>Нецікаво</small>
        </button>
        <button
          type="button"
          className="leisure-deck-choice is-seen"
          aria-label={
            item.category === 'cinema'
              ? 'Вже дивився'
              : item.category === 'podcast'
                ? 'Вже слухав'
                : 'Вже були'
          }
          disabled={busy || saving}
          onClick={() => void choose('down')}
        >
          <span aria-hidden="true">↓</span>
          <small>
            {item.category === 'cinema'
              ? 'Дивився'
              : item.category === 'podcast'
                ? 'Слухав'
                : 'Були'}
          </small>
        </button>
        <button
          type="button"
          className="leisure-deck-choice is-yes"
          aria-label="Цікаво"
          disabled={busy || saving}
          onClick={() => void choose('right')}
        >
          <span aria-hidden="true">♡</span>
          <small>Цікаво</small>
        </button>
      </div>
      <button
        type="button"
        className="leisure-deck-details"
        disabled={busy || saving}
        onClick={() => onOpen(item)}
      >
        Деталі події ↗
      </button>
      {saving && (
        <p role="status" className="leisure-secondary">
          Зберігаю вибір…
        </p>
      )}
      {error && (
        <p role="alert" className="leisure-error">
          {error}
        </p>
      )}
    </div>
  );
}
