import { useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

// Каскадна поява списків: кожен елемент грає fadeUp зі сходинкою затримки за
// індексом — екран «складається» зверху вниз, а не вмикається весь одразу.
//
// Той самий інваріант, що в графіках: у fadeUp кінцевий стан = природний стан
// DOM, `backwards` лише тримає елемент на прозорому кадрі протягом затримки.
// Не програлось (reduced-motion гасить і тривалість, і затримку) — список
// просто стоїть намальований.
//
// cap: хвіст довгого списку (архів на 50 рядків) не повинен зʼявлятися
// секундами — після cap-ного елемента всі йдуть з однаковою затримкою.

export function cascade(i: number, step = 45, cap = 8): CSSProperties {
  return { animation: `fadeUp .32s ease-out ${Math.min(i, cap) * step}ms backwards` };
}

/**
 * Обгортка для списків, де індекси ЖИВУТЬ (видалення/перетягування зсуває
 * сусідів). Стиль заморожується на монтуванні: інакше зсув індексу міняє
 * animation-delay, а зміна shorthand `animation` РЕСТАРТУЄ анімацію — рядки
 * під видаленим блимали б fadeUp на кожне видалення. Для статичних списків
 * (індекси не міняються за життя екрана) досить голого cascade(i).
 */
export function useCascade(i: number, step?: number, cap?: number): CSSProperties {
  const [style] = useState(() => cascade(i, step, cap));
  return style;
}

/**
 * Обгортка-div для готових компонентів. Там, де зайвий div ламає розмітку
 * (рядки з first:*-стилями, flex-діти з власною геометрією), — useCascade
 * прямо в компоненті рядка.
 */
export function Cascade({
  i,
  step,
  cap,
  children,
}: {
  i: number;
  step?: number;
  cap?: number;
  children: ReactNode;
}) {
  return <div style={useCascade(i, step, cap)}>{children}</div>;
}
