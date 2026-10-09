import { afterEach, it, expect } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { HourlyChart, PrecipitationChart } from './WeatherCharts.tsx';
afterEach(cleanup);
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
