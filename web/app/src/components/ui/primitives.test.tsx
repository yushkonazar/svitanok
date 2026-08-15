import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Hint, Note } from './primitives.tsx';

/**
 * Підказка під графіком: згорнута за замовчуванням, розкривається кнопкою.
 *
 * ⚠️ ЧОМУ ЦЕ ВЗАГАЛІ ТЕСТУЄТЬСЯ. Hint — не один компонент, а поведінка
 * ТРИДЦЯТИ місць екрана статистики: правиться в одному файлі, ламається
 * скрізь. Плюс тут легко зробити «кнопку», яка для клавіатури й екранного
 * читача не кнопка — рівно те, що вже одного разу довелось лікувати в шторці
 * та в чартах (a11y-хвости F8/F9).
 *
 * Окремо пришпилено, що Note НЕ ховається: він відповідає на «чому тут
 * порожньо», і сховати таке за кнопкою означає лишити людину перед порожньою
 * карткою без натяку, що робити.
 */

describe('Hint — згорнута підказка', () => {
  it('за замовчуванням тексту немає, є лише кнопка', () => {
    render(<Hint>Медіана, а не середнє</Hint>);
    expect(screen.queryByText('Медіана, а не середнє')).toBeNull();
    expect(screen.getByRole('button')).toBeTruthy();
  });

  it('клік розкриває текст, повторний — ховає', async () => {
    const user = userEvent.setup();
    render(<Hint>Медіана, а не середнє</Hint>);
    await user.click(screen.getByRole('button'));
    expect(screen.getByText('Медіана, а не середнє')).toBeTruthy();
    await user.click(screen.getByRole('button'));
    expect(screen.queryByText('Медіана, а не середнє')).toBeNull();
  });

  it('це СПРАВЖНЯ кнопка зі станом: aria-expanded іде за розкриттям', async () => {
    const user = userEvent.setup();
    render(<Hint>текст</Hint>);
    const btn = screen.getByRole('button');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    await user.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
  });

  it('aria-controls показує на реальний елемент, а не в порожнечу', async () => {
    const user = userEvent.setup();
    const { container } = render(<Hint>текст</Hint>);
    const btn = screen.getByRole('button');
    await user.click(btn);
    const id = btn.getAttribute('aria-controls');
    expect(id).toBeTruthy();
    // CSS.escape: useId генерує ідентифікатори з двокрапками (:r0:), і без
    // екранування селектор просто не спарситься.
    expect(container.querySelector(`#${CSS.escape(id!)}`)?.textContent).toBe('текст');
  });

  it('дві підказки на екрані не ділять один id — інакше aria бреше', async () => {
    const user = userEvent.setup();
    render(
      <>
        <Hint>перша</Hint>
        <Hint>друга</Hint>
      </>,
    );
    const [a, b] = screen.getAllByRole('button');
    await user.click(a!);
    await user.click(b!);
    expect(a!.getAttribute('aria-controls')).not.toBe(b!.getAttribute('aria-controls'));
  });

  it('розкриття однієї не чіпає сусідню — стан у кожної свій', async () => {
    const user = userEvent.setup();
    render(
      <>
        <Hint>перша</Hint>
        <Hint>друга</Hint>
      </>,
    );
    await user.click(screen.getAllByRole('button')[0]!);
    expect(screen.getByText('перша')).toBeTruthy();
    expect(screen.queryByText('друга')).toBeNull();
  });
});

describe('Note — повідомлення про стан', () => {
  it('видно одразу й без кнопки: це відповідь на «чому порожньо»', () => {
    render(<Note>Сітка зʼявиться після 12 зрізів</Note>);
    expect(screen.getByText('Сітка зʼявиться після 12 зрізів')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
