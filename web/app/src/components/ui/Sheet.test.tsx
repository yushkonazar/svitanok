import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Sheet } from './Sheet.tsx';

/* F8 з аудиту C2. Шторка виглядала модальним вікном, а для клавіатури й
 * екранного читача була звичайним <div>: Escape не закривав, фокус лишався
 * ПІД нею (табом можна було піти в контент, який вона ж і затуляє), і читач
 * не оголошував ані діалогу, ані того, що решта сторінки неактивна.
 *
 * Це не косметика доступності: людина з клавіатурою просто не могла закрити
 * шторку інакше, ніж мишею. */

describe('Sheet — справжній діалог', () => {
  it('locks the page, contains horizontal and boundary gestures, and restores scroll after closing', () => {
    const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    const { unmount } = render(
      <Sheet onClose={() => {}}>
        <div data-testid="scroller" style={{ overflowY: 'auto' }}>
          Content
        </div>
      </Sheet>,
    );
    expect(document.body.style.position).toBe('fixed');
    expect(document.documentElement.style.overflow).toBe('hidden');
    const area = screen.getByTestId('scroller');
    Object.defineProperties(area, { scrollHeight: { value: 500 }, clientHeight: { value: 100 } });
    const gesture = (x: number, y: number) => {
      fireEvent.touchStart(area, { touches: [{ clientX: 50, clientY: 100 }] });
      const event = new Event('touchmove', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'touches', { value: [{ clientX: x, clientY: y }] });
      area.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(gesture(100, 100)).toBe(true);
    expect(gesture(50, 150)).toBe(true);
    expect(gesture(50, 50)).toBe(false);
    area.scrollTop = 400;
    expect(gesture(50, 50)).toBe(true);
    unmount();
    expect(document.body.style.position).toBe('');
    expect(document.documentElement.style.overflow).toBe('');
    expect(scroll).toHaveBeenCalled();
    scroll.mockRestore();
  });
  it('starts a new wizard step at the top while keeping the page locked', () => {
    const { rerender } = render(
      <Sheet onClose={() => {}} resetKey={0}>
        <button>Continue</button>
      </Sheet>,
    );
    const panel = screen.getByRole('dialog');
    panel.scrollTop = 200;
    rerender(
      <Sheet onClose={() => {}} resetKey={1}>
        <button>Confirm</button>
      </Sheet>,
    );
    expect(panel.scrollTop).toBe(0);
    expect(panel).toHaveFocus();
    expect(document.body.style.position).toBe('fixed');
  });
  it('оголошений як модальний діалог із назвою', () => {
    render(
      <Sheet onClose={() => {}} label="Вакансія">
        <button type="button">Дія</button>
      </Sheet>,
    );
    const dlg = screen.getByRole('dialog', { name: 'Вакансія' });
    expect(dlg.getAttribute('aria-modal')).toBe('true');
  });

  it('Escape закриває', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <Sheet onClose={onClose}>
        <button type="button">Дія</button>
      </Sheet>,
    );
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('фокус їде ВСЕРЕДИНУ при відкритті', () => {
    render(
      <Sheet onClose={() => {}}>
        <button type="button">Перша</button>
        <button type="button">Друга</button>
      </Sheet>,
    );
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Перша' }));
  });

  it('Tab із останнього елемента повертається на перший, а не тікає під шторку', async () => {
    const user = userEvent.setup();
    render(
      <Sheet onClose={() => {}}>
        <button type="button">Перша</button>
        <button type="button">Остання</button>
      </Sheet>,
    );
    const first = screen.getByRole('button', { name: 'Перша' });
    const last = screen.getByRole('button', { name: 'Остання' });
    last.focus();
    await user.tab();
    expect(document.activeElement).toBe(first);
  });

  it('Shift+Tab із першого йде на останній', async () => {
    const user = userEvent.setup();
    render(
      <Sheet onClose={() => {}}>
        <button type="button">Перша</button>
        <button type="button">Остання</button>
      </Sheet>,
    );
    screen.getByRole('button', { name: 'Перша' }).focus();
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Остання' }));
  });

  it('після закриття фокус повертається туди, звідки відкрили', async () => {
    const opener = document.createElement('button');
    opener.textContent = 'Відкрити';
    document.body.appendChild(opener);
    opener.focus();

    const { unmount } = render(
      <Sheet onClose={() => {}}>
        <button type="button">Дія</button>
      </Sheet>,
    );
    expect(document.activeElement).not.toBe(opener);
    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('шторка без жодної кнопки все одно приймає фокус (інакше він лишився б знизу)', () => {
    render(
      <Sheet onClose={() => {}}>
        <span>Лише текст</span>
      </Sheet>,
    );
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
  });
});
