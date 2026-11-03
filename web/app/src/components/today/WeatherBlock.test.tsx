import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { WeatherBlock } from './WeatherBlock.tsx';
import type { WeatherLocation } from '../../api/briefing-schema.ts';

const clock = vi.hoisted(() => ({ now: Date.parse('2026-11-03T08:00:00Z') }));
vi.mock('../../lib/useTick.ts', () => ({ useTick: () => clock.now }));
vi.mock('../../api/hooks.ts', () => ({
  useSetWeatherLocation: () => ({}),
  useSetWeatherLocationExact: () => ({}),
  useClearWeatherLocation: () => ({}),
  useRequestLocatePrompt: () => ({}),
  useSettlements: () => ({}),
}));
afterEach(() => {
  cleanup();
  clock.now = Date.parse('2026-11-03T08:00:00Z');
});
const location: WeatherLocation = {
  name: 'Львів',
  emoji: '',
  tempC: 12,
  sunrise: 0,
  sunset: 0,
  hourly: [80, 10, 10, 50].map((popPercent, index) => ({
    h: 10 + index,
    at: Date.parse('2026-11-03T08:00:00Z') / 1000 + index * 3600,
    t: 12 + index,
    popPercent,
    precipMm: index === 0 ? 1 : 0,
    precipType: 'rain',
  })),
};
it('links the outing window to both charts and removes it when the forecast expires', () => {
  const { container, rerender } = render(<WeatherBlock locations={[location]} />);
  const button = screen.getByRole('button', { name: /Вікно для виходу/ });
  expect(button).toHaveTextContent('Сьогодні 11:00–12:00');
  expect(button).toHaveTextContent('до 10%');
  expect(container.querySelectorAll('[data-forecast-window]')).toHaveLength(0);
  fireEvent.click(button);
  expect(button).toHaveAttribute('aria-pressed', 'true');
  expect(container.querySelectorAll('[data-forecast-window]')).toHaveLength(2);
  expect(screen.getByRole('slider', { name: 'Година прогнозу температури' })).toHaveValue('1');
  expect(screen.getByRole('slider', { name: 'Година прогнозу опадів' })).toHaveValue('1');
  fireEvent.click(button);
  expect(container.querySelectorAll('[data-forecast-window]')).toHaveLength(0);
  fireEvent.click(button);
  clock.now += 12 * 3600000;
  rerender(<WeatherBlock locations={[location]} />);
  expect(screen.queryByRole('button', { name: /Вікно для виходу/ })).not.toBeInTheDocument();
  expect(container.querySelectorAll('[data-forecast-window]')).toHaveLength(0);
});
it('keeps untimed and incomplete legacy forecasts usable without inventing an outing interval', () => {
  render(
    <WeatherBlock
      locations={[{ ...location, hourly: location.hourly!.map(({ at: _at, ...point }) => point) }]}
    />,
  );
  expect(screen.queryByRole('button', { name: /Вікно для виходу/ })).not.toBeInTheDocument();
  expect(screen.getByRole('slider', { name: 'Година прогнозу температури' })).toBeInTheDocument();
});
