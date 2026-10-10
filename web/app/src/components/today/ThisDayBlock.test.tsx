import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { ThisDayBlock } from './ThisDayBlock.tsx';
import type { OnThisDayData } from '../../api/briefing-schema.ts';

afterEach(cleanup);
const data: OnThisDayData = {
  events: [
    {
      year: 2001,
      text: 'Подія над морем',
      location: {
        lat: 42,
        lon: 37,
        label: 'Чорне море',
        sourceUrl: 'https://uk.wikipedia.org/wiki/Test',
        kind: 'associated_article',
      },
    },
    { year: 1535, text: 'Надруковано книгу' },
    {
      year: 1957,
      text: 'Запуск супутника',
      location: {
        lat: 45,
        lon: 63,
        label: 'Космодром',
        sourceUrl: 'https://uk.wikipedia.org/wiki/Launch',
        kind: 'event',
      },
    },
  ],
};

it('updates the selected description and map while dragging, including unmapped events', () => {
  render(<ThisDayBlock d={data} />);
  const slider = screen.getByRole('slider');
  expect(slider).toHaveAttribute('aria-valuetext', '1535: Надруковано книгу');
  expect(screen.getByRole('status')).toHaveTextContent('1535');
  const map = screen.getByRole('group', { name: 'Мапа місць історичних подій' });
  fireEvent.input(slider, { target: { value: '1' } });
  expect(slider).toHaveAttribute('aria-valuetext', '1957: Запуск супутника');
  expect(within(map).getByRole('button', { name: '1957: Космодром' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  fireEvent.change(slider, { target: { value: '2' } });
  expect(within(map).getByRole('button', { name: '2001: Чорне море' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(screen.getByText(/Місце зі статті/)).toHaveTextContent('можуть відрізнятися');
  fireEvent.click(screen.getByRole('button', { name: 'Попередня історична подія' }));
  fireEvent.click(screen.getByRole('button', { name: 'Попередня історична подія' }));
  expect(screen.getByRole('status')).toHaveTextContent('1535');
  fireEvent.click(screen.getByRole('button', { name: 'Наступна історична подія' }));
  expect(slider).toHaveValue('1');
});

it('filters mapped events, supports marker keyboard navigation and restores the full timeline', () => {
  render(<ThisDayBlock d={data} />);
  const checkbox = screen.getByRole('checkbox', { name: 'Лише події з місцем' });
  fireEvent.click(checkbox);
  expect(screen.getByRole('slider')).toHaveAttribute('max', '1');
  expect(screen.getByRole('slider')).toHaveAttribute('aria-valuetext', '1957: Запуск супутника');
  fireEvent.keyDown(screen.getByRole('button', { name: '2001: Чорне море' }), { key: 'Enter' });
  expect(screen.getByRole('slider')).toHaveValue('1');
  fireEvent.click(checkbox);
  expect(screen.getByRole('slider')).toHaveAttribute('max', '2');
  expect(screen.getByRole('status')).toHaveTextContent('1535');
});

it('handles legacy briefings without coordinates and empty or refreshed data', () => {
  const { rerender } = render(<ThisDayBlock d={data} />);
  fireEvent.click(screen.getByRole('checkbox'));
  rerender(<ThisDayBlock d={{ events: [{ year: 1000, text: 'Без місця' }] }} />);
  expect(screen.getByRole('slider')).toBeDisabled();
  expect(screen.getByRole('status')).toHaveTextContent('1000');
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  expect(screen.getByText('З місцем: 0 / 1')).toBeInTheDocument();
  rerender(<ThisDayBlock d={{ events: [] }} />);
  expect(screen.queryByRole('slider')).not.toBeInTheDocument();
});

it('shows a verified event place without presenting its point as an exact address', () => {
  render(
    <ThisDayBlock
      d={{
        events: [
          {
            year: 1964,
            text: 'у Токіо почалися XVIII Олімпійські ігри.',
            location: {
              lat: 35.689444,
              lon: 139.691667,
              label: 'Токіо',
              sourceUrl: 'https://www.wikidata.org/wiki/Q1490',
              kind: 'event_place',
            },
          },
        ],
      }}
    />,
  );
  expect(screen.getByRole('button', { name: '1964: Токіо' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  expect(screen.getByText(/Місце проведення — Токіо/)).toHaveTextContent(
    'не обов’язково точну адресу',
  );
});
