import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { UpdatedValue } from './UpdatedValue.tsx';
import { savePresentation } from '../../lib/presentation.ts';

const animate = vi.fn();
const cancel = vi.fn();
const original = Element.prototype.animate;
beforeEach(() => {
  savePresentation({ calm: false });
  animate.mockReturnValue({ cancel });
  Element.prototype.animate = animate;
});
afterEach(() => {
  cleanup();
  if (original) Element.prototype.animate = original;
  else delete (Element.prototype as Partial<Element>).animate;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  savePresentation({ calm: false });
});
it('shows exact values and accents only later changes of the same data item', () => {
  const { rerender } = render(
    <UpdatedValue identity="USD" value={40}>
      40,00
    </UpdatedValue>,
  );
  expect(animate).not.toHaveBeenCalled();
  rerender(
    <UpdatedValue identity="USD" value={41}>
      41,00
    </UpdatedValue>,
  );
  expect(screen.getByText('41,00')).toBeInTheDocument();
  expect(animate).toHaveBeenCalledTimes(1);
  rerender(
    <UpdatedValue identity="USD" value={41}>
      41,00
    </UpdatedValue>,
  );
  expect(animate).toHaveBeenCalledTimes(1);
  rerender(
    <UpdatedValue identity="EUR" value={43}>
      43,00
    </UpdatedValue>,
  );
  expect(animate).toHaveBeenCalledTimes(1);
  expect(cancel).toHaveBeenCalledTimes(1);
  rerender(
    <UpdatedValue identity="EUR" value={null}>
      Невідомо
    </UpdatedValue>,
  );
  rerender(
    <UpdatedValue identity="EUR" value={44}>
      44,00
    </UpdatedValue>,
  );
  expect(animate).toHaveBeenCalledTimes(1);
});
it('cancels the current effect and respects calm mode, system motion and finance settings', () => {
  const { rerender } = render(
    <UpdatedValue identity="balance" value={1}>
      1
    </UpdatedValue>,
  );
  rerender(
    <UpdatedValue identity="balance" value={2}>
      2
    </UpdatedValue>,
  );
  act(() => savePresentation({ calm: true }));
  expect(cancel).toHaveBeenCalled();
  rerender(
    <UpdatedValue identity="balance" value={3}>
      3
    </UpdatedValue>,
  );
  expect(animate).toHaveBeenCalledTimes(1);
  act(() => savePresentation({ calm: false }));
  expect(animate).toHaveBeenCalledTimes(1);
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  rerender(
    <UpdatedValue identity="balance" value={4}>
      4
    </UpdatedValue>,
  );
  expect(animate).toHaveBeenCalledTimes(1);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  rerender(
    <UpdatedValue identity="balance" enabled={false} value={5}>
      5
    </UpdatedValue>,
  );
  expect(animate).toHaveBeenCalledTimes(1);
});
