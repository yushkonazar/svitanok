import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TodayOrder } from './TodayOrder.tsx';
import { DEFAULT_TODAY_ORDER, normalizeTodayOrder, saveTodayOrder } from '../../lib/todayLayout.ts';
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  saveTodayOrder(DEFAULT_TODAY_ORDER);
  vi.unstubAllGlobals();
});
it('persists a keyboard-accessible reorder, keeps its focus and restores the default', () => {
  render(<TodayOrder />);
  fireEvent.click(screen.getByText('Порядок блоків на «Сьогодні»'));
  const currencyUp = screen.getByRole('button', { name: 'Валюти: вище' });
  currencyUp.focus();
  fireEvent.click(currencyUp);
  expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('Валюти');
  expect(screen.getByRole('button', { name: 'Валюти: нижче' })).toHaveFocus();
  expect(currencyUp).toBeDisabled();
  expect(JSON.parse(localStorage.getItem('svitanok:today-order:v1')!)).toEqual([
    'currency',
    'weather',
    'fact',
    'stoic',
    'onthisday',
  ]);
  expect(screen.getByRole('status')).toHaveTextContent('Валюти: позиція 1');
  fireEvent.click(screen.getByRole('button', { name: 'Відновити початковий порядок' }));
  expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('Погода');
});
it('normalizes old or damaged orders and still allows changes when storage is unavailable', () => {
  expect(normalizeTodayOrder(['onthisday', 'news', 'onthisday', null])).toEqual([
    'onthisday',
    'weather',
    'currency',
    'fact',
    'stoic',
  ]);
  expect(normalizeTodayOrder({ weather: 1 })).toEqual(DEFAULT_TODAY_ORDER);
  vi.mocked(localStorage.setItem).mockImplementation(() => {
    throw new Error('Unavailable');
  });
  render(<TodayOrder />);
  fireEvent.click(screen.getByText('Порядок блоків на «Сьогодні»'));
  fireEvent.click(screen.getByRole('button', { name: 'Валюти: вище' }));
  expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('Валюти');
});
it('adopts the saved order when another app tab changes it', () => {
  render(<TodayOrder />);
  fireEvent.click(screen.getByText('Порядок блоків на «Сьогодні»'));
  localStorage.setItem('svitanok:today-order:v1', JSON.stringify(['onthisday']));
  act(() => window.dispatchEvent(new StorageEvent('storage', { key: 'svitanok:today-order:v1' })));
  expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('День на мапі історії');
});
