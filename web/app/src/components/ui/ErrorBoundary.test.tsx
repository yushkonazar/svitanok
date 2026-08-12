import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorBoundary } from './ErrorBoundary.tsx';

/* Перший компонентний тест Mini App — і перевіряє він саме те, заради чого
 * harness піднімався: поведінку, якої не видно ні в типах, ні в збірці.
 *
 * Контекст: React 19 при неспійманій помилці рендера РОЗМОНТОВУЄ все дерево.
 * Для власника це не «зламався графік», а порожній білий екран у чаті — при
 * тому, що дані цілі, а впала одна картка з несподіваною формою поля. */

/** Компонент, який кидає на рендері (типова «несподівана форма даних»). */
function Boom(): never {
  throw new Error('поле прийшло undefined');
}

beforeEach(() => {
  // React друкує спійману помилку в консоль — у виводі тестів це шум, який
  // маскує справжні падіння.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('ErrorBoundary', () => {
  it('без помилки просто рендерить дітей', () => {
    render(
      <ErrorBoundary>
        <span>вміст</span>
      </ErrorBoundary>,
    );
    expect(screen.getByText('вміст')).toBeInTheDocument();
  });

  it('помилка в дитині НЕ гасить екран — показує причину й називає, ЩО впало', () => {
    render(
      <ErrorBoundary label="Статистика">
        <Boom />
      </ErrorBoundary>,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Не вдалось показати «Статистика»');
    // Головне для довіри: власник має знати, що ДАНІ цілі.
    expect(alert).toHaveTextContent(/дані на місці/i);
  });

  it('«Спробувати ще раз» відроджує піддерево, якщо причина зникла', async () => {
    // Причина живе ЗЗОВНІ дерева (як реальна: підвантажились нормальні дані).
    // Тому повторна спроба має сенс — не «спробуй те саме», а «дані вже інші».
    let broken = true;
    function Maybe() {
      if (broken) throw new Error('поле прийшло undefined');
      return <span>усе добре</span>;
    }

    render(
      <ErrorBoundary label="Сьогодні">
        <Maybe />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();

    broken = false;
    await userEvent.click(screen.getByRole('button', { name: 'Спробувати ще раз' }));
    expect(screen.getByText('усе добре')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('зміна resetKey (перехід на інший екран) сама прибирає помилку', () => {
    const { rerender } = render(
      <ErrorBoundary resetKey="/stats">
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();

    rerender(
      <ErrorBoundary resetKey="/today">
        <span>інший екран</span>
      </ErrorBoundary>,
    );
    expect(screen.getByText('інший екран')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
