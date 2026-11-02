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
