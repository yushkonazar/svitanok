import { describe, it, expect, vi } from 'vitest';
import { svgButtonProps } from '../web/app/src/lib/svgButton.ts';

/* F9 з аудиту C2. У SVG немає власного <button>, тож графіки, що реагують на
 * тап, писались як <g onClick>: для миші й пальця працює, для клавіатури
 * такого елемента не існує взагалі — до нього не дотягнутись табом, Enter
 * нічого не робить, а екранний читач бачить безіменний прямокутник.
 *
 * Логіка однакова в чотирьох графіках, тож живе в одному місці: інакше
 * четверта копія неминуче розійдеться з першими трьома. */

const ev = (key: string) => {
  const preventDefault = vi.fn();
  return { e: { key, preventDefault } as never, preventDefault };
};

describe('svgButtonProps', () => {
  it('оголошує елемент кнопкою з підписом і фокусом', () => {
    const p = svgButtonProps({ label: 'Тиждень 12', onActivate: () => {} });
    expect(p.role).toBe('button');
    expect(p.tabIndex).toBe(0);
    expect(p['aria-label']).toBe('Тиждень 12');
  });

  it('Enter і пробіл спрацьовують, як клік', () => {
    const onActivate = vi.fn();
    const p = svgButtonProps({ label: 'x', onActivate });
    for (const key of ['Enter', ' ']) {
      const { e } = ev(key);
      p.onKeyDown(e);
    }
    expect(onActivate).toHaveBeenCalledTimes(2);
  });

  it('пробіл зупиняє прокрутку — інакше графік зникає з очей', () => {
    const { e, preventDefault } = ev(' ');
    svgButtonProps({ label: 'x', onActivate: () => {} }).onKeyDown(e);
    expect(preventDefault).toHaveBeenCalled();
  });

  it('інші клавіші не активують і не блокують сторінку', () => {
    const onActivate = vi.fn();
    const { e, preventDefault } = ev('a');
    svgButtonProps({ label: 'x', onActivate }).onKeyDown(e);
    expect(onActivate).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('стан «обрано» їде для читача, а не лише обведенням', () => {
    expect(
      svgButtonProps({ label: 'x', pressed: true, onActivate: () => {} })['aria-pressed'],
    ).toBe(true);
    expect(
      svgButtonProps({ label: 'x', pressed: false, onActivate: () => {} })['aria-pressed'],
    ).toBe(false);
  });

  it('без стану — атрибута немає взагалі (кнопка-дія, не перемикач)', () => {
    expect('aria-pressed' in svgButtonProps({ label: 'x', onActivate: () => {} })).toBe(false);
  });
});
