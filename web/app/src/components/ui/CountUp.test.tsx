import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { CountUp, useCountUp } from './CountUp.tsx';

/* Характеризаційні тести ПЕРЕД рефактором.
 *
 * ⚠️ react-hooks v7 (`set-state-in-effect`) слушно вказує на синхронний setState
 * в ефекті — але поведінка, яку той ефект реалізує, задокументована й потрібна:
 *   • reduced-motion / немає rAF -> одразу фінальне число, без кадру нуля;
 *   • дані оновились ПІСЛЯ програвання -> просто нове число, без повторного
 *     набігання (цифра, що крутиться на кожен рефетч, — шум);
 *   • розмонтування посеред анімації не лишає «недокрученого» значення.
 *
 * Тести пришпилюють саме це, щоб рефактор було видно, якщо він щось змінить. */

// ⚠️ Заглушка rAF мусить ЧЕСНО скасовувати. Перша версія робила
// cancelAnimationFrame() пустишкою — і «скасований» кадр усе одно спрацьовував,
// перетираючи число старою ціллю. Тест падав, хоч код був правий: у браузері
// такого кадру просто не буває.
let rafFrames: Map<number, FrameRequestCallback>;
let rafId = 0;

beforeEach(() => {
  rafFrames = new Map();
  rafId = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafFrames.set(++rafId, cb);
    return rafId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => void rafFrames.delete(id));
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
});
afterEach(() => vi.unstubAllGlobals());

/** Прокрутити анімацію до кінця. */
const flush = (t = 10_000) =>
  act(() => {
    for (let i = 0; i < 5 && rafFrames.size; i++) {
      const q = [...rafFrames.entries()];
      rafFrames.clear();
      for (const [, cb] of q) cb(t);
    }
  });

function Probe({ n, play = true }: { n: number; play?: boolean }) {
  return <span data-testid="v">{useCountUp(n, play)}</span>;
}
const val = () => screen.getByTestId('v').textContent;

describe('useCountUp — анімація', () => {
  it('стартує з нуля й доїжджає до цілі', () => {
    render(<Probe n={42} />);
    expect(val()).toBe('0');
    flush();
    expect(val()).toBe('42');
  });

  it('play=false — не набігає й лишається на нулі', () => {
    render(<Probe n={42} play={false} />);
    flush();
    expect(val()).toBe('0');
  });

  it('нуль як ціль — одразу нуль, без кадрів', () => {
    render(<Probe n={0} />);
    expect(val()).toBe('0');
  });
});

describe('useCountUp — reduced-motion', () => {
  it('одразу фінальне число, БЕЗ кадру нуля', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    render(<Probe n={42} />);
    // Саме це й мусить бути видно з першого рендера: нуль тут — миготіння.
    expect(val()).toBe('42');
  });
});

describe('useCountUp — оновлення даних', () => {
  it('нова ціль ПІСЛЯ програвання показується одразу, без повторного набігання', () => {
    const { rerender } = render(<Probe n={10} />);
    flush();
    expect(val()).toBe('10');
    rerender(<Probe n={25} />);
    // Без проміжних кадрів: цифра, що крутиться на кожен рефетч, — це шум.
    expect(val()).toBe('25');
  });

  it('зміна цілі ПОСЕРЕД анімації не лишає недокрученого числа', () => {
    const { rerender } = render(<Probe n={100} />);
    act(() => {
      const q = [...rafFrames.entries()];
      rafFrames.clear();
      for (const [, cb] of q) cb(50); // частковий кадр
    });
    rerender(<Probe n={7} />);
    flush();
    expect(val()).toBe('7');
  });
});

describe('CountUp — обгортка', () => {
  it('рендерить число у span із переданим класом', () => {
    const { container } = render(<CountUp n={5} play className="x" />);
    flush();
    expect(container.querySelector('span.x')?.textContent).toBe('5');
  });
});
