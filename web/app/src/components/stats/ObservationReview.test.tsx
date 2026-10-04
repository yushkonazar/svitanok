import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { EMPTY_STATS } from '../../api/sample.ts';
import { statsSchema, type Stats } from '../../api/schema.ts';
import { demoObservations } from '../../../../core/checkin/observations.mjs';
import { ObservationReview } from './ObservationReview.tsx';
vi.mock('../../api/hooks.ts', () => ({ useSettings: () => ({ data: undefined }) }));
vi.mock('../../telegram.ts', () => ({ inTelegram: () => false }));
afterEach(cleanup);
function Review({ s }: { s: Stats }) {
  const [days, setDays] = useState(7);
  return <ObservationReview s={s} days={days} setDays={setDays} />;
}
function show(s: Stats) {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <Review s={s} />
    </QueryClientProvider>,
  );
}
it('renders the empty new account without invented points or an invalid calendar date', () => {
  show({ ...EMPTY_STATS, checkinRaw: { records: {}, days: 180, from: '', to: '' } });
  expect(screen.getByText(/Нові графіки почнуть наповнюватись/)).toBeInTheDocument();
  expect(screen.queryByRole('slider')).not.toBeInTheDocument();
  expect(screen.getByText('Сон і наступний день')).toBeInTheDocument();
});
it('a selected chart date opens that day; switching periods resets both chart and context', () => {
  const to = '2026-10-05';
  const s = statsSchema.parse({
    ...EMPTY_STATS,
    checkinRaw: { records: demoObservations(to), days: 180, from: '2026-04-09', to },
  });
  show(s);
  const slider = screen.getByRole('slider', { name: 'Дата: Енергія, Ранок' });
  fireEvent.change(slider, { target: { value: '0' } });
  expect(slider).toHaveAttribute('aria-valuetext', expect.stringContaining('29 вер.'));
  const detail = screen.getByText('29 вересня · відповіді та контекст').closest('details');
  expect(detail).toHaveAttribute('open');
  fireEvent.click(screen.getByRole('button', { name: '30д' }));
  expect(screen.getByRole('slider', { name: 'Дата: Енергія, Ранок' })).toHaveAttribute(
    'aria-valuetext',
    expect.stringContaining('5 жовт.'),
  );
  for (const summary of screen.getAllByText('5 жовтня · відповіді та контекст')) {
    expect(summary.closest('details')).not.toHaveAttribute('open');
  }
});
