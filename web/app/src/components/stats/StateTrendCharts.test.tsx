import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { checkinPointSchema } from '../../api/schema.ts';
import { StateTrendCharts } from './StateTrendCharts.tsx';
afterEach(cleanup);
const rows = [
  {
    d: '2026-10-02',
    p: checkinPointSchema.parse({ d: '2026-10-02', energy: 4, moodCurve: [3], sleepH: 8 }),
  },
  { d: '2026-10-03', p: undefined },
  {
    d: '2026-10-04',
    p: checkinPointSchema.parse({ d: '2026-10-04', energy: 2, moodCurve: [4], sleepH: 0 }),
  },
];
it('separates sleep hours from ratings, preserves real zero sleep and never bridges missing dates', () => {
  const { container } = render(
    <StateTrendCharts
      rows={rows}
      enabled={['energy', 'mood', 'sleep']}
      selected="2026-10-04"
      onSelect={() => {}}
    />,
  );
  expect(screen.getByRole('img', { name: /Енергія та настрій/ })).toBeInTheDocument();
  expect(screen.getByRole('img', { name: /Тривалість сну/ })).toBeInTheDocument();
  expect(screen.getByText('1–5 балів')).toBeInTheDocument();
  expect(screen.getByText('0–12 год')).toBeInTheDocument();
  expect(container.querySelectorAll('path')).toHaveLength(3);
  for (const path of container.querySelectorAll('path')) {
    expect(path.getAttribute('d')?.match(/M/g)).toHaveLength(2);
    expect(path.getAttribute('d')).not.toContain('L');
  }
  expect(screen.getByText('2026-10-04: Сон 0')).toBeInTheDocument();
  expect(container.querySelectorAll('title')).toHaveLength(8);
});
it('does not draw fictitious data in an empty period', () => {
  render(
    <StateTrendCharts
      rows={[{ d: '2026-10-04', p: undefined }]}
      enabled={['sleep']}
      selected="2026-10-04"
      onSelect={() => {}}
    />,
  );
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
  expect(screen.getByText(/ще немає відповідей/)).toBeInTheDocument();
});
