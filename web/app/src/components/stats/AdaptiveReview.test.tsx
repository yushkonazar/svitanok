import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { EMPTY_STATS } from '../../api/sample.ts';
import { statsSchema, type Stats } from '../../api/schema.ts';
import { demoAdaptive } from '../../../../core/checkin/adaptive-observations.mjs';
import { AdaptiveReview } from './AdaptiveReview.tsx';
vi.mock('../../telegram.ts', () => ({ inTelegram: () => true }));
afterEach(cleanup);
function Review({ s }: { s: Stats }) {
  const [days, setDays] = useState(7);
  return <AdaptiveReview s={s} days={days} setDays={setDays} />;
}
it('does not invent observations in a private empty account', () => {
  render(
    <Review
      s={{
        ...EMPTY_STATS,
        checkinDate: '2026-10-06',
        checkinToday: null,
        checkinRaw: { records: {}, from: '', to: '', days: 180 },
      }}
    />,
  );
  expect(screen.getAllByText(/0\/7 днів із записами/)).toHaveLength(2);
  expect(screen.queryByText(/Демонстраційні спостереження/)).not.toBeInTheDocument();
  expect(screen.queryByRole('slider')).not.toBeInTheDocument();
});
it('exposes grouped reasons with denominators and opens a selected day', () => {
  const to = '2026-10-06';
  render(
    <Review
      s={statsSchema.parse({
        ...EMPTY_STATS,
        checkinDate: to,
        checkinToday: null,
        checkinRaw: { records: demoAdaptive(to), from: '2026-08-26', to, days: 180 },
      })}
    />,
  );
  const slider = screen.getByRole('slider', { name: 'Дата: Енергія' });
  fireEvent.change(slider, { target: { value: '0' } });
  expect(screen.getByText('30 вересня · відповіді й контекст')).toBeInTheDocument();
  expect(screen.getByText('Переглянути конкретний день').closest('details')).toHaveAttribute(
    'open',
  );
  fireEvent.click(screen.getByText('Сон і те, що відсуває вечір'));
  expect(screen.getByText('Що відсунуло відхід до сну')).toBeInTheDocument();
  expect(screen.getByText(/Частки рахуємо лише серед явних відповідей/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '30д' }));
  expect(screen.getByText('Переглянути конкретний день').closest('details')).not.toHaveAttribute(
    'open',
  );
});
it('separates mood explanations by rating and shows new energy helpers with their own denominator', () => {
  const records = {
    '2026-10-05': {
      evening: {
        questionVersion: 3,
        confirmed: true,
        energy: 5,
        mood: 4,
        moodFactorsV3: ['good_news'],
        energyHelpersV3: ['rest'],
      },
    },
    '2026-10-06': {
      evening: {
        questionVersion: 3,
        confirmed: true,
        energy: 2,
        mood: 2,
        moodFactorsV3: ['conflict'],
      },
    },
  };
  render(
    <Review
      s={statsSchema.parse({
        ...EMPTY_STATS,
        checkinDate: '2026-10-06',
        checkinToday: null,
        checkinRaw: { records, from: '2026-10-05', to: '2026-10-06', days: 180 },
      })}
    />,
  );
  fireEvent.click(screen.getByText('Розподіл оцінок і пояснення'));
  const energy = screen
    .getByText('Що підтримує твою бадьорість?')
    .closest('.adaptive-distribution')!;
  expect(within(energy as HTMLElement).getByText('Відпочив / зробив перерву')).toBeInTheDocument();
  expect(within(energy as HTMLElement).getByText('1/1')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Настрій' }));
  const good = screen
    .getByText('Пояснення хорошого настрою · оцінки 4–5')
    .closest('.adaptive-distribution')!;
  const poor = screen
    .getByText('Пояснення поганого настрою · оцінки 1–2')
    .closest('.adaptive-distribution')!;
  expect(within(good as HTMLElement).getByText('Добрі новини')).toBeInTheDocument();
  expect(within(good as HTMLElement).queryByText('Конфлікт')).not.toBeInTheDocument();
  expect(within(poor as HTMLElement).getByText('Конфлікт')).toBeInTheDocument();
});
