import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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
