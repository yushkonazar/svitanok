import { afterEach, it, expect } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { HourlyChart, PrecipitationChart } from './WeatherCharts.tsx';
afterEach(cleanup);
it('hides a dry or unknown precipitation plot and distinguishes snow from rain', () => {
  const { container, rerender } = render(
    <PrecipitationChart
      hourly={[
        { h: 10, t: 5, popPercent: 0, precipMm: 0 },
        { h: 11, t: 6, popPercent: 0 },
      ]}
    />,
  );
  expect(screen.queryByLabelText('Погодинний прогноз опадів')).not.toBeInTheDocument();
  rerender(
    <PrecipitationChart
      hourly={[
        { h: 10, t: -1, popPercent: 80, precipMm: 2, precipType: 'snow' },
        { h: 11, t: 1, popPercent: 60, precipMm: 1, precipType: 'rain' },
      ]}
    />,
  );
  expect(screen.getByText('Сніг · мм')).toBeInTheDocument();
  expect(screen.getByText('Дощ · мм')).toBeInTheDocument();
  expect(container.querySelector('[data-precipitation="snow"]')).toHaveAttribute(
    'fill',
    'var(--precip-snow)',
  );
  expect(screen.queryByText(/Ліва шкала/)).not.toBeInTheDocument();
});
it('shows precipitation amount and probability simultaneously, keeping unknown probability unknown', () => {
  render(
    <PrecipitationChart
      hourly={[
        { h: 23, t: 8, popPercent: 50, precipMm: 2 },
        { h: 0, t: 7, precipMm: 1 },
      ]}
    />,
  );
  expect(screen.getByText('50%')).toBeInTheDocument();
  expect(screen.getByText('2.0 мм', { selector: 'b' })).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Година прогнозу опадів'), { target: { value: '1' } });
  expect(screen.getByText('Немає даних')).toBeInTheDocument();
  expect(screen.getByText('1.0 мм')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Кількість, мм' })).not.toBeInTheDocument();
});
it('preserves time order across midnight and exposes the selected hour temperature', () => {
  const { container } = render(
    <HourlyChart
      hourly={[
        { h: 23, t: 8 },
        { h: 0, t: 7 },
        { h: 1, t: 6 },
      ]}
    />,
  );
  const circles = [...container.querySelectorAll('circle')];
  expect(Number(circles[1].getAttribute('cx'))).toBeGreaterThan(
    Number(circles[0].getAttribute('cx')),
  );
  fireEvent.change(screen.getByLabelText('Година прогнозу температури'), {
    target: { value: '1' },
  });
  expect(screen.getByText('00:00 · +7°')).toBeInTheDocument();
});
it('keeps a partly timestamped forecast in time order instead of drawing backwards', () => {
  const { container } = render(
    <HourlyChart
      hourly={[
        { h: 6, t: 17 },
        { h: 8, t: 18 },
        { h: 12, t: 22, at: Date.parse('2026-11-02T10:00:00Z') / 1000 },
        { h: 18, t: 24 },
      ]}
    />,
  );
  const xs = [...container.querySelectorAll('circle')].map((p) => Number(p.getAttribute('cx')));
  expect(xs).toEqual([...xs].sort((a, b) => a - b));
  expect(xs[2]! - xs[1]!).toBeCloseTo((xs[1]! - xs[0]!) * 2);
});

it.each([
  { temperatures: [5, 6], labels: ['+4,8°', '+5,5°', '+6,2°'] },
  { temperatures: [6, 6], labels: ['+5,8°', '+6°', '+6,2°'] },
  { temperatures: [0, 0], labels: ['-0,2°', '0°', '+0,2°'] },
  { temperatures: [-6, -5], labels: ['-6,2°', '-5,5°', '-4,8°'] },
  { temperatures: [-0.1, 0.1], labels: ['-0,3°', '0°', '+0,3°'] },
  { temperatures: [5.01, 5.02], labels: ['+4,8°', '+5,1°', '+5,3°'] },
])('keeps the temperature axis readable for $temperatures', ({ temperatures, labels }) => {
  render(<HourlyChart hourly={temperatures.map((t, index) => ({ h: 10 + index, t }))} />);
  const chart = screen.getByRole('img', { name: 'температура по годинах' });
  const ticks = [...chart.querySelectorAll('[data-temperature-axis] text')];
  expect(ticks.map((text) => text.textContent)).toEqual(labels);
  expect(new Set(ticks.map((text) => text.textContent)).size).toBe(3);
  const positions = ticks.map((text) => Number(text.getAttribute('y')));
  expect(Math.abs(positions[1]! - positions[0]!)).toBeGreaterThanOrEqual(30);
  expect(Math.abs(positions[2]! - positions[1]!)).toBeGreaterThanOrEqual(30);
  const points = [...chart.querySelectorAll('circle')];
  expect(
    Number(points[0]!.getAttribute('cx')) - Number(ticks[0]!.getAttribute('x')),
  ).toBeGreaterThan(5);
  expect(points.every((point) => Number.isFinite(Number(point.getAttribute('cy'))))).toBe(true);
  if (temperatures[0] === temperatures[1]) {
    expect(points[0]).toHaveAttribute('cy', points[1]!.getAttribute('cy'));
    expect(screen.getByText(/^Без змін ·/)).toBeInTheDocument();
  }
  if (temperatures[0] === 5 && temperatures[1] === 6) {
    expect(
      Math.abs(Number(points[0]!.getAttribute('cy')) - Number(points[1]!.getAttribute('cy'))),
    ).toBeGreaterThan(50);
    expect(screen.getByText('Від +5° до +6°')).toBeInTheDocument();
  }
});
