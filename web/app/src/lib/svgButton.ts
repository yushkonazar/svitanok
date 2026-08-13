import type { KeyboardEvent } from 'react';

// Клікабельний елемент усередині SVG — як кнопка, а не як малюнок.
//
// ⚠️ F9 з аудиту C2. У SVG немає власного <button>, тож графіки, що реагують на
// тап, писались як <g onClick>. Для миші й пальця це працює, а для клавіатури
// такого елемента просто не існує: до нього не дотягнутись табом, Enter нічого
// не робить, і екранний читач бачить безіменний прямокутник. Тобто половина
// інтерактиву дашборда була доступна лише вказівником.
//
// Логіка однакова в кожному графіку (роль, tabIndex, Enter/Space, підпис,
// стан «обрано»), тож живе в одному місці — інакше четверта копія неминуче
// розійдеться з першими трьома.

export interface SvgButtonOptions {
  /** Що прочитає екранний читач. Без нього елемент лишається безіменним. */
  label: string;
  /** Чи цей елемент зараз обраний (aria-pressed). */
  pressed?: boolean;
  onActivate: () => void;
}

export function svgButtonProps({ label, pressed, onActivate }: SvgButtonOptions) {
  return {
    role: 'button' as const,
    tabIndex: 0,
    'aria-label': label,
    ...(pressed === undefined ? {} : { 'aria-pressed': pressed }),
    onClick: onActivate,
    onKeyDown: (e: KeyboardEvent) => {
      // ⚠️ preventDefault обовʼязковий саме для пробілу: без нього браузер ще й
      // гортає сторінку, тобто натиснути на графік з клавіатури означало б
      // втратити його з очей.
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onActivate();
      }
    },
    style: { cursor: 'pointer' },
  };
}
