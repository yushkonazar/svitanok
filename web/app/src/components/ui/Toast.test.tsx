import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { ToastProvider, useToast } from './Toast.tsx';

/* Тости про невдалі мутації. Перевіряється поведінка, якої не видно ні типам,
 * ні збірці: що повідомлення взагалі зʼявляється, що серія однакових помилок не
 * перетворює екран на стос, і що тост сам зникає.
 *
 * Чому це важливо саме тут: тост — єдиний сигнал, що оптимістичне оновлення
 * відкотилось. Якщо він не показався (або показався тричі), власник робить
 * хибний висновок про стан своїх даних. */

function Trigger({ text = 'Не вдалось' }: { text?: string }) {
  const { notifyError } = useToast();
  return (
    <button type="button" onClick={() => notifyError(text)}>
      зламати
    </button>
  );
}

afterEach(() => vi.useRealTimers());

describe('ToastProvider', () => {
  it('показує повідомлення про помилку', () => {
    render(
      <ToastProvider>
        <Trigger text="Немає звʼязку — зміну не збережено." />
      </ToastProvider>,
    );
    act(() => screen.getByRole('button', { name: 'зламати' }).click());
    expect(screen.getByText('Немає звʼязку — зміну не збережено.')).toBeInTheDocument();
  });

  it('область тостів — ввічливий live-region (скрінрідер не переривають)', () => {
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );
    // `status`/`polite`, а не `alert`/`assertive`: нічого критичного не сталось,
    // дію можна повторити — переривати поточну роботу немає підстав.
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
  });

  it('однакові помилки поспіль НЕ множаться (серія тапів по офлайну)', () => {
    render(
      <ToastProvider>
        <Trigger text="Немає звʼязку" />
      </ToastProvider>,
    );
    const btn = screen.getByRole('button', { name: 'зламати' });
    act(() => {
      btn.click();
      btn.click();
      btn.click();
    });
    expect(screen.getAllByText('Немає звʼязку')).toHaveLength(1);
  });

  it('тост сам зникає — не залипає над екраном', () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <Trigger text="Зникни" />
      </ToastProvider>,
    );
    act(() => screen.getByRole('button', { name: 'зламати' }).click());
    expect(screen.getByText('Зникни')).toBeInTheDocument();

    act(() => void vi.advanceTimersByTime(5100));
    expect(screen.queryByText('Зникни')).not.toBeInTheDocument();
  });

  it('поза провайдером useToast — тихий no-op, а не падіння', () => {
    // Тост це фідбек, а не механіка: ізольований рендер компонента (чи тест
    // сусідньої фічі) не має падати через відсутній провайдер.
    render(<Trigger />);
    expect(() => act(() => screen.getByRole('button').click())).not.toThrow();
  });
});
